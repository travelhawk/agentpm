import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';

import {
  AgentPmService,
  publishSkillToRegistry,
  registryLogin,
  registryLogout,
  registryWhoami,
  type InstallOptions,
  type ProviderInstalledSkillRecord,
  type ProviderSkillSearchResult,
  type UpdateOptions,
} from '@agentpm/core';
import {
  loadRegistryCredentials,
  registryApiRequest,
  getRegistryToken,
} from '@agentpm/registry';
import { startRegistryServer } from '@agentpm/registry-server';
import { createPromptApi, promptToConfirm, promptToInput } from '@agentpm/ui';

import { resolveTargetAddArgs } from './target-add.js';


type AgentId = 'codex' | 'claude' | 'generic';
type ScopeId = 'global' | 'project' | 'workspace';
type QuickstartFlow = 'install' | 'team' | 'sync';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const KNOWN_AGENTS: AgentId[] = ['codex', 'claude', 'generic'];

function parseAgents(value: string | undefined): AgentId[] | undefined {
  if (!value) {
    return undefined;
  }
  const requested = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  const invalid = requested.filter(
    (part) => !KNOWN_AGENTS.includes(part as AgentId),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown agent(s): ${invalid.join(', ')}. Use one of: ${KNOWN_AGENTS.join(', ')}.`,
    );
  }
  return requested as AgentId[];
}

function parseAgent(value: string | undefined): AgentId | undefined {
  const agents = parseAgents(value);
  if (!agents) {
    return undefined;
  }
  if (agents.length !== 1) {
    throw new Error('--target accepts exactly one agent for this command.');
  }
  return agents[0];
}

function parseScope(value: string | undefined): ScopeId | undefined {
  if (!value) {
    return undefined;
  }
  const scope = value.toLowerCase();
  if (scope !== 'global' && scope !== 'project' && scope !== 'workspace') {
    throw new Error(
      'Unknown scope. Use one of: global, project, workspace.',
    );
  }
  return scope;
}

const QUICKSTART_GUIDES: Record<
  QuickstartFlow,
  {
    title: string;
    goal: string;
    commands: string[];
    notes: string[];
  }
> = {
  install: {
    title: 'Install One Skill',
    goal: 'Find a skill and install it into your current machine or repo.',
    commands: [
      'agentpm skills search typescript --json',
      'agentpm skills install wshobson/agents@typescript-advanced-types --project --yes --json',
      'agentpm list --json',
    ],
    notes: [
      'Use this when you want a one-off skill without managing a shared repo yet.',
      'Add --global to install into your home agent directories instead of the current project.',
    ],
  },
  team: {
    title: 'Set Up a Team Repo',
    goal: 'Turn a repository into a reproducible team contract with agentpm.yaml.',
    commands: [
      'agentpm source add travelhawk/skills-vault --json',
      'agentpm install --from travelhawk/skills-vault --skill release-helper --project --add-source --yes --json',
      'agentpm init --json',
      'agentpm sync --json',
    ],
    notes: [
      'Use this when your repo should declare required skills for everyone who clones it.',
      'Once agentpm.yaml exists, future project and workspace installs update that contract automatically.',
    ],
  },
  sync: {
    title: 'Sync Skills Across Machines',
    goal: 'Publish canonical skills to a Git repo and pull them onto another device.',
    commands: [
      'agentpm target add my-skills travelhawk/skills-vault --default --json',
      'agentpm push --all --to my-skills --json',
      'agentpm pull --from my-skills --target codex,claude,generic --yes --json',
    ],
    notes: [
      'Use this when you want one canonical skill library that fans out to Codex, Claude, and generic agents.',
      'Add --target codex,claude,generic to control which runtimes receive pulled skills.',
    ],
  },
};

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printSuccessJson(action: string, data: Record<string, unknown> = {}): void {
  printJson({ ok: true, action, ...data });
}

function printErrorJson(message: string, hints: string[]): void {
  printJson({
    ok: false,
    error: {
      message,
      hints,
    },
  });
}

function quickstartPayload(flow?: QuickstartFlow) {
  if (flow) {
    return { selected: flow, guide: QUICKSTART_GUIDES[flow] };
  }
  return {
    guides: Object.entries(QUICKSTART_GUIDES).map(([id, guide]) => ({
      id,
      ...guide,
    })),
  };
}

function printQuickstart(flow?: QuickstartFlow): void {
  const guides = flow
    ? [[flow, QUICKSTART_GUIDES[flow]] as const]
    : (Object.entries(QUICKSTART_GUIDES) as Array<
        [QuickstartFlow, (typeof QUICKSTART_GUIDES)[QuickstartFlow]]
      >);

  section('Quickstart');
  for (const [id, guide] of guides) {
    console.log(`  ${style.bold(guide.title)} (${id})`);
    console.log(`    ${guide.goal}`);
    for (const command of guide.commands) {
      // Strip --json and --yes for human readability in terminal output
      const humanCommand = command
        .replace(/\s--json(\s|$)/g, '$1')
        .replace(/\s--yes(\s|$)/g, '$1');
      console.log(`    ${symbols.arrow} ${style.cyan(humanCommand)}`);
    }
    for (const note of guide.notes) {
      console.log(`    ${symbols.bullet} ${note}`);
    }
    console.log('');
  }
}

function errorGuidance(message: string): string[] {
  const hints: string[] = [];
  if (
    /No sources have been added yet|No catalog entries are indexed yet/i.test(
      message,
    )
  ) {
    hints.push('Add a source first with `agentpm source add <repo-or-registry>`.');
  }
  if (/Unknown source/i.test(message)) {
    hints.push(
      'List configured sources with `agentpm source list` and retry with the exact source id.',
    );
  }
  if (/interactive TTY|Re-run interactively/i.test(message)) {
    hints.push(
      'Pass explicit flags like `--skill`, `--all`, `--from`, or `--yes` when running non-interactively.',
    );
  }
  if (/Unknown agent\(s\)/i.test(message)) {
    hints.push(
      'Use a comma-separated subset of `codex`, `claude`, or `generic` for `--target`.',
    );
  }
  if (/skills\.sh|public skills|npx skills/i.test(message)) {
    hints.push(
      'Verify network access and retry with `agentpm skills search <query>` before installing.',
    );
  }
  if (/Cannot remove source/i.test(message)) {
    hints.push(
      'Remove dependent installs first with `agentpm list` and `agentpm remove <name>`.',
    );
  }
  if (/agentpm\.yaml|manifest/i.test(message)) {
    hints.push(
      'Use `agentpm init` to create a repo contract, or remove project-scope assumptions from the command.',
    );
  }
  if (/credential|permission|auth|repository|SSH/i.test(message)) {
    hints.push(
      'Check repository access, SSH credentials, and the exact locator you passed.',
    );
  }
  if (hints.length === 0) {
    hints.push(
      'Run `agentpm doctor` for environment checks and `agentpm --help` for command examples.',
    );
  }
  return hints;
}

const BRAND_LINES = [
  '    _                    _   ____  __  __',
  '   / \\   __ _  ___ _ __ | |_|  _ \\|  \\/  |',
  "  / _ \\ / _` |/ _ \\ '_ \\| __| |_) | |\\/| |",
  ' / ___ \\ (_| |  __/ | | | |_|  __/| |  | |',
  '/_/   \\_\\__, |\\___|_| |_|\\__|_|   |_|  |_|',
  '        |___/',
];

function colorize(text: string, code: number): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return text;
  }
  return `\u001B[${code}m${text}\u001B[0m`;
}

// Premium palette styles (ANSI codes)
const style = {
  cyan: (t: string) => colorize(t, 36),
  green: (t: string) => colorize(t, 32),
  yellow: (t: string) => colorize(t, 33),
  red: (t: string) => colorize(t, 31),
  gray: (t: string) => colorize(t, 90),
  bold: (t: string) => colorize(t, 1),
  underline: (t: string) => colorize(t, 4),
  magenta: (t: string) => colorize(t, 35),
};

const symbols = {
  success: colorize('+', 32),
  info: colorize('i', 36),
  warning: colorize('!', 33),
  error: colorize('x', 31),
  arrow: colorize('->', 36),
  star: colorize('*', 33),
  bullet: colorize('-', 90),
};

function brandBlock(): string {
  const logo = BRAND_LINES.map((line) => style.cyan(line)).join('\n');
  return `\n${logo}\n\n  ${style.bold(style.cyan('AgentPM'))} ${style.gray('-')} ${style.bold('Project-aware AI skill orchestration')}\n`;
}

function formatExamples(examples: string[]): string {
  return `\nExamples:\n${examples.map((example) => `  ${example}`).join('\n')}\n`;
}

function addExamples<T extends Command>(command: T, examples: string[]): T {
  command.addHelpText('after', formatExamples(examples));
  return command;
}

