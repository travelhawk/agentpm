import type { AdapterId, CatalogEntryRecord } from '@agentpm/shared';

export const ADAPTER_IDS: AdapterId[] = ['claude', 'codex', 'generic'];

/** The agents an install was asked for. Empty means "the entry's own layout". */
export function requestedTargets(options: {
  target?: AdapterId | undefined;
  targets?: AdapterId[] | undefined;
}): AdapterId[] {
  const targets = options.targets?.length
    ? options.targets
    : options.target
      ? [options.target]
      : [];
  return [...new Set(targets)];
}

function isSkillEntry(entry: CatalogEntryRecord): boolean {
  return entry.metadata.kind === 'skill' || entry.tags.includes('skill');
}

/** Entries whose own layout belongs to one of the requested agents. */
export function matchesCatalogEntryTargets(
  entry: CatalogEntryRecord,
  targets: AdapterId[],
): boolean {
  return (
    targets.length === 0 ||
    entry.adapterHint === null ||
    targets.includes(entry.adapterHint)
  );
}

/**
 * Entries an install for these agents can use. An entry in a requested
 * agent's own layout wins. A skill that only exists in another layout, such as
 * plain `skills/` (generic), is still usable: it is linked into the native
 * skill folder of every requested agent. Agents, subagents and plugins keep
 * their own layout.
 */
export function selectEntriesForTargets(
  entries: CatalogEntryRecord[],
  targets: AdapterId[],
): CatalogEntryRecord[] {
  if (targets.length === 0) {
    return entries;
  }
  const exact = entries.filter((entry) =>
    matchesCatalogEntryTargets(entry, targets),
  );
  const exactNames = new Set(exact.map((entry) => entry.name));
  return entries.filter(
    (entry) =>
      matchesCatalogEntryTargets(entry, targets) ||
      (isSkillEntry(entry) && !exactNames.has(entry.name)),
  );
}

/**
 * Agents a detected entry is installed for. Skills fan out to every requested
 * agent; everything else stays with the agent its layout belongs to.
 */
export function installAdaptersFor(
  entry: { kind: string; adapter: AdapterId },
  targets: AdapterId[],
): AdapterId[] {
  if (targets.length === 0) {
    return [entry.adapter];
  }
  if (entry.kind === 'skill') {
    return targets;
  }
  return targets.includes(entry.adapter) ? [entry.adapter] : [];
}
