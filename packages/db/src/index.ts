import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import type {
  CacheRepoRecord,
  CatalogEntryRecord,
  InstallRecord,
  SearchResult,
  SourceRecord,
} from '@agentpm/shared';

type JsonRecord = Record<string, unknown>;

function encodeJson(value: JsonRecord | string[]): string {
  return JSON.stringify(value);
}

function decodeObject(value: string | null): JsonRecord {
  if (!value) {
    return {};
  }
  return JSON.parse(value) as JsonRecord;
}

function decodeArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return JSON.parse(value) as string[];
}

function mapSource(row: Record<string, unknown>): SourceRecord {
  return {
    id: row.id as string,
    kind: row.kind as SourceRecord['kind'],
    locator: row.locator as string,
    normalizedLocator: row.normalized_locator as string,
    displayName: row.display_name as string,
    metadata: decodeObject(row.metadata_json as string | null),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapCatalogEntry(row: Record<string, unknown>): CatalogEntryRecord {
  return {
    id: row.id as string,
    sourceId: row.source_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    repo: row.repo as string,
    ref: (row.ref as string | null) ?? null,
    path: (row.path as string | null) ?? null,
    adapterHint:
      (row.adapter_hint as CatalogEntryRecord['adapterHint']) ?? null,
    tags: decodeArray(row.tags_json as string | null),
    metadata: decodeObject(row.metadata_json as string | null),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapCacheRepo(row: Record<string, unknown>): CacheRepoRecord {
  return {
    cacheKey: row.cache_key as string,
    sourceId: (row.source_id as string | null) ?? null,
    locator: row.locator as string,
    kind: row.kind as CacheRepoRecord['kind'],
    basePath: row.base_path as string,
    currentRevision: (row.current_revision as string | null) ?? null,
    isGit: Boolean(row.is_git),
    layoutSignature: (row.layout_signature as string | null) ?? null,
    metadata: decodeObject(row.metadata_json as string | null),
    updatedAt: row.updated_at as string,
  };
}

function mapInstall(row: Record<string, unknown>): InstallRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    sourceId: row.source_id as string,
    catalogEntryId: (row.catalog_entry_id as string | null) ?? null,
    adapter: row.adapter as InstallRecord['adapter'],
    scope: row.scope as InstallRecord['scope'],
    scopeRoot: row.scope_root as string,
    targetPath: row.target_path as string,
    linkTarget: row.link_target as string,
    sourceRelativePath: row.source_relative_path as string,
    sourceRootRelativePath: row.source_root_relative_path as string,
    selectedItems: decodeArray(row.selected_items_json as string | null),
    contentKind: row.content_kind as InstallRecord['contentKind'],
    contentLocator: row.content_locator as string,
    contentRef: (row.content_ref as string | null) ?? null,
    cacheKey: (row.cache_key as string | null) ?? null,
    installedRevision: (row.installed_revision as string | null) ?? null,
    layoutSignature: row.layout_signature as string,
    metadata: decodeObject(row.metadata_json as string | null),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

const INSTALL_COLUMNS = `id, name, source_id, catalog_entry_id, adapter, scope, scope_root, target_path,
  link_target, source_relative_path, source_root_relative_path, selected_items_json, content_kind,
  content_locator, content_ref, cache_key, installed_revision, layout_signature, metadata_json,
  created_at, updated_at`;

// installs.source_id has no foreign key on purpose: an install keeps its own
// content locator, so it can outlive a removed source. Source ids are
// deterministic, so re-adding the same source links the install again.
function installsTableSql(tableName: string): string {
  return `
    create table if not exists ${tableName} (
      id text primary key,
      name text not null,
      source_id text not null,
      catalog_entry_id text references catalog_entries(id) on delete set null,
      adapter text not null,
      scope text not null,
      scope_root text not null,
      target_path text not null unique,
      link_target text not null,
      source_relative_path text not null,
      source_root_relative_path text not null,
      selected_items_json text not null default '[]',
      content_kind text not null,
      content_locator text not null,
      content_ref text,
      cache_key text,
      installed_revision text,
      layout_signature text not null,
      metadata_json text not null default '{}',
      created_at text not null,
      updated_at text not null
    );
  `;
}

const INSTALLS_INDEXES_SQL = `
  create index if not exists installs_name_idx on installs(name);
  create index if not exists installs_source_id_idx on installs(source_id);
  create index if not exists installs_cache_key_idx on installs(cache_key);
`;

export class AgentPmDatabase {
  private readonly database: DatabaseSync;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.database = new DatabaseSync(filePath);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    this.database.exec(`
      create table if not exists sources (
        id text primary key,
        kind text not null,
        locator text not null,
        normalized_locator text not null unique,
        display_name text not null,
        metadata_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists catalog_entries (
        id text primary key,
        source_id text not null references sources(id) on delete cascade,
        name text not null,
        description text,
        repo text not null,
        ref text,
        path text,
        adapter_hint text,
        tags_json text not null default '[]',
        metadata_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );
      create index if not exists catalog_entries_source_id_idx on catalog_entries(source_id);
      create index if not exists catalog_entries_name_idx on catalog_entries(name);

      create table if not exists cache_repos (
        cache_key text primary key,
        source_id text references sources(id) on delete set null,
        locator text not null,
        kind text not null,
        base_path text not null,
        current_revision text,
        is_git integer not null,
        layout_signature text,
        metadata_json text not null default '{}',
        updated_at text not null
      );

      ${installsTableSql('installs')}
      ${INSTALLS_INDEXES_SQL}
    `);
    this.dropInstallSourceForeignKey();
  }

  // Databases created before installs could outlive their source still carry
  // an `on delete restrict` key on installs.source_id. SQLite cannot drop a
  // foreign key in place, so rebuild the table once without it.
  private dropInstallSourceForeignKey(): void {
    const foreignKeys = this.database
      .prepare('PRAGMA foreign_key_list(installs)')
      .all() as Array<{ from: string }>;
    if (!foreignKeys.some((key) => key.from === 'source_id')) {
      return;
    }

    this.database.exec('PRAGMA foreign_keys = OFF');
    this.database.exec('BEGIN');
    try {
      this.database.exec(`
        ${installsTableSql('installs_next')}
        insert into installs_next (${INSTALL_COLUMNS})
          select ${INSTALL_COLUMNS} from installs;
        drop table installs;
        alter table installs_next rename to installs;
        ${INSTALLS_INDEXES_SQL}
      `);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    } finally {
      this.database.exec('PRAGMA foreign_keys = ON');
    }
  }

  upsertSource(source: SourceRecord): SourceRecord {
    const statement = this.database.prepare(`
      insert into sources (
        id, kind, locator, normalized_locator, display_name, metadata_json, created_at, updated_at
      ) values (
        @id, @kind, @locator, @normalizedLocator, @displayName, @metadataJson, @createdAt, @updatedAt
      )
      on conflict(normalized_locator) do update set
        kind = excluded.kind,
        locator = excluded.locator,
        display_name = excluded.display_name,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `);

    statement.run({
      id: source.id,
      kind: source.kind,
      locator: source.locator,
      normalizedLocator: source.normalizedLocator,
      displayName: source.displayName,
      metadataJson: encodeJson(source.metadata),
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    });

    const stored =
      this.getSource(source.id) ??
      this.getSourceByLocator(source.normalizedLocator);
    if (!stored) {
      throw new Error(`Failed to store source ${source.id}`);
    }
    return stored;
  }

  listSources(): SourceRecord[] {
    return this.database
      .prepare('select * from sources order by display_name asc')
      .all()
      .map((row) => mapSource(row));
  }

  getSource(id: string): SourceRecord | null {
    const row = this.database
      .prepare('select * from sources where id = ?')
      .get(id);
    return row ? mapSource(row) : null;
  }

  getSourceByLocator(locatorOrId: string): SourceRecord | null {
    const row = this.database
      .prepare(
        'select * from sources where id = ? or locator = ? or normalized_locator = ? limit 1',
      )
      .get(locatorOrId, locatorOrId, locatorOrId);
    return row ? mapSource(row) : null;
  }

  deleteSource(sourceId: string): void {
    this.database.prepare('delete from sources where id = ?').run(sourceId);
  }

  replaceCatalogEntries(sourceId: string, entries: CatalogEntryRecord[]): void {
    this.database.exec('BEGIN');
    try {
      this.database
        .prepare('delete from catalog_entries where source_id = ?')
        .run(sourceId);
      const statement = this.database.prepare(`
        insert into catalog_entries (
          id, source_id, name, description, repo, ref, path, adapter_hint, tags_json, metadata_json, created_at, updated_at
        ) values (
          @id, @sourceId, @name, @description, @repo, @ref, @path, @adapterHint, @tagsJson, @metadataJson, @createdAt, @updatedAt
        )
      `);

      for (const entry of entries) {
        statement.run({
          id: entry.id,
          sourceId: entry.sourceId,
          name: entry.name,
          description: entry.description,
          repo: entry.repo,
          ref: entry.ref,
          path: entry.path,
          adapterHint: entry.adapterHint,
          tagsJson: encodeJson(entry.tags),
          metadataJson: encodeJson(entry.metadata),
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        });
      }

      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listCatalogEntries(): CatalogEntryRecord[] {
    return this.database
      .prepare('select * from catalog_entries order by name asc')
      .all()
      .map((row) => mapCatalogEntry(row as Record<string, unknown>));
  }

  listCatalogEntriesBySource(sourceId: string): CatalogEntryRecord[] {
    return this.database
      .prepare(
        'select * from catalog_entries where source_id = ? order by name asc',
      )
      .all(sourceId)
      .map((row) => mapCatalogEntry(row as Record<string, unknown>));
  }

  findCatalogEntriesByName(name: string): CatalogEntryRecord[] {
    return this.database
      .prepare('select * from catalog_entries where name = ? order by name asc')
      .all(name)
      .map((row) => mapCatalogEntry(row as Record<string, unknown>));
  }

  searchCatalogEntries(query: string): CatalogEntryRecord[] {
    const likeQuery = `%${query.toLowerCase()}%`;
    return this.database
      .prepare(
        `
        select * from catalog_entries
        where lower(name) like ?
           or lower(coalesce(description, '')) like ?
           or lower(tags_json) like ?
        order by name asc
      `,
      )
      .all(likeQuery, likeQuery, likeQuery)
      .map((row) => mapCatalogEntry(row as Record<string, unknown>));
  }

  saveCacheRepo(cacheRepo: CacheRepoRecord): CacheRepoRecord {
    this.database
      .prepare(
        `
        insert into cache_repos (
          cache_key, source_id, locator, kind, base_path, current_revision, is_git, layout_signature, metadata_json, updated_at
        ) values (
          @cacheKey, @sourceId, @locator, @kind, @basePath, @currentRevision, @isGit, @layoutSignature, @metadataJson, @updatedAt
        )
        on conflict(cache_key) do update set
          source_id = excluded.source_id,
          locator = excluded.locator,
          kind = excluded.kind,
          base_path = excluded.base_path,
          current_revision = excluded.current_revision,
          is_git = excluded.is_git,
          layout_signature = excluded.layout_signature,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
      )
      .run({
        cacheKey: cacheRepo.cacheKey,
        sourceId: cacheRepo.sourceId,
        locator: cacheRepo.locator,
        kind: cacheRepo.kind,
        basePath: cacheRepo.basePath,
        currentRevision: cacheRepo.currentRevision,
        isGit: cacheRepo.isGit ? 1 : 0,
        layoutSignature: cacheRepo.layoutSignature,
        metadataJson: encodeJson(cacheRepo.metadata),
        updatedAt: cacheRepo.updatedAt,
      });

    const stored = this.getCacheRepo(cacheRepo.cacheKey);
    if (!stored) {
      throw new Error(`Failed to store cache repo ${cacheRepo.cacheKey}`);
    }
    return stored;
  }

  getCacheRepo(cacheKey: string): CacheRepoRecord | null {
    const row = this.database
      .prepare('select * from cache_repos where cache_key = ?')
      .get(cacheKey);
    return row ? mapCacheRepo(row) : null;
  }

  listCacheRepos(): CacheRepoRecord[] {
    return this.database
      .prepare('select * from cache_repos order by updated_at desc')
      .all()
      .map((row) => mapCacheRepo(row as Record<string, unknown>));
  }

  deleteCacheRepo(cacheKey: string): void {
    this.database
      .prepare('delete from cache_repos where cache_key = ?')
      .run(cacheKey);
  }

  saveInstall(install: InstallRecord): InstallRecord {
    this.database
      .prepare(
        `
        insert into installs (
          id, name, source_id, catalog_entry_id, adapter, scope, scope_root, target_path, link_target,
          source_relative_path, source_root_relative_path, selected_items_json, content_kind, content_locator,
          content_ref, cache_key, installed_revision, layout_signature, metadata_json, created_at, updated_at
        ) values (
          @id, @name, @sourceId, @catalogEntryId, @adapter, @scope, @scopeRoot, @targetPath, @linkTarget,
          @sourceRelativePath, @sourceRootRelativePath, @selectedItemsJson, @contentKind, @contentLocator,
          @contentRef, @cacheKey, @installedRevision, @layoutSignature, @metadataJson, @createdAt, @updatedAt
        )
        on conflict(id) do update set
          name = excluded.name,
          source_id = excluded.source_id,
          catalog_entry_id = excluded.catalog_entry_id,
          adapter = excluded.adapter,
          scope = excluded.scope,
          scope_root = excluded.scope_root,
          target_path = excluded.target_path,
          link_target = excluded.link_target,
          source_relative_path = excluded.source_relative_path,
          source_root_relative_path = excluded.source_root_relative_path,
          selected_items_json = excluded.selected_items_json,
          content_kind = excluded.content_kind,
          content_locator = excluded.content_locator,
          content_ref = excluded.content_ref,
          cache_key = excluded.cache_key,
          installed_revision = excluded.installed_revision,
          layout_signature = excluded.layout_signature,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at
      `,
      )
      .run({
        id: install.id,
        name: install.name,
        sourceId: install.sourceId,
        catalogEntryId: install.catalogEntryId,
        adapter: install.adapter,
        scope: install.scope,
        scopeRoot: install.scopeRoot,
        targetPath: install.targetPath,
        linkTarget: install.linkTarget,
        sourceRelativePath: install.sourceRelativePath,
        sourceRootRelativePath: install.sourceRootRelativePath,
        selectedItemsJson: encodeJson(install.selectedItems),
        contentKind: install.contentKind,
        contentLocator: install.contentLocator,
        contentRef: install.contentRef,
        cacheKey: install.cacheKey,
        installedRevision: install.installedRevision,
        layoutSignature: install.layoutSignature,
        metadataJson: encodeJson(install.metadata),
        createdAt: install.createdAt,
        updatedAt: install.updatedAt,
      });

    const stored = this.getInstall(install.id);
    if (!stored) {
      throw new Error(`Failed to store install ${install.id}`);
    }
    return stored;
  }

  getInstall(installId: string): InstallRecord | null {
    const row = this.database
      .prepare('select * from installs where id = ?')
      .get(installId);
    return row ? mapInstall(row) : null;
  }

  listInstalls(): InstallRecord[] {
    return this.database
      .prepare('select * from installs order by name asc')
      .all()
      .map((row) => mapInstall(row as Record<string, unknown>));
  }

  listInstallsByName(name: string): InstallRecord[] {
    return this.database
      .prepare('select * from installs where name = ? order by created_at asc')
      .all(name)
      .map((row) => mapInstall(row as Record<string, unknown>));
  }

  listInstallsBySource(sourceId: string): InstallRecord[] {
    return this.database
      .prepare('select * from installs where source_id = ? order by name asc')
      .all(sourceId)
      .map((row) => mapInstall(row as Record<string, unknown>));
  }

  removeInstall(installId: string): void {
    this.database.prepare('delete from installs where id = ?').run(installId);
  }

  countInstallsForSource(sourceId: string): number {
    const row = this.database
      .prepare('select count(*) as count from installs where source_id = ?')
      .get(sourceId) as {
      count: number;
    };
    return row.count;
  }

  countInstallsForCacheKey(cacheKey: string): number {
    const row = this.database
      .prepare('select count(*) as count from installs where cache_key = ?')
      .get(cacheKey) as {
      count: number;
    };
    return row.count;
  }

  searchInstalled(query: string): SearchResult[] {
    const likeQuery = `%${query.toLowerCase()}%`;
    return this.database
      .prepare(
        `
        select name, adapter, scope, source_id, content_locator
        from installs
        where lower(name) like ?
        order by name asc
      `,
      )
      .all(likeQuery)
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          kind: 'installed' as const,
          name: record.name as string,
          description: null,
          sourceId: record.source_id as string,
          adapter: (record.adapter as SearchResult['adapter']) ?? null,
          scope: (record.scope as SearchResult['scope']) ?? null,
          locator: (record.content_locator as string | null) ?? null,
        };
      });
  }
}