function section(title: string): void {
  console.log(`\n${style.bold(style.cyan(title))}`);
}

function resolveScope(flags: {
  global?: boolean;
  project?: boolean;
  workspace?: boolean;
}): InstallOptions['scope'] {
  if (flags.global) {
    return 'global';
  }
  if (flags.project) {
    return 'project';
  }
  if (flags.workspace) {
    return 'workspace';
  }
  return undefined;
}

function resolveTarget(value?: string): InstallOptions['target'] {
  if (!value) {
    return undefined;
  }
  if (value === 'codex' || value === 'claude' || value === 'generic') {
    return value;
  }
  throw new Error('--target must be one of: codex, claude, generic');
}

function printInspection(
  report: Awaited<ReturnType<AgentPmService['inspect']>>,
): void {
  section('Source');
  console.log(
    `  ${symbols.bullet} locator      : ${style.bold(report.locator)}`,
  );
  console.log(
    `  ${symbols.bullet} installable  : ${report.installable ? style.green('yes') : style.red('no')}`,
  );

  section('Trust');
  const trustColor = report.trust.trusted ? 32 : 33;
  console.log(
    `  ${symbols.bullet} status       : ${colorize(report.trust.trusted ? 'trusted' : 'untrusted', trustColor)} (${style.bold(report.trust.score.toString())}/100)`,
  );
  for (const reason of report.trust.reasons) {
    console.log(`    ${style.gray('-')} ${reason}`);
  }

  section('Detected');
  if (report.groups.length === 0) {
    console.log(`  ${symbols.warning} no components detected`);
  }
  for (const group of report.groups) {
    console.log(
      `  ${symbols.success} ${style.green(group.label)} (${group.entries.length} entries)`,
    );
  }

  section('Compatibility');
  for (const compatibility of report.compatibleAdapters) {
    const statusSymbol = compatibility.compatible
      ? symbols.success
      : symbols.warning;
    console.log(
      `  ${statusSymbol} ${style.bold(compatibility.adapter)} (compatibility score: ${style.bold(compatibility.score.toString())}/100)`,
    );
    for (const reason of compatibility.reasons) {
      console.log(`    ${style.gray('-')} ${reason}`);
    }
  }

  section('Entries');
  for (const group of report.groups) {
    for (const entry of group.entries) {
      console.log(
        `  ${symbols.arrow} ${style.bold(entry.name)} ${style.gray('->')} ${style.underline(entry.relativePath)}`,
      );
    }
  }

  if (report.scripts.length > 0) {
    section('Risks');
    for (const script of report.scripts) {
      console.log(
        `  ${symbols.warning} custom install script found: ${style.yellow(script.relativePath)}`,
      );
    }
  }

  if (report.warnings.length > 0) {
    section('Warnings');
    for (const warning of report.warnings) {
      console.log(`  ${symbols.warning} ${style.yellow(warning)}`);
    }
  }
  console.log('');
}

function printRuntimeContext(
  graph: Awaited<ReturnType<AgentPmService['resolveRuntimeContext']>>,
): void {
  section('Runtime');
  console.log(`  ${symbols.bullet} Root Workspace : ${style.bold(graph.cwd)}`);
  if (graph.configPath) {
    console.log(
      `  ${symbols.bullet} Config File    : ${style.bold(graph.configPath)}`,
    );
  }

  for (const layer of ['global', 'project', 'temporary'] as const) {
    const entries = graph.layers[layer];
    section(`${layer[0]!.toUpperCase()}${layer.slice(1)}`);
    if (entries.length === 0) {
      console.log(`  ${style.gray('-')} no entries active in this layer`);
      continue;
    }
    for (const entry of entries) {
      const source = entry.sourceLocator
        ? ` [source: ${entry.sourceLocator}]`
        : '';
      const pathSummary = entry.sourceRelativePath
        ? ` ${style.gray('->')} ${entry.sourceRelativePath}`
        : '';
      console.log(
        `  ${symbols.success} ${style.bold(entry.name)}${pathSummary}${style.gray(source)}`,
      );
      for (const warning of entry.warnings) {
        console.log(`    ${symbols.warning} ${style.yellow(warning)}`);
      }
    }
  }

  if (graph.warnings.length > 0) {
    section('Warnings');
    for (const warning of graph.warnings) {
      console.log(`  ${symbols.warning} ${style.yellow(warning)}`);
    }
  }
  console.log('');
}

function printUpdates(
  previews: Awaited<ReturnType<AgentPmService['previewUpdates']>>,
): void {
  if (previews.length === 0) {
    console.log(`\n${symbols.info} No installed skills or assets detected.`);
    return;
  }

  section('Skill Update Preview');
  for (const preview of previews) {
    const revisionSummary =
      preview.currentRevision && preview.candidateRevision
        ? `${style.bold(preview.currentRevision.slice(0, 7))} ${style.gray('->')} ${style.bold(preview.candidateRevision.slice(0, 7))}`
        : 'n/a';
    const statusText = preview.changed
      ? style.yellow('update available')
      : style.green('up to date');
    const statusSymbol = preview.changed ? symbols.warning : symbols.success;

    console.log(
      `  ${statusSymbol} ${style.bold(preview.install.name)}: ${statusText} (${revisionSummary})`,
    );
    if (preview.changed) {
      console.log(
        `    ${symbols.bullet} Risk Profile: ${style.bold(preview.risk)}`,
      );
      for (const diff of preview.diff) {
        console.log(
          `      ${style.gray('-')} ${style.cyan(diff.kind.padEnd(8))} : ${diff.path}`,
        );
      }
      for (const warning of preview.warnings) {
        console.log(`      ${symbols.warning} ${style.yellow(warning)}`);
      }
    }
  }
  console.log('');
}

function printDoctor(
  issues: Awaited<ReturnType<AgentPmService['doctor']>>,
): void {
  if (issues.length === 0) {
    console.log(
      `\n${symbols.success} Doctor found no issues. Your environment is perfectly healthy!`,
    );
    return;
  }

  section('Doctor Diagnosis');
  for (const issue of issues) {
    const isError = issue.severity === 'error';
    const severitySymbol = isError ? symbols.error : symbols.warning;
    const severityText = isError
      ? style.red(issue.severity.toUpperCase())
      : style.yellow(issue.severity.toUpperCase());

    console.log(
      `  ${severitySymbol} [${severityText}] ${style.bold(issue.code)}: ${issue.message}`,
    );
    if (issue.path) {
      console.log(`    ${style.gray('Path   :')} ${issue.path}`);
    }
    if (issue.remedy) {
      console.log(`    ${style.gray('Remedy :')} ${style.green(issue.remedy)}`);
    }
  }
  console.log('');
}

function printRefreshResults(
  results: Awaited<ReturnType<AgentPmService['refreshSources']>>,
): void {
  if (results.length === 0) {
    console.log(`\n${symbols.info} No sources configured.\n`);
    return;
  }

  section('Source Refresh');
  for (const result of results) {
    console.log(
      `  ${symbols.success} ${style.bold(result.source.displayName)} ${style.gray(`(${result.indexedEntries} entries indexed)`)}`,
    );
  }
  console.log('');
}

function printCacheCleanResult(
  result: Awaited<ReturnType<AgentPmService['cleanCache']>>,
): void {
  if (result.removedEntries === 0) {
    console.log(
      `\n${symbols.success} Cache is already clean. Active install caches and the searchable source index were preserved.\n`,
    );
    return;
  }

  section(result.dryRun ? 'Cache Clean Preview' : 'Cache Clean');
  console.log(
    `  ${symbols.success} ${result.dryRun ? 'Would remove' : 'Removed'} ${style.bold(result.removedEntries.toString())} unused Git checkout cache item(s).`,
  );
  console.log(
    `  ${symbols.bullet} Preserved active install caches and the searchable source index.`,
  );
  for (const removedPath of result.removedPaths) {
    console.log(`    ${style.gray('-')} ${removedPath}`);
  }
  console.log('');
}

function printDoctorFixes(
  actions: Awaited<ReturnType<AgentPmService['planDoctorFixes']>>,
  issues: Awaited<ReturnType<AgentPmService['doctor']>> = [],
): void {
  if (actions.length === 0) {
    console.log(`\n${symbols.info} No safe automatic fixes are available.\n`);
    const unsupported = issues.filter((issue) => issue.severity === 'error');
    for (const issue of unsupported) {
      console.log(
        `  ${symbols.bullet} ${issue.code}: no automated fix is available; ${issue.remedy}`,
      );
    }
    if (unsupported.length > 0) {
      console.log('');
    }
    return;
  }

  section('Planned Fixes');
  for (const action of actions) {
    console.log(`  ${symbols.warning} ${style.yellow(action.description)}`);
  }
  const fixedInstallIds = new Set(
    actions.flatMap((action) =>
      action.code === 'remove-install-record' ? [action.installId] : [],
    ),
  );
  const fixedSourceIds = new Set(
    actions.flatMap((action) =>
      action.code === 'remove-source' ? [action.sourceId] : [],
    ),
  );
  const unsupported = issues.filter((issue) => {
    if (issue.severity !== 'error') {
      return false;
    }
    if (issue.installId && fixedInstallIds.has(issue.installId)) {
      return false;
    }
    if (
      issue.sourceId &&
      fixedSourceIds.has(issue.sourceId) &&
      (issue.code === 'source-missing' || issue.code === 'source-unavailable')
    ) {
      return false;
    }
    return true;
  });
  if (unsupported.length > 0) {
    section('Manual Review');
    for (const issue of unsupported) {
      console.log(
        `  ${symbols.bullet} ${issue.code}: no automated fix is available; ${issue.remedy}`,
      );
    }
  }
  console.log('');
}

