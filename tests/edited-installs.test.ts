import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';

import { findCacheInstallFor } from '../packages/core/src/install-edits';

import {
  copyDir,
  git,
  initFixtureGitRepo,
  makeTempDir,
  writeFile,
} from './helpers';

const CI_TEST_TIMEOUT = 30_000;

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'AgentPM Tests',
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'AgentPM Tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
};

// A skill installed from a git source: its files live in AgentPM's cache.
async function setup(base?: string) {
  const homeDir = base
    ? path.join(base, 'home')
    : await makeTempDir('agentpm-edit-home-');
  const repoDir = await makeTempDir('agentpm-edit-repo-');
  const projectDir = base
    ? path.join(base, 'project')
    : await makeTempDir('agentpm-edit-project-');
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await copyDir(path.resolve('tests/fixtures/repos/generic'), repoDir);
  initFixtureGitRepo(repoDir);

  const service = new AgentPmService({
    cwd: projectDir,
    env: { ...GIT_ENV, AGENTPM_HOME: homeDir },
  });
  await service.addSource(pathToFileURL(repoDir).href);
  const [install] = await service.install(['skill-b'], {
    scope: 'project',
    target: 'generic',
  });
  const skillFile = path.join(install!.targetPath, 'SKILL.md');
  return {
    service,
    homeDir,
    repoDir,
    projectDir,
    install: install!,
    skillFile,
  };
}

// A new upstream commit, so `update` has something to apply.
async function publishUpstreamChange(repoDir: string) {
  await writeFile(
    path.join(repoDir, '.agents', 'skills', 'skill-b', 'SKILL.md'),
    '# upstream change\n',
  );
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-m', 'upstream');
}

