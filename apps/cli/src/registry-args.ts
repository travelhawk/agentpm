import { AgentPmError, type SelectOption } from '@agentpm/shared';

export interface RegistryArgDeps {
  isInteractive: boolean;
  selectOne: <T>(message: string, options: SelectOption<T>[]) => Promise<T>;
}

/** Picks the registry for commands that take an optional --registry. */
export async function chooseRegistryUrl(
  explicit: string | undefined,
  origins: string[],
  deps: RegistryArgDeps,
): Promise<string> {
  if (explicit) {
    return explicit;
  }
  if (origins.length === 1) {
    return origins[0]!;
  }
  if (origins.length === 0) {
    throw new AgentPmError(
      'No registry configured. Pass --registry <url> or run `agentpm registry login <url>` first.',
    );
  }
  if (!deps.isInteractive) {
    throw new AgentPmError(
      `You are logged in to more than one registry. Choose one with --registry <url>:\n${origins
        .map((origin) => `  ${origin}`)
        .join('\n')}`,
    );
  }
  return deps.selectOne(
    'Choose a registry:',
    origins.map((origin) => ({ label: origin, value: origin })),
  );
}

/**
 * Without a terminal, login cannot ask for a username or password, so say
 * which flags to pass. Token login comes first: it keeps the password out of
 * shell history.
 */
export function assertRegistryLoginAnswerable(
  url: string,
  flags: { token?: string | undefined; username?: string | undefined; password?: string | undefined },
  isInteractive: boolean,
): void {
  if (isInteractive || flags.token || (flags.username && flags.password)) {
    return;
  }
  throw new AgentPmError(
    [
      'Login needs a token or a username and password. Pass one of these:',
      `  agentpm registry login ${url} --token <token>`,
      `  agentpm registry login ${url} --username <name> --password <password>`,
    ].join('\n'),
  );
}
