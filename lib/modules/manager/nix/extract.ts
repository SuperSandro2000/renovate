import { logger } from '../../../logger';
import { getSiblingFileName, readLocalFile } from '../../../util/fs';
import { regEx } from '../../../util/regex';
import { GitRefsDatasource } from '../../datasource/git-refs';
import type { PackageDependency, PackageFileContent } from '../types';
import { NixFlakeLock } from './schema';

// TODO: add support to update nixpkgs branches in flakes.nix using nixpkgsVersioning

// as documented upstream
// https://github.com/NixOS/nix/blob/master/doc/manual/source/protocols/tarball-fetcher.md#gitea-and-forgejo-support
const lockableHTTPTarballProtocol = regEx(
  '^https://(?<domain>[^/]+)/(?<owner>[^/]+)/(?<repo>[^/]+)/archive/(?<rev>.+).tar.gz$',
);

export async function extractPackageFile(
  content: string,
  packageFile: string,
): Promise<PackageFileContent | null> {
  const packageLockFile = getSiblingFileName(packageFile, 'flake.lock');
  const lockContents = await readLocalFile(packageLockFile);

  logger.trace(`nix.extractPackageFile(${packageLockFile})`);

  const deps: PackageDependency[] = [];

  const flakeLockParsed = NixFlakeLock.safeParse(lockContents);
  if (!flakeLockParsed.success) {
    logger.error(
      { packageLockFile, error: flakeLockParsed.error },
      `invalid flake.lock file`,
    );
    return null;
  }

  const flakeLock = flakeLockParsed.data;

  for (const depName of Object.keys(flakeLock.nodes)) {
    // the root input is a magic string for the entrypoint and only references other flake inputs
    if (depName === 'root') {
      continue;
    }

    // skip all locked nodes which are not in the flake.nix and cannot be updated
    const rootInputs = flakeLock.nodes['root'].inputs;
    if (!rootInputs || !(depName in rootInputs)) {
      logger.error(
        { packageLockFile, error: flakeLockParsed.error },
        `invalid flake.lock file because cannot find "root" node`,
      );
      continue;
    }

    const flakeInput = flakeLock.nodes[depName];
    const flakeLocked = flakeInput.locked;
    const flakeOriginal = flakeInput.original;

    // istanbul ignore if: if we are not in a root node then original and locked always exist which cannot be easily expressed in the type
    if (flakeLocked === undefined || flakeOriginal === undefined) {
      logger.debug(
        { packageLockFile },
        `Found empty flake input '${JSON.stringify(flakeInput)}', skipping`,
      );
      continue;
    }

    // indirect inputs cannot be reliable updated because they depend on the flake registry
    if (flakeOriginal.type === 'indirect') {
      continue;
    }

    switch (flakeLocked.type) {
      case 'github':
        deps.push({
          depName,
          currentValue: flakeOriginal.ref,
          currentDigest: flakeLocked.rev,
          replaceString: flakeLocked.rev,
          datasource: GitRefsDatasource.id,
          packageName: `https://${flakeOriginal.host ?? 'github.com'}/${flakeOriginal.owner}/${flakeOriginal.repo}`,
        });
        break;
      case 'gitlab':
        deps.push({
          depName,
          currentValue: flakeOriginal.ref,
          currentDigest: flakeLocked.rev,
          replaceString: flakeLocked.rev,
          datasource: GitRefsDatasource.id,
          packageName: `https://${flakeOriginal.host ?? 'gitlab.com'}/${flakeOriginal.owner}/${flakeOriginal.repo}`,
        });
        break;
      case 'git':
        deps.push({
          depName,
          currentValue: flakeOriginal.ref,
          currentDigest: flakeLocked.rev,
          replaceString: flakeLocked.rev,
          datasource: GitRefsDatasource.id,
          packageName: flakeOriginal.url,
        });
        break;
      case 'sourcehut':
        deps.push({
          depName,
          currentValue: flakeOriginal.ref,
          currentDigest: flakeLocked.rev,
          replaceString: flakeLocked.rev,
          datasource: GitRefsDatasource.id,
          packageName: `https://${flakeOriginal.host ?? 'git.sr.ht'}/${flakeOriginal.owner}/${flakeOriginal.repo}`,
        });
        break;
      case 'tarball':
        deps.push({
          depName,
          currentValue: flakeLocked.ref,
          currentDigest: flakeLocked.rev,
          replaceString: flakeLocked.rev,
          datasource: GitRefsDatasource.id,
          // type tarball always contains this link
          packageName: (
            flakeOriginal.url ?? /* istanbul ignore next */ ''
          ).replace(
            lockableHTTPTarballProtocol,
            'https://$<domain>/$<owner>/$<repo>',
          ),
        });
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
