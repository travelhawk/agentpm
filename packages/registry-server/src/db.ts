import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

export type RegistryRole = 'admin' | 'publisher' | 'reader';
export type SkillVisibility = 'public' | 'private';

export interface RegistryUser {
  id: string;
  username: string;
  passwordHash: string;
  role: RegistryRole;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RegistryToken {
  id: string;
  userId: string;
  tokenHash: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export interface RegistrySkill {
  id: string;
  name: string;
  kind: string;
  target: string | null;
  description: string | null;
  tags: string[];
  visibility: SkillVisibility;
  ownerId: string;
  downloads: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegistrySkillVersion {
  id: string;
  skillId: string;
  version: string;
  checksum: string;
  archivePath: string;
  sizeBytes: number;
  publishedBy: string;
  publishedAt: string;
}

function now(): string {
  return new Date().toISOString();
}

function mapUser(row: Record<string, unknown>): RegistryUser {
  return {
    id: row.id as string,
    username: row.username as string,
    passwordHash: row.password_hash as string,
    role: row.role as RegistryRole,
    active: Boolean(row.active),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapToken(row: Record<string, unknown>): RegistryToken {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    tokenHash: row.token_hash as string,
    label: row.label as string,
    createdAt: row.created_at as string,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
    revoked: Boolean(row.revoked),
  };
}

function mapSkill(row: Record<string, unknown>): RegistrySkill {
  return {
    id: row.id as string,
    name: row.name as string,
    kind: row.kind as string,
    target: (row.target as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    tags: JSON.parse((row.tags_json as string | null) ?? '[]') as string[],
    visibility: row.visibility as SkillVisibility,
    ownerId: row.owner_id as string,
    downloads: Number(row.downloads ?? 0),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function mapVersion(row: Record<string, unknown>): RegistrySkillVersion {
  return {
    id: row.id as string,
    skillId: row.skill_id as string,
    version: row.version as string,
    checksum: row.checksum as string,
    archivePath: row.archive_path as string,
    sizeBytes: Number(row.size_bytes ?? 0),
    publishedBy: row.published_by as string,
    publishedAt: row.published_at as string,
  };
}

export class RegistryServerDatabase {
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
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        target TEXT,
        description TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        visibility TEXT NOT NULL DEFAULT 'public',
        owner_id TEXT NOT NULL REFERENCES users(id),
        downloads INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        checksum TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        published_by TEXT NOT NULL REFERENCES users(id),
        published_at TEXT NOT NULL,
        UNIQUE(skill_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
      CREATE INDEX IF NOT EXISTS idx_versions_skill ON skill_versions(skill_id);
    `);
  }

  countUsers(): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM users')
      .get() as Record<string, unknown>;
    return Number(row.count ?? 0);
  }

  createUser(username: string, passwordHash: string, role: RegistryRole): RegistryUser {
    const timestamp = now();
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, username, passwordHash, role, timestamp, timestamp);
    return this.getUserById(id)!;
  }

  getUserById(id: string): RegistryUser | null {
    const row = this.database.prepare('SELECT * FROM users WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapUser(row) : null;
  }

  getUserByUsername(username: string): RegistryUser | null {
    const row = this.database
      .prepare('SELECT * FROM users WHERE username = ?')
      .get(username) as Record<string, unknown> | undefined;
    return row ? mapUser(row) : null;
  }

  listUsers(): RegistryUser[] {
    const rows = this.database
      .prepare('SELECT * FROM users ORDER BY username')
      .all() as Record<string, unknown>[];
    return rows.map(mapUser);
  }

  updateUser(
    id: string,
    updates: { role?: RegistryRole; active?: boolean; passwordHash?: string },
  ): RegistryUser | null {
    const user = this.getUserById(id);
    if (!user) {
      return null;
    }
    this.database
      .prepare('UPDATE users SET role = ?, active = ?, password_hash = ?, updated_at = ? WHERE id = ?')
      .run(
        updates.role ?? user.role,
        (updates.active ?? user.active) ? 1 : 0,
        updates.passwordHash ?? user.passwordHash,
        now(),
        id,
      );
    return this.getUserById(id);
  }

  createToken(userId: string, tokenHash: string, label: string): RegistryToken {
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO tokens (id, user_id, token_hash, label, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, userId, tokenHash, label, now());
    const row = this.database.prepare('SELECT * FROM tokens WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return mapToken(row);
  }

  getTokenByHash(tokenHash: string): RegistryToken | null {
    const row = this.database
      .prepare('SELECT * FROM tokens WHERE token_hash = ? AND revoked = 0')
      .get(tokenHash) as Record<string, unknown> | undefined;
    return row ? mapToken(row) : null;
  }

  touchToken(id: string): void {
    this.database.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(now(), id);
  }

  listTokens(userId?: string): RegistryToken[] {
    const rows = (
      userId
        ? this.database
            .prepare('SELECT * FROM tokens WHERE user_id = ? ORDER BY created_at DESC')
            .all(userId)
        : this.database.prepare('SELECT * FROM tokens ORDER BY created_at DESC').all()
    ) as Record<string, unknown>[];
    return rows.map(mapToken);
  }

  getTokenById(id: string): RegistryToken | null {
    const row = this.database.prepare('SELECT * FROM tokens WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? mapToken(row) : null;
  }

  revokeToken(id: string): void {
    this.database.prepare('UPDATE tokens SET revoked = 1 WHERE id = ?').run(id);
  }

  upsertSkill(input: {
    name: string;
    kind: string;
    target: string | null;
    description: string | null;
    tags: string[];
    visibility: SkillVisibility;
    ownerId: string;
  }): RegistrySkill {
    const existing = this.getSkillByName(input.name);
    const timestamp = now();
    if (existing) {
      this.database
        .prepare(
          `UPDATE skills SET kind = ?, target = ?, description = ?, tags_json = ?, visibility = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.kind,
          input.target,
          input.description,
          JSON.stringify(input.tags),
          input.visibility,
          timestamp,
          existing.id,
        );
      return this.getSkillByName(input.name)!;
    }
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO skills (id, name, kind, target, description, tags_json, visibility, owner_id, downloads, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.kind,
        input.target,
        input.description,
        JSON.stringify(input.tags),
        input.visibility,
        input.ownerId,
        timestamp,
        timestamp,
      );
    return this.getSkillByName(input.name)!;
  }

  updateSkillMetadata(
    id: string,
    updates: {
      description?: string | null;
      tags?: string[];
      visibility?: SkillVisibility;
      ownerId?: string;
    },
  ): RegistrySkill | null {
    const row = this.database.prepare('SELECT * FROM skills WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return null;
    }
    const skill = mapSkill(row);
    this.database
      .prepare(
        'UPDATE skills SET description = ?, tags_json = ?, visibility = ?, owner_id = ?, updated_at = ? WHERE id = ?',
      )
      .run(
        updates.description === undefined ? skill.description : updates.description,
        JSON.stringify(updates.tags ?? skill.tags),
        updates.visibility ?? skill.visibility,
        updates.ownerId ?? skill.ownerId,
        now(),
        id,
      );
    const updated = this.database.prepare('SELECT * FROM skills WHERE id = ?').get(id) as Record<
      string,
      unknown
    >;
    return mapSkill(updated);
  }

  getSkillByName(name: string): RegistrySkill | null {
    const row = this.database.prepare('SELECT * FROM skills WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined;
    return row ? mapSkill(row) : null;
  }

  listSkills(): RegistrySkill[] {
    const rows = this.database
      .prepare('SELECT * FROM skills ORDER BY name')
      .all() as Record<string, unknown>[];
    return rows.map(mapSkill);
  }

  deleteSkill(id: string): void {
    this.database.prepare('DELETE FROM skills WHERE id = ?').run(id);
  }

  incrementDownloads(id: string): void {
    this.database
      .prepare('UPDATE skills SET downloads = downloads + 1 WHERE id = ?')
      .run(id);
  }

  addSkillVersion(input: {
    skillId: string;
    version: string;
    checksum: string;
    archivePath: string;
    sizeBytes: number;
    publishedBy: string;
  }): RegistrySkillVersion {
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO skill_versions (id, skill_id, version, checksum, archive_path, size_bytes, published_by, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.skillId,
        input.version,
        input.checksum,
        input.archivePath,
        input.sizeBytes,
        input.publishedBy,
        now(),
      );
    const row = this.database
      .prepare('SELECT * FROM skill_versions WHERE id = ?')
      .get(id) as Record<string, unknown>;
    return mapVersion(row);
  }

  listSkillVersions(skillId: string): RegistrySkillVersion[] {
    const rows = this.database
      .prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY published_at DESC')
      .all(skillId) as Record<string, unknown>[];
    return rows.map(mapVersion);
  }

  getSkillVersion(skillId: string, version: string): RegistrySkillVersion | null {
    const row = this.database
      .prepare('SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?')
      .get(skillId, version) as Record<string, unknown> | undefined;
    return row ? mapVersion(row) : null;
  }

  deleteSkillVersion(id: string): void {
    this.database.prepare('DELETE FROM skill_versions WHERE id = ?').run(id);
  }
}
