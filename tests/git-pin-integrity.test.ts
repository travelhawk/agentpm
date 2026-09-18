import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';
import { materializeGitRelease, resolveReleasePath } from '@agentpm/git';

import { copyDir, git, makeTempDir, writeFile } from './helpers';

const CI_TEST_TIMEOUT = process.env.CI ? 30_000 : 15_000;
const SKILL_PATH = path.join('.codex', 'skills', 'skill-a', 'SKILL.md');
const EVIL_MARKER = 'Evil content after the pin.';

interface PinFixture {
  repoDir: string;
  pinnedRevision: string;
  tipRevision: string;
}

function commitAll(repoDir: string, message: string): string {
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-m', message);
  return git(repoDir, 'rev-parse', 'HEAD');
}

// Builds a repo whose default branch name tries to shadow the pinned commit.
// `branchName` may depend on the pinned SHA, so it is applied after commit one.
async function createShadowingRepo(
  branchName: (pinnedRevision: string) => string,
): Promise<PinFixture> {
  const repoDir = await makeTempDir('agentpm-git-pin-source-');
  await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
  git(repoDir, 'init', '-b', 'main');
  git(repoDir, 'config', 'user.name', 'AgentPM Tests');
  git(repoDir, 'config', 'user.email', 'tests@example.com');
  const pinnedRevision = commitAll(repoDir, 'good');
  git(repoDir, 'branch', '-m', branchName(pinnedRevision));

  await writeFile(
    path.join(repoDir, SKILL_PATH),
    `# Skill A\n\n${EVIL_MARKER}\n`,
  );
  const tipRevision = commitAll(repoDir, 'evil');
  return { repoDir, pinnedRevision, tipRevision };
}

async function readSkill(root: string): Promise<string> {
  return fs.readFile(path.join(root, SKILL_PATH), 'utf8');
}

