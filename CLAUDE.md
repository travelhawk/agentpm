# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install deps: `pnpm install` (pnpm 10, Node >= 24)
- Build all packages: `pnpm build` (Turborepo, respects package build order)
- Run the CLI from source: `pnpm start -- <args>` or `node --no-warnings apps/cli/bin/agentpm.js <args>`
- Put dev CLI on global PATH: `pnpm run link:global` (rebuild after changes with `pnpm build`)
- Lint: `pnpm lint` — Typecheck: `pnpm typecheck` — Format: `pnpm format`
- Test (all): `pnpm test` (Vitest)
- Test a single file: `pnpm vitest run tests/install-and-manifest.test.ts`
- Test by name: `pnpm vitest run -t "<test name substring>"`
- End-to-end smoke (build + packaged bin against fixtures, isolated `AGENTPM_HOME`): `pnpm smoke`
- Pack/publish the CLI: `pnpm pack:cli` / `pnpm publish:cli` (only the `@travelhawk/agentpm` bundle is published)

Tests live in the top-level `tests/` directory (not per-package) and run against fixture
repos in `tests/fixtures/repos/{claude,codex,generic,nested-skills}`. Set `AGENTPM_HOME`
to an isolated dir to avoid touching real global state during manual CLI checks.

## Architecture

AgentPM is a Git-native skill manager for AI coding agents (codex, claude, generic). It
installs/updates/syncs/pushes skills from Git repos, local folders, and static registry
indexes **while preserving each agent's native on-disk layout** — it does not convert one
agent format into another.

pnpm + Turborepo monorepo. The CLI is intentionally thin; nearly all behavior lives in
`packages/core`:

- `apps/cli` — Commander.js CLI (`src/index.ts`). Parses args/flags and delegates to the
  core service. Keep command bodies thin.
- `packages/core` — the orchestration layer. `service.ts` (`AgentPmService`) is the
  large hub that coordinates resolution, install/update/sync/push, doctor, and cache.
  `provider-bridge.ts` is the public no-key discovery bridge that shells out to
  `npx skills` (skills.sh) for `agentpm skills search/install/...`.
- `packages/config` — loads/writes the optional committed `agentpm.yaml` project contract
  (and `.agentpmrc` local override). Skills can be string shorthand or detailed objects
  (`source`, `ref`, `revision`, `target`, `scope`, `items`, `workspaceRoot`). `target`
  selects a native layout; `adapter` is a compatibility alias.
- `packages/adapters` — detects and installs native layouts. Scans marker roots like
  `.codex/skills`, `.codex.cloud/skills`, `.claude/agents`, `.agents/skills`, plain
  `skills/`, and `subagents/`. Generic installs from plain `skills/` land in `.agents/skills/`.
- `packages/git` — `simple-git` wrapper with an interactive runner for operations that may
  prompt for SSH/passphrase; manages cached repo checkouts under the cache dir.
- `packages/registry` — loads static local/HTTP YAML/JSON registry indexes, downloads
  skill archives, and manages per-origin registry credentials (env bearer tokens
  `AGENTPM_REGISTRY_TOKEN[_<HOST>]` take precedence over `credentials.json`).
- `packages/registry-server` — self-hosted registry server (`agentpm registry serve`):
  node:http + node:sqlite, users/tokens/roles, public/private skills, JSON skill
  archives, embedded web UI for browsing/curation/user management.
- `packages/db` — persistent install state / manifest records under `AGENTPM_HOME`.
- `packages/fs` — cross-platform filesystem helpers.
- `packages/shared` — shared types and locator classification (`github:owner/repo`,
  `local:<path>`, `registry:<url-or-path>`).
- `packages/ui` — Ink/React interactive components (multi-select pickers, push-target choice).

### Key concepts

- **Two modes**: (1) standalone skill package manager with local installs; (2) committed
  `agentpm.yaml` turns a repo into a shared contract for reproducible `agentpm sync`.
- **Native layout preservation is the default** — compatibility over normalization. A
  Codex skill stays under `.codex/skills/...`, generic under `.agents/skills/...`.
- **Sources of truth** are repos/folders. AgentPM only manages metadata, cache, links,
  and diagnostics around them. Global state, caches (`cache/repos/` with hashed paths),
  and credentials live under `AGENTPM_HOME` and stay local — never committed.
- **Scopes**: global, project, workspace, and temporary runtime layers resolved by
  `AgentPmService.resolveRuntimeContext()` without creating project runtime folders.
  Project/workspace installs write generated target paths to `.git/info/exclude`.
- **Destructive/risky actions require explicit confirmation** (replacing links, remapping
  installs, pruning cache). Install scripts in sources are reported as risks, not executed.

## Conventions & governance

- `AGENTS.md` is authoritative for the operating contract, release law, and git safety —
  read it before non-trivial work. Notably: **never push without explicit `yes`**;
  `CHANGELOG.md` + workspace version bumps move together in the final release-facing commit;
  classify release impact as none/patch/minor/major.
- `docs/summaries/` is the first-pass codebase index; **update the matching summary in the
  same diff** when a summarized module changes. Write docs alongside new commands/config/adapters.
- Add modular helpers instead of widening already-large files (`service.ts` especially).
- Package builds use per-package `tsconfig.build.json` so declaration generation stays scoped.
```
