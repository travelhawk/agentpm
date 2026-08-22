# AgentPM

<p align="center">
  <a href="https://www.npmjs.com/package/@travelhawk/agentpm"><img src="https://img.shields.io/npm/v/@travelhawk/agentpm?color=cb3837&label=npm" alt="npm version" /></a>
  <a href="https://github.com/travelhawk/agentpm/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-0f766e.svg" alt="MIT License" /></a>
  <a href="https://github.com/travelhawk/agentpm/actions/workflows/ci.yml"><img src="https://github.com/travelhawk/agentpm/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<p align="center">
  <strong>Git-native skill management for AI coding agents.</strong><br />
  Discover, install, sync, and publish skills across Codex, Claude, and generic agent layouts.
</p>

<p align="center">
  <img src="./docs/assets/agentpm-demo.gif" alt="AgentPM add and push demo" width="900" />
</p>

## Install

Use the published CLI when you want to use AgentPM:

```bash
npm install -g @travelhawk/agentpm
agentpm --help
```

Use the repository checkout only when developing AgentPM itself:

```bash
git clone https://github.com/travelhawk/agentpm.git
cd agentpm
pnpm install
pnpm build
pnpm --filter @travelhawk/agentpm exec agentpm --help
```

If you want the development checkout on your global `PATH` while working on the CLI:

```bash
pnpm run link:global
agentpm --help
```

## First 5 Minutes

Start here instead of reading the full command surface:

```bash
agentpm quickstart
agentpm quickstart install
agentpm quickstart team
agentpm quickstart sync
agentpm quickstart --json
```

### 1. Install One Skill

Use this when you want one skill on this machine or in the current repo.

```bash
agentpm skills search typescript
agentpm skills install typescript --project
agentpm list
```

- `--project` installs into the current repo.
- `--global` installs into your home agent directories.

### 2. Set Up a Team Repo

Use this when the repository should declare required skills for everyone who clones it.

```bash
agentpm source add travelhawk/skills-vault
agentpm install --from travelhawk/skills-vault --skill release-helper --project --add-source
agentpm init
agentpm sync
```

This creates and maintains an `agentpm.yaml` contract. Once that file exists, future project and workspace installs update the repo contract automatically.

### 3. Sync Skills Across Machines

Use this when you want one canonical skills repo and multiple machines pulling from it.

```bash
agentpm target add my-skills git@github.com:me/skills.git --default
agentpm push --all
agentpm pull --from my-skills
```

Add `--target codex,claude,generic` to control which runtimes receive pulled skills.

## For AI Agents

AgentPM is safe to drive from another coding agent when the agent avoids prompt-driven flows. Use explicit selectors, explicit targets, `--yes` for confirmations, `--all` for bulk push, and `--json` whenever output will be parsed.

The fastest way to onboard an agent: tell it to run `agentpm guide` (or
`agentpm guide --json`). It prints a compact, agent-oriented reference for
discovery, installs, plugins, the team contract, and the self-hosted registry.

Copy this prompt into an AI coding agent that has shell access:

```text
You are organizing this machine's AI coding skills with AgentPM. Work non-interactively: never rely on TTY menus, pickers, or confirmation prompts. Prefer commands with --json for inspection, and use explicit flags such as --from, --skill, --target, --yes, --all, --project, or --global.

Goal:
- Install AgentPM if it is missing.
- Inspect the current AgentPM state.
- Adopt existing local skills from Codex, Claude, and generic agent folders into AgentPM's canonical library.
- Optionally sync the canonical library to the configured Git target.
- Leave the system in a recoverable state and report exactly what changed.

Rules:
- Before changing anything, run `agentpm --version`, `agentpm --help`, `agentpm quickstart --json`, `agentpm target list --json`, `agentpm source list --json`, `agentpm list --json`, and `agentpm doctor --json`.
- If `agentpm` is not installed, install it with `npm install -g @travelhawk/agentpm`, then rerun the inspection commands.
- Do not run commands that open selection menus. If a command would need a choice, rerun it with explicit names, paths, `--from`, `--skill`, `--target codex,claude,generic`, `--yes`, or `--all`.
- Adopt local skills one explicit path at a time, for example `agentpm adopt ~/.claude/skills/my-skill --target codex,generic --yes --json`.
- When pulling a shared library, use `agentpm pull --from <target-id-or-repo> --target codex,claude,generic --yes --json`.
- When pushing a local canonical library, use `agentpm push --all --to <target-id-or-repo> --message "Sync skills" --json`.
- When removing a skill that may be installed into multiple targets, choose one explicitly, for example `agentpm remove my-skill --target codex --scope project --json` or `agentpm remove my-skill --path <exact-target-path> --json`.
- After changes, run `agentpm doctor --json`; if safe fixes are reported, run `agentpm doctor --fix --yes --json`.
- Never delete or overwrite unmanaged skill folders unless AgentPM explicitly confirms they are managed links or the user has approved that exact path.
- Finish with a concise report: installed AgentPM version, adopted skills, linked targets, pushed revision if any, doctor status, warnings, and commands run.

Suggested workflow:
1. Check whether AgentPM exists: `agentpm --version` and `agentpm --help`.
2. If missing: `npm install -g @travelhawk/agentpm`.
3. Inspect state with JSON: `agentpm quickstart --json`, `agentpm list --json`, `agentpm target list --json`, `agentpm doctor --json`.
4. Adopt explicit local skill paths with `agentpm adopt <path> --target codex,claude,generic --yes --json`.
5. Pull shared skills with `agentpm pull --from <target-id-or-repo> --target codex,claude,generic --yes --json`.
6. Push the canonical library with `agentpm push --all --to <target-id-or-repo> --message "Sync skills" --json`.
7. Remove one duplicate install with `agentpm remove <name> --target <agent> --scope <scope> --json` or `agentpm remove <name> --path <exact-target-path> --json`.
8. Validate with `agentpm doctor --json` and, if appropriate, `agentpm doctor --fix --yes --json`.
```

