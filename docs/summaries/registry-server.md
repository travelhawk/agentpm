# Registry Server

## Responsibility

Self-hosted skill registry: stores published skill/plugin archives, manages
users, API tokens, and visibility, serves a client-compatible index and an
embedded web UI.

## Key Files

- `packages/registry-server/src/server.ts` — node:http server, routing, authz
- `packages/registry-server/src/db.ts` — node:sqlite schema (users, tokens, skills, skill_versions)
- `packages/registry-server/src/auth.ts` — scrypt password hashing, `agpm_` tokens (sha256-hashed at rest)
- `packages/registry-server/src/web-ui.ts` — self-contained HTML/JS web UI served at `/`

## Entry Points

- `startRegistryServer(options)` / `createRegistryServer(options)` — used by `agentpm registry serve`
- HTTP: `/index.json`, `/v1/auth/login`, `/v1/whoami`, `/v1/skills[...]`, `/v1/users[...]`, `/v1/tokens[...]`, `/v1/stats`, `/health`

## Dependencies

- node:http, node:sqlite, node:crypto (no external packages)
- @agentpm/shared (`validateSkillArchive`, registry index types)

## Notes

- First run bootstraps an `admin` user and prints password + token once.
- Roles: admin, publisher, reader. Skills are public or private; private ones
  need any authenticated active user. `publicRead: false` (CLI `--private`)
  gates everything behind tokens.
- Archives are stored on disk under `<dataDir>/archives/<name>/<version>.json`;
  metadata lives in `<dataDir>/registry.sqlite`.
- Index entries expose relative `archive` URLs that the client resolves
  against the index locator; downloads increment a per-skill counter.
- Version re-publish returns 409; owners (or admins) manage visibility, tags,
  ownership transfer, deletion.
