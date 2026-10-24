import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import {
  AgentPmService,
  parseSkillsProviderSearchResponse,
  resolveProviderInstallInput,
  resolveProviderInstallRequest,
} from '@agentpm/core';

import {
  copyDir,
  git,
  initFixtureGitRepo,
  makeTempDir,
  writeFile,
} from './helpers';

async function writeGitGlobalIgnoreConfig(
  rootDir: string,
  patterns: string[],
): Promise<string> {
  const ignorePath = path.join(rootDir, 'global-ignore');
  const configPath = path.join(rootDir, 'gitconfig');
  await fs.writeFile(ignorePath, `${patterns.join('\n')}\n`, 'utf8');
  await fs.writeFile(
    configPath,
    `[core]\n    excludesfile = ${ignorePath.replace(/\\/g, '/')}\n`,
    'utf8',
  );
  return configPath;
}

const execFileAsync = promisify(execFile);
const cliEntry = path.resolve('apps/cli/src/index.ts');
// Tests here shell out to the CLI (often twice, through tsx with its cache
// disabled), so a single case can legitimately take well over ten seconds on a
// busy machine. Use the same budget locally as on CI: the tighter local limit
// only produced timeout flakes, never a faster signal.
const CI_TEST_TIMEOUT = 30_000;
const tsxLoader = pathToFileURL(
  path.resolve('node_modules/tsx/dist/loader.mjs'),
).href;
const rootTsconfig = path.resolve('tsconfig.json');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'AgentPM Tests',
  GIT_AUTHOR_EMAIL: 'tests@example.com',
  GIT_COMMITTER_NAME: 'AgentPM Tests',
  GIT_COMMITTER_EMAIL: 'tests@example.com',
};

const FAKE_SKILLS_SH_RESULTS = {
  typescript: [
    {
      id: 'wshobson/agents/typescript-advanced-types',
      skillId: 'typescript-advanced-types',
      name: 'typescript-advanced-types',
      installs: 42_700,
      source: 'wshobson/agents',
    },
    {
      id: 'github/awesome-copilot/javascript-typescript-jest',
      skillId: 'javascript-typescript-jest',
      name: 'javascript-typescript-jest',
      installs: 10_600,
      source: 'github/awesome-copilot',
    },
  ],
  empty: [],
} as const;

async function startFakeSkillsSh(): Promise<{
  url: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const query = url.searchParams.get('q') ?? '';
    if (url.pathname !== '/api/search' || !(query in FAKE_SKILLS_SH_RESULTS)) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('unexpected request');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        query,
        skills:
          FAKE_SKILLS_SH_RESULTS[query as keyof typeof FAKE_SKILLS_SH_RESULTS],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function runCli(
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
) {
  return execFileAsync(
    process.execPath,
    ['--import', tsxLoader, cliEntry, ...args],
    {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        TSX_DISABLE_CACHE: '1',
        TSX_TSCONFIG_PATH: rootTsconfig,
      },
    },
  );
}

