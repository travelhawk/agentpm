import type {
  InstallRecord,
  SelectOption,
  SourceRecord,
} from '@agentpm/shared';

// What happens to installed skills when the source they came from is removed.
// `keep` detaches them: they stay installed and keep updating from their own
// content locator. `remove` uninstalls them together with the source.
export type SourceInstallsAction = 'keep' | 'remove';

export interface RemoveSourceOptions {
  installs?: SourceInstallsAction | undefined;
}

export interface RemoveSourceResult {
  source: SourceRecord;
  /** False when the user cancelled at the prompt; nothing was changed. */
  removed: boolean;
  keptInstalls: InstallRecord[];
  removedInstalls: InstallRecord[];
}

const MAX_LISTED_NAMES = 5;

/** Unique skill names, since one skill installed for three agents is three records. */
export function installNames(installs: InstallRecord[]): string[] {
  return [...new Set(installs.map((install) => install.name))];
}

export function describeInstallNames(installs: InstallRecord[]): string {
  const names = installNames(installs);
  const listed = names.slice(0, MAX_LISTED_NAMES).join(', ');
  const hidden = names.length - MAX_LISTED_NAMES;
  return hidden > 0 ? `${listed} and ${hidden} more` : listed;
}

export function countSkills(installs: InstallRecord[]): string {
  const count = installNames(installs).length;
  return `${count} installed skill${count === 1 ? '' : 's'}`;
}

export function sourceInstallsChoices(
  installs: InstallRecord[],
  sourceContentMissing: boolean,
): SelectOption<SourceInstallsAction | 'cancel'>[] {
  const keep: SelectOption<SourceInstallsAction> = {
    label: 'Keep the skills',
    value: 'keep',
    description: sourceContentMissing
      ? 'Keeps the install records only. The source folder is gone, so these skills no longer work.'
      : 'They stay installed and still update from where they came from.',
  };
  const remove: SelectOption<SourceInstallsAction> = {
    label: 'Remove the skills too',
    value: 'remove',
    description: `Uninstall ${describeInstallNames(installs)} from every agent.`,
  };
  const cancel: SelectOption<'cancel'> = {
    label: 'Cancel',
    value: 'cancel',
    description: 'Change nothing.',
  };
  // The first option is the highlighted default. Keeping is the safe choice,
  // unless the source folder is already gone and the skills cannot update.
  return sourceContentMissing ? [remove, keep, cancel] : [keep, remove, cancel];
}

export function sourceInstallsPrompt(
  source: SourceRecord,
  installs: InstallRecord[],
): string {
  return `Source "${source.displayName}" is used by ${countSkills(installs)}: ${describeInstallNames(installs)}. What should happen to them?`;
}

export function sourceInstallsChoiceRequiredMessage(
  source: SourceRecord,
  installs: InstallRecord[],
  sourceContentMissing: boolean,
): string {
  const lines = [
    `Source "${source.displayName}" is still used by ${countSkills(installs)}: ${describeInstallNames(installs)}.`,
  ];
  if (sourceContentMissing) {
    lines.push(
      `Its folder ${source.locator} is gone, so these skills no longer work. Removing them is usually right.`,
    );
  }
  const remove = '  --remove-installs  uninstall the skills, then remove the source';
  const keep = sourceContentMissing
    ? '  --keep-installs    keep the install records only'
    : '  --keep-installs    keep the skills; they still work and update from where they came from';
  lines.push(
    'Choose what happens to them:',
    // Same order as the interactive choices: the recommended flag first.
    ...(sourceContentMissing ? [remove, keep] : [keep, remove]),
  );
  return lines.join('\n');
}

/**
 * Records where a detached install came from, so manifests and diagnostics
 * can still name its origin after the source row is gone.
 */
export function detachInstallFromSource(
  install: InstallRecord,
  source: SourceRecord,
  now: string,
): InstallRecord {
  return {
    ...install,
    metadata: {
      ...install.metadata,
      sourceLocator: source.locator,
      sourceKind: source.kind,
      sourceName: source.displayName,
      detachedAt: now,
    },
    updatedAt: now,
  };
}
