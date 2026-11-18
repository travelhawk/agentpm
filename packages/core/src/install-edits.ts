import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
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

// Left out of the edit signature: version control data, installed packages and
// files an interpreter or the OS writes. Everything else the source ships, such
// as a committed `dist/`, counts: an edit there is an edit.
const SIGNATURE_IGNORED = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.DS_Store',
]);

/** A hash of every shipped file in the folder, by relative path and content. */
async function editSignature(root: string): Promise<string> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (SIGNATURE_IGNORED.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  await visit(root);
  files.sort();
  const hash = createHash('sha1');
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join('/'));
    hash.update(await fs.readFile(file));
  }
  return hash.digest('hex');
}

/**
 * True when the install's files are a copy in AgentPM's cache. A registry
 * archive install reports `contentKind: 'local'` but is cached the same way.
 */
/**
 * True when the project's `agentpm.yaml` lists this install. `sync` installs
 * every listed entry from its source again, so moving the skill to the library
 * would not last.
 */
export function isListedInManifest(
  install: InstallRecord,
  manifestInstalls: Array<{ name: string; items: string[] }>,
): boolean {
  return (
    install.scope !== 'global' &&
    manifestInstalls.some(
      (entry) =>
        entry.name === install.name || entry.items.includes(install.name),
    )
  );
}

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
  const signature = await editSignature(linkTarget).catch(() => null);
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
  const current = await editSignature(install.linkTarget).catch(() => null);
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
  // The deepest scope root wins: a global install (the home folder) contains
  // every project under it, but the project's own install is the closer one.
  const inScope = matches
    .filter((install) => isWithinDirectory(install.scopeRoot, cwd))
    .sort((left, right) => right.scopeRoot.length - left.scopeRoot.length);
  return inScope[0] ?? matches[0] ?? null;
}
