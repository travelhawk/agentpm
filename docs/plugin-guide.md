# Plugin Guide (Claude Code and Codex)

AgentPM indexes and installs **Claude Code** and **Codex** plugins alongside
skills and agents.

## Detection

A source repository exposes plugins when it contains a per-agent manifest or
marketplace:

| Agent | Plugin manifest | Marketplace manifest |
|-------|-----------------|----------------------|
| Claude Code | `.claude-plugin/plugin.json` | `.claude-plugin/marketplace.json` |
| Codex | `.codex-plugin/plugin.json` | `.agents/plugins/marketplace.json` (and `api_marketplace.json`) |

For each plugin directory, the manifest `name` wins over the folder name.
Marketplace manifests are also read: plugins listed with a local relative-path
source are indexed too. Claude uses a string source (`"./plugins/foo"`); Codex
uses an object source (`{ "source": "local", "path": "./plugins/foo" }`).

A repository that carries **both** manifests yields one plugin entry per agent,
so you can install it for Claude Code and Codex independently. Plugin entries
use the `plugin` kind; the entry's agent (`claude`/`codex`) is chosen with
`--target`.

### Name clashes with a skill

A repo can contain a skill and a plugin (or two entries for different agents)
that share a name. `agentpm install <name>` then resolves to more than one
entry: interactively it shows a picker labeled by kind and agent; non-interactively
it fails with a clear error. Disambiguate with `--kind <skill|agent|subagent|plugin>`
and/or `--target <codex|claude|generic>`:

```bash
agentpm install widget --kind plugin --target claude
agentpm install widget --kind skill
```

## Installation model

`agentpm install <plugin> --target claude|codex` places the plugin at
`<scope>/.agentpm/plugins/<agent>/plugins/<name>` (a managed link into the
AgentPM cache, like every other install). AgentPM also maintains the agent's
native marketplace manifest in that root, so the folder is a valid **local
marketplace** for that agent:

- Claude Code → `<scope>/.agentpm/plugins/claude/.claude-plugin/marketplace.json`
- Codex → `<scope>/.agentpm/plugins/codex/.agents/plugins/marketplace.json`

Enable an installed plugin natively:

```bash
# Claude Code
claude plugin marketplace add <scope>/.agentpm/plugins/claude   # once per scope
claude plugin install <name>@agentpm            # global scope
claude plugin install <name>@agentpm-<folder>   # project scope

# Codex
codex plugin marketplace add <scope>/.agentpm/plugins/codex     # once per scope
codex plugin add <name>@agentpm                 # global scope
codex plugin add <name>@agentpm-<folder>        # project scope
```

The exact enable command (with the resolved marketplace name) is printed after
each plugin install.

AgentPM never writes to `~/.claude/plugins`, `~/.codex/config.toml`, or either
host's settings — the host stays the source of truth for enablement, AgentPM
stays the source of truth for content, updates, and provenance.

## Updating and removing

- `agentpm update --yes` refreshes plugin content and rewrites the affected
  marketplace manifest so its versions/descriptions stay in sync.
- `agentpm remove <name> --target <agent>` removes the managed link and
  rewrites the marketplace manifest (the manifest disappears when the last
  plugin for that agent is removed).

## Publishing plugins to a registry

`agentpm registry publish ./my-plugin` detects `.claude-plugin/plugin.json` or
`.codex-plugin/plugin.json` and publishes the folder as a `plugin`-kind archive.
Installing it from the registry restores the same layout and marketplace
behavior for the detected agent.

## Not managed by AgentPM

AgentPM materializes plugin **content** and the local marketplace manifest. It
does not run `claude plugin` / `codex plugin` for you, and it does not toggle a
plugin's enabled state in the host's own config — run the printed enable
commands for that.
