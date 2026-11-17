import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';
import { removeManagedLink } from '@agentpm/fs';

import { git, initFixtureGitRepo, makeTempDir, writeFile } from './helpers';

const CI_TEST_TIMEOUT = 30_000;

async function exists(target: string): Promise<boolean> {
  return fs
    .lstat(target)
    .then(() => true)
    .catch(() => false);
}

function skillMd(name: string, body = 'v1'): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;
}

async function makeService(cwd?: string) {
  const homeDir = await makeTempDir('agentpm-home-');
  const projectDir = cwd ?? (await makeTempDir('agentpm-project-'));
  const service = new AgentPmService({
    cwd: projectDir,
    env: { AGENTPM_HOME: homeDir },
  });
  return { service, homeDir, projectDir };
}

async function makeTwoSkillRepo() {
  const repoDir = await makeTempDir('agentpm-repo-');
  for (const name of ['alpha', 'beta']) {
    await writeFile(
      path.join(repoDir, 'skills', name, 'SKILL.md'),
      skillMd(name),
    );
  }
  initFixtureGitRepo(repoDir);
  return repoDir;
}

describe('reliability fixes', () => {
  test(
    'adopt keeps .git, node_modules, empty folders and nested links of the skill',
    async () => {
      const { service, homeDir, projectDir } = await makeService();
      try {
        const origin = path.join(projectDir, '.claude', 'skills', 'helper');
        await writeFile(path.join(origin, 'SKILL.md'), skillMd('helper'));
        await writeFile(path.join(origin, '.git', 'HEAD'), 'ref: x\n');
        await writeFile(path.join(origin, 'node_modules', 'x', 'i.js'), '1');
        await fs.mkdir(path.join(origin, 'empty'));
        const outside = await makeTempDir('agentpm-outside-');
        await fs.symlink(
          outside,
          path.join(origin, 'linked'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );

        await service.adopt(origin, { agents: [], yes: true });

        const library = path.join(homeDir, 'skills', 'helper');
        expect(await exists(path.join(library, '.git', 'HEAD'))).toBe(true);
        expect(await exists(path.join(library, 'node_modules', 'x', 'i.js'))).toBe(
          true,
        );
        expect(await exists(path.join(library, 'empty'))).toBe(true);
        expect((await fs.lstat(path.join(library, 'linked'))).isSymbolicLink()).toBe(
          true,
        );
        // The original location is now a link into the library.
        expect((await fs.lstat(origin)).isSymbolicLink()).toBe(true);
        expect(await exists(path.join(origin, '.git', 'HEAD'))).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'update refreshes every skill installed from the same repository',
    async () => {
      const repoDir = await makeTwoSkillRepo();
      const { service, projectDir } = await makeService();
      try {
        await service.addSource(pathToFileURL(repoDir).href);
        await service.install(['alpha', 'beta'], {
          scope: 'project',
          target: 'generic',
        });

        for (const name of ['alpha', 'beta']) {
          await writeFile(
            path.join(repoDir, 'skills', name, 'SKILL.md'),
            skillMd(name, 'v2'),
          );
        }
        git(repoDir, 'commit', '-am', 'second');

        await service.update({ apply: true, yes: true });

        for (const name of ['alpha', 'beta']) {
          const content = await fs.readFile(
            path.join(projectDir, '.agents', 'skills', name, 'SKILL.md'),
            'utf8',
          );
          expect(content).toContain('v2');
        }
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'removeManagedLink refuses a real folder and removes broken links',
    async () => {
      const dir = await makeTempDir('agentpm-links-');
      const real = path.join(dir, 'real');
      await writeFile(path.join(real, 'SKILL.md'), 'keep me');
      await expect(removeManagedLink(real)).rejects.toThrow(
        /not a link AgentPM created/,
      );
      expect(await exists(path.join(real, 'SKILL.md'))).toBe(true);

      const gone = path.join(dir, 'gone');
      await fs.mkdir(gone);
      const broken = path.join(dir, 'broken');
      await fs.symlink(
        gone,
        broken,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await fs.rm(gone, { recursive: true });
      await removeManagedLink(broken);
      expect(await exists(broken)).toBe(false);
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'remove keeps the install record when a real folder sits at the target',
    async () => {
      const repoDir = await makeTwoSkillRepo();
      const { service, projectDir } = await makeService();
      try {
        await service.addSource(pathToFileURL(repoDir).href);
        const [install] = await service.install(['alpha'], {
          scope: 'project',
          target: 'generic',
        });
        const target = install!.targetPath;
        // The user replaced the link with their own folder.
        await fs.rm(target, { recursive: true, force: true });
        await writeFile(path.join(target, 'SKILL.md'), 'my own work');

        await expect(service.removeInstall('alpha')).rejects.toThrow(
          /not a link AgentPM created/,
        );
        expect(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8')).toBe(
          'my own work',
        );
        expect(service.listInstalls()).toHaveLength(1);
        expect(projectDir).toBeTruthy();
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'adopting a link that points outside the library fails before copying',
    async () => {
      const { service, homeDir, projectDir } = await makeService();
      try {
        const devRepo = await makeTempDir('agentpm-dev-');
        const devSkill = path.join(devRepo, 'helper');
        await writeFile(path.join(devSkill, 'SKILL.md'), skillMd('helper'));
        const link = path.join(projectDir, '.claude', 'skills', 'helper');
        await fs.mkdir(path.dirname(link), { recursive: true });
        await fs.symlink(
          devSkill,
          link,
          process.platform === 'win32' ? 'junction' : 'dir',
        );

        await expect(
          service.adopt(link, { agents: [], yes: true }),
        ).rejects.toThrow(/is a link to[\s\S]*agentpm adopt/);

        expect(await exists(path.join(homeDir, 'skills', 'helper'))).toBe(false);
        expect(service.listInstalls()).toHaveLength(0);
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
        expect(await exists(path.join(devSkill, 'SKILL.md'))).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'doctor --fix removes a dangling link with its stale record, but never a repairable install',
    async () => {
      const repoDir = await makeTwoSkillRepo();
      const { service, homeDir } = await makeService();
      try {
        await service.addSource(pathToFileURL(repoDir).href);
        const [install] = await service.install(['alpha'], {
          scope: 'project',
          target: 'generic',
        });
        // Break the link by deleting the cache content it points to.
        await fs.rm(path.join(homeDir, 'cache'), {
          recursive: true,
          force: true,
        });
        expect((await fs.lstat(install!.targetPath)).isSymbolicLink()).toBe(
          true,
        );

        const issues = await service.doctor();
        await service.applyDoctorFixes(await service.planDoctorFixes(issues));

        // Windows junctions still answer fs.access once their target is gone,
        // so doctor reports broken-link there: `agentpm update` can restore it,
        // and --fix must not uninstall it. POSIX reports install-missing, a
        // stale record whose dangling link goes with it.
        if (issues.some((issue) => issue.code === 'broken-link')) {
          expect(
            issues.find((issue) => issue.code === 'broken-link')?.remedy,
          ).toMatch(/agentpm update alpha/);
          expect(service.listInstalls()).toHaveLength(1);
          // The remedy must hold: update restores the skill.
          await service.update({ names: ['alpha'], apply: true, yes: true });
          expect(await exists(path.join(install!.targetPath, 'SKILL.md'))).toBe(
            true,
          );
        } else {
          expect(
            issues.some((issue) => issue.code === 'install-missing'),
          ).toBe(true);
          expect(await exists(install!.targetPath)).toBe(false);
          expect(service.listInstalls()).toHaveLength(0);
        }
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'remove --purge also drops the cache_repos row',
    async () => {
      const repoDir = await makeTwoSkillRepo();
      const { service } = await makeService();
      try {
        await service.addSource(pathToFileURL(repoDir).href);
        const [install] = await service.install(['alpha'], {
          scope: 'project',
          target: 'generic',
        });
        const cacheKey = install!.cacheKey!;
        expect(service.db.getCacheRepo(cacheKey)).not.toBeNull();

        await service.removeInstall('alpha', { purge: true });

        expect(service.db.getCacheRepo(cacheKey)).toBeNull();
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
});
