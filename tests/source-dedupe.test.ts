import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';
import { gitRepoIdentity } from '@agentpm/shared';

import { copyDir, initFixtureGitRepo, makeTempDir } from './helpers';

const CI_TEST_TIMEOUT = 30_000;

// Serves github.com/owner/<repo> from a local folder, so the test stays offline.
async function setupFakeGitHub() {
  const homeDir = await makeTempDir('agentpm-home-');
  const hostDir = await makeTempDir('agentpm-github-');
  const repoDir = path.join(hostDir, 'owner', 'skills.git');
  await copyDir(path.resolve('tests/fixtures/repos/generic'), repoDir);
  initFixtureGitRepo(repoDir);
  const base = `${pathToFileURL(hostDir).href}/`;
  const service = new AgentPmService({
    cwd: await makeTempDir('agentpm-project-'),
    env: {
      AGENTPM_HOME: homeDir,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: `url.${base}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_CONFIG_KEY_1: `url.${base}.insteadOf`,
      GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'protocol.file.allow',
      GIT_CONFIG_VALUE_2: 'always',
    },
  });
  return { service };
}

describe('git repository identity', () => {
  test('treats https, ssh and github: addresses of one repo as equal', () => {
    const expected = 'github.com/travelhawk/skills-vault';
    for (const locator of [
      'github:travelhawk/skills-vault',
      'travelhawk/skills-vault',
      'https://github.com/travelhawk/skills-vault',
      'https://github.com/travelhawk/skills-vault.git',
      'https://github.com/TravelHawk/Skills-Vault/',
      'git@github.com:travelhawk/skills-vault.git',
      'ssh://git@github.com/travelhawk/skills-vault.git',
    ]) {
      expect(gitRepoIdentity(locator), locator).toBe(expected);
    }
  });

  test('keeps other hosts and repos apart and ignores local paths', () => {
    expect(gitRepoIdentity('https://gitlab.com/travelhawk/skills-vault')).toBe(
      'gitlab.com/travelhawk/skills-vault',
    );
    expect(gitRepoIdentity('https://github.com/travelhawk/test-skills-vault')).toBe(
      'github.com/travelhawk/test-skills-vault',
    );
    expect(gitRepoIdentity('C:\\skills')).toBeNull();
    expect(gitRepoIdentity('file:///C:/skills')).toBeNull();
  });
});

describe('duplicate sources', () => {
  test(
    'adding the same repository under another address reuses the source',
    async () => {
      const { service } = await setupFakeGitHub();
      try {
        const first = await service.addSource('https://github.com/owner/skills.git');
        const second = await service.addSource('git@github.com:owner/skills.git');
        const third = await service.addSource('owner/skills');

        expect(second.source.id).toBe(first.source.id);
        expect(third.source.id).toBe(first.source.id);
        expect(service.listSources()).toHaveLength(1);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'doctor --fix merges existing duplicates and keeps their skills installed',
    async () => {
      const { service } = await setupFakeGitHub();
      try {
        const kept = await service.addSource('https://github.com/owner/skills.git');
        // An older AgentPM stored the shorthand as a second source.
        const duplicate = service.db.upsertSource({
          ...kept.source,
          id: 'src_shorthand',
          locator: 'github:owner/skills',
          normalizedLocator: 'github:owner/skills',
        });
        const [installed] = await service.install(['skill-b'], {
          scope: 'project',
          target: 'generic',
        });
        const install = service.db.saveInstall({
          ...installed!,
          sourceId: duplicate.id,
        });

        const issues = await service.doctor();
        expect(
          issues.filter((issue) => issue.code === 'source-duplicate'),
        ).toHaveLength(1);
        const actions = await service.planDoctorFixes(issues);
        expect(actions).toContainEqual(
          expect.objectContaining({
            code: 'merge-duplicate-source',
            sourceId: duplicate.id,
          }),
        );
        await service.applyDoctorFixes(actions);

        expect(service.listSources().map((source) => source.id)).toEqual([
          kept.source.id,
        ]);
        expect(service.db.getInstall(install.id)?.sourceId).toBe(
          kept.source.id,
        );
        expect(
          (await service.doctor()).some(
            (issue) => issue.code === 'source-duplicate',
          ),
        ).toBe(false);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
});
