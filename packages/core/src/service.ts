import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  getAdapter,
  inspectRepository,
  listInstallableEntries,
  nativePluginRoot,
  nativeSkillRoot,
} from '@agentpm/adapters';
import {
  LOCAL_PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_FILENAME,
  ensureAgentPmHome,
  loadGlobalConfig,
  upsertProjectConfigInstalls,
  loadProjectConfig,
  resolveScopeRoot,
  saveProjectConfig,
} from '@agentpm/config';
import { AgentPmDatabase } from '@agentpm/db';
import {
  computeTreeSignature,
  diffTrees,
  ensureDir,
  ensureManagedLink,
  isBrokenLink,
  materializeArchive,
  pathExists,
  removeManagedLink,
  walkFiles,
} from '@agentpm/fs';
import {
  DEFAULT_DISCOVERY_PATHS,
  cleanupTemporaryRelease,
  createTemporaryGitRelease,
  inferContentKind,
  isLocalGitRepository,
  materializeGitRelease,
  normalizeSparsePaths,
  resolveGitRevision,
  resolveReleasePath,
  runGitCommand,
} from '@agentpm/git';
import { fetchSkillArchive, loadRegistryIndex } from '@agentpm/registry';
import {
  AgentPmError,
  MANIFEST_VERSION,
  classifyLocator,
  displayNameFromLocator,
  isGitHubRepoShorthand,
  makeId,
  normalizeGitHubRepoLocator,
  nowIso,
  slugify,
  toPosixPath,
  type CacheCleanOptions,
  type CacheCleanResult,
  type CatalogEntryRecord,
  type ContentKind,
  type DoctorFixAction,
  type DoctorFixResult,
  type DoctorIssue,
  type EntryKind,
  type InstallRecord,
  type InstallScope,
  type AdapterId,
  type InspectionReport,
  type LoadedProjectConfig,
  type ManifestFile,
  type ManifestPushTargetSpec,
  type ManifestSourceSpec,
  type PromptApi,
  type ProjectConfigFile,
  type ManifestInstallSpec,
  type PushOptions,
  type PushResult,
  type PullOptions,
  type PullResult,
  type AdoptOptions,
  type AdoptResult,
  type MaterializedSkillRecord,
  type RefreshSourceResult,
  type RegistryIndexEntry,
  type RuntimeContextEntry,
  type RuntimeContextGraph,
  type SearchResult,
  type SourceKind,
  type SourceRecord,
  type UpdatePreview,
} from '@agentpm/shared';
import {
  formatProviderSkillSelector,
  resolveProviderInstallInput,
  resolveProviderInstallRequest,
  searchProviderSkills,
  type ProviderSkillSearchResult,
} from './provider-bridge.js';

export interface AddSourceResult {
  source: SourceRecord;
  indexedEntries: number;
  report?: InspectionReport;
}

export interface InstallOptions {
  scope?: InstallScope | undefined;
  workspaceRoot?: string | undefined;
  all?: boolean | undefined;
  skills?: string[] | undefined;
  ref?: string | null | undefined;
  revision?: string | null | undefined;
  target?: AdapterId | undefined;
  from?: string | undefined;
  addSource?: boolean | undefined;
  yes?: boolean | undefined;
  updateProjectConfig?: boolean | undefined;
}

export interface RemoveInstallOptions {
  purge?: boolean;
  adapter?: AdapterId | undefined;
  scope?: InstallScope | undefined;
  targetPath?: string | undefined;
}

export interface UpdateOptions {
  names?: string[] | undefined;
  apply?: boolean | undefined;
  yes?: boolean | undefined;
}

export interface AgentPmServiceOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  prompts?: PromptApi;
  onStatus?: ((message: string) => void) | undefined;
}

interface ServicePaths {
  homeDir: string;
  cacheDir: string;
  skillsLibraryDir: string;
  dbPath: string;
  globalConfigPath: string;
  manifestPath: string;
}

interface PreparedContent {
  report: InspectionReport;
  contentKind: ContentKind;
  contentLocator: string;
  contentRef: string | null;
  revision: string | null;
  repoRoot: string;
  cacheKey: string | null;
  archive?: { version: string } | undefined;
  cleanup?: (() => Promise<void>) | undefined;
}

interface ResolvedInstallSource {
  source: SourceRecord;
  entries: CatalogEntryRecord[];
  persisted: boolean;
}

interface ConfiguredSourceBinding {
  spec: ManifestSourceSpec;
  source: SourceRecord;
}

interface PushCandidate {
  name: string;
  adapter: AdapterId;
  kind: EntryKind;
  sourcePath: string;
  sourceRelativePath: string;
  destinationRelativePath: string;
}

function describePushCandidate(
  cwd: string,
  candidate: PushCandidate,
): string {
  const storedPath = path.relative(cwd, candidate.sourcePath);
  const displayPath =
    storedPath.length > 0 && !storedPath.startsWith('..')
      ? toPosixPath(storedPath)
      : candidate.sourcePath;
  return `${candidate.adapter}  ${candidate.destinationRelativePath}  <- ${displayPath}`;
}

export interface SourceSkillEntry {
  name: string;
  path: string | null;
  adapter: AdapterId | null;
  description: string | null;
  repo: string;
  archive?: boolean | undefined;
  version?: string | null | undefined;
  kind?: EntryKind | null | undefined;
  sourceId: string | null;
  sourceDisplayName: string;
}

export interface SourceEntriesResult {
  sourceId: string | null;
  sourceDisplayName: string;
  sourceLocator: string;
  persisted: boolean;
  entries: SourceSkillEntry[];
}

export interface ProviderSkillInstallOptions extends InstallOptions {
  provider?: string | undefined;
}

export interface ProviderInstalledSkillRecord {
  provider: string;
  name: string;
  source: string | null;
  installLocator: string | null;
  skillSelector: string | null;
  scope: InstallScope;
  targetPath: string;
  installedRevision: string | null;
  installId: string;
}

const execFileAsync = promisify(execFile);

function normalizeCatalogSelector(selector: string): string {
  return selector.trim().replace(/\\/g, '/');
}

function matchesCatalogEntrySelector(
  entry: CatalogEntryRecord,
  selector: string,
): boolean {
  const normalizedSelector = normalizeCatalogSelector(selector);
  if (!normalizedSelector) {
    return false;
  }

  if (entry.name === normalizedSelector) {
    return true;
  }

  if (!entry.path) {
    return false;
  }

  return (
    entry.path === normalizedSelector ||
    entry.path.endsWith(`/${normalizedSelector}`)
  );
}

function matchesCatalogEntryTarget(
  entry: CatalogEntryRecord,
  target?: AdapterId,
): boolean {
  return !target || entry.adapterHint === null || entry.adapterHint === target;
}

export class AgentPmService {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly prompts: PromptApi;
  readonly onStatus: ((message: string) => void) | undefined;
  readonly paths: ServicePaths;
  readonly db: AgentPmDatabase;

  constructor(options: AgentPmServiceOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    this.env = { ...process.env, ...options.env };
    this.prompts = options.prompts ?? {};
    this.onStatus = options.onStatus;

    const agentPmHome =
      this.env.AGENTPM_HOME ?? path.join(os.homedir(), '.agentpm');
    this.paths = {
      homeDir: agentPmHome,
      cacheDir: path.join(agentPmHome, 'cache'),
      skillsLibraryDir: path.join(agentPmHome, 'skills'),
      dbPath: path.join(agentPmHome, 'agentpm.db'),
      globalConfigPath: path.join(agentPmHome, 'config.yaml'),
      manifestPath: path.join(this.cwd, PROJECT_CONFIG_FILENAME),
    };

    this.db = new AgentPmDatabase(this.paths.dbPath);
  }

  async initialize(): Promise<void> {
    await ensureAgentPmHome(this.cwd, this.env);
  }

  close(): void {
    this.db.close();
  }

  private cacheBasePath(cacheKey: string): string {
    return path.join(this.paths.cacheDir, 'repos', cacheKey.slice(0, 16));
  }

  private reportStatus(message: string): void {
    this.onStatus?.(message);
  }

  private async toGitTransportLocator(locator: string): Promise<string> {
    if (locator.startsWith('github:')) {
      return `https://github.com/${locator
        .slice('github:'.length)
        .replace(/^\/+/, '')
        .replace(/\.git$/i, '')}.git`;
    }
    if (locator.includes('://') || locator.includes('@')) {
      return locator;
    }

    const localPath = path.resolve(this.cwd, locator);
    if (await pathExists(localPath)) {
      return pathToFileURL(localPath).href;
    }

    return locator;
  }

