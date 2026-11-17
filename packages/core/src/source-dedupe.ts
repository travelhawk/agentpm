import {
  gitRepoIdentity,
  type CatalogEntryRecord,
  type InstallRecord,
  type SourceRecord,
} from '@agentpm/shared';

export interface DuplicateSourceGroup {
  identity: string;
  keep: SourceRecord;
  duplicates: SourceRecord[];
}

/** The repository a source points at, or null when it is not a remote git source. */
export function sourceIdentity(source: SourceRecord): string | null {
  return source.kind === 'git' ? gitRepoIdentity(source.locator) : null;
}

/**
 * A readable name for a source: `owner/repo` for git, the host for HTTP
 * registries, and the stored display name otherwise.
 */
export function sourceLabel(source: SourceRecord): string {
  const identity = sourceIdentity(source);
  if (identity) {
    return identity.startsWith('github.com/')
      ? (gitRepoPath(source.locator) ?? identity.slice('github.com/'.length))
      : identity;
  }
  if (source.kind === 'registry' && /^https?:\/\//i.test(source.locator)) {
    try {
      const url = new URL(source.locator);
      const pathname = url.pathname.replace(/\/+$/, '');
      return pathname ? `${url.host}${pathname}` : url.host;
    } catch {
      return source.displayName;
    }
  }
  return source.displayName;
}

// Keeps the owner's spelling (`cmd-one-GmbH/CMD_Skills`); the identity is lower case.
function gitRepoPath(locator: string): string | null {
  const match =
    /github(?:\.com)?[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/*$/i.exec(
      locator.trim(),
    );
  return match?.[1] ?? null;
}

/**
 * Sources that point at the same repository. An https address is kept first
 * (it works without SSH keys), then the one with the most installs, then the
 * oldest. Every install moves to the kept source, so nothing is lost.
 */
export function findDuplicateSources(
  sources: SourceRecord[],
  countInstalls: (sourceId: string) => number,
): DuplicateSourceGroup[] {
  const byIdentity = new Map<string, SourceRecord[]>();
  for (const source of sources) {
    const identity = sourceIdentity(source);
    if (!identity || source.metadata.transient === true) {
      continue;
    }
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), source]);
  }

  const groups: DuplicateSourceGroup[] = [];
  for (const [identity, group] of byIdentity) {
    if (group.length < 2) {
      continue;
    }
    const ranked = [...group].sort(
      (left, right) =>
        httpsRank(right) - httpsRank(left) ||
        countInstalls(right.id) - countInstalls(left.id) ||
        left.createdAt.localeCompare(right.createdAt),
    );
    groups.push({
      identity,
      keep: ranked[0]!,
      duplicates: ranked.slice(1),
    });
  }
  return groups;
}

function httpsRank(source: SourceRecord): number {
  return /^https:\/\//i.test(source.locator) ? 1 : 0;
}

/**
 * The install moved onto the kept source. Its catalog entry is matched by
 * name and path, because the duplicate's entries go away with it.
 */
export function moveInstallToSource(
  install: InstallRecord,
  keep: SourceRecord,
  keepEntries: CatalogEntryRecord[],
  previous: CatalogEntryRecord[],
): InstallRecord {
  const oldEntry = previous.find((entry) => entry.id === install.catalogEntryId);
  const newEntry = oldEntry
    ? keepEntries.find(
        (entry) => entry.name === oldEntry.name && entry.path === oldEntry.path,
      )
    : undefined;
  return {
    ...install,
    sourceId: keep.id,
    catalogEntryId: newEntry?.id ?? (oldEntry ? null : install.catalogEntryId),
  };
}
