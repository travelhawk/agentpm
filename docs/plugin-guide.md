# Claude Code Plugin Guide

AgentPM indexes and installs Claude Code plugins alongside skills and agents.

## Detection

A source repository exposes plugins when it contains:

- `.claude-plugin/plugin.json` — a single plugin whose root is the parent of
  the `.claude-plugin` directory. The manifest `name` wins over the folder
  name.
- `.claude-plugin/marketplace.json` — a marketplace manifest. Plugins listed
  with relative-path sources (`"source": "./plugins/foo"`) are indexed as
  installable entries too.

Plugin entries use the `plugin` kind and the `claude` adapter.

## Installation model

`agentpm install <plugin-name>` places the plugin at
`<scope root>/.agentpm/plugins/<name>` (a managed link into the AgentPM cache,
like every other install). AgentPM also maintains
`<scope root>/.agentpm/plugins/.claude-plugin/marketplace.json`, which makes
that folder a valid **local Claude Code marketplace**.

Enable an installed plugin natively in Claude Code:

```bash
# once per scope root:
claude plugin marketplace add <scope root>/.agentpm/plugins

# then per plugin:
claude plugin install <name>@agentpm          # global scope
claude plugin install <name>@agentpm-<repo>   # project scope

# one-off session without registering anything:
claude --plugin-dir <scope root>/.agentpm/plugins/<name>
```

AgentPM never writes to `~/.claude/plugins` or Claude Code's own settings —
Claude Code stays the source of truth for enablement, AgentPM stays the source
of truth for content, updates, and provenance.

## Updating and removing

- `agentpm update --apply` refreshes plugin content like any other install.
- `agentpm remove <name>` removes the managed link and rewrites the
  marketplace manifest (the manifest disappears when the last plugin is
  removed).

## Publishing plugins to a registry

`agentpm registry publish ./my-plugin` detects `.claude-plugin/plugin.json`
and publishes the folder as a `plugin`-kind archive. Installing it from the
registry restores the same layout and marketplace behavior.
