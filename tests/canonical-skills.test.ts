import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';

import { git, makeTempDir, writeFile } from './helpers';

// Tests here shell out to the CLI (often twice, through tsx with its cache
// disabled), so a single case can legitimately take well over ten seconds on a
// busy machine. Use the same budget locally as on CI: the tighter local limit
// only produced timeout flakes, never a faster signal.
const CI_TEST_TIMEOUT = 30_000;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'AgentPM Tests',
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'AgentPM Tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
};

async function realpath(target: string): Promise<string> {
  return fs.realpath(target);
}

describe('canonical skill library', () => {
  test('push normalizes a native codex skill into the canonical skills/ folder', async () => {
    const projectDir = await makeTempDir('agentpm-canon-project-');
    const remoteDir = await makeTempDir('agentpm-canon-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const verifyDir = path.join(remoteDir, 'verify');

    git(remoteDir, 'init', '--bare', remoteRepo);
    await writeFile(
      path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
      '# codex skill\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: await makeTempDir('agentpm-canon-home-') },
    });
    try {
      const result = await service.push({
        target: remoteRepo,
        path: 'skill-a',
        message: 'canonical push',
      });
      expect(result.entries).toEqual(['skills/skill-a']);

      git(remoteDir, 'clone', remoteRepo, verifyDir);
      expect(
        await fs.readFile(
          path.join(verifyDir, 'skills', 'skill-a', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('# codex skill');
      // The original native path is not preserved in the destination.
      expect(
        await fs
          .stat(path.join(verifyDir, '.codex', 'skills', 'skill-a'))
          .catch(() => null),
      ).toBeNull();
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('push --preserve-layout keeps the native target-relative path', async () => {
    const projectDir = await makeTempDir('agentpm-canon-project-');
    const remoteDir = await makeTempDir('agentpm-canon-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const verifyDir = path.join(remoteDir, 'verify');

    git(remoteDir, 'init', '--bare', remoteRepo);
    await writeFile(
      path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
      '# codex skill\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: await makeTempDir('agentpm-canon-home-') },
    });
    try {
      const result = await service.push({
        target: remoteRepo,
        path: 'skill-a',
        preserveLayout: true,
        message: 'native push',
      });
      expect(result.entries).toEqual(['.codex/skills/skill-a']);

      git(remoteDir, 'clone', remoteRepo, verifyDir);
      expect(
        await fs.readFile(
          path.join(verifyDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('# codex skill');
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('push --all aborts when multiple native skills collapse into one canonical destination', async () => {
    const projectDir = await makeTempDir('agentpm-canon-project-');
    const remoteDir = await makeTempDir('agentpm-canon-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');

    git(remoteDir, 'init', '--bare', remoteRepo);
    await writeFile(
      path.join(projectDir, '.codex', 'skills', 'shared-name', 'SKILL.md'),
      '# codex variant\n',
    );
    await writeFile(
      path.join(projectDir, '.claude', 'skills', 'shared-name', 'SKILL.md'),
      '# claude variant\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: await makeTempDir('agentpm-canon-home-') },
    });
    try {
      await expect(
        service.push({
          target: remoteRepo,
          all: true,
          message: 'canonical push',
        }),
      ).rejects.toThrow(
        /Multiple entries resolve to the same canonical push destination/,
      );
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('pull materializes a canonical skill into multiple agents as symlinks to one library entry', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const projectDir = await makeTempDir('agentpm-canon-project-');
    const remoteDir = await makeTempDir('agentpm-canon-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const seedDir = path.join(remoteDir, 'seed');

    // Build a canonical skills repository: skills/<name>/SKILL.md
    git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
    await writeFile(
      path.join(seedDir, 'skills', 'demo', 'SKILL.md'),
      '# demo skill\n',
    );
    git(seedDir, 'init', '-b', 'main');
    git(seedDir, 'config', 'user.name', 'AgentPM Tests');
    git(seedDir, 'config', 'user.email', 'tests@example.com');
    git(seedDir, 'add', '.');
    git(seedDir, 'commit', '-m', 'seed');
    git(seedDir, 'remote', 'add', 'origin', remoteRepo);
    git(seedDir, 'push', 'origin', 'main');

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.pull({
        target: remoteRepo,
        agents: ['codex', 'claude', 'generic'],
        scope: 'project',
        yes: true,
      });

      expect(result.success).toBe(true);
      expect(result.skills).toEqual(['demo']);
      expect(result.installs).toHaveLength(3);

      const libraryEntry = path.join(homeDir, 'skills', 'demo');
      expect(
        await fs.readFile(path.join(libraryEntry, 'SKILL.md'), 'utf8'),
      ).toContain('# demo skill');

      const codexLink = path.join(projectDir, '.codex', 'skills', 'demo');
      const claudeLink = path.join(projectDir, '.claude', 'skills', 'demo');
      const genericLink = path.join(projectDir, '.agents', 'skills', 'demo');

      for (const link of [codexLink, claudeLink, genericLink]) {
        const stats = await fs.lstat(link);
        expect(stats.isSymbolicLink()).toBe(true);
        expect(await realpath(link)).toBe(await realpath(libraryEntry));
      }
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('push surfaces a managed library skill from a workspace where it is not installed', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const envDir = await makeTempDir('agentpm-canon-env-');
    const projectDir = await makeTempDir('agentpm-canon-project-');
    const remoteDir = await makeTempDir('agentpm-canon-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const verifyDir = path.join(remoteDir, 'verify');

    git(remoteDir, 'init', '--bare', remoteRepo);

    // Adopt a skill in one environment so it lands in the shared library.
    const originPath = path.join(envDir, '.claude', 'skills', 'helper');
    await writeFile(path.join(originPath, 'SKILL.md'), '# helper skill\n');
    const adoptService = new AgentPmService({
      cwd: envDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      await adoptService.adopt(originPath, { yes: true });
    } finally {
      adoptService.close();
    }

    // Push from an unrelated, empty project. The skill lives only in the
    // library, yet it must still be selectable and pushable by name.
    const pushService = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await pushService.push({
        target: remoteRepo,
        path: 'helper',
        message: 'push adopted skill',
      });
      expect(result.entries).toEqual(['skills/helper']);

      git(remoteDir, 'clone', remoteRepo, verifyDir);
      expect(
        await fs.readFile(
          path.join(verifyDir, 'skills', 'helper', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('# helper skill');
    } finally {
      pushService.close();
    }
  }, CI_TEST_TIMEOUT);

  test('pull skips skills that are already up to date instead of recopying them', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const projectDir = await makeTempDir('agentpm-canon-project-');
    const remoteDir = await makeTempDir('agentpm-canon-remote-');
    const remoteRepo = path.join(remoteDir, 'skills.git');
    const seedDir = path.join(remoteDir, 'seed');

    git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
    await writeFile(
      path.join(seedDir, 'skills', 'demo', 'SKILL.md'),
      '# demo skill\n',
    );
    git(seedDir, 'init', '-b', 'main');
    git(seedDir, 'config', 'user.name', 'AgentPM Tests');
    git(seedDir, 'config', 'user.email', 'tests@example.com');
    git(seedDir, 'add', '.');
    git(seedDir, 'commit', '-m', 'seed');
    git(seedDir, 'remote', 'add', 'origin', remoteRepo);
    git(seedDir, 'push', 'origin', 'main');

    const service = new AgentPmService({
      cwd: projectDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const first = await service.pull({
        target: remoteRepo,
        agents: ['codex', 'claude'],
        scope: 'project',
        yes: true,
      });
      expect(first.updated).toEqual(['demo']);
      expect(first.skipped).toEqual([]);
      expect(first.installs).toHaveLength(2);

      // Pulling the same version again should be a no-op: the skill is reported
      // as skipped, nothing is re-linked, and the library is left untouched.
      const second = await service.pull({
        target: remoteRepo,
        agents: ['codex', 'claude'],
        scope: 'project',
        yes: true,
      });
      expect(second.skills).toEqual(['demo']);
      expect(second.updated).toEqual([]);
      expect(second.skipped).toEqual(['demo']);
      expect(second.installs).toHaveLength(0);
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('adopt moves an existing skill into the library and fans it out to other agents', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const envDir = await makeTempDir('agentpm-canon-env-');

    // A skill that currently only lives in the Claude agent directory.
    const originPath = path.join(envDir, '.claude', 'skills', 'helper');
    await writeFile(path.join(originPath, 'SKILL.md'), '# helper skill\n');

    const service = new AgentPmService({
      cwd: envDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.adopt(originPath, {
        agents: ['codex', 'generic'],
        yes: true,
      });

      expect(result.success).toBe(true);
      expect(result.name).toBe('helper');

      const libraryEntry = path.join(homeDir, 'skills', 'helper');
      expect(
        await fs.readFile(path.join(libraryEntry, 'SKILL.md'), 'utf8'),
      ).toContain('# helper skill');

      // Origin is replaced by a managed symlink into the library.
      const originStats = await fs.lstat(originPath);
      expect(originStats.isSymbolicLink()).toBe(true);
      expect(await realpath(originPath)).toBe(await realpath(libraryEntry));

      // Other agents now symlink to the same single source of truth.
      const codexLink = path.join(envDir, '.codex', 'skills', 'helper');
      const genericLink = path.join(envDir, '.agents', 'skills', 'helper');
      for (const link of [codexLink, genericLink]) {
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
        expect(await realpath(link)).toBe(await realpath(libraryEntry));
      }
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('remove can disambiguate duplicate fan-out installs by target without a prompt', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const envDir = await makeTempDir('agentpm-canon-env-');

    const originPath = path.join(envDir, '.claude', 'skills', 'helper');
    await writeFile(path.join(originPath, 'SKILL.md'), '# helper skill\n');

    const service = new AgentPmService({
      cwd: envDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      await service.adopt(originPath, {
        agents: ['codex', 'generic'],
        yes: true,
      });

      const removed = await service.removeInstall('helper', {
        adapter: 'codex',
      });

      expect(removed.adapter).toBe('codex');
      await expect(
        service.removeInstall('helper', { adapter: 'codex' }),
      ).rejects.toThrow(/No install named "helper" found/);

      const libraryEntry = path.join(homeDir, 'skills', 'helper');
      expect(
        await fs.readFile(path.join(libraryEntry, 'SKILL.md'), 'utf8'),
      ).toContain('# helper skill');

      const codexLink = path.join(envDir, '.codex', 'skills', 'helper');
      const claudeLink = path.join(envDir, '.claude', 'skills', 'helper');
      const genericLink = path.join(envDir, '.agents', 'skills', 'helper');

      await expect(fs.lstat(codexLink)).rejects.toThrow();
      for (const link of [claudeLink, genericLink]) {
        expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
        expect(await realpath(link)).toBe(await realpath(libraryEntry));
      }
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('remove reports filter flags when duplicate installs cannot be disambiguated non-interactively', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const envDir = await makeTempDir('agentpm-canon-env-');

    const originPath = path.join(envDir, '.claude', 'skills', 'helper');
    await writeFile(path.join(originPath, 'SKILL.md'), '# helper skill\n');

    const service = new AgentPmService({
      cwd: envDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
      prompts: {},
    });
    try {
      await service.adopt(originPath, {
        agents: ['codex', 'generic'],
        yes: true,
      });

      await expect(service.removeInstall('helper')).rejects.toThrow(
        /--target, --scope, or --path/,
      );
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('adopt by name from the library fans out without replacing the library with a self-link', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const envDir = await makeTempDir('agentpm-canon-env-');
    const fakeUserHome = await makeTempDir('agentpm-canon-user-home-');
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const skillName = `helper-${Date.now()}`;

    const originPath = path.join(envDir, '.agents', 'skills', skillName);
    await writeFile(path.join(originPath, 'SKILL.md'), '# helper skill\n');

    try {
      process.env.HOME = fakeUserHome;
      process.env.USERPROFILE = fakeUserHome;

      const firstService = new AgentPmService({
        cwd: envDir,
        env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
      });
      try {
        await firstService.adopt(originPath, {
          agents: ['codex', 'generic'],
          yes: true,
        });
      } finally {
        firstService.close();
      }

      const libraryEntry = path.join(homeDir, 'skills', skillName);
      const librarySkillFile = path.join(libraryEntry, 'SKILL.md');
      expect(await fs.readFile(librarySkillFile, 'utf8')).toContain(
        '# helper skill',
      );

      const secondService = new AgentPmService({
        cwd: homeDir,
        env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
      });
      try {
        const result = await secondService.adopt(skillName, {
          agents: ['claude'],
          yes: true,
        });

        expect(result.success).toBe(true);
        expect(await fs.readFile(librarySkillFile, 'utf8')).toContain(
          '# helper skill',
        );
        expect((await fs.lstat(libraryEntry)).isSymbolicLink()).toBe(false);

        const claudeLink = path.join(
          os.homedir(),
          '.claude',
          'skills',
          skillName,
        );
        expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
        expect(await realpath(claudeLink)).toBe(await realpath(libraryEntry));
      } finally {
        secondService.close();
      }
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }
  }, CI_TEST_TIMEOUT);

  test('fan-out skips a pre-existing unmanaged directory instead of aborting', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const envDir = await makeTempDir('agentpm-canon-env-');

    const originPath = path.join(envDir, '.claude', 'skills', 'helper');
    await writeFile(path.join(originPath, 'SKILL.md'), '# helper skill\n');

    // Codex already has a real, unmanaged skill directory of the same name.
    const codexReal = path.join(envDir, '.codex', 'skills', 'helper');
    await writeFile(path.join(codexReal, 'SKILL.md'), '# pre-existing codex\n');

    const service = new AgentPmService({
      cwd: envDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.adopt(originPath, {
        agents: ['codex', 'generic'],
        yes: true,
      });

      expect(result.success).toBe(true);
      // Codex is skipped with a warning; its real content is left untouched.
      expect(result.warnings.some((w) => w.includes('codex'))).toBe(true);
      const codexStats = await fs.lstat(codexReal);
      expect(codexStats.isSymbolicLink()).toBe(false);
      expect(
        await fs.readFile(path.join(codexReal, 'SKILL.md'), 'utf8'),
      ).toContain('# pre-existing codex');

      // Generic still links to the library.
      const genericLink = path.join(envDir, '.agents', 'skills', 'helper');
      expect((await fs.lstat(genericLink)).isSymbolicLink()).toBe(true);
      expect(await realpath(genericLink)).toBe(
        await realpath(path.join(homeDir, 'skills', 'helper')),
      );
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);

  test('adopt aborts before replacing a local skill when the library already has different contents', async () => {
    const homeDir = await makeTempDir('agentpm-canon-home-');
    const envDir = await makeTempDir('agentpm-canon-env-');

    const libraryEntry = path.join(homeDir, 'skills', 'helper');
    await writeFile(path.join(libraryEntry, 'SKILL.md'), '# library helper\n');

    const originPath = path.join(envDir, '.claude', 'skills', 'helper');
    await writeFile(path.join(originPath, 'SKILL.md'), '# local helper\n');

    const service = new AgentPmService({
      cwd: envDir,
      env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
    });
    try {
      await expect(
        service.adopt(originPath, {
          agents: ['codex'],
          yes: true,
        }),
      ).rejects.toThrow(/already exists in the AgentPM library/);

      const originStats = await fs.lstat(originPath);
      expect(originStats.isSymbolicLink()).toBe(false);
      expect(await fs.readFile(path.join(originPath, 'SKILL.md'), 'utf8')).toContain(
        '# local helper',
      );
      expect(
        await fs.readFile(path.join(libraryEntry, 'SKILL.md'), 'utf8'),
      ).toContain('# library helper');
    } finally {
      service.close();
    }
  }, CI_TEST_TIMEOUT);
});
