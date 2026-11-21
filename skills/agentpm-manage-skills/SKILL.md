---
name: agentpm-manage-skills
description: Manage private, team, and company AI skills with AgentPM. Use when migrating existing Claude, Codex, or generic skills with `agentpm adopt`, installing skills from private or company sources, syncing a git-backed skill repository with `agentpm target add`, `push`, and `pull`, or changing a skill that AgentPM already manages. Also use to set or read the default shared skills repository URL (`AGENTPM_SKILLS_REPO_URL`).
---

# AgentPM Manage Skills

Use `agentpm` instead of copying skill folders by hand. Run `agentpm --help` and `agentpm guide` for the full command list. This skill covers the workflows that are not obvious from the help.

Read [references/agentpm-workflows.md](references/agentpm-workflows.md) for a new source, a new target repo, or a larger migration.

## Default repository URL

`AGENTPM_SKILLS_REPO_URL` is the default shared skills repository. Set it once per machine, then read it:

```powershell
python scripts/agentpm_config.py setup                                  # interactive
python scripts/agentpm_config.py setup --repo-url git@github.com:me/skills.git
python scripts/agentpm_config.py show
```

Pass the value to `agentpm target add` instead of hardcoding another remote.

## Adopt, push, pull

Bring an existing native skill folder under management, then sync it:

```powershell
agentpm adopt .claude/skills/my-skill --target codex,claude,generic
agentpm target add shared-skills $(python scripts/agentpm_config.py show) --default
agentpm push --all
agentpm pull --from shared-skills --target codex,claude
agentpm doctor
```

- Point `adopt` at the skill folder itself, not a parent folder.
- Limit runtimes with `--target`.
- For repo-scoped requirements, use `agentpm init` and `agentpm sync`.

## Install from private sources

```powershell
agentpm source add git@github.com:company/private-skills.git
agentpm install --from git@github.com:company/private-skills.git --skill release-helper --project --add-source
```

Use `--project` when the repo should own the skill, `--global` only for machine-local skills.

## Public skills

AgentPM is for private, team, and company skills. The skills.sh bridge (`agentpm skills search/install/update`) is off by default because public skills are a supply-chain risk. Use it only if the user asks and sets `AGENTPM_ENABLE_SKILLS_SH=1`. For public skills, suggest `npx skills add`, and run the `skill-security-check` skill on anything from a public source first.

## Changing a managed skill

Find it with `agentpm list --json` (`storedPath`). Edit the managed source that `.claude/skills` and `.agents/skills` link to. Never edit a copy and never replace the links, so every agent gets the change.

Check that the skill got better, not worse:

1. Before editing, keep the old version and write 3-5 realistic prompts, including one the skill should not trigger on.
2. Run them against the old and the new version and compare.
3. Keep the change only if it is equal or better.

The `bench-compare` skill can run this if it is installed.

Then ask whether to push it to its remote (check `agentpm target list`). Do a dry run first: `agentpm push <skill> --dry-run`. Never push without a clear yes.

## Recovery

Try `agentpm source list`, `agentpm target list`, `agentpm doctor`, then `agentpm doctor --fix` before any manual cleanup. Add `--json` for scripts.
