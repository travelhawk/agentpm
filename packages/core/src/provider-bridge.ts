import { AgentPmError } from '@agentpm/shared';

const SKILLS_SH_PUBLIC_URL = 'https://skills.sh';
// Tests and mirrors can point the bridge at another origin.
const SKILLS_SH_URL_ENV = 'AGENTPM_SKILLS_SH_URL';
const SKILLS_SH_SEARCH_LIMIT = 10;
const SKILLS_SH_TIMEOUT_MS = 15_000;
const SKILLS_SH_MAX_RESPONSE_CHARS = 2 * 1024 * 1024;

// Search results are third-party text that ends up in the terminal and in
// install selectors, so anything with control characters is dropped.
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1F\x7F-\x9F]/;
const PROVIDER_SKILL_ID_PATTERN = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;

export type ProviderId = 'skills.sh';

export interface ProviderSkillSearchResult {
  provider: ProviderId;
  name: string;
  source: string;
  installLocator: string;
  skillSelector: string;
  url: string | null;
  installs: string | null;
  description: string | null;
  raw: string;
}

export interface ProviderSkillInstallRequest {
  provider: ProviderId;
  source: string;
  installLocator: string;
  skills: string[];
  selector: string | null;
}

export type ProviderInstallInput =
  | {
      kind: 'request';
      request: ProviderSkillInstallRequest;
    }
  | {
      kind: 'query';
      provider: ProviderId;
      query: string;
    };

export function formatProviderSkillSelector(
  source: string,
  skill: string,
): string | null {
  const normalizedSkill = skill.trim();
  if (!normalizedSkill) {
    return null;
  }
  const normalizedSource = source.trim();
  const githubSource = normalizedSource.startsWith('github:')
    ? normalizedSource.slice('github:'.length)
    : normalizedSource;
  if (/^[^/\s]+\/[^/\s]+$/.test(githubSource)) {
    return `${githubSource}@${normalizedSkill}`;
  }
  return null;
}

function normalizeProviderId(provider: string): ProviderId {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'skills' || normalized === 'skills.sh') {
    return 'skills.sh';
  }
  throw new AgentPmError(
    `Unsupported provider "${provider}". Supported providers: skills.sh`,
  );
}

function normalizeProviderSource(source: string): {
  source: string;
  installLocator: string;
} {
  const normalized = source.trim();
  if (!normalized) {
    throw new AgentPmError('A provider source is required.');
  }
  if (
    normalized.startsWith('github:') ||
    normalized.includes('://') ||
    normalized.startsWith('git@')
  ) {
    return {
      source: normalized,
      installLocator: normalized,
    };
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    return {
      source: normalized,
      installLocator: `github:${normalized}`,
    };
  }
  return {
    source: normalized,
    installLocator: normalized,
  };
}

function isProviderSelectorCandidate(value: string): boolean {
  return /^([^/\s]+\/[^@\s]+)@([^\s]+)$/.test(value.trim());
}

function isProviderSourceCandidate(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.startsWith('github:') ||
    normalized.includes('://') ||
    normalized.startsWith('git@') ||
    /^[^/\s]+\/[^/\s]+$/.test(normalized)
  );
}

function parseProviderSelector(selector: string): {
  source: string;
  installLocator: string;
  skill: string;
} {
  const normalized = selector.trim();
  const match = normalized.match(/^([^/\s]+\/[^@\s]+)@([^\s]+)$/);
  if (!match) {
    throw new AgentPmError(
      'Expected a provider selector like "owner/repo@skill-name". Or pass a repo/path and use --skill <name>.',
    );
  }

  const source = match[1]!;
  const skill = match[2]!;
  return {
    source,
    installLocator: `github:${source}`,
    skill,
  };
}

function resolveSkillsShBaseUrl(env: NodeJS.ProcessEnv): URL {
  const override = env[SKILLS_SH_URL_ENV]?.trim();
  let base: URL;
  try {
    base = new URL(override || SKILLS_SH_PUBLIC_URL);
  } catch {
    throw new AgentPmError(
      `${SKILLS_SH_URL_ENV} is not a valid URL: "${override ?? ''}".`,
    );
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new AgentPmError(`${SKILLS_SH_URL_ENV} must be an http(s) URL.`);
  }
  return base;
}

async function fetchSkillsShSearch(
  query: string,
  env: NodeJS.ProcessEnv,
): Promise<unknown> {
  const url = new URL('/api/search', resolveSkillsShBaseUrl(env));
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(SKILLS_SH_SEARCH_LIMIT));

  let status: number;
  let text: string;
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(SKILLS_SH_TIMEOUT_MS),
    });
    status = response.status;
    text = await response.text();
  } catch (error: unknown) {
    const cause =
      error instanceof Error && error.cause instanceof Error
        ? error.cause.message
        : null;
    const reason = error instanceof Error ? error.message : String(error);
    throw new AgentPmError(
      `Could not reach skills.sh at ${url.origin}: ${cause ?? reason}`,
    );
  }

  if (status < 200 || status >= 300) {
    throw new AgentPmError(`skills.sh search failed with HTTP ${status}.`);
  }
  if (text.length > SKILLS_SH_MAX_RESPONSE_CHARS) {
    throw new AgentPmError('skills.sh returned an oversized search response.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AgentPmError(
      'skills.sh returned an unexpected search response (not JSON).',
    );
  }
}

