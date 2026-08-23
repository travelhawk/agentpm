import path from 'node:path';

import {
  listChildDirectories,
  pathExists,
  readTextFile,
  walkFiles,
} from '@agentpm/fs';
import {
  AgentPmError,
  stableHash,
  toPosixPath,
  isHttpUrl,
  type AdapterCompatibility,
  type AdapterId,
  type AdapterUpdateResult,
  type DetectedEntry,
  type DetectedGroup,
  type DetectedScript,
  type InspectionReport,
  type InspectionTrust,
  type InstallMapping,
  type InstallRecord,
  type SourceKind,
} from '@agentpm/shared';

export interface SkillAdapter {
  id: AdapterId;
  detect(rootPath: string): Promise<DetectedGroup[]>;
  scoreCompatibility(report: InspectionReport): AdapterCompatibility;
  install(entry: DetectedEntry, scopeRoot: string): Promise<InstallMapping>;
  update(record: InstallRecord, report: InspectionReport): AdapterUpdateResult;
  remove(record: InstallRecord): string[];
  validate(report: InspectionReport, entry: DetectedEntry): string[];
}

interface LayoutDefinition {
  adapter: AdapterId;
  label: string;
  relativeRoot: string;
  kind: DetectedGroup['kind'];
}

const LAYOUTS: LayoutDefinition[] = [
  {
    adapter: 'codex',
    label: 'Codex skills',
    relativeRoot: '.codex/skills',
    kind: 'skill',
  },
  {
    adapter: 'codex',
    label: 'Codex cloud skills',
    relativeRoot: '.codex.cloud/skills',
    kind: 'skill',
  },
  {
    adapter: 'claude',
    label: 'Claude skills',
    relativeRoot: '.claude/skills',
    kind: 'skill',
  },
  {
    adapter: 'claude',
    label: 'Claude agents',
    relativeRoot: '.claude/agents',
    kind: 'agent',
  },
  {
    adapter: 'generic',
    label: 'Generic skills',
    relativeRoot: '.agents/skills',
    kind: 'skill',
  },
  {
    adapter: 'generic',
    label: 'Generic skills',
    relativeRoot: 'skills',
    kind: 'skill',
  },
  {
    adapter: 'generic',
    label: 'Subagents',
    relativeRoot: 'subagents',
    kind: 'subagent',
  },
  {
    adapter: 'generic',
    label: 'Deep skills',
    relativeRoot: '',
    kind: 'skill',
  },
];

// Native skill directory per agent. Skills are transformed into the chosen
// agent's root on install/pull (canonical + transform model).
const SKILL_ROOTS: Record<AdapterId, string> = {
  codex: '.codex/skills',
  claude: '.claude/skills',
  generic: '.agents/skills',
};

export function nativeSkillRoot(adapter: AdapterId): string {
  return SKILL_ROOTS[adapter];
}

const SCRIPT_PATTERNS = [/^install\.(sh|ps1|js|mjs|cjs|ts)$/i];
const ENTRY_MARKERS: Record<DetectedGroup['kind'], string[]> = {
  skill: ['SKILL.md'],
  subagent: ['SKILL.md'],
  agent: ['README.md', 'AGENT.md', 'CLAUDE.md'],
  // Plugins are detected by dedicated marker logic (.claude-plugin/plugin.json),
  // not by the generic layout scan.
  plugin: [],
};

// AgentPM keeps installed plugins under a per-agent managed marketplace root so
// each host reads its own native manifest without clashing:
//   claude -> <root>/.claude-plugin/marketplace.json   (`claude plugin marketplace add <root>`)
//   codex  -> <root>/.agents/plugins/marketplace.json   (`codex plugin marketplace add <root>`)
// Plugins live at <root>/plugins/<name>, mirroring the openai/plugins layout.
const PLUGIN_ROOTS: Partial<Record<AdapterId, string>> = {
  claude: '.agentpm/plugins/claude',
  codex: '.agentpm/plugins/codex',
};

