import { AgentPmError } from '@agentpm/shared';

export interface ConfirmDeps {
  isInteractive: boolean;
  confirm: (message: string, details?: string[]) => Promise<boolean>;
}

/**
 * Asks in a terminal. Without one, a confirmation prompt can only fail, so
 * this throws `withoutTerminal` instead: it should say that nothing changed
 * and which flag (usually --yes) answers the question.
 */
export async function confirmOrExplain(
  question: string,
  details: string[],
  withoutTerminal: string,
  deps: ConfirmDeps,
): Promise<boolean> {
  if (!deps.isInteractive) {
    throw new AgentPmError(withoutTerminal);
  }
  return deps.confirm(question, details);
}

export function updatesNeedYesMessage(count: number, command: string): string {
  const updates = `${count} update${count === 1 ? '' : 's'}`;
  return `${updates} ready. Nothing was changed.\nTo apply ${count === 1 ? 'it' : 'them'}, re-run with --yes: ${command} --yes`;
}

export function doctorFixesNeedYesMessage(count: number): string {
  const fixes = `${count} fix${count === 1 ? '' : 'es'}`;
  return `${fixes} planned. Nothing was changed.\nTo apply ${count === 1 ? 'it' : 'them'}, re-run with --yes: agentpm doctor --fix --yes`;
}
