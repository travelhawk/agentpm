import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';
import { AgentPmDatabase } from '@agentpm/db';
import type { PromptApi } from '@agentpm/shared';

import { copyDir, makeTempDir } from './helpers';

async function setupInstalledSkill(prompts: PromptApi = {}) {
  const homeDir = await makeTempDir('agentpm-home-');
  const sourceDir = await makeTempDir('agentpm-source-');
  const projectDir = await makeTempDir('agentpm-project-');
  await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);

  const service = new AgentPmService({
    cwd: projectDir,
    env: { AGENTPM_HOME: homeDir },
    prompts,
  });
  const added = await service.addSource(sourceDir);
  const [install] = await service.install(['skill-b'], { scope: 'project' });
  return { service, sourceDir, source: added.source, install: install! };
}

describe('source removal', () => {
  test('removes a source that no skill depends on', async () => {
    const homeDir = await makeTempDir('agentpm-home-');
    const sourceDir = await makeTempDir('agentpm-source-');
    await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
    const service = new AgentPmService({ env: { AGENTPM_HOME: homeDir } });
    try {
      const { source } = await service.addSource(sourceDir);
      const result = await service.removeSource(source.id);
      expect(result.removed).toBe(true);
      expect(service.listSources()).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  test('explains the choices instead of failing bare when it cannot prompt', async () => {
    const { service, source } = await setupInstalledSkill();
    try {
      await expect(service.removeSource(source.id)).rejects.toThrow(
        /still used by 1 installed skill: skill-b[\s\S]*--keep-installs[\s\S]*--remove-installs/,
      );
      expect(service.listSources()).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  test('keeps installed skills working after their source is removed', async () => {
    const { service, source, sourceDir, install } = await setupInstalledSkill();
    try {
      const result = await service.removeSource(source.id, { installs: 'keep' });
      expect(result.removed).toBe(true);
      expect(result.keptInstalls.map((kept) => kept.name)).toEqual(['skill-b']);
      expect(service.listSources()).toHaveLength(0);

      const [kept] = service.listInstalls();
      expect(kept?.metadata).toMatchObject({
        sourceLocator: source.locator,
        sourceKind: 'local',
      });
      await expect(
        fs.readFile(path.join(install.targetPath, 'SKILL.md'), 'utf8'),
      ).resolves.toBeTruthy();
      await expect(service.previewUpdates()).resolves.toHaveLength(1);

      // Source ids are deterministic, so re-adding links the skill again.
      const readded = await service.addSource(sourceDir);
      expect(readded.source.id).toBe(kept?.sourceId);
    } finally {
      service.close();
    }
  });

  test('uninstalls dependent skills when asked to remove them', async () => {
    const { service, source, install } = await setupInstalledSkill();
    try {
      const result = await service.removeSource(source.id, {
        installs: 'remove',
      });
      expect(result.removedInstalls.map((removed) => removed.name)).toEqual([
        'skill-b',
      ]);
      expect(service.listInstalls()).toHaveLength(0);
      expect(service.listSources()).toHaveLength(0);
      await expect(fs.lstat(install.targetPath)).rejects.toThrow();
    } finally {
      service.close();
    }
  });

  test('asks what to do with dependent skills and respects cancel', async () => {
    let offered: string[] = [];
    const { service, source } = await setupInstalledSkill({
      isInteractive: () => true,
      selectOne: <T>(_message: string, options: { label: string; value: T }[]) => {
        offered = options.map((option) => option.label);
        return Promise.resolve(
          options.find((option) => option.label === 'Cancel')!.value,
        );
      },
    });
    try {
      const result = await service.removeSource(source.id);
      expect(offered).toEqual([
        'Keep the skills',
        'Remove the skills too',
        'Cancel',
      ]);
      expect(result.removed).toBe(false);
      expect(service.listSources()).toHaveLength(1);
      expect(service.listInstalls()).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  test('suggests removing the skills first when the local source folder is gone', async () => {
    let offered: string[] = [];
    const { service, source, sourceDir } = await setupInstalledSkill({
      isInteractive: () => true,
      selectOne: <T>(_message: string, options: { label: string; value: T }[]) => {
        offered = options.map((option) => option.label);
        return Promise.resolve(options[0]!.value);
      },
    });
    try {
      await fs.rm(sourceDir, { recursive: true, force: true });
      const result = await service.removeSource(source.id);
      expect(offered[0]).toBe('Remove the skills too');
      expect(result.removedInstalls).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  test('migrates an old database so installs can outlive their source', async () => {
    const dbPath = path.join(await makeTempDir('agentpm-db-'), 'state.db');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      create table sources (id text primary key, kind text not null, locator text not null,
        normalized_locator text not null unique, display_name text not null,
        metadata_json text not null default '{}', created_at text not null, updated_at text not null);
      create table catalog_entries (id text primary key,
        source_id text not null references sources(id) on delete cascade, name text not null,
        description text, repo text not null, ref text, path text, adapter_hint text,
        tags_json text not null default '[]', metadata_json text not null default '{}',
        created_at text not null, updated_at text not null);
      create table installs (id text primary key, name text not null,
        source_id text not null references sources(id) on delete restrict,
        catalog_entry_id text references catalog_entries(id) on delete set null,
        adapter text not null, scope text not null, scope_root text not null,
        target_path text not null unique, link_target text not null,
        source_relative_path text not null, source_root_relative_path text not null,
        selected_items_json text not null default '[]', content_kind text not null,
        content_locator text not null, content_ref text, cache_key text, installed_revision text,
        layout_signature text not null, metadata_json text not null default '{}',
        created_at text not null, updated_at text not null);
      insert into sources values ('src-1', 'local', '/x', '/x', 'x', '{}', 't', 't');
      insert into installs (id, name, source_id, adapter, scope, scope_root, target_path,
        link_target, source_relative_path, source_root_relative_path, content_kind,
        content_locator, layout_signature, created_at, updated_at)
        values ('inst-1', 'skill-b', 'src-1', 'generic', 'project', '/p', '/p/t', '/l',
        'skills/skill-b', 'skills', 'local', '/x', 'sig', 't', 't');
    `);
    legacy.close();

    const db = new AgentPmDatabase(dbPath);
    try {
      db.deleteSource('src-1');
      expect(db.getSource('src-1')).toBeNull();
      expect(db.getInstall('inst-1')?.sourceId).toBe('src-1');
    } finally {
      db.close();
    }
  });
});
