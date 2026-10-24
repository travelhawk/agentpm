import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { inferContentKind } from '@agentpm/git';
import { AgentPmService } from '@agentpm/core';
import { classifyLocator, normalizeGitHubRepoLocator } from '@agentpm/shared';

import {
  copyDir,
  git,
  initFixtureGitRepo,
  makeTempDir,
  writeFile,
} from './helpers';

const fixturesRoot = path.resolve('tests/fixtures/repos');
// Tests here shell out to the CLI (often twice, through tsx with its cache
// disabled), so a single case can legitimately take well over ten seconds on a
// busy machine. Use the same budget locally as on CI: the tighter local limit
// only produced timeout flakes, never a faster signal.
const CI_TEST_TIMEOUT = 30_000;

describe('inspect and search', () => {
  test('detects codex layout from a local repo', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const repoDir = await makeTempDir('agentpm-codex-');
    await copyDir(path.join(fixturesRoot, 'codex'), repoDir);

    const service = new AgentPmService({
      cwd: repoDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const report = await service.inspect(repoDir);
      expect(report.installable).toBe(true);
      expect(report.groups[0]?.relativeRoot).toBe('.codex/skills');
      expect(report.groups[0]?.entries.map((entry) => entry.name)).toContain(
        'skill-a',
      );
    } finally {
      service.close();
    }
  });

  test('adds a registry source and exposes catalog search results', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const workspace = await makeTempDir('agentpm-workspace-');
    await copyDir(
      path.resolve('tests/fixtures/registry'),
      path.join(workspace, 'registry'),
    );
    await copyDir(
      path.resolve('tests/fixtures/repos/codex'),
      path.join(workspace, 'repos', 'codex'),
    );

    const service = new AgentPmService({
      cwd: workspace,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const added = await service.addSource(
        path.join(workspace, 'registry', 'index.yaml'),
      );
      expect(added.indexedEntries).toBe(1);

      const results = service.search('registry-codex');
      expect(results.some((result) => result.name === 'registry-codex')).toBe(
        true,
      );
    } finally {
      service.close();
    }
  });

  test('does not treat skills.sh as a dedicated registry locator', () => {
    expect(classifyLocator('skills.sh')).toBe('local');
    expect(classifyLocator('https://skills.sh')).toBe('git');
    expect(classifyLocator('skillshub.wtf')).toBe('local');
    expect(classifyLocator('https://skillshub.wtf')).toBe('git');
  });

  test('treats bare owner/repo locators as git and normalizes them to github:', () => {
    expect(classifyLocator('travelhawk/skills-vault')).toBe('git');
    expect(normalizeGitHubRepoLocator('travelhawk/skills-vault')).toBe(
      'github:travelhawk/skills-vault',
    );
    expect(inferContentKind('travelhawk/skills-vault')).toBe('git');
  });

  test('prefers an existing local owner/repo path over GitHub shorthand', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const workspaceDir = await makeTempDir('agentpm-workspace-');
    await writeFile(
      path.join(
        workspaceDir,
        'travelhawk',
        'skills-vault',
        'skills',
        'local-skill',
        'SKILL.md',
      ),
      '# Local Skill\n',
    );

    const service = new AgentPmService({
      cwd: workspaceDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const result = await service.addSource('travelhawk/skills-vault');
      expect(result.source.kind).toBe('local');
      expect(result.source.locator).toBe(
        path.join(workspaceDir, 'travelhawk', 'skills-vault'),
      );
      expect(
        service
          .search('local-skill')
          .some((entry) => entry.name === 'local-skill'),
      ).toBe(true);
    } finally {
      service.close();
    }
  });

  test(
    'refresh rebuilds a git source index after repository changes',
    async () => {
      const homeDir = await makeTempDir('agentpm-home-');
      const repoDir = await makeTempDir('agentpm-git-source-');
      await copyDir(path.join(fixturesRoot, 'codex'), repoDir);
      initFixtureGitRepo(repoDir);

      const service = new AgentPmService({
        cwd: repoDir,
        env: { AGENTPM_HOME: homeDir },
      });
      try {
        await service.addSource(repoDir);
        expect(service.search('new-skill')).toHaveLength(0);

        await writeFile(
          path.join(repoDir, '.codex', 'skills', 'new-skill', 'SKILL.md'),
          '# New Skill\n',
        );
        git(repoDir, 'add', '.');
        git(repoDir, 'commit', '-m', 'add new skill');

        const results = await service.refreshSources();
        expect(results[0]?.indexedEntries).toBe(2);
        expect(
          service
            .search('new-skill')
            .some((result) => result.name === 'new-skill'),
        ).toBe(true);
      } finally {
        service.close();
      }
    },
    CI_TEST_TIMEOUT,
  );

  test('detects plain skills folder repositories and install-script risk', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const repoDir = await makeTempDir('agentpm-plain-skills-');
    await writeFile(
      path.join(repoDir, 'skills', 'plain-skill', 'SKILL.md'),
      '# Plain Skill\n',
    );
    await writeFile(path.join(repoDir, 'scripts', 'install.sh'), '#!/bin/sh\n');

    const service = new AgentPmService({
      cwd: repoDir,
      env: { AGENTPM_HOME: homeDir },
    });
    try {
      const report = await service.inspect(repoDir);
      expect(report.installable).toBe(true);
      expect(report.groups[0]?.relativeRoot).toBe('skills');
      expect(report.groups[0]?.entries[0]?.name).toBe('plain-skill');
      expect(report.scripts[0]?.relativePath).toBe('scripts/install.sh');
      expect(report.warnings).toContain(
        'Install scripts detected. AgentPM does not execute them automatically.',
      );
    } finally {
      service.close();
    }
  });
});
