import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';

import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFile,
} from '@agentpm/fs';
import {
  AgentPmError,
  GLOBAL_CONFIG_VERSION,
  MANIFEST_VERSION,
  classifyLocator,
  normalizeGitHubRepoLocator,
  type AdapterId,
  type GlobalConfigFile,
  type InstallScope,
  type LoadedProjectConfig,
  type LocalInstallScope,
  type ManifestFile,
  type ManifestInstallSpec,
  type ManifestPushTargetSpec,
  type ManifestSourceSpec,
  type ProjectConfigFile,
  type ProjectSkillSpec,
  type ProjectSourceSpec,
  type PushTargetKind,
  type SourceKind,
} from '@agentpm/shared';

export const PROJECT_CONFIG_FILENAME = 'agentpm.yaml';
export const LOCAL_PROJECT_CONFIG_FILENAME = '.agentpmrc';

export interface AgentPmPaths {
  homeDir: string;
  cacheDir: string;
  skillsLibraryDir: string;
  dbPath: string;
  globalConfigPath: string;
  manifestPath: string;
}

export function resolveAgentPmPaths(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentPmPaths {
  const homeDir = env.AGENTPM_HOME ?? path.join(os.homedir(), '.agentpm');
  return {
    homeDir,
    cacheDir: path.join(homeDir, 'cache'),
    // Canonical local skill library: the single source of truth that every
    // agent's native skill directory symlinks back to.
    skillsLibraryDir: path.join(homeDir, 'skills'),
    dbPath: path.join(homeDir, 'agentpm.db'),
    globalConfigPath: path.join(homeDir, 'config.yaml'),
    manifestPath: path.join(cwd, PROJECT_CONFIG_FILENAME),
  };
}

export async function ensureAgentPmHome(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentPmPaths> {
  const paths = resolveAgentPmPaths(cwd, env);
  await ensureDir(paths.homeDir);
  await ensureDir(paths.cacheDir);
  await ensureDir(paths.skillsLibraryDir);
  return paths;
}

function parseYaml<T>(content: string): T {
  return yaml.load(content) as T;
}

function stringifyYaml(value: unknown): string {
  return yaml.dump(value, {
    noRefs: true,
    lineWidth: 100,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new AgentPmError(`${label} must be an object.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AgentPmError(`${label} must be a non-empty string.`);
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new AgentPmError(`${label} must be an array of strings.`);
  }
  const items = value.map((item, index) =>
    optionalString(item, `${label}[${index}]`),
  );
  return items.filter((item): item is string => Boolean(item));
}

function optionalSourceKind(
  value: unknown,
  label: string,
): SourceKind | undefined {
  const kind = optionalString(value, label);
  if (!kind) {
    return undefined;
  }
  if (kind !== 'git' && kind !== 'local' && kind !== 'registry') {
    throw new AgentPmError(`${label} must be one of: git, local, registry.`);
  }
  return kind;
}

function optionalScope(
  value: unknown,
  label: string,
): LocalInstallScope | undefined {
  const scope = optionalString(value, label);
  if (!scope) {
    return undefined;
  }
  if (scope !== 'project' && scope !== 'workspace') {
    throw new AgentPmError(`${label} must be one of: project, workspace.`);
  }
  return scope;
}

function optionalAdapterId(
  value: unknown,
  label: string,
): AdapterId | undefined {
  const target = optionalString(value, label);
  if (!target) {
    return undefined;
  }
  if (target !== 'codex' && target !== 'claude' && target !== 'generic') {
    throw new AgentPmError(`${label} must be one of: codex, claude, generic.`);
  }
  return target;
}

function optionalPushTargetKind(
  value: unknown,
  label: string,
): PushTargetKind | undefined {
  const kind = optionalString(value, label);
  if (!kind) {
    return undefined;
  }
  if (kind !== 'git' && kind !== 'registry') {
    throw new AgentPmError(`${label} must be one of: git, registry.`);
  }
  return kind;
}

export async function loadGlobalConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GlobalConfigFile> {
  const paths = resolveAgentPmPaths(cwd, env);
  if (!(await pathExists(paths.globalConfigPath))) {
    return { version: GLOBAL_CONFIG_VERSION };
  }

  const parsed = parseYaml<GlobalConfigFile>(
    await readTextFile(paths.globalConfigPath),
  );
  return parsed ?? { version: GLOBAL_CONFIG_VERSION };
}

export async function saveGlobalConfig(
  cwd: string,
  config: GlobalConfigFile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const paths = await ensureAgentPmHome(cwd, env);
  await writeTextFile(paths.globalConfigPath, stringifyYaml(config));
}

export async function loadManifest(cwd: string): Promise<ManifestFile | null> {
  const manifestPath = path.join(cwd, PROJECT_CONFIG_FILENAME);
  if (!(await pathExists(manifestPath))) {
    return null;
  }

  const parsed = parseYaml<Record<string, unknown>>(
    await readTextFile(manifestPath),
  );
  return parsed ? normalizeProjectConfig(parsed) : null;
}

export async function saveManifest(
  cwd: string,
  manifest: ManifestFile,
): Promise<string> {
  const manifestPath = path.join(cwd, PROJECT_CONFIG_FILENAME);
  await writeTextFile(manifestPath, stringifyYaml(manifest));
  return manifestPath;
}

function normalizeSourceSpec(
  source: ProjectSourceSpec,
): ManifestFile['sources'][number] {
  if (typeof source === 'string') {
    if (source.trim().length === 0) {
      throw new AgentPmError('sources[] string entries must be non-empty.');
    }
    return { locator: normalizeGitHubRepoLocator(source) };
  }
  const record = requireRecord(source, 'sources[] entries');
  const locator = optionalString(record.locator, 'sources[].locator');
  if (!locator) {
    throw new AgentPmError('sources[] object entries must include locator.');
  }
  return {
    id: optionalString(record.id, 'sources[].id'),
    locator: normalizeGitHubRepoLocator(locator),
    kind: optionalSourceKind(record.kind, 'sources[].kind'),
  };
}

function normalizePushTargetSpec(
  target: ManifestPushTargetSpec,
): ManifestPushTargetSpec {
  const record = requireRecord(target, 'targets[] entries');
  const locator = optionalString(record.locator, 'targets[].locator');
  if (!locator) {
    throw new AgentPmError('targets[] object entries must include locator.');
  }
  const normalizedLocator = normalizeGitHubRepoLocator(locator);
  return {
    id: optionalString(record.id, 'targets[].id'),
    locator: normalizedLocator,
    kind:
      optionalPushTargetKind(record.kind, 'targets[].kind') ??
      (classifyLocator(normalizedLocator) === 'registry' ? 'registry' : 'git'),
    default: record.default === true,
  };
}

function normalizeSkillSpec(
  skill: ProjectSkillSpec,
  defaultScope: LocalInstallScope,
): ManifestInstallSpec {
  if (typeof skill === 'string') {
    if (skill.trim().length === 0) {
      throw new AgentPmError('skills[] string entries must be non-empty.');
    }
    return {
      name: skill,
      items: [skill],
      scope: defaultScope,
    };
  }

  const record = requireRecord(skill, 'skills[] entries');
  const name = optionalString(record.name, 'skills[].name');
  if (!name) {
    throw new AgentPmError('skills[] object entries must include name.');
  }
  const target = optionalAdapterId(record.target, 'skills[].target');
  const adapter = optionalAdapterId(record.adapter, 'skills[].adapter');
  if (target && adapter && target !== adapter) {
    throw new AgentPmError(
      'skills[].target and skills[].adapter cannot disagree.',
    );
  }
  const items = optionalStringArray(record.items, 'skills[].items');

  return {
    name,
    source: optionalString(record.source, 'skills[].source'),
    items: items && items.length > 0 ? items : [name],
    scope: optionalScope(record.scope, 'skills[].scope') ?? defaultScope,
    ref: optionalString(record.ref, 'skills[].ref'),
    revision: optionalString(record.revision, 'skills[].revision'),
    target: target ?? adapter,
    adapter: adapter ?? target,
    workspaceRoot: optionalString(
      record.workspaceRoot,
      'skills[].workspaceRoot',
    ),
    provider: optionalString(record.provider, 'skills[].provider'),
    selector: optionalString(record.selector, 'skills[].selector'),
  };
}

export function projectConfigToManifest(
  config: ProjectConfigFile,
): ManifestFile {
  const record = requireRecord(config, 'project config');
  const defaultScope = optionalScope(record.scope, 'scope') ?? 'project';
  if (record.version !== undefined && typeof record.version !== 'number') {
    throw new AgentPmError('version must be a number.');
  }
  if (record.sources !== undefined && !Array.isArray(record.sources)) {
    throw new AgentPmError('sources must be an array.');
  }
  if (record.skills !== undefined && !Array.isArray(record.skills)) {
    throw new AgentPmError('skills must be an array.');
  }
  if (record.targets !== undefined && !Array.isArray(record.targets)) {
    throw new AgentPmError('targets must be an array.');
  }
  return {
    version: config.version ?? MANIFEST_VERSION,
    sources: (config.sources ?? []).map((source) =>
      normalizeSourceSpec(source),
    ),
    installs: (config.skills ?? []).map((skill) =>
      normalizeSkillSpec(skill, defaultScope),
    ),
    targets: (config.targets ?? []).map((target) =>
      normalizePushTargetSpec(target),
    ),
  };
}

function looksLikeManifestFile(value: Record<string, unknown>): boolean {
  return Array.isArray(value.installs);
}

function normalizeProjectConfig(value: Record<string, unknown>): ManifestFile {
  if (looksLikeManifestFile(value)) {
    if (value.version !== undefined && typeof value.version !== 'number') {
      throw new AgentPmError('version must be a number.');
    }
    if (value.sources !== undefined && !Array.isArray(value.sources)) {
      throw new AgentPmError('sources must be an array.');
    }
    if (value.targets !== undefined && !Array.isArray(value.targets)) {
      throw new AgentPmError('targets must be an array.');
    }
    if (!Array.isArray(value.installs)) {
      throw new AgentPmError('installs must be an array.');
    }
    return {
      version:
        typeof value.version === 'number' ? value.version : MANIFEST_VERSION,
      sources: Array.isArray(value.sources)
        ? (value.sources as ProjectSourceSpec[]).map((source) =>
            normalizeSourceSpec(source),
          )
        : [],
      installs: Array.isArray(value.installs)
        ? (value.installs as ManifestInstallSpec[]).map((install, index) => {
            const record = requireRecord(install, `installs[${index}]`);
            const name = optionalString(record.name, `installs[${index}].name`);
            if (!name) {
              throw new AgentPmError(`installs[${index}] must include name.`);
            }
            const target = optionalAdapterId(
              record.target,
              `installs[${index}].target`,
            );
            const adapter = optionalAdapterId(
              record.adapter,
              `installs[${index}].adapter`,
            );
            if (target && adapter && target !== adapter) {
              throw new AgentPmError(
                `installs[${index}].target and installs[${index}].adapter cannot disagree.`,
              );
            }
            const items = optionalStringArray(
              record.items,
              `installs[${index}].items`,
            );
            return {
              name,
              source: optionalString(
                record.source,
                `installs[${index}].source`,
              ),
              items: items && items.length > 0 ? items : [name],
              scope:
                optionalScope(record.scope, `installs[${index}].scope`) ??
                'project',
              ref: optionalString(record.ref, `installs[${index}].ref`),
              revision: optionalString(
                record.revision,
                `installs[${index}].revision`,
              ),
              target: target ?? adapter,
              adapter: adapter ?? target,
              workspaceRoot: optionalString(
                record.workspaceRoot,
                `installs[${index}].workspaceRoot`,
              ),
              provider: optionalString(
                record.provider,
                `installs[${index}].provider`,
              ),
              selector: optionalString(
                record.selector,
                `installs[${index}].selector`,
              ),
            };
          })
        : [],
      targets: Array.isArray(value.targets)
        ? (value.targets as ManifestPushTargetSpec[]).map((target) =>
            normalizePushTargetSpec(target),
          )
        : [],
    };
  }

  return projectConfigToManifest(value);
}

function mergeManifests(
  canonical: ManifestFile,
  local: ManifestFile,
): ManifestFile {
  return {
    version: canonical.version,
    sources: [...canonical.sources, ...local.sources],
    installs: [...canonical.installs, ...local.installs],
    targets: [...(canonical.targets ?? []), ...(local.targets ?? [])],
  };
}

function isSimpleProjectInstall(install: ManifestInstallSpec): boolean {
  return (
    install.scope === 'project' &&
    !install.source &&
    !install.ref &&
    !install.revision &&
    !install.target &&
    !install.adapter &&
    !install.workspaceRoot &&
    install.items.length === 1 &&
    install.items[0] === install.name
  );
}

function manifestInstallToProjectSkillSpec(
  install: ManifestInstallSpec,
): ProjectSkillSpec {
  if (isSimpleProjectInstall(install)) {
    return install.name;
  }

  return {
    name: install.name,
    source: install.source,
    items: install.items,
    scope: install.scope,
    ref: install.ref,
    revision: install.revision,
    target: install.target ?? install.adapter,
    adapter: install.adapter ?? install.target,
    workspaceRoot: install.workspaceRoot,
    provider: install.provider,
    selector: install.selector,
  };
}

function mergeManifestSources(
  existing: ManifestSourceSpec[],
  additions: ManifestSourceSpec[],
): ManifestSourceSpec[] {
  const merged = [...existing];

  for (const source of additions) {
    const index = merged.findIndex(
      (candidate) =>
        (source.id && candidate.id === source.id) ||
        candidate.locator === source.locator,
    );
    if (index >= 0) {
      merged[index] = {
        ...merged[index],
        ...source,
      };
    } else {
      merged.push(source);
    }
  }

  return merged;
}

function mergeManifestInstalls(
  existing: ManifestInstallSpec[],
  additions: ManifestInstallSpec[],
): ManifestInstallSpec[] {
  const merged = [...existing];

  for (const install of additions) {
    const index = merged.findIndex(
      (candidate) => candidate.name === install.name,
    );
    if (index >= 0) {
      merged[index] = install;
    } else {
      merged.push(install);
    }
  }

  return merged;
}

export async function loadProjectConfig(
  cwd: string,
): Promise<LoadedProjectConfig | null> {
  const configPath = path.join(cwd, PROJECT_CONFIG_FILENAME);
  if (await pathExists(configPath)) {
    const parsed =
      parseYaml<Record<string, unknown>>(await readTextFile(configPath)) ?? {};
    let manifest = normalizeProjectConfig(parsed);
    const localConfigPath = path.join(cwd, LOCAL_PROJECT_CONFIG_FILENAME);
    const warnings: string[] = [];

    if (await pathExists(localConfigPath)) {
      const localParsed =
        parseYaml<Record<string, unknown>>(
          await readTextFile(localConfigPath),
        ) ?? {};
      manifest = mergeManifests(manifest, normalizeProjectConfig(localParsed));
      warnings.push(
        `${LOCAL_PROJECT_CONFIG_FILENAME} was merged as a local override; commit ${PROJECT_CONFIG_FILENAME} for team reproducibility.`,
      );
    }

    return {
      configPath,
      localConfigPath: (await pathExists(localConfigPath))
        ? localConfigPath
        : undefined,
      format: 'agentpm.yaml',
      manifest,
      warnings,
    };
  }

  const localConfigPath = path.join(cwd, LOCAL_PROJECT_CONFIG_FILENAME);
  if (await pathExists(localConfigPath)) {
    const parsed =
      parseYaml<Record<string, unknown>>(await readTextFile(localConfigPath)) ??
      {};
    return {
      configPath: localConfigPath,
      format: '.agentpmrc',
      manifest: normalizeProjectConfig(parsed),
      warnings: [
        `${LOCAL_PROJECT_CONFIG_FILENAME} was loaded as a compatibility fallback. Prefer ${PROJECT_CONFIG_FILENAME} for committed project configuration.`,
      ],
    };
  }

  return null;
}

export async function saveProjectConfig(
  cwd: string,
  config: ProjectConfigFile,
): Promise<string> {
  const configPath = path.join(cwd, PROJECT_CONFIG_FILENAME);
  await writeTextFile(configPath, stringifyYaml(config));
  return configPath;
}

export async function upsertProjectConfigInstalls(
  cwd: string,
  options: {
    sources: ManifestSourceSpec[];
    installs: ManifestInstallSpec[];
  },
): Promise<string> {
  const configPath = path.join(cwd, PROJECT_CONFIG_FILENAME);
  if (!(await pathExists(configPath))) {
    throw new AgentPmError(`No ${PROJECT_CONFIG_FILENAME} found in ${cwd}.`);
  }

  const parsed =
    parseYaml<Record<string, unknown>>(await readTextFile(configPath)) ?? {};
  const record = requireRecord(parsed, 'project config');
  const manifest = normalizeProjectConfig(record);
  const nextSources = mergeManifestSources(manifest.sources, options.sources);
  const nextInstalls = mergeManifestInstalls(
    manifest.installs,
    options.installs,
  );

  await saveProjectConfig(cwd, {
    version: manifest.version,
    scope: optionalScope(record.scope, 'scope'),
    sources: nextSources,
    targets: manifest.targets,
    skills: nextInstalls.map((install) =>
      manifestInstallToProjectSkillSpec(install),
    ),
  });

  return configPath;
}

export async function addTargetToProjectConfig(
  cwd: string,
  target: ManifestPushTargetSpec,
): Promise<void> {
  const loaded = await loadProjectConfig(cwd);
  if (!loaded) {
    throw new AgentPmError(`No ${PROJECT_CONFIG_FILENAME} found in ${cwd}.`);
  }

  const manifest = loaded.manifest;
  const targets = [...(manifest.targets ?? [])];
  const existingIndex = targets.findIndex((t) => t.id === target.id);
  const existingDefault =
    existingIndex >= 0 ? targets[existingIndex]?.default === true : false;
  const nextTarget = {
    ...target,
    default: target.default === true || existingDefault || undefined,
  };

  if (existingIndex >= 0) {
    targets[existingIndex] = nextTarget;
  } else {
    targets.push(nextTarget);
  }

  manifest.targets = target.default
    ? targets.map((candidate) => ({
        ...candidate,
        default: candidate.id === target.id,
      }))
    : targets;
  await saveProjectConfig(cwd, {
    version: manifest.version,
    scope: 'project',
    sources: manifest.sources,
    targets: manifest.targets,
    skills: manifest.installs,
  });
}

export async function setDefaultProjectTarget(
  cwd: string,
  targetId: string,
): Promise<void> {
  const loaded = await loadProjectConfig(cwd);
  if (!loaded) {
    throw new AgentPmError(`No ${PROJECT_CONFIG_FILENAME} found in ${cwd}.`);
  }

  const manifest = loaded.manifest;
  const targets = manifest.targets ?? [];
  if (!targets.some((target) => target.id === targetId)) {
    throw new AgentPmError(`Target "${targetId}" not found in config.`);
  }

  manifest.targets = targets.map((target) => ({
    ...target,
    default: target.id === targetId,
  }));
  await saveProjectConfig(cwd, {
    version: manifest.version,
    scope: 'project',
    sources: manifest.sources,
    targets: manifest.targets,
    skills: manifest.installs,
  });
}

export async function removeTargetFromProjectConfig(
  cwd: string,
  targetId: string,
): Promise<void> {
  const loaded = await loadProjectConfig(cwd);
  if (!loaded) {
    throw new AgentPmError(`No ${PROJECT_CONFIG_FILENAME} found in ${cwd}.`);
  }

  const manifest = loaded.manifest;
  const targets = manifest.targets ?? [];
  const nextTargets = targets.filter((t) => t.id !== targetId);

  if (targets.length === nextTargets.length) {
    throw new AgentPmError(`Target "${targetId}" not found in config.`);
  }

  manifest.targets = nextTargets;
  await saveProjectConfig(cwd, {
    version: manifest.version,
    scope: 'project',
    sources: manifest.sources,
    targets: manifest.targets,
    skills: manifest.installs,
  });
}

export async function addTargetToGlobalConfig(
  cwd: string,
  target: ManifestPushTargetSpec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = await loadGlobalConfig(cwd, env);
  const targets = [...(config.targets ?? [])];
  const existingIndex = targets.findIndex((t) => t.id === target.id);
  const existingDefault =
    existingIndex >= 0 ? targets[existingIndex]?.default === true : false;
  const nextTarget = {
    ...target,
    default: target.default === true || existingDefault || undefined,
  };

  if (existingIndex >= 0) {
    targets[existingIndex] = nextTarget;
  } else {
    targets.push(nextTarget);
  }

  config.targets = target.default
    ? targets.map((candidate) => ({
        ...candidate,
        default: candidate.id === target.id,
      }))
    : targets;
  await saveGlobalConfig(cwd, config, env);
}

export async function setDefaultGlobalTarget(
  cwd: string,
  targetId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = await loadGlobalConfig(cwd, env);
  const targets = config.targets ?? [];
  if (!targets.some((target) => target.id === targetId)) {
    throw new AgentPmError(`Target "${targetId}" not found in global config.`);
  }

  config.targets = targets.map((target) => ({
    ...target,
    default: target.id === targetId,
  }));
  await saveGlobalConfig(cwd, config, env);
}

export async function removeTargetFromGlobalConfig(
  cwd: string,
  targetId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = await loadGlobalConfig(cwd, env);
  const targets = config.targets ?? [];
  const nextTargets = targets.filter((t) => t.id !== targetId);

  if (targets.length === nextTargets.length) {
    throw new AgentPmError(`Target "${targetId}" not found in global config.`);
  }

  config.targets = nextTargets;
  await saveGlobalConfig(cwd, config, env);
}

export function createEmptyManifest(): ManifestFile {
  return {
    version: MANIFEST_VERSION,
    sources: [],
    installs: [],
    targets: [],
  };
}

export function resolveScopeRoot(
  scope: InstallScope,
  cwd: string,
  globalConfig: GlobalConfigFile,
  workspaceRoot?: string,
): string {
  if (scope === 'global') {
    return os.homedir();
  }

  if (scope === 'project') {
    return cwd;
  }

  return workspaceRoot ?? globalConfig.defaults?.workspaceRoot ?? cwd;
}

export function isLocalManifestScope(
  scope: InstallScope,
): scope is LocalInstallScope {
  return scope === 'project' || scope === 'workspace';
}
