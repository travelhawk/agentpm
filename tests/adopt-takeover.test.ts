import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';

import { copyDir, initFixtureGitRepo, makeTempDir, writeFile } from './helpers';

const CI_TEST_TIMEOUT = 30_000;

// A skill installed into a project from a git source, so its files live in a
// cache snapshot: the state an `adopt` of a cache path started from.
async function setupGitInstall() {
  const homeDir = await makeTempDir('agentpm-home-');
  const repoDir = await makeTempDir('agentpm-repo-');
  const projectDir = await makeTempDir('agentpm-project-');
  await copyDir(path.resolve('tests/fixtures/repos/generic'), repoDir);
  initFixtureGitRepo(repoDir);

  const service = new AgentPmService({
    cwd: projectDir,
    env: { AGENTPM_HOME: homeDir },
  });
  await service.addSource(pathToFileURL(repoDir).href);
  const [install] = await service.install(['skill-b'], {
    scope: 'project',
    target: 'generic',
  });
  const libraryPath = path.join(homeDir, 'skills', 'skill-b');
  return { service, homeDir, projectDir, install: install!, libraryPath };
}

async function realpath(target: string): Promise<string> {
  return fs.realpath(target);
}

describe('adopt takes over existing installs', () => {
  test(
    'adopting a cache path adopts the install that uses it and leaves the cache alone',
    async () => {
      const { service, projectDir, install, libraryPath } =
        await setupGitInstall();
      try {
        expect(install.linkTarget).toContain(path.join('cache', 'repos'));

        const result = await service.adopt(install.linkTarget, {
          agents: ['generic'],
          yes: true,
        });

        expect(result.warnings.join('\n')).toMatch(/inside AgentPM's cache/);
        // The cache snapshot is still a real folder, not a link to the library.
        expect((await fs.lstat(install.linkTarget)).isSymbolicLink()).toBe(false);

        const installs = service.listInstalls();
        expect(installs).toHaveLength(1);
        expect(installs[0]).toMatchObject({
          adapter: 'generic',
          scope: 'project',
          scopeRoot: projectDir,
          targetPath: install.targetPath,
          metadata: { library: true },
        });
        expect(await realpath(install.targetPath)).toBe(
          await realpath(libraryPath),
        );
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'refuses a cache path that no install uses, with a pointer to what works',
    async () => {
      const { service, homeDir } = await setupGitInstall();
      try {
        await expect(
          service.adopt(path.join(homeDir, 'cache', 'repos', 'nothing-here')),
        ).rejects.toThrow(/inside AgentPM's cache[\s\S]*pass its name/);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'adopting a git-installed target replaces its record instead of failing',
    async () => {
      const { service, install } = await setupGitInstall();
      try {
        await service.adopt(install.targetPath, {
          agents: ['claude'],
          yes: true,
        });
        const installs = service.listInstalls();
        expect(installs.map((entry) => entry.adapter).sort()).toEqual([
          'claude',
          'generic',
        ]);
        expect(installs.every((entry) => entry.metadata.library === true)).toBe(
          true,
        );
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'moves a matching install of the same skill in the same scope to the library',
    async () => {
      const { service, projectDir, install } = await setupGitInstall();
      try {
        const claudeCopy = path.join(projectDir, '.claude', 'skills', 'skill-b');
        await copyDir(install.linkTarget, claudeCopy);

        const result = await service.adopt(claudeCopy, { agents: [], yes: true });

        expect(result.warnings.join('\n')).toMatch(
          /Moved the generic install of "skill-b" to the library copy/,
        );
        const installs = service.listInstalls();
        expect(installs.map((entry) => entry.adapter).sort()).toEqual([
          'claude',
          'generic',
        ]);
        expect(installs.every((entry) => entry.metadata.library === true)).toBe(
          true,
        );
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'leaves a same-scope install with different files unchanged',
    async () => {
      const { service, projectDir, install } = await setupGitInstall();
      try {
        const claudeCopy = path.join(projectDir, '.claude', 'skills', 'skill-b');
        await writeFile(path.join(claudeCopy, 'SKILL.md'), '# my own edit\n');

        const result = await service.adopt(claudeCopy, { agents: [], yes: true });

        expect(result.warnings.join('\n')).toMatch(
          /Left the generic install of "skill-b" unchanged/,
        );
        const generic = service
          .listInstalls()
          .find((entry) => entry.adapter === 'generic');
        expect(generic?.linkTarget).toBe(install.linkTarget);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'replaces a same-scope install with different files when its agent is named',
    async () => {
      const { service, projectDir, libraryPath } = await setupGitInstall();
      try {
        const claudeCopy = path.join(projectDir, '.claude', 'skills', 'skill-b');
        await writeFile(path.join(claudeCopy, 'SKILL.md'), '# my own edit\n');

        const result = await service.adopt(claudeCopy, {
          agents: ['generic'],
          yes: true,
        });

        expect(result.warnings.join('\n')).toMatch(
          /Replaced the generic install of "skill-b" with the library copy/,
        );
        const generic = service
          .listInstalls()
          .find((entry) => entry.adapter === 'generic');
        expect(generic?.linkTarget).toBe(libraryPath);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'doctor --fix removes installs that an older adopt linked inside the cache',
    async () => {
      const { service, install } = await setupGitInstall();
      try {
        // linkTarget is <checkout>/.agents/skills/skill-b
        const checkout = path.dirname(path.dirname(path.dirname(install.linkTarget)));
        const strayTarget = path.join(checkout, '.claude', 'skills', 'skill-b');
        await fs.mkdir(path.dirname(strayTarget), { recursive: true });
        await fs.symlink(install.linkTarget, strayTarget, 'junction');
        service.db.saveInstall({
          ...install,
          id: 'inst-stray',
          adapter: 'claude',
          scopeRoot: checkout,
          targetPath: strayTarget,
        });

        const issues = await service.doctor();
        expect(issues.some((issue) => issue.code === 'install-in-cache')).toBe(
          true,
        );
        const actions = await service.planDoctorFixes(issues);
        await service.applyDoctorFixes(actions);

        expect(service.db.getInstall('inst-stray')).toBeNull();
        await expect(fs.lstat(strayTarget)).rejects.toThrow();
        // The cache content the stray link pointed at is untouched.
        expect((await fs.lstat(install.linkTarget)).isDirectory()).toBe(true);
        expect(service.db.getInstall(install.id)).not.toBeNull();
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
});