export const PLUGIN_ADAPTERS: AdapterId[] = ['claude', 'codex'];

export function nativePluginRoot(adapter: AdapterId): string {
  return PLUGIN_ROOTS[adapter] ?? '.agentpm/plugins/generic';
}

export function pluginTargetRelativePath(
  adapter: AdapterId,
  name: string,
): string {
  return toPosixPath(path.join(nativePluginRoot(adapter), 'plugins', name));
}

// Per-agent plugin manifest markers. A repo is a plugin for an agent when it
// carries that agent's `<marker>/plugin.json`; marketplaces are listed under
// the marketplace file names Codex/Claude Code discover.
interface PluginMarker {
  adapter: AdapterId;
  manifestDir: string;
  marketplaceFiles: string[];
  label: string;
}

const PLUGIN_MARKERS: PluginMarker[] = [
  {
    adapter: 'claude',
    manifestDir: '.claude-plugin',
    marketplaceFiles: ['.claude-plugin/marketplace.json'],
    label: 'Claude Code plugins',
  },
  {
    adapter: 'codex',
    manifestDir: '.codex-plugin',
    marketplaceFiles: [
      '.agents/plugins/marketplace.json',
      '.agents/plugins/api_marketplace.json',
    ],
    label: 'Codex plugins',
  },
];

const SAFE_PLUGIN_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

// A plugin name becomes a directory segment under the managed plugin root, so
// it must be a single safe path segment. Untrusted repos can put anything in a
// manifest, so fall back to the directory basename when the name is unsafe.
function safePluginName(raw: unknown, pluginRoot: string): string {
  return typeof raw === 'string' && SAFE_PLUGIN_NAME.test(raw.trim())
    ? raw.trim()
    : path.basename(pluginRoot);
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readTextFile(filePath));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function marketplaceSourcePath(source: unknown): string | null {
  // Claude Code uses a string source ("./plugins/foo"); Codex uses an object
  // { source: "local", path: "./plugins/foo" }.
  if (typeof source === 'string') {
    return source.startsWith('.') ? source : null;
  }
  if (source && typeof source === 'object') {
    const record = source as Record<string, unknown>;
    if (record.source === 'local' && typeof record.path === 'string') {
      return record.path.startsWith('.') ? record.path : null;
    }
  }
  return null;
}

async function detectPluginGroupsForMarker(
  rootPath: string,
  files: string[],
  marker: PluginMarker,
): Promise<DetectedGroup[]> {
  const pluginRoots = new Map<string, string>();

  for (const filePath of files) {
    const base = path.basename(filePath);
    const parent = path.basename(path.dirname(filePath));
    if (base === 'plugin.json' && parent === marker.manifestDir) {
      const pluginRoot = path.dirname(path.dirname(filePath));
      const manifest = await readJsonFile(filePath);
      pluginRoots.set(pluginRoot, safePluginName(manifest?.name, pluginRoot));
    }
  }

  // Marketplace manifests can list plugins by relative path; index those too so
  // a marketplace repo exposes its plugins even without per-plugin manifests.
  for (const filePath of files) {
    const relFromRoot = toPosixPath(path.relative(rootPath, filePath));
    if (!marker.marketplaceFiles.includes(relFromRoot)) {
      continue;
    }
    const marketplaceRoot = rootPath;
    const manifest = await readJsonFile(filePath);
    const plugins = Array.isArray(manifest?.plugins) ? manifest.plugins : [];
    for (const rawEntry of plugins) {
      if (!rawEntry || typeof rawEntry !== 'object') {
        continue;
      }
      const record = rawEntry as Record<string, unknown>;
      const sourcePath = marketplaceSourcePath(record.source);
      if (!sourcePath) {
        continue;
      }
      const pluginRoot = path.resolve(marketplaceRoot, sourcePath);
      if (!(await pathExists(pluginRoot))) {
        continue;
      }
      if (!pluginRoots.has(pluginRoot)) {
        pluginRoots.set(pluginRoot, safePluginName(record.name, pluginRoot));
      }
    }
  }

  if (pluginRoots.size === 0) {
    return [];
  }

  const entries: DetectedEntry[] = [...pluginRoots.entries()]
    .map(([pluginRoot, name]): DetectedEntry => {
      const relative = path.relative(rootPath, pluginRoot);
      const relativePath = relative === '' ? '.' : toPosixPath(relative);
      return {
        name,
        relativePath,
        rootRelativePath: relativePath,
        adapter: marker.adapter,
        kind: 'plugin',
        warnings: [],
      };
    })
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return [
    {
      adapter: marker.adapter,
      label: marker.label,
      relativeRoot: '',
      kind: 'plugin',
      nativeTargetRelativeRoot: nativePluginRoot(marker.adapter),
      confidence: 100,
      entries,
    },
  ];
}

