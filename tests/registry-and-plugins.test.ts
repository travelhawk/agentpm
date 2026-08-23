import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import {
  AgentPmService,
  publishSkillToRegistry,
  registryLogin,
  registryWhoami,
} from '@agentpm/core';
import {
  fetchSkillArchive,
  loadRegistryIndex,
  registryApiRequest,
} from '@agentpm/registry';
import {
  startRegistryServer,
  type RegistryServerHandle,
} from '@agentpm/registry-server';

import { copyDir, initFixtureGitRepo, makeTempDir, writeFile } from './helpers';

const CI_TEST_TIMEOUT = process.env.CI ? 60_000 : 30_000;

const handles: RegistryServerHandle[] = [];

async function startServer(): Promise<RegistryServerHandle> {
  const dataDir = await makeTempDir('agentpm-registry-data-');
  const handle = await startRegistryServer({ dataDir, port: 0 });
  handles.push(handle);
  return handle;
}

afterAll(async () => {
  await Promise.allSettled(handles.map((handle) => handle.close()));
});

async function makeSkillFixture(name: string, body: string): Promise<string> {
  const dir = await makeTempDir('agentpm-skill-src-');
  const skillDir = path.join(dir, name);
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\ndescription: Test skill ${name}\n---\n\n# ${name}\n\n${body}\n`,
  );
  await writeFile(path.join(skillDir, 'notes.txt'), body);
  return skillDir;
}