describe('git pin integrity', () => {
  test(
    'pins the requested commit when the default branch is named FETCH_HEAD',
    async () => {
      const fixture = await createShadowingRepo(() => 'FETCH_HEAD');
      expect(fixture.tipRevision).not.toBe(fixture.pinnedRevision);

      for (const pin of [
        { revision: fixture.pinnedRevision },
        { ref: fixture.pinnedRevision },
      ]) {
        const basePath = await makeTempDir('agentpm-git-pin-cache-');
        const release = await materializeGitRelease({
          locator: fixture.repoDir,
          basePath,
          sparsePaths: [],
          ...pin,
        });

        expect(release.revision).toBe(fixture.pinnedRevision);
        expect(git(release.releasePath, 'rev-parse', 'HEAD')).toBe(
          fixture.pinnedRevision,
        );
        expect(await readSkill(release.releasePath)).not.toContain(EVIL_MARKER);
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'pins the requested commit when the default branch is named like the pinned SHA',
    async () => {
      const fixture = await createShadowingRepo((pinned) => pinned);
      const basePath = await makeTempDir('agentpm-git-pin-cache-');

      const release = await materializeGitRelease({
        locator: fixture.repoDir,
        basePath,
        sparsePaths: [],
        revision: fixture.pinnedRevision,
      });

      expect(release.revision).toBe(fixture.pinnedRevision);
      expect(await readSkill(release.releasePath)).not.toContain(EVIL_MARKER);
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'installs the pinned commit through the service with an isolated AGENTPM_HOME',
    async () => {
      const fixture = await createShadowingRepo(() => 'FETCH_HEAD');
      const homeDir = await makeTempDir('agentpm-home-');
      const projectDir = await makeTempDir('agentpm-project-');

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(fixture.repoDir);
        const installs = await service.install(['skill-a'], {
          scope: 'project',
          ref: fixture.pinnedRevision,
        });

        expect(installs[0]?.installedRevision).toBe(fixture.pinnedRevision);
        expect(await readSkill(projectDir)).not.toContain(EVIL_MARKER);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'replaces a cached release whose HEAD is not the pinned commit',
    async () => {
      const fixture = await createShadowingRepo(() => 'main');
      const basePath = await makeTempDir('agentpm-git-pin-cache-');
      const options = {
        locator: fixture.repoDir,
        basePath,
        sparsePaths: [],
        revision: fixture.pinnedRevision,
      };

      const first = await materializeGitRelease(options);
      // Poison the cache entry: same folder, but HEAD is the newer commit.
      git(first.releasePath, 'checkout', '--quiet', '--detach', 'origin/main');
      expect(git(first.releasePath, 'rev-parse', 'HEAD')).toBe(
        fixture.tipRevision,
      );
      expect(await readSkill(first.releasePath)).toContain(EVIL_MARKER);

      const second = await materializeGitRelease(options);

      expect(second.releasePath).toBe(first.releasePath);
      expect(second.revision).toBe(fixture.pinnedRevision);
      expect(git(second.releasePath, 'rev-parse', 'HEAD')).toBe(
        fixture.pinnedRevision,
      );
      expect(await readSkill(second.releasePath)).not.toContain(EVIL_MARKER);
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'keeps a verified cached release without cloning again',
    async () => {
      const fixture = await createShadowingRepo(() => 'main');
      const basePath = await makeTempDir('agentpm-git-pin-cache-');
      const options = {
        locator: fixture.repoDir,
        basePath,
        sparsePaths: [],
        revision: fixture.pinnedRevision,
      };

      const first = await materializeGitRelease(options);
      const markerPath = path.join(first.releasePath, 'cache-marker.txt');
      await writeFile(markerPath, 'still here');

      const second = await materializeGitRelease(options);

      expect(second).toEqual({
        releasePath: first.releasePath,
        revision: fixture.pinnedRevision,
      });
      expect(await fs.readFile(markerPath, 'utf8')).toBe('still here');
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'checks out the tagged commit when pinned by an annotated tag object id',
    async () => {
      const fixture = await createShadowingRepo(() => 'main');
      git(
        fixture.repoDir,
        'tag',
        '-a',
        'v1.0.0',
        '-m',
        'release',
        fixture.pinnedRevision,
      );
      const tagObject = git(fixture.repoDir, 'rev-parse', 'v1.0.0');
      expect(tagObject).not.toBe(fixture.pinnedRevision);
      const basePath = await makeTempDir('agentpm-git-pin-cache-');
      const options = {
        locator: fixture.repoDir,
        basePath,
        sparsePaths: [],
        ref: 'v1.0.0',
        revision: tagObject,
      };

      const first = await materializeGitRelease(options);
      expect(first.revision).toBe(fixture.pinnedRevision);

      // The cached release is keyed by the tag object and must stay trusted.
      const markerPath = path.join(first.releasePath, 'cache-marker.txt');
      await writeFile(markerPath, 'still here');
      await materializeGitRelease(options);
      expect(await fs.readFile(markerPath, 'utf8')).toBe('still here');
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'removes the release folder when the pinned commit cannot be fetched',
    async () => {
      const fixture = await createShadowingRepo(() => 'main');
      const basePath = await makeTempDir('agentpm-git-pin-cache-');
      const missingRevision = 'f'.repeat(40);

      await expect(
        materializeGitRelease({
          locator: fixture.repoDir,
          basePath,
          sparsePaths: [],
          revision: missingRevision,
        }),
      ).rejects.toThrow();

      await expect(
        fs.stat(resolveReleasePath(basePath, missingRevision)),
      ).rejects.toThrow();
    },
    CI_TEST_TIMEOUT,
  );

  test('rejects locators, refs, and revisions that start with a dash', async () => {
    const basePath = await makeTempDir('agentpm-git-pin-cache-');
    const base = { basePath, sparsePaths: [] };

    await expect(
      materializeGitRelease({ ...base, locator: '--upload-pack=evil' }),
    ).rejects.toThrow(/starts with "-"/);
    await expect(
      materializeGitRelease({
        ...base,
        locator: 'https://example.invalid/repo.git',
        ref: '--upload-pack=evil',
      }),
    ).rejects.toThrow(/starts with "-"/);
    await expect(
      materializeGitRelease({
        ...base,
        locator: 'https://example.invalid/repo.git',
        revision: '-c',
      }),
    ).rejects.toThrow(/starts with "-"/);
  });
});