describe('edited installs from a source', () => {
  test(
    'update leaves an edited install alone instead of dropping the edits',
    async () => {
      const { service, repoDir, install, skillFile } = await setup();
      try {
        await fs.appendFile(skillFile, '\nmy local edit\n');
        await publishUpstreamChange(repoDir);

        const [preview] = await service.update({ names: ['skill-b'] });
        expect(preview!.changed).toBe(true);
        expect(preview!.localEdits).toBe(true);
        expect(preview!.warnings.join('\n')).toMatch(/agentpm adopt ".*skill-b"/);

        // --yes does not answer this one, and the test has no terminal.
        await service.update({ names: ['skill-b'], apply: true, yes: true });
        expect(service.listInstalls()[0]!.linkTarget).toBe(install.linkTarget);
        expect(await fs.readFile(skillFile, 'utf8')).toContain('my local edit');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'update still applies when the files were not edited',
    async () => {
      const { service, repoDir, install, skillFile } = await setup();
      try {
        await publishUpstreamChange(repoDir);

        const [preview] = await service.update({ names: ['skill-b'] });
        expect(preview!.localEdits).toBeFalsy();

        await service.update({ names: ['skill-b'], apply: true, yes: true });
        expect(service.listInstalls()[0]!.linkTarget).not.toBe(
          install.linkTarget,
        );
        expect(await fs.readFile(skillFile, 'utf8')).toContain(
          'upstream change',
        );

        // The new files are the baseline now: no edits are reported.
        const [again] = await service.update({ names: ['skill-b'] });
        expect(again!.localEdits).toBeFalsy();
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'push moves an edited install to the library and publishes the edits',
    async () => {
      const { service, homeDir, install, skillFile } = await setup();
      const remoteDir = await makeTempDir('agentpm-edit-remote-');
      const remoteRepo = path.join(remoteDir, 'skills.git');
      const verifyDir = path.join(remoteDir, 'verify');
      git(remoteDir, 'init', '--bare', remoteRepo);
      try {
        await fs.appendFile(skillFile, '\nmy local edit\n');

        const result = await service.push({
          target: remoteRepo,
          path: 'skill-b',
        });
        expect(result.warnings.join('\n')).toMatch(/local edits are kept/);

        git(remoteDir, 'clone', remoteRepo, verifyDir);
        expect(
          await fs.readFile(
            path.join(verifyDir, 'skills', 'skill-b', 'SKILL.md'),
            'utf8',
          ),
        ).toContain('my local edit');

        // The edits now live in the library, which updates never replace.
        const libraryFile = path.join(homeDir, 'skills', 'skill-b', 'SKILL.md');
        expect(await fs.readFile(libraryFile, 'utf8')).toContain(
          'my local edit',
        );
        expect(await fs.realpath(install.targetPath)).toBe(
          await fs.realpath(path.dirname(libraryFile)),
        );
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'push of an unedited install does not move it',
    async () => {
      const { service, homeDir, install } = await setup();
      const remoteDir = await makeTempDir('agentpm-edit-remote-');
      const remoteRepo = path.join(remoteDir, 'skills.git');
      git(remoteDir, 'init', '--bare', remoteRepo);
      try {
        const result = await service.push({
          target: remoteRepo,
          path: 'skill-b',
        });
        expect(result.warnings.join('\n')).not.toMatch(/skill library/);
        await expect(
          fs.stat(path.join(homeDir, 'skills', 'skill-b')),
        ).rejects.toThrow();
        expect(service.listInstalls()[0]!.linkTarget).toBe(install.linkTarget);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
  test(
    'installing again keeps the baseline, so earlier edits are still found',
    async () => {
      const { service, repoDir, skillFile } = await setup();
      try {
        await fs.appendFile(skillFile, '\nmy local edit\n');
        // `sync` runs install for every entry again, over the edited files.
        await service.install(['skill-b'], {
          scope: 'project',
          target: 'generic',
        });
        await publishUpstreamChange(repoDir);

        const [preview] = await service.update({ names: ['skill-b'] });
        expect(preview!.localEdits).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'an install for another agent reuses the baseline of the shared cache copy',
    async () => {
      const { service, repoDir, skillFile } = await setup();
      try {
        await fs.appendFile(skillFile, '\nmy local edit\n');
        // Same files, other agent: its baseline must be the original files.
        await service.install(['skill-b'], {
          scope: 'project',
          target: 'claude',
        });
        await publishUpstreamChange(repoDir);

        const previews = await service.update({ names: ['skill-b'] });
        expect(previews.length).toBeGreaterThan(1);
        expect(previews.every((preview) => preview.localEdits)).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'push stops when the library has a different skill of that name, and keeps the edits',
    async () => {
      const { service, homeDir, install, skillFile } = await setup();
      const remoteDir = await makeTempDir('agentpm-edit-remote-');
      const remoteRepo = path.join(remoteDir, 'skills.git');
      git(remoteDir, 'init', '--bare', remoteRepo);
      try {
        await writeFile(
          path.join(homeDir, 'skills', 'skill-b', 'SKILL.md'),
          '# OLD LIBRARY COPY\n',
        );
        await fs.appendFile(skillFile, '\nmy local edit\n');

        await expect(
          service.push({ target: remoteRepo, path: 'skill-b' }),
        ).rejects.toThrow(/already exists in the AgentPM library/);

        // Nothing moved: the edits are still in the install.
        expect(await fs.readFile(skillFile, 'utf8')).toContain('my local edit');
        expect(service.listInstalls()[0]!.linkTarget).toBe(install.linkTarget);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'adopt works when the home and project folders sit behind a link',
    async () => {
      // Like macOS /var -> /private/var or a Windows short name: the real path
      // of every folder differs from the one AgentPM was given.
      const realBase = await makeTempDir('agentpm-edit-real-');
      const aliasParent = await makeTempDir('agentpm-edit-alias-');
      const alias = path.join(aliasParent, 'alias');
      await fs.symlink(realBase, alias, 'junction');
      const { service, install } = await setup(alias);
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
    'update repairs an install whose cache was deleted, even after upstream moved',
    async () => {
      const { service, homeDir, repoDir, skillFile } = await setup();
      try {
        await fs.rm(path.join(homeDir, 'cache'), {
          recursive: true,
          force: true,
        });
        await publishUpstreamChange(repoDir);

        const [preview] = await service.update({ names: ['skill-b'] });
        expect(preview!.changed).toBe(true);
        // Missing files cannot hold edits.
        expect(preview!.localEdits).toBeFalsy();

        await service.update({ names: ['skill-b'], apply: true, yes: true });
        expect(await fs.readFile(skillFile, 'utf8')).toContain(
          'upstream change',
        );
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'files an interpreter or the OS writes into the skill do not count as edits',
    async () => {
      const { service, repoDir, install } = await setup();
      try {
        await writeFile(
          path.join(install.targetPath, '__pycache__', 'helper.pyc'),
          'bytecode',
        );
        await writeFile(path.join(install.targetPath, '.DS_Store'), 'junk');
        await publishUpstreamChange(repoDir);

        const [preview] = await service.update({ names: ['skill-b'] });
        expect(preview!.changed).toBe(true);
        expect(preview!.localEdits).toBeFalsy();
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test('the install in the current scope wins when installs share a cache folder', async () => {
    const root = await makeTempDir('agentpm-edit-shared-');
    const cacheDir = path.join(root, 'cache');
    const release = path.join(cacheDir, 'repos', 'k', 'r', 'skill-b');
    await fs.mkdir(release, { recursive: true });
    const fake = (scopeRoot: string) =>
      ({ linkTarget: release, scopeRoot }) as never;
    const globalInstall = fake(path.join(root, 'home'));
    const projectInstall = fake(path.join(root, 'project'));

    const found = await findCacheInstallFor(
      release,
      cacheDir,
      [globalInstall, projectInstall],
      path.join(root, 'project', 'sub'),
    );
    expect(found).toBe(projectInstall);
  });
});