describe('registry server', () => {
  test(
    'bootstrap, publish, index, archive download, and version bumps',
    async () => {
      const server = await startServer();
      expect(server.bootstrap).not.toBeNull();
      const token = server.bootstrap!.token;
      const homeDir = await makeTempDir('agentpm-home-');
      const env = { AGENTPM_HOME: homeDir, AGENTPM_REGISTRY_TOKEN: token };

      const skillDir = await makeSkillFixture('it-skill', 'version one');
      const published = await publishSkillToRegistry({
        registryUrl: server.url,
        sourcePath: skillDir,
        env,
      });
      expect(published.version).toBe('0.1.0');

      const index = await loadRegistryIndex(`${server.url}/index.json`, env);
      const entry = index.entries.find((item) => item.name === 'it-skill');
      expect(entry).toBeDefined();
      expect(entry!.archive).toContain('v1/skills/it-skill');
      expect(entry!.version).toBe('0.1.0');
      expect(entry!.description).toContain('Test skill');

      const archiveUrl = new URL(entry!.archive!, `${server.url}/index.json`).href;
      const { archive } = await fetchSkillArchive(archiveUrl, env);
      expect(archive.files.some((file) => file.path === 'SKILL.md')).toBe(true);

      // Publishing again without --version bumps the patch level.
      const second = await publishSkillToRegistry({
        registryUrl: server.url,
        sourcePath: skillDir,
        env,
      });
      expect(second.version).toBe('0.1.1');

      // Re-publishing an existing version is rejected.
      await expect(
        publishSkillToRegistry({
          registryUrl: server.url,
          sourcePath: skillDir,
          version: '0.1.1',
          env,
        }),
      ).rejects.toThrow(/already exists/);
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'rejects a path-traversal version on publish',
    async () => {
      const server = await startServer();
      const token = server.bootstrap!.token;
      const skillDir = await makeSkillFixture('trav-skill', 'x');
      await expect(
        publishSkillToRegistry({
          registryUrl: server.url,
          sourcePath: skillDir,
          version: '../../../../etc/pwn',
          env: { AGENTPM_REGISTRY_TOKEN: token },
        }),
      ).rejects.toThrow(/valid "version"/);
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'index archive URLs resolve identically from /index.json and /v1/index.json',
    async () => {
      const server = await startServer();
      const token = server.bootstrap!.token;
      const env = { AGENTPM_REGISTRY_TOKEN: token };
      const skillDir = await makeSkillFixture('alias-skill', 'aliased');
      await publishSkillToRegistry({
        registryUrl: server.url,
        sourcePath: skillDir,
        env,
      });

      for (const indexPath of ['/index.json', '/v1/index.json']) {
        const index = await loadRegistryIndex(`${server.url}${indexPath}`, env);
        const entry = index.entries.find((item) => item.name === 'alias-skill');
        expect(entry).toBeDefined();
        const archiveUrl = new URL(
          entry!.archive!,
          `${server.url}${indexPath}`,
        ).href;
        expect(archiveUrl).not.toContain('/v1/v1/');
        const { archive } = await fetchSkillArchive(archiveUrl, env);
        expect(archive.name).toBe('alias-skill');
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'a private server returns 401 to anonymous index reads',
    async () => {
      const dataDir = await makeTempDir('agentpm-registry-private-');
      const handle = await startRegistryServer({
        dataDir,
        port: 0,
        publicRead: false,
      });
      handles.push(handle);
      const anonHome = await makeTempDir('agentpm-anon-');
      await expect(
        loadRegistryIndex(`${handle.url}/index.json`, {
          AGENTPM_HOME: anonHome,
        }),
      ).rejects.toThrow(/401|authentication/i);
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'visibility, login, and user management',
    async () => {
      const server = await startServer();
      const adminToken = server.bootstrap!.token;
      const homeDir = await makeTempDir('agentpm-home-');
      const adminEnv = {
        AGENTPM_HOME: homeDir,
        AGENTPM_REGISTRY_TOKEN: adminToken,
      };

      const skillDir = await makeSkillFixture('secret-skill', 'private data');
      await publishSkillToRegistry({
        registryUrl: server.url,
        sourcePath: skillDir,
        visibility: 'private',
        env: adminEnv,
      });

      // Anonymous index excludes private skills.
      const anonHome = await makeTempDir('agentpm-anon-home-');
      const anonIndex = await loadRegistryIndex(`${server.url}/index.json`, {
        AGENTPM_HOME: anonHome,
      });
      expect(anonIndex.entries).toHaveLength(0);

      // Authenticated index includes them.
      const authedIndex = await loadRegistryIndex(
        `${server.url}/index.json`,
        adminEnv,
      );
      expect(authedIndex.entries.map((item) => item.name)).toContain(
        'secret-skill',
      );

      // Admin creates a user; login with the generated password works.
      const created = await registryApiRequest({
        method: 'POST',
        url: `${server.url}/v1/users`,
        token: adminToken,
        body: { username: 'teammate', role: 'publisher' },
      });
      expect(typeof created.password).toBe('string');

      const loginHome = await makeTempDir('agentpm-login-home-');
      const login = await registryLogin({
        url: server.url,
        username: 'teammate',
        password: created.password as string,
        env: { AGENTPM_HOME: loginHome },
      });
      expect(login.username).toBe('teammate');
      expect(login.role).toBe('publisher');

      const whoami = await registryWhoami(server.url, {
        AGENTPM_HOME: loginHome,
      });
      expect(whoami.username).toBe('teammate');

      // Readers cannot publish.
      await registryApiRequest({
        method: 'PATCH',
        url: `${server.url}/v1/users/teammate`,
        token: adminToken,
        body: { role: 'reader' },
      });
      const readerSkill = await makeSkillFixture('reader-skill', 'nope');
      await expect(
        publishSkillToRegistry({
          registryUrl: server.url,
          sourcePath: readerSkill,
          env: { AGENTPM_HOME: loginHome },
        }),
      ).rejects.toThrow(/roles/);
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'service roundtrip: add source, install, update, remove',
    async () => {
      const server = await startServer();
      const token = server.bootstrap!.token;
      const publisherHome = await makeTempDir('agentpm-pub-home-');
      const publisherEnv = {
        AGENTPM_HOME: publisherHome,
        AGENTPM_REGISTRY_TOKEN: token,
      };

      const skillDir = await makeSkillFixture('rt-skill', 'roundtrip v1');
      await publishSkillToRegistry({
        registryUrl: server.url,
        sourcePath: skillDir,
        env: publisherEnv,
      });

      const homeDir = await makeTempDir('agentpm-home-');
      const projectDir = await makeTempDir('agentpm-project-');
      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir, AGENTPM_REGISTRY_TOKEN: token },
      });
      try {
        const added = await service.addSource(
          `registry:${server.url}/index.json`,
        );
        expect(added.indexedEntries).toBe(1);

        const installs = await service.install(['rt-skill'], {
          scope: 'project',
          yes: true,
          updateProjectConfig: false,
        });
        expect(installs).toHaveLength(1);
        const install = installs[0]!;
        expect(install.metadata.archive).toBe(true);
        expect(install.metadata.archiveVersion).toBe('0.1.0');

        const installedSkillMd = path.join(install.targetPath, 'SKILL.md');
        await expect(fs.readFile(installedSkillMd, 'utf8')).resolves.toContain(
          'roundtrip v1',
        );

        // No changes yet: update preview reports unchanged.
        const unchanged = await service.previewUpdates({
          names: ['rt-skill'],
        });
        expect(unchanged[0]?.changed).toBe(false);

        // Publish v2, refresh the index, and apply the update.
        await writeFile(path.join(skillDir, 'SKILL.md'), '# rt-skill\n\nroundtrip v2\n');
        await publishSkillToRegistry({
          registryUrl: server.url,
          sourcePath: skillDir,
          env: publisherEnv,
        });
        await service.refreshSources();

        const previews = await service.update({ apply: true, yes: true });
        const preview = previews.find(
          (item) => item.install.name === 'rt-skill',
        );
        expect(preview?.changed).toBe(true);
        await expect(fs.readFile(installedSkillMd, 'utf8')).resolves.toContain(
          'roundtrip v2',
        );

        // doctor must not flag a healthy archive install as missing content.
        const issues = await service.doctor();
        expect(
          issues.some((issue) => issue.code === 'source-content-missing'),
        ).toBe(false);

        const removed = await service.removeInstall('rt-skill');
        expect(removed.name).toBe('rt-skill');
        await expect(fs.access(install.targetPath)).rejects.toThrow();
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
});

describe('claude code plugins', () => {
  test(
    'installs a Claude plugin and maintains the Claude marketplace manifest',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const projectDir = await makeTempDir('agentpm-plugin-project-');
      const repoDir = await makeTempDir('agentpm-plugin-repo-');
      await copyDir(path.resolve('tests/fixtures/repos/plugin'), repoDir);
      initFixtureGitRepo(repoDir);

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        const added = await service.addSource(repoDir);
        expect(added.indexedEntries).toBeGreaterThanOrEqual(2);

        const installs = await service.install(['demo-plugin'], {
          scope: 'project',
          target: 'claude',
          yes: true,
          updateProjectConfig: false,
        });
        expect(installs).toHaveLength(1);
        const install = installs[0]!;
        expect(install.adapter).toBe('claude');
        expect(install.targetPath).toBe(
          path.join(
            projectDir,
            '.agentpm',
            'plugins',
            'claude',
            'plugins',
            'demo-plugin',
          ),
        );

        const manifestRaw = await fs.readFile(
          path.join(install.targetPath, '.claude-plugin', 'plugin.json'),
          'utf8',
        );
        expect(JSON.parse(manifestRaw)).toMatchObject({ name: 'demo-plugin' });

        const marketplacePath = path.join(
          projectDir,
          '.agentpm',
          'plugins',
          'claude',
          '.claude-plugin',
          'marketplace.json',
        );
        const marketplace = JSON.parse(
          await fs.readFile(marketplacePath, 'utf8'),
        ) as {
          name: string;
          plugins: Array<{ name: string; source: string }>;
        };
        expect(marketplace.plugins).toEqual([
          expect.objectContaining({
            name: 'demo-plugin',
            source: './plugins/demo-plugin',
          }),
        ]);

        await service.removeInstall('demo-plugin');
        await expect(fs.access(marketplacePath)).rejects.toThrow();
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'an unsafe plugin manifest name cannot escape the plugins directory',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const projectDir = await makeTempDir('agentpm-plugin-project-');
      const repoDir = await makeTempDir('agentpm-evil-plugin-');
      await writeFile(
        path.join(repoDir, 'evil', '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: '../../pwned', version: '1.0.0' }),
      );
      await writeFile(path.join(repoDir, 'evil', 'commands', 'x.md'), '# x\n');

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);
        // The detected/installed name falls back to the safe directory basename.
        const installs = await service.install(['evil'], {
          scope: 'project',
          yes: true,
          updateProjectConfig: false,
        });
        expect(installs).toHaveLength(1);
        const resolved = path.resolve(installs[0]!.targetPath);
        const pluginsRoot = path.resolve(
          projectDir,
          '.agentpm',
          'plugins',
        );
        expect(resolved.startsWith(pluginsRoot + path.sep)).toBe(true);
        expect(installs[0]!.name).not.toContain('..');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'installs a Codex plugin into the codex marketplace with the native manifest',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const projectDir = await makeTempDir('agentpm-codex-plugin-project-');
      const repoDir = await makeTempDir('agentpm-codex-plugin-repo-');
      await copyDir(path.resolve('tests/fixtures/repos/codex-plugin'), repoDir);
      initFixtureGitRepo(repoDir);

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);
        const installs = await service.install(['demo-codex'], {
          scope: 'project',
          target: 'codex',
          yes: true,
          updateProjectConfig: false,
        });
        expect(installs).toHaveLength(1);
        const install = installs[0]!;
        expect(install.adapter).toBe('codex');
        expect(install.targetPath).toBe(
          path.join(
            projectDir,
            '.agentpm',
            'plugins',
            'codex',
            'plugins',
            'demo-codex',
          ),
        );
        await expect(
          fs.readFile(
            path.join(install.targetPath, '.codex-plugin', 'plugin.json'),
            'utf8',
          ),
        ).resolves.toContain('demo-codex');

        // Codex reads .agents/plugins/marketplace.json with an object source.
        const marketplacePath = path.join(
          projectDir,
          '.agentpm',
          'plugins',
          'codex',
          '.agents',
          'plugins',
          'marketplace.json',
        );
        const marketplace = JSON.parse(
          await fs.readFile(marketplacePath, 'utf8'),
        ) as {
          name: string;
          plugins: Array<{ name: string; source: { source: string; path: string } }>;
        };
        expect(marketplace.plugins).toEqual([
          expect.objectContaining({
            name: 'demo-codex',
            source: { source: 'local', path: './plugins/demo-codex' },
          }),
        ]);

        await service.removeInstall('demo-codex');
        await expect(fs.access(marketplacePath)).rejects.toThrow();
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'publish and reinstall a plugin through the registry keeps plugin detection',
    async () => {
      const server = await startServer();
      const token = server.bootstrap!.token;
      const publisherHome = await makeTempDir('agentpm-pub-home-');

      const pluginSource = await makeTempDir('agentpm-plugin-src-');
      await copyDir(
        path.resolve('tests/fixtures/repos/plugin'),
        pluginSource,
      );

      const published = await publishSkillToRegistry({
        registryUrl: server.url,
        sourcePath: pluginSource,
        name: 'demo-plugin',
        env: { AGENTPM_HOME: publisherHome, AGENTPM_REGISTRY_TOKEN: token },
      });
      expect(published.name).toBe('demo-plugin');

      const homeDir = await makeTempDir('agentpm-home-');
      const projectDir = await makeTempDir('agentpm-plugin-project-');
      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir, AGENTPM_REGISTRY_TOKEN: token },
      });
      try {
        await service.addSource(`registry:${server.url}/index.json`);
        const installs = await service.install(['demo-plugin'], {
          scope: 'project',
          yes: true,
          updateProjectConfig: false,
        });
        expect(installs).toHaveLength(1);
        expect(installs[0]!.targetPath).toBe(
          path.join(
            projectDir,
            '.agentpm',
            'plugins',
            'claude',
            'plugins',
            'demo-plugin',
          ),
        );
        await expect(
          fs.readFile(
            path.join(
              installs[0]!.targetPath,
              '.claude-plugin',
              'plugin.json',
            ),
            'utf8',
          ),
        ).resolves.toContain('demo-plugin');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
});

describe('install disambiguation on identical names', () => {
  async function nameClashRepo(): Promise<string> {
    const repoDir = await makeTempDir('agentpm-nameclash-repo-');
    await copyDir(path.resolve('tests/fixtures/repos/name-clash'), repoDir);
    initFixtureGitRepo(repoDir);
    return repoDir;
  }

  test(
    'a skill and a plugin with the same name error without a picker',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const projectDir = await makeTempDir('agentpm-nameclash-project-');
      const repoDir = await nameClashRepo();
      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);
        await expect(
          service.install(['widget'], {
            scope: 'project',
            target: 'claude',
            yes: true,
            updateProjectConfig: false,
          }),
        ).rejects.toThrow(/matches more than one/i);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    '--kind selects the plugin, and --kind selects the skill',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const projectDir = await makeTempDir('agentpm-nameclash-project-');
      const repoDir = await nameClashRepo();
      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);

        const asPlugin = await service.install(['widget'], {
          scope: 'project',
          target: 'claude',
          kind: 'plugin',
          yes: true,
          updateProjectConfig: false,
        });
        expect(asPlugin).toHaveLength(1);
        expect(asPlugin[0]!.targetPath).toBe(
          path.join(
            projectDir,
            '.agentpm',
            'plugins',
            'claude',
            'plugins',
            'widget',
          ),
        );

        const asSkill = await service.install(['widget'], {
          scope: 'project',
          target: 'claude',
          kind: 'skill',
          yes: true,
          updateProjectConfig: false,
        });
        expect(asSkill).toHaveLength(1);
        expect(asSkill[0]!.targetPath).toBe(
          path.join(projectDir, '.claude', 'skills', 'widget'),
        );
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'an interactive picker resolves the ambiguity',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const projectDir = await makeTempDir('agentpm-nameclash-project-');
      const repoDir = await nameClashRepo();
      const picked: string[] = [];
      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
        prompts: {
          selectOne<T>(
            _message: string,
            options: Array<{ label: string; value: T }>,
          ): Promise<T> {
            // Choose the plugin entry.
            const plugin =
              options.find((option) => /plugin/i.test(option.label)) ??
              options[0]!;
            picked.push(plugin.label);
            return Promise.resolve(plugin.value);
          },
        },
      });
      try {
        await service.addSource(repoDir);
        const installs = await service.install(['widget'], {
          scope: 'project',
          target: 'claude',
          updateProjectConfig: false,
        });
        expect(installs).toHaveLength(1);
        expect(installs[0]!.targetPath).toContain(
          path.join('.agentpm', 'plugins', 'claude', 'plugins', 'widget'),
        );
        expect(picked.some((label) => /plugin/i.test(label))).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
});
