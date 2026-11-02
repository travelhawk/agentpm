import type { SourceRecord } from '@agentpm/shared';

// Errors for questions AgentPM would ask in a terminal but cannot ask without
// one. Each says what is missing and lists the flags or commands that answer
// it, with the recommended answer first (the same order as the picker).

const MAX_LISTED_NAMES = 5;

export function describeNames(names: string[]): string {
  const unique = [...new Set(names)];
  const listed = unique.slice(0, MAX_LISTED_NAMES).join(', ');
  const hidden = unique.length - MAX_LISTED_NAMES;
  return hidden > 0 ? `${listed} and ${hidden} more` : listed;
}

function describeSources(sources: SourceRecord[]): string {
  return sources
    .map((source) => `  ${source.id}  ${source.displayName} (${source.locator})`)
    .join('\n');
}

export function scopeChoiceRequiredMessage(cwd: string): string {
  return [
    'Choose where to install. Add one of these flags:',
    `  --project    into this project (${cwd})`,
    '  --global     into your home folder, for every project',
    '  --workspace  into a workspace root (with --workspace-root <path>)',
  ].join('\n');
}

export function installNameRequiredMessage(skillNames: string[]): string {
  return [
    'Name the skill to install: agentpm install <name>',
    `Skills you can install: ${describeNames(skillNames)}.`,
    'To see every skill in a source: agentpm source skills <source>',
  ].join('\n');
}

export function installAllSourceRequiredMessage(sources: SourceRecord[]): string {
  return [
    '--all needs a source. Name it first: agentpm install <source> --all',
    'Sources:',
    describeSources(sources),
  ].join('\n');
}

export function sourceRequiredMessage(
  command: string,
  sources: SourceRecord[],
): string {
  return [
    `Name the source: ${command} <source>`,
    'Sources:',
    describeSources(sources),
  ].join('\n');
}

export function agentChoiceRequiredMessage(candidates: string[]): string {
  return [
    `These skills can go into more than one agent: ${candidates.join(', ')}.`,
    'Choose with one of these flags:',
    '  --yes              install into all of them',
    `  --target <agents>  only some of them, e.g. --target ${candidates[0] ?? 'codex'}`,
  ].join('\n');
}

export function pushEntriesChoiceRequiredMessage(available: string): string {
  return [
    'More than one skill or agent can be pushed. Choose with one of these:',
    '  agentpm push <name-or-path>  push one of them',
    '  agentpm push --all           push all of them',
    '',
    `Available entries:\n${available}`,
  ].join('\n');
}

export const UPDATE_NEEDS_CONFIRMATION_WARNING =
  'Skipped: this layout change needs confirmation. Re-run with --yes to apply it.';
