# Registry

## Responsibility

Loads and parses static registry index files (JSON/YAML).

## Key Files

- `packages/registry/src/index.ts`

## Entry Points

- `loadRegistryIndex(locator, env)` — dispatched from `packages/core` during `reindexSource`
- `fetchSkillArchive(url, env)` — downloads and validates a JSON skill archive
- `registryApiRequest({method, url, token, body})` — JSON client for the registry server API
- `setRegistryCredential` / `removeRegistryCredential` / `getRegistryToken` / `loadRegistryCredentials` — per-origin credentials in `<AGENTPM_HOME>/credentials.json`

## Dependencies

- js-yaml
- @agentpm/fs (pathExists, readTextFile)
- @agentpm/shared (AgentPmError, types, isHttpUrl, validateSkillArchive)

## Notes

- Supports static registry files (local .json/.yaml files or HTTP URLs serving them), including `registry:<url-or-path>` source shorthands. Registry indexes are rebuilt on source add and refresh.
- Registry entries must carry `repo` or `archive` (a skill-archive URL, possibly relative to the index locator) plus optional `version` and `kind` (`skill`/`agent`/`subagent`/`plugin`).
- Registry entries prefer `target` for the native runtime layout and still accept `adapterHint` as a compatibility alias.
- The no-key public `skills.sh` path is not handled here; it lives in the provider bridge under `packages/core`.
- HTTP requests use `node:http`/`node:https` (not `fetch()`) to avoid a libuv handle cleanup assert on Windows (Node.js v25.x); plain `http:` is supported for local registry servers.
- Bearer tokens resolve in order: `AGENTPM_REGISTRY_TOKEN_<HOST>`, `AGENTPM_REGISTRY_TOKEN`, then the stored credential for the URL origin (written by `agentpm registry login`).
