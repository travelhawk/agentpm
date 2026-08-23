# Runtime Architecture

## Responsibility

Summarizes the runtime package split and the main command execution flow.

## Key Files

- `apps/cli/src/index.ts`
- `packages/core/src/index.ts`
- `packages/config/src/index.ts`
- `packages/adapters/src/index.ts`
- `packages/git/src/index.ts`
- `packages/db/src/index.ts`
- `packages/registry/src/index.ts`
- `packages/shared/src/index.ts`

## Entry Points

- `agentpm` CLI binary
- `AgentPmService` orchestration layer

## Dependencies

- Commander.js
- simple-git
- Ink

## Notes

- The CLI stays thin and delegates behavior to `packages/core`.
- Native layout preservation is the default install strategy.
- Public no-key discovery lives in a provider bridge under `packages/core`, not in `packages/registry`.
- `agentpm.yaml` is an optional committed project config that enables shared contract mode. `.agentpmrc` is an optional local override or compatibility fallback.
- Project config sources support shorthands such as bare `owner/repo`, `github:owner/repo`, `local:<path>`, and `registry:<url-or-path>`.
- `agentpm skills search` shells out to `npx skills find`, disables provider telemetry by default, parses provider selectors like `owner/repo@skill`, and the `skills install/list/update/remove` bridge commands reuse normal AgentPM install state while tagging provider-backed installs in metadata; `skills install <query>` can open an interactive picker, one-off direct repo installs do not have to persist a global source, and when `agentpm.yaml` exists AgentPM still persists the resolved source plus optional provider provenance so later `sync` does not need the bridge.
- `agentpm source skills` lists installable entries from a configured source or a direct repo locator, and `agentpm install --from <locator>` reuses the same service-layer selection flow for direct repo installs.
- `agentpm target add` accepts either `<id> <locator>` or a locator alone in interactive mode, then prompts for a target name with a repo-name default suggestion.
- `agentpm.yaml` skills can be string shorthand or detailed objects with `source`, `ref`, `revision`, `target`, `scope`, `items`, and `workspaceRoot`.
- `target` is the public project-config selector for native layouts (`codex`, `claude`, or `generic`); `adapter` remains a compatibility alias.
- `AgentPmService.resolveRuntimeContext()` builds global/project/temporary skill layers without creating project runtime folders.
- Project and workspace installs stay local by default when `agentpm.yaml` is absent; `agentpm init` is the explicit creation step, and later project/workspace installs update the existing `agentpm.yaml`.
- Project install/sync writes generated target paths to `.git/info/exclude` when a scope root is a Git repository.
- Source addition indexes installable entries immediately, and `agentpm refresh`, `agentpm search --refresh`, `agentpm source skills --refresh`, or `agentpm update --refresh` rebuild source indexes later.
- Adapter detection scans supported roots for marker files, so nested collections inside `skills/` can still be indexed and installed.
- Generic installs from plain `skills/` sources now target `.agents/skills/`; already-native `.agents/skills/` and `subagents/` roots are preserved.
- Adapter detection also recognizes `.codex.cloud/skills` and reports install scripts as risks without executing them.
- Git-backed remote operations that may require SSH or passphrase prompts run through an interactive runner, and `agentpm push` now discovers local native entries, preserves their target-relative layout in the destination repo, resolves push targets from global config, force-stages selected paths even when native dot-directories match Git ignore rules, supports interactive multi-select and push target default selection, and handles empty remotes without resolving `HEAD` first.
- Git-backed source clones run quietly, and `agentpm push` reports user-facing progress while reusing a cached target checkout instead of recloning the destination on every push.
- Git cache directories use shortened hashed paths under `cache/repos/` so sparse clones stay within Windows path-length limits, and Git-backed source indexing now reuses that cache when it can do so without mutating an active sparse install checkout.
- Registry sources are static local or HTTP YAML/JSON indexes.
- Private HTTP registry indexes can use `AGENTPM_REGISTRY_TOKEN` or host-specific bearer tokens such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`.
- `agentpm cache clean` removes unused repository caches without clearing active install caches or source catalog indexes, and `--dry-run` previews removals.
- Registry entries with an `archive` URL install through `prepareArchiveContent`: the JSON skill archive is downloaded (with registry auth), materialized into a per-revision release under a stable `cache_...archive...` key (mirroring git releases), and then flows through the normal adapter/link pipeline; `previewArchiveInstallUpdate` re-fetches the latest archive for `agentpm update`.
- Claude Code and Codex plugins are a first-class `plugin` entry kind: `detectPluginGroups` recognizes `.claude-plugin/plugin.json` (adapter `claude`) and `.codex-plugin/plugin.json` (adapter `codex`) plus each host's marketplace manifest. Installs land in `<scope>/.agentpm/plugins/<agent>/plugins/<name>`, and `syncPluginMarketplace(scopeRoot, adapter)` maintains the native manifest — `.claude-plugin/marketplace.json` (string source) for Claude, `.agents/plugins/marketplace.json` (object `{source:"local",path}` + policy) for Codex — so each host adds the folder as a native marketplace. A repo with both manifests yields one entry per agent, chosen via `--target`. Install ids include the adapter so the same name can install for two agents. See `docs/plugin-guide.md`.
- `agentpm install <name>` resolves a name to one installable entry; when several distinct entries share the name (a skill and a plugin, or two agents), it offers an interactive picker (labeled by kind/agent) or, non-interactively, errors. `--kind <skill|agent|subagent|plugin>` filters alongside `--target`. Catalog rows key their id on name+path+adapter+kind and carry `metadata.kind`, so same-name-different-kind entries stay distinct.
- `agentpm registry serve/login/logout/whoami/publish/user` run and talk to the self-hosted registry server (`@agentpm/registry-server`); `registry-client.ts` in `packages/core` holds login/publish logic, and `agentpm guide` prints an agent-oriented usage guide.
- Skills follow a canonical + transform model: a canonical local skill library lives at `skillsLibraryDir` (`~/.agentpm/skills/`, resolved in `@agentpm/config`), and every agent's native skill directory is a symlink back to a single library entry. The `skill` kind installs into the chosen agent's native root (`.codex/skills`, `.claude/skills`, `.agents/skills`) regardless of source layout, preserving any nested collection sub-path; `agent`/`subagent` kinds keep selector/passthrough behavior. `nativeSkillRoot()` in `@agentpm/adapters` is the per-agent root map.
- `agentpm push` normalizes pushed entries to a canonical `skills/<name>` folder by default; `--preserve-layout` keeps native target-relative paths, and canonical destination collisions now abort instead of silently dropping one variant.
- `agentpm pull` (`AgentPmService.pull`) clones the canonical push target, copies its `skills/*` into the library, auto-detects installed agents (`.codex`/`.claude`/`.agents`), multi-selects (default all) via `prompts.selectMany`, and symlinks each chosen agent's native skill dir to the shared library entry (one install record per agent). Defaults to global scope (home agent dirs); `--project` uses cwd.
- `agentpm adopt` (`AgentPmService.adopt`) moves an existing local skill into the library, replaces the origin with a managed symlink, and fans it out to the other agents the same way as pull; if the library already has a different skill with the same name, adopt now aborts before deleting local content. If the origin is already `skillsLibraryDir/<name>`, adopt treats it as a canonical library entry and only links it into selected global agents, avoiding a self-link over the library copy. Both reuse `ensureManagedLink`, `recordGeneratedTargetInLocalGitExclude`, and a backing source row via `db.upsertSource` (installs require a non-null `source_id`).
- `agentpm remove` and `agentpm skills remove` can disambiguate duplicate install names non-interactively with `--target`, `--scope`, or `--path`; without filters, duplicate names still use the interactive picker when available and otherwise fail with the matching target paths.
- `agentpm doctor` validates project config resolution, configured sources/skills, broken installs, cache state, local source paths, permissions, and tracked generated targets. `agentpm doctor --fix` plans and confirms safe removal of unreachable unused sources and stale install records.