async function detectPluginGroups(
  rootPath: string,
  adapter: AdapterId,
): Promise<DetectedGroup[]> {
  const marker = PLUGIN_MARKERS.find((candidate) => candidate.adapter === adapter);
  if (!marker) {
    return [];
  }
  const files = await walkFiles(rootPath);
  return detectPluginGroupsForMarker(rootPath, files, marker);
}

function isNestedWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  );
}

function findEntryDirectories(
  files: string[],
  layout: LayoutDefinition,
  absoluteRoot: string,
): string[] {
  const markerPaths = files
    .filter((filePath) =>
      ENTRY_MARKERS[layout.kind].includes(path.basename(filePath)),
    )
    .map((filePath) => path.dirname(filePath))
    .filter((directoryPath) => {
      // For agents, we usually want to avoid the root README.md unless it's explicitly an AGENT.md
      if (layout.kind === 'agent' && directoryPath === absoluteRoot) {
        const markers = files.filter((f) => path.dirname(f) === absoluteRoot).map((f) => path.basename(f));
        return markers.includes('AGENT.md') || markers.includes('CLAUDE.md');
      }
      return true;
    })
    .sort(
      (left, right) =>
        left.split(path.sep).length - right.split(path.sep).length,
    );

  const entries: string[] = [];
  for (const directoryPath of markerPaths) {
    if (entries.some((entryPath) => isNestedWithin(entryPath, directoryPath))) {
      continue;
    }
    entries.push(directoryPath);
  }

  return entries;
}

async function detectGroupsForLayout(
  rootPath: string,
  layout: LayoutDefinition,
): Promise<DetectedGroup[]> {
  const absoluteRoot = path.join(rootPath, layout.relativeRoot);
  if (!(await pathExists(absoluteRoot))) {
    return [];
  }

  const files = await walkFiles(absoluteRoot);
  const entryDirectories = findEntryDirectories(files, layout, absoluteRoot);

  // Fallback: if no SKILL.md/README.md markers found in subdirectories,
  // and we are NOT at the root level scan (relativeRoot != ''),
  // assume children of the relativeRoot are entries.
  const fallbackDirectories =
    entryDirectories.length === 0 && layout.relativeRoot !== ''
      ? await listChildDirectories(absoluteRoot)
      : [];

  const resolvedDirectories =
    entryDirectories.length > 0
      ? entryDirectories
      : fallbackDirectories.map((directory) =>
          path.join(absoluteRoot, directory),
        );

  const entries: DetectedEntry[] = resolvedDirectories.map((directoryPath) => ({
    name: path.basename(directoryPath),
    relativePath: toPosixPath(path.relative(rootPath, directoryPath)),
    rootRelativePath: toPosixPath(path.relative(absoluteRoot, directoryPath)),
    adapter: layout.adapter,
    kind: layout.kind,
    warnings: [],
  }));

  if (entries.length === 0) {
    return [];
  }

  return [
    {
      adapter: layout.adapter,
      label: layout.label,
      relativeRoot: layout.relativeRoot,
      kind: layout.kind,
      nativeTargetRelativeRoot: layout.relativeRoot,
      confidence: layout.relativeRoot === '' ? 50 : 100,
      entries: entries.sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
      ),
    },
  ];
}

