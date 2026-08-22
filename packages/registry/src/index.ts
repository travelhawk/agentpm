import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { promises as fs } from 'node:fs';

import yaml from 'js-yaml';

import { pathExists, readTextFile } from '@agentpm/fs';
import {
  AgentPmError,
  validateSkillArchive,
  type RegistryIndexEntry,
  type RegistryIndexFile,
  type SkillArchive,
  isHttpUrl,
} from '@agentpm/shared';

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new AgentPmError('Registry entries must be objects.');
  }
  return value as Record<string, unknown>;
}

function coerceEntry(entry: Record<string, unknown>): RegistryIndexEntry {
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const adapterHint = coerceAdapterId(entry.adapterHint, 'adapterHint');
  const target = coerceAdapterId(entry.target, 'target');
  if (adapterHint && target && adapterHint !== target) {
    throw new AgentPmError(
      `Registry entry "${String(entry.name)}" has conflicting adapterHint and target values.`,
    );
  }

  if (typeof entry.name !== 'string') {
    throw new AgentPmError('Registry entries must include a string "name" field.');
  }
  const repo = typeof entry.repo === 'string' ? entry.repo : undefined;
  const archive = typeof entry.archive === 'string' ? entry.archive : undefined;
  if (!repo && !archive) {
    throw new AgentPmError(
      `Registry entry "${entry.name}" must include a "repo" or an "archive" field.`,
    );
  }

  const kind = entry.kind;
  if (
    kind !== undefined &&
    kind !== 'skill' &&
    kind !== 'agent' &&
    kind !== 'subagent' &&
    kind !== 'plugin'
  ) {
    throw new AgentPmError(
      `Registry entry "${entry.name}" kind must be skill, agent, subagent, or plugin.`,
    );
  }

  return {
    name: entry.name,
    description:
      typeof entry.description === 'string' ? entry.description : undefined,
    repo,
    archive,
    version: typeof entry.version === 'string' ? entry.version : undefined,
    kind,
    ref: typeof entry.ref === 'string' ? entry.ref : undefined,
    path: typeof entry.path === 'string' ? entry.path : undefined,
    adapterHint: adapterHint ?? target,
    target: target ?? adapterHint,
    tags,
  };
}

function coerceAdapterId(
  value: unknown,
  field: string,
): RegistryIndexEntry['adapterHint'] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === 'generic' || value === 'codex' || value === 'claude') {
    return value;
  }
  throw new AgentPmError(
    `Registry entry ${field} must be one of: codex, claude, generic.`,
  );
}

function parseRegistryContent(
  locator: string,
  content: string,
): RegistryIndexFile {
  const extension = (
    isHttpUrl(locator) ? path.extname(new URL(locator).pathname) : path.extname(locator)
  ).toLowerCase();
  const parsed: unknown =
    extension === '.json' ? JSON.parse(content) : yaml.load(content);

  if (Array.isArray(parsed)) {
    return {
      version: 1,
      entries: parsed.map((entry) => coerceEntry(toRecord(entry))),
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new AgentPmError('Registry index must be an object or array.');
  }

  const record = parsed as Record<string, unknown>;
  const entries = Array.isArray(record.entries) ? record.entries : [];
  return {
    version: typeof record.version === 'number' ? record.version : 1,
    entries: entries.map((entry) => coerceEntry(toRecord(entry))),
  };
}

function httpGet(
  url: string,
  headers?: Record<string, string>,
  redirects = 5,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'http:' ? http : https;
    const opts: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'agentpm', ...headers },
    };
    const req = client.get(opts, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        if (redirects <= 0) {
          reject(new AgentPmError(`Too many redirects fetching ${url}`));
          return;
        }
        const redirectUrl = new URL(res.headers.location, url).href;
        res.resume();
        resolve(httpGet(redirectUrl, headers, redirects - 1));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) {
          const hint =
            res.statusCode === 401 || res.statusCode === 403
              ? ' (authentication failed; run `agentpm registry login <url>` or set AGENTPM_REGISTRY_TOKEN)'
              : '';
          reject(
            new AgentPmError(`Failed to fetch ${url} (${res.statusCode})${hint}`),
          );
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function registryTokenEnvName(locator: string): string {
  const host = new URL(locator).hostname
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return `AGENTPM_REGISTRY_TOKEN_${host}`;
}

export interface RegistryCredentialsFile {
  version: number;
  registries: Record<string, { token: string; username?: string | undefined }>;
}

export function credentialsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.AGENTPM_HOME?.trim()
    ? path.resolve(env.AGENTPM_HOME)
    : path.join(os.homedir(), '.agentpm');
  return path.join(home, 'credentials.json');
}

