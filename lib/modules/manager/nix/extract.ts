import { logger } from '../../../logger';
import { getSiblingFileName, readLocalFile } from '../../../util/fs';
import { regEx } from '../../../util/regex';
import { GitRefsDatasource } from '../../datasource/git-refs';
import { id as nixpkgsVersioning } from '../../versioning/nixpkgs';
import type { PackageDependency, PackageFileContent } from '../types';
import { NixFlakeLock } from './schema';

const nixpkgsRegex = regEx(/"github:nixos\/nixpkgs(\/(?<ref>[a-z0-9-.]+))?"/i);

// as documented upstream
// https://github.com/NixOS/nix/blob/master/doc/manual/source/protocols/tarball-fetcher.md#gitea-and-forgejo-support
const lockableHTTPTarballProtocol = regEx(
  '^https://(?<domain>[^/]+)/(?<owner>[^/]+)/(?<repo>[^/]+)/archive/(?<rev>.+).tar.gz$',
);

const lockableChannelOriginalUrl = regEx(
  '^https://nixos.org/channels/(?<channel>[^/]+)/nixexprs.tar.xz$',
);
const lockableChannelLockedUrl = regEx(
  '^https://releases.nixos.org/nixpkgs/(?<channel>[^/-]+)-(?<release>[^/]+)pre[0-9]+.(?<ref>[^/]+)/nixexprs.tar.xz$',
);