function flattenEntries(groups: DetectedGroup[]): DetectedEntry[] {
  return groups.flatMap((group) => group.entries);
}

function buildCompatibility(
  adapter: AdapterId,
  groups: DetectedGroup[],
): AdapterCompatibility {
  const matchingGroups = groups.filter((group) => group.adapter === adapter);
  if (matchingGroups.length === 0) {
    return {
      adapter,
      compatible: false,
      score: 0,
      reasons: ['No matching native layout detected.'],
    };
  }

  const scoreByAdapter: Record<AdapterId, number> = {
    codex: 100,
    claude: 100,
    generic: 85,
  };

  return {
    adapter,
    compatible: true,
    score: scoreByAdapter[adapter],
    reasons: [`Detected ${matchingGroups.length} matching layout root(s).`],
  };
}

function buildLayoutSignature(
  groups: DetectedGroup[],
  scripts: DetectedScript[],
): string {
  return stableHash({
    groups: groups.map((group) => ({
      adapter: group.adapter,
      root: group.relativeRoot,
      entries: group.entries.map((entry) => entry.relativePath),
    })),
    scripts,
  });
}

function findCompatibleEntry(
  record: InstallRecord,
  report: InspectionReport,
): DetectedEntry | null {
  const exactMatch =
    flattenEntries(report.groups).find(
      (entry) => entry.relativePath === record.sourceRelativePath,
    ) ?? null;

  if (exactMatch) {
    return exactMatch;
  }

  return (
    flattenEntries(report.groups).find(
      (entry) => entry.name === record.name && entry.adapter === record.adapter,
    ) ?? null
  );
}