function printSourceEntries(
  result: Awaited<ReturnType<AgentPmService['listSourceEntries']>>,
): void {
  section('Source Skills');
  console.log(
    `  ${symbols.bullet} source       : ${style.bold(result.sourceDisplayName)}`,
  );
  console.log(`  ${symbols.bullet} locator      : ${result.sourceLocator}`);
  console.log(
    `  ${symbols.bullet} persisted    : ${result.persisted ? style.green('yes') : style.yellow('no')}`,
  );

  if (result.entries.length === 0) {
    console.log(`\n  ${symbols.info} No installable skills were found.\n`);
    return;
  }

  console.log('');
  for (const entry of result.entries) {
    console.log(
      `  ${symbols.success} ${style.bold(entry.name)} ${style.gray('|')} ${(entry.adapter ?? 'unknown').padEnd(7)} ${entry.path ?? entry.repo}`,
    );
  }
  console.log('');
}

function printProviderEntries(results: ProviderSkillSearchResult[]): void {
  section('Public Skills');
  if (results.length === 0) {
    console.log(`  ${symbols.info} No public skills found.\n`);
    return;
  }

  for (const entry of results) {
    const installs = entry.installs
      ? `${style.cyan(entry.installs)} ${style.gray('installs')}`
      : style.gray('installs unknown');
    console.log(
      `  ${symbols.success} ${style.bold(entry.skillSelector)} ${style.gray('|')} ${installs}`,
    );
    console.log(
      `    ${style.gray('repo')} ${style.cyan(entry.source)} ${style.gray('->')} ${entry.installLocator}`,
    );
    if (entry.url) {
      console.log(`    ${style.gray('url ')} ${entry.url}`);
    }
  }
  console.log(
    `\n  ${symbols.info} Install with ${style.bold('agentpm skills install <owner/repo@skill>')}` +
      ` ${style.gray('or')} ${style.bold('agentpm skills install <query>')}\n`,
  );
}

function printInstalledProviderSkills(
  results: ProviderInstalledSkillRecord[],
): void {
  section('Installed Public Skills');
  if (results.length === 0) {
    console.log(`  ${symbols.info} No skills.sh installs found.\n`);
    return;
  }

  for (const entry of results) {
    console.log(
      `  ${symbols.success} ${style.bold(entry.skillSelector ?? entry.name)} ${style.gray('|')} ${entry.scope}`,
    );
    if (entry.source) {
      console.log(`    ${style.gray('repo')} ${style.cyan(entry.source)}`);
    }
    console.log(`    ${style.gray('path')} ${entry.targetPath}`);
  }
  console.log('');
}

function summarizeInstalls(
  installs: Awaited<ReturnType<AgentPmService['listInstalls']>>,
): Array<{
  name: string;
  scope: string;
  scopeRoot: string;
  storedPath: string;
  adapters: string[];
  targetPaths: string[];
}> {
  const grouped = new Map<
    string,
    {
      name: string;
      scope: string;
      scopeRoot: string;
      storedPath: string;
      adapters: Set<string>;
      targetPaths: Set<string>;
    }
  >();

  for (const install of installs) {
    const storedPath = install.linkTarget || install.targetPath;
    const key = [
      install.name,
      install.scope,
      install.scopeRoot,
      storedPath,
    ].join('::');
    const existing = grouped.get(key) ?? {
      name: install.name,
      scope: install.scope,
      scopeRoot: install.scopeRoot,
      storedPath,
      adapters: new Set<string>(),
      targetPaths: new Set<string>(),
    };
    existing.adapters.add(install.adapter);
    existing.targetPaths.add(install.targetPath);
    grouped.set(key, existing);
  }

  return [...grouped.values()]
    .map((entry) => ({
      name: entry.name,
      scope: entry.scope,
      scopeRoot: entry.scopeRoot,
      storedPath: entry.storedPath,
      adapters: [...entry.adapters].sort(),
      targetPaths: [...entry.targetPaths].sort(),
    }))
    .sort((left, right) =>
      `${left.name}:${left.scope}:${left.storedPath}`.localeCompare(
        `${right.name}:${right.scope}:${right.storedPath}`,
      ),
    );
}

async function withService<T>(
  callback: (service: AgentPmService) => Promise<T>,
  options: {
    statusMessages?: boolean;
  } = {},
): Promise<T> {
  const service = new AgentPmService({
    prompts: createPromptApi(),
    onStatus:
      options.statusMessages === false
        ? undefined
        : (message) => {
            console.log(`${symbols.info} ${message}`);
          },
  });
  try {
    return await callback(service);
  } finally {
    service.close();
  }
}

const program = new Command();
const rawCliArgs = process.argv.slice(2);
program
  .name('agentpm')
  .description('Git-native skill and agent asset manager')
  .version('0.9.2')
  .exitOverride()
  .showHelpAfterError(false)
  .addHelpText('beforeAll', brandBlock());

addExamples(program, [
  'agentpm source add travelhawk/skills-vault',
  'agentpm quickstart install',
  'agentpm source skills github:company/private-skills',
  'agentpm skills search typescript',
  'agentpm skills install wshobson/agents@typescript-advanced-types --project',
  'agentpm install --from travelhawk/skills-vault --skill release-helper --project',
  'agentpm target add https://github.com/travelhawk/skills-vault',
  'agentpm push',
  'agentpm pull --from skills-vault',
  'agentpm doctor --fix',
]);

addExamples(
  program
    .command('quickstart')
    .description('Show task-oriented first-run flows')
    .argument('[flow]', 'One of: install, team, sync')
    .option('--json', 'Print machine-readable JSON')
    .action(
      (
        flow: QuickstartFlow | undefined,
        flags: { json?: boolean },
      ) => {
        if (flow && !(flow in QUICKSTART_GUIDES)) {
          throw new Error(
            `Unknown quickstart flow: ${flow}. Use one of: ${Object.keys(QUICKSTART_GUIDES).join(', ')}.`,
          );
        }
        if (flags.json) {
          printJson(quickstartPayload(flow));
          return;
        }
        printQuickstart(flow);
      },
    ),
  ['agentpm quickstart', 'agentpm quickstart install', 'agentpm quickstart --json'],
);

const source = addExamples(
  program.command('source').alias('sources').description('Manage sources'),
  [
    'agentpm source add travelhawk/skills-vault',
    'agentpm source add ./examples/repos/codex-sample',
    'agentpm source skills skills-vault',
    'agentpm source remove skills-vault',
  ],
);

const skillsCmd = addExamples(
  program
    .command('skills')
    .description(
      'Search and import public skills through the skills.sh CLI bridge',
    ),
  [
    'agentpm skills search typescript',
    'agentpm skills install wshobson/agents@typescript-advanced-types --project',
    'agentpm skills list',
    'agentpm skills update --yes',
  ],
);

