# Registry Guide

AgentPM supports two registry flavors under the `registry` source kind:

1. **Static indexes** — YAML or JSON files served from local paths or HTTP(S)
   URLs whose entries point at Git repositories.
2. **The AgentPM registry server** — a self-hosted server
   (`agentpm registry serve`) that stores published skill archives, manages
   users, tokens, and visibility, serves a compatible `/index.json`, and ships
   a web UI for browsing and curation.

The `skills.sh` CLI bridge is separate from this registry model. Use `agentpm skills search` and `agentpm skills install` when you want no-key public discovery or import without treating the provider as a normal indexed source.

## Supported format

```yaml
version: 1
entries:
  - name: audio-mastering
    description: Codex skill collection for mastering workflows
    repo: https://github.com/example/audio-skills.git
    ref: main
    path: .codex/skills/audio-mastering
    target: codex
    tags:
      - audio
      - mastering
```

`target` is preferred for new registry indexes. `adapterHint` remains supported as a compatibility alias for older indexes.

Entries may reference an `archive` instead of a `repo`. An archive is a JSON
skill bundle (format version 1) that AgentPM downloads and materializes into
its cache before running the normal adapter flow. Archive URLs may be relative
to the index URL; `version` and `kind` (`skill`, `agent`, `subagent`, or
`plugin`) are optional entry metadata:

```yaml
version: 1
entries:
  - name: release-helper
    description: Canonical release helper skill
    archive: v1/skills/release-helper/versions/1.2.0/archive
    version: 1.2.0
    kind: skill
```

## Self-hosted registry server

```bash
agentpm registry serve --port 7420            # data in ~/.agentpm/registry
# First run prints an admin username/password and API token once.

agentpm registry login http://localhost:7420 --token <token>
agentpm registry publish ./my-skill           # version bump is automatic
agentpm registry publish ./my-plugin --visibility private

# Consume it from any machine:
agentpm source add registry:http://localhost:7420/index.json
agentpm install my-skill
```

- The web UI at `/` lets you browse and search skills, read their SKILL.md,
  copy install commands, toggle visibility, delete skills, and manage users
  and API tokens (admin).
- Users have roles: `admin` (everything), `publisher` (publish and manage own
  skills), `reader` (read private skills). Manage them in the web UI or with
  `agentpm registry user add/list`.
- Private skills are only served (index, detail, and archive) to authenticated
  users. Start the server with `--private` to require a token for everything.
- Credentials from `agentpm registry login` are stored per registry origin in
  `~/.agentpm/credentials.json`; environment tokens keep working and take
  precedence.
- Publishing accepts any folder with a `SKILL.md` (skills) or a
  `.claude-plugin/plugin.json` / `.codex-plugin/plugin.json` (Claude Code or
  Codex plugins); pass `--kind` to publish anything else. Re-publishing an
  existing version is rejected; omit `--version` to bump the latest patch
  automatically.

## Behavior

- Add a registry index with `agentpm source add <path-or-url-to-index>`.
- Use `registry:<path-or-url-to-index>` when a source should be treated as a registry even if the locator does not end in `.yaml`, `.yml`, or `.json`.
- Registry search is backed by local indexes for configured sources. Rebuild indexes with `agentpm refresh`.
- Installing a registry entry resolves the underlying repo and path, then follows the normal adapter and cache flow.
- Private HTTP registries can use `AGENTPM_REGISTRY_TOKEN` or host-specific bearer tokens such as `AGENTPM_REGISTRY_TOKEN_REGISTRY_EXAMPLE_COM`. AgentPM reads those tokens from the environment but does not store them.
- Project configs should reference registry sources by top-level source `id`:

```yaml
sources:
  - id: enterprise
    locator: registry:https://registry.example.com/agentpm/index.yaml

skills:
  - name: audio-mastering
    source: enterprise
    target: codex
    ref: v1.2.0
    items:
      - audio-mastering
```
