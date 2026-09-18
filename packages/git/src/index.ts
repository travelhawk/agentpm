import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ensureDir, pathExists } from '@agentpm/fs';
import {
  AgentPmError,
  isGitRevision,
  normalizeGitHubRepoLocator,
  type ContentKind,
} from '@agentpm/shared';
import { simpleGit } from 'simple-git';

export const DEFAULT_DISCOVERY_PATHS = [
  '.codex',
  '.claude',
  '.agents',
  'skills',
  'subagents',
  'install.sh',
  'install.ps1',
  'install.js',
  'install.mjs',
];

export interface GitReleaseOptions {
  locator: string;
  basePath: string;
  sparsePaths: string[];
  ref?: string | null | undefined;
  revision?: string | null | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface GitRelease {
  releasePath: string;
  revision: string;
}

export interface GitCommandResult {
  stdout: string;
}

export interface GitCommandOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  captureStdout?: boolean | undefined;
}

export function resolveReleasePath(basePath: string, revision: string): string {
  return path.join(basePath, 'r', revision.slice(0, 12));
}

export async function isLocalGitRepository(locator: string): Promise<boolean> {
  const gitDirectory = path.join(locator, '.git');
  return pathExists(gitDirectory);
}

function resolveGitEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}

function isFullGitRevision(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

// A value that starts with "-" would be parsed by git as an option
// (for example --upload-pack=<command>), so it is never a valid locator or ref.
function assertSafeGitArgument(value: string, label: string): void {
  if (value.trim().startsWith('-')) {
    throw new AgentPmError(
      `Refusing git ${label} that starts with "-": ${value}`,
    );
  }
}

async function resolveCommitInRepo(
  repoPath: string,
  revision: string,
): Promise<string | null> {
  try {
    const output = await simpleGit(repoPath).revparse([
      '--verify',
      `${revision}^{commit}`,
    ]);
    const commit = output.trim().toLowerCase();
    return isFullGitRevision(commit) ? commit : null;
  } catch {
    return null;
  }
}

// A full object id always resolves by content, so it cannot be shadowed by a
// branch or tag with a confusing name such as FETCH_HEAD.
async function releaseMatchesRevision(
  releasePath: string,
  revision: string,
): Promise<boolean> {
  if (!(await pathExists(path.join(releasePath, '.git')))) {
    return false;
  }
  const head = await resolveCommitInRepo(releasePath, 'HEAD');
  if (!head) {
    return false;
  }
  if (head === revision.toLowerCase()) {
    return true;
  }
  return head === (await resolveCommitInRepo(releasePath, revision));
}

async function toGitTransportLocator(locator: string): Promise<string> {
  const normalizedGithub = normalizeGitHubRepoLocator(locator);
  if (normalizedGithub.startsWith('github:')) {
    return `https://github.com/${normalizedGithub
      .slice('github:'.length)
      .replace(/^\/+/, '')
      .replace(/\.git$/i, '')}.git`;
  }
  if (
    locator.includes('://') ||
    locator.includes('@') ||
    locator.endsWith('.git')
  ) {
    const localPath = path.resolve(locator);
    if (await pathExists(localPath)) {
      return pathToFileURL(localPath).href;
    }
    return locator;
  }

  const localPath = path.resolve(locator);
  if (await pathExists(localPath)) {
    return pathToFileURL(localPath).href;
  }

  return locator;
}

export async function runGitCommand(
  args: string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const stdoutChunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env: resolveGitEnv(options.env),
      stdio: options.captureStdout ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      windowsHide: false,
    });

    if (options.captureStdout) {
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdoutChunks.push(
          typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
        );
      });
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new AgentPmError(
          `git ${args[0] ?? 'command'} failed with exit code ${code ?? 'unknown'}`,
        ),
      );
    });
  });

  return {
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
  };
}

export async function resolveGitRevision(
  locator: string,
  ref?: string | null,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  assertSafeGitArgument(locator, 'locator');
  if (ref) {
    assertSafeGitArgument(ref, 'ref');
  }

  if (await isLocalGitRepository(locator)) {
    const repo = simpleGit(locator);
    const revision = await repo.revparse([ref ?? 'HEAD']);
    return revision.trim();
  }

  const target = ref ?? 'HEAD';
  const output = await runGitCommand(['ls-remote', '--', locator, target], {
    env,
    captureStdout: true,
  });
  const firstLine = output.stdout
    .split('\n')
    .find((line) => line.trim().length > 0);
  const revision = firstLine?.split('\t')[0]?.trim();
  if (!revision) {
    throw new AgentPmError(`Could not resolve remote revision for ${locator}`);
  }
  return revision;
}

