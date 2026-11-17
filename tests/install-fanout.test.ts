import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';

import { git, initFixtureGitRepo, makeTempDir, writeFile } from './helpers';

const CI_TEST_TIMEOUT = 30_000;

function skillMd(name: string, body = 'v1'): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`;
}

async function setup() {
  const repoDir = await makeTempDir('agentpm-repo-');
  await writeFile(
    path.join(repoDir, 'skills', 'alpha', 'SKILL.md'),
    skillMd('alpha'),
  );
  initFixtureGitRepo(repoDir);
  const homeDir = await makeTempDir('agentpm-home-');
  const projectDir = await makeTempDir('agentpm-project-');
  const service = new AgentPmService({
    cwd: projectDir,
    env: { AGENTPM_HOME: homeDir },
  });
  await service.addSource(pathToFileURL(repoDir).href);
  return { service, repoDir, projectDir };
}

describe('install for several agents', () => {
  test(
    'a skill from a plain skills/ folder is linked into every requested agent',
    async () => {
      const { service, projectDir } = await setup();
      try {
        const installs = await service.install(['alpha'], {
          scope: 'project',
          targets: ['claude', 'codex', 'generic'],
        });

        expect(installs.map((install) => install.adapter).sort()).toEqual([
          'claude',
          'codex',
          'generic',
        ]);
        for (const root of ['.claude', '.codex', '.agents']) {
          const content = await fs.readFile(
            path.join(projectDir, root, 'skills', 'alpha', 'SKILL.md'),
            'utf8',
          );
          expect(content).toContain('alpha');
        }
        // One checkout behind all three links.
        expect(
          new Set(installs.map((install) => install.linkTarget)).size,
        ).toBe(1);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'a single --target claude works for a skill in plain skills/',
    async () => {
      const { service, projectDir } = await setup();
      try {
        const installs = await service.install(['alpha'], {
          scope: 'project',
          target: 'claude',
        });

        expect(installs).toHaveLength(1);
        expect(installs[0]!.adapter).toBe('claude');
        expect(
          (
            await fs.lstat(path.join(projectDir, '.claude', 'skills', 'alpha'))
          ).isSymbolicLink(),
        ).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'one update refreshes the skill for every agent',
    async () => {
      const { service, repoDir, projectDir } = await setup();
      try {
        await service.install(['alpha'], {
          scope: 'project',
          targets: ['claude', 'codex'],
        });
        await writeFile(
          path.join(repoDir, 'skills', 'alpha', 'SKILL.md'),
          skillMd('alpha', 'v2'),
        );
        git(repoDir, 'commit', '-am', 'second');

        await service.update({ apply: true, yes: true });

        for (const root of ['.claude', '.codex']) {
          const content = await fs.readFile(
            path.join(projectDir, root, 'skills', 'alpha', 'SKILL.md'),
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
    'without a target the skill keeps its own layout',
    async () => {
      const { service } = await setup();
      try {
        const installs = await service.install(['alpha'], { scope: 'project' });
        expect(installs.map((install) => install.adapter)).toEqual(['generic']);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
});
