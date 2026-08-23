# Changelog

All notable user-facing changes to AgentPM should be recorded in this file.

This repo uses a simple release workflow:

- each release-facing cycle updates this changelog
- each release-facing cycle bumps the workspace package versions together
- changelog and version bumps should land in the same commit when practical

## [0.10.0] - 2026-08-22

### Added

- **Self-hosted registry server** (`agentpm registry serve`): a dependency-free Node HTTP server with SQLite-backed users, API tokens, and skills. It supports roles (admin/publisher/reader), public/private skill visibility, versioned skill/plugin archives, a compatible `/index.json`, and an embedded web UI for browsing, searching, curation, and user/token management. New CLI: `agentpm registry serve/login/logout/whoami/publish/user`.
- **Registry publish/subscribe over archives**: registry index entries may reference a JSON skill **archive** (format v1) instead of a Git repo. `agentpm registry publish <folder>` packs a skill or plugin, auto-bumps the patch version, and installs flow through the normal adapter/link/update pipeline. Credentials are stored per registry origin via `agentpm registry login` (env `AGENTPM_REGISTRY_TOKEN[_<HOST>]` still take precedence).
- **Claude Code and Codex plugin support**: repositories with `.claude-plugin/plugin.json` (Claude Code) or `.codex-plugin/plugin.json` (Codex) — or a matching marketplace manifest — are indexed as a new `plugin` entry kind. Installing one (`--target claude|codex`) lands under `<scope>/.agentpm/plugins/<agent>/plugins/<name>` and maintains that host's native marketplace manifest there (`.claude-plugin/marketplace.json` for Claude, `.agents/plugins/marketplace.json` for Codex), so each host consumes the folder natively. Install ids now include the adapter, so the same name can be installed for two agents.
- `agentpm guide` prints a compact, agent-oriented reference for discovery, installs, plugins, the team contract, and the self-hosted registry.

### Fixed

- `agentpm update` now reuses each install's cache key and registers the materialized release, so revision-pinned installs (e.g. from `agentpm sync`) are no longer deleted by a later `agentpm cache clean`.
- Service status messages are written to stderr, so `--json` output on stdout stays machine-parseable for `source add`, `install`, `skills install`, and `sync`; `update`/`skills update`/`doctor` no longer interleave human output before their JSON, and `doctor --fix --json` returns planned fixes without requiring a TTY.
- `agentpm doctor` no longer reports registry-archive installs as missing local content; duplicate registry entry names surface a clear error instead of a raw SQLite failure; archive installs from one-off `--from` sources now detect new versions.
- Registry index archive URLs are root-absolute so `/v1/index.json` resolves correctly, and `--target` is accepted case-insensitively everywhere.

### Security

- Skill archive versions and Claude Code plugin names are validated so a malicious archive or repository cannot write or link outside the intended directory; the publish handler adds a path-containment check.
- Registry login verifies passwords off the event loop and throttles repeated failures; the CLI strips the bearer token on cross-origin redirects and masks the interactive password prompt.

## [0.9.2] - 2026-06-30

### Added

- Added a README prompt and command recipe for AI agents to install and operate AgentPM without TTY menus, using explicit selectors, `--yes`, `--all`, and `--json`.
- Updated quickstart command recipes so `agentpm quickstart --json` returns non-interactive, agent-safe commands.
- Added a README prompt and command recipe for AI agents to install and operate AgentPM without TTY menus, using explicit selectors, `--yes`, `--all`, and `--json`.
- Updated quickstart command recipes so `agentpm quickstart --json` returns non-interactive, agent-safe commands.

### Fixed

- Prevented `agentpm adopt <name>` from replacing an existing canonical library skill with a self-link when the command is run from `AGENTPM_HOME`; re-adopting a library skill now only links it into the selected agent targets.
- Restored the documented `agentpm push --all` CLI flag so canonical mass-push workflows can run without the interactive multi-select prompt.
- Added `--target`, `--scope`, and `--path` filters to `agentpm remove` and `agentpm skills remove` so agents can remove one duplicate install without a TTY picker.

## [0.9.0] - 2026-06-10

### Added

- Bare GitHub repository shorthand such as `travelhawk/skills-vault` is now accepted anywhere AgentPM accepts Git source or target locators, and AgentPM now stores that shorthand canonically as `github:travelhawk/skills-vault`.
- `agentpm target add` now accepts a locator without an explicit target id in interactive shells, then prompts for a target name with a default suggestion derived from the repository name.

### Changed

- `agentpm --help` keeps the overview examples, while subcommand `--help` pages now show examples tailored to the command being viewed instead of the same global example block.

## [0.8.0] - 2026-06-10

