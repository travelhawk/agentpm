# Getting Started

## Requirements

- Node.js 24 LTS or newer
- Git

## Install the Right Thing

Use the published CLI when you want to use AgentPM:

```bash
npm install -g @travelhawk/agentpm
agentpm --help
```

Use this repository checkout only when developing AgentPM:

```bash
pnpm install
pnpm build
pnpm --filter @travelhawk/agentpm exec agentpm --help
```

If you want the local checkout on your global `PATH` while developing:

```bash
pnpm run link:global
```

## Pick Your First Job

The fastest entry point is:

```bash
agentpm quickstart
```

You can also jump straight to one intent:

```bash
agentpm quickstart install
agentpm quickstart team
agentpm quickstart sync
agentpm quickstart --json
```

## Install One Skill

Use this when you just need a skill in this repo or on this machine.

```bash
agentpm skills search typescript
agentpm skills install typescript --project
agentpm list
```

- `--project` installs into the current repository.
- `--global` installs into your home agent directories.

## Set Up a Team Repo

Use this when the repo should define a shared skill contract.

```bash
agentpm source add git@github.com:company/private-skills.git
agentpm install --from git@github.com:company/private-skills.git --skill shared-review --project --add-source
agentpm init
agentpm sync
```

This creates or updates `agentpm.yaml`. Once the file exists, future project and workspace installs update the contract automatically.

## Sync Skills Across Machines

Use this when you want a canonical skills repository and multiple machines pulling from it.

```bash
agentpm target add my-skills git@github.com:me/skills.git --default
agentpm push --all
agentpm pull --from my-skills
```

Add `--target codex,claude,generic` when you want to control the runtime fan-out explicitly.

## `agentpm.yaml`

Commit `agentpm.yaml` only when you want reproducible repo setup:

```yaml
sources:
  - id: internal
    locator: git@github.com:company/private-skills.git
  - id: registry
    locator: registry:https://registry.example.com/agentpm/index.yaml
  - local:./examples/repos/codex-sample

skills:
  - audio-mastering

  - name: shared-review
    source: registry
    target: generic
    scope: workspace
    workspaceRoot: ..
    ref: main
    items:
      - review/checklists
```

String skills are shorthand. Object skills bind a stable project skill name to a configured source, optional Git ref or resolved revision, runtime target, install scope, and one or more native skill items.

## Public Bridge

For public no-key discovery and import:

```bash
agentpm skills search typescript
agentpm skills install wshobson/agents@typescript-advanced-types --project
agentpm skills install typescript
```

## Machine-Readable Output

Use `--json` in scripts, automation, and CI:

```bash
agentpm quickstart --json
agentpm source list --json
agentpm install release-helper --project --json
agentpm update --json
agentpm update --yes --json
agentpm doctor --json
agentpm doctor --fix --yes --json
```

Conventions:

- successful stateful commands return `ok: true` plus an `action`
- preview-style commands return structured previews unless `--yes` is present
- failures return `ok: false` with recovery hints

## Troubleshooting

Use these first:

```bash
agentpm source list
agentpm target list
agentpm doctor
agentpm doctor --fix
```

Typical fixes:

- no sources configured: `agentpm source add <repo-or-registry>`
- wrong source token: inspect `agentpm source list`
- removing a source that skills came from: `agentpm source remove <source>` asks whether to keep or remove those skills; pass `--keep-installs` or `--remove-installs` to skip the question
- non-interactive execution: pass `--skill`, `--all`, `--from`, or `--yes`
- repo contract issues: run `agentpm init` if the repo should own the contract

## Validation

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm smoke
```

`pnpm smoke` builds the CLI and runs a temporary end-to-end flow with an isolated `AGENTPM_HOME`.
