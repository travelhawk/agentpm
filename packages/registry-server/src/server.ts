import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  AgentPmError,
  validateSkillArchive,
  type RegistryIndexEntry,
  type SkillArchive,
} from '@agentpm/shared';

import {
  generatePassword,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from './auth';
import {
  RegistryServerDatabase,
  type RegistryRole,
  type RegistrySkill,
  type RegistryUser,
  type SkillVisibility,
} from './db';
import { WEB_UI_HTML } from './web-ui';

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

export interface RegistryServerOptions {
  dataDir: string;
  host?: string | undefined;
  port?: number | undefined;
  /** When false, even public skills require an authenticated token. Default true. */
  publicRead?: boolean | undefined;
  maxArchiveBytes?: number | undefined;
}

export interface BootstrapCredentials {
  username: string;
  password: string;
  token: string;
}

export interface RegistryServerHandle {
  server: http.Server;
  db: RegistryServerDatabase;
  bootstrap: BootstrapCredentials | null;
  url: string;
  close(): Promise<void>;
}

interface AuthContext {
  user: RegistryUser;
  tokenId: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new HttpError(413, `Request body exceeds ${maxBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req, maxBytes);
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'Request body must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function skillSummary(
  db: RegistryServerDatabase,
  skill: RegistrySkill,
): Record<string, unknown> {
  const versions = db.listSkillVersions(skill.id);
  const owner = db.getUserById(skill.ownerId);
  return {
    name: skill.name,
    kind: skill.kind,
    target: skill.target,
    description: skill.description,
    tags: skill.tags,
    visibility: skill.visibility,
    owner: owner?.username ?? null,
    downloads: skill.downloads,
    latestVersion: versions[0]?.version ?? null,
    versionCount: versions.length,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

export function createRegistryServer(options: RegistryServerOptions): RegistryServerHandle {
  const dataDir = path.resolve(options.dataDir);
  const archivesDir = path.join(dataDir, 'archives');
  const publicRead = options.publicRead !== false;
  const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const db = new RegistryServerDatabase(path.join(dataDir, 'registry.sqlite'));

  let bootstrap: BootstrapCredentials | null = null;
  if (db.countUsers() === 0) {
    const password = generatePassword();
    const admin = db.createUser('admin', hashPassword(password), 'admin');
    const token = generateToken();
    db.createToken(admin.id, hashToken(token), 'bootstrap');
    bootstrap = { username: admin.username, password, token };
  }

  function authenticate(req: http.IncomingMessage): AuthContext | null {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      return null;
    }
    const token = header.slice('bearer '.length).trim();
    if (!token) {
      return null;
    }
    const record = db.getTokenByHash(hashToken(token));
    if (!record) {
      return null;
    }
    const user = db.getUserById(record.userId);
    if (!user || !user.active) {
      return null;
    }
    db.touchToken(record.id);
    return { user, tokenId: record.id };
  }

  function requireAuth(auth: AuthContext | null): AuthContext {
    if (!auth) {
      throw new HttpError(401, 'Authentication required. Pass an API token as a Bearer token.');
    }
    return auth;
  }

  function requireRole(auth: AuthContext | null, roles: RegistryRole[]): AuthContext {
    const context = requireAuth(auth);
    if (!roles.includes(context.user.role)) {
      throw new HttpError(403, `Requires one of these roles: ${roles.join(', ')}.`);
    }
    return context;
  }

  function canReadSkill(skill: RegistrySkill, auth: AuthContext | null): boolean {
    if (skill.visibility === 'public') {
      return publicRead || auth !== null;
    }
    return auth !== null;
  }

  function canManageSkill(skill: RegistrySkill, auth: AuthContext): boolean {
    return auth.user.role === 'admin' || skill.ownerId === auth.user.id;
  }

  function visibleSkills(auth: AuthContext | null): RegistrySkill[] {
    return db.listSkills().filter((skill) => canReadSkill(skill, auth));
  }

  async function readArchiveFromDisk(archivePath: string): Promise<SkillArchive> {
    const raw = await fs.readFile(archivePath, 'utf8');
    return validateSkillArchive(JSON.parse(raw));
  }

  function findReadme(archive: SkillArchive): string | null {
    const preferred = ['SKILL.md', 'README.md', 'readme.md', 'AGENT.md'];
    for (const name of preferred) {
      const file = archive.files.find((candidate) => candidate.path === name);
      if (file && file.encoding === 'utf8') {
        return file.content;
      }
    }
    const fallback = archive.files.find(
      (candidate) => candidate.encoding === 'utf8' && candidate.path.toLowerCase().endsWith('.md'),
    );
    return fallback ? fallback.content : null;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const auth = authenticate(req);

    if (method === 'GET' && (pathname === '/' || pathname === '/ui')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(WEB_UI_HTML);
      return;
    }

    if (method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && (pathname === '/index.json' || pathname === '/v1/index.json')) {
      const entries: RegistryIndexEntry[] = [];
      for (const skill of visibleSkills(auth)) {
        const versions = db.listSkillVersions(skill.id);
        const latest = versions[0];
        if (!latest) {
          continue;
        }
        entries.push({
          name: skill.name,
          description: skill.description ?? undefined,
          archive: `v1/skills/${encodeURIComponent(skill.name)}/versions/${encodeURIComponent(latest.version)}/archive`,
          version: latest.version,
          kind: skill.kind as RegistryIndexEntry['kind'],
          target: (skill.target ?? undefined) as RegistryIndexEntry['target'],
          tags: skill.tags,
        });
      }
      sendJson(res, 200, { version: 1, entries });
      return;
    }

    if (method === 'POST' && pathname === '/v1/auth/login') {
      const body = await readJsonBody(req, 1024 * 64);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const user = username ? db.getUserByUsername(username) : null;
      if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
        throw new HttpError(401, 'Invalid username or password.');
      }
      const token = generateToken();
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'login';
      const record = db.createToken(user.id, hashToken(token), label);
      sendJson(res, 200, {
        token,
        tokenId: record.id,
        user: { username: user.username, role: user.role },
      });
      return;
    }

    if (method === 'GET' && pathname === '/v1/whoami') {
      const context = requireAuth(auth);
      sendJson(res, 200, {
        username: context.user.username,
        role: context.user.role,
      });
      return;
    }

    if (method === 'GET' && pathname === '/v1/stats') {
      const skills = visibleSkills(auth);
      sendJson(res, 200, {
        skills: skills.length,
        downloads: skills.reduce((sum, skill) => sum + skill.downloads, 0),
        users: auth?.user.role === 'admin' ? db.listUsers().length : undefined,
        publicRead,
      });
      return;
    }

    if (method === 'GET' && pathname === '/v1/skills') {
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      const skills = visibleSkills(auth).filter((skill) => {
        if (!query) {
          return true;
        }
        return (
          skill.name.toLowerCase().includes(query) ||
          (skill.description ?? '').toLowerCase().includes(query) ||
          skill.tags.some((tag) => tag.toLowerCase().includes(query))
        );
      });
      sendJson(res, 200, {
        skills: skills.map((skill) => skillSummary(db, skill)),
      });
      return;
    }

    const skillMatch = pathname.match(/^\/v1\/skills\/([^/]+)$/);
    if (skillMatch) {
      const name = decodeURIComponent(skillMatch[1]!);
      if (method === 'GET') {
        const skill = db.getSkillByName(name);
        if (!skill || !canReadSkill(skill, auth)) {
          throw new HttpError(404, `Skill not found: ${name}`);
        }
        const versions = db.listSkillVersions(skill.id);
        let readme: string | null = null;
        if (versions[0]) {
          try {
            readme = findReadme(await readArchiveFromDisk(versions[0].archivePath));
          } catch {
            readme = null;
          }
        }
        sendJson(res, 200, {
          ...skillSummary(db, skill),
          readme,
          versions: versions.map((version) => ({
            version: version.version,
            checksum: version.checksum,
            sizeBytes: version.sizeBytes,
            publishedAt: version.publishedAt,
            publishedBy: db.getUserById(version.publishedBy)?.username ?? null,
          })),
        });
        return;
      }

      if (method === 'PUT') {
        const context = requireRole(auth, ['admin', 'publisher']);
        const body = await readJsonBody(req, maxArchiveBytes);
        let archive: SkillArchive;
        try {
          archive = validateSkillArchive(body.archive);
        } catch (error) {
          throw new HttpError(
            400,
            error instanceof AgentPmError ? error.message : 'Invalid skill archive.',
          );
        }
        if (archive.name !== name) {
          throw new HttpError(400, `Archive name "${archive.name}" does not match URL name "${name}".`);
        }
        if (!NAME_PATTERN.test(name)) {
          throw new HttpError(400, `Invalid skill name: ${name}`);
        }
        const requestedVisibility = body.visibility;
        if (
          requestedVisibility !== undefined &&
          requestedVisibility !== 'public' &&
          requestedVisibility !== 'private'
        ) {
          throw new HttpError(400, 'visibility must be "public" or "private".');
        }

        const existing = db.getSkillByName(name);
        if (existing && !canManageSkill(existing, context)) {
          throw new HttpError(403, `Skill "${name}" is owned by another user.`);
        }
        if (existing && db.getSkillVersion(existing.id, archive.version)) {
          throw new HttpError(
            409,
            `Version ${archive.version} of "${name}" already exists. Bump the version to publish again.`,
          );
        }

        const skill = existing
          ? db.updateSkillMetadata(existing.id, {
              description: archive.description ?? existing.description,
              tags: archive.tags ?? existing.tags,
              visibility: (requestedVisibility) ?? existing.visibility,
            })!
          : db.upsertSkill({
              name,
              kind: archive.kind,
              target: archive.target ?? null,
              description: archive.description ?? null,
              tags: archive.tags ?? [],
              visibility: (requestedVisibility) ?? 'public',
              ownerId: context.user.id,
            });

        const serialized = JSON.stringify(archive);
        const checksum = createHash('sha256').update(serialized).digest('hex');
        const archiveDir = path.join(archivesDir, skill.name);
        await fs.mkdir(archiveDir, { recursive: true });
        const archivePath = path.join(archiveDir, `${archive.version}.json`);
        await fs.writeFile(archivePath, serialized, 'utf8');

        const version = db.addSkillVersion({
          skillId: skill.id,
          version: archive.version,
          checksum,
          archivePath,
          sizeBytes: Buffer.byteLength(serialized),
          publishedBy: context.user.id,
        });

        sendJson(res, 201, {
          name: skill.name,
          version: version.version,
          checksum: version.checksum,
          visibility: skill.visibility,
        });
        return;
      }

      if (method === 'PATCH') {
        const context = requireAuth(auth);
        const skill = db.getSkillByName(name);
        if (!skill || !canReadSkill(skill, auth)) {
          throw new HttpError(404, `Skill not found: ${name}`);
        }
        if (!canManageSkill(skill, context)) {
          throw new HttpError(403, `Skill "${name}" is owned by another user.`);
        }
        const body = await readJsonBody(req, 1024 * 256);
        const updates: {
          description?: string | null;
          tags?: string[];
          visibility?: SkillVisibility;
          ownerId?: string;
        } = {};
        if (body.description !== undefined) {
          if (body.description !== null && typeof body.description !== 'string') {
            throw new HttpError(400, 'description must be a string or null.');
          }
          updates.description = body.description;
        }
        if (body.tags !== undefined) {
          if (
            !Array.isArray(body.tags) ||
            body.tags.some((tag) => typeof tag !== 'string')
          ) {
            throw new HttpError(400, 'tags must be an array of strings.');
          }
          updates.tags = body.tags as string[];
        }
        if (body.visibility !== undefined) {
          if (body.visibility !== 'public' && body.visibility !== 'private') {
            throw new HttpError(400, 'visibility must be "public" or "private".');
          }
          updates.visibility = body.visibility;
        }
        if (body.owner !== undefined) {
          if (context.user.role !== 'admin') {
            throw new HttpError(403, 'Only admins can transfer skill ownership.');
          }
          if (typeof body.owner !== 'string') {
            throw new HttpError(400, 'owner must be a username string.');
          }
          const owner = db.getUserByUsername(body.owner);
          if (!owner) {
            throw new HttpError(400, `Unknown user: ${body.owner}`);
          }
          updates.ownerId = owner.id;
        }
        const updated = db.updateSkillMetadata(skill.id, updates)!;
        sendJson(res, 200, skillSummary(db, updated));
        return;
      }

      if (method === 'DELETE') {
        const context = requireAuth(auth);
        const skill = db.getSkillByName(name);
        if (!skill || !canReadSkill(skill, auth)) {
          throw new HttpError(404, `Skill not found: ${name}`);
        }
        if (!canManageSkill(skill, context)) {
          throw new HttpError(403, `Skill "${name}" is owned by another user.`);
        }
        db.deleteSkill(skill.id);
        await fs.rm(path.join(archivesDir, skill.name), { recursive: true, force: true });
        sendJson(res, 200, { deleted: skill.name });
        return;
      }
    }

    const versionMatch = pathname.match(/^\/v1\/skills\/([^/]+)\/versions\/([^/]+)\/archive$/);
    if (versionMatch && method === 'GET') {
      const name = decodeURIComponent(versionMatch[1]!);
      const versionName = decodeURIComponent(versionMatch[2]!);
      const skill = db.getSkillByName(name);
      if (!skill || !canReadSkill(skill, auth)) {
        throw new HttpError(404, `Skill not found: ${name}`);
      }
      const version =
        versionName === 'latest'
          ? db.listSkillVersions(skill.id)[0]
          : db.getSkillVersion(skill.id, versionName);
      if (!version) {
        throw new HttpError(404, `Version not found: ${name}@${versionName}`);
      }
      const archive = await readArchiveFromDisk(version.archivePath);
      db.incrementDownloads(skill.id);
      sendJson(res, 200, archive);
      return;
    }

    const versionDeleteMatch = pathname.match(/^\/v1\/skills\/([^/]+)\/versions\/([^/]+)$/);
    if (versionDeleteMatch && method === 'DELETE') {
      const context = requireAuth(auth);
      const name = decodeURIComponent(versionDeleteMatch[1]!);
      const versionName = decodeURIComponent(versionDeleteMatch[2]!);
      const skill = db.getSkillByName(name);
      if (!skill || !canReadSkill(skill, auth)) {
        throw new HttpError(404, `Skill not found: ${name}`);
      }
      if (!canManageSkill(skill, context)) {
        throw new HttpError(403, `Skill "${name}" is owned by another user.`);
      }
      const version = db.getSkillVersion(skill.id, versionName);
      if (!version) {
        throw new HttpError(404, `Version not found: ${name}@${versionName}`);
      }
      db.deleteSkillVersion(version.id);
      await fs.rm(version.archivePath, { force: true });
      sendJson(res, 200, { deleted: `${name}@${versionName}` });
      return;
    }

    if (pathname === '/v1/users' && method === 'GET') {
      requireRole(auth, ['admin']);
      sendJson(res, 200, {
        users: db.listUsers().map((user) => ({
          username: user.username,
          role: user.role,
          active: user.active,
          createdAt: user.createdAt,
        })),
      });
      return;
    }

    if (pathname === '/v1/users' && method === 'POST') {
      requireRole(auth, ['admin']);
      const body = await readJsonBody(req, 1024 * 64);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      if (!USERNAME_PATTERN.test(username)) {
        throw new HttpError(400, 'Invalid username.');
      }
      if (db.getUserByUsername(username)) {
        throw new HttpError(409, `User already exists: ${username}`);
      }
      const role = body.role ?? 'publisher';
      if (role !== 'admin' && role !== 'publisher' && role !== 'reader') {
        throw new HttpError(400, 'role must be admin, publisher, or reader.');
      }
      const password =
        typeof body.password === 'string' && body.password ? body.password : generatePassword();
      const user = db.createUser(username, hashPassword(password), role);
      sendJson(res, 201, {
        username: user.username,
        role: user.role,
        password: typeof body.password === 'string' && body.password ? undefined : password,
      });
      return;
    }

    const userMatch = pathname.match(/^\/v1\/users\/([^/]+)$/);
    if (userMatch && method === 'PATCH') {
      const context = requireRole(auth, ['admin']);
      const username = decodeURIComponent(userMatch[1]!);
      const user = db.getUserByUsername(username);
      if (!user) {
        throw new HttpError(404, `User not found: ${username}`);
      }
      const body = await readJsonBody(req, 1024 * 64);
      const updates: { role?: RegistryRole; active?: boolean; passwordHash?: string } = {};
      if (body.role !== undefined) {
        if (body.role !== 'admin' && body.role !== 'publisher' && body.role !== 'reader') {
          throw new HttpError(400, 'role must be admin, publisher, or reader.');
        }
        updates.role = body.role;
      }
      if (body.active !== undefined) {
        if (typeof body.active !== 'boolean') {
          throw new HttpError(400, 'active must be a boolean.');
        }
        if (user.id === context.user.id && body.active === false) {
          throw new HttpError(400, 'You cannot deactivate your own account.');
        }
        updates.active = body.active;
      }
      if (body.password !== undefined) {
        if (typeof body.password !== 'string' || body.password.length < 8) {
          throw new HttpError(400, 'password must be a string with at least 8 characters.');
        }
        updates.passwordHash = hashPassword(body.password);
      }
      const updated = db.updateUser(user.id, updates)!;
      sendJson(res, 200, {
        username: updated.username,
        role: updated.role,
        active: updated.active,
      });
      return;
    }

    if (pathname === '/v1/tokens' && method === 'POST') {
      const context = requireAuth(auth);
      const body = await readJsonBody(req, 1024 * 64);
      const label =
        typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'api-token';
      const token = generateToken();
      const record = db.createToken(context.user.id, hashToken(token), label);
      sendJson(res, 201, { token, tokenId: record.id, label: record.label });
      return;
    }

    if (pathname === '/v1/tokens' && method === 'GET') {
      const context = requireAuth(auth);
      const all = url.searchParams.get('all') === '1' && context.user.role === 'admin';
      const tokens = db.listTokens(all ? undefined : context.user.id);
      sendJson(res, 200, {
        tokens: tokens
          .filter((token) => !token.revoked)
          .map((token) => ({
            id: token.id,
            label: token.label,
            user: db.getUserById(token.userId)?.username ?? null,
            createdAt: token.createdAt,
            lastUsedAt: token.lastUsedAt,
          })),
      });
      return;
    }

    const tokenMatch = pathname.match(/^\/v1\/tokens\/([^/]+)$/);
    if (tokenMatch && method === 'DELETE') {
      const context = requireAuth(auth);
      const id = decodeURIComponent(tokenMatch[1]!);
      const token = db.getTokenById(id);
      if (!token) {
        throw new HttpError(404, 'Token not found.');
      }
      if (token.userId !== context.user.id && context.user.role !== 'admin') {
        throw new HttpError(403, 'You can only revoke your own tokens.');
      }
      db.revokeToken(id);
      sendJson(res, 200, { revoked: id });
      return;
    }

    throw new HttpError(404, `No route for ${method} ${pathname}`);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: `Internal registry error: ${message}` });
    });
  });

  const handleRef: RegistryServerHandle = {
    server,
    db,
    bootstrap,
    url: '',
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          db.close();
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
  return handleRef;
}

export async function startRegistryServer(
  options: RegistryServerOptions,
): Promise<RegistryServerHandle> {
  const handle = createRegistryServer(options);
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 7420;
  await new Promise<void>((resolve, reject) => {
    handle.server.once('error', reject);
    handle.server.listen(port, host, () => resolve());
  });
  const address = handle.server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  handle.url = `http://${displayHost}:${actualPort}`;
  return handle;
}