  async addSource(locator: string): Promise<AddSourceResult> {
    await this.initialize();
    const kind = await this.classifySource(locator);
    const normalizedLocator = this.normalizeLocator(locator, kind);
    this.reportStatus(
      `Resolving source ${displayNameFromLocator(normalizedLocator)}...`,
    );
    const sourceId = makeId('src', kind, normalizedLocator);
    const source: SourceRecord = {
      id: sourceId,
      kind,
      locator: normalizedLocator,
      normalizedLocator,
      displayName: displayNameFromLocator(normalizedLocator),
      metadata: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const storedSource = this.db.upsertSource(source);
    return this.reindexSource(storedSource);
  }

  listSources(): SourceRecord[] {
    return this.db
      .listSources()
      .filter((source) => source.metadata.transient !== true);
  }

  async listSourceEntries(
    sourceToken?: string,
    options: {
      refresh?: boolean | undefined;
      target?: AdapterId | undefined;
    } = {},
  ): Promise<SourceEntriesResult> {
    await this.initialize();

    let source = sourceToken ? this.findSourceByToken(sourceToken) : null;
    if (!source && !sourceToken) {
      const sources = this.listSources();
      if (sources.length === 0) {
        throw new AgentPmError(
          'No sources have been added yet. Use "agentpm source add <locator>" first.',
        );
      }
      if (!this.prompts.selectOne) {
        throw new AgentPmError(
          'Listing source skills without a source requires an interactive TTY.',
        );
      }
      source = await this.prompts.selectOne(
        'Choose a source to inspect:',
        sources.map((candidate) => ({
          label: candidate.displayName,
          description: candidate.locator,
          value: candidate,
        })),
      );
    }

    if (source) {
      if (options.refresh) {
        await this.reindexSource(source);
      }
      const entries = this.db
        .listCatalogEntriesBySource(source.id)
        .filter((entry) => matchesCatalogEntryTarget(entry, options.target))
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          adapter: entry.adapterHint,
          description: entry.description,
          repo: entry.repo,
          sourceId: source.id,
          sourceDisplayName: source.displayName,
        }));
      return {
        sourceId: source.id,
        sourceDisplayName: source.displayName,
        sourceLocator: source.locator,
        persisted: true,
        entries,
      };
    }

    if (!sourceToken) {
      throw new AgentPmError('A source token or locator is required.');
    }

    const kind = await this.classifySource(sourceToken);
    const normalizedLocator = this.normalizeLocator(sourceToken, kind);
    const displayName = displayNameFromLocator(normalizedLocator);
    if (kind === 'registry') {
      const registry = await loadRegistryIndex(normalizedLocator, this.env);
      const entries = registry.entries
        .filter(
          (entry) =>
            !options.target ||
            !entry.target ||
            entry.target === options.target ||
            entry.adapterHint === options.target,
        )
        .map((entry) => ({
          name: entry.name,
          path: entry.path ?? null,
          adapter: entry.target ?? entry.adapterHint ?? null,
          description: entry.description ?? null,
          repo: resolveRegistryRepo(
            normalizedLocator,
            entry.archive ?? entry.repo ?? '',
          ),
          archive: entry.archive !== undefined,
          version: entry.version ?? null,
          kind: entry.kind ?? null,
          sourceId: null,
          sourceDisplayName: displayName,
        }));
      return {
        sourceId: null,
        sourceDisplayName: displayName,
        sourceLocator: normalizedLocator,
        persisted: false,
        entries,
      };
    }

    const prepared = await this.prepareInspectionTarget(
      normalizedLocator,
      kind,
      {
        sourceId: null,
      },
    );
    try {
      const entries = this.catalogEntriesFromInspection(
        '__preview__',
        normalizedLocator,
        prepared.report,
      )
        .filter((entry) => matchesCatalogEntryTarget(entry, options.target))
        .map((entry) => ({
          name: entry.name,
          path: entry.path,
          adapter: entry.adapterHint,
          description: entry.description,
          repo: entry.repo,
          sourceId: null,
          sourceDisplayName: displayName,
        }));
      return {
        sourceId: null,
        sourceDisplayName: displayName,
        sourceLocator: normalizedLocator,
        persisted: false,
        entries,
      };
    } finally {
      await prepared.cleanup?.();
    }
  }

  async refreshSources(
    sourceTokens: string[] = [],
  ): Promise<RefreshSourceResult[]> {
    await this.initialize();
    const sources =
      sourceTokens.length > 0
        ? sourceTokens.map((token) => {
            const source = this.findSourceByToken(token);
            if (!source) {
              throw new AgentPmError(`Unknown source: ${token}`);
            }
            return source;
          })
        : this.listSources();

    const results: RefreshSourceResult[] = [];
    for (const source of sources) {
      const result = await this.reindexSource(source);
      results.push({
        source: result.source,
        indexedEntries: result.indexedEntries,
      });
    }
    return results;
  }

  async removeSource(sourceToken: string): Promise<void> {
    await this.initialize();
    const source = this.findSourceByToken(sourceToken);
    if (!source) {
      throw new AgentPmError(`Unknown source: ${sourceToken}`);
    }

    if (this.db.countInstallsForSource(source.id) > 0) {
      throw new AgentPmError(
        `Cannot remove source "${source.displayName}" while installs still depend on it.`,
      );
    }

    this.db.deleteSource(source.id);
  }

  async inspect(
    target: string,
    options: {
      skill?: string | undefined;
      target?: AdapterId | undefined;
    } = {},
  ): Promise<InspectionReport> {
    await this.initialize();
    const source = this.findSourceByToken(target);
    if (source && source.kind !== 'registry') {
      const prepared = await this.prepareInspectionTarget(
        source.locator,
        source.kind,
      );
      try {
        return this.annotateInspectionForRequest(prepared.report, options);
      } finally {
        await prepared.cleanup?.();
      }
    }

    const kind = await this.classifySource(target);
    if (kind === 'registry') {
      throw new AgentPmError(
        'Registry indexes are not inspectable as repositories.',
      );
    }

    const prepared = await this.prepareInspectionTarget(target, kind);
    try {
      return this.annotateInspectionForRequest(prepared.report, options);
    } finally {
      await prepared.cleanup?.();
    }
  }

  search(query: string): SearchResult[] {
    const catalogResults = this.db.searchCatalogEntries(query).map((entry) => ({
      kind: 'catalog' as const,
      name: entry.name,
      description: entry.description,
      sourceId: entry.sourceId,
      adapter: entry.adapterHint,
      scope: null,
      locator: entry.repo,
    }));
    return [...catalogResults, ...this.db.searchInstalled(query)];
  }

  async searchProviderSkills(
    query: string,
  ): Promise<ProviderSkillSearchResult[]> {
    await this.initialize();
    return searchProviderSkills(query, this.env);
  }

  listProviderSkillInstalls(
    provider = 'skills.sh',
  ): ProviderInstalledSkillRecord[] {
    return this.db
      .listInstalls()
      .filter((install) => install.metadata.provider === provider)
      .map((install) => ({
        provider,
        name: install.name,
        source:
          typeof install.metadata.providerSource === 'string'
            ? install.metadata.providerSource
            : null,
        installLocator:
          typeof install.metadata.providerInstallLocator === 'string'
            ? install.metadata.providerInstallLocator
            : null,
        skillSelector:
          typeof install.metadata.providerSkillSelector === 'string'
            ? install.metadata.providerSkillSelector
            : null,
        scope: install.scope,
        targetPath: install.targetPath,
        installedRevision: install.installedRevision,
        installId: install.id,
      }));
  }

  async installProviderSkill(
    sourceOrSelector: string,
    options: ProviderSkillInstallOptions = {},
  ): Promise<InstallRecord[]> {
    const resolved = resolveProviderInstallInput(
      sourceOrSelector,
      options.skills ?? [],
      options.provider,
    );
    if (resolved.kind === 'query') {
      this.reportStatus(`Searching public skills for "${resolved.query}"...`);
      const results = await searchProviderSkills(
        resolved.query,
        this.env,
        resolved.provider,
      );
      if (results.length === 0) {
        throw new AgentPmError(
          `No public skills found for "${resolved.query}".`,
        );
      }
      if (!this.prompts.selectOne) {
        throw new AgentPmError(
          `Query installs require an interactive TTY. Re-run interactively or install with a concrete selector like "${results[0]!.skillSelector}".`,
        );
      }
      const selected = await this.prompts.selectOne(
        `Choose a public skill to install for "${resolved.query}":`,
        results.map((result) => ({
          label: result.skillSelector,
          description: result.url ?? result.installLocator,
          value: result,
        })),
      );
      sourceOrSelector = selected.skillSelector;
    }

    const request = resolveProviderInstallRequest(
      sourceOrSelector,
      options.skills ?? [],
      options.provider,
    );
    this.reportStatus(
      `Installing ${request.selector ?? request.source} from ${request.installLocator}...`,
    );
    const installs = await this.install([], {
      ...options,
      from: request.installLocator,
      addSource: options.addSource,
      skills: request.skills,
    });
    const taggedInstalls = installs.map((install) =>
      this.db.saveInstall({
        ...install,
        metadata: {
          ...install.metadata,
          provider: request.provider,
          providerSource: request.source,
          providerInstallLocator: request.installLocator,
          providerSkillSelector:
            request.selector ??
            formatProviderSkillSelector(request.source, install.name),
        },
        updatedAt: nowIso(),
      }),
    );
    if (taggedInstalls.length > 0 && options.updateProjectConfig !== false) {
      await this.updateExistingProjectConfig(taggedInstalls);
    }
    return taggedInstalls;
  }

  async removeProviderSkill(
    identifier: string,
    options: RemoveInstallOptions = {},
  ): Promise<InstallRecord> {
    await this.initialize();
    const install = await this.resolveProviderInstall(identifier, options);
    return this.removeInstallRecord(install, options);
  }

  async updateProviderSkills(
    identifiers: string[] = [],
    options: UpdateOptions = {},
  ): Promise<UpdatePreview[]> {
    await this.initialize();
    const installs = this.resolveProviderInstalls(identifiers);
    const installIds = new Set(installs.map((install) => install.id));
    const previews = (await this.previewUpdates({ apply: false })).filter(
      (preview) => installIds.has(preview.install.id),
    );
    if (!options.apply) {
      return previews;
    }
    return this.applyUpdatePreviews(previews, options);
  }

  listInstalls(): InstallRecord[] {
    return this.db.listInstalls();
  }

  async install(
    names: string[],
    options: InstallOptions = {},
  ): Promise<InstallRecord[]> {
    await this.initialize();
    const globalConfig = await loadGlobalConfig(this.cwd, this.env);
    const scope = await this.resolveScope(options.scope);
    const scopeRoot = resolveScopeRoot(
      scope,
      this.cwd,
      globalConfig,
      options.workspaceRoot,
    );
    const selections = await this.resolveSelections(names, options);
    const installs: InstallRecord[] = [];

    for (const selection of selections) {
      this.reportStatus(`Installing selected skill ${selection.entry.name}...`);
      const prepared = await this.prepareContentForEntry(
        selection.entry,
        selection.source,
        {
          ref: options.ref,
          revision: options.revision,
        },
      );

      try {
        const selector: {
          name?: string | undefined;
          relativePath?: string | undefined;
        } = {
          name: selection.entry.name,
        };
        if (selection.entry.path) {
          selector.relativePath = selection.entry.path;
        }
        const detectedEntries = listInstallableEntries(prepared.report).filter(
          (entry) => !options.target || entry.adapter === options.target,
        );
        const detectedEntry =
          // 1. Exact relativePath match
          detectedEntries.find((entry) => {
            if (selector.relativePath) {
              return entry.relativePath === selector.relativePath;
            }
            return selector.name ? entry.name === selector.name : false;
          }) ??
          // 2. Exact name match
          detectedEntries.find(
            (entry) => entry.name === selection.entry.name,
          ) ??
          // 3. Basename match — handles nested paths like composio-skills/doppler-automation
          (selector.relativePath
            ? detectedEntries.find(
                (entry) =>
                  path.basename(entry.relativePath) === selector.relativePath,
              )
            : undefined) ??
          // 4. Basename of relativePath matches the name hint
          (selector.name
            ? detectedEntries.find(
                (entry) => path.basename(entry.relativePath) === selector.name,
              )
            : undefined);

        if (!detectedEntry) {
          const targetSummary = options.target
            ? ` for target "${options.target}"`
            : '';
          const availableNames = detectedEntries
            .slice(0, 20)
            .map((e) => `  - ${e.name} (${e.relativePath})`)
            .join('\n');
          const moreNote =
            detectedEntries.length > 20
              ? `\n  ... and ${detectedEntries.length - 20} more`
              : '';
          throw new AgentPmError(
            `Could not find installable entry "${selection.entry.name}"${targetSummary} in ${prepared.contentLocator}.` +
              (detectedEntries.length > 0
                ? `\n\nAvailable entries in this repository:\n${availableNames}${moreNote}`
                : '\n\nNo installable entries (SKILL.md) were detected in this repository.'),
          );
        }

        const adapter = getAdapter(detectedEntry.adapter);
        const mapping = await adapter.install(detectedEntry, scopeRoot);
        const linkTarget = path.join(
          prepared.repoRoot,
          mapping.sourceRelativePath,
        );
        const targetPath = path.join(scopeRoot, mapping.targetRelativePath);

        await ensureDir(path.dirname(targetPath));
        await ensureManagedLink(targetPath, linkTarget);

        const installedRevision =
          prepared.revision ??
          (prepared.contentKind === 'local'
            ? await computeTreeSignature(
                path.join(prepared.repoRoot, mapping.sourceRelativePath),
              )
            : null);

        // The adapter is part of the identity so the same skill/plugin name can
        // be installed for two agents (e.g. codex and claude) from one source
        // without the second install overwriting the first record.
        const installId = makeId(
          'inst',
          selection.source.id,
          mapping.name,
          scope,
          scopeRoot,
          mapping.adapter,
        );
        const savedInstall = this.db.saveInstall({
          id: installId,
          name: mapping.name,
          sourceId: selection.source.id,
          catalogEntryId: selection.entry.id,
          adapter: mapping.adapter,
          scope,
          scopeRoot,
          targetPath,
          linkTarget,
          sourceRelativePath: mapping.sourceRelativePath,
          sourceRootRelativePath: mapping.sourceRootRelativePath,
          selectedItems:
            options.skills && options.skills.length > 0
              ? options.skills
              : [mapping.name],
          contentKind: prepared.contentKind,
          contentLocator: prepared.contentLocator,
          contentRef: options.ref ?? selection.entry.ref ?? null,
          cacheKey: prepared.cacheKey,
          installedRevision,
          layoutSignature: prepared.report.layoutSignature,
          metadata: {
            sourceLocator: selection.source.locator,
            sourceKind: selection.source.kind,
            ...(prepared.archive
              ? { archive: true, archiveVersion: prepared.archive.version }
              : {}),
          },
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });

        await this.recordGeneratedTargetInLocalGitExclude(savedInstall);
        await this.ensureGitignored(scopeRoot, targetPath, options.yes);
        installs.push(savedInstall);

        if (detectedEntry.kind === 'plugin') {
          const marketplaceName = await this.syncPluginMarketplace(
            scopeRoot,
            mapping.adapter,
          );
          const pluginRoot = path.join(
            scopeRoot,
            nativePluginRoot(mapping.adapter),
          );
          const cli = mapping.adapter === 'codex' ? 'codex' : 'claude';
          const installVerb =
            mapping.adapter === 'codex' ? 'add' : 'install';
          this.reportStatus(
            `Plugin ready. Enable it in ${cli === 'codex' ? 'Codex' : 'Claude Code'}:\n` +
              `  ${cli} plugin marketplace add ${pluginRoot}\n` +
              `  ${cli} plugin ${installVerb} ${mapping.name}@${marketplaceName}`,
          );
        }
      } finally {
        await prepared.cleanup?.();
      }
    }

    if (installs.length > 0 && options.updateProjectConfig !== false) {
      this.reportStatus('Updating manifest and local install metadata...');
      await this.updateExistingProjectConfig(installs);
    }

    return installs;
  }

  async previewUpdates(options: UpdateOptions = {}): Promise<UpdatePreview[]> {
    await this.initialize();
    const installs = this.filterInstallsByName(options.names);
    const previews: UpdatePreview[] = [];

    for (const install of installs) {
      const source = this.db.getSource(install.sourceId);
      if (install.metadata.archive === true) {
        previews.push(await this.previewArchiveInstallUpdate(install, source));
        continue;
      }
      if (install.contentKind === 'local') {
        previews.push(await this.previewLocalInstallUpdate(install, source));
        continue;
      }

      const candidateRevision = await resolveGitRevision(
        install.contentLocator,
        install.contentRef ?? undefined,
        this.env,
      );
      if (candidateRevision === install.installedRevision) {
        previews.push({
          install,
          source,
          changed: false,
          currentRevision: install.installedRevision,
          candidateRevision,
          diff: [],
          risk: 'safe',
          warnings: [],
          nextLinkTarget: install.linkTarget,
        });
        continue;
      }

      const prepared = await this.prepareGitCandidateFromInstall(
        install,
        candidateRevision,
      );
      try {
        const adapter = getAdapter(install.adapter);
        const updateResult = adapter.update(install, prepared.report);
        const nextLinkTarget = updateResult.nextRelativePath
          ? path.join(prepared.repoRoot, updateResult.nextRelativePath)
          : null;
        const diff =
          nextLinkTarget && (await pathExists(install.linkTarget))
            ? await diffTrees(install.linkTarget, nextLinkTarget)
            : [];

        previews.push({
          install,
          source,
          changed: true,
          currentRevision: install.installedRevision,
          candidateRevision,
          diff,
          risk: updateResult.risk,
          warnings: updateResult.warnings,
          nextLinkTarget,
        });
      } finally {
        await prepared.cleanup?.();
      }
    }

    return previews;
  }

  async update(options: UpdateOptions = {}): Promise<UpdatePreview[]> {
    const previews = await this.previewUpdates({ ...options, apply: false });
    if (!options.apply) {
      return previews;
    }

    return this.applyUpdatePreviews(previews, options);
  }

  private async applyUpdatePreviews(
    previews: UpdatePreview[],
    options: UpdateOptions,
  ): Promise<UpdatePreview[]> {
    const pluginMarketplaces = new Map<string, { scopeRoot: string; adapter: AdapterId }>();
    for (const preview of previews) {
      if (!preview.changed || !preview.nextLinkTarget) {
        continue;
      }

      if (
        (preview.risk === 'remap' || preview.risk === 'breaking') &&
        !options.yes
      ) {
        const confirmed = await this.prompts.confirm?.(
          `Update ${preview.install.name} with ${preview.risk} layout risk?`,
          preview.warnings,
        );
        if (!confirmed) {
          preview.warnings.push('Skipped by user.');
          continue;
        }
      }

      try {
        await removeManagedLink(preview.install.targetPath);
        await ensureManagedLink(
          preview.install.targetPath,
          preview.nextLinkTarget,
        );
        // Both git and archive installs materialize into a per-revision
        // release under their cache key, so recompute the source-relative path
        // against that release path.
        const nextSourceRelativePath =
          (preview.install.contentKind === 'git' ||
            preview.install.metadata.archive === true) &&
          preview.install.cacheKey &&
          preview.candidateRevision
            ? path
                .relative(
                  resolveReleasePath(
                    this.cacheBasePath(preview.install.cacheKey),
                    preview.candidateRevision,
                  ),
                  preview.nextLinkTarget,
                )
                .split(path.sep)
                .join('/')
            : preview.install.sourceRelativePath;
        this.db.saveInstall({
          ...preview.install,
          linkTarget: preview.nextLinkTarget,
          sourceRelativePath: nextSourceRelativePath,
          installedRevision: preview.candidateRevision,
          updatedAt: nowIso(),
        });

        if (this.isPluginInstall(preview.install)) {
          pluginMarketplaces.set(
            `${preview.install.scopeRoot}::${preview.install.adapter}`,
            {
              scopeRoot: preview.install.scopeRoot,
              adapter: preview.install.adapter,
            },
          );
        }
      } catch (error) {
        throw new AgentPmError(
          `Failed to update "${preview.install.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Refresh each affected plugin marketplace once so its manifest reflects
    // the updated plugin versions/descriptions.
    for (const { scopeRoot, adapter } of pluginMarketplaces.values()) {
      await this.syncPluginMarketplace(scopeRoot, adapter);
    }

    return previews;
  }

  async cleanCache(options: CacheCleanOptions = {}): Promise<CacheCleanResult> {
    await this.initialize();
    await ensureDir(this.paths.cacheDir);
    const installedCacheKeys = new Set(
      this.db
        .listInstalls()
        .map((install) => install.cacheKey)
        .filter((cacheKey): cacheKey is string => Boolean(cacheKey)),
    );
    const removedPaths: string[] = [];

    for (const cacheRepo of this.db.listCacheRepos()) {
      if (installedCacheKeys.has(cacheRepo.cacheKey)) {
        continue;
      }
      if (cacheRepo.metadata.role === 'push-target') {
        continue;
      }
      if (!options.dryRun) {
        await fs.rm(cacheRepo.basePath, { recursive: true, force: true });
        this.db.deleteCacheRepo(cacheRepo.cacheKey);
      }
      removedPaths.push(cacheRepo.basePath);
    }

    const reposDir = path.join(this.paths.cacheDir, 'repos');
    const repoEntries = await fs
      .readdir(reposDir, { withFileTypes: true })
      .catch(() => []);
    const knownPaths = new Set(
      this.db
        .listCacheRepos()
        .map((cacheRepo) => path.resolve(cacheRepo.basePath)),
    );
    for (const entry of repoEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const entryPath = path.join(reposDir, entry.name);
      if (knownPaths.has(path.resolve(entryPath))) {
        continue;
      }
      if (!options.dryRun) {
        await fs.rm(entryPath, { recursive: true, force: true });
      }
      removedPaths.push(entryPath);
    }

    return {
      removedEntries: removedPaths.length,
      removedPaths,
      dryRun: Boolean(options.dryRun),
    };
  }

  async removeInstall(
    name: string,
    options: RemoveInstallOptions = {},
  ): Promise<InstallRecord> {
    await this.initialize();
    const installs = this.filterRemoveCandidates(
      this.db.listInstallsByName(name),
      options,
    );
    if (installs.length === 0) {
      throw new AgentPmError(`No install named "${name}" found.`);
    }

    let install = installs[0]!;
    if (installs.length > 1) {
      const available = this.formatRemoveCandidates(installs);
      const hasExplicitFilter =
        Boolean(options.adapter) ||
        Boolean(options.scope) ||
        Boolean(options.targetPath);
      if (!this.prompts.selectOne) {
        throw new AgentPmError(
          `Multiple installs named "${name}" found. Re-run with --target, --scope, or --path to choose one.\n\nMatches:\n${available}`,
        );
      }
      if (hasExplicitFilter) {
        throw new AgentPmError(
          `Multiple installs named "${name}" still match the supplied filters. Add --path to choose one.\n\nMatches:\n${available}`,
        );
      }

      install = await this.prompts.selectOne(
        `Choose which "${name}" install to remove:`,
        installs.map((candidate) => ({
          label: `${candidate.name} (${candidate.scope})`,
          description: candidate.targetPath,
          value: candidate,
        })),
      );
    }

    return this.removeInstallRecord(install, options);
  }

  async initManifest(): Promise<{
    manifestPath: string;
    manifest: ManifestFile;
  }> {
    await this.initialize();
    const installs = this.db
      .listInstalls()
      .filter(
        (install) =>
          install.scope !== 'global' &&
          path.resolve(install.scopeRoot) === this.cwd,
      );
    const sources = installs
      .map((install) => this.db.getSource(install.sourceId))
      .filter((source): source is SourceRecord => Boolean(source));

    const uniqueSources = [
      ...new Map(sources.map((source) => [source.id, source])).values(),
    ];
    const projectConfig: ProjectConfigFile = {
      version: MANIFEST_VERSION,
      sources: uniqueSources.map((source) => ({
        id: source.id,
        locator: source.locator,
        kind: source.kind,
      })),
      targets: [],
      scope: 'project',
      skills: installs.map((install) => {
        const base = {
          name: install.name,
          source: install.sourceId,
          items:
            install.selectedItems.length > 0
              ? install.selectedItems
              : [install.name],
          scope:
            install.scope === 'global' ? ('project' as const) : install.scope,
          ref: install.contentRef ?? undefined,
          revision: install.installedRevision ?? undefined,
          target: install.adapter,
          workspaceRoot:
            install.scope === 'workspace' ? install.scopeRoot : undefined,
        };

        if (
          base.scope === 'project' &&
          !base.ref &&
          !base.revision &&
          base.items.length === 1 &&
          base.items[0] === install.name
        ) {
          return install.name;
        }

        return base;
      }),
    };

    const manifest: ManifestFile = {
      version: MANIFEST_VERSION,
      sources: uniqueSources.map((source) => ({
        id: source.id,
        locator: source.locator,
        kind: source.kind,
      })),
      installs: installs.map((install) => ({
        name: install.name,
        source: install.sourceId,
        items:
          install.selectedItems.length > 0
            ? install.selectedItems
            : [install.name],
        scope: install.scope === 'global' ? 'project' : install.scope,
        ref: install.contentRef ?? undefined,
        revision: install.installedRevision ?? undefined,
        target: install.adapter,
        workspaceRoot:
          install.scope === 'workspace' ? install.scopeRoot : undefined,
      })),
      targets: [],
    };

    const manifestPath = await saveProjectConfig(this.cwd, projectConfig);
    return { manifestPath, manifest };
  }

  async syncManifest(): Promise<InstallRecord[]> {
    await this.initialize();
    const loadedConfig = await loadProjectConfig(this.cwd);
    if (!loadedConfig) {
      throw new AgentPmError(
        `No ${PROJECT_CONFIG_FILENAME} found in ${this.cwd}. Use "agentpm init" or add a committed ${PROJECT_CONFIG_FILENAME}.`,
      );
    }

    const manifest = loadedConfig.manifest;
    const orderedSources = await this.ensureConfiguredSources(manifest.sources);

    const installs: InstallRecord[] = [];
    for (const installSpec of manifest.installs) {
      const sourceToken =
        installSpec.source !== undefined
          ? this.resolveConfiguredSourceToken(
              installSpec.source,
              orderedSources,
            )
          : this.resolveSourceForConfiguredSkill(
              installSpec.items,
              orderedSources,
              installSpec.target ?? installSpec.adapter,
            );
      const sourceBinding =
        orderedSources.find(
          (binding) =>
            binding.source.id === sourceToken ||
            this.matchesConfiguredSourceToken(binding, sourceToken),
        ) ?? null;
      const created = await this.install(sourceBinding ? [] : [sourceToken], {
        from: sourceBinding?.source.locator,
        scope: installSpec.scope,
        workspaceRoot: installSpec.workspaceRoot,
        skills: installSpec.items,
        ref: installSpec.ref ?? null,
        revision: installSpec.revision ?? null,
        target: installSpec.target ?? installSpec.adapter,
        yes: true,
        updateProjectConfig: false,
      });
      installs.push(...created);
    }

    return installs;
  }

  async addTarget(
    id: string,
    locator: string,
    defaultTarget = false,
  ): Promise<void> {
    await this.initialize();
    const sourceKind = await this.classifySource(locator);
    const normalizedLocator = this.normalizeLocator(locator, sourceKind);
    const pushKind = sourceKind === 'local' ? ('git' as const) : sourceKind;
    const { addTargetToGlobalConfig } = await import('@agentpm/config');
    await addTargetToGlobalConfig(
      this.cwd,
      {
        id,
        locator: normalizedLocator,
        kind: pushKind,
        default: defaultTarget,
      },
      this.env,
    );
  }

  async setDefaultTarget(id: string): Promise<void> {
    await this.initialize();
    const { setDefaultGlobalTarget } = await import('@agentpm/config');
    await setDefaultGlobalTarget(this.cwd, id, this.env);
  }

  async removeTarget(id: string): Promise<void> {
    await this.initialize();
    const { removeTargetFromGlobalConfig } = await import('@agentpm/config');
    await removeTargetFromGlobalConfig(this.cwd, id, this.env);
  }

  async push(options: PushOptions = {}): Promise<PushResult> {
    await this.initialize();
    const loadedConfig = await loadProjectConfig(this.cwd);
    const target = await this.resolvePushTarget(options.target, loadedConfig);
    const entries = await this.resolvePushCandidates(
      options.path,
      options.all,
      options.preserveLayout ?? false,
    );

    if (entries.length === 0) {
      return {
        success: true,
        targetLocator: target.locator,
        warnings: ['No entries selected.'],
        entries: [],
      };
    }

    if (target.kind === 'git') {
      return this.pushToGit(
        target.locator,
        entries,
        options.message,
        options.dryRun,
      );
    }

    if (target.kind === 'registry') {
      throw new AgentPmError('Registry push is not implemented yet.');
    }

    throw new AgentPmError(`Unsupported push target kind: ${target.kind}`);
  }

  private async resolvePushTarget(
    token: string | undefined,
    config: LoadedProjectConfig | null,
  ): Promise<ManifestPushTargetSpec> {
    const { loadGlobalConfig } = await import('@agentpm/config');
    const globalConfig = await loadGlobalConfig(this.cwd, this.env);
    const legacyProjectTargets = config?.manifest.targets ?? [];
    const targets = globalConfig.targets ?? [];

    if (token) {
      const normalizedToken = this.normalizeTargetToken(token);
      const match = targets.find(
        (t) => t.id === token || t.locator === normalizedToken,
      );
      if (match) {
        return match;
      }
      return {
        locator: normalizedToken,
        kind:
          classifyLocator(normalizedToken) === 'registry' ? 'registry' : 'git',
      };
    }

    const defaultTarget = targets.find((t) => t.default);
    if (defaultTarget) {
      return defaultTarget;
    }

    if (targets.length === 1) {
      return targets[0]!;
    }

    if (targets.length > 1 && this.prompts.selectOne) {
      const selected = await this.prompts.selectOne(
        'Choose a push target:',
        targets.map((target) => ({
          label: target.id ?? target.locator,
          value: target,
          description: `${target.kind ?? 'git'}  ${target.locator}`,
        })),
      );
      if (selected.id && this.prompts.confirm) {
        const shouldSaveDefault = await this.prompts.confirm(
          `Save "${selected.id}" as the default push target?`,
          ['The default will be written to global AgentPM config.'],
        );
        if (shouldSaveDefault) {
          await this.setDefaultTarget(selected.id);
        }
      }
      return selected;
    }

    const available =
      targets.length > 0
        ? targets
            .map(
              (target) =>
                `  - ${target.id ?? target.locator} (${target.kind ?? 'git'}) ${target.locator}`,
            )
            .join('\n')
        : '  - none configured';
    throw new AgentPmError(
      `No push target specified and no default target configured in global config.` +
        (legacyProjectTargets.length > 0
          ? '\n\nLegacy project targets were found in agentpm.yaml but are no longer used for push target resolution.'
          : '') +
        `\n\nAvailable targets:\n${available}\n\nUse --to <target>, or set one with: agentpm target default <id>`,
    );
  }

  private installRecordToManifestSpec(
    install: InstallRecord,
  ): ManifestInstallSpec {
    return {
      name: install.name,
      source: install.sourceId,
      items:
        install.selectedItems.length > 0
          ? install.selectedItems
          : [install.name],
      scope: install.scope === 'global' ? 'project' : install.scope,
      ref: install.contentRef ?? undefined,
      revision: install.installedRevision ?? undefined,
      target: install.adapter,
      workspaceRoot:
        install.scope === 'workspace' ? install.scopeRoot : undefined,
      provider:
        typeof install.metadata.provider === 'string'
          ? install.metadata.provider
          : undefined,
      selector:
        typeof install.metadata.providerSkillSelector === 'string'
          ? install.metadata.providerSkillSelector
          : undefined,
    };
  }

  private async updateExistingProjectConfig(
    installs: InstallRecord[],
  ): Promise<void> {
    const loadedConfig = await loadProjectConfig(this.cwd);
    if (!loadedConfig || loadedConfig.format !== 'agentpm.yaml') {
      return;
    }

    const localInstalls = installs.filter(
      (install) => install.scope !== 'global',
    );
    if (localInstalls.length === 0) {
      return;
    }

    const sources = localInstalls.map((install) => {
      const source = this.db.getSource(install.sourceId);
      if (source) {
        return {
          id: source.id,
          locator: source.locator,
          kind: source.kind,
        } satisfies ManifestSourceSpec;
      }

      const sourceLocator =
        typeof install.metadata.sourceLocator === 'string'
          ? install.metadata.sourceLocator
          : install.contentLocator;
      const sourceKind =
        typeof install.metadata.sourceKind === 'string'
          ? (install.metadata.sourceKind as SourceKind)
          : classifyLocator(sourceLocator) === 'registry'
            ? 'registry'
            : install.contentKind === 'local'
              ? 'local'
              : 'git';
      return {
        id: install.sourceId,
        locator: sourceLocator,
        kind: sourceKind,
      } satisfies ManifestSourceSpec;
    });

    const uniqueSources = [
      ...new Map(
        sources.map((source) => [source.id ?? source.locator, source]),
      ).values(),
    ];

    await upsertProjectConfigInstalls(this.cwd, {
      sources: uniqueSources,
      installs: localInstalls.map((install) =>
        this.installRecordToManifestSpec(install),
      ),
    });
  }

  private async discoverPushCandidates(
    rootPath: string,
    preserveLayout = false,
  ): Promise<PushCandidate[]> {
    // Canonical push normalizes skills to `skills/<name>` so remote
    // repositories stay tidy and can be pulled into any agent. `preserveLayout`
    // keeps the original native target-relative path. Agents and subagents
    // always keep their native layout so the kind distinction is not lost.
    const toDestination = (
      name: string,
      kind: EntryKind,
      nativePath: string,
    ): string =>
      !preserveLayout && kind === 'skill'
        ? toPosixPath(path.posix.join('skills', name))
        : toPosixPath(nativePath);

    const report = await inspectRepository(rootPath, rootPath, 'local');
    const entries = listInstallableEntries(report);
    const candidates = entries.map((entry) => {
      return {
        name: entry.name,
        adapter: entry.adapter,
        kind: entry.kind,
        sourcePath: path.join(rootPath, entry.relativePath),
        sourceRelativePath: entry.relativePath,
        destinationRelativePath: toDestination(
          entry.name,
          entry.kind,
          entry.relativePath,
        ),
      } satisfies PushCandidate;
    });

    const installedCandidates = this.db
      .listInstalls()
      .filter((install) => path.resolve(install.scopeRoot) === rootPath)
      .map((install) => {
        const nativePath = path.relative(rootPath, install.targetPath);
        const kind = this.inferKindFromNativePath(nativePath);
        return {
          name: install.name,
          adapter: install.adapter,
          kind,
          sourcePath: install.linkTarget,
          sourceRelativePath: install.sourceRelativePath,
          destinationRelativePath: toDestination(
            install.name,
            kind,
            nativePath,
          ),
        } satisfies PushCandidate;
      });

    return [
      ...new Map(
        [...candidates, ...installedCandidates].map((candidate) => [
          [
            path.resolve(candidate.sourcePath),
            candidate.destinationRelativePath,
            candidate.adapter,
            candidate.kind,
          ].join('::'),
          candidate,
        ]),
      ).values(),
    ].sort((left, right) =>
      left.destinationRelativePath.localeCompare(right.destinationRelativePath),
    );
  }

  private assertNoPushDestinationCollisions(
    candidates: PushCandidate[],
    context: string,
  ): void {
    const collisions = new Map<string, PushCandidate[]>();
    for (const candidate of candidates) {
      const existing = collisions.get(candidate.destinationRelativePath) ?? [];
      existing.push(candidate);
      collisions.set(candidate.destinationRelativePath, existing);
    }

    const conflicting = [...collisions.entries()].filter(
      ([, entries]) => entries.length > 1,
    );
    if (conflicting.length === 0) {
      return;
    }

    const details = conflicting
      .map(([destination, entries]) => {
        const variants = entries
          .map(
            (entry) =>
              `    - ${entry.adapter} ${entry.kind}: ${entry.sourceRelativePath}`,
          )
          .join('\n');
        return `  - ${destination}\n${variants}`;
      })
      .join('\n');
    throw new AgentPmError(
      `Multiple entries resolve to the same canonical push destination while ${context}.\n\n${details}\n\nChoose one variant explicitly or re-run with --preserve-layout.`,
    );
  }

  private async resolvePushCandidates(
    token: string | undefined,
    all = false,
    preserveLayout = false,
  ): Promise<PushCandidate[]> {
    const workspaceCandidates = await this.discoverPushCandidates(
      this.cwd,
      preserveLayout,
    );

    if (workspaceCandidates.length === 0) {
      throw new AgentPmError(
        'No pushable skills or agents were detected in the current workspace.',
      );
    }

    if (all) {
      this.assertNoPushDestinationCollisions(
        workspaceCandidates,
        'pushing all detected entries',
      );
      return workspaceCandidates;
    }

    const normalizedToken = normalizeCatalogSelector(token ?? '.');
    if (normalizedToken && normalizedToken !== '.') {
      const resolvedPath = path.resolve(this.cwd, normalizedToken);
      const pathMatches = (await pathExists(resolvedPath))
        ? workspaceCandidates.filter((candidate) => {
            const candidateRoot = path.resolve(candidate.sourcePath);
            return (
              resolvedPath === candidateRoot ||
              resolvedPath.startsWith(`${candidateRoot}${path.sep}`)
            );
          })
        : [];

      if (pathMatches.length > 0) {
        return this.choosePushCandidates(pathMatches, normalizedToken);
      }

      const selectorMatches = workspaceCandidates.filter((candidate) => {
        const destinationBase = path.basename(
          candidate.destinationRelativePath,
        );
        const sourceBase = path.basename(candidate.sourceRelativePath);
        return (
          candidate.name === normalizedToken ||
          candidate.sourceRelativePath === normalizedToken ||
          candidate.destinationRelativePath === normalizedToken ||
          sourceBase === normalizedToken ||
          destinationBase === normalizedToken
        );
      });

      if (selectorMatches.length > 0) {
        return this.choosePushCandidates(selectorMatches, normalizedToken);
      }

      if (await pathExists(resolvedPath)) {
        const directCandidates = await this.discoverPushCandidates(
          resolvedPath,
          preserveLayout,
        );
        if (directCandidates.length > 0) {
          return directCandidates;
        }
      }

      const available = workspaceCandidates
        .map(
          (candidate) =>
            `  - ${candidate.name} -> ${candidate.destinationRelativePath}`,
        )
        .join('\n');
      throw new AgentPmError(
        `Could not find a pushable skill or agent matching "${token}".\n\nAvailable entries:\n${available}`,
      );
    }

    if (workspaceCandidates.length === 1) {
      return workspaceCandidates;
    }

    if (this.prompts.selectMany) {
      const selected = await this.prompts.selectMany(
        'Choose skills or agents to push:',
        workspaceCandidates.map((candidate) => ({
          label: candidate.name,
          value: candidate,
          description: describePushCandidate(this.cwd, candidate),
        })),
      );
      this.assertNoPushDestinationCollisions(
        selected,
        'choosing entries to push',
      );
      return selected;
    }

    const available = workspaceCandidates
      .map(
        (candidate) =>
          `  - ${candidate.name} -> ${candidate.destinationRelativePath}`,
      )
      .join('\n');
    throw new AgentPmError(
      `Multiple pushable entries were detected. Re-run interactively, or pass a skill name or path.\n\nAvailable entries:\n${available}`,
    );
  }

  private async choosePushCandidates(
    matches: PushCandidate[],
    token: string,
  ): Promise<PushCandidate[]> {
    if (matches.length === 1) {
      return matches;
    }

    if (!this.prompts.selectOne) {
      const available = matches
        .map(
          (candidate) =>
            `  - ${candidate.name} -> ${candidate.destinationRelativePath}`,
        )
        .join('\n');
      throw new AgentPmError(
        `Multiple pushable entries matched "${token}". Re-run in interactive mode or use a more specific path.\n\nMatches:\n${available}`,
      );
    }

    const selected = await this.prompts.selectOne(
      `Multiple entries match "${token}". Choose one to push:`,
      matches.map((candidate) => ({
        label: candidate.name,
        value: candidate,
        description: describePushCandidate(this.cwd, candidate),
      })),
    );
    return [selected];
  }

  private async pushToGit(
    locator: string,
    entries: PushCandidate[],
    message?: string,
    dryRun?: boolean,
  ): Promise<PushResult> {
    const warnings: string[] = [];
    const pushedEntries = entries.map((entry) => entry.destinationRelativePath);
    if (dryRun) {
      return {
        success: true,
        targetLocator: locator,
        warnings: ['Dry run: would push to ' + locator],
        entries: pushedEntries,
      };
    }
    try {
      const { repoPath: releasePath } =
        await this.preparePushTargetRepository(locator);

      this.reportStatus(
        `Copying ${entries.length === 1 ? entries[0]!.name : `${entries.length} selected entries`} into the target repository...`,
      );
      for (const entry of entries) {
        const destinationRoot = path.join(
          releasePath,
          entry.destinationRelativePath,
        );
        await fs.rm(destinationRoot, { recursive: true, force: true });

        const files = await walkFiles(entry.sourcePath);
        for (const file of files) {
          const relative = path.relative(entry.sourcePath, file);
          const destination = path.join(destinationRoot, relative);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.copyFile(file, destination);
        }
      }

      const destinationPathspecs = entries.map((entry) =>
        toPosixPath(entry.destinationRelativePath),
      );
      await runGitCommand(
        ['add', '-A', '--force', '--', ...destinationPathspecs],
        {
          cwd: releasePath,
          env: this.env,
        },
      );

      const commitMessage =
        message ??
        `Update ${entries.length === 1 ? entries[0]!.name : `${entries.length} skills`} from AgentPM`;
      this.reportStatus('Creating Git commit...');
      await runGitCommand(['commit', '--quiet', '-m', commitMessage], {
        cwd: releasePath,
        env: this.env,
      }).catch(() => {
        warnings.push('No changes to commit or commit failed.');
      });

      const revision = (
        await runGitCommand(['rev-parse', 'HEAD'], {
          cwd: releasePath,
          env: this.env,
          captureStdout: true,
        }).catch(() => ({ stdout: '' }))
      ).stdout.trim();
      if (!revision) {
        throw new AgentPmError(
          'No commit is available to push. Add files or create a commit before pushing.',
        );
      }

      this.reportStatus('Pushing changes to the remote target...');
      await runGitCommand(
        ['push', '--quiet', '--set-upstream', 'origin', 'HEAD'],
        {
          cwd: releasePath,
          env: this.env,
        },
      );

      const cacheKey = makeId('push-target', locator);
      this.db.saveCacheRepo({
        cacheKey,
        sourceId: null,
        locator,
        kind: 'git',
        basePath: path.dirname(releasePath),
        currentRevision: revision,
        isGit: true,
        layoutSignature: null,
        metadata: {
          role: 'push-target',
        },
        updatedAt: nowIso(),
      });

      return {
        success: true,
        targetLocator: locator,
        revision,
        warnings,
        entries: pushedEntries,
      };
    } catch (error) {
      throw new AgentPmError(
        `Git push fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async preparePushTargetRepository(
    locator: string,
  ): Promise<{ repoPath: string; cacheKey: string }> {
    const cacheKey = makeId('push-target', locator);
    const cacheBasePath = this.cacheBasePath(cacheKey);
    const repoPath = path.join(cacheBasePath, 'worktree');
    const gitDir = path.join(repoPath, '.git');
    const transportLocator = await this.toGitTransportLocator(locator);

    if (!(await pathExists(gitDir))) {
      await fs
        .rm(cacheBasePath, { recursive: true, force: true })
        .catch(() => {});
      await ensureDir(cacheBasePath);
      this.reportStatus(
        'Cloning the target repository into the local cache...',
      );
      await runGitCommand(['clone', '--quiet', transportLocator, repoPath], {
        env: this.env,
      });
      return { repoPath, cacheKey };
    }

    this.reportStatus('Refreshing the cached target repository...');
    await runGitCommand(['reset', '--hard', '--quiet', 'HEAD'], {
      cwd: repoPath,
      env: this.env,
    }).catch(() => {});
    await runGitCommand(['clean', '-fd'], {
      cwd: repoPath,
      env: this.env,
    }).catch(() => {});
    await runGitCommand(['fetch', '--quiet', 'origin', '--prune'], {
      cwd: repoPath,
      env: this.env,
    }).catch(() => {});
    await runGitCommand(['pull', '--ff-only', '--quiet'], {
      cwd: repoPath,
      env: this.env,
    }).catch(() => {});

    return { repoPath, cacheKey };
  }

  // --- Canonical skill library: pull and adopt ---------------------------

  private ensureSource(
    kind: SourceKind,
    locator: string,
    displayName: string,
  ): SourceRecord {
    const id = makeId('src', kind, locator);
    const existing = this.db.getSource(id);
    if (existing) {
      return existing;
    }
    const now = nowIso();
    return this.db.upsertSource({
      id,
      kind,
      locator,
      normalizedLocator: locator,
      displayName,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
  }

  private inferKindFromNativePath(nativePath: string): EntryKind {
    const posix = toPosixPath(nativePath);
    if (posix === 'subagents' || posix.startsWith('subagents/')) {
      return 'subagent';
    }
    if (posix.includes('/agents/') || posix.startsWith('.claude/agents')) {
      return 'agent';
    }
    return 'skill';
  }

  private async copyTreeInto(src: string, dest: string): Promise<void> {
    await fs.rm(dest, { recursive: true, force: true });
    const files = await walkFiles(src);
    for (const file of files) {
      const relative = path.relative(src, file);
      const out = path.join(dest, relative);
      await ensureDir(path.dirname(out));
      await fs.copyFile(file, out);
    }
  }

  private async detectInstalledAgents(scopeRoot: string): Promise<AdapterId[]> {
    const probes: Array<[AdapterId, string]> = [
      ['codex', '.codex'],
      ['claude', '.claude'],
      ['generic', '.agents'],
    ];
    const present: AdapterId[] = [];
    for (const [adapter, dir] of probes) {
      if (await pathExists(path.join(scopeRoot, dir))) {
        present.push(adapter);
      }
    }
    return present;
  }

  private async chooseAgentTargets(
    scopeRoot: string,
    explicit: AdapterId[] | undefined,
    yes: boolean,
  ): Promise<AdapterId[]> {
    const all: AdapterId[] = ['codex', 'claude', 'generic'];
    if (explicit && explicit.length > 0) {
      return explicit;
    }

    const detected = await this.detectInstalledAgents(scopeRoot);
    const candidates = detected.length > 0 ? detected : all;

    if (yes || !this.prompts.selectMany || candidates.length === 1) {
      return candidates;
    }

    const selected = await this.prompts.selectMany<AdapterId>(
      'Select agents to install these skills into:',
      candidates.map((adapter) => ({
        label: adapter,
        value: adapter,
        description: nativeSkillRoot(adapter),
      })),
    );
    return selected.length > 0 ? selected : candidates;
  }

  /**
   * Resolve the workspace root and originating adapter for a native skill path
   * such as `<root>/.claude/skills/<name>` or `<root>/skills/<name>`.
   */
  private resolveNativeScope(absPath: string): {
    scopeRoot: string;
    adapter: AdapterId;
  } {
    const segments = absPath.split(path.sep);
    const baseAdapters: Record<string, AdapterId> = {
      '.codex': 'codex',
      '.codex.cloud': 'codex',
      '.claude': 'claude',
      '.agents': 'generic',
    };
    // Prefer an agent base directory (`.claude`, `.codex`, ...). It outranks the
    // plain `skills`/`subagents` segment that may sit just below it.
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      const segment = segments[i]!;
      if (segment in baseAdapters) {
        return {
          scopeRoot: segments.slice(0, i).join(path.sep) || path.sep,
          adapter: baseAdapters[segment]!,
        };
      }
    }
    // Otherwise fall back to a plain generic root not nested under a dot dir.
    for (let i = segments.length - 1; i >= 1; i -= 1) {
      const segment = segments[i]!;
      if (segment === 'skills' || segment === 'subagents') {
        return {
          scopeRoot: segments.slice(0, i).join(path.sep) || path.sep,
          adapter: 'generic',
        };
      }
    }
    return {
      scopeRoot: path.dirname(path.dirname(absPath)),
      adapter: 'generic',
    };
  }

  /**
   * Symlink one canonical library skill into each selected agent's native skill
   * directory and persist an install record per agent. Every agent dir points
   * at the same library entry, so there is a single source of truth.
   */
  private async linkSkillIntoAgents(params: {
    name: string;
    libraryPath: string;
    agents: AdapterId[];
    scope: InstallScope;
    scopeRoot: string;
    sourceId: string;
    contentKind: ContentKind;
    contentLocator: string;
    contentRef: string | null;
    installedRevision: string | null;
    yes: boolean;
    warnings: string[];
  }): Promise<MaterializedSkillRecord[]> {
    const results: MaterializedSkillRecord[] = [];
    for (const adapter of params.agents) {
      const targetRelativePath = toPosixPath(
        path.join(nativeSkillRoot(adapter), params.name),
      );
      const targetPath = path.join(params.scopeRoot, targetRelativePath);
      await ensureDir(path.dirname(targetPath));

      // A pre-existing real (unmanaged) directory is the common case for adopt
      // and pull. Never clobber it silently: confirm when interactive, skip
      // otherwise, so one collision cannot abort the whole fan-out.
      const existing = await fs.lstat(targetPath).catch(() => null);
      if (existing && !existing.isSymbolicLink()) {
        let replace = false;
        if (!params.yes && this.prompts.confirm) {
          replace = await this.prompts.confirm(
            `"${targetPath}" already exists and is not managed by AgentPM. Replace it with a link to the library copy?`,
            ['The existing files at that path will be removed.'],
          );
        }
        if (!replace) {
          params.warnings.push(
            `Skipped ${adapter}: ${targetRelativePath} already exists and is not managed by AgentPM.`,
          );
          continue;
        }
        await fs.rm(targetPath, { recursive: true, force: true });
      }

      try {
        await ensureManagedLink(targetPath, params.libraryPath);
      } catch (error) {
        params.warnings.push(
          `Skipped ${adapter}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      const installId = makeId(
        'inst',
        params.sourceId,
        params.name,
        params.scope,
        params.scopeRoot,
        adapter,
      );
      const saved = this.db.saveInstall({
        id: installId,
        name: params.name,
        sourceId: params.sourceId,
        catalogEntryId: null,
        adapter,
        scope: params.scope,
        scopeRoot: params.scopeRoot,
        targetPath,
        linkTarget: params.libraryPath,
        sourceRelativePath: toPosixPath(path.join('skills', params.name)),
        sourceRootRelativePath: 'skills',
        selectedItems: [params.name],
        contentKind: params.contentKind,
        contentLocator: params.contentLocator,
        contentRef: params.contentRef,
        cacheKey: null,
        installedRevision: params.installedRevision,
        layoutSignature: '',
        metadata: { library: true },
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      await this.recordGeneratedTargetInLocalGitExclude(saved);
      await this.ensureGitignored(params.scopeRoot, targetPath, params.yes);
      results.push({ name: params.name, adapter, targetPath });
    }
    return results;
  }

  async pull(options: PullOptions = {}): Promise<PullResult> {
    await this.initialize();
    const loadedConfig = await loadProjectConfig(this.cwd);
    const target = await this.resolvePushTarget(options.target, loadedConfig);
    if (target.kind === 'registry') {
      throw new AgentPmError(
        'Pulling from a registry target is not supported.',
      );
    }

    const scope: InstallScope = options.scope ?? 'global';
    const scopeRoot = scope === 'project' ? this.cwd : os.homedir();
    const warnings: string[] = [];

    this.reportStatus('Fetching the canonical skills repository...');
    const { repoPath } = await this.preparePushTargetRepository(target.locator);
    const revision =
      (
        await runGitCommand(['rev-parse', 'HEAD'], {
          cwd: repoPath,
          env: this.env,
          captureStdout: true,
        }).catch(() => ({ stdout: '' }))
      ).stdout.trim() || null;

    const report = await inspectRepository(repoPath, target.locator, 'git');
    const available = listInstallableEntries(report).filter(
      (entry) => entry.kind === 'skill',
    );
    if (available.length === 0) {
      throw new AgentPmError(
        `No canonical skills were found in ${target.locator}.`,
      );
    }

    const requested = options.skills?.filter((name) => name.length > 0) ?? [];
    const selected =
      requested.length > 0
        ? available.filter((entry) => requested.includes(entry.name))
        : available;

    if (selected.length === 0) {
      throw new AgentPmError(
        `None of the requested skills were found. Available: ${available
          .map((entry) => entry.name)
          .join(', ')}`,
      );
    }

    const agents = await this.chooseAgentTargets(
      scopeRoot,
      options.agents,
      options.yes ?? false,
    );
    if (agents.length === 0) {
      return {
        success: true,
        sourceLocator: target.locator,
        revision,
        skills: [],
        installs: [],
        warnings: ['No agents selected.'],
      };
    }

    const source = this.ensureSource(
      'git',
      target.locator,
      displayNameFromLocator(target.locator),
    );

    const installs: MaterializedSkillRecord[] = [];
    const pulledSkills: string[] = [];
    for (const entry of selected) {
      const libraryPath = path.join(this.paths.skillsLibraryDir, entry.name);
      this.reportStatus(`Updating "${entry.name}" in the skill library...`);
      await this.copyTreeInto(
        path.join(repoPath, entry.relativePath),
        libraryPath,
      );
      pulledSkills.push(entry.name);

      const materialized = await this.linkSkillIntoAgents({
        name: entry.name,
        libraryPath,
        agents,
        scope,
        scopeRoot,
        sourceId: source.id,
        contentKind: 'git',
        contentLocator: target.locator,
        contentRef: revision,
        installedRevision: revision,
        yes: options.yes ?? false,
        warnings,
      });
      installs.push(...materialized);
    }

    return {
      success: true,
      sourceLocator: target.locator,
      revision,
      skills: pulledSkills,
      installs,
      warnings,
    };
  }

  async adopt(token: string, options: AdoptOptions = {}): Promise<AdoptResult> {
    await this.initialize();
    const warnings: string[] = [];

    // Resolve the existing skill either from an explicit directory path or by
    // name within the current workspace.
    const resolvedPath = path.resolve(this.cwd, token);
    let name: string;
    let contentPath: string;
    let originAdapter: AdapterId | null;
    let scopeRoot: string;

    const resolvedStat = await fs.lstat(resolvedPath).catch(() => null);
    if (resolvedStat?.isDirectory() || resolvedStat?.isSymbolicLink()) {
      name = path.basename(resolvedPath);
      contentPath = resolvedPath;
      const native = this.resolveNativeScope(resolvedPath);
      originAdapter = native.adapter;
      scopeRoot = native.scopeRoot;
    } else {
      const report = await inspectRepository(this.cwd, this.cwd, 'local');
      const match = listInstallableEntries(report).find(
        (entry) => entry.name === token,
      );
      if (!match) {
        throw new AgentPmError(
          `Could not find a skill named "${token}" in ${this.cwd}. Pass a path to the skill directory instead.`,
        );
      }
      name = match.name;
      contentPath = path.join(this.cwd, match.relativePath);
      originAdapter = match.adapter;
      scopeRoot = this.cwd;
    }

    const libraryPath = path.join(this.paths.skillsLibraryDir, name);
    const resolvedContentPath = path.resolve(contentPath);
    const resolvedLibraryPath = path.resolve(libraryPath);
    const libraryRelativePath = path.relative(
      path.resolve(this.paths.skillsLibraryDir),
      resolvedContentPath,
    );
    const originIsLibraryEntry =
      resolvedContentPath === resolvedLibraryPath &&
      libraryRelativePath !== '' &&
      !libraryRelativePath.startsWith('..') &&
      !path.isAbsolute(libraryRelativePath);

    // Fan-out lands beside the origin: all agents share the same environment so
    // a skill adopted from `~/.claude` also appears in `~/.codex`, etc. When
    // the origin is already the canonical library entry, fan-out globally
    // instead of trying to replace the library path with a link to itself.
    const effectiveScopeRoot = originIsLibraryEntry ? os.homedir() : scopeRoot;
    const scope: InstallScope =
      path.resolve(effectiveScopeRoot) === path.resolve(os.homedir())
        ? 'global'
        : 'project';
    if (originIsLibraryEntry) {
      originAdapter = null;
      warnings.push(
        `"${name}" is already in the AgentPM library; AgentPM will only link it into the selected agents.`,
      );
    }

    const originStat = await fs.lstat(contentPath).catch(() => null);
    const originIsLink = originStat?.isSymbolicLink() ?? false;

    if (await pathExists(libraryPath)) {
      if (!originIsLink) {
        const [originRevision, libraryRevision] = await Promise.all([
          computeTreeSignature(contentPath),
          computeTreeSignature(libraryPath),
        ]);
        if (originRevision !== libraryRevision) {
          const message =
            `A different skill named "${name}" already exists in the AgentPM library. ` +
            'Aborting before replacing the local skill with the library copy.';
          if (!options.yes && this.prompts.confirm) {
            const shouldReplace = await this.prompts.confirm(message, [
              `Library: ${libraryPath}`,
              `Local: ${contentPath}`,
            ]);
            if (!shouldReplace) {
              throw new AgentPmError(
                `Adopt cancelled because "${name}" already exists in the library with different contents.`,
              );
            }
          } else {
            throw new AgentPmError(message);
          }
        } else {
          warnings.push(
            `A skill named "${name}" already exists in the library; the local files match, so AgentPM will relink to the existing library copy.`,
          );
        }
      }
    } else {
      this.reportStatus(`Moving "${name}" into the skill library...`);
      await this.copyTreeInto(contentPath, libraryPath);
    }

    // Replace the original location with a managed symlink into the library so
    // there is no duplicated content.
    if (!originIsLink && !originIsLibraryEntry) {
      await fs.rm(contentPath, { recursive: true, force: true });
      await ensureManagedLink(contentPath, libraryPath);
    }

    const source = this.ensureSource(
      'local',
      this.paths.skillsLibraryDir,
      'AgentPM skill library',
    );
    const revision = await computeTreeSignature(libraryPath);

    // Always record the origin agent when there is one, plus any chosen
    // additional agents.
    const requestedAgents = await this.chooseAgentTargets(
      effectiveScopeRoot,
      options.agents,
      options.yes ?? false,
    );
    const agents = Array.from(
      new Set<AdapterId>([
        ...(originAdapter ? [originAdapter] : []),
        ...requestedAgents,
      ]),
    );

    const installs = await this.linkSkillIntoAgents({
      name,
      libraryPath,
      agents,
      scope,
      scopeRoot: effectiveScopeRoot,
      sourceId: source.id,
      contentKind: 'local',
      contentLocator: libraryPath,
      contentRef: null,
      installedRevision: revision,
      yes: options.yes ?? false,
      warnings,
    });

    return {
      success: true,
      name,
      libraryPath,
      installs,
      warnings,
    };
  }

  async resolveRuntimeContext(
    options: { temporarySkills?: string[] } = {},
  ): Promise<RuntimeContextGraph> {
    await this.initialize();
    const loadedConfig = await loadProjectConfig(this.cwd);
    const sourceBindings = loadedConfig
      ? await this.ensureConfiguredSources(loadedConfig.manifest.sources)
      : [];
    const sources = sourceBindings.map((binding) => binding.source);
    const globalEntries = this.db
      .listInstalls()
      .filter((install) => install.scope === 'global')
      .map((install) => this.runtimeEntryFromInstall('global', install));

    const projectEntries = loadedConfig
      ? loadedConfig.manifest.installs.map((installSpec) => {
          const sourceToken =
            installSpec.source !== undefined
              ? this.resolveConfiguredSourceToken(
                  installSpec.source,
                  sourceBindings,
                )
              : this.resolveSourceForConfiguredSkill(
                  installSpec.items,
                  sourceBindings,
                  installSpec.target ?? installSpec.adapter,
                );
          const source = this.findSourceByToken(sourceToken);
          const itemSelector = installSpec.items[0] ?? installSpec.name;
          const target = installSpec.target ?? installSpec.adapter;
          const entry = source
            ? this.db
                .listCatalogEntriesBySource(source.id)
                .find(
                  (candidate) =>
                    matchesCatalogEntrySelector(candidate, itemSelector) &&
                    matchesCatalogEntryTarget(candidate, target),
                )
            : null;
          const installed =
            this.findProjectInstall(
              entry?.name ?? installSpec.name,
              installSpec.scope,
              installSpec.workspaceRoot,
            ) ??
            (entry?.path
              ? this.findProjectInstallBySourcePath(
                  entry.path,
                  installSpec.scope,
                  installSpec.workspaceRoot,
                )
              : null);

          return {
            layer: 'project' as const,
            name: entry?.name ?? installSpec.name,
            sourceId: source?.id ?? null,
            sourceLocator: source?.locator ?? null,
            adapter: target ?? entry?.adapterHint ?? installed?.adapter ?? null,
            sourceRelativePath:
              entry?.path ?? installed?.sourceRelativePath ?? null,
            targetPath: installed?.targetPath ?? null,
            linkTarget: installed?.linkTarget ?? null,
            scope: installed?.scope ?? installSpec.scope,
            warnings: entry
              ? []
              : [
                  `Configured skill "${installSpec.name}" is not indexed in resolved sources.`,
                ],
          } satisfies RuntimeContextEntry;
        })
      : [];

    const temporaryEntries = (options.temporarySkills ?? []).map((name) =>
      this.resolveTemporaryRuntimeEntry(name, sourceBindings),
    );
    const warnings = loadedConfig
      ? loadedConfig.warnings
      : [
          `No ${PROJECT_CONFIG_FILENAME} found; project layer is empty. ${LOCAL_PROJECT_CONFIG_FILENAME} is only a local override file.`,
        ];

    return {
      cwd: this.cwd,
      configPath: loadedConfig?.configPath ?? null,
      sources,
      layers: {
        global: globalEntries,
        project: projectEntries,
        temporary: temporaryEntries,
      },
      warnings,
    };
  }

  async doctor(): Promise<DoctorIssue[]> {
    await this.initialize();
    const issues: DoctorIssue[] = [];
    const loadedConfig = await loadProjectConfig(this.cwd).catch(
      (error: unknown) => {
        issues.push({
          severity: 'error',
          code: 'config-invalid',
          path: this.paths.manifestPath,
          message:
            error instanceof Error
              ? `Project config is invalid: ${error.message}`
              : 'Project config is invalid.',
          remedy:
            'Fix agentpm.yaml so sources is an array and skills entries are strings or valid objects.',
        });
        return null;
      },
    );

    if (loadedConfig) {
      const configuredSources = loadedConfig.manifest.sources.map((source) => ({
        id: source.id,
        rawLocator: source.locator,
        normalizedLocator: this.normalizeLocator(
          source.locator,
          source.kind ?? classifyLocator(source.locator),
        ),
      }));
      for (const installSpec of loadedConfig.manifest.installs) {
        if (!installSpec.source) {
          continue;
        }
        const matchesConfiguredSource = configuredSources.some(
          (source) =>
            source.id === installSpec.source ||
            source.rawLocator === installSpec.source ||
            source.normalizedLocator === installSpec.source,
        );
        if (!matchesConfiguredSource) {
          issues.push({
            severity: 'error',
            code: 'config-source-missing',
            path: loadedConfig.configPath,
            message: `Configured skill "${installSpec.name}" references unknown source "${installSpec.source}".`,
            remedy:
              'Add a matching source id or locator under sources, or update the skill source field.',
          });
        }
      }

      const configuredBindings = await this.ensureConfiguredSources(
        loadedConfig.manifest.sources,
      ).catch((error: unknown) => {
        issues.push({
          severity: 'error',
          code: 'config-source-unavailable',
          path: loadedConfig.configPath,
          message:
            error instanceof Error
              ? `Configured source is unavailable: ${error.message}`
              : 'Configured source is unavailable.',
          remedy:
            'Verify private Git credentials, registry tokens, or local source paths.',
        });
        return [] as ConfiguredSourceBinding[];
      });

      if (configuredBindings.length > 0) {
        for (const installSpec of loadedConfig.manifest.installs) {
          const target = installSpec.target ?? installSpec.adapter;
          try {
            const sourceToken =
              installSpec.source !== undefined
                ? this.resolveConfiguredSourceToken(
                    installSpec.source,
                    configuredBindings,
                  )
                : this.resolveSourceForConfiguredSkill(
                    installSpec.items,
                    configuredBindings,
                    target,
                  );
            const source = this.findSourceByToken(sourceToken);
            const entries = source
              ? this.db.listCatalogEntriesBySource(source.id)
              : [];
            const hasMatchingEntry = installSpec.items.some((item) =>
              entries.some(
                (entry) =>
                  matchesCatalogEntrySelector(entry, item) &&
                  matchesCatalogEntryTarget(entry, target),
              ),
            );
            if (!hasMatchingEntry) {
              issues.push({
                severity: 'error',
                code: 'config-skill-missing',
                path: loadedConfig.configPath,
                message: `Configured skill "${installSpec.name}" is not available from the resolved source${target ? ` for target "${target}"` : ''}.`,
                remedy:
                  'Check the skill items, source id, registry path, or target value.',
              });
            }
          } catch (error) {
            issues.push({
              severity: 'error',
              code: 'config-skill-unresolved',
              path: loadedConfig.configPath,
              message:
                error instanceof Error
                  ? error.message
                  : `Configured skill "${installSpec.name}" could not be resolved.`,
              remedy:
                'Check the skill source, item selectors, source order, and target.',
            });
          }
        }
      }
    }

    for (const source of this.db.listSources()) {
      if (source.kind === 'local' && !(await pathExists(source.locator))) {
        issues.push({
          severity: 'error',
          code: 'source-missing',
          sourceId: source.id,
          path: source.locator,
          message: `Local source is missing: ${source.locator}`,
          remedy: 'Remove or re-add the source with a valid path.',
        });
      }

      if (source.kind === 'git') {
        try {
          await resolveGitRevision(source.locator, undefined, this.env);
        } catch (error) {
          issues.push({
            severity: 'error',
            code: 'source-unavailable',
            sourceId: source.id,
            message: `Git source is unavailable: ${source.locator}`,
            remedy:
              error instanceof Error
                ? error.message
                : 'Verify network access and repository permissions.',
          });
        }
      }

      if (
        source.kind === 'registry' &&
        this.db.listCatalogEntriesBySource(source.id).length === 0
      ) {
        issues.push({
          severity: 'warning',
          code: 'registry-empty',
          sourceId: source.id,
          message: `Registry source ${source.displayName} has no indexed entries.`,
          remedy: 'Re-add the source or inspect the registry index file.',
        });
      }
    }

    for (const install of this.db.listInstalls()) {
      const targetMissing = !(await pathExists(install.targetPath));
      if (targetMissing) {
        issues.push({
          severity: 'error',
          code: 'install-missing',
          installId: install.id,
          path: install.targetPath,
          message: `Install target is missing: ${install.targetPath}`,
          remedy: 'Reinstall or remove the missing install record.',
        });
      } else if (await isBrokenLink(install.targetPath)) {
        issues.push({
          severity: 'error',
          code: 'broken-link',
          installId: install.id,
          path: install.targetPath,
          message: `Broken link detected: ${install.targetPath}`,
          remedy: 'Run agentpm remove/install to repair the link.',
        });
      }

      if (
        install.cacheKey &&
        !targetMissing &&
        !(await pathExists(this.cacheBasePath(install.cacheKey)))
      ) {
        issues.push({
          severity: 'error',
          code: 'missing-cache',
          installId: install.id,
          path: this.cacheBasePath(install.cacheKey),
          message: 'Cached release is missing.',
          remedy: 'Reinstall or update the entry to restore the cache.',
        });
      }

      if (
        install.metadata.archive !== true &&
        install.contentKind === 'local' &&
        !(await pathExists(install.contentLocator))
      ) {
        // Archive installs record contentKind 'local' with an http(s) archive
        // URL as the locator, so the on-disk existence check does not apply.
        issues.push({
          severity: 'error',
          code: 'source-content-missing',
          installId: install.id,
          path: install.contentLocator,
          message: `Local install source is missing: ${install.contentLocator}`,
          remedy: 'Restore the source path or reinstall from another source.',
        });
      }

      try {
        await fs.access(path.dirname(install.targetPath), fsConstants.W_OK);
      } catch {
        issues.push({
          severity: 'warning',
          code: 'permission-warning',
          installId: install.id,
          path: install.targetPath,
          message: `Write access looks restricted for ${path.dirname(install.targetPath)}`,
          remedy: 'Check permissions before updating or removing this install.',
        });
      }

      if (install.scope !== 'global') {
        const tracked = await this.isGitTrackedPath(
          install.scopeRoot,
          install.targetPath,
        );
        if (tracked) {
          issues.push({
            severity: 'warning',
            code: 'generated-target-tracked',
            installId: install.id,
            path: install.targetPath,
            message: `Generated AgentPM target is tracked by Git: ${install.targetPath}`,
            remedy:
              'Remove the generated target from Git tracking and keep only agentpm.yaml committed.',
          });
        }
      }
    }

    return issues;
  }

  async planDoctorFixes(
    issues: DoctorIssue[] | null = null,
  ): Promise<DoctorFixAction[]> {
    await this.initialize();
    const doctorIssues = issues ?? (await this.doctor());
    const actions: DoctorFixAction[] = [];

    for (const issue of doctorIssues) {
      if (issue.code === 'install-missing' && issue.installId) {
        const install = this.db.getInstall(issue.installId);
        if (!install) {
          continue;
        }
        actions.push({
          code: 'remove-install-record',
          installId: install.id,
          description: `Removing stale install record: ${install.name} (${install.targetPath})`,
        });
        continue;
      }

      if (
        !issue.sourceId ||
        (issue.code !== 'source-missing' &&
          issue.code !== 'source-unavailable' &&
          issue.code !== 'registry-empty')
      ) {
        continue;
      }

      const source = this.db.getSource(issue.sourceId);
      if (!source || this.db.countInstallsForSource(source.id) > 0) {
        continue;
      }

      actions.push({
        code: 'remove-source',
        sourceId: source.id,
        description: `Removing unreachable source: ${source.displayName} (${source.locator})`,
      });
    }

    return actions;
  }

  async applyDoctorFixes(
    actions: DoctorFixAction[],
  ): Promise<DoctorFixResult[]> {
    await this.initialize();
    const results: DoctorFixResult[] = [];

    for (const action of actions) {
      if (action.code === 'remove-source') {
        const source = this.db.getSource(action.sourceId);
        if (!source) {
          results.push({ action, applied: false });
          continue;
        }
        if (this.db.countInstallsForSource(source.id) > 0) {
          throw new AgentPmError(
            `Cannot remove source "${source.displayName}" while installs still depend on it.`,
          );
        }
        this.db.deleteSource(source.id);
        results.push({ action, applied: true });
      } else if (action.code === 'remove-install-record') {
        const install = this.db.getInstall(action.installId);
        if (!install) {
          results.push({ action, applied: false });
          continue;
        }
        this.db.removeInstall(install.id);
        results.push({ action, applied: true });
      }
    }

    return results;
  }

  private async reindexSource(source: SourceRecord): Promise<AddSourceResult> {
    this.reportStatus(`Indexing skills from ${source.displayName}...`);
    if (source.kind === 'registry') {
      const registry = await loadRegistryIndex(source.locator, this.env);
      const entries = this.catalogEntriesFromRegistry(source, registry.entries);
      this.db.replaceCatalogEntries(source.id, entries);
      return { source, indexedEntries: entries.length };
    }

    const prepared = await this.prepareInspectionTarget(
      source.locator,
      source.kind,
      {
        sourceId: source.id,
      },
    );
    try {
      const entries = this.catalogEntriesFromInspection(
        source.id,
        source.locator,
        prepared.report,
      );
      this.db.replaceCatalogEntries(source.id, entries);
      return {
        source,
        indexedEntries: entries.length,
        report: prepared.report,
      };
    } finally {
      await prepared.cleanup?.();
    }
  }

  private catalogEntriesFromRegistry(
    source: Pick<SourceRecord, 'id' | 'locator'>,
    entries: RegistryIndexEntry[],
  ): CatalogEntryRecord[] {
    const seen = new Set<string>();
    return entries.map((entry) => {
      const location = entry.archive ?? entry.repo ?? '';
      // Archive URLs change per published version, so key catalog identity by
      // name plus the stable target/kind/path (never the URL) — installs keep
      // matching across versions, while same-name-per-target entries stay
      // distinct instead of colliding on the primary key.
      const id = makeId(
        'cat',
        source.id,
        entry.name,
        entry.archive ? 'archive' : location,
        entry.target ?? entry.adapterHint ?? '',
        entry.kind ?? '',
        entry.path ?? '',
      );
      if (seen.has(id)) {
        throw new AgentPmError(
          `Registry index ${source.locator} has duplicate entries named "${entry.name}" for the same target and path; entry names must be unique per target.`,
        );
      }
      seen.add(id);
      return {
        id,
        sourceId: source.id,
        name: entry.name,
        description: entry.description ?? null,
        repo: resolveRegistryRepo(source.locator, location),
        ref: entry.ref ?? null,
        path: entry.path ?? null,
        adapterHint: entry.target ?? entry.adapterHint ?? null,
        tags: entry.tags ?? [],
        metadata: entry.archive
          ? {
              archive: true,
              archiveVersion: entry.version ?? null,
              archiveKind: entry.kind ?? null,
            }
          : {},
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
    });
  }

  private catalogEntriesFromInspection(
    sourceId: string,
    locator: string,
    report: InspectionReport,
  ): CatalogEntryRecord[] {
    return listInstallableEntries(report).map((entry) => ({
      id: makeId('cat', sourceId, entry.name, entry.relativePath),
      sourceId,
      name: entry.name,
      description: null,
      repo: locator,
      ref: null,
      path: entry.relativePath,
      adapterHint: entry.adapter,
      tags: [entry.adapter, entry.kind],
      metadata: {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }));
  }

  private annotateInspectionForRequest(
    report: InspectionReport,
    options: { skill?: string | undefined; target?: AdapterId | undefined },
  ): InspectionReport {
    if (!options.skill && !options.target) {
      return report;
    }

    const matchingEntries = listInstallableEntries(report).filter(
      (entry) =>
        (!options.skill ||
          matchesCatalogEntrySelector(
            {
              id: '',
              sourceId: '',
              name: entry.name,
              description: null,
              repo: report.locator,
              ref: null,
              path: entry.relativePath,
              adapterHint: entry.adapter,
              tags: [],
              metadata: {},
              createdAt: '',
              updatedAt: '',
            },
            options.skill,
          )) &&
        (!options.target || entry.adapter === options.target),
    );
    const request = [
      options.skill ? `skill "${options.skill}"` : null,
      options.target ? `target "${options.target}"` : null,
    ]
      .filter(Boolean)
      .join(' with ');

    return {
      ...report,
      warnings:
        matchingEntries.length > 0
          ? report.warnings
          : [...report.warnings, `No detected entry satisfies ${request}.`],
    };
  }

  private async classifySource(locator: string): Promise<SourceKind> {
    const kind = classifyLocator(locator);
    if (kind === 'git' && isGitHubRepoShorthand(locator)) {
      const localPath = path.resolve(this.cwd, this.expandHomePath(locator));
      if (await pathExists(localPath)) {
        return 'local';
      }
    }
    if (kind !== 'local') {
      return kind;
    }

    const resolved = path.resolve(
      this.cwd,
      this.normalizeLocator(locator, kind),
    );
    const stats = await fs.stat(resolved).catch(() => null);
    if (!stats) {
      throw new AgentPmError(`Path does not exist: ${resolved}`);
    }
    if (stats.isFile()) {
      return 'registry';
    }
    return 'local';
  }

  private normalizeLocator(locator: string, kind: SourceKind): string {
    const trimmed = locator.trim();
    if (trimmed.startsWith('registry+https://')) {
      return trimmed.slice('registry+'.length);
    }
    if (trimmed.startsWith('registry:')) {
      return trimmed.slice('registry:'.length);
    }
    if (trimmed.startsWith('local:')) {
      const localPath = trimmed.slice('local:'.length);
      return path.resolve(this.cwd, this.expandHomePath(localPath));
    }
    if (kind === 'local' || (kind === 'registry' && !locator.includes('://'))) {
      return path.resolve(this.cwd, this.expandHomePath(locator));
    }
    const normalizedGithub = normalizeGitHubRepoLocator(trimmed);
    if (normalizedGithub.startsWith('github:')) {
      const repo = normalizedGithub
        .slice('github:'.length)
        .replace(/^\/+/, '')
        .replace(/\.git$/i, '');
      return `github:${repo}`;
    }
    return trimmed;
  }

  private expandHomePath(locator: string): string {
    if (locator === '~') {
      return os.homedir();
    }
    if (locator.startsWith(`~${path.sep}`) || locator.startsWith('~/')) {
      return path.join(os.homedir(), locator.slice(2));
    }
    return locator;
  }

  private findSourceByToken(token: string): SourceRecord | null {
    const exact = this.db.getSourceByLocator(token);
    if (exact) {
      return exact;
    }

    return (
      this.db.listSources().find((source) => {
        const normalizedToken = this.normalizeLocator(token, source.kind);
        return (
          source.displayName === token ||
          source.id === token ||
          source.locator === normalizedToken ||
          source.normalizedLocator === normalizedToken ||
          slugify(source.displayName) === token
        );
      }) ?? null
    );
  }

  private async ensureConfiguredSources(
    sourceSpecs: ManifestSourceSpec[],
  ): Promise<ConfiguredSourceBinding[]> {
    const bindings: ConfiguredSourceBinding[] = [];
    for (const sourceSpec of sourceSpecs) {
      const source =
        (sourceSpec.id ? this.findSourceByToken(sourceSpec.id) : null) ??
        this.findSourceByToken(sourceSpec.locator);
      if (source) {
        bindings.push({ spec: sourceSpec, source });
        continue;
      }

      const added = await this.addSource(sourceSpec.locator);
      bindings.push({ spec: sourceSpec, source: added.source });
    }
    return bindings;
  }

  private matchesConfiguredSourceToken(
    binding: ConfiguredSourceBinding,
    token: string,
  ): boolean {
    const aliases = [
      binding.spec.id,
      binding.spec.locator,
      binding.source.id,
      binding.source.locator,
      binding.source.normalizedLocator,
      binding.source.displayName,
      slugify(binding.source.displayName),
    ].filter((value): value is string => Boolean(value));

    return aliases.some((alias) => alias === token);
  }

  private resolveConfiguredSourceToken(
    token: string,
    orderedSources: ConfiguredSourceBinding[],
  ): string {
    const binding = orderedSources.find((candidate) =>
      this.matchesConfiguredSourceToken(candidate, token),
    );
    if (binding) {
      return binding.source.id;
    }

    throw new AgentPmError(
      `Configured source not found in agentpm.yaml sources: ${token}`,
    );
  }

  private resolveSourceForConfiguredSkill(
    items: string[],
    orderedSources: ConfiguredSourceBinding[],
    target?: AdapterId,
  ): string {
    for (const binding of orderedSources) {
      const entries = this.db.listCatalogEntriesBySource(binding.source.id);
      if (
        items.some((item) =>
          entries.some(
            (entry) =>
              matchesCatalogEntrySelector(entry, item) &&
              matchesCatalogEntryTarget(entry, target),
          ),
        )
      ) {
        return binding.source.id;
      }
    }

    const selectors = items.length > 0 ? items.join(', ') : '(none)';
    const targetSummary = target ? ` for target "${target}"` : '';
    throw new AgentPmError(
      `No configured source contains requested skill selector(s)${targetSummary}: ${selectors}`,
    );
  }

  private findProjectInstall(
    name: string,
    scope: InstallScope,
    workspaceRoot: string | undefined,
  ): InstallRecord | null {
    const expectedRoot =
      scope === 'workspace'
        ? path.resolve(workspaceRoot ?? this.cwd)
        : this.cwd;
    return (
      this.db
        .listInstallsByName(name)
        .find(
          (install) =>
            install.scope === scope &&
            path.resolve(install.scopeRoot) === expectedRoot,
        ) ?? null
    );
  }

  private findProjectInstallBySourcePath(
    sourceRelativePath: string,
    scope: InstallScope,
    workspaceRoot: string | undefined,
  ): InstallRecord | null {
    const expectedRoot =
      scope === 'workspace'
        ? path.resolve(workspaceRoot ?? this.cwd)
        : this.cwd;
    return (
      this.db
        .listInstalls()
        .find(
          (install) =>
            install.scope === scope &&
            path.resolve(install.scopeRoot) === expectedRoot &&
            install.sourceRelativePath === sourceRelativePath,
        ) ?? null
    );
  }

  private runtimeEntryFromInstall(
    layer: RuntimeContextEntry['layer'],
    install: InstallRecord,
  ): RuntimeContextEntry {
    const source = this.db.getSource(install.sourceId);
    return {
      layer,
      name: install.name,
      sourceId: install.sourceId,
      sourceLocator: source?.locator ?? install.contentLocator,
      adapter: install.adapter,
      sourceRelativePath: install.sourceRelativePath,
      targetPath: install.targetPath,
      linkTarget: install.linkTarget,
      scope: install.scope,
      warnings: [],
    };
  }

  private resolveTemporaryRuntimeEntry(
    name: string,
    orderedSources: ConfiguredSourceBinding[],
  ): RuntimeContextEntry {
    const sources =
      orderedSources.length > 0
        ? orderedSources.map((binding) => binding.source)
        : this.db.listSources();
    for (const source of sources) {
      const entry = this.db
        .listCatalogEntriesBySource(source.id)
        .find((candidate) => matchesCatalogEntrySelector(candidate, name));
      if (entry) {
        return {
          layer: 'temporary',
          name: entry.name,
          sourceId: source.id,
          sourceLocator: source.locator,
          adapter: entry.adapterHint,
          sourceRelativePath: entry.path,
          targetPath: null,
          linkTarget: null,
          scope: null,
          warnings: [],
        };
      }
    }

    return {
      layer: 'temporary',
      name,
      sourceId: null,
      sourceLocator: null,
      adapter: null,
      sourceRelativePath: null,
      targetPath: null,
      linkTarget: null,
      scope: null,
      warnings: [
        `Temporary skill "${name}" is not indexed in resolved sources.`,
      ],
    };
  }

  private async recordGeneratedTargetInLocalGitExclude(
    install: InstallRecord,
  ): Promise<void> {
    if (install.scope === 'global') {
      return;
    }

    const scopeRoot = path.resolve(install.scopeRoot);
    const targetPath = path.resolve(install.targetPath);
    const relativePath = path.relative(scopeRoot, targetPath);
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath)
    ) {
      return;
    }

    const gitDir = path.join(scopeRoot, '.git');
    const gitStats = await fs.stat(gitDir).catch(() => null);
    if (!gitStats?.isDirectory()) {
      return;
    }

    const excludePath = path.join(gitDir, 'info', 'exclude');
    const excludeEntry = `${toPosixPath(relativePath)}/`;
    const existing = await fs.readFile(excludePath, 'utf8').catch(() => '');
    if (existing.split(/\r?\n/).includes(excludeEntry)) {
      return;
    }

    await ensureDir(path.dirname(excludePath));
    const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
    const header = existing.includes('# AgentPM generated targets')
      ? ''
      : '# AgentPM generated targets\n';
    await fs.appendFile(
      excludePath,
      `${prefix}${header}${excludeEntry}\n`,
      'utf8',
    );
  }

  private async ensureGitignored(
    scopeRoot: string,
    targetPath: string,
    yesOption?: boolean,
  ): Promise<void> {
    const gitDir = path.join(scopeRoot, '.git');
    const gitStats = await fs.stat(gitDir).catch(() => null);
    if (!gitStats?.isDirectory()) {
      return;
    }

    const relativePath = path.relative(scopeRoot, targetPath);
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath)
    ) {
      return;
    }

    const firstSegment = relativePath.replace(/\\/g, '/').split('/')[0] ?? '';
    if (!firstSegment || !firstSegment.startsWith('.')) {
      return;
    }

    const gitignorePath = path.join(scopeRoot, '.gitignore');
    const existing = await fs.readFile(gitignorePath, 'utf8').catch(() => '');

    const lines = existing.split(/\r?\n/);
    const isIgnored = lines.some((line) => {
      const trimmed = line.trim();
      return (
        trimmed === firstSegment ||
        trimmed === `${firstSegment}/` ||
        trimmed === `/${firstSegment}/` ||
        trimmed === `/${firstSegment}`
      );
    });

    if (isIgnored) {
      return;
    }

    let shouldAdd = false;
    if (yesOption) {
      shouldAdd = true;
    } else if (this.prompts.confirm) {
      shouldAdd = await this.prompts.confirm(
        `Would you like to add "${firstSegment}/" to your .gitignore?`,
        [
          `AgentPM manages links inside "${firstSegment}/" which should not be committed to Git.`,
        ],
      );
    } else {
      shouldAdd = true;
    }

    if (shouldAdd) {
      const prefix =
        existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
      const header = existing.includes('# AgentPM')
        ? ''
        : '\n# AgentPM managed folders\n';
      await fs.appendFile(
        gitignorePath,
        `${prefix}${header}${firstSegment}/\n`,
        'utf8',
      );
    }
  }

  private async isGitTrackedPath(
    scopeRoot: string,
    targetPath: string,
  ): Promise<boolean> {
    const gitDir = path.join(scopeRoot, '.git');
    const gitStats = await fs.stat(gitDir).catch(() => null);
    if (!gitStats?.isDirectory()) {
      return false;
    }

    const relativePath = path.relative(scopeRoot, targetPath);
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      path.isAbsolute(relativePath)
    ) {
      return false;
    }

    try {
      await execFileAsync(
        'git',
        ['ls-files', '--error-unmatch', toPosixPath(relativePath)],
        {
          cwd: scopeRoot,
        },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async prepareInspectionTarget(
    locator: string,
    kind: SourceKind,
    options: { sourceId?: string | null } = {},
  ): Promise<PreparedContent> {
    if (kind === 'local') {
      const normalized = path.resolve(locator);
      const localGit = await isLocalGitRepository(normalized);
      const report = await inspectRepository(normalized, normalized, 'local');
      return {
        report,
        contentKind: localGit ? 'git' : 'local',
        contentLocator: normalized,
        contentRef: null,
        revision: localGit
          ? await resolveGitRevision(normalized, undefined, this.env)
          : null,
        repoRoot: normalized,
        cacheKey: null,
      };
    }

    return this.prepareGitContent(locator, {
      sourceId: options.sourceId ?? null,
      sparsePaths: [],
      requireFullCheckout: true,
    });
  }

  private async resolveSourceForInstall(
    sourceToken: string,
    addSource = false,
    skipConfirmation = false,
  ): Promise<ResolvedInstallSource> {
    const existing = this.findSourceByToken(sourceToken);
    if (existing) {
      return {
        source: existing,
        entries: this.db.listCatalogEntriesBySource(existing.id),
        persisted: existing.metadata.transient !== true,
      };
    }

    const kind = await this.classifySource(sourceToken);
    const normalizedLocator = this.normalizeLocator(sourceToken, kind);
    if (addSource) {
      const added = await this.addSource(normalizedLocator);
      return {
        source: added.source,
        entries: this.db.listCatalogEntriesBySource(added.source.id),
        persisted: true,
      };
    }

    this.reportStatus(
      `Resolving one-off source ${displayNameFromLocator(normalizedLocator)}...`,
    );
    if (!skipConfirmation && this.prompts.confirm) {
      const shouldAdd = await this.prompts.confirm(
        'Add this repo as a permanent AgentPM source?',
        [normalizedLocator],
      );
      if (shouldAdd) {
        const added = await this.addSource(normalizedLocator);
        return {
          source: added.source,
          entries: this.db.listCatalogEntriesBySource(added.source.id),
          persisted: true,
        };
      }
    }

    const preview = await this.listSourceEntries(normalizedLocator);
    const transientId = makeId('temp-src', kind, normalizedLocator);
    const source: SourceRecord = {
      id: transientId,
      kind,
      locator: normalizedLocator,
      normalizedLocator,
      displayName: displayNameFromLocator(normalizedLocator),
      metadata: { transient: true },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const storedSource = this.db.upsertSource(source);
    const entries = preview.entries.map(
      (entry) =>
        ({
          id: makeId(
            'temp-cat',
            transientId,
            entry.name,
            entry.repo,
            entry.path ?? '',
          ),
          sourceId: transientId,
          name: entry.name,
          description: entry.description,
          repo: entry.repo,
          ref: null,
          path: entry.path,
          adapterHint: entry.adapter,
          tags: entry.adapter ? [entry.adapter] : [],
          metadata: entry.archive
            ? {
                archive: true,
                archiveVersion: entry.version ?? null,
                archiveKind: entry.kind ?? null,
              }
            : {},
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }) satisfies CatalogEntryRecord,
    );
    this.db.replaceCatalogEntries(storedSource.id, entries);
    return {
      source: storedSource,
      entries: this.db.listCatalogEntriesBySource(storedSource.id),
      persisted: false,
    };
  }

  private async prepareGitContent(
    locator: string,
    options: {
      sourceId: string | null;
      ref?: string | null | undefined;
      revision?: string | null | undefined;
      sparsePaths: string[];
      requireFullCheckout?: boolean | undefined;
    },
  ): Promise<PreparedContent> {
    const requestedRef = options.revision ?? options.ref ?? null;
    const cacheKey = makeId('cache', locator, requestedRef ?? 'HEAD');
    const cacheBasePath = this.cacheBasePath(cacheKey);
    const existingCache = this.db.getCacheRepo(cacheKey);
    const installCount = this.db.countInstallsForCacheKey(cacheKey);
    const requireFullCheckout = Boolean(options.requireFullCheckout);
    const hasFullCheckout = existingCache?.metadata.fullCheckout === true;

    if (requireFullCheckout && existingCache && !hasFullCheckout) {
      if (installCount > 0) {
        const release = await createTemporaryGitRelease(
          locator,
          [],
          undefined,
          this.env,
        );
        const report = await inspectRepository(
          release.releasePath,
          locator,
          'git',
        );
        return {
          report,
          contentKind: 'git',
          contentLocator: locator,
          contentRef: requestedRef,
          revision: release.revision,
          repoRoot: release.releasePath,
          cacheKey: null,
          cleanup: async () => cleanupTemporaryRelease(release.releasePath),
        };
      }

      await fs.rm(cacheBasePath, { recursive: true, force: true });
      this.db.deleteCacheRepo(cacheKey);
    }

    const sparsePaths = requireFullCheckout
      ? []
      : normalizeSparsePaths(options.sparsePaths);
    this.reportStatus(
      existingCache
        ? 'Refreshing cached repository checkout...'
        : 'Cloning repository into local cache...',
    );
    let release = await materializeGitRelease({
      locator,
      basePath: cacheBasePath,
      sparsePaths,
      ref: options.ref,
      revision: options.revision ?? null,
      env: this.env,
    });
    let report = await inspectRepository(release.releasePath, locator, 'git');

    if (!requireFullCheckout && sparsePaths.length > 0) {
      const detectedEntries = listInstallableEntries(report);
      if (detectedEntries.length === 0) {
        if (installCount > 0) {
          const fallback = await createTemporaryGitRelease(
            locator,
            [],
            options.ref ?? undefined,
            this.env,
          );
          report = await inspectRepository(
            fallback.releasePath,
            locator,
            'git',
          );
          return {
            report,
            contentKind: 'git',
            contentLocator: locator,
            contentRef: requestedRef,
            revision: fallback.revision,
            repoRoot: fallback.releasePath,
            cacheKey: null,
            cleanup: async () => cleanupTemporaryRelease(fallback.releasePath),
          };
        }

        await fs.rm(cacheBasePath, { recursive: true, force: true });
        this.db.deleteCacheRepo(cacheKey);
        this.reportStatus('Retrying with a full repository checkout...');
        release = await materializeGitRelease({
          locator,
          basePath: cacheBasePath,
          sparsePaths: [],
          ref: options.ref,
          revision: options.revision ?? null,
          env: this.env,
        });
        report = await inspectRepository(release.releasePath, locator, 'git');
      }
    }

    const metadata = {
      ...(existingCache?.metadata ?? {}),
      fullCheckout:
        requireFullCheckout ||
        existingCache?.metadata.fullCheckout === true ||
        sparsePaths.length === 0,
      sparsePaths,
    };
    this.db.saveCacheRepo({
      cacheKey,
      sourceId: options.sourceId ?? existingCache?.sourceId ?? null,
      locator,
      kind: 'git',
      basePath: cacheBasePath,
      currentRevision: release.revision,
      isGit: true,
      layoutSignature: report.layoutSignature,
      metadata,
      updatedAt: nowIso(),
    });

    return {
      report,
      contentKind: 'git',
      contentLocator: locator,
      contentRef: requestedRef,
      revision: release.revision,
      repoRoot: release.releasePath,
      cacheKey,
    };
  }

  private async resolveSelections(
    names: string[],
    options: InstallOptions,
  ): Promise<Array<{ source: SourceRecord; entry: CatalogEntryRecord }>> {
    const forcedInstallSource = options.from
      ? await this.resolveSourceForInstall(
          options.from,
          options.addSource,
          Boolean(options.yes),
        )
      : null;
    const forcedSource = forcedInstallSource?.source ?? null;
    const requestedNames =
      options.skills && options.skills.length > 0 ? options.skills : names;

    if (forcedSource) {
      const entries = (
        forcedInstallSource?.persisted
          ? this.db.listCatalogEntriesBySource(forcedSource.id)
          : (forcedInstallSource?.entries ?? [])
      ).filter((entry) => matchesCatalogEntryTarget(entry, options.target));

      if (entries.length === 0) {
        const targetSummary = options.target ? ` for ${options.target}` : '';
        throw new AgentPmError(
          `No installable entries${targetSummary} were found in source ${forcedSource.displayName}. Run "agentpm source skills ${forcedSource.id}" or "agentpm inspect ${forcedSource.locator}" for details.`,
        );
      }

      if (options.all) {
        const filtered = entries.filter(
          (entry) =>
            requestedNames.length === 0 ||
            requestedNames.some((skillSelector) =>
              matchesCatalogEntrySelector(entry, skillSelector),
            ),
        );
        if (filtered.length === 0) {
          const targetSummary = options.target ? ` for ${options.target}` : '';
          throw new AgentPmError(
            `No requested skills${targetSummary} were found in source ${forcedSource.displayName}.`,
          );
        }
        return filtered.map((entry) => ({ source: forcedSource, entry }));
      }

      if (requestedNames.length > 0) {
        return this.resolveNamedSelectionsFromSource(
          forcedSource,
          entries,
          requestedNames,
          options.target,
        );
      }

      if (entries.length === 1) {
        return [{ source: forcedSource, entry: entries[0]! }];
      }

      if (this.prompts.selectMany) {
        const selected = await this.prompts.selectMany(
          `Choose skills to install from ${forcedSource.displayName}:`,
          entries.map((entry) => ({
            label: entry.name,
            description: `${entry.adapterHint ?? 'unknown'}  ${entry.path ?? entry.repo}`,
            value: entry,
          })),
        );
        if (selected.length === 0) {
          return [];
        }
        return selected.map((entry) => ({ source: forcedSource, entry }));
      }

      const available = entries
        .map((entry) => `  - ${entry.name} (${entry.path ?? entry.repo})`)
        .join('\n');
      throw new AgentPmError(
        `Multiple installable entries were found in source ${forcedSource.displayName}. Re-run interactively, pass --skill <name>, or use --all.\n\nAvailable entries:\n${available}`,
      );
    }

    const sources = this.listSources();
    if (sources.length === 0) {
      throw new AgentPmError(
        'No sources have been added yet. Use "agentpm source add" first.',
      );
    }

    if (options.all) {
      const sourceToken = names[0];
      let source = sourceToken ? this.findSourceByToken(sourceToken) : null;
      if (!source) {
        if (!this.prompts.selectOne) {
          throw new AgentPmError(
            'Installing all entries requires a source argument or an interactive TTY.',
          );
        }
        source = await this.prompts.selectOne(
          'Choose a source to install from:',
          sources.map((candidate) => ({
            label: candidate.displayName,
            description: candidate.locator,
            value: candidate,
          })),
        );
      }

      const entries = this.db
        .listCatalogEntriesBySource(source.id)
        .filter(
          (entry) =>
            (!options.skills ||
              options.skills.length === 0 ||
              options.skills.some((skillSelector) =>
                matchesCatalogEntrySelector(entry, skillSelector),
              )) &&
            matchesCatalogEntryTarget(entry, options.target),
        );
      if (entries.length === 0) {
        throw new AgentPmError(
          `No installable entries found for source ${source.displayName}.`,
        );
      }
      return entries.map((entry) => ({ source, entry }));
    }

    if (names.length === 1 && options.skills && options.skills.length > 0) {
      const source = this.findSourceByToken(names[0]!);
      if (source) {
        const entries = this.db
          .listCatalogEntriesBySource(source.id)
          .filter(
            (entry) =>
              Boolean(
                options.skills?.some((skillSelector) =>
                  matchesCatalogEntrySelector(entry, skillSelector),
                ),
              ) && matchesCatalogEntryTarget(entry, options.target),
          );
        if (entries.length === 0) {
          const targetSummary = options.target ? ` for ${options.target}` : '';
          throw new AgentPmError(
            `No requested skills${targetSummary} were found in source ${source.displayName}.`,
          );
        }
        return entries.map((entry) => ({ source, entry }));
      }
    }

    if (requestedNames.length === 0) {
      if (!this.prompts.selectOne) {
        throw new AgentPmError(
          'No install target supplied. Re-run interactively or provide a skill name.',
        );
      }

      const allEntries = this.db.listCatalogEntries();
      if (allEntries.length === 0) {
        throw new AgentPmError(
          'No catalog entries are indexed yet. Add a source first.',
        );
      }

      const entry = await this.prompts.selectOne(
        'Choose an entry to install:',
        allEntries.map((candidate) => {
          const source = this.db.getSource(candidate.sourceId);
          return {
            label: candidate.name,
            description: source
              ? `${source.displayName} · ${candidate.repo}`
              : candidate.repo,
            value: candidate,
          };
        }),
      );
      const source = this.db.getSource(entry.sourceId);
      if (!source) {
        throw new AgentPmError(
          `Missing source for catalog entry ${entry.name}`,
        );
      }
      return [{ source, entry }];
    }

    const selections: Array<{
      source: SourceRecord;
      entry: CatalogEntryRecord;
    }> = [];
    for (const requestedName of requestedNames) {
      const matches = this.db
        .listCatalogEntries()
        .filter(
          (entry) =>
            matchesCatalogEntrySelector(entry, requestedName) &&
            matchesCatalogEntryTarget(entry, options.target),
        );
      if (matches.length === 0) {
        const targetSummary = options.target
          ? ` for target "${options.target}"`
          : '';
        throw new AgentPmError(
          `No catalog entry named "${requestedName}"${targetSummary} found.`,
        );
      }

      let entry = matches[0]!;
      if (matches.length > 1) {
        if (!this.prompts.selectOne) {
          throw new AgentPmError(
            `Multiple catalog entries named "${requestedName}" found. Re-run interactively.`,
          );
        }
        entry = await this.prompts.selectOne(
          `Choose which "${requestedName}" entry to install:`,
          matches.map((candidate) => {
            const source = this.db.getSource(candidate.sourceId);
            return {
              label: `${candidate.name} (${source?.displayName ?? candidate.sourceId})`,
              description: candidate.repo,
              value: candidate,
            };
          }),
        );
      }

      const source = this.db.getSource(entry.sourceId);
      if (!source) {
        throw new AgentPmError(
          `Missing source for catalog entry ${entry.name}`,
        );
      }
      selections.push({ source, entry });
    }

    return selections;
  }

  private async resolveNamedSelectionsFromSource(
    source: SourceRecord,
    entries: CatalogEntryRecord[],
    selectors: string[],
    target?: AdapterId,
  ): Promise<Array<{ source: SourceRecord; entry: CatalogEntryRecord }>> {
    const selections: Array<{
      source: SourceRecord;
      entry: CatalogEntryRecord;
    }> = [];
    for (const selector of selectors) {
      const matches = entries.filter((entry) =>
        matchesCatalogEntrySelector(entry, selector),
      );
      if (matches.length === 0) {
        const targetSummary = target ? ` for target "${target}"` : '';
        throw new AgentPmError(
          `No catalog entry named "${selector}"${targetSummary} found in source ${source.displayName}.`,
        );
      }

      let entry = matches[0]!;
      if (matches.length > 1) {
        if (!this.prompts.selectOne) {
          const available = matches
            .map(
              (candidate) =>
                `  - ${candidate.name} (${candidate.path ?? candidate.repo})`,
            )
            .join('\n');
          throw new AgentPmError(
            `Multiple entries named "${selector}" were found in source ${source.displayName}. Re-run interactively or use a more specific path selector.\n\nMatches:\n${available}`,
          );
        }
        entry = await this.prompts.selectOne(
          `Choose which "${selector}" entry to install from ${source.displayName}:`,
          matches.map((candidate) => ({
            label: candidate.name,
            description: `${candidate.adapterHint ?? 'unknown'}  ${candidate.path ?? candidate.repo}`,
            value: candidate,
          })),
        );
      }

      selections.push({ source, entry });
    }

    return selections;
  }

  private async resolveScope(scope?: InstallScope): Promise<InstallScope> {
    if (scope) {
      return scope;
    }

    if (this.prompts.selectOne) {
      return this.prompts.selectOne('Choose an install scope:', [
        { label: 'Project', description: this.cwd, value: 'project' as const },
        {
          label: 'Global',
          description: 'Install into your home directory native target',
          value: 'global' as const,
        },
        {
          label: 'Workspace',
          description: 'Install into a workspace root',
          value: 'workspace' as const,
        },
      ]);
    }

    return 'project';
  }

  private async prepareContentForEntry(
    entry: CatalogEntryRecord,
    source: SourceRecord,
    overrides: {
      ref?: string | null | undefined;
      revision?: string | null | undefined;
    },
  ): Promise<PreparedContent> {
    if (entry.metadata.archive === true) {
      return this.prepareArchiveContent(entry);
    }
    const contentLocator = this.resolveContentLocator(entry.repo);
    const requestedRef =
      overrides.revision ?? overrides.ref ?? entry.ref ?? null;
    const contentKind = await this.resolveContentKind(contentLocator);

    if (contentKind === 'local') {
      return {
        report: await inspectRepository(
          contentLocator,
          contentLocator,
          'local',
        ),
        contentKind,
        contentLocator,
        contentRef: requestedRef,
        revision: null,
        repoRoot: contentLocator,
        cacheKey: null,
      };
    }
    // Plugin roots can contain arbitrary directories (.claude-plugin, commands,
    // hooks, ...), so a plugin at the repository root needs a full checkout; a
    // nested plugin is covered by its own subtree sparse path.
    const isPlugin = entry.tags.includes('plugin');
    if (isPlugin && (!entry.path || entry.path === '.')) {
      return this.prepareGitContent(contentLocator, {
        sourceId: source.id,
        ref: requestedRef,
        revision: overrides.revision ?? null,
        sparsePaths: [],
        requireFullCheckout: true,
      });
    }
    return this.prepareGitContent(contentLocator, {
      sourceId: source.id,
      ref: requestedRef,
      revision: overrides.revision ?? null,
      sparsePaths: [entry.path ?? '', ...DEFAULT_DISCOVERY_PATHS],
    });
  }

  // Registry-server entries carry an archive URL instead of a git repo. The
  // archive is a JSON file bundle that is materialized into a per-revision
  // release directory under the cache, mirroring the git cache layout so
  // installs can symlink into it and updates can swap revisions.
  private async prepareArchiveContent(
    entry: CatalogEntryRecord,
  ): Promise<PreparedContent> {
    const url = entry.repo;
    this.reportStatus(`Downloading skill archive for ${entry.name}...`);
    const { archive, raw } = await fetchSkillArchive(url, this.env);
    const revision = createHash('sha256').update(raw).digest('hex');
    const cacheKey = makeId('cache', 'archive', entry.sourceId, entry.name);
    const cacheBasePath = this.cacheBasePath(cacheKey);
    const releasePath = resolveReleasePath(cacheBasePath, revision);
    const rootDir =
      archive.kind === 'skill' || archive.kind === 'subagent'
        ? path.join(releasePath, 'skills', archive.name)
        : path.join(releasePath, archive.name);

    if (!(await pathExists(rootDir))) {
      await fs.rm(releasePath, { recursive: true, force: true });
      await materializeArchive(archive, rootDir);
    }

    const report = await inspectRepository(releasePath, url, 'local');
    this.db.saveCacheRepo({
      cacheKey,
      sourceId: entry.sourceId,
      locator: url,
      kind: 'local',
      basePath: cacheBasePath,
      currentRevision: revision,
      isGit: false,
      layoutSignature: report.layoutSignature,
      metadata: {
        archive: true,
        archiveVersion: archive.version,
        archiveKind: archive.kind,
      },
      updatedAt: nowIso(),
    });

    return {
      report,
      contentKind: 'local',
      contentLocator: url,
      contentRef: null,
      revision,
      repoRoot: releasePath,
      cacheKey,
      archive: { version: archive.version },
    };
  }

  private async prepareGitCandidateFromInstall(
    install: InstallRecord,
    revision: string,
  ): Promise<PreparedContent> {
    // Reuse the install's own cache key. Deriving a fresh key from (locator,
    // ref) diverges from the install-time key whenever the install pinned a
    // revision (e.g. from `agentpm sync`), which left the materialized release
    // untracked in cache_repos — so `cache clean` would delete the live
    // install content. Registering the cache row keeps that sweep away.
    const cacheKey =
      install.cacheKey ??
      makeId('cache', install.contentLocator, install.contentRef ?? 'HEAD');
    const cacheBasePath = this.cacheBasePath(cacheKey);
    const release = await materializeGitRelease({
      locator: install.contentLocator,
      basePath: cacheBasePath,
      sparsePaths: normalizeSparsePaths([install.sourceRelativePath]),
      ref: install.contentRef,
      revision,
      env: this.env,
    });
    const report = await inspectRepository(
      release.releasePath,
      install.contentLocator,
      'git',
    );
    const existingCache = this.db.getCacheRepo(cacheKey);
    this.db.saveCacheRepo({
      cacheKey,
      sourceId: existingCache?.sourceId ?? install.sourceId,
      locator: install.contentLocator,
      kind: 'git',
      basePath: cacheBasePath,
      currentRevision: release.revision,
      isGit: true,
      layoutSignature: report.layoutSignature,
      metadata: existingCache?.metadata ?? {},
      updatedAt: nowIso(),
    });
    return {
      report,
      contentKind: 'git',
      contentLocator: install.contentLocator,
      contentRef: install.contentRef,
      revision: release.revision,
      repoRoot: release.releasePath,
      cacheKey,
    };
  }

  private resolveContentLocator(locator: string): string {
    const normalizedGithub = normalizeGitHubRepoLocator(locator);
    if (
      normalizedGithub.includes('://') ||
      normalizedGithub.includes('@') ||
      normalizedGithub.endsWith('.git') ||
      normalizedGithub.startsWith('github:')
    ) {
      return normalizedGithub;
    }
    return path.resolve(this.cwd, locator);
  }

  private normalizeTargetToken(token: string): string {
    return normalizeGitHubRepoLocator(token.trim());
  }

  private async resolveContentKind(locator: string): Promise<ContentKind> {
    if (inferContentKind(locator) === 'git') {
      return 'git';
    }
    return (await isLocalGitRepository(locator)) ? 'git' : 'local';
  }

  private filterInstallsByName(names?: string[]): InstallRecord[] {
    if (!names || names.length === 0) {
      return this.db.listInstalls();
    }
    const requested = new Set(names);
    return this.db
      .listInstalls()
      .filter((install) => requested.has(install.name));
  }

  private resolveProviderInstalls(identifiers: string[]): InstallRecord[] {
    const providerInstalls = this.db
      .listInstalls()
      .filter((install) => install.metadata.provider === 'skills.sh');
    if (identifiers.length === 0) {
      return providerInstalls;
    }

    const matches: InstallRecord[] = [];
    const matchedIds = new Set<string>();
    for (const identifier of identifiers) {
      const requested = identifier.trim();
      const directMatches = providerInstalls.filter((install) => {
        const providerSelector =
          typeof install.metadata.providerSkillSelector === 'string'
            ? install.metadata.providerSkillSelector
            : null;
        return install.name === requested || providerSelector === requested;
      });
      if (directMatches.length === 0) {
        throw new AgentPmError(
          `No skills.sh install matching "${requested}" was found.`,
        );
      }
      for (const install of directMatches) {
        if (!matchedIds.has(install.id)) {
          matchedIds.add(install.id);
          matches.push(install);
        }
      }
    }
    return matches;
  }

  private async resolveProviderInstall(
    identifier: string,
    options: RemoveInstallOptions,
  ): Promise<InstallRecord> {
    const matches = this.filterRemoveCandidates(
      this.resolveProviderInstalls([identifier]),
      options,
    );
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (matches.length === 0) {
      throw new AgentPmError(
        `No skills.sh install matching "${identifier}" was found.`,
      );
    }
    const available = this.formatRemoveCandidates(matches);
    const hasExplicitFilter =
      Boolean(options.adapter) ||
      Boolean(options.scope) ||
      Boolean(options.targetPath);
    if (!this.prompts.selectOne) {
      throw new AgentPmError(
        `Multiple skills.sh installs match "${identifier}". Re-run with --target, --scope, or --path to choose one.\n\nMatches:\n${available}`,
      );
    }
    if (hasExplicitFilter) {
      throw new AgentPmError(
        `Multiple skills.sh installs still match "${identifier}" with the supplied filters. Add --path to choose one.\n\nMatches:\n${available}`,
      );
    }
    return this.prompts.selectOne(
      `Choose which "${identifier}" skills.sh install to remove:`,
      matches.map((install) => ({
        label:
          typeof install.metadata.providerSkillSelector === 'string'
            ? install.metadata.providerSkillSelector
            : install.name,
        description: install.targetPath,
        value: install,
      })),
    );
  }

  private filterRemoveCandidates(
    installs: InstallRecord[],
    options: RemoveInstallOptions,
  ): InstallRecord[] {
    return installs.filter((install) => {
      if (options.adapter && install.adapter !== options.adapter) {
        return false;
      }
      if (options.scope && install.scope !== options.scope) {
        return false;
      }
      if (
        options.targetPath &&
        path.resolve(install.targetPath) !==
          path.resolve(this.cwd, options.targetPath)
      ) {
        return false;
      }
      return true;
    });
  }

  private formatRemoveCandidates(installs: InstallRecord[]): string {
    return installs
      .map(
        (candidate) =>
          `- ${candidate.name}: target=${candidate.adapter}, scope=${candidate.scope}, path=${candidate.targetPath}`,
      )
      .join('\n');
  }

  private async removeInstallRecord(
    install: InstallRecord,
    options: RemoveInstallOptions,
  ): Promise<InstallRecord> {
    await removeManagedLink(install.targetPath);
    this.db.removeInstall(install.id);

    if (
      options.purge &&
      install.cacheKey &&
      this.db.countInstallsForCacheKey(install.cacheKey) === 0
    ) {
      await fs.rm(this.cacheBasePath(install.cacheKey), {
        recursive: true,
        force: true,
      });
    }

    // If this was a plugin install, refresh its agent's managed marketplace.
    if (this.isPluginInstall(install)) {
      await this.syncPluginMarketplace(install.scopeRoot, install.adapter);
    }

    return install;
  }

  private isPluginInstall(install: InstallRecord): boolean {
    const pluginRoot = path.resolve(
      install.scopeRoot,
      nativePluginRoot(install.adapter),
    );
    return path
      .resolve(install.targetPath)
      .startsWith(pluginRoot + path.sep);
  }

  // Keeps a managed plugin marketplace in sync with the plugin directories
  // AgentPM installs under <scopeRoot>/.agentpm/plugins/<adapter>/plugins/*, in
  // the native format each host discovers:
  //   claude -> <root>/.claude-plugin/marketplace.json
  //   codex  -> <root>/.agents/plugins/marketplace.json
  // Returns the marketplace name.
  private async syncPluginMarketplace(
    scopeRoot: string,
    adapter: AdapterId,
  ): Promise<string> {
    const root = path.join(scopeRoot, nativePluginRoot(adapter));
    const pluginsRoot = path.join(root, 'plugins');
    const marketplaceName =
      path.resolve(scopeRoot) === path.resolve(os.homedir())
        ? 'agentpm'
        : `agentpm-${slugify(path.basename(scopeRoot))}`;
    const manifestRelDir =
      adapter === 'codex' ? path.join('.agents', 'plugins') : '.claude-plugin';
    const manifestPath = path.join(root, manifestRelDir, 'marketplace.json');

    const discovered: Array<{
      name: string;
      description?: string | undefined;
      version?: string | undefined;
    }> = [];
    if (await pathExists(pluginsRoot)) {
      const children = await fs.readdir(pluginsRoot, { withFileTypes: true });
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        const childPath = path.join(pluginsRoot, child.name);
        try {
          const stats = await fs.stat(childPath);
          if (!stats.isDirectory()) {
            continue;
          }
        } catch {
          continue;
        }
        const manifestDir =
          adapter === 'codex' ? '.codex-plugin' : '.claude-plugin';
        let description: string | undefined;
        let version: string | undefined;
        try {
          const manifest = JSON.parse(
            await fs.readFile(
              path.join(childPath, manifestDir, 'plugin.json'),
              'utf8',
            ),
          ) as Record<string, unknown>;
          description =
            typeof manifest.description === 'string'
              ? manifest.description
              : undefined;
          version =
            typeof manifest.version === 'string' ? manifest.version : undefined;
        } catch {
          // Plugins without their own manifest are still listed by path.
        }
        discovered.push({ name: child.name, description, version });
      }
    }

    if (discovered.length === 0) {
      await fs.rm(path.join(root, manifestRelDir), {
        recursive: true,
        force: true,
      });
      return marketplaceName;
    }

    const manifest =
      adapter === 'codex'
        ? {
            name: marketplaceName,
            interface: { displayName: 'AgentPM' },
            plugins: discovered.map((plugin) => ({
              name: plugin.name,
              source: { source: 'local', path: `./plugins/${plugin.name}` },
              policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
              ...(plugin.description
                ? { description: plugin.description }
                : {}),
            })),
          }
        : {
            name: marketplaceName,
            owner: { name: 'AgentPM' },
            plugins: discovered.map((plugin) => ({
              name: plugin.name,
              source: `./plugins/${plugin.name}`,
              ...(plugin.description
                ? { description: plugin.description }
                : {}),
              ...(plugin.version ? { version: plugin.version } : {}),
            })),
          };

    await ensureDir(path.dirname(manifestPath));
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    return marketplaceName;
  }

  private async previewLocalInstallUpdate(
    install: InstallRecord,
    source: SourceRecord | null,
  ): Promise<UpdatePreview> {
    const currentPath = path.join(
      install.contentLocator,
      install.sourceRelativePath,
    );
    const currentExists = await pathExists(currentPath);
    const currentRevision = currentExists
      ? await computeTreeSignature(currentPath)
      : null;
    return {
      install,
      source,
      changed: currentRevision !== install.installedRevision,
      currentRevision: install.installedRevision,
      candidateRevision: currentRevision,
      diff: [],
      risk: currentExists ? 'safe' : 'breaking',
      warnings: currentExists
        ? ['Live local folder install; detailed diff is not available.']
        : ['Source path is missing.'],
      nextLinkTarget: currentExists ? currentPath : null,
    };
  }

  private async previewArchiveInstallUpdate(
    install: InstallRecord,
    source: SourceRecord | null,
  ): Promise<UpdatePreview> {
    // Registry archive URLs are version-pinned, so only a catalog reindex
    // surfaces a newer version. Do it here (transient one-off `--from` sources
    // are skipped by refreshSources), giving archive installs the same live
    // update behavior as git installs.
    if (source && source.kind === 'registry') {
      try {
        await this.reindexSource(source);
      } catch {
        // Fall back to the cached catalog entry / install-time URL below.
      }
    }
    // Prefer the freshest catalog entry (refresh replaces archive URLs when a
    // new version is published); fall back to the URL recorded at install time.
    const entry = this.db
      .listCatalogEntriesBySource(install.sourceId)
      .find(
        (candidate) =>
          candidate.metadata.archive === true &&
          candidate.name === install.name,
      );

    let prepared: PreparedContent;
    try {
      prepared = entry
        ? await this.prepareArchiveContent(entry)
        : await this.prepareArchiveContent({
            id: install.catalogEntryId ?? install.id,
            sourceId: install.sourceId,
            name: install.name,
            description: null,
            repo: install.contentLocator,
            ref: null,
            path: null,
            adapterHint: install.adapter,
            tags: [],
            metadata: { archive: true },
            createdAt: install.createdAt,
            updatedAt: install.updatedAt,
          });
    } catch (error) {
      return {
        install,
        source,
        changed: false,
        currentRevision: install.installedRevision,
        candidateRevision: null,
        diff: [],
        risk: 'breaking',
        warnings: [
          `Could not check the registry for updates: ${error instanceof Error ? error.message : String(error)}`,
        ],
        nextLinkTarget: null,
      };
    }

    if (prepared.revision === install.installedRevision) {
      return {
        install,
        source,
        changed: false,
        currentRevision: install.installedRevision,
        candidateRevision: prepared.revision,
        diff: [],
        risk: 'safe',
        warnings: [],
        nextLinkTarget: install.linkTarget,
      };
    }

    const adapter = getAdapter(install.adapter);
    const updateResult = adapter.update(install, prepared.report);
    const nextLinkTarget = updateResult.nextRelativePath
      ? path.join(prepared.repoRoot, updateResult.nextRelativePath)
      : null;
    const diff =
      nextLinkTarget && (await pathExists(install.linkTarget))
        ? await diffTrees(install.linkTarget, nextLinkTarget)
        : [];

    return {
      install,
      source,
      changed: true,
      currentRevision: install.installedRevision,
      candidateRevision: prepared.revision,
      diff,
      risk: updateResult.risk,
      warnings: updateResult.warnings,
      nextLinkTarget,
    };
  }
}

function resolveRegistryRepo(registryLocator: string, repo: string): string {
  if (repo.includes('://') || repo.includes('@') || repo.endsWith('.git')) {
    return repo;
  }

  if (registryLocator.includes('://')) {
    return new URL(repo, registryLocator).toString();
  }

  return path.resolve(path.dirname(registryLocator), repo);
}
