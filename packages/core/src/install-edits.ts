import {
  computeTreeSignature,
  isWithinDirectory,
  realpathOrNull,
} from '@agentpm/fs';
import type { InstallRecord } from '@agentpm/shared';

/**
 * A git or archive install is a link into AgentPM's cache, so an edit made
 * through the link changes the cache copy. AgentPM records the files' signature
 * when it creates the install, so it can tell later whether they were edited.
 */
const SIGNATURE_KEY = 'installedSignature';

/** Metadata to store with an install whose files live in the cache. */
export async function signatureMetadata(
  linkTarget: string,
): Promise<Record<string, string>> {
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
  const current = await computeTreeSignature(install.linkTarget).catch(
    () => null,
  );
  return current !== null && current !== recorded;
}

/** The install whose cache folder `contentPath` resolves into, if any. */
export async function findCacheInstallFor(
  contentPath: string,
  cacheDir: string,
  installs: InstallRecord[],
): Promise<InstallRecord | null> {
  const real = await realpathOrNull(contentPath);
  const realCache = (await realpathOrNull(cacheDir)) ?? cacheDir;
  if (
    !real ||
    !(isWithinDirectory(cacheDir, real) || isWithinDirectory(realCache, real))
  ) {
    return null;
  }
  for (const install of installs) {
    if ((await realpathOrNull(install.linkTarget)) === real) {
      return install;
    }
  }
  return null;
}
