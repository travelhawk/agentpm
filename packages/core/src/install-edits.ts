import {
  computeTreeSignature,
  isWithinDirectory,
  pathExists,
  realpathOrNull,
} from '@agentpm/fs';
import type { InstallRecord } from '@agentpm/shared';

/**
 * A git or archive install is a link into AgentPM's cache, so an edit made
 * through the link changes the cache copy. AgentPM records the files' signature
 * when it creates the install, so it can tell later whether they were edited.
 */
const SIGNATURE_KEY = 'installedSignature';

/**
 * True when the install's files are a copy in AgentPM's cache. A registry
 * archive install reports `contentKind: 'local'` but is cached the same way.
 */
export function isCacheBacked(install: InstallRecord): boolean {
  return install.contentKind !== 'local' || install.metadata.archive === true;
}

/**
 * Metadata to store with an install whose files live in the cache. When the
 * same install already exists on the same files, its baseline is kept: the
 * files may have been edited since, and hashing them now would make the edits
 * look like the original.
 */
export async function signatureMetadata(
  linkTarget: string,
  previous?: InstallRecord | null,
): Promise<Record<string, string>> {
  const kept = previous?.metadata[SIGNATURE_KEY];
  if (
    previous &&
    previous.linkTarget === linkTarget &&
    typeof kept === 'string'
  ) {
    return { [SIGNATURE_KEY]: kept };
  }
  const signature = await computeTreeSignature(linkTarget).catch(() => null);
  return signature ? { [SIGNATURE_KEY]: signature } : {};
}

/**
 * True when the files of a cache-backed install differ from what AgentPM
 * installed. Installs made before the signature was recorded return false:
 * there is nothing to compare with.
 */
export async function hasLocalEdits(install: InstallRecord): Promise<boolean> {
  const recorded = install.metadata[SIGNATURE_KEY];
  if (typeof recorded !== 'string') {
    return false;
  }
  // Missing files hold no edits. Their signature is that of an empty folder,
  // which would otherwise count as a change and block the repair.
  if (!(await pathExists(install.linkTarget))) {
    return false;
  }
  const current = await computeTreeSignature(install.linkTarget).catch(
    () => null,
  );
  return current !== null && current !== recorded;
}

/**
 * The install whose cache folder `contentPath` resolves into, if any. Several
 * installs can share one cache folder (other scopes, other agents), so one in
 * the scope of `cwd` wins.
 */
export async function findCacheInstallFor(
  contentPath: string,
  cacheDir: string,
  installs: InstallRecord[],
  cwd: string,
): Promise<InstallRecord | null> {
  const real = await realpathOrNull(contentPath);
  const realCache = (await realpathOrNull(cacheDir)) ?? cacheDir;
  if (
    !real ||
    !(isWithinDirectory(cacheDir, real) || isWithinDirectory(realCache, real))
  ) {
    return null;
  }
  const matches: InstallRecord[] = [];
  for (const install of installs) {
    if ((await realpathOrNull(install.linkTarget)) === real) {
      matches.push(install);
    }
  }
  return (
    matches.find((install) => isWithinDirectory(install.scopeRoot, cwd)) ??
    matches[0] ??
    null
  );
}
