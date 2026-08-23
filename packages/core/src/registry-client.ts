import path from 'node:path';

import { packDirectoryToArchive, pathExists, readTextFile } from '@agentpm/fs';
import {
  getRegistryToken,
  registryApiRequest,
  registryOrigin,
  removeRegistryCredential,
  setRegistryCredential,
} from '@agentpm/registry';
import {
  AgentPmError,
  type AdapterId,
  type EntryKind,
  type SkillArchive,
} from '@agentpm/shared';

export interface RegistryLoginOptions {
  url: string;
  username?: string | undefined;
  password?: string | undefined;
  token?: string | undefined;
  label?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface RegistryLoginResult {
  origin: string;
  username: string;
  role: string;
}

function normalizeRegistryUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(trimmed)) {
    throw new AgentPmError(
      `Registry URL must start with http:// or https://: ${url}`,
    );
  }
  return trimmed;
}

export async function registryLogin(
  options: RegistryLoginOptions,
): Promise<RegistryLoginResult> {
  const env = options.env ?? process.env;
  const base = normalizeRegistryUrl(options.url);

  let token = options.token;
  if (!token) {
    if (!options.username || !options.password) {
      throw new AgentPmError(
        'Registry login needs --token, or --username and --password.',
      );
    }
    const response = await registryApiRequest({
      method: 'POST',
      url: `${base}/v1/auth/login`,
      body: {
        username: options.username,
        password: options.password,
        label: options.label ?? 'agentpm-cli',
      },
    });
    if (typeof response.token !== 'string') {
      throw new AgentPmError('Registry login did not return a token.');
    }
    token = response.token;
  }

  const whoami = await registryApiRequest({
    method: 'GET',
    url: `${base}/v1/whoami`,
    token,
  });
  const username =
    typeof whoami.username === 'string' ? whoami.username : 'unknown';
  const role = typeof whoami.role === 'string' ? whoami.role : 'unknown';

  const origin = await setRegistryCredential(base, { token, username }, env);
  return { origin, username, role };
}

export async function registryLogout(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return removeRegistryCredential(normalizeRegistryUrl(url), env);
}

export async function registryWhoami(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RegistryLoginResult> {
  const base = normalizeRegistryUrl(url);
  const token = await getRegistryToken(base, env);
  if (!token) {
    throw new AgentPmError(
      `Not logged in to ${registryOrigin(base)}. Run \`agentpm registry login ${base}\` first.`,
    );
  }
  const whoami = await registryApiRequest({
    method: 'GET',
    url: `${base}/v1/whoami`,
    token,
  });
  return {
    origin: registryOrigin(base),
    username: typeof whoami.username === 'string' ? whoami.username : 'unknown',
    role: typeof whoami.role === 'string' ? whoami.role : 'unknown',
  };
}

export interface PublishSkillOptions {
  registryUrl: string;
  sourcePath: string;
  name?: string | undefined;
  version?: string | undefined;
  kind?: EntryKind | undefined;
  target?: AdapterId | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  visibility?: 'public' | 'private' | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface PublishSkillResult {
  name: string;
  version: string;
  checksum: string;
  visibility: string;
  registry: string;
}

function bumpPatch(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
  if (!match) {
    return `${version}.1`;
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

async function inferSkillMetadata(sourcePath: string): Promise<{
  kind: EntryKind;
  description: string | undefined;
}> {
  for (const manifestDir of ['.claude-plugin', '.codex-plugin']) {
    const manifestPath = path.join(sourcePath, manifestDir, 'plugin.json');
    if (!(await pathExists(manifestPath))) {
      continue;
    }
    try {
      const manifest = JSON.parse(await readTextFile(manifestPath)) as Record<
        string,
        unknown
      >;
      return {
        kind: 'plugin',
        description:
          typeof manifest.description === 'string'
            ? manifest.description
            : undefined,
      };
    } catch {
      return { kind: 'plugin', description: undefined };
    }
  }

  for (const candidate of ['SKILL.md', 'README.md']) {
    const markerPath = path.join(sourcePath, candidate);
    if (!(await pathExists(markerPath))) {
      continue;
    }
    const content = await readTextFile(markerPath);
    const frontmatter = content.match(
      /^---\r?\n[\s\S]*?^description:\s*(.+?)\s*$/m,
    );
    if (frontmatter?.[1]) {
      return {
        kind: 'skill',
        description: frontmatter[1].replace(/^['"]|['"]$/g, ''),
      };
    }
    const paragraph = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#') && !line.startsWith('---'));
    return { kind: 'skill', description: paragraph };
  }

  return { kind: 'skill', description: undefined };
}

export async function publishSkillToRegistry(
  options: PublishSkillOptions,
): Promise<PublishSkillResult> {
  const env = options.env ?? process.env;
  const base = normalizeRegistryUrl(options.registryUrl);
  const token = await getRegistryToken(base, env);
  if (!token) {
    throw new AgentPmError(
      `Not logged in to ${registryOrigin(base)}. Run \`agentpm registry login ${base}\` first.`,
    );
  }

  const sourcePath = path.resolve(options.sourcePath);
  if (!(await pathExists(sourcePath))) {
    throw new AgentPmError(`Publish source not found: ${sourcePath}`);
  }

  const name = options.name ?? path.basename(sourcePath);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new AgentPmError(
      `"${name}" is not a valid skill name. Pass --name to override.`,
    );
  }

  // Guard against publishing an unrelated folder by mistake: require a skill or
  // plugin marker unless the caller explicitly forces the kind.
  const hasSkillMarker = await pathExists(path.join(sourcePath, 'SKILL.md'));
  const hasPluginMarker =
    (await pathExists(path.join(sourcePath, '.claude-plugin', 'plugin.json'))) ||
    (await pathExists(path.join(sourcePath, '.codex-plugin', 'plugin.json')));
  if (!hasSkillMarker && !hasPluginMarker && !options.kind) {
    throw new AgentPmError(
      `${sourcePath} has no SKILL.md or plugin manifest (.claude-plugin/ or .codex-plugin/). Point at a skill or plugin folder, or pass an explicit --kind to publish it anyway.`,
    );
  }

  const inferred = await inferSkillMetadata(sourcePath);

  let version = options.version;
  if (!version) {
    try {
      const existing = await registryApiRequest({
        method: 'GET',
        url: `${base}/v1/skills/${encodeURIComponent(name)}`,
        token,
      });
      version =
        typeof existing.latestVersion === 'string'
          ? bumpPatch(existing.latestVersion)
          : '0.1.0';
    } catch {
      version = '0.1.0';
    }
  }

  const archive: SkillArchive = await packDirectoryToArchive(sourcePath, {
    name,
    version,
    kind: options.kind ?? inferred.kind,
    target: options.target,
    description: options.description ?? inferred.description,
    tags: options.tags,
  });

  const response = await registryApiRequest({
    method: 'PUT',
    url: `${base}/v1/skills/${encodeURIComponent(name)}`,
    token,
    body: {
      archive,
      ...(options.visibility ? { visibility: options.visibility } : {}),
    },
  });

  return {
    name,
    version:
      typeof response.version === 'string' ? response.version : version,
    checksum: typeof response.checksum === 'string' ? response.checksum : '',
    visibility:
      typeof response.visibility === 'string' ? response.visibility : 'public',
    registry: registryOrigin(base),
  };
}