function formatInstallCount(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/.0$/, '')}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/.0$/, '')}K`;
  }
  return String(Math.trunc(value));
}

function isSafeProviderSkillId(id: string): boolean {
  return (
    PROVIDER_SKILL_ID_PATTERN.test(id) &&
    !id.split('/').some((segment) => /^\.+$/.test(segment))
  );
}

function readCleanString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || CONTROL_CHARACTER_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function parseSkillsProviderSearchResponse(
  body: unknown,
): ProviderSkillSearchResult[] {
  const skills =
    body && typeof body === 'object' && 'skills' in body
      ? (body as { skills?: unknown }).skills
      : undefined;
  if (!Array.isArray(skills)) {
    throw new AgentPmError(
      'skills.sh returned an unexpected search response (missing "skills" list).',
    );
  }

  const results: ProviderSkillSearchResult[] = [];
  for (const entry of skills) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const source = readCleanString(record.source);
    const name =
      readCleanString(record.name) ?? readCleanString(record.skillId);
    if (!source || !name) {
      continue;
    }
    const selector = `${source}@${name}`;
    // Entries that are not "owner/repo@skill" cannot flow through the Git
    // install path, so they are skipped like the old CLI bridge did.
    if (!isProviderSelectorCandidate(selector)) {
      continue;
    }
    const parsed = parseProviderSelector(selector);
    const id = readCleanString(record.id);
    results.push({
      provider: 'skills.sh',
      name: parsed.skill,
      source: parsed.source,
      installLocator: parsed.installLocator,
      skillSelector: selector,
      url:
        id && isSafeProviderSkillId(id)
          ? `${SKILLS_SH_PUBLIC_URL}/${id}`
          : null,
      installs: formatInstallCount(record.installs),
      description: readCleanString(record.description),
      raw: JSON.stringify(record),
    });
  }

  return results;
}

export async function searchProviderSkills(
  query: string,
  env: NodeJS.ProcessEnv,
  provider = 'skills.sh',
): Promise<ProviderSkillSearchResult[]> {
  const resolvedProvider = normalizeProviderId(provider);
  if (resolvedProvider !== 'skills.sh') {
    throw new AgentPmError(`Unsupported provider "${provider}".`);
  }
  if (!query.trim()) {
    throw new AgentPmError('A provider search query is required.');
  }
  const body = await fetchSkillsShSearch(query.trim(), {
    ...process.env,
    ...env,
  });
  return parseSkillsProviderSearchResponse(body);
}

export function resolveProviderInstallRequest(
  sourceOrSelector: string,
  skills: string[] = [],
  provider = 'skills.sh',
): ProviderSkillInstallRequest {
  const resolvedProvider = normalizeProviderId(provider);
  if (resolvedProvider !== 'skills.sh') {
    throw new AgentPmError(`Unsupported provider "${provider}".`);
  }

  if (skills.length > 0) {
    const normalized = normalizeProviderSource(sourceOrSelector);
    return {
      provider: resolvedProvider,
      source: normalized.source,
      installLocator: normalized.installLocator,
      skills,
      selector: null,
    };
  }

  const parsed = parseProviderSelector(sourceOrSelector);
  return {
    provider: resolvedProvider,
    source: parsed.source,
    installLocator: parsed.installLocator,
    skills: [parsed.skill],
    selector: `${parsed.source}@${parsed.skill}`,
  };
}

export function resolveProviderInstallInput(
  sourceOrSelector: string,
  skills: string[] = [],
  provider = 'skills.sh',
): ProviderInstallInput {
  const resolvedProvider = normalizeProviderId(provider);
  const normalized = sourceOrSelector.trim();
  if (!normalized) {
    throw new AgentPmError('A provider install target or query is required.');
  }

  if (skills.length > 0 || isProviderSelectorCandidate(normalized)) {
    return {
      kind: 'request',
      request: resolveProviderInstallRequest(normalized, skills, provider),
    };
  }

  if (isProviderSourceCandidate(normalized)) {
    const source = normalizeProviderSource(normalized);
    return {
      kind: 'request',
      request: {
        provider: resolvedProvider,
        source: source.source,
        installLocator: source.installLocator,
        skills: [],
        selector: null,
      },
    };
  }

  return {
    kind: 'query',
    provider: resolvedProvider,
    query: normalized,
  };
}