describe('update and cli flows', () => {
  test('parses skills.sh search responses and rejects malformed results', () => {
    const parsed = parseSkillsProviderSearchResponse({
      skills: [
        ...FAKE_SKILLS_SH_RESULTS.typescript.slice(0, 1),
        // Not an "owner/repo" source, so it cannot use the Git install path.
        { id: 'x', name: 'no-repo', source: 'example.com', installs: 3 },
        // Control characters must never reach the terminal or a selector.
        { id: 'y', name: 'evil\x1b[2Jname', source: 'owner/repo' },
        { id: '../z', name: 'odd-id', source: 'owner/repo', installs: 999 },
      ],
    });
    expect(parsed).toEqual([
      expect.objectContaining({
        skillSelector: 'wshobson/agents@typescript-advanced-types',
        source: 'wshobson/agents',
        installLocator: 'github:wshobson/agents',
        installs: '42.7K',
        url: 'https://skills.sh/wshobson/agents/typescript-advanced-types',
      }),
      expect.objectContaining({
        skillSelector: 'owner/repo@odd-id',
        installs: '999',
        url: null,
      }),
    ]);
    expect(parseSkillsProviderSearchResponse({ skills: [] })).toEqual([]);
    expect(() => parseSkillsProviderSearchResponse({ nope: true })).toThrow(
      'skills.sh returned an unexpected search response',
    );
  });

  test('resolves provider install requests from selectors and explicit skills', () => {
    expect(
      resolveProviderInstallRequest(
        'wshobson/agents@typescript-advanced-types',
      ),
    ).toEqual(
      expect.objectContaining({
        installLocator: 'github:wshobson/agents',
        skills: ['typescript-advanced-types'],
        selector: 'wshobson/agents@typescript-advanced-types',
      }),
    );
    expect(
      resolveProviderInstallRequest('github:vercel-labs/agent-skills', [
        'web-design-guidelines',
      ]),
    ).toEqual(
      expect.objectContaining({
        installLocator: 'github:vercel-labs/agent-skills',
        skills: ['web-design-guidelines'],
        selector: null,
      }),
    );
  });

  test('treats plain skills install text as either a repo/source request or a search query', () => {
    const selectorInput = resolveProviderInstallInput(
      'wshobson/agents@typescript-advanced-types',
    );
    if (selectorInput.kind !== 'request') {
      throw new Error('Expected a provider install request.');
    }
    expect(selectorInput.request.installLocator).toBe('github:wshobson/agents');
    expect(selectorInput.request.skills).toEqual(['typescript-advanced-types']);

    const repoInput = resolveProviderInstallInput(
      'github:vercel-labs/agent-skills',
    );
    if (repoInput.kind !== 'request') {
      throw new Error('Expected a provider install request.');
    }
    expect(repoInput.request.installLocator).toBe(
      'github:vercel-labs/agent-skills',
    );
    expect(repoInput.request.skills).toEqual([]);

    const queryInput = resolveProviderInstallInput('typescript');
    expect(queryInput).toEqual({
      kind: 'query',
      provider: 'skills.sh',
      query: 'typescript',
    });
  });

  test(
    'detects and applies updates from a local git source',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      const projectDir = await makeTempDir('agentpm-project-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);
        await service.install(['skill-a'], { scope: 'project' });

        await writeFile(
          path.join(repoDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
          '# Skill A\n\nUpdated.\n',
        );
        git(repoDir, 'add', '.');
        git(repoDir, 'commit', '-m', 'update skill');

        const previews = await service.previewUpdates({ names: ['skill-a'] });
        expect(previews[0]?.changed).toBe(true);

        await service.update({ names: ['skill-a'], apply: true, yes: true });
        const content = await fs.readFile(
          path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
          'utf8',
        );
        expect(content).toContain('Updated.');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'CLI update prints a success message after applying changes',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      const projectDir = await makeTempDir('agentpm-project-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);
        await service.install(['skill-a'], { scope: 'project' });
      } finally {
        service.close();
      }

      await writeFile(
        path.join(repoDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
        '# Skill A\n\nUpdated by CLI.\n',
      );
      git(repoDir, 'add', '.');
      git(repoDir, 'commit', '-m', 'update skill for cli');

      const { stdout } = await runCli(['update', 'skill-a', '--yes'], {
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      expect(stdout).toContain('Update complete');
      expect(stdout).toContain('1 item(s) updated');
      expect(
        await fs.readFile(
          path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('Updated by CLI.');
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'installs a specific git commit when a ref is pinned',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      const projectDir = await makeTempDir('agentpm-project-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);
      const firstRevision = git(repoDir, 'rev-parse', 'HEAD');

      await writeFile(
        path.join(repoDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
        '# Skill A\n\nUpdated after pin.\n',
      );
      git(repoDir, 'add', '.');
      git(repoDir, 'commit', '-m', 'update after pin');

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);
        const installs = await service.install(['skill-a'], {
          scope: 'project',
          ref: firstRevision,
        });

        expect(installs[0]?.installedRevision).toBe(firstRevision);
        const content = await fs.readFile(
          path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
          'utf8',
        );
        expect(content).not.toContain('Updated after pin.');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'cache clean removes unused repository caches without clearing the index',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      const projectDir = await makeTempDir('agentpm-project-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);
        await service.install(['skill-a'], { scope: 'project' });
        expect(service.db.listCacheRepos()).toHaveLength(1);

        await service.removeInstall('skill-a');
        const result = await service.cleanCache();

        expect(result.removedEntries).toBeGreaterThan(0);
        expect(service.db.listCacheRepos()).toHaveLength(0);
        expect(
          service.search('skill-a').some((entry) => entry.name === 'skill-a'),
        ).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'cache clean dry run reports unused caches without deleting them',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      const projectDir = await makeTempDir('agentpm-project-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);
        await service.install(['skill-a'], { scope: 'project' });
        await service.removeInstall('skill-a');

        const result = await service.cleanCache({ dryRun: true });
        expect(result.dryRun).toBe(true);
        expect(result.removedEntries).toBeGreaterThan(0);
        expect(service.db.listCacheRepos()).toHaveLength(1);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'cache clean preserves reusable push target repositories',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const projectDir = await makeTempDir('agentpm-push-project-');
      const remoteDir = await makeTempDir('agentpm-push-remote-');
      const remoteRepo = path.join(remoteDir, 'skills.git');
      const gitGlobalConfig = await writeGitGlobalIgnoreConfig(remoteDir, [
        '.agents/',
      ]);

      git(remoteDir, 'init', '--bare', remoteRepo);
      await writeFile(
        path.join(projectDir, '.agents', 'skills', 'skill-a', 'SKILL.md'),
        '# pushed skill\n',
      );

      const service = new AgentPmService({
        cwd: projectDir,
        env: {
          AGENTPM_HOME: homeDir,
          GIT_AUTHOR_NAME: 'AgentPM Tests',
          GIT_AUTHOR_EMAIL: 'tests@example.com',
          GIT_COMMITTER_NAME: 'AgentPM Tests',
          GIT_COMMITTER_EMAIL: 'tests@example.com',
          GIT_CONFIG_GLOBAL: gitGlobalConfig,
        },
      });
      try {
        await service.push({
          target: remoteRepo,
          path: 'skill-a',
          message: 'Initial push',
        });

        const pushTargetCache = service.db
          .listCacheRepos()
          .find((repo) => repo.metadata.role === 'push-target');
        expect(pushTargetCache).toBeTruthy();

        const result = await service.cleanCache();
        expect(result.removedPaths).not.toContain(pushTargetCache!.basePath);
        expect(await fs.stat(pushTargetCache!.basePath)).toBeTruthy();
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'source add and install reuse a single cached checkout for the same git repo',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      const projectDir = await makeTempDir('agentpm-project-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        const repoLocator = pathToFileURL(repoDir).href;
        await service.addSource(repoLocator);
        expect(service.db.listCacheRepos()).toHaveLength(1);

        const installs = await service.install(['skill-a'], {
          scope: 'project',
        });
        expect(installs).toHaveLength(1);
        expect(service.db.listCacheRepos()).toHaveLength(1);
        expect(service.db.listCacheRepos()[0]?.cacheKey).toBe(
          installs[0]?.cacheKey,
        );
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test('doctor plans and applies a transparent fix for an unused missing source', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const added = await service.addSource(sourceDir);
      await fs.rm(sourceDir, { recursive: true, force: true });

      const issues = await service.doctor();
      expect(issues.some((issue) => issue.code === 'source-missing')).toBe(
        true,
      );

      const actions = await service.planDoctorFixes(issues);
      expect(actions).toEqual([
        expect.objectContaining({
          code: 'remove-source',
          sourceId: added.source.id,
        }),
      ]);
      expect(actions[0]?.description).toContain('Removing unreachable source');

      const results = await service.applyDoctorFixes(actions);
      expect(results[0]?.applied).toBe(true);
      expect(service.listSources()).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  test(
    'doctor can remove stale install records and deduplicates missing cache',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      const projectDir = await makeTempDir('agentpm-project-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);
        const installs = await service.install(['skill-a'], {
          scope: 'project',
        });
        const cachePath = service.db.listCacheRepos()[0]!.basePath;
        await fs.rm(installs[0]!.targetPath, { recursive: true, force: true });
        await fs.rm(cachePath, { recursive: true, force: true });

        const issues = await service.doctor();
        expect(issues.some((issue) => issue.code === 'install-missing')).toBe(
          true,
        );
        expect(issues.some((issue) => issue.code === 'missing-cache')).toBe(
          false,
        );

        const actions = await service.planDoctorFixes(issues);
        expect(actions).toEqual([
          expect.objectContaining({
            code: 'remove-install-record',
            installId: installs[0]!.id,
          }),
        ]);

        const results = await service.applyDoctorFixes(actions);
        expect(results[0]?.applied).toBe(true);
        expect(service.listInstalls()).toHaveLength(0);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'CLI search hints stale indexes and --refresh rebuilds them',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);

      const service = new AgentPmService({
        cwd: repoDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);
      } finally {
        service.close();
      }

      await writeFile(
        path.join(repoDir, '.codex', 'skills', 'new-skill', 'SKILL.md'),
        '# New Skill\n',
      );
      git(repoDir, 'add', '.');
      git(repoDir, 'commit', '-m', 'add new skill');

      const stale = await runCli(['search', 'new-skill'], {
        cwd: repoDir,
        env: { AGENTPM_HOME: homeDir },
      });
      expect(stale.stdout).toContain('No matches found.');
      expect(stale.stdout).toContain('Indexes may be stale');

      const refreshed = await runCli(['search', 'new-skill', '--refresh'], {
        cwd: repoDir,
        env: { AGENTPM_HOME: homeDir },
      });
      expect(refreshed.stdout).toContain('Source Refresh');
      expect(refreshed.stdout).toContain('catalog  new-skill');
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'skills search uses the provider bridge and supports json output',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const projectDir = await makeTempDir('agentpm-project-');
      const skillsSh = await startFakeSkillsSh();

      try {
        const { stdout } = await runCli(
          ['skills', 'search', 'typescript', '--json'],
          {
            cwd: projectDir,
            env: { AGENTPM_HOME: homeDir, AGENTPM_SKILLS_SH_URL: skillsSh.url },
          },
        );

        const results = JSON.parse(stdout) as Array<Record<string, unknown>>;
        expect(results[0]?.skillSelector).toBe(
          'wshobson/agents@typescript-advanced-types',
        );
        expect(results[0]?.installs).toBe('42.7K');
        expect(results[1]?.installLocator).toBe(
          'github:github/awesome-copilot',
        );
        expect(skillsSh.requests).toEqual([
          '/api/search?q=typescript&limit=10',
        ]);
      } finally {
        await skillsSh.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test('skills search fails clearly when skills.sh is unreachable or broken', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const projectDir = await makeTempDir('agentpm-project-');
    const skillsSh = await startFakeSkillsSh();

    const broken = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir, AGENTPM_SKILLS_SH_URL: skillsSh.url },
    });
    try {
      await expect(broken.searchProviderSkills('empty')).resolves.toEqual([]);
      await expect(broken.searchProviderSkills('broken')).rejects.toThrow(
        'skills.sh search failed with HTTP 500',
      );
    } finally {
      broken.close();
      await skillsSh.close();
    }

    // The port is closed now, so the same URL is unreachable.
    const unreachable = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir, AGENTPM_SKILLS_SH_URL: skillsSh.url },
    });
    try {
      await expect(
        unreachable.searchProviderSkills('typescript'),
      ).rejects.toThrow('Could not reach skills.sh');
    } finally {
      unreachable.close();
    }
  });

  test(
    'skills install reuses the normal install flow for repo-and-skill input without persisting a source',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      const projectDir = await makeTempDir('agentpm-project-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);

      const { stdout } = await runCli(
        [
          'skills',
          'install',
          repoDir,
          '--skill',
          'skill-a',
          '--project',
          '--yes',
        ],
        {
          cwd: projectDir,
          env: { AGENTPM_HOME: homeDir },
        },
      );

      expect(stdout).toContain('Installed');
      expect(
        await fs.readFile(
          path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('# Skill A');

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        expect(service.listSources()).toHaveLength(0);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'skills list shows provider-tagged installs',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      const projectDir = await makeTempDir('agentpm-project-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);

      await runCli(
        [
          'skills',
          'install',
          repoDir,
          '--skill',
          'skill-a',
          '--project',
          '--yes',
        ],
        {
          cwd: projectDir,
          env: { AGENTPM_HOME: homeDir },
        },
      );

      const { stdout } = await runCli(['skills', 'list', '--json'], {
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });

      const installs = JSON.parse(stdout) as Array<Record<string, unknown>>;
      expect(installs).toHaveLength(1);
      expect(installs[0]?.name).toBe('skill-a');
      expect(installs[0]?.source).toBe(path.resolve(repoDir));
      expect(installs[0]?.skillSelector).toBeNull();
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'list collapses one logical skill installed into multiple agents',
    async () => {
      const homeDir = await makeTempDir('agentpm-list-home-');
      const projectDir = await makeTempDir('agentpm-list-project-');
      const remoteDir = await makeTempDir('agentpm-list-remote-');
      const remoteRepo = path.join(remoteDir, 'skills.git');
      const seedDir = path.join(remoteDir, 'seed');

      git(remoteDir, 'init', '--bare', '-b', 'main', remoteRepo);
      await writeFile(
        path.join(seedDir, 'skills', 'implementation-workflow', 'SKILL.md'),
        '# implementation workflow\n',
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
        await service.pull({
          target: remoteRepo,
          agents: ['codex', 'claude', 'generic'],
          scope: 'project',
          yes: true,
        });
      } finally {
        service.close();
      }

      const { stdout } = await runCli(['list'], {
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir, ...GIT_ENV },
      });
      const lines = stdout
        .split(/\r?\n/)
        .filter((line) => line.includes('implementation-workflow'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(path.join(homeDir, 'skills', 'implementation-workflow'));
      expect(lines[0]).toContain('(3 targets)');
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'skills remove removes a provider-tagged install',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      const projectDir = await makeTempDir('agentpm-project-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);

      await runCli(
        [
          'skills',
          'install',
          repoDir,
          '--skill',
          'skill-a',
          '--project',
          '--yes',
        ],
        {
          cwd: projectDir,
          env: { AGENTPM_HOME: homeDir },
        },
      );

      const { stdout } = await runCli(['skills', 'remove', 'skill-a'], {
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });

      expect(stdout).toContain('Removed');
      expect(
        await fs
          .stat(path.join(projectDir, '.codex', 'skills', 'skill-a'))
          .catch(() => null),
      ).toBeNull();
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'skills update updates only provider-tagged installs',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      const projectDir = await makeTempDir('agentpm-project-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), repoDir);
      initFixtureGitRepo(repoDir);

      await runCli(
        [
          'skills',
          'install',
          repoDir,
          '--skill',
          'skill-a',
          '--project',
          '--yes',
        ],
        {
          cwd: projectDir,
          env: { AGENTPM_HOME: homeDir },
        },
      );

      await writeFile(
        path.join(repoDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
        '# Skill A\n\nUpdated by provider bridge.\n',
      );
      git(repoDir, 'add', '.');
      git(repoDir, 'commit', '-m', 'update provider skill');

      const { stdout } = await runCli(['skills', 'update', '--yes'], {
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });

      expect(stdout).toContain('Update complete');
      expect(stdout).toContain('skills.sh item(s) updated');
      expect(
        await fs.readFile(
          path.join(projectDir, '.codex', 'skills', 'skill-a', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('Updated by provider bridge.');
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'prints CLI help through tsx',
    async () => {
      const { stdout } = await runCli(['--help'], {
        cwd: path.resolve('.'),
      });
      expect(stdout).toContain('Git-native skill and agent asset manager');
      expect(stdout).toContain('source');
      expect(stdout).toContain('install');
      expect(stdout).toContain('refresh');
      expect(stdout).toContain('cache');
      expect(stdout).toContain('skills search typescript');
      expect(stdout).toContain(
        'skills install wshobson/agents@typescript-advanced-types --project',
      );
      expect(stdout).toContain(
        'install --from travelhawk/skills-vault --skill release-helper --project',
      );
      expect(stdout).toContain(
        'target add https://github.com/travelhawk/skills-vault',
      );
      expect(stdout).toContain('agentpm push');
      expect(stdout).not.toContain('push --all');
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'prints agent-safe quickstart commands as JSON',
    async () => {
      const { stdout } = await runCli(['quickstart', '--json'], {
        cwd: path.resolve('.'),
      });
      const payload = JSON.parse(stdout) as {
        guides: Array<{ id: string; commands: string[] }>;
      };
      const commands = payload.guides.flatMap((guide) => guide.commands);
      expect(commands).toContain('agentpm push --all --to my-skills --json');
      expect(commands).toContain(
        'agentpm pull --from my-skills --target codex,claude,generic --yes --json',
      );
      expect(commands).not.toContain('agentpm push');
      expect(
        commands.every(
          (command) => !command.includes(' --json') || command.endsWith('--json'),
        ),
      ).toBe(true);
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'prints the package version through the CLI',
    async () => {
      const packageJson = JSON.parse(
        await fs.readFile(path.join('apps', 'cli', 'package.json'), 'utf8'),
      ) as { version: string };
      const { stdout } = await runCli(['--version'], {
        cwd: path.resolve('.'),
      });
      expect(stdout.trim()).toBe(packageJson.version);
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'prints command-specific help examples for source add',
    async () => {
      const { stdout } = await runCli(['source', 'add', '--help'], {
        cwd: path.resolve('.'),
      });
      expect(stdout).toContain('agentpm source add travelhawk/skills-vault');
      expect(stdout).toContain(
        'registry:https://registry.example.com/agentpm/index.yaml',
      );
      expect(stdout).not.toContain('agentpm push --all');
      expect(stdout).not.toContain(
        'agentpm target add https://github.com/travelhawk/skills-vault',
      );
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'prints command-specific help examples for target add',
    async () => {
      const { stdout } = await runCli(['target', 'add', '--help'], {
        cwd: path.resolve('.'),
      });
      expect(stdout).toContain(
        'agentpm target add origin travelhawk/skills-vault --default',
      );
      expect(stdout).toContain(
        'agentpm target add https://github.com/travelhawk/skills-vault',
      );
      expect(stdout).not.toContain(
        'agentpm source add git@github.com:company/private-skills.git',
      );
      expect(stdout).not.toContain('agentpm push --all');
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'prints push --all in push command help',
    async () => {
      const { stdout } = await runCli(['push', '--help'], {
        cwd: path.resolve('.'),
      });
      expect(stdout).toContain('--all');
      expect(stdout).toContain('agentpm push --all');
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'prints non-interactive remove filters in remove command help',
    async () => {
      const { stdout } = await runCli(['remove', '--help'], {
        cwd: path.resolve('.'),
      });
      expect(stdout).toContain('--target <agent>');
      expect(stdout).toContain('--scope <scope>');
      expect(stdout).toContain('--path <path>');
    },
    CI_TEST_TIMEOUT,
  );
});
