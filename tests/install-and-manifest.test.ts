import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';

import {
  copyDir,
  git,
  initFixtureGitRepo,
  makeTempDir,
  writeFile,
} from './helpers';

// Tests here shell out to the CLI (often twice, through tsx with its cache
// disabled), so a single case can legitimately take well over ten seconds on a
// busy machine. Use the same budget locally as on CI: the tighter local limit
// only produced timeout flakes, never a faster signal.
const CI_TEST_TIMEOUT = 30_000;

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

describe('install and manifest flows', () => {
  test('installs a local generic skill into project scope without creating a manifest by default', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addSource(sourceDir);
      const installs = await service.install(['skill-b'], { scope: 'project' });
      expect(installs).toHaveLength(1);

      const targetPath = path.join(projectDir, '.agents', 'skills', 'skill-b');
      expect(await fs.lstat(targetPath)).toBeTruthy();
      await expect(
        fs.readFile(path.join(projectDir, 'agentpm.yaml'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      service.close();
    }
  });

  test('workspace installs do not create a manifest by default', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    const workspaceRoot = path.join(projectDir, 'workspace-root');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addSource(sourceDir);
      const installs = await service.install(['skill-b'], {
        scope: 'workspace',
        workspaceRoot,
      });
      expect(installs).toHaveLength(1);
      expect(
        await fs.lstat(
          path.join(workspaceRoot, '.agents', 'skills', 'skill-b'),
        ),
      ).toBeTruthy();
      await expect(
        fs.readFile(path.join(projectDir, 'agentpm.yaml'), 'utf8'),
      ).rejects.toThrow();
    } finally {
      service.close();
    }
  });

  test('installs a local generic skill into project scope and writes a manifest after explicit init', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addSource(sourceDir);
      const installs = await service.install(['skill-b'], { scope: 'project' });
      expect(installs).toHaveLength(1);

      const targetPath = path.join(projectDir, '.agents', 'skills', 'skill-b');
      expect(await fs.lstat(targetPath)).toBeTruthy();

      const manifest = await service.initManifest();
      expect(manifest.manifest.installs[0]?.name).toBe('skill-b');
      expect(
        await fs.readFile(path.join(projectDir, 'agentpm.yaml'), 'utf8'),
      ).toContain('skill-b');

      const doctorIssues = await service.doctor();
      expect(
        doctorIssues.filter((issue) => issue.severity === 'error'),
      ).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  test('project installs update an existing agentpm.yaml automatically', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
    await fs.writeFile(
      path.join(projectDir, 'agentpm.yaml'),
      'version: 1\nskills: []\n',
      'utf8',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addSource(sourceDir);
      const installs = await service.install(['skill-b'], { scope: 'project' });
      expect(installs).toHaveLength(1);

      const { loadProjectConfig } = await import('@agentpm/config');
      const config = await loadProjectConfig(projectDir);
      expect(config?.manifest.sources).toHaveLength(1);
      expect(config?.manifest.installs.map((install) => install.name)).toEqual([
        'skill-b',
      ]);
      expect(
        await fs.readFile(path.join(projectDir, 'agentpm.yaml'), 'utf8'),
      ).toContain('skills:');
    } finally {
      service.close();
    }
  });

  test('workspace installs update an existing agentpm.yaml automatically', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    const workspaceRoot = path.join(projectDir, 'workspace-target');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
    await fs.writeFile(
      path.join(projectDir, 'agentpm.yaml'),
      'version: 1\nskills: []\n',
      'utf8',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addSource(sourceDir);
      const installs = await service.install(['skill-b'], {
        scope: 'workspace',
        workspaceRoot,
      });
      expect(installs).toHaveLength(1);

      const { loadProjectConfig } = await import('@agentpm/config');
      const config = await loadProjectConfig(projectDir);
      expect(config?.manifest.installs[0]?.name).toBe('skill-b');
      expect(config?.manifest.installs[0]?.scope).toBe('workspace');
      expect(config?.manifest.installs[0]?.workspaceRoot).toBe(workspaceRoot);
    } finally {
      service.close();
    }
  });

  test(
    'skills.sh bridge installs persist resolved sources and provenance into agentpm.yaml for later sync',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const sourceDir = await makeTempDir('agentpm-source-');
      const projectA = await makeTempDir('agentpm-project-a-');
      const projectB = await makeTempDir('agentpm-project-b-');
      await copyDir(path.resolve('tests/fixtures/repos/codex'), sourceDir);
      initFixtureGitRepo(sourceDir);
      await fs.writeFile(
        path.join(projectA, 'agentpm.yaml'),
        'version: 1\nskills: []\n',
        'utf8',
      );

      const serviceA = new AgentPmService({
        cwd: projectA,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        const installs = await serviceA.installProviderSkill(sourceDir, {
          scope: 'project',
          skills: ['skill-a'],
        });
        expect(installs).toHaveLength(1);

        const { loadProjectConfig } = await import('@agentpm/config');
        const config = await loadProjectConfig(projectA);
        expect(config?.manifest.sources).toHaveLength(1);
        expect(config?.manifest.sources[0]?.locator).toBe(
          path.resolve(sourceDir),
        );
        expect(config?.manifest.installs[0]?.name).toBe('skill-a');
        expect(config?.manifest.installs[0]?.provider).toBe('skills.sh');
        expect(config?.manifest.installs[0]?.selector).toBeUndefined();
      } finally {
        serviceA.close();
      }

      await fs.copyFile(
        path.join(projectA, 'agentpm.yaml'),
        path.join(projectB, 'agentpm.yaml'),
      );

      const serviceB = new AgentPmService({
        cwd: projectB,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        const installs = await serviceB.syncManifest();
        expect(installs.some((install) => install.name === 'skill-a')).toBe(
          true,
        );
        expect(
          await fs.lstat(path.join(projectB, '.codex', 'skills', 'skill-a')),
        ).toBeTruthy();
      } finally {
        serviceB.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test('a standalone .agentpmrc does not trigger agentpm.yaml creation on install', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
    await fs.writeFile(
      path.join(projectDir, '.agentpmrc'),
      'version: 1\nskills: []\n',
      'utf8',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addSource(sourceDir);
      const installs = await service.install(['skill-b'], { scope: 'project' });
      expect(installs).toHaveLength(1);
      await expect(
        fs.readFile(path.join(projectDir, 'agentpm.yaml'), 'utf8'),
      ).rejects.toThrow();
      expect(
        await fs.readFile(path.join(projectDir, '.agentpmrc'), 'utf8'),
      ).toContain('skills: []');
    } finally {
      service.close();
    }
  });

  test('sync installs entries from agentpm.yaml into a second project', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectA = await makeTempDir('agentpm-project-a-');
    const projectB = await makeTempDir('agentpm-project-b-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);

    const serviceA = new AgentPmService({
      cwd: projectA,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await serviceA.addSource(sourceDir);
      await serviceA.install(['skill-b'], { scope: 'project' });
      await serviceA.initManifest();
    } finally {
      serviceA.close();
    }

    await fs.copyFile(
      path.join(projectA, 'agentpm.yaml'),
      path.join(projectB, 'agentpm.yaml'),
    );

    const serviceB = new AgentPmService({
      cwd: projectB,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const installs = await serviceB.syncManifest();
      expect(installs.some((install) => install.name === 'skill-b')).toBe(true);
      expect(
        await fs.lstat(path.join(projectB, '.agents', 'skills', 'skill-b')),
      ).toBeTruthy();
    } finally {
      serviceB.close();
    }
  });

  test('installs a nested skill collection entry by path selector', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const projectDir = await makeTempDir('agentpm-project-');
    const repoDir = path.resolve('tests/fixtures/repos/nested-skills');

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const addedSource = await service.addSource(repoDir);
      expect(addedSource.indexedEntries).toBe(2);

      const installs = await service.install([addedSource.source.id], {
        scope: 'project',
        skills: ['.curated/openai-docs'],
      });

      expect(installs).toHaveLength(1);
      expect(installs[0]?.name).toBe('openai-docs');
      expect(installs[0]?.sourceRelativePath).toBe(
        'skills/.curated/openai-docs',
      );

      const installedPath = path.join(
        projectDir,
        '.agents',
        'skills',
        '.curated',
        'openai-docs',
        'SKILL.md',
      );
      const installedContent = await fs.readFile(installedPath, 'utf8');
      expect(installedContent).toContain('Curated OpenAI docs skill');
    } finally {
      service.close();
    }
  });

  test('plain skills sources install into .agents/skills and can update .gitignore', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-plain-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await writeFile(
      path.join(sourceDir, 'skills', 'plain-skill', 'SKILL.md'),
      '# Plain Skill\n',
    );
    await writeFile(path.join(projectDir, 'README.md'), '# Project\n');
    initFixtureGitRepo(projectDir);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
      prompts: {
        confirm: () => Promise.resolve(true),
      },
    });
    try {
      await service.addSource(sourceDir);
      const installs = await service.install(['plain-skill'], {
        scope: 'project',
      });

      expect(installs[0]?.targetPath).toBe(
        path.join(projectDir, '.agents', 'skills', 'plain-skill'),
      );
      expect(
        await fs.readFile(
          path.join(projectDir, '.agents', 'skills', 'plain-skill', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('Plain Skill');
      expect(
        await fs.readFile(path.join(projectDir, '.gitignore'), 'utf8'),
      ).toContain('.agents/');
    } finally {
      service.close();
    }
  });

  test('lists installable skills from a direct repo locator without adding a source', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.listSourceEntries(sourceDir);
      expect(result.persisted).toBe(false);
      expect(result.entries.map((entry) => entry.name)).toEqual(['skill-b']);
      expect(service.listSources()).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  test('installs selected skills from --from and adds the source after confirmation', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
      prompts: {
        confirm: () => Promise.resolve(true),
        selectMany: (_message, options) =>
          Promise.resolve(
            options
              .filter((option) => option.label === 'skill-b')
              .map((option) => option.value),
          ),
      },
    });
    try {
      const installs = await service.install([], {
        from: sourceDir,
        scope: 'project',
      });
      expect(installs).toHaveLength(1);
      expect(installs[0]?.name).toBe('skill-b');
      expect(
        await fs.lstat(path.join(projectDir, '.agents', 'skills', 'skill-b')),
      ).toBeTruthy();
      expect(service.listSources()).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  test('installs selected skills from --from without permanently adding the source when declined', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
    await fs.writeFile(
      path.join(projectDir, 'agentpm.yaml'),
      'version: 1\nskills: []\n',
      'utf8',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
      prompts: {
        confirm: () => Promise.resolve(false),
        selectMany: (_message, options) =>
          Promise.resolve(
            options
              .filter((option) => option.label === 'skill-b')
              .map((option) => option.value),
          ),
      },
    });
    try {
      const installs = await service.install([], {
        from: sourceDir,
        scope: 'project',
      });
      expect(installs).toHaveLength(1);
      expect(service.listSources()).toHaveLength(0);

      const { loadProjectConfig } = await import('@agentpm/config');
      const config = await loadProjectConfig(projectDir);
      expect(config?.manifest.sources.map((source) => source.locator)).toEqual([
        path.resolve(sourceDir),
      ]);
      expect(config?.manifest.installs[0]?.name).toBe('skill-b');
    } finally {
      service.close();
    }
  });

  test('sync reads agentpm.yaml, resolves sources in order, and excludes generated targets locally', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
    await fs.writeFile(
      path.join(projectDir, 'agentpm.yaml'),
      `sources:\n  - ${JSON.stringify(`local:${sourceDir}`)}\nscope: project\nskills:\n  - skill-b\n`,
      'utf8',
    );
    initFixtureGitRepo(projectDir);

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const installs = await service.syncManifest();
      expect(installs.map((install) => install.name)).toEqual(['skill-b']);
      expect(
        await fs.lstat(path.join(projectDir, '.agents', 'skills', 'skill-b')),
      ).toBeTruthy();

      const exclude = await fs.readFile(
        path.join(projectDir, '.git', 'info', 'exclude'),
        'utf8',
      );
      expect(exclude).toContain('.agents/skills/skill-b/');
    } finally {
      service.close();
    }
  });

  test('resolves project and temporary runtime layers without adding project targets', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
    await fs.writeFile(
      path.join(projectDir, 'agentpm.yaml'),
      `sources:\n  - ${JSON.stringify(`local:${sourceDir}`)}\nskills:\n  - skill-b\n`,
      'utf8',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const graph = await service.resolveRuntimeContext({
        temporarySkills: ['skill-b'],
      });
      expect(graph.configPath).toBe(path.join(projectDir, 'agentpm.yaml'));
      expect(graph.layers.project[0]?.name).toBe('skill-b');
      expect(graph.layers.project[0]?.targetPath).toBeNull();
      expect(graph.layers.temporary[0]?.name).toBe('skill-b');
      await expect(
        fs.lstat(path.join(projectDir, '.agents', 'skills', 'skill-b')),
      ).rejects.toThrow();
    } finally {
      service.close();
    }
  });

  test('sync supports source aliases and registry-prefixed private indexes', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const workspace = await makeTempDir('agentpm-workspace-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(
      path.resolve('tests/fixtures/registry'),
      path.join(workspace, 'registry'),
    );
    await copyDir(
      path.resolve('tests/fixtures/repos/codex'),
      path.join(workspace, 'repos', 'codex'),
    );

    const registryPath = path.join(workspace, 'registry', 'index.yaml');
    await fs.writeFile(
      path.join(projectDir, 'agentpm.yaml'),
      [
        'sources:',
        '  - id: enterprise',
        `    locator: ${JSON.stringify(`registry:${registryPath}`)}`,
        'skills:',
        '  - name: registry-codex',
        '    source: enterprise',
        '    items:',
        '      - registry-codex',
        '',
      ].join('\n'),
      'utf8',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const installs = await service.syncManifest();
      expect(installs.map((install) => install.name)).toEqual(['skill-a']);
      expect(
        await fs.lstat(path.join(projectDir, '.codex', 'skills', 'skill-a')),
      ).toBeTruthy();
      const graph = await service.resolveRuntimeContext();
      expect(graph.layers.project[0]?.name).toBe('registry-codex');
      expect(graph.layers.project[0]?.targetPath).toBe(
        path.join(projectDir, '.codex', 'skills', 'skill-a'),
      );
    } finally {
      service.close();
    }
  });

  test(
    'sync honors detailed target, ref, revision, and workspace root fields',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const sourceDir = await makeTempDir('agentpm-source-mixed-');
      const projectDir = await makeTempDir('agentpm-project-');
      const workspaceRoot = path.join(projectDir, 'workspace-target');
      await writeFile(
        path.join(sourceDir, '.codex', 'skills', 'shared-skill', 'SKILL.md'),
        '# Codex Shared Skill\n',
      );
      await writeFile(
        path.join(sourceDir, '.agents', 'skills', 'shared-skill', 'SKILL.md'),
        '# Generic Shared Skill\n',
      );
      initFixtureGitRepo(sourceDir);
      const revision = (
        await fs.readFile(
          path.join(sourceDir, '.git', 'refs', 'heads', 'main'),
          'utf8',
        )
      ).trim();

      await fs.writeFile(
        path.join(projectDir, 'agentpm.yaml'),
        [
          'sources:',
          '  - id: mixed',
          `    locator: ${JSON.stringify(`local:${sourceDir}`)}`,
          'skills:',
          '  - name: shared-package',
          '    source: mixed',
          '    target: codex',
          '    scope: workspace',
          `    workspaceRoot: ${JSON.stringify(workspaceRoot)}`,
          '    ref: main',
          `    revision: ${revision}`,
          '    items:',
          '      - shared-skill',
          '',
        ].join('\n'),
        'utf8',
      );

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        const installs = await service.syncManifest();
        expect(installs).toHaveLength(1);
        expect(installs[0]?.adapter).toBe('codex');
        expect(installs[0]?.contentRef).toBe('main');
        expect(installs[0]?.installedRevision).toBe(revision);
        expect(installs[0]?.scopeRoot).toBe(workspaceRoot);
        expect(
          await fs.readFile(
            path.join(
              workspaceRoot,
              '.codex',
              'skills',
              'shared-skill',
              'SKILL.md',
            ),
            'utf8',
          ),
        ).toContain('Codex Shared Skill');
        await expect(
          fs.lstat(
            path.join(workspaceRoot, '.agents', 'skills', 'shared-skill'),
          ),
        ).rejects.toThrow();

        const graph = await service.resolveRuntimeContext();
        expect(graph.layers.project[0]?.name).toBe('shared-skill');
        expect(graph.layers.project[0]?.adapter).toBe('codex');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test('sync fails clearly for unsupported target values', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
    await fs.writeFile(
      path.join(projectDir, 'agentpm.yaml'),
      [
        'sources:',
        `  - ${JSON.stringify(`local:${sourceDir}`)}`,
        'skills:',
        '  - name: skill-b',
        '    target: cursor',
        '',
      ].join('\n'),
      'utf8',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await expect(service.syncManifest()).rejects.toThrow(
        'skills[].target must be one of: codex, claude, generic',
      );
      const issues = await service.doctor();
      expect(issues.some((issue) => issue.code === 'config-invalid')).toBe(
        true,
      );
    } finally {
      service.close();
    }
  });

  test('loads .agentpmrc only as a local compatibility fallback', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    const projectDir = await makeTempDir('agentpm-project-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
    await fs.writeFile(
      path.join(projectDir, '.agentpmrc'),
      `sources:\n  - ${JSON.stringify(`local:${sourceDir}`)}\nskills:\n  - skill-b\n`,
      'utf8',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const graph = await service.resolveRuntimeContext();
      expect(graph.configPath).toBe(path.join(projectDir, '.agentpmrc'));
      expect(graph.warnings[0]).toContain('compatibility fallback');
      expect(graph.layers.project[0]?.name).toBe('skill-b');
    } finally {
      service.close();
    }
  });

  test(
    'indexes a git-backed source under a shortened Windows-safe cache path',
    async () => {
      const homeRoot = await makeTempDir('agentpm-home-root-');
      const homeDir = path.join(homeRoot, `agentpm-home-${'x'.repeat(48)}`);
      const sourceDir = await makeTempDir('agentpm-source-git-');
      const projectDir = await makeTempDir('agentpm-project-');
      await fs.mkdir(homeDir, { recursive: true });
      await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
      initFixtureGitRepo(sourceDir);

      const service = new AgentPmService({
        cwd: projectDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(pathToFileURL(sourceDir).href);
        const cacheRepos = service.db.listCacheRepos();
        expect(cacheRepos).toHaveLength(1);
        const cacheBasePath = cacheRepos[0]!.basePath;
        expect(cacheBasePath).toContain(path.join('cache', 'repos'));
        expect(path.basename(cacheBasePath)).toHaveLength(16);
        expect(cacheBasePath.length).toBeLessThan(180);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test('configures global targets and falls back to global targets when no local agentpm.yaml is present', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const projectDir = await makeTempDir('agentpm-project-');
    await writeFile(
      path.join(projectDir, '.agents', 'skills', 'local-skill', 'SKILL.md'),
      '# local skill\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      // 1. Add target globally
      await service.addTarget(
        'global-git-target',
        'https://github.com/my-org/my-target-repo.git',
      );

      // 2. Load global config and assert target is saved globally
      const { loadGlobalConfig } = await import('@agentpm/config');
      const globalConfig = await loadGlobalConfig(projectDir, {
        AGENTPM_HOME: homeDir,
      });
      expect(globalConfig.targets).toHaveLength(1);
      expect(globalConfig.targets?.[0]?.id).toBe('global-git-target');
      expect(globalConfig.targets?.[0]?.locator).toBe(
        'https://github.com/my-org/my-target-repo.git',
      );
      expect(globalConfig.targets?.[0]?.kind).toBe('git');

      // 3. Perform a dry-run push and assert it resolves to the global target because there is no local agentpm.yaml
      const result = await service.push({
        target: 'global-git-target',
        dryRun: true,
      });
      expect(result.success).toBe(true);
      expect(result.targetLocator).toBe(
        'https://github.com/my-org/my-target-repo.git',
      );

      // 4. Remove target globally
      await service.removeTarget('global-git-target');
      const nextGlobalConfig = await loadGlobalConfig(projectDir, {
        AGENTPM_HOME: homeDir,
      });
      expect(nextGlobalConfig.targets).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  test('normalizes bare GitHub shorthand for targets and direct push locators', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const projectDir = await makeTempDir('agentpm-project-');
    await writeFile(
      path.join(projectDir, '.agents', 'skills', 'local-skill', 'SKILL.md'),
      '# local skill\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addTarget('skills-vault', 'travelhawk/skills-vault');

      const { loadGlobalConfig } = await import('@agentpm/config');
      const globalConfig = await loadGlobalConfig(projectDir, {
        AGENTPM_HOME: homeDir,
      });
      expect(globalConfig.targets?.[0]?.locator).toBe(
        'github:travelhawk/skills-vault',
      );

      const result = await service.push({
        target: 'travelhawk/skills-vault',
        dryRun: true,
      });
      expect(result.targetLocator).toBe('github:travelhawk/skills-vault');
    } finally {
      service.close();
    }
  });

  test('push selects a target interactively and saves it as the default', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const projectDir = await makeTempDir('agentpm-project-');
    await writeFile(
      path.join(projectDir, 'agentpm.yaml'),
      'version: 1\nskills: []\n',
    );
    await writeFile(
      path.join(projectDir, '.agents', 'skills', 'local-skill', 'SKILL.md'),
      '# local skill\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
      prompts: {
        selectOne: (_message, options) =>
          Promise.resolve(
            options.find((option) => option.label === 'secondary')!.value,
          ),
        confirm: () => Promise.resolve(true),
      },
    });
    try {
      await service.addTarget(
        'primary',
        'https://github.com/my-org/primary.git',
      );
      await service.addTarget(
        'secondary',
        'https://github.com/my-org/secondary.git',
      );

      const result = await service.push({ dryRun: true });
      expect(result.targetLocator).toBe(
        'https://github.com/my-org/secondary.git',
      );

      const { loadGlobalConfig } = await import('@agentpm/config');
      const config = await loadGlobalConfig(projectDir, {
        AGENTPM_HOME: homeDir,
      });
      expect(
        config.targets?.find((target) => target.id === 'secondary')?.default,
      ).toBe(true);
      expect(
        config.targets?.find((target) => target.id === 'primary')?.default,
      ).toBe(false);
    } finally {
      service.close();
    }
  });

  test('push fails clearly for multiple non-interactive targets without a default', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const projectDir = await makeTempDir('agentpm-project-');
    await writeFile(
      path.join(projectDir, 'agentpm.yaml'),
      'version: 1\nskills: []\n',
    );
    await writeFile(
      path.join(projectDir, '.agents', 'skills', 'local-skill', 'SKILL.md'),
      '# local skill\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addTarget(
        'primary',
        'https://github.com/my-org/primary.git',
      );
      await service.addTarget(
        'secondary',
        'https://github.com/my-org/secondary.git',
      );

      await expect(service.push({ dryRun: true })).rejects.toThrow(
        'agentpm target default <id>',
      );
    } finally {
      service.close();
    }
  });

  test('target defaults can be set explicitly and only one remains active', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const projectDir = await makeTempDir('agentpm-project-');
    await writeFile(
      path.join(projectDir, 'agentpm.yaml'),
      'version: 1\nskills: []\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addTarget(
        'primary',
        'https://github.com/my-org/primary.git',
        true,
      );
      await service.addTarget(
        'secondary',
        'https://github.com/my-org/secondary.git',
      );
      await service.setDefaultTarget('secondary');

      const { loadGlobalConfig } = await import('@agentpm/config');
      const config = await loadGlobalConfig(projectDir, {
        AGENTPM_HOME: homeDir,
      });
      expect(
        config.targets?.map((target) => [target.id, target.default]),
      ).toEqual([
        ['primary', false],
        ['secondary', true],
      ]);
    } finally {
      service.close();
    }
  });

  test('push ignores legacy project targets and uses global targets only', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const projectDir = await makeTempDir('agentpm-project-');
    await writeFile(
      path.join(projectDir, 'agentpm.yaml'),
      [
        'version: 1',
        'targets:',
        '  - id: legacy-project',
        '    locator: https://github.com/my-org/legacy.git',
        '    kind: git',
        '    default: true',
        'skills: []',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(projectDir, '.agents', 'skills', 'local-skill', 'SKILL.md'),
      '# local skill\n',
    );

    const service = new AgentPmService({
      cwd: projectDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      await service.addTarget(
        'global-target',
        'https://github.com/my-org/global.git',
      );
      const result = await service.push({ dryRun: true });
      expect(result.targetLocator).toBe('https://github.com/my-org/global.git');
    } finally {
      service.close();
    }
  });

  test(
    'pushes a selected workspace skill into the canonical skills/ folder of an empty target repository',
    async () => {
      const projectDir = await makeTempDir('agentpm-push-project-');
      const remoteDir = await makeTempDir('agentpm-push-remote-');
      const remoteRepo = path.join(remoteDir, 'skills.git');
      const verifyDir = path.join(remoteDir, 'verify');
      const gitGlobalConfig = await writeGitGlobalIgnoreConfig(remoteDir, [
        '.agents/',
      ]);

      git(remoteDir, 'init', '--bare', remoteRepo);
      await writeFile(
        path.join(projectDir, '.agents', 'skills', 'skill-a', 'SKILL.md'),
        '# pushed skill\n',
      );
      await writeFile(path.join(projectDir, 'README.md'), 'workspace root\n');
      git(projectDir, 'init', '-b', 'main');
      git(projectDir, 'config', 'user.name', 'AgentPM Tests');
      git(projectDir, 'config', 'user.email', 'tests@example.com');

      const service = new AgentPmService({
        cwd: projectDir,
        env: {
          GIT_AUTHOR_NAME: 'AgentPM Tests',
          GIT_AUTHOR_EMAIL: 'tests@example.com',
          GIT_COMMITTER_NAME: 'AgentPM Tests',
          GIT_COMMITTER_EMAIL: 'tests@example.com',
          GIT_CONFIG_GLOBAL: gitGlobalConfig,
        },
      });
      try {
        const result = await service.push({
          target: remoteRepo,
          path: 'skill-a',
          message: 'Initial push',
        });

        expect(result.success).toBe(true);
        expect(result.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(result.entries).toEqual(['skills/skill-a']);

        git(remoteDir, 'clone', remoteRepo, verifyDir);
        expect(
          await fs.readFile(
            path.join(verifyDir, 'skills', 'skill-a', 'SKILL.md'),
            'utf8',
          ),
        ).toContain('# pushed skill');
        expect(
          await fs.stat(path.join(verifyDir, 'README.md')).catch(() => null),
        ).toBeNull();
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'push can interactively select individual workspace skills',
    async () => {
      const projectDir = await makeTempDir('agentpm-push-project-');
      const remoteDir = await makeTempDir('agentpm-push-remote-');
      const remoteRepo = path.join(remoteDir, 'skills.git');
      const verifyDir = path.join(remoteDir, 'verify');
      const promptedDescriptions: string[] = [];
      const gitGlobalConfig = await writeGitGlobalIgnoreConfig(remoteDir, [
        '.agents/',
        '.codex/',
      ]);

      git(remoteDir, 'init', '--bare', remoteRepo);
      await writeFile(
        path.join(projectDir, '.agents', 'skills', 'skill-a', 'SKILL.md'),
        '# skill a\n',
      );
      await writeFile(
        path.join(projectDir, '.codex', 'skills', 'skill-b', 'SKILL.md'),
        '# skill b\n',
      );

      const service = new AgentPmService({
        cwd: projectDir,
        env: {
          GIT_AUTHOR_NAME: 'AgentPM Tests',
          GIT_AUTHOR_EMAIL: 'tests@example.com',
          GIT_COMMITTER_NAME: 'AgentPM Tests',
          GIT_COMMITTER_EMAIL: 'tests@example.com',
          GIT_CONFIG_GLOBAL: gitGlobalConfig,
        },
        prompts: {
          selectMany: (_message, options) => {
            promptedDescriptions.push(
              ...options.map((option) => option.description ?? ''),
            );
            return Promise.resolve([
              options.find((option) => option.label === 'skill-b')!.value,
            ]);
          },
        },
      });

      try {
        const result = await service.push({
          target: remoteRepo,
          message: 'Push selected skill',
        });

        expect(result.entries).toEqual(['skills/skill-b']);
        expect(promptedDescriptions).toContain(
          'generic  skills/skill-a  <- .agents/skills/skill-a',
        );
        expect(promptedDescriptions).toContain(
          'codex  skills/skill-b  <- .codex/skills/skill-b',
        );

        git(remoteDir, 'clone', remoteRepo, verifyDir);
        expect(
          await fs.readFile(
            path.join(verifyDir, 'skills', 'skill-b', 'SKILL.md'),
            'utf8',
          ),
        ).toContain('# skill b');
        expect(
          await fs
            .stat(path.join(verifyDir, 'skills', 'skill-a'))
            .catch(() => null),
        ).toBeNull();
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test(
    'push reuses the cached target repository across repeated pushes',
    async () => {
      const projectDir = await makeTempDir('agentpm-push-project-');
      const remoteDir = await makeTempDir('agentpm-push-remote-');
      const remoteRepo = path.join(remoteDir, 'skills.git');
      const verifyDir = path.join(remoteDir, 'verify');
      const gitGlobalConfig = await writeGitGlobalIgnoreConfig(remoteDir, [
        '.agents/',
      ]);

      git(remoteDir, 'init', '--bare', remoteRepo);
      await writeFile(
        path.join(projectDir, '.agents', 'skills', 'skill-a', 'SKILL.md'),
        '# version one\n',
      );

      const service = new AgentPmService({
        cwd: projectDir,
        env: {
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
        const cachedRepoPath = path.join(pushTargetCache!.basePath, 'worktree');
        const firstStat = await fs.stat(cachedRepoPath);

        await writeFile(
          path.join(projectDir, '.agents', 'skills', 'skill-a', 'SKILL.md'),
          '# version two\n',
        );

        await service.push({
          target: remoteRepo,
          path: 'skill-a',
          message: 'Second push',
        });

        const secondStat = await fs.stat(cachedRepoPath);
        expect(secondStat.ino).toBe(firstStat.ino);

        git(remoteDir, 'clone', remoteRepo, verifyDir);
        expect(
          await fs.readFile(
            path.join(verifyDir, 'skills', 'skill-a', 'SKILL.md'),
            'utf8',
          ),
        ).toContain('# version two');
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );
});
