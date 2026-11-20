# AgentPM Workflows

Use this reference when the task requires exact `agentpm` command shapes or a decision about `source`, `target`, `adopt`, or `skills` flows.

## Install and Availability

Use the published CLI when `agentpm` is not already installed:

```bash
npm install -g @travelhawk/agentpm
agentpm --help
```

## Fastest On-Ramp

Use the quickstart flows before manual discovery when the task is exploratory:

```bash
agentpm quickstart
agentpm quickstart install
agentpm quickstart team
agentpm quickstart sync
agentpm quickstart --json
```

## Install from Sources

Install from a private, team, or company source:

```bash
agentpm source add internal git@github.com:company/private-skills.git
agentpm install --from internal --skill release-helper --project --add-source
agentpm list
```

## Public Skills (opt-in)

The skills.sh bridge (`agentpm skills search/install/update`) is off by default because public skills are a supply-chain risk. It needs `AGENTPM_ENABLE_SKILLS_SH=1`; `skills list` and `skills remove` always work. Prefer `npx skills add` or another skill manager, and run `skill-security-check` before installing anything public.

## Team Sources and Project Contracts

Use sources plus a repo contract when the current repository should declare required skills:

```bash
agentpm source add travelhawk/skills-vault
agentpm install --from travelhawk/skills-vault --skill release-helper --project --add-source
agentpm init
agentpm sync
```

`agentpm.yaml` supports string shorthand and structured entries. Structured entries can bind a skill to a specific source, git ref, runtime target, scope, and list of items.

## Canonical Push, Pull, and Adopt

Use a canonical target repo when one repository should store the shared skill library:

```bash
agentpm target add my-skills git@github.com:me/skills.git --default
agentpm push --all
agentpm pull --from my-skills
agentpm adopt .claude/skills/my-existing-skill --target codex,generic
```

Add `--target codex,claude,generic` to `pull` when only selected runtimes should receive the synced skills.

## JSON and Automation

Prefer `--json` for automation, CI, or follow-up parsing:

```bash
agentpm quickstart --json
agentpm source list --json
agentpm install release-helper --project --json
agentpm update --json
agentpm update --yes --json
agentpm doctor --json
agentpm doctor --fix --yes --json
```

Expected patterns:

- Read-only or list commands return structured data.
- Stateful commands return an `{ "ok": true, "action": "..." }` shape.
- Preview-style commands require `--yes` to apply changes non-interactively.
- Failures return `{ "ok": false, "error": { "message", "hints" } }`.

## Recovery

Use these commands before manual intervention:

```bash
agentpm source list
agentpm target list
agentpm doctor
agentpm doctor --fix
```

Typical fixes:

- No configured sources: `agentpm source add <repo-or-registry>`
- Non-interactive runs: provide `--skill`, `--all`, `--from`, or `--yes`
- Unknown target agents: use `codex`, `claude`, or `generic`
- Missing repo contract: run `agentpm init`