### Added

- Added a canonical local **skill library** at `~/.agentpm/skills/` (under `AGENTPM_HOME`). It is the single source of truth for managed skills: every agent's native skill directory is a symlink back to the library, so a skill is stored once and updates propagate to every agent.
- Added `agentpm pull [skills...] --from <target>` to fetch canonical skills from a target repository and materialize them into your coding agents. Pull auto-detects which agents are present (`.codex`, `.claude`, `.agents`) and lets you multi-select which ones to install into (defaulting to all detected); pass `--target codex,claude,generic` to choose explicitly or `--yes` to skip the prompt.
- Added `agentpm adopt <skillOrPath>` to bring a skill that already lives in one agent (e.g. `.claude/skills/...`) under AgentPM management: it moves the content into the library, replaces the original with a managed symlink, and fans the skill out to the other agents.
- Added a `.claude/skills` native layout so Claude skills are detected and installed alongside Claude agents (`.claude/agents`).

### Changed

- **Push now normalizes to a canonical `skills/<name>` form by default** instead of preserving native target-relative paths. This keeps shared repositories tidy and lets the same repo be pulled into any agent. Use `agentpm push --preserve-layout` to keep the old native-path behavior (`.codex/skills/...`, `.claude/...`).
- **The `skill` kind now transforms across agents**: installing or pulling a skill with `--target codex|claude|generic` materializes it into that agent's native skill root (`.codex/skills`, `.claude/skills`, `.agents/skills`) regardless of the source layout. Previously plain `skills/` sources were always forced into `.agents/skills`. Nested skill collections keep their sub-path under the chosen root. Agent and subagent layouts are unchanged.

## [0.7.0] - 2026-05-26

### Changed

- Push targets are now global-only. `agentpm target add`, `target default`, `target remove`, and `push` resolve targets from global AgentPM config instead of project `agentpm.yaml` targets.
- Direct `agentpm install --from ...` and `agentpm skills install <repo-or-url>` flows can now continue as one-off installs without permanently adding the repository as an AgentPM source; when `agentpm.yaml` exists, the resolved source is still persisted there for later `sync`.
- `agentpm skills install` now accepts plain queries such as `agentpm skills install typescript` and opens an interactive picker, while search output highlights the exact installable selector more clearly.
- Source add, install, provider install, and push flows now show cleaner AgentPM-owned status updates instead of leaking raw internal progress.
- The packaged CLI bootstrap no longer uses top-level await, so Ctrl+C during startup no longer shows Node's unsettled top-level await warning.

### Fixed

- Push documentation and help now consistently describe native-layout preservation, so `.codex`, `.agents`, and `.claude` paths remain in their original format when published.

## [0.6.1] - 2026-05-25

### Added

- Added a GitHub Actions npm publish workflow for the public `@travelhawk/agentpm` CLI package, restricted to `master` and using the `NPM_TOKEN` repository secret with npm provenance.
- Added npm-ready scoped CLI package metadata, README and license packaging, npm-focused install instructions, and README badges for npm, license, CI, and publish status.

### Changed

- Internal `@agentpm/*` workspace packages are now marked private while the CLI package bundles runtime internals for global npm installs.
- Repository-local global install commands are now documented as development-only workflows.

## [0.6.0] - 2026-05-21

### Changed

- `skillshub.wtf` is no longer treated as a built-in registry adapter or shorthand source. Smaller registries should be added through static `registry:<url-or-path>` indexes instead.
- `skills.sh` remains the built-in public registry integration and now stands alone beside static local or HTTP registry indexes under the `registry` source kind.
- First start now offers `skills.sh` as the default public registry only when a `SKILLS_SH_API_KEY` or `SKILLS_API_KEY` is already configured.
- Added a no-key `skills.sh` CLI bridge with `agentpm skills search` and `agentpm skills install`, so public discovery/import can reuse the official `npx skills` workflow without changing AgentPM's private-first Git install model.
- Added `agentpm skills list`, `agentpm skills update`, and `agentpm skills remove` so provider-backed installs can be managed through the same bridge workflow after import.
- Provider-backed installs saved into `agentpm.yaml` now persist the resolved syncable source plus optional `skills.sh` provenance, so later `agentpm sync` works without the bridge.

## [0.5.1] - 2026-05-21

### Changed

- `agentpm install --project` and `agentpm install --workspace` no longer create `agentpm.yaml` automatically when a repo has not opted into contract mode yet.
- `agentpm init` is now the explicit way to create `agentpm.yaml` from current local installs, while later project and workspace installs update the existing manifest automatically.
- Docs now distinguish local package-manager installs from manifest-backed repo sync workflows.
- Git-backed source installs and `agentpm push` now suppress raw Git progress output, show AgentPM-owned status messages instead, and reuse cached target checkouts across repeated pushes.