addExamples(
  skillsCmd
    .command('search')
    .argument('<query>', 'Search query for skills.sh')
    .option('--json', 'Print machine-readable JSON')
    .action(async (query: string, flags: { json?: boolean }) => {
      const results = await withService((service) =>
        service.searchProviderSkills(query),
      );
      if (flags.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      printProviderEntries(results);
    }),
  ['agentpm skills search typescript', 'agentpm skills search react --json'],
);

addExamples(
  skillsCmd
    .command('install')
    .argument(
      '<source-or-selector>',
      'Provider selector like owner/repo@skill, or a repo/url plus --skill',
    )
    .option(
      '--skill <name>',
      'Skill name when passing a repo or URL',
      collect,
      [],
    )
    .option('--global', 'Install to the global native target')
    .option('--project', 'Install to the current project')
    .option('--workspace', 'Install to a workspace root')
    .option('--workspace-root <path>', 'Explicit workspace root')
    .option(
      '--target <target>',
      'Install only entries for codex, claude, or generic',
    )
    .option('--yes', 'Accept safe install prompts automatically')
    .option('--json', 'Print machine-readable JSON')
    .action(
      async (
        sourceOrSelector: string,
        flags: InstallOptions & {
          global?: boolean;
          project?: boolean;
          workspace?: boolean;
          workspaceRoot?: string;
          skill?: string[];
          target?: string;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        const installs = await withService((service) =>
          service.installProviderSkill(sourceOrSelector, {
            scope: resolveScope(flags),
            workspaceRoot: flags.workspaceRoot,
            skills: flags.skill,
            target: resolveTarget(flags.target),
            yes: flags.yes,
          }),
        );
        if (flags.json) {
          printSuccessJson('skills.install', {
            sourceOrSelector,
            installs,
          });
          return;
        }
        for (const install of installs) {
          console.log(
            `\n${symbols.success} ${style.bold('Installed')} ${style.green(install.name)} ${style.gray('->')} ${style.underline(install.targetPath)}`,
          );
        }
        console.log('');
      },
    ),
  [
    'agentpm skills install wshobson/agents@typescript-advanced-types --project',
    'agentpm skills install vercel-labs/agent-skills --skill nextjs-architecture --global',
  ],
);

skillsCmd
  .command('list')
  .option('--json', 'Print machine-readable JSON')
  .action(async (flags: { json?: boolean }) => {
    const installs = await withService((service) =>
      Promise.resolve(service.listProviderSkillInstalls()),
    );
    if (flags.json) {
      console.log(JSON.stringify(installs, null, 2));
      return;
    }
    printInstalledProviderSkills(installs);
  });

skillsCmd
  .command('remove')
  .argument(
    '<name-or-selector>',
    'Installed skill name or owner/repo@skill selector',
  )
  .option('--purge', 'Also purge unused cache data')
  .option('--target <agent>', 'Remove one target agent (codex, claude, generic)')
  .option('--scope <scope>', 'Remove one install scope (global, project, workspace)')
  .option('--path <path>', 'Remove the install at an exact target path')
  .option('--json', 'Print machine-readable JSON')
  .action(async (
    identifier: string,
    flags: {
      purge?: boolean;
      target?: string;
      scope?: string;
      path?: string;
      json?: boolean;
    },
  ) => {
    const removed = await withService((service) =>
      service.removeProviderSkill(identifier, {
        purge: Boolean(flags.purge),
        adapter: parseAgent(flags.target),
        scope: parseScope(flags.scope),
        targetPath: flags.path,
      }),
    );
    if (flags.json) {
      printSuccessJson('skills.remove', {
        identifier,
        removed,
      });
      return;
    }
    const selector =
      typeof removed.metadata.providerSkillSelector === 'string'
        ? removed.metadata.providerSkillSelector
        : removed.name;
    console.log(
      `\n${symbols.success} ${style.bold('Removed')} ${style.green(selector)}\n`,
    );
  });

skillsCmd
  .command('update')
  .argument(
    '[skills...]',
    'Optional installed skill names or owner/repo@skill selectors',
  )
  .option('--yes', 'Confirm risky remaps automatically')
  .option('--json', 'Print machine-readable JSON')
  .action(async (identifiers: string[], flags: { yes?: boolean; json?: boolean }) => {
    await withService(async (service) => {
      const previews = await service.updateProviderSkills(identifiers, {
        apply: false,
      });
      const changed = previews.filter((preview) => preview.changed);
      if (flags.json && !flags.yes) {
        printSuccessJson('skills.update', {
          identifiers,
          applied: false,
          requiresConfirmation: changed.length > 0,
          preview: previews,
        });
        return;
      }
      if (previews.length === 0) {
        if (flags.json) {
          printSuccessJson('skills.update', {
            identifiers,
            applied: false,
            requiresConfirmation: false,
            preview: previews,
          });
          return;
        }
        console.log(`\n${symbols.info} No skills.sh installs found.\n`);
        return;
      }
      printUpdates(previews);
      if (changed.length === 0) {
        if (flags.json) {
          printSuccessJson('skills.update', {
            identifiers,
            applied: false,
            requiresConfirmation: false,
            preview: previews,
          });
        }
        return;
      }

      if (!flags.yes) {
        const confirmed = await promptToConfirm(
          'Do you want to update these skills.sh installs? [y/N]',
          changed.map((preview) => {
            const selector =
              typeof preview.install.metadata.providerSkillSelector === 'string'
                ? preview.install.metadata.providerSkillSelector
                : preview.install.name;
            return `${selector}: ${preview.currentRevision?.slice(0, 7) ?? 'n/a'} -> ${preview.candidateRevision?.slice(0, 7) ?? 'n/a'}`;
          }),
        );
        if (!confirmed) {
          console.log(`\n${symbols.info} Update skipped.\n`);
          return;
        }
      }

      const applied = await service.updateProviderSkills(identifiers, {
        apply: true,
        yes: Boolean(flags.yes),
      } satisfies UpdateOptions);
      if (flags.json) {
        printSuccessJson('skills.update', {
          identifiers,
          applied: true,
          preview: previews,
          result: applied,
        });
        return;
      }
      printUpdates(applied);
      const updatedCount = applied.filter(
        (preview) =>
          preview.changed &&
          preview.nextLinkTarget &&
          !preview.warnings.includes('Skipped by user.'),
      ).length;
      console.log(
        `\n${symbols.success} ${style.bold('Update complete')} ${style.gray(`(${updatedCount} skills.sh item(s) updated)`)}\n`,
      );
    });
  });

addExamples(
  source
    .command('add')
    .argument(
      '<locator>',
      'Git locator, OWNER/REPO shorthand, local folder, or registry index path',
    )
    .option('--json', 'Print machine-readable JSON')
    .action(async (locator: string, flags: { json?: boolean }) => {
      const result = await withService((service) => service.addSource(locator));
      if (flags.json) {
        printSuccessJson('source.add', {
          locator,
          result,
        });
        return;
      }
      console.log(
        `\n${symbols.success} ${style.bold('Added source')} ${style.cyan(result.source.displayName)} ${style.gray(`(${result.indexedEntries} entries indexed)`)}\n`,
      );
    }),
  [
    'agentpm source add travelhawk/skills-vault',
    'agentpm source add git@github.com:company/private-skills.git',
    'agentpm source add registry:https://registry.example.com/agentpm/index.yaml',
  ],
);

source.command('list').option('--json', 'Print machine-readable JSON').action(async (flags: { json?: boolean }) => {
  const sources = await withService((service) =>
    Promise.resolve(service.listSources()),
  );
  if (flags.json) {
    printSuccessJson('source.list', { sources });
    return;
  }
  if (sources.length === 0) {
    console.log('No sources configured.');
    return;
  }
  for (const item of sources) {
    console.log(`${item.id}  ${item.kind}  ${item.locator}`);
  }
});

addExamples(
  source
    .command('skills')
    .alias('entries')
    .argument(
      '[source]',
      'Configured source id, locator, or a direct repo locator',
    )
    .option('--refresh', 'Refresh the configured source before listing')
    .option('--target <target>', 'Filter entries for codex, claude, or generic')
    .option('--json', 'Print machine-readable JSON')
    .action(
      async (
        sourceToken: string | undefined,
        flags: { refresh?: boolean; target?: string; json?: boolean },
      ) => {
        const result = await withService((service) =>
          service.listSourceEntries(sourceToken, {
            ...(flags.refresh ? { refresh: true } : {}),
            ...(flags.target ? { target: resolveTarget(flags.target) } : {}),
          }),
        );
        if (flags.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        printSourceEntries(result);
      },
    ),
  [
    'agentpm source skills skills-vault',
    'agentpm source skills travelhawk/skills-vault --target codex',
    'agentpm source skills enterprise --refresh',
  ],
);

source
  .command('remove')
  .argument('<source>', 'Source id or locator')
  .option('--json', 'Print machine-readable JSON')
  .action(async (sourceToken: string, flags: { json?: boolean }) => {
    await withService((service) => service.removeSource(sourceToken));
    if (flags.json) {
      printSuccessJson('source.remove', {
        source: sourceToken,
      });
      return;
    }
    console.log(
      `\n${symbols.success} ${style.bold('Removed source')} ${style.cyan(sourceToken)}\n`,
    );
  });

const targetCmd = addExamples(
  program
    .command('target')
    .alias('targets')
    .description('Manage global push targets'),
  [
    'agentpm target add origin travelhawk/skills-vault --default',
    'agentpm target add https://github.com/travelhawk/skills-vault',
    'agentpm target list',
    'agentpm target default origin',
  ],
);

addExamples(
  targetCmd
    .command('add')
    .usage('[id] <locator>')
    .argument('<idOrLocator>', 'Target ID or target locator')
    .argument(
      '[locator]',
      'Target locator (Git URL, OWNER/REPO shorthand, or registry path)',
    )
    .option('--default', 'Make this the default push target')
    .option('--json', 'Print machine-readable JSON')
    .action(
      async (
        idOrLocator: string,
        locatorArg: string | undefined,
        flags: { default?: boolean; json?: boolean },
      ) => {
        const { id, locator } = await resolveTargetAddArgs(
          idOrLocator,
          locatorArg,
          {
            isInteractive: Boolean(process.stdout.isTTY && process.stdin.isTTY),
            promptForId: (defaultId) =>
              promptToInput('Target name', {
                defaultValue: defaultId,
                placeholder: 'short id',
              }),
          },
        );
        await withService((service) =>
          service.addTarget(id, locator, flags.default),
        );
        if (flags.json) {
          printSuccessJson('target.add', {
            target: {
              id,
              locator,
              default: Boolean(flags.default),
            },
          });
          return;
        }
        console.log(
          `\n${symbols.success} ${style.bold('Added target')} ${style.cyan(id)} to global config${flags.default ? ' as default' : ''}\n`,
        );
      },
    ),
  [
    'agentpm target add origin travelhawk/skills-vault --default',
    'agentpm target add https://github.com/travelhawk/skills-vault',
  ],
);

targetCmd
  .command('default')
  .argument('<id>', 'Target ID')
  .option('--json', 'Print machine-readable JSON')
  .action(async (id: string, flags: { json?: boolean }) => {
    await withService((service) => service.setDefaultTarget(id));
    if (flags.json) {
      printSuccessJson('target.default', { id });
      return;
    }
    console.log(
      `\n${symbols.success} ${style.bold('Default target')} ${style.cyan(id)} saved to global config\n`,
    );
  });

targetCmd
  .command('remove')
  .argument('<id>', 'Target ID')
  .option('--json', 'Print machine-readable JSON')
  .action(async (id: string, flags: { json?: boolean }) => {
    await withService((service) => service.removeTarget(id));
    if (flags.json) {
      printSuccessJson('target.remove', { id });
      return;
    }
    console.log(
      `\n${symbols.success} ${style.bold('Removed target')} ${style.cyan(id)} from global config\n`,
    );
  });

targetCmd.command('list').option('--json', 'Print machine-readable JSON').action(async (flags: { json?: boolean }) => {
  const { loadGlobalConfig } = await import('@agentpm/config');
  const globalConfig = await loadGlobalConfig(process.cwd());
  const globalTargets = globalConfig.targets ?? [];
  if (flags.json) {
    printSuccessJson('target.list', {
      targets: globalTargets,
    });
    return;
  }

  if (globalTargets.length === 0) {
    console.log('No targets configured in global config.');
    return;
  }

  console.log('Global Targets (config.yaml):');
  for (const target of globalTargets) {
    const targetId = target.id ?? '(unnamed)';
    console.log(
      `${target.default ? '*' : ' '} ${targetId.padEnd(20)} ${target.kind?.padEnd(10) ?? ''} ${target.locator}`,
    );
  }
});

program
  .command('inspect')
  .argument('<target>', 'Source id, Git URL, or local path')
  .option(
    '--skill <name>',
    'Check whether a specific skill selector is present',
  )
  .option(
    '--target <target>',
    'Check a runtime target: codex, claude, or generic',
  )
  .action(
    async (target: string, flags: { skill?: string; target?: string }) => {
      const report = await withService((service) =>
        service.inspect(target, {
          skill: flags.skill,
          target: resolveTarget(flags.target),
        }),
      );
      printInspection(report);
    },
  );

addExamples(
  program
    .command('search')
    .argument('<query>', 'Query text')
    .option('--refresh', 'Refresh configured source indexes before searching')
    .action(async (query: string, flags: { refresh?: boolean }) => {
      const { results, sourceCount } = await withService(async (service) => {
        if (flags.refresh) {
          printRefreshResults(await service.refreshSources());
        }
        return {
          results: service.search(query),
          sourceCount: service.listSources().length,
        };
      });
      if (results.length === 0) {
        console.log('No matches found.');
        if (sourceCount > 0 && !flags.refresh) {
          console.log(
            'Indexes may be stale; run `agentpm refresh` or `agentpm search --refresh`.',
          );
        }
        return;
      }
      for (const result of results) {
        console.log(`${result.kind}  ${result.name}  ${result.locator ?? ''}`);
      }
    }),
  ['agentpm search pdf', 'agentpm search pdf --refresh'],
);

addExamples(
  program
    .command('refresh')
    .description('Refresh local indexes for configured sources')
    .argument(
      '[sources...]',
      'Optional source ids, locators, or names to refresh',
    )
    .option('--json', 'Print machine-readable JSON')
    .action(async (sources: string[], flags: { json?: boolean }) => {
      const results = await withService((service) =>
        service.refreshSources(sources),
      );
      if (flags.json) {
        printSuccessJson('refresh', { sources, results });
        return;
      }
      printRefreshResults(results);
    }),
  ['agentpm refresh', 'agentpm refresh skills-vault enterprise'],
);

addExamples(
  program
    .command('install')
    .alias('add')
    .argument(
      '[names...]',
      'Skill names or source token for --all/--skill flows',
    )
    .option(
      '--from <source>',
      'Install from a configured source or direct repo locator',
    )
    .option(
      '--add-source',
      'Add a direct repo locator as a source before installing',
    )
    .option('--global', 'Install to the global native target')
    .option('--project', 'Install to the current project')
    .option('--workspace', 'Install to a workspace root')
    .option('--workspace-root <path>', 'Explicit workspace root')
    .option('--all', 'Install all entries from a source')
    .option('--skill <name>', 'Select a specific skill name', collect, [])
    .option('--ref <ref>', 'Git branch, tag, or revision')
    .option(
      '--target <target>',
      'Install only entries for codex, claude, or generic',
    )
    .option('--yes', 'Accept safe install prompts automatically')
    .option('--json', 'Print machine-readable JSON')
    .action(
      async (
        names: string[],
        flags: InstallOptions & {
          from?: string;
          addSource?: boolean;
          global?: boolean;
          project?: boolean;
          workspace?: boolean;
          workspaceRoot?: string;
          skill?: string[];
          ref?: string;
          target?: string;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        const installs = await withService((service) =>
          service.install(names, {
            scope: resolveScope(flags),
            workspaceRoot: flags.workspaceRoot,
            all: flags.all,
            skills: flags.skill,
            ref: flags.ref ?? null,
            target: resolveTarget(flags.target),
            from: flags.from,
            addSource: flags.addSource,
            yes: flags.yes,
          }),
        );
        if (flags.json) {
          printSuccessJson('install', {
            names,
            installs,
          });
          return;
        }
        for (const install of installs) {
          console.log(
            `\n${symbols.success} ${style.bold('Installed')} ${style.green(install.name)} ${style.gray('->')} ${style.underline(install.targetPath)}`,
          );
        }
      },
    ),
  [
    'agentpm install release-helper --project',
    'agentpm install --from travelhawk/skills-vault --skill release-helper --project',
    'agentpm install --from github:company/private-skills --all --target codex',
  ],
);

program
  .command('update')
  .argument('[names...]', 'Optional installed names to update')
  .option('--refresh', 'Refresh source indexes before checking updates')
  .option('--yes', 'Confirm risky remaps automatically')
  .option('--json', 'Print machine-readable JSON')
  .action(
    async (names: string[], flags: { yes?: boolean; refresh?: boolean; json?: boolean }) => {
      await withService(async (service) => {
        let refreshResults: Awaited<ReturnType<typeof service.refreshSources>> | undefined;
        if (flags.refresh) {
          refreshResults = await service.refreshSources();
          if (!flags.json) {
            printRefreshResults(refreshResults);
          }
        }

        const previews = await service.previewUpdates({ names });
        const changed = previews.filter((preview) => preview.changed);
        if (flags.json && !flags.yes) {
          printSuccessJson('update', {
            names,
            applied: false,
            requiresConfirmation: changed.length > 0,
            refreshResults,
            preview: previews,
          });
          return;
        }
        printUpdates(previews);
        if (changed.length === 0) {
          if (flags.json) {
            printSuccessJson('update', {
              names,
              applied: false,
              requiresConfirmation: false,
              refreshResults,
              preview: previews,
            });
          }
          return;
        }

        if (!flags.yes) {
          const confirmed = await promptToConfirm(
            'Do you want to update these skills? [y/N]',
            changed.map(
              (preview) =>
                `${preview.install.name}: ${preview.currentRevision?.slice(0, 7) ?? 'n/a'} -> ${preview.candidateRevision?.slice(0, 7) ?? 'n/a'}`,
            ),
          );
          if (!confirmed) {
            console.log(`\n${symbols.info} Update skipped.\n`);
            return;
          }
        }

        const applied = await service.update({
          names,
          apply: true,
          yes: Boolean(flags.yes),
        } satisfies UpdateOptions);
        if (flags.json) {
          printSuccessJson('update', {
            names,
            applied: true,
            refreshResults,
            preview: previews,
            result: applied,
          });
          return;
        }
        printUpdates(applied);
        const updatedCount = applied.filter(
          (preview) =>
            preview.changed &&
            preview.nextLinkTarget &&
            !preview.warnings.includes('Skipped by user.'),
        ).length;
        console.log(
          `\n${symbols.success} ${style.bold('Update complete')} ${style.gray(`(${updatedCount} item(s) updated)`)}\n`,
        );
      });
    },
  );

program
  .command('diff')
  .argument('[names...]', 'Optional installed names to diff')
  .action(async (names: string[]) => {
    const previews = await withService((service) =>
      service.previewUpdates({ names }),
    );
    printUpdates(previews);
  });

program
  .command('remove')
  .argument('<name>', 'Installed name')
  .option('--purge', 'Also purge unused cache data')
  .option('--target <agent>', 'Remove one target agent (codex, claude, generic)')
  .option('--scope <scope>', 'Remove one install scope (global, project, workspace)')
  .option('--path <path>', 'Remove the install at an exact target path')
  .option('--json', 'Print machine-readable JSON')
  .action(async (
    name: string,
    flags: {
      purge?: boolean;
      target?: string;
      scope?: string;
      path?: string;
      json?: boolean;
    },
  ) => {
    const removed = await withService((service) =>
      service.removeInstall(name, {
        purge: Boolean(flags.purge),
        adapter: parseAgent(flags.target),
        scope: parseScope(flags.scope),
        targetPath: flags.path,
      }),
    );
    if (flags.json) {
      printSuccessJson('remove', {
        name,
        removed,
      });
      return;
    }
    console.log(
      `\n${symbols.success} ${style.bold('Removed')} ${style.green(removed.name)}\n`,
    );
  });

const cacheCmd = addExamples(
  program.command('cache').description('Manage AgentPM cache'),
  ['agentpm cache clean --dry-run'],
);

const cacheCleanCmd = addExamples(
  cacheCmd
    .command('clean')
    .description(
      'Remove unused Git checkout caches while preserving active installs and the search index',
    )
    .option('--dry-run', 'Show unused cache paths without deleting them'),
  ['agentpm cache clean --dry-run', 'agentpm cache clean --json', 'agentpm cache clean'],
);

cacheCleanCmd.option('--json', 'Print machine-readable JSON').action(async (flags: { json?: boolean }) => {
  const dryRun = Boolean(
    cacheCleanCmd.opts<{ dryRun?: boolean }>().dryRun ||
    rawCliArgs.includes('--dry-run'),
  );
  const result = await withService((service) => service.cleanCache({ dryRun }));
  if (flags.json) {
    printSuccessJson('cache.clean', {
      dryRun,
      result,
    });
    return;
  }
  printCacheCleanResult(result);
});

addExamples(
  program
    .command('push')
    .argument(
      '[pathOrName]',
      'Skill name, relative path, or folder to push. Omit to choose interactively.',
    )
    .option('--to <target>', 'Target id or locator')
    .option('-m, --message <message>', 'Commit message if changes exist')
    .option('--dry-run', 'Show what would be pushed without doing it')
    .option('--all', 'Push all detected skills and agents without prompting')
    .option(
      '--preserve-layout',
      'Keep native target-relative paths instead of normalizing to skills/<name>',
    )
    .option('--json', 'Print machine-readable JSON')
    .action(
      async (
        pathArg: string | undefined,
        flags: {
          to?: string;
          message?: string;
          dryRun?: boolean;
          all?: boolean;
          preserveLayout?: boolean;
          json?: boolean;
        },
      ) => {
        const result = await withService(
          (service) =>
            service.push({
              path: pathArg,
              target: flags.to,
              message: flags.message,
              dryRun: flags.dryRun,
              all: flags.all,
              preserveLayout: flags.preserveLayout,
            }),
          {
            statusMessages: true,
          },
        );
        if (flags.json) {
          printSuccessJson('push', {
            path: pathArg,
            result,
          });
          return;
        }
        if (result.success) {
          console.log(
            `\n${symbols.success} ${style.bold('Pushed to')} ${style.cyan(result.targetLocator)}`,
          );
          for (const entry of result.entries) {
            console.log(`  ${symbols.bullet} ${entry}`);
          }
          if (result.revision) {
            console.log(
              `  ${symbols.bullet} Revision: ${style.bold(result.revision.slice(0, 12))}`,
            );
          }
          for (const warning of result.warnings) {
            console.log(`  ${symbols.warning} ${style.yellow(warning)}`);
          }
          console.log('');
        }
      },
    ),
  [
    'agentpm push',
    'agentpm push --all',
    'agentpm push skill-a --to travelhawk/skills-vault',
    'agentpm push --preserve-layout',
  ],
);

addExamples(
  program
    .command('pull')
    .description(
      'Pull canonical skills from a target repo into your coding agents',
    )
    .argument('[skills...]', 'Skill names to pull. Omit to pull every skill.')
    .option('--from <target>', 'Target id or locator to pull from')
    .option(
      '--target <agents>',
      'Comma-separated agents to install into (codex,claude,generic). Default: auto-detect.',
    )
    .option('--project', 'Install into the current project instead of globally')
    .option('--yes', 'Skip prompts and install to all detected agents')
    .option('--json', 'Print machine-readable JSON')
    .action(
      async (
        skills: string[],
        flags: {
          from?: string;
          target?: string;
          project?: boolean;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        const result = await withService(
          (service) =>
            service.pull({
              skills,
              target: flags.from,
              agents: parseAgents(flags.target),
              scope: flags.project ? 'project' : 'global',
              yes: flags.yes,
            }),
          { statusMessages: true },
        );
        if (flags.json) {
          printSuccessJson('pull', {
            skills,
            result,
          });
          return;
        }
        if (result.success) {
          console.log(
            `\n${symbols.success} ${style.bold('Pulled from')} ${style.cyan(result.sourceLocator)}`,
          );
          for (const install of result.installs) {
            console.log(
              `  ${symbols.bullet} ${style.green(install.name)} ${style.gray('->')} ${install.targetPath}`,
            );
          }
          for (const warning of result.warnings) {
            console.log(`  ${symbols.warning} ${style.yellow(warning)}`);
          }
          console.log('');
        }
      },
    ),
  [
    'agentpm pull --from skills-vault',
    'agentpm pull release-helper --from travelhawk/skills-vault --target codex,claude',
  ],
);

addExamples(
  program
    .command('adopt')
    .description(
      'Bring an existing local skill under AgentPM management and fan it out to other agents',
    )
    .argument(
      '<skillOrPath>',
      'Skill name or path to an existing skill directory',
    )
    .option(
      '--target <agents>',
      'Comma-separated agents to also install into (codex,claude,generic)',
    )
    .option('--yes', 'Skip prompts and install to all detected agents')
    .option('--json', 'Print machine-readable JSON')
    .action(
      async (token: string, flags: { target?: string; yes?: boolean; json?: boolean }) => {
        const result = await withService(
          (service) =>
            service.adopt(token, {
              agents: parseAgents(flags.target),
              yes: flags.yes,
            }),
          { statusMessages: true },
        );
        if (flags.json) {
          printSuccessJson('adopt', {
            token,
            result,
          });
          return;
        }
        if (result.success) {
          console.log(
            `\n${symbols.success} ${style.bold('Adopted')} ${style.green(result.name)} ${style.gray('->')} ${style.underline(result.libraryPath)}`,
          );
          for (const install of result.installs) {
            console.log(
              `  ${symbols.bullet} ${install.adapter} ${style.gray('->')} ${install.targetPath}`,
            );
          }
          for (const warning of result.warnings) {
            console.log(`  ${symbols.warning} ${style.yellow(warning)}`);
          }
          console.log('');
        }
      },
    ),
  [
    'agentpm adopt my-claude-skill --target codex,generic',
    'agentpm adopt .claude/skills/my-claude-skill',
  ],
);

program.command('list').option('--json', 'Print machine-readable JSON').action(async (flags: { json?: boolean }) => {
  const installs = await withService((service) =>
    Promise.resolve(service.listInstalls()),
  );
  const summaries = summarizeInstalls(installs);
  if (flags.json) {
    printSuccessJson('list', { installs: summaries });
    return;
  }
  if (summaries.length === 0) {
    console.log('No installs found.');
    return;
  }
  for (const install of summaries) {
    const targetsSuffix =
      install.targetPaths.length > 1
        ? ` ${style.gray(`(${install.targetPaths.length} targets)`)}` 
        : '';
    console.log(
      `${install.name}  ${install.scope}  ${install.storedPath}${targetsSuffix}`,
    );
  }
});

program.command('init').option('--json', 'Print machine-readable JSON').action(async (flags: { json?: boolean }) => {
  const result = await withService((service) => service.initManifest());
  if (flags.json) {
    printSuccessJson('init', { result });
    return;
  }
  console.log(
    `\n${symbols.success} ${style.bold('Initialized manifest')} ${style.gray('->')} ${style.underline(result.manifestPath)}\n`,
  );
});

program.command('sync').option('--json', 'Print machine-readable JSON').action(async (flags: { json?: boolean }) => {
  const installs = await withService((service) => service.syncManifest());
  if (flags.json) {
    printSuccessJson('sync', { installs });
    return;
  }
  for (const install of installs) {
    console.log(
      `${symbols.success} ${style.bold('Synced')} ${style.green(install.name)}`,
    );
  }
});

program
  .command('resolve')
  .description(
    'Resolve active runtime skill layers without writing project runtime folders',
  )
  .option('--temp <name>', 'Add a temporary skill layer entry', collect, [])
  .option('--json', 'Print the resolved context graph as JSON')
  .action(async (flags: { temp?: string[]; json?: boolean }) => {
    const graph = await withService((service) =>
      service.resolveRuntimeContext({ temporarySkills: flags.temp ?? [] }),
    );
    if (flags.json) {
      console.log(JSON.stringify(graph, null, 2));
      return;
    }
    printRuntimeContext(graph);
  });

addExamples(
  program
    .command('doctor')
    .option('--yes', 'Apply safe fixes without interactive confirmation')
    .option('--fix', 'Interactively apply safe fixes for detected errors')
    .option('--json', 'Print machine-readable JSON')
    .action(async (flags: { fix?: boolean; yes?: boolean; json?: boolean }) => {
      await withService(async (service) => {
        const issues = await service.doctor();
        if (flags.json && !flags.fix) {
          printSuccessJson('doctor', {
            fixPlanned: false,
            issues,
          });
          return;
        }
        printDoctor(issues);

        if (!flags.fix) {
          return;
        }

        const errors = issues.filter((issue) => issue.severity === 'error');
        if (errors.length === 0) {
          if (flags.json) {
            printSuccessJson('doctor', {
              fixPlanned: false,
              issues,
              actions: [],
              results: [],
            });
            return;
          }
          console.log(`\n${symbols.success} No errors detected.\n`);
          return;
        }

        const shouldPlan =
          flags.yes ||
          (await promptToConfirm(
            'Errors detected. Would you like to attempt to fix these issues? [y/N]',
          ));
        if (!shouldPlan) {
          if (flags.json) {
            printSuccessJson('doctor', {
              fixPlanned: false,
              issues,
              actions: [],
              results: [],
            });
            return;
          }
          console.log(`\n${symbols.info} No fixes applied.\n`);
          return;
        }

        const actions = await service.planDoctorFixes(issues);
        if (flags.json && !flags.yes) {
          printSuccessJson('doctor', {
            fixPlanned: true,
            fixApplied: false,
            issues,
            actions,
            results: [],
          });
          return;
        }
        printDoctorFixes(actions, issues);
        if (actions.length === 0) {
          if (flags.json) {
            printSuccessJson('doctor', {
              fixPlanned: true,
              fixApplied: false,
              issues,
              actions,
              results: [],
            });
          }
          return;
        }

        const shouldApply =
          flags.yes || (await promptToConfirm('Apply these fixes? [y/N]'));
        if (!shouldApply) {
          if (flags.json) {
            printSuccessJson('doctor', {
              fixPlanned: true,
              fixApplied: false,
              issues,
              actions,
              results: [],
            });
            return;
          }
          console.log(`\n${symbols.info} No fixes applied.\n`);
          return;
        }

        const results = await service.applyDoctorFixes(actions);
        if (flags.json) {
          printSuccessJson('doctor', {
            fixPlanned: true,
            fixApplied: true,
            issues,
            actions,
            results,
          });
          return;
        }
        for (const result of results) {
          if (result.applied) {
            console.log(`${symbols.success} ${result.action.description}`);
          }
        }
        console.log('');
      });
    }),
  ['agentpm doctor', 'agentpm doctor --fix'],
);

async function resolveRegistryUrl(explicit?: string): Promise<string> {
  if (explicit) {
    return explicit;
  }
  const credentials = await loadRegistryCredentials();
  const origins = Object.keys(credentials.registries);
  if (origins.length === 1) {
    return origins[0]!;
  }
  if (origins.length === 0) {
    throw new Error(
      'No registry configured. Pass --registry <url> or run `agentpm registry login <url>` first.',
    );
  }
  throw new Error(
    `Multiple registries configured (${origins.join(', ')}). Pass --registry <url> to choose one.`,
  );
}

function defaultRegistryDataDir(): string {
  const home = process.env.AGENTPM_HOME?.trim()
    ? path.resolve(process.env.AGENTPM_HOME)
    : path.join(os.homedir(), '.agentpm');
  return path.join(home, 'registry');
}

const registryCmd = addExamples(
  program
    .command('registry')
    .description('Run and use a self-hosted AgentPM registry'),
  [
    'agentpm registry serve --port 7420',
    'agentpm registry login http://localhost:7420 --username admin --password <pw>',
    'agentpm registry publish ./my-skill',
    'agentpm source add registry:http://localhost:7420/index.json',
  ],
);

addExamples(
  registryCmd
    .command('serve')
    .description('Start a self-hosted skill registry with a web UI')
    .option('--port <port>', 'Port to listen on', '7420')
    .option('--host <host>', 'Host to bind', '127.0.0.1')
    .option('--data-dir <dir>', 'Directory for registry data (default: ~/.agentpm/registry)')
    .option('--private', 'Require an API token even for public skills')
    .action(
      async (flags: {
        port: string;
        host: string;
        dataDir?: string;
        private?: boolean;
      }) => {
        const handle = await startRegistryServer({
          dataDir: flags.dataDir ?? defaultRegistryDataDir(),
          host: flags.host,
          port: Number(flags.port),
          publicRead: !flags.private,
        });
        section('AgentPM Registry');
        console.log(`  ${symbols.success} Listening on ${style.cyan(handle.url)}`);
        console.log(`  ${symbols.bullet} Web UI:  ${handle.url}/`);
        console.log(`  ${symbols.bullet} Index:   ${handle.url}/index.json`);
        console.log(`  ${symbols.bullet} API:     ${handle.url}/v1/`);
        if (handle.bootstrap) {
          console.log('');
          console.log(
            `  ${style.bold('First run — admin account created (shown only once):')}`,
          );
          console.log(`    username: ${handle.bootstrap.username}`);
          console.log(`    password: ${handle.bootstrap.password}`);
          console.log(`    token:    ${handle.bootstrap.token}`);
          console.log('');
          console.log(
            `  ${symbols.arrow} Log in: ${style.cyan(`agentpm registry login ${handle.url} --token ${handle.bootstrap.token}`)}`,
          );
        }
        console.log('');
        console.log(`  Press Ctrl+C to stop.`);
        const shutdown = () => {
          void handle.close().finally(() => process.exit(0));
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        // Keep the process attached to the server until it is closed.
        await new Promise<void>((resolve) => {
          handle.server.on('close', resolve);
        });
      },
    ),
  ['agentpm registry serve', 'agentpm registry serve --host 0.0.0.0 --port 8080'],
);

addExamples(
  registryCmd
    .command('login')
    .description('Store credentials for a registry')
    .argument('<url>', 'Registry base URL, e.g. http://localhost:7420')
    .option('--username <username>', 'Registry username')
    .option('--password <password>', 'Registry password')
    .option('--token <token>', 'Existing API token (skips username/password)')
    .option('--json', 'Print machine-readable JSON')
    .action(
      async (
        url: string,
        flags: {
          username?: string;
          password?: string;
          token?: string;
          json?: boolean;
        },
      ) => {
        let username = flags.username;
        let password = flags.password;
        if (!flags.token && !username) {
          username = await promptToInput('Username:');
        }
        if (!flags.token && username && !password) {
          password = await promptToInput(`Password for ${username}:`);
        }
        const result = await registryLogin({
          url,
          username,
          password,
          token: flags.token,
        });
        if (flags.json) {
          printSuccessJson('registry-login', { ...result });
          return;
        }
        console.log(
          `${symbols.success} Logged in to ${result.origin} as ${style.bold(result.username)} (${result.role}).`,
        );
      },
    ),
  [
    'agentpm registry login http://localhost:7420 --username admin --password <pw>',
    'agentpm registry login https://skills.example.com --token agpm_xxx',
  ],
);

addExamples(
  registryCmd
    .command('logout')
    .description('Remove stored credentials for a registry')
    .argument('<url>', 'Registry base URL')
    .option('--json', 'Print machine-readable JSON')
    .action(async (url: string, flags: { json?: boolean }) => {
      const removed = await registryLogout(url);
      if (flags.json) {
        printSuccessJson('registry-logout', { removed });
        return;
      }
      console.log(
        removed
          ? `${symbols.success} Logged out.`
          : `${symbols.info} No stored credentials for that registry.`,
      );
    }),
  ['agentpm registry logout http://localhost:7420'],
);

addExamples(
  registryCmd
    .command('whoami')
    .description('Show the authenticated registry user')
    .argument('[url]', 'Registry base URL (default: the only configured registry)')
    .option('--json', 'Print machine-readable JSON')
    .action(async (url: string | undefined, flags: { json?: boolean }) => {
      const resolved = await resolveRegistryUrl(url);
      const result = await registryWhoami(resolved);
      if (flags.json) {
        printSuccessJson('registry-whoami', { ...result });
        return;
      }
      console.log(
        `${symbols.success} ${result.origin}: ${style.bold(result.username)} (${result.role})`,
      );
    }),
  ['agentpm registry whoami'],
);

addExamples(
  registryCmd
    .command('publish')
    .description('Pack a skill or plugin folder and publish it to a registry')
    .argument('<path>', 'Folder containing the skill (SKILL.md) or plugin')
    .option('--registry <url>', 'Registry base URL (default: the only configured registry)')
    .option('--name <name>', 'Override the published name (default: folder name)')
    .option('--version <version>', 'Version to publish (default: bump latest patch)')
    .option('--visibility <visibility>', 'public or private')
    .option('--tag <tag>', 'Add a tag (repeatable)', collect, [])
    .option('--target <agent>', 'Preferred agent layout: codex, claude, or generic')
    .option('--description <text>', 'Override the description')
    .option('--json', 'Print machine-readable JSON')
    .action(
      async (
        sourcePath: string,
        flags: {
          registry?: string;
          name?: string;
          version?: string;
          visibility?: string;
          tag: string[];
          target?: string;
          description?: string;
          json?: boolean;
        },
      ) => {
        if (
          flags.visibility &&
          flags.visibility !== 'public' &&
          flags.visibility !== 'private'
        ) {
          throw new Error('--visibility must be "public" or "private".');
        }
        const registryUrl = await resolveRegistryUrl(flags.registry);
        const result = await publishSkillToRegistry({
          registryUrl,
          sourcePath,
          name: flags.name,
          version: flags.version,
          visibility: flags.visibility as 'public' | 'private' | undefined,
          tags: flags.tag.length > 0 ? flags.tag : undefined,
          target: parseAgent(flags.target),
          description: flags.description,
        });
        if (flags.json) {
          printSuccessJson('registry-publish', { ...result });
          return;
        }
        console.log(
          `${symbols.success} Published ${style.bold(`${result.name}@${result.version}`)} to ${result.registry} (${result.visibility}).`,
        );
        console.log(
          `  ${symbols.arrow} Install anywhere: ${style.cyan(`agentpm source add registry:${result.registry}/index.json && agentpm install ${result.name}`)}`,
        );
      },
    ),
  [
    'agentpm registry publish ./my-skill',
    'agentpm registry publish ./my-skill --registry http://localhost:7420 --visibility private',
  ],
);

const registryUserCmd = registryCmd
  .command('user')
  .description('Manage registry users (admin only)');

addExamples(
  registryUserCmd
    .command('add')
    .description('Create a registry user')
    .argument('<username>', 'New username')
    .option('--registry <url>', 'Registry base URL')
    .option('--role <role>', 'admin, publisher, or reader', 'publisher')
    .option('--password <password>', 'Password (default: generated and shown once)')
    .option('--json', 'Print machine-readable JSON')
    .action(
      async (
        username: string,
        flags: {
          registry?: string;
          role: string;
          password?: string;
          json?: boolean;
        },
      ) => {
        const registryUrl = await resolveRegistryUrl(flags.registry);
        const token = await getRegistryToken(registryUrl);
        const response = await registryApiRequest({
          method: 'POST',
          url: `${registryUrl}/v1/users`,
          token,
          body: {
            username,
            role: flags.role,
            ...(flags.password ? { password: flags.password } : {}),
          },
        });
        if (flags.json) {
          printSuccessJson('registry-user-add', { ...response });
          return;
        }
        console.log(
          `${symbols.success} Created user ${style.bold(String(response.username))} (${String(response.role)}).`,
        );
        if (typeof response.password === 'string') {
          console.log(
            `  ${symbols.bullet} One-time password (share securely): ${response.password}`,
          );
        }
      },
    ),
  ['agentpm registry user add teammate --role publisher'],
);

addExamples(
  registryUserCmd
    .command('list')
    .description('List registry users')
    .option('--registry <url>', 'Registry base URL')
    .option('--json', 'Print machine-readable JSON')
    .action(async (flags: { registry?: string; json?: boolean }) => {
      const registryUrl = await resolveRegistryUrl(flags.registry);
      const token = await getRegistryToken(registryUrl);
      const response = await registryApiRequest({
        method: 'GET',
        url: `${registryUrl}/v1/users`,
        token,
      });
      const users = Array.isArray(response.users) ? response.users : [];
      if (flags.json) {
        printSuccessJson('registry-user-list', { users });
        return;
      }
      section('Registry Users');
      for (const user of users as Array<Record<string, unknown>>) {
        console.log(
          `  ${String(user.username)}  ${String(user.role)}${user.active === false ? '  (inactive)' : ''}`,
        );
      }
      console.log('');
    }),
  ['agentpm registry user list'],
);

const AGENT_GUIDE = `# AgentPM — guide for AI agents

AgentPM manages skills, agents, and Claude Code plugins across native layouts
(.codex/skills, .claude/skills, .agents/skills, .agentpm/plugins). Every command
supports --json for machine-readable output and --yes to skip prompts.

## Discover & install skills
- agentpm skills search <query> --json          # public skills (skills.sh)
- agentpm skills install <owner/repo@skill> --project --yes --json
- agentpm source add <owner/repo | registry:URL | ./path> --json
- agentpm source skills <source> --json         # list installable entries
- agentpm install <name> --target claude --project --yes --json
- agentpm list --json                           # installed state
- agentpm update --apply --yes --json           # update installs
- agentpm remove <name> --yes --json

## Claude Code plugins
Repos with .claude-plugin/plugin.json or marketplace.json are indexed as
plugins. Installing one places it in <scope>/.agentpm/plugins/<name> and keeps
that folder valid as a Claude Code marketplace. Enable it with:
- claude plugin marketplace add <scope>/.agentpm/plugins   (once)
- claude plugin install <name>@agentpm

## Team contract
- agentpm init --json     # write agentpm.yaml describing required skills
- agentpm sync --json     # reproduce installs from agentpm.yaml after clone

## Self-hosted registry (share skills with full control)
- agentpm registry serve                        # start server + web UI
- agentpm registry login <url> --token <tok>    # or --username/--password
- agentpm registry publish ./my-skill --json    # push a skill/plugin (version bump is automatic)
- agentpm source add registry:<url>/index.json  # subscribe to the registry
- agentpm install <name> --yes --json           # install from it
Private HTTP registries authenticate via stored login, AGENTPM_REGISTRY_TOKEN,
or AGENTPM_REGISTRY_TOKEN_<HOST>.

## Diagnostics
- agentpm doctor --json  # health checks; --fix plans safe repairs
- agentpm cache clean --dry-run --json
`;

addExamples(
  program
    .command('guide')
    .description('Print a compact AgentPM guide for AI agents and new users')
    .option('--json', 'Print machine-readable JSON')
    .action((flags: { json?: boolean }) => {
      if (flags.json) {
        printSuccessJson('guide', { guide: AGENT_GUIDE });
        return;
      }
      console.log(AGENT_GUIDE);
    }),
  ['agentpm guide', 'agentpm guide --json'],
);

try {
  await program.parseAsync(process.argv);
} catch (err: unknown) {
  if (err instanceof Error) {
    if (err.message === '(outputHelp)' || err.message === program.version()) {
      process.exit(0);
    }
    const hints = errorGuidance(err.message);
    if (rawCliArgs.includes('--json')) {
      printErrorJson(err.message, hints);
      process.exit(1);
    }
    console.error(
      `\n${symbols.error} ${style.bold(style.red('AgentPM Command Failed'))}`,
    );
    console.error(`  ${style.red(err.message)}`);
    if (hints.length > 0) {
      console.error('');
      for (const hint of hints) {
        console.error(`  ${symbols.bullet} ${hint}`);
      }
      console.error('');
    }
  } else {
    if (rawCliArgs.includes('--json')) {
      printErrorJson(String(err), [
        'Run `agentpm doctor` for environment checks and `agentpm --help` for command examples.',
      ]);
      process.exit(1);
    }
    console.error(
      `\n${symbols.error} ${style.bold(style.red('An unexpected error occurred'))}`,
    );
    console.error(`  ${style.red(String(err))}\n`);
  }
  process.exit(1);
}