export async function materializeGitRelease(
  options: GitReleaseOptions,
): Promise<GitRelease> {
  assertSafeGitArgument(options.locator, 'locator');
  if (options.ref) {
    assertSafeGitArgument(options.ref, 'ref');
  }
  if (options.revision) {
    assertSafeGitArgument(options.revision, 'revision');
  }

  await ensureDir(options.basePath);
  const transportLocator = await toGitTransportLocator(options.locator);
  assertSafeGitArgument(transportLocator, 'locator');
  const targetRevision =
    options.revision ??
    (await resolveGitRevision(
      options.locator,
      options.ref ?? undefined,
      options.env,
    ));
  const pinnedRevision = resolvePinnedRevision(options, targetRevision);
  const releasePath = resolveReleasePath(options.basePath, targetRevision);
  if (await pathExists(releasePath)) {
    const expectedRevision =
      pinnedRevision ??
      (isFullGitRevision(targetRevision) ? targetRevision : null);
    if (
      !expectedRevision ||
      (await releaseMatchesRevision(releasePath, expectedRevision))
    ) {
      return { releasePath, revision: targetRevision };
    }
    // The cached release does not hold the revision it is keyed by.
    await fs.rm(releasePath, { recursive: true, force: true });
  }

  await ensureDir(path.dirname(releasePath));
  const cloneArgs = ['--depth', '1', '--filter=blob:none', '--no-checkout'];
  if (options.ref && !isGitRevision(options.ref)) {
    cloneArgs.push('--branch', options.ref);
  }

  try {
    await runGitCommand(
      ['clone', '--quiet', ...cloneArgs, '--', transportLocator, releasePath],
      {
        env: options.env,
      },
    );

    const repo = simpleGit(releasePath);
    if (options.sparsePaths.length > 0) {
      await repo.raw(['sparse-checkout', 'init', '--cone']);
      await repo.raw(['sparse-checkout', 'set', ...options.sparsePaths]);
    }

    if (pinnedRevision) {
      await runGitCommand(
        ['fetch', '--quiet', '--depth', '1', '--', 'origin', pinnedRevision],
        {
          cwd: releasePath,
          env: options.env,
        },
      );
      // Check out by object id. `git checkout FETCH_HEAD` would switch to a
      // remote branch that is literally named FETCH_HEAD instead.
      await repo.raw([
        'checkout',
        '--quiet',
        '--detach',
        `${pinnedRevision}^{commit}`,
      ]);
    } else {
      await repo.checkout(['HEAD']);
    }

    const revision = (await repo.revparse(['HEAD'])).trim();
    if (pinnedRevision) {
      const expectedCommit = await resolveCommitInRepo(
        releasePath,
        pinnedRevision,
      );
      if (revision.toLowerCase() !== expectedCommit) {
        throw new AgentPmError(
          `Pinned revision mismatch for ${options.locator}: expected ${pinnedRevision}, but the checkout is at ${revision}. The cached release was removed.`,
        );
      }
    }
    return { releasePath, revision };
  } catch (error) {
    // Never leave a partial or unverified release behind; a later run would
    // find the folder and trust it.
    await fs.rm(releasePath, { recursive: true, force: true });
    throw error;
  }
}

function resolvePinnedRevision(
  options: GitReleaseOptions,
  targetRevision: string,
): string | null {
  const requested =
    options.revision && isGitRevision(options.revision)
      ? options.revision
      : options.ref && isGitRevision(options.ref)
        ? options.ref
        : null;
  if (!requested) {
    return null;
  }
  if (isFullGitRevision(requested)) {
    return requested.toLowerCase();
  }
  // Short or hex-like refs were resolved to a full object id above.
  if (isFullGitRevision(targetRevision)) {
    return targetRevision.toLowerCase();
  }
  throw new AgentPmError(
    `Cannot pin ${options.locator} to ${requested}: use the full 40-character commit SHA.`,
  );
}

export async function createTemporaryGitRelease(
  locator: string,
  sparsePaths: string[],
  ref?: string | null,
  env?: NodeJS.ProcessEnv,
): Promise<GitRelease> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentpm-inspect-'));
  return materializeGitRelease({
    locator,
    basePath: tempRoot,
    sparsePaths,
    ref,
    env,
  });
}

export function normalizeSparsePaths(paths: string[]): string[] {
  return [
    ...new Set(
      paths
        .map((entry) => entry.replace(/\\/g, '/').replace(/\/+$/, ''))
        .filter(Boolean),
    ),
  ].sort();
}

export async function cleanupTemporaryRelease(
  releasePath: string,
): Promise<void> {
  const root = path.dirname(path.dirname(releasePath));
  await fs.rm(root, { recursive: true, force: true });
}

export function inferContentKind(locator: string): ContentKind {
  const normalizedGithub = normalizeGitHubRepoLocator(locator);
  return normalizedGithub.includes('://') ||
    normalizedGithub.endsWith('.git') ||
    normalizedGithub.includes('@') ||
    normalizedGithub.startsWith('github:')
    ? 'git'
    : 'local';
}
