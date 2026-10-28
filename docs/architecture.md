# Architecture

AgentPM is a Git-native CLI for discovering and managing AI skills and agent assets from repositories, local folders, owned registry indexes, and an optional public skills.sh search bridge.

## Runtime flow

1. `apps/cli` parses commands and flags with Commander.
2. `packages/core` resolves the action, source, scope, and confirmation policy.
3. Specialized packages handle config, database, git or local source access, provider bridge execution, adapter detection, file linking, and output formatting.
4. The database tracks sources, indexed catalog entries, cache state, and installs.
5. Project config is declared in committed `agentpm.yaml` only for repos that opt into shared contract mode; optional `.agentpmrc` files are local-only overrides or compatibility fallbacks.
6. Native target directories are populated with symlinks or directory junctions for install/sync flows, while `agentpm resolve` builds a runtime context graph without writing project runtime folders.

## Package responsibilities

- `packages/shared`: domain types and common helpers.
- `packages/config`: AgentPM home resolution and YAML config or manifest IO.
- `packages/db`: SQLite persistence and migrations.
- `packages/git`: shallow sparse Git release materialization and revision checks.
- `packages/registry`: static registry index loading (local or HTTP YAML/JSON indexes).
- `packages/adapters`: repository layout detection and install mapping.
- `packages/fs`: file walking, diffing, and safe link management.
- `packages/ui`: interactive Ink prompts.
- `packages/core`: orchestration, provider bridge logic, and business rules.

## Data model

- `sources`: configured source locators plus metadata and indexing state.
- `catalog_entries`: searchable installable items from repository scans or registry indexes.
- `cache_repos`: cached Git source roots and revision metadata.
- `installs`: active installs, selected items, target paths, tracked revisions, and layout signatures.

## Project-aware runtime resolution

When present, `agentpm.yaml` declares source order, default scope, and required project skills:

```yaml
sources:
  - id: internal
    locator: git@github.com:me/private-skills.git
  - id: company-registry
    locator: registry:https://registry.example.com/agentpm/index.yaml
  - local:~/skills
scope: project
skills:
  - audio-mastering

  - name: review-pack
    source: company-registry
    target: generic
    scope: workspace
    workspaceRoot: ..
    ref: main
    items:
      - review/checklists
```

String skills are shorthand for resolving a skill from configured sources in order. Object skills are the detailed direct contract: `name`, `source`, `ref`, `revision`, `target`, `scope`, `items`, and `workspaceRoot`. `target` is the public runtime-layout field in project config. It selects a matching native adapter (`codex`, `claude`, or `generic`) and does not transform layouts.

Without `agentpm.yaml`, `agentpm install --project` and `agentpm install --workspace` behave like local package-manager installs and do not create a contract file. `agentpm init` is the explicit creation step. Once `agentpm.yaml` exists, project and workspace installs update it automatically.

`agentpm sync` uses source order deterministically and writes generated target paths to `.git/info/exclude` when the scope root is a Git repository. This keeps committed project state focused on `agentpm.yaml`.

`agentpm resolve` returns the active runtime context layers:

- global installs already tracked in AgentPM
- project skills from `agentpm.yaml`
- temporary skills passed with `--temp`

The resolver may index configured sources into AgentPM state, but it does not create native project skill folders or symlinks.

Supported source shorthands include bare `owner/repo`, `github:owner/repo`, `local:<path>`, and `registry:<url-or-path>`. Full Git URLs, SSH locators, local paths, and registry index files remain supported. Private Git sources use the local Git credential setup. Private HTTP registries can be accessed with `AGENTPM_REGISTRY_TOKEN` or a host-specific environment variable such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`.

Public no-key discovery and import is available separately through `agentpm skills search` and `agentpm skills install`, which query the public skills.sh search endpoint over HTTPS (no `npx`, no child process). Selector installs such as `owner/repo@skill` work directly, plain queries can open an interactive picker, and the resolved Git locator then flows through AgentPM's normal install path.

`agentpm source add` stores a local index for the source. `agentpm refresh` rebuilds indexes for all configured sources, or for selected source ids and locators. `agentpm update --refresh` runs the same refresh step before checking installed skills for updates.

Git repository materialization is stored under the AgentPM cache directory in `cache/repos/`. `agentpm cache clean` removes unused repository cache roots and stale cache records without deleting source records or catalog entries, so search remains available after cleanup.

## Diagnostics

`agentpm inspect` reports detected layouts, adapter compatibility, install-script risks, and optional `--skill` / `--target` satisfaction warnings.

`agentpm doctor` validates project config, configured sources, configured skills, installed target links, cache entries, local source paths, write access, and generated targets that were accidentally tracked by Git. `agentpm doctor --fix` is conservative: it plans safe fixes, prints the exact action such as removing an unreachable unused source, and asks again before applying it.
