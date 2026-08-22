import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DiffEntry, SkillArchive, SkillArchiveFile } from '@agentpm/shared';
import {
  AgentPmError,
  SKILL_ARCHIVE_FORMAT_VERSION,
  assertSafeArchivePath,
  toPosixPath,
} from '@agentpm/shared';

const IGNORED_NAMES = new Set(['.git', 'node_modules', '.turbo', 'dist']);

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(targetPath: string): Promise<string> {
  return fs.readFile(targetPath, 'utf8');
}

export async function writeTextFile(targetPath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, content, 'utf8');
}

export async function listChildDirectories(rootPath: string): Promise<string[]> {
  if (!(await pathExists(rootPath))) {
    return [];
  }

  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function walkFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(currentPath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name)) {
        continue;
      }

      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  if (await pathExists(rootPath)) {
    await visit(rootPath);
  }

  return files.sort();
}

export async function computeTreeSignature(rootPath: string): Promise<string> {
  const files = await walkFiles(rootPath);
  const hash = createHash('sha1');
  for (const filePath of files) {
    const relativePath = toPosixPath(path.relative(rootPath, filePath));
    hash.update(relativePath);
    hash.update(await fs.readFile(filePath));
  }
  return hash.digest('hex');
}

async function mapFiles(rootPath: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const filePath of await walkFiles(rootPath)) {
    const relativePath = toPosixPath(path.relative(rootPath, filePath));
    const content = await fs.readFile(filePath);
    const contentHash = createHash('sha1').update(content).digest('hex');
    result.set(relativePath, contentHash);
  }
  return result;
}

export async function diffTrees(previousRoot: string, nextRoot: string): Promise<DiffEntry[]> {
  const previous = await mapFiles(previousRoot);
  const next = await mapFiles(nextRoot);
  const paths = new Set([...previous.keys(), ...next.keys()]);
  const result: DiffEntry[] = [];

  for (const relativePath of [...paths].sort()) {
    const before = previous.get(relativePath);
    const after = next.get(relativePath);

    if (!before && after) {
      result.push({ kind: 'added', path: relativePath });
    } else if (before && !after) {
      result.push({ kind: 'removed', path: relativePath });
    } else if (before && after && before !== after) {
      result.push({ kind: 'changed', path: relativePath });
    }
  }

  return result;
}

export async function ensureManagedLink(linkPath: string, targetPath: string): Promise<void> {
  await ensureDir(path.dirname(linkPath));

  if (path.resolve(linkPath) === path.resolve(targetPath)) {
    throw new AgentPmError(`Refusing to create a managed link to itself: ${linkPath}`);
  }

  if (await pathExists(linkPath)) {
    const stats = await fs.lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      throw new AgentPmError(`Refusing to replace existing non-link path: ${linkPath}`);
    }

    const resolvedExisting = await fs.realpath(linkPath);
    const resolvedTarget = await fs.realpath(targetPath);
    if (resolvedExisting === resolvedTarget) {
      return;
    }

    throw new AgentPmError(`Refusing to replace existing link with different target: ${linkPath}`);
  }

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(targetPath, linkPath, linkType);
}

export async function removeManagedLink(linkPath: string): Promise<void> {
  if (await pathExists(linkPath)) {
    await fs.rm(linkPath, { recursive: true, force: true });
  }
}

export async function isBrokenLink(linkPath: string): Promise<boolean> {
  try {
    const stats = await fs.lstat(linkPath);
    if (!stats.isSymbolicLink()) {
      return false;
    }
    await fs.realpath(linkPath);
    return false;
  } catch {
    return true;
  }
}

export async function realpathOrNull(targetPath: string): Promise<string | null> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return null;
  }
}

function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return true;
  }
  // Round-trip check: content that survives utf8 decode/encode unchanged is text.
  return Buffer.from(buffer.toString('utf8'), 'utf8').compare(buffer) !== 0;
}

export interface PackArchiveMetadata {
  name: string;
  version: string;
  kind: SkillArchive['kind'];
  target?: SkillArchive['target'];
  description?: string | undefined;
  tags?: string[] | undefined;
}

export async function packDirectoryToArchive(
  rootPath: string,
  metadata: PackArchiveMetadata,
): Promise<SkillArchive> {
  const files = await walkFiles(rootPath);
  if (files.length === 0) {
    throw new AgentPmError(`Nothing to pack: ${rootPath} contains no files.`);
  }

  const archiveFiles: SkillArchiveFile[] = [];
  for (const filePath of files) {
    const relativePath = toPosixPath(path.relative(rootPath, filePath));
    assertSafeArchivePath(relativePath);
    const buffer = await fs.readFile(filePath);
    const stats = await fs.stat(filePath);
    const binary = isProbablyBinary(buffer);
    archiveFiles.push({
      path: relativePath,
      encoding: binary ? 'base64' : 'utf8',
      content: binary ? buffer.toString('base64') : buffer.toString('utf8'),
      executable: (stats.mode & 0o111) !== 0 ? true : undefined,
    });
  }

  return {
    formatVersion: SKILL_ARCHIVE_FORMAT_VERSION,
    name: metadata.name,
    version: metadata.version,
    kind: metadata.kind,
    target: metadata.target,
    description: metadata.description,
    tags: metadata.tags,
    files: archiveFiles,
  };
}

export async function materializeArchive(
  archive: SkillArchive,
  targetDir: string,
): Promise<void> {
  const resolvedTarget = path.resolve(targetDir);
  await ensureDir(resolvedTarget);
  for (const file of archive.files) {
    assertSafeArchivePath(file.path);
    const destination = path.resolve(resolvedTarget, ...file.path.split('/'));
    const relative = path.relative(resolvedTarget, destination);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AgentPmError(`Archive escapes target directory: ${file.path}`);
    }
    await ensureDir(path.dirname(destination));
    const buffer =
      file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : Buffer.from(file.content, 'utf8');
    await fs.writeFile(destination, buffer);
    if (file.executable && process.platform !== 'win32') {
      await fs.chmod(destination, 0o755);
    }
  }
}