## [0.5.0] - 2026-05-19

### Added

- `agentpm source skills` (alias `agentpm source entries`) to list installable skills from a configured source or a direct repo locator, with optional `--target`, `--refresh`, and `--json` output.
- `agentpm install --from <source-or-repo>` to install directly from a configured source, GitHub shorthand, Git URL, SSH URL, or local folder without forcing a separate search step first.
- Interactive direct-repo install selection for multi-skill repositories, plus `--add-source` for explicit source persistence in non-interactive workflows.

### Changed

- Git source indexing now reuses the persistent checkout cache when possible, so `source add` followed by install no longer duplicates the remote checkout in the common Git-backed flow.
- CLI help and getting-started docs now show the smoother source-listing and direct-repo install workflow.
- `file://` repository locators are now treated as Git sources.
- Workspace package versions were aligned to `0.5.0`.

## [0.4.0] - 2026-05-18

### Added

- `agentpm search --refresh` to refresh configured source indexes before searching, plus stale-index guidance when normal search returns no matches.
- Push target default management with `agentpm target add --default`, `agentpm target default`, and interactive default selection during `agentpm push`.
- `agentpm cache clean --dry-run` to preview unused Git checkout cache removals.
- `agentpm doctor --fix` can now remove stale install records when generated skill folders were deleted outside AgentPM.

### Changed

- Plain `skills/<name>` generic sources now install into `.agents/skills/<name>` so synced project skills are immediately usable by `.agents` runtimes.
- Cache, help, doctor, and update CLI output now explains outcomes and next actions more clearly.
- Workspace package versions were aligned to `0.4.0`.

### Fixed

- `agentpm doctor` no longer reports a duplicate missing-cache error for an install whose target path is already missing.
- `agentpm update` now prints an explicit success summary after applying changes.

## [0.3.0] - 2026-05-18

### Added

- `agentpm refresh` and `agentpm update --refresh` to rebuild local source indexes from configured registry, Git, and local sources.
- Interactive `agentpm update` previews that ask for confirmation before applying available skill updates.
- `agentpm cache clean` to remove unused repository cache roots while preserving source indexes for search.
- `agentpm doctor --fix` safe-fix planning for unreachable unused sources, including a second confirmation before applying changes.
- Regression coverage for Git source refresh, commit-pinned installs, cache cleanup, doctor fixes, and push flows.

### Changed

- Git cache materialization now lives under `cache/repos/` for a more explicit cache layout.
- Workspace package versions were aligned to `0.3.0`.

### Fixed

- PNPM/Vitest push tests no longer fail from a `packages/core` runtime import of `simple-git`; core push now uses the existing Git command runner.

## [0.2.2] - 2026-05-17

### Added

- Contributor governance documents, PR template, security policy, changelog, and GitHub Sponsors funding metadata.
- A repo-local GodMode operating contract in `AGENTS.md` for governance preflight, role routing, validation gates, and release-impact reporting.

### Changed

- Repository governance now requires release-facing cycles to update both the changelog and workspace package versions.

## [0.2.1] - 2026-05-17

### Added

- Interactive multi-select for `agentpm push`, including select-all and select-none controls in TTY mode.

### Changed

- `agentpm push` now resolves local skills and agents by name or path, preserves native target-relative layout in the destination repository, and handles empty Git remotes correctly.
- Git-backed remote operations now use an interactive runner that works with SSH passphrase prompts and private remotes more reliably.

## [0.2.0] - 2026-05-17

### Added

- Push target management commands and project/global target configuration.
- Project-aware `agentpm.yaml` support with detailed skill objects, source binding, target selection, sync, resolve, and doctor coverage.
- Layered multi-source resolution across local folders, Git repositories, static registries, private registries, and SkillsHub.
- Smoke-test coverage for end-to-end CLI behavior and registry-backed project sync flows.

### Changed

- The CLI received a broader UX overhaul, including improved inspect, install, and push-oriented flows.
- Git push fallback support was added for non-Git local folders targeting Git remotes.
- Registry loading and compatibility handling expanded to cover newer adapter and target semantics.
- Package versions were aligned to `0.2.0` across the publishable workspace.

## [0.1.0] - 2026-05-10

### Added

- Initial AgentPM release with CLI commands, workspace packages, adapter detection, registry support, config handling, tests, docs, and CI.

### Changed

- SQLite storage was later migrated from `better-sqlite3` to built-in `node:sqlite` during the early `0.1.x` development cycle before the `0.2.0` version line.