export async function loadRegistryCredentials(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegistryCredentialsFile> {
  const filePath = credentialsFilePath(env);
  if (!(await pathExists(filePath))) {
    return { version: 1, registries: {} };
  }
  try {
    const parsed = JSON.parse(await readTextFile(filePath)) as RegistryCredentialsFile;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      registries:
        parsed.registries && typeof parsed.registries === 'object'
          ? parsed.registries
          : {},
    };
  } catch {
    return { version: 1, registries: {} };
  }
}

export function registryOrigin(locator: string): string {
  return new URL(locator).origin;
}

async function saveRegistryCredentials(
  credentials: RegistryCredentialsFile,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const filePath = credentialsFilePath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(credentials, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

export async function setRegistryCredential(
  urlOrOrigin: string,
  credential: { token: string; username?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const origin = registryOrigin(urlOrOrigin);
  const credentials = await loadRegistryCredentials(env);
  credentials.registries[origin] = credential;
  await saveRegistryCredentials(credentials, env);
  return origin;
}

export async function removeRegistryCredential(
  urlOrOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const origin = registryOrigin(urlOrOrigin);
  const credentials = await loadRegistryCredentials(env);
  if (!(origin in credentials.registries)) {
    return false;
  }
  delete credentials.registries[origin];
  await saveRegistryCredentials(credentials, env);
  return true;
}

export async function getRegistryToken(
  urlOrOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const hostToken = env[registryTokenEnvName(urlOrOrigin)];
  if (hostToken) {
    return hostToken;
  }
  if (env.AGENTPM_REGISTRY_TOKEN) {
    return env.AGENTPM_REGISTRY_TOKEN;
  }
  const credentials = await loadRegistryCredentials(env);
  return credentials.registries[registryOrigin(urlOrOrigin)]?.token;
}

async function getRegistryHeaders(
  locator: string,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string> | undefined> {
  const hostToken = env[registryTokenEnvName(locator)];
  let token = hostToken || env.AGENTPM_REGISTRY_TOKEN;
  if (!token) {
    const credentials = await loadRegistryCredentials(env);
    token = credentials.registries[registryOrigin(locator)]?.token;
  }
  if (!token) {
    return undefined;
  }
  return { Authorization: `Bearer ${token}` };
}

export async function loadRegistryIndex(
  locator: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegistryIndexFile> {
  const content = await readRegistryLocator(locator, env);
  return parseRegistryContent(locator, content);
}

export async function readRegistryLocator(
  locator: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (isHttpUrl(locator)) {
    return httpGet(locator, await getRegistryHeaders(locator, env));
  }

  const absolutePath = path.resolve(locator);
  if (!(await pathExists(absolutePath))) {
    throw new AgentPmError(`Registry index not found: ${absolutePath}`);
  }
  return readTextFile(absolutePath);
}

export async function fetchSkillArchive(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ archive: SkillArchive; raw: string }> {
  let raw: string;
  if (isHttpUrl(url)) {
    raw = await httpGet(url, await getRegistryHeaders(url, env));
  } else {
    const absolutePath = path.resolve(url);
    if (!(await pathExists(absolutePath))) {
      throw new AgentPmError(`Skill archive not found: ${absolutePath}`);
    }
    raw = await readTextFile(absolutePath);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentPmError(`Skill archive at ${url} is not valid JSON.`);
  }
  return { archive: validateSkillArchive(parsed), raw };
}

export interface RegistryApiRequest {
  method: string;
  url: string;
  token?: string | undefined;
  body?: unknown;
}

export async function registryApiRequest(
  request: RegistryApiRequest,
): Promise<Record<string, unknown>> {
  const parsed = new URL(request.url);
  const client = parsed.protocol === 'http:' ? http : https;
  const payload =
    request.body === undefined ? undefined : JSON.stringify(request.body);
  const headers: Record<string, string> = {
    'User-Agent': 'agentpm',
    Accept: 'application/json',
  };
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(payload));
  }
  if (request.token) {
    headers.Authorization = `Bearer ${request.token}`;
  }

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        method: request.method,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: Record<string, unknown> = {};
          if (text.trim()) {
            try {
              data = JSON.parse(text) as Record<string, unknown>;
            } catch {
              data = { raw: text };
            }
          }
          if (!res.statusCode || res.statusCode >= 400) {
            const message =
              typeof data.error === 'string'
                ? data.error
                : `Registry request failed (${res.statusCode ?? 'no status'})`;
            reject(new AgentPmError(`${message} [${request.method} ${request.url}]`));
            return;
          }
          resolve(data);
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}