export async function extractPackageFile(
  content: string,
  packageFile: string,
): Promise<PackageFileContent | null> {
  const packageLockFile = getSiblingFileName(packageFile, 'flake.lock');
  const lockContents = await readLocalFile(packageLockFile, 'utf8');

  logger.trace(`nix.extractPackageFile(${packageLockFile})`);

  const deps: PackageDependency[] = [];

  const nixpkgsMatch = nixpkgsRegex.exec(content);
  let hasPackageFileNixpkgs = false;
  if (nixpkgsMatch?.groups) {
    const { ref } = nixpkgsMatch.groups;
    // only add when we matched a ref
    if (ref !== undefined) {
      // Note: it is perfectly valid for a nix flake to have multiple nixpkgs inputs, and for the nixpkgs input to be
      // named something other than `nixpkgs`.  Neither of those cases are supported here; it is assumed that the input
      // matching the `nixpkgsRegex` is named `nixpkgs` and that it's the only one that matches the RE.  This could be
      // improved in the future by using `nix` to actually evaluate the `flake.nix` file and then this manager could be
      // fully capable of understanding all input packages, (eg. `nix eval --file flake.nix --json inputs`), and then
      // only rely on the lock file for `lockedVersion` inputs...
      deps.push({
        depName: 'nixpkgs',
        currentValue: ref,
        datasource: GitRefsDatasource.id,
        packageName: 'https://github.com/NixOS/nixpkgs',
        versioning: nixpkgsVersioning,
      });
      hasPackageFileNixpkgs = true;
    }
  }

  const flakeLockParsed = NixFlakeLock.safeParse(lockContents);
  if (!flakeLockParsed.success) {
    logger.debug(
      { packageLockFile, error: flakeLockParsed.error },
      `invalid flake.lock file`,
    );
    return null;
  }

  const flakeLock = flakeLockParsed.data;
  const rootInputs = flakeLock.nodes.root.inputs;

  if (!rootInputs) {
    logger.debug(
      { packageLockFile, error: flakeLockParsed.error },
      `flake.lock is missing "root" node`,
    );

    if (deps.length) {
      return { deps };
    }
    return null;
  }

  for (const [depName, flakeInput] of Object.entries(flakeLock.nodes)) {
    // the root input is a magic string for the entrypoint and only references other flake inputs
    if (depName === 'root') {
      continue;
    }

    if (depName === 'nixpkgs' && hasPackageFileNixpkgs) {
      // Prevent `nixpkgs` from appearing as a dependency twice; once when `nixpkgsMatch` is matched, and once from the
      // flake.lock file.
      continue;
    }

    // skip all locked and transitivie nodes as they cannot be updated by regular means
    if (!(depName in rootInputs)) {
      continue;
    }

    const flakeLocked = flakeInput.locked;
    const flakeOriginal = flakeInput.original;

    // istanbul ignore if: if we are not in a root node then original and locked always exist which cannot be easily expressed in the type
    if (flakeLocked === undefined || flakeOriginal === undefined) {
      logger.debug(
        { packageLockFile, flakeInput },
        `Found empty flake input, skipping`,
      );
      continue;
    }

    // indirect inputs cannot be reliable updated because they depend on the flake registry
    if (flakeOriginal.type === 'indirect') {
      continue;
    }

    const isLockableTarball =
      flakeOriginal.url && lockableChannelOriginalUrl.test(flakeOriginal.url);

    // if no rev is being tracked, we cannot update this input
    if (flakeLocked.rev === undefined && !isLockableTarball) {
      continue;
    }

    // Mapping nix flake options to the dependency outputs:
    //
    // currentValue -- should be set to the package file's description of the target version; typically this doesn't
    // exist for a nix input reference, but some situations like a branch reference (eg.
    // `github:NixOS/nixpkgs/nixos-20.09`) will have a currentValue (eg. `nixos-20.09`).  Most often undefined,
    // representing a floating dependency.
    //
    // currentDigest -- should be set to the package file's digest of the target if the target is pinned.  Not typical
    // in a nix flake input, but would exist if the flake input is pinned (eg.
    // `github:NixOS/nixpkgs/a3a3dda3bacf61e8a39258a0ed9c924eeca8e293`).
    //
    // lockedVersion -- should be set to the digest that the package has currently floated to and been locked by the
    // lockfile.  Typically this is read from the nix flake.lock, but, if `currentDigest` is provided and the dependency
    // is pinned then we don't indicate it as locked, which allows renovate to recognize that the package file can be
    // updated to change this dependency.  Typically, renovate will only update this dependency by a lock file update.

    switch (flakeLocked.type) {
      case 'github':
        deps.push({
          depName,
          currentValue: flakeOriginal.ref,
          currentDigest: flakeOriginal.rev,
          lockedVersion: flakeOriginal.rev ? undefined : flakeLocked.rev,
          datasource: GitRefsDatasource.id,
          packageName: `https://${flakeOriginal.host ?? 'github.com'}/${flakeOriginal.owner}/${flakeOriginal.repo}`,
        });
        break;
      case 'gitlab':
        deps.push({
          depName,
          currentValue: flakeOriginal.ref,
          currentDigest: flakeOriginal.rev,
          lockedVersion: flakeOriginal.rev ? undefined : flakeLocked.rev,
          datasource: GitRefsDatasource.id,
          packageName: `https://${flakeOriginal.host ?? 'gitlab.com'}/${decodeURIComponent(flakeOriginal.owner!)}/${flakeOriginal.repo}`,
        });
        break;
      case 'git':
        deps.push({
          depName,
          currentValue: flakeOriginal.ref,
          currentDigest: flakeOriginal.rev,
          lockedVersion: flakeOriginal.rev ? undefined : flakeLocked.rev,
          datasource: GitRefsDatasource.id,
          packageName: flakeOriginal.url,
        });
        break;
      case 'sourcehut':
        deps.push({
          depName,
          currentValue: flakeOriginal.ref,
          currentDigest: flakeOriginal.rev,
          lockedVersion: flakeOriginal.rev ? undefined : flakeLocked.rev,
          datasource: GitRefsDatasource.id,
          packageName: `https://${flakeOriginal.host ?? 'git.sr.ht'}/${flakeOriginal.owner}/${flakeOriginal.repo}`,
        });
        break;
      case 'tarball':
        if (isLockableTarball) {
          const branch = flakeOriginal.url!.replace(
            lockableChannelOriginalUrl,
            '$<channel>',
          );
          const rev = flakeLocked.url!.replace(
            lockableChannelLockedUrl,
            '$<ref>',
          );
          deps.push({
            depName,
            currentValue: branch,
            lockedVersion: rev,
            datasource: GitRefsDatasource.id,
            packageName: 'https://github.com/NixOS/nixpkgs',
          });
        } else {
          deps.push({
            depName,
            currentValue: flakeOriginal.ref,
            currentDigest: flakeOriginal.rev,
            lockedVersion: flakeOriginal.rev ? undefined : flakeLocked.rev,
            datasource: GitRefsDatasource.id,
            // type tarball always contains this link
            packageName: flakeOriginal.url!.replace(
              lockableHTTPTarballProtocol,
              'https://$<domain>/$<owner>/$<repo>',
            ),
          });
        }
        break;
      // istanbul ignore next: just a safeguard
      default:
        logger.debug(
          { packageLockFile },
          `Unknown flake.lock type "${flakeLocked.type}", skipping`,
        );
        break;
    }
  }

  if (deps.length) {
    return { deps };
  }

  return null;
}