function createAdapter(id: AdapterId): SkillAdapter {
  return {
    id,
    async detect(rootPath: string): Promise<DetectedGroup[]> {
      const layouts = LAYOUTS.filter((layout) => layout.adapter === id);
      const groups = await Promise.all(
        layouts.map((layout) => detectGroupsForLayout(rootPath, layout)),
      );
      const flattened = groups.flat();
      if (PLUGIN_ADAPTERS.includes(id)) {
        flattened.push(...(await detectPluginGroups(rootPath, id)));
      }
      return flattened;
    },
    scoreCompatibility(report: InspectionReport): AdapterCompatibility {
      return buildCompatibility(id, report.groups);
    },
    async install(entry: DetectedEntry, scopeRoot: string): Promise<InstallMapping> {
      const sourceRootRelativePath =
        entry.relativePath === '.'
          ? ''
          : entry.relativePath.split('/').slice(0, -1).join('/');

      // Skills follow the canonical + transform model: a skill is always
      // materialized into the chosen agent's native skill directory, regardless
      // of the source layout. This is what lets one canonical `skills/<name>`
      // entry fan out to codex, claude, and generic agents.
      if (entry.kind === 'skill') {
        // Preserve any nested collection sub-path (e.g. `.curated/openai-docs`)
        // under the chosen agent's skill root while still transforming the root.
        const subPath =
          entry.rootRelativePath && entry.rootRelativePath !== '.'
            ? entry.rootRelativePath
            : entry.name;
        return {
          name: entry.name,
          adapter: id,
          sourceRelativePath: entry.relativePath,
          sourceRootRelativePath,
          targetRelativePath: toPosixPath(path.join(SKILL_ROOTS[id], subPath)),
        };
      }

      // Plugins land in AgentPM's managed per-agent marketplace directory,
      // which the host consumes via `claude plugin marketplace add <root>` or
      // `codex plugin marketplace add <root>`. Clamp the name to a single safe
      // segment as defense-in-depth against an unsafe name reaching this far.
      if (entry.kind === 'plugin') {
        const safeName = SAFE_PLUGIN_NAME.test(entry.name)
          ? entry.name
          : path.basename(entry.name);
        return {
          name: safeName,
          adapter: id,
          sourceRelativePath: entry.relativePath,
          sourceRootRelativePath,
          targetRelativePath: pluginTargetRelativePath(id, safeName),
        };
      }

      // Agents and subagents keep the selector behavior: preserve a native
      // layout when the source already uses one, otherwise fall back to the
      // adapter's default root for the kind.
      const targetGroups = (
        await Promise.all(ADAPTERS.map((a) => a.detect(scopeRoot)))
      ).flat();
      const bestGroup =
        targetGroups.find((g) => g.kind === entry.kind && g.adapter === id) ??
        targetGroups.find((g) => g.kind === entry.kind);

      const defaultRelativeRoots: Record<
        AdapterId,
        Partial<Record<DetectedGroup['kind'], string>>
      > = {
        codex: {},
        claude: {
          agent: '.claude/agents',
        },
        generic: {
          subagent: 'subagents',
        },
      };

      const targetRoot =
        bestGroup?.relativeRoot ??
        defaultRelativeRoots[id]?.[entry.kind] ??
        defaultRelativeRoots['generic'][entry.kind] ??
        'subagents';

      const standardRoots = new Set([
        '.codex',
        '.codex.cloud',
        '.claude',
        '.agents',
        'subagents',
      ]);
      const firstSegment = entry.relativePath.split('/')[0] ?? '';
      const isStandardLayout = standardRoots.has(firstSegment);

      const targetRelativePath = isStandardLayout
        ? entry.relativePath
        : toPosixPath(path.join(targetRoot, entry.name));

      return {
        name: entry.name,
        adapter: id,
        sourceRelativePath: entry.relativePath,
        sourceRootRelativePath,
        targetRelativePath,
      };
    },
    update(
      record: InstallRecord,
      report: InspectionReport,
    ): AdapterUpdateResult {
      const exactMatch = flattenEntries(report.groups).find(
        (entry) => entry.relativePath === record.sourceRelativePath,
      );
      if (exactMatch) {
        return {
          risk: 'safe',
          nextRelativePath: exactMatch.relativePath,
          warnings: [],
        };
      }

      const remapped = findCompatibleEntry(record, report);
      if (remapped) {
        return {
          risk: 'remap',
          nextRelativePath: remapped.relativePath,
          warnings: ['Layout changed, but the entry can be remapped by name.'],
        };
      }

      return {
        risk: 'breaking',
        nextRelativePath: null,
        warnings: [
          'Previously installed entry was not found in the updated layout.',
        ],
      };
    },
    remove(record: InstallRecord): string[] {
      return [record.targetPath];
    },
    validate(report: InspectionReport, entry: DetectedEntry): string[] {
      const matching = flattenEntries(report.groups).find(
        (candidate) => candidate.relativePath === entry.relativePath,
      );
      return matching
        ? []
        : ['Entry is no longer present in the detected layout.'];
    },
  };
}

export const ADAPTERS: SkillAdapter[] = [
  createAdapter('codex'),
  createAdapter('claude'),
  createAdapter('generic'),
];

export function getAdapter(adapterId: AdapterId): SkillAdapter {
  const adapter = ADAPTERS.find((candidate) => candidate.id === adapterId);
  if (!adapter) {
    throw new AgentPmError(`Unknown adapter: ${adapterId}`);
  }
  return adapter;
}

