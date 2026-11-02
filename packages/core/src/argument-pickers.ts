import {
  AgentPmError,
  type InstallRecord,
  type ManifestPushTargetSpec,
  type PromptApi,
  type SelectOption,
  type SourceRecord,
} from '@agentpm/shared';

import { describeNames, sourceRequiredMessage } from './choice-guidance.js';
import { canPrompt } from './prompt-guard.js';

// When a command needs one thing from a list (an install, a source, a target)
// and the user left it out: offer the list in a terminal, otherwise say what
// to type and what the choices are. Escape in the picker cancels.

interface PickSpec<T> {
  items: T[];
  /** Thrown when there is nothing to choose from. */
  noneMessage: string;
  /** Thrown when there is no terminal to ask in. */
  missingMessage: string;
  question: string;
  toOption: (item: T) => SelectOption<T>;
}

async function pickMissingArgument<T>(
  prompts: PromptApi,
  spec: PickSpec<T>,
): Promise<T> {
  if (spec.items.length === 0) {
    throw new AgentPmError(spec.noneMessage);
  }
  if (!canPrompt(prompts, 'selectOne')) {
    throw new AgentPmError(spec.missingMessage);
  }
  return prompts.selectOne(spec.question, spec.items.map(spec.toOption));
}

export function pickInstallToRemove(
  prompts: PromptApi,
  installs: InstallRecord[],
): Promise<InstallRecord> {
  return pickMissingArgument(prompts, {
    items: installs,
    noneMessage: 'No skills are installed, so there is nothing to remove.',
    missingMessage: [
      'Name the skill to remove: agentpm remove <name>',
      `Installed: ${describeNames(installs.map((install) => install.name))}.`,
      'To see every install: agentpm list',
    ].join('\n'),
    question: 'Choose a skill to remove:',
    toOption: (install) => ({
      label: `${install.name} (${install.scope} · ${install.adapter})`,
      description: install.targetPath,
      value: install,
    }),
  });
}

export function pickSourceToRemove(
  prompts: PromptApi,
  sources: SourceRecord[],
): Promise<SourceRecord> {
  return pickMissingArgument(prompts, {
    items: sources,
    noneMessage: 'No sources are configured, so there is nothing to remove.',
    missingMessage: sourceRequiredMessage('agentpm source remove', sources),
    question: 'Choose a source to remove:',
    toOption: (source) => ({
      label: source.displayName,
      description: source.locator,
      value: source,
    }),
  });
}

function describeTargets(targets: ManifestPushTargetSpec[]): string {
  return targets
    .map(
      (target) =>
        `  ${target.id ?? target.locator}  ${target.locator}${target.default ? ' (default)' : ''}`,
    )
    .join('\n');
}

/** Resolves a target id, or asks for one when it is missing. */
export async function pickTargetId(
  prompts: PromptApi,
  targets: ManifestPushTargetSpec[],
  id: string | undefined,
  command: 'default' | 'remove',
): Promise<string> {
  const usage = `agentpm target ${command} <id>`;
  const named = targets.filter(
    (target): target is ManifestPushTargetSpec & { id: string } =>
      typeof target.id === 'string',
  );
  if (id) {
    if (named.some((target) => target.id === id)) {
      return id;
    }
    throw new AgentPmError(
      named.length > 0
        ? `There is no target named "${id}". Use one of these ids:\n${describeTargets(named)}`
        : `There is no target named "${id}". No targets are set up yet. Add one with: agentpm target add <git-url>`,
    );
  }
  const picked = await pickMissingArgument(prompts, {
    items: named,
    noneMessage:
      'No targets are set up yet. Add one with: agentpm target add <git-url>',
    missingMessage: `Name the target: ${usage}\nTargets:\n${describeTargets(named)}`,
    question:
      command === 'default'
        ? 'Choose the default push target:'
        : 'Choose a target to remove:',
    toOption: (target) => ({
      label: target.default ? `${target.id} (default)` : target.id,
      description: target.locator,
      value: target,
    }),
  });
  return picked.id;
}
