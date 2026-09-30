# Dependency trust

Installing packages is ordinary work, so the scanner does not reject it outright.
It asks one question instead: **can the content that would be installed still
change after this review?**

The ranking below is by how well the content is nailed down, not by how well
known the name is. A curated name list is a snapshot of reputation, and it ages.
The packages that actually get compromised — event-stream, ua-parser-js, colors,
xz — are exactly the popular ones such a list would contain. So the list only
decides how much noise you see. It never turns a REJECT into a PASS.

## Classes

| Class                     | Condition                                                                                                                                                                | Severity                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `integrity-pinned`        | An artifact hash travels with it: a lockfile `integrity`/`checksum`, `--hash=sha256:`, an image `@sha256:` digest, a 40-hex commit. Default registry, no index override. | INFO                                       |
| `registry-pinned`         | Default registry, exact version by that ecosystem's grammar, install scripts disabled.                                                                                   | INFO                                       |
| `registry-pinned-scripts` | As above, but install scripts still run.                                                                                                                                 | REVIEW                                     |
| `trusted-unpinned`        | Known name, default registry, a range or a tag.                                                                                                                          | REVIEW                                     |
| `unknown-name`            | Default registry, any pin, name not on the list.                                                                                                                         | REVIEW (REJECT under `--strict`)           |
| `executes-fetched`        | `npx`, `bunx`, `uvx`, `pipx run`, `go run x@v`. Fetches and runs in one step, and the pin covers only the root package.                                                  | REVIEW (REJECT under `--strict`)           |
| `name-near-miss`          | Looks like a known name but is not one itself.                                                                                                                           | REVIEW                                     |
| `name-invalid`            | Illegal character set, not NFKC-stable, mixed scripts, or a collision after normalization.                                                                               | REJECT                                     |
| `untrusted-source`        | A URL, a git target, a tarball, a path leaving the skill, an alias target, a custom index, or a container tag without a digest.                                          | REJECT                                     |
| `poisoned`                | Any index override anywhere in the skill.                                                                                                                                | REJECT for **every** package in that skill |

Two further outcomes are about where the package list lives:

- `dep-manifest-missing` (REJECT) — the skill installs from a file it names, such
  as `pip install -r requirements.txt`, and that file is not in the skill. The
  package list was never reviewed.
- `dep-ambient-install` (REVIEW) — the skill runs `npm install`, `npm ci`,
  `uv sync`, `poetry install` or `bundle install` with no file named. That
  installs the dependencies of whatever project the agent is standing in, which
  is the user's own list.

OS installers (`apt`, `brew`, `winget`, `choco`, `snap`) are REVIEW. The scanner
stays offline: it never queries a registry or an advisory database.

## Two deviations worth knowing

**A pinned trusted name is not enough for PASS on its own.** The pin fixes the
identity of the root package, not of its transitive tree, and lifecycle scripts
still run. The top tier needs an artifact hash, or an exact version **plus**
scripts disabled (`npm ci --ignore-scripts`, `pip install --only-binary=:all:`).
That is the concrete thing a skill author can do to earn a PASS.

**Name similarity never causes a REJECT.** Edit-distance-1 against a small list
fires on `requests`/`request`, `pillow`/`pillow-simd` and
`psycopg2`/`psycopg2-binary`, all of which are real packages. Real typosquats are
mostly combosquats (`python-requests`), which distance-1 misses anyway. REJECT is
kept for the two cases with no false positives: a name that cannot legally be
that package, and two names that collide after normalization.

## Pin grammar, per ecosystem

The same string means different things in different manifests. A single "looks
like a version" test gets Cargo wrong in the unsafe direction.

| Ecosystem | Exact                        | Not exact                                |
| --------- | ---------------------------- | ---------------------------------------- |
| npm       | `1.2.3`, `=1.2.3`            | `^1.2.3`, `~1.2.3`, `1.2`, `latest`      |
| PyPI      | `==1.2.3`, `===1.2.3`        | `==1.2.*`, `~=1.2`, `>=1.2`              |
| Cargo     | `=1.0.200`                   | **`"1.0.200"`** — this means `^1.0.200`  |
| Go        | `v1.2.3`, a 12–40 hex commit | `latest`, a branch                       |
| Docker    | `@sha256:…`                  | any tag, including `:latest` and `:3.19` |

PyPI collapses `[-_.]+` to `-` (PEP 503), so `my_pkg` and `my-pkg` are the same
project and a separator difference there is never a typosquat. npm treats them as
different packages, so there it is.

Import names are not distribution names. `import PIL` is satisfied by
`pillow==10.4.0`, `import yaml` by `pyyaml`, `import bs4` by `beautifulsoup4`.

## Lockfiles are the strongest signal

A lockfile pins the _transitive_ tree, which an exact top-level version never
does. `package-lock.json` carries `resolved` plus `integrity`; `uv.lock`,
`poetry.lock`, `Cargo.lock`, `pnpm-lock.yaml`, `yarn.lock` v1 and `go.sum` carry
per-artifact hashes. `Gemfile.lock` has no hashes and `bun.lockb` is binary, so
both stay REVIEW.

## Index overrides poison the whole skill

An index override is not a property of one package. It redirects every install in
the skill, so every package in it becomes REJECT.

- Files: `.npmrc`, `pip.conf`, `uv.toml`, `bunfig.toml`, `.yarnrc.yml`
  `npmRegistryServer`, `NuGet.config`, `.cargo/config.toml`
  `[source.crates-io] replace-with`.
- Commands: `npm config set registry`, `pip config set global.index-url`,
  `poetry source add`, `yarn config set`, `dotnet nuget add source`,
  `gem sources --add`.
- Environment: `PIP_INDEX_URL`, `UV_INDEX_URL`, `NPM_CONFIG_REGISTRY`, `GOPROXY`,
  `GEM_HOST`.

`--extra-index-url` is worse than `--index-url`: it keeps the default index and
pip takes the highest version across both. That is dependency confusion against a
name that is trusted and pinned.

## The override file

The bundled list lives in `scripts/trust-data.mjs`. It ships as a module rather
than as data under `references/`, because the sandboxed child may only read the
script directory and the skill: a `references/trust.json` would raise
`ERR_ACCESS_DENIED`, which the scanner turns into a REJECT.

A local override may add or remove package names:

```json
{
  "schema": 1,
  "add": { "pypi": ["corp-internal-lib"], "npm": ["@corp/ui"] },
  "remove": { "npm": ["event-stream"] }
}
```

It is read from `$AGENTPM_HOME/skill-trust.json`, else
`~/.agentpm/skill-trust.json`, else the path given to `--trust`. The parent
process reads it and passes the result to the sandboxed child on stdin.

The file is validated strictly. Unknown keys, a wrong `schema`, a symlink, a file
over 256 KB or malformed JSON make the whole file a REVIEW finding — never a
silent fallback, because the author believed it was in force.

An agent can write this file, and a skill's own prose can tell it to. Four things
limit the damage:

- `remove` always applies. Taking trust away can only make the scan stricter.
- `add` is ignored under `--strict`.
- Every name trusted only through the override gets an INFO row naming it.
- The policy hash changes, so an approval made under the old policy does not
  carry over.

A skill that mentions `skill-trust.json` or an `agentpm.yaml` `security.` key is
itself a `persist-agent-config` finding: it is attacking the gate rather than
passing it.