function calculateTrust(
  locator: string,
  sourceKind: SourceKind,
  scripts: DetectedScript[],
): InspectionTrust {
  const reasons: string[] = [];
  let score = 100;

  if (sourceKind === 'local') {
    reasons.push('Source is a local folder.');
  } else if (isHttpUrl(locator)) {
    try {
      const url = new URL(locator);
      if (url.hostname === 'github.com') {
        reasons.push('Source is a public GitHub repository.');
      } else {
        score -= 20;
        reasons.push(`Source is an external HTTP host: ${url.hostname}`);
      }
    } catch {
      score -= 10;
      reasons.push('Source locator is a non-standard Git URL.');
    }
  }

  if (scripts.length > 0) {
    score -= 30;
    reasons.push(
      `Detected ${scripts.length} custom install script(s) which could be risky.`,
    );
  }

  return {
    trusted: score >= 80,
    score,
    reasons,
  };
}

export async function inspectRepository(
  repoPath: string,
  locator: string,
  sourceKind: SourceKind,
): Promise<InspectionReport> {
  const groups = (
    await Promise.all(ADAPTERS.map((adapter) => adapter.detect(repoPath)))
  ).flat();

  const scripts = (await detectInstallScripts(repoPath)).sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );

  const warnings =
    scripts.length > 0
      ? [
          'Install scripts detected. AgentPM does not execute them automatically.',
        ]
      : [];
  if (groups.length === 0) {
    warnings.push('No supported native skill or agent layout was detected.');
  }

  const report: InspectionReport = {
    locator,
    sourceKind,
    resolvedPath: repoPath,
    groups,
    scripts,
    compatibleAdapters: [],
    installable: groups.some((group) => group.entries.length > 0),
    trust: calculateTrust(locator, sourceKind, scripts),
    warnings,
    layoutSignature: buildLayoutSignature(groups, scripts),
  };

  report.compatibleAdapters = ADAPTERS.map((adapter) =>
    adapter.scoreCompatibility(report),
  ).sort((left, right) => right.score - left.score);

  return report;
}

export function listInstallableEntries(
  report: InspectionReport,
): DetectedEntry[] {
  const all = flattenEntries(report.groups);
  const seen = new Set<string>();
  const result: DetectedEntry[] = [];

  // Prioritize specific layout and adapter matches over Deep skills fallback
  const sorted = [...all].sort((a, b) => {
    // 1. Prioritize specific adapters (non-generic) over generic
    if (a.adapter !== 'generic' && b.adapter === 'generic') return -1;
    if (a.adapter === 'generic' && b.adapter !== 'generic') return 1;

    // 2. Prioritize non-empty relativeRoot (specific matches) over empty (Deep skills fallback)
    const aIsDeep = a.rootRelativePath === a.relativePath;
    const bIsDeep = b.rootRelativePath === b.relativePath;
    if (!aIsDeep && bIsDeep) return -1;
    if (aIsDeep && !bIsDeep) return 1;

    return 0;
  });

  for (const entry of sorted) {
    // A plugin folder can carry both a Claude and a Codex manifest, yielding two
    // entries at the same path for different agents; keep them distinct so each
    // host can install its own. Skills stay deduped by path.
    const key =
      entry.kind === 'plugin'
        ? `${entry.relativePath}::${entry.adapter}`
        : entry.relativePath;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }

  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function findDetectedEntry(
  report: InspectionReport,
  selector: { name?: string | undefined; relativePath?: string | undefined },
): DetectedEntry | null {
  return (
    flattenEntries(report.groups).find((entry) => {
      if (
        selector.relativePath &&
        entry.relativePath === selector.relativePath
      ) {
        return true;
      }
      if (selector.name && entry.name === selector.name) {
        return true;
      }
      return false;
    }) ?? null
  );
}

export async function detectInstallScripts(
  rootPath: string,
): Promise<DetectedScript[]> {
  const files = await walkFiles(rootPath);
  return files
    .filter((filePath) =>
      SCRIPT_PATTERNS.some((pattern) => pattern.test(path.basename(filePath))),
    )
    .map((filePath) => ({
      name: path.basename(filePath),
      relativePath: toPosixPath(path.relative(rootPath, filePath)),
    }));
}
