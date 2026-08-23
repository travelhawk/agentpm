# Shared

## Responsibility

Shared types, pure utility functions, and cross-package constants. No runtime dependencies on other AgentPM packages.

## Key Files

- `packages/shared/src/index.ts`

## Entry Points

- Used by all packages via `@agentpm/shared` import

## Dependencies

- Node.js built-ins only (crypto, path)

## Notes

- `classifyLocator` determines source kind from a locator string. `registry:<url-or-path>` is classified as `'registry'`, bare `owner/repo` locators are treated as GitHub Git shorthands, and `file://` locators are treated as Git sources.
- `SourceKind` is `'git' | 'local' | 'registry'`.
- Project and manifest skill specs include `target` as the preferred runtime-layout selector; `adapter` remains a compatibility alias.
- Registry entries include preferred `target` metadata plus legacy `adapterHint`, and carry either `repo` or `archive` (plus optional `version`/`kind`).
- `EntryKind` is `'skill' | 'agent' | 'subagent' | 'plugin'`; plugins are Claude Code plugins detected via `.claude-plugin/` manifests.
- The skill-archive format v1 (`SkillArchive`, `validateSkillArchive`, `assertSafeArchivePath`) is the JSON bundle exchanged with the registry server; validation rejects unsafe paths (absolute, `..`, backslashes), duplicate paths, and unknown kinds/targets.
- Shared result types cover source refresh, cache cleanup dry-runs, and doctor fix actions/results for removing unused sources or stale install records across CLI and core boundaries.