Agent-safe examples:

```bash
agentpm --version
agentpm quickstart --json
agentpm list --json
agentpm doctor --json
agentpm adopt ~/.claude/skills/release-helper --target codex,generic --yes --json
agentpm pull --from my-skills --target codex,claude,generic --yes --json
agentpm push --all --to my-skills --message "Sync skills" --json
agentpm remove release-helper --target codex --scope project --json
agentpm doctor --fix --yes --json
```

## What AgentPM Does Well

- `📦` Install skills from Git repositories, local folders, static registries, and the public `skills.sh` bridge.
- `🔌` Install Claude Code plugins (`.claude-plugin/plugin.json` and marketplace repos) into a managed local marketplace Claude Code consumes natively.
- `🏠` Run your own registry with `agentpm registry serve`: users, API tokens, public/private skills, publish/install, and a built-in web UI for curation.
- `🧭` Keep the CLI thin while respecting native agent layouts instead of rewriting them.
- `🤝` Turn `agentpm.yaml` into a reproducible team contract for repo-scoped skills.
- `🔁` Publish a canonical `skills/<name>` library with `push`, then materialize it everywhere with `pull`.
- `🩺` Explain broken state with `doctor` and clean stale cache data with `cache clean`.
- `🧾` Emit machine-readable JSON with `--json` across stateful automation flows.

## Self-Hosted Registry

Share skills and plugins with your team under your own control — who can read,
who can publish, and what stays private:

```bash
agentpm registry serve                # starts the server + web UI on :7420
agentpm registry login http://localhost:7420 --token <token-from-first-run>
agentpm registry publish ./my-skill   # automatic patch-version bump
agentpm registry user add teammate --role publisher

# On any other machine:
agentpm source add registry:https://skills.example.com/index.json
agentpm install my-skill
```

The web UI at the server root lets you browse and search skills, read their
docs, copy install commands, toggle public/private visibility, and manage
users and API tokens. See `docs/registry-guide.md` for the full picture.

## Claude Code Plugins

Repos containing `.claude-plugin/plugin.json` (or a marketplace manifest) are
indexed as plugins. `agentpm install <plugin>` places the plugin under
`<scope>/.agentpm/plugins/<name>` and maintains a marketplace manifest there,
so Claude Code can use it natively:

```bash
claude plugin marketplace add ~/.agentpm/plugins   # once
claude plugin install <name>@agentpm
```

See `docs/plugin-guide.md` for details.

## Common Flows

### Project Contract

Create and commit `agentpm.yaml` when you want repository-level setup to be reproducible:

```yaml
sources:
  - id: internal
    locator: git@github.com:company/private-skills.git
  - id: public
    locator: github:agentpm/public-skills
  - id: registry
    locator: registry:https://registry.example.com/agentpm/index.yaml

skills:
  - nextjs-architecture

  - name: audio-mastering
    source: internal
    ref: v1.2.0
    target: codex
    scope: project
    items:
      - audio-mastering
```

String entries are shorthand. Object entries bind a project skill to a configured source, optional Git ref or resolved revision, runtime target, install scope, and one or more native skill items.

### Public Bridge

Use the public bridge when you do not have your own team source yet:

```bash
agentpm skills search typescript
agentpm skills install wshobson/agents@typescript-advanced-types --project
agentpm skills list
agentpm skills update --yes
```

### Canonical Push / Pull / Adopt

AgentPM keeps a canonical skill library in `~/.agentpm/skills/` under `AGENTPM_HOME`. A single skill is stored once and fanned out into agent-specific directories through managed links.

```bash
agentpm target add my-skills git@github.com:me/skills.git --default
agentpm push --all
agentpm pull --from my-skills
agentpm adopt .claude/skills/my-existing-skill --target codex,generic
```

## Automation and JSON Output

For scripts, CI, and local tooling, prefer `--json`:

```bash
agentpm quickstart --json
agentpm source list --json
agentpm install release-helper --project --json
agentpm remove release-helper --target codex --scope project --json
agentpm update --json
agentpm update --yes --json
agentpm doctor --json
agentpm doctor --fix --yes --json
```

Behavior is consistent:

- read/list flows return structured data
- stateful commands return `{ "ok": true, "action": "..." }`
- confirmation-based flows return previews in JSON unless `--yes` is also provided
- failures return `{ "ok": false, "error": { "message", "hints" } }`

## Error Guidance

AgentPM now tries to tell you what to do next instead of only failing.

Typical recovery commands:

```bash
agentpm source list
agentpm target list
agentpm doctor
agentpm doctor --fix
```

Common cases:

- no configured sources: `agentpm source add <repo-or-registry>`
- non-interactive runs: pass explicit flags such as `--skill`, `--all`, `--from`, or `--yes`
- unknown target agents: use `codex`, `claude`, or `generic`
- manifest confusion: run `agentpm init` if the repo should own a contract

## Development

Validate the workspace before release-facing changes:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm smoke
```

`pnpm smoke` builds the CLI and runs an end-to-end flow with an isolated `AGENTPM_HOME`.

## Docs

- [Getting Started](./docs/getting-started.md)
- [Architecture](./docs/architecture.md)
- [Adapter Guide](./docs/adapter-guide.md)
- [Registry Guide](./docs/registry-guide.md)
- [Concept](./docs/concept.md)
- [Plan](./docs/plan.md)
- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
- [Security Policy](./SECURITY.md)

## License

MIT. See [LICENSE](./LICENSE).
