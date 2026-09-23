# Skill security layer: research and design proposal

Status: research, 2026-09-18. Nothing here is implemented yet.
Method: 6 web research lanes, each checked by an independent fact checker, 2 code maps of AgentPM, and 1 completeness critic. Claims marked "vendor research" come from one security vendor and are self-reported. Line numbers refer to the working tree on 2026-09-18.

## 1. Short answer

- The worry is real and has a name. OWASP Agentic Skills Top 10 lists it as **AST05 "Untrusted External Instructions"** and **AST07 "Update Drift"**.
- **A content scanner cannot solve it.** Every public skill scanner was bypassed in 2026, including Cisco, NVIDIA and all three skills.sh auditors. In the Air Security demo the skill files were clean. The payload lived at a URL and was swapped after approval. About 26,000 agents followed it (vendor research).
- The controls that do work are **structural and deterministic**:
  1. Pin content by hash and verify it, everywhere.
  2. List every external reference and every capability a skill has. Gate on policy, not on "is this malicious?".
  3. On update, show the **delta** of references and capabilities and ask again.
  4. Bind every approval to a content hash, and store it outside the repo.
- Pattern rules for prompt-injection phrases stay in the design, but only as advice. They never decide "safe".
- No existing tool is a drop-in. The mature engines are Python, and several need an LLM or a cloud API. The reusable parts are **rule files** and **design ideas**.
- AgentPM has concrete gaps today. One is a confirmed pin bypass (section 2).

## 2. Gaps found in AgentPM today

### Confirmed

| # | Gap | Where | Evidence |
|---|-----|-------|----------|
| 1 | **Git pin bypass.** After `fetch origin <sha>`, the code runs `checkout FETCH_HEAD` and never checks that `HEAD` equals the pinned revision. If the remote's default branch is named `FETCH_HEAD`, git checks out the attacker's branch tip. The cache folder is still keyed by the pinned SHA. | `packages/git/src/index.ts:196-223` | Reproduced on git 2.54 (Windows) with AgentPM's exact command sequence: pinned commit A, got commit B. Same class as "Plugin4Shell" (Air Security, 2026-09-17). |
| 2 | **Poisoned cache is trusted forever.** `materializeGitRelease` returns early when the release folder exists. There is no re-verification. | `packages/git/src/index.ts:173-175` | Code reading. |
| 3 | **Registry checksum is never verified, and cannot be.** The server hashes compact `JSON.stringify(archive)`. The download route re-parses and pretty-prints. The index has no checksum field. The client hashes the bytes it received and uses that only as a cache key. | `packages/registry-server/src/server.ts:70-71, 464-465, 581-583`; `packages/core/src/service.ts:4343-4344` | Code reading. |
| 4 | **Registry versions are not immutable.** An owner can delete a version and publish the same version number with new content. A deleted skill name can be claimed by another user. | `packages/registry-server/src/server.ts:550-561, 587` | Code reading. |
| 5 | **`walkFiles` hides things.** It skips symlinks silently and ignores `.git`, `node_modules`, `.turbo`, `dist`. `computeTreeSignature` is SHA-1 over path + content with no separators. A scanner or hash built on these cannot see what the agent can reach. | `packages/fs/src/index.ts:13, 46-81` | Code reading. |
| 6 | **Installs are links into mutable storage.** Local sources link to the live folder. Pull/adopt link to the shared library folder. What was scanned can differ from what the agent reads later. Claude Code reloads an edited `SKILL.md` live. | `packages/core/src/service.ts:4298-4311`; `packages/fs/src/index.ts:138-139` | Code reading. |
| 7 | **`--yes` skips every prompt**, and `sync` hard-codes `yes: true`. A new gate that uses the same flag is bypassed on day one. | `packages/core/src/service.ts:114-127, 1395` | Code reading. |
| 8 | **Pull and adopt do not pass through the install path.** They call `linkSkillIntoAgents` directly. pnpm had the same bug shape (GHSA-379q-355j-w6rj). | `packages/core/src/service.ts:2376-2662` | Code reading. |
| 9 | **Publish can pack secrets.** The ignore list is only `.git, node_modules, .turbo, dist`. `.env`, keys and `.npmrc` are packed. `push` uses `git add --force`. | `packages/fs/src/index.ts:13`; `packages/core/src/service.ts:1964-1970` | Code reading. |
| 10 | **Trust score is cosmetic.** `calculateTrust()` and `detectInstallScripts()` are only printed by `agentpm inspect`. Install, update, sync and pull never read them. | `packages/adapters/src/index.ts:630-710, 771-783` | Code reading. |

### Code-derived, not tested

- Raw `spawn('git', ...)` calls have no `--` separator and do not reject locators or refs that start with `-` (`packages/git/src/index.ts:146, 184, 202`). This is the classic git option-injection class.
- `simple-git` is declared as `^3.28.0`. Three RCE advisories in 2026 affect versions below 3.36.0. The lockfile resolves 3.36.0 today. Raise the floor.
- `assertSafeArchivePath` misses Windows reserved names, trailing dot or space, control characters, and case or Unicode collisions (`packages/shared/src/index.ts:200-280`).
- `agentpm update` does not write the new revision back to `agentpm.yaml`, so the next `sync` re-pins the old one (`service.ts:1076-1156`).
- The registry bearer token is sent to archive URLs on other origins (`packages/registry/src/index.ts:283-297`).
- Fixed on 2026-09-19: the provider bridge used to run `npx skills` without an exact version. It now calls the skills.sh search endpoint over HTTPS and runs no child process.

## 3. Threat picture

| Finding | Source |
|---|---|
| 26.1% of 31,132 skills have at least one vulnerability pattern | arXiv 2601.10338 |
| 36.8% of 3,984 skills flawed, 13.4% critical, 76 confirmed malicious | Snyk "ToxicSkills" |
| 84.2% of vulnerabilities sit in `SKILL.md` prose, not in code | study of 98,380 skills |
| 12.4% of 142,836 skills depend on an untrusted external instruction source | Air Security "Circus of Skills" (vendor research) |
| 925 skills served from GitHub accounts that no longer exist and can be re-registered | Air Security "SkillJacking" (vendor research) |
| 341 to 1,184 malicious skills on ClawHub | "ClawHavoc" reports |
| Trail of Bits bypassed ClawHub, Cisco and the skills.sh scanners. Three of four bypasses took under one hour in total. | Trail of Bits, 2026-06-03 |
| Adversa bypassed 8 of 8 open-source scanners. None beat a "flag everything" baseline on F1. | Adversa AI |
| Cisco's own source-disjoint benchmark: 7.75% recall for the static core | cisco-ai-defense/skill-scanner |

Bypass techniques that a deterministic gate must handle: 100,000 leading newlines to force truncation, payload inside a `.docx`, poisoned `.pyc` next to a clean `.py`, invisible Unicode Tags, homoglyphs, base64, and a registry override that redirects a package install.

Host facts that make AgentPM the right place for the gate:

- Claude Code honours a skill's `allowed-tools` and frontmatter `hooks` without a workspace-trust check for personal-scope skills.
- A folder under `~/.claude/skills/` that contains `.claude-plugin/plugin.json` is loaded as a **full plugin** (hooks, MCP servers, `bin/`, monitors). A "skill" install can silently become a plugin install.
- `.agents/skills` is read by about 15 hosts (Codex, Gemini CLI, Cursor, VS Code Copilot, Zed, and more). A global generic install has the largest blast radius.
- Anthropic's server-side skill scanning covers claude.ai uploads only. It does not cover skills on disk.

## 4. What already exists

Verified with `gh api` on 2026-09-18.

| Project | License | Language | Deterministic? | Use for AgentPM |
|---|---|---|---|---|
| [microsoft/apm](https://github.com/microsoft/apm) (3.8k stars) | MIT | Python | Yes. Lockfile with `resolved_commit` + `content_hash`, hidden-Unicode gate, transitive MCP blocked by default, `apm audit --ci`, org policy file. | **Closest design to copy.** |
| `gh skill` (GitHub CLI 2.90+) | MIT | Go | Yes. `--pin`, records git tree SHA, compares trees on update. No content scanner. | Precedent for pin + drift. |
| [NVIDIA/SkillSpector](https://github.com/NVIDIA/SkillSpector) (17.7k) | Apache-2.0 | Python | Mostly, with `--no-llm`. One rule still calls OSV.dev. LLM is on by default. | Port regex tables. Optional shell-out. |
| [cisco-ai-defense/skill-scanner](https://github.com/cisco-ai-defense/skill-scanner) (2.5k) | Apache-2.0 | Python | Core yes, LLM optional. | Port YAML signatures. Use `evals/skills` as fixtures. |
| [Agent-Threat-Rule/agent-threat-rules](https://github.com/Agent-Threat-Rule/agent-threat-rules) (393) | MIT | TypeScript | Yes. About 825 YAML regex rules. | Vendor a reviewed snapshot at a fixed git SHA. All skill rules are `maturity: test` with about 2% false positives each, so **warn only**. Do not enable its cloud reporter. npm `latest` is 4.0.0. |
| [affaan-m/agentshield](https://github.com/affaan-m/agentshield) (1.2k) | MIT | TypeScript | Yes. 268 rules for hooks, MCP, permissions. | Best TS rule source for **plugin** manifests. |
| [gendigitalinc/sage](https://github.com/gendigitalinc/sage) | Apache-2.0, rules DRL 1.1 | TypeScript | Yes. | 29 prompt-injection content rules are portable. Most rules target runtime commands. |
| [skills-lock/skil-lock](https://github.com/skills-lock/skil-lock) (6) | Apache-2.0 | Go | Yes. | Design idea: capability lock + delta + approvals. |
| [T-Zevin/SkillGuardrail](https://github.com/T-Zevin/SkillGuardrail) (57) | Apache-2.0 | Go | Yes. | Design idea: PASS / REVIEW / BLOCK, approvals bound to fingerprint. "PASS is not a safety certificate." |
| [garagon/aguara](https://github.com/garagon/aguara) (91) | Apache-2.0 | Go | Yes, offline. | Portable YAML rules. |
| [qualixar/skillfortifybench](https://github.com/qualixar/skillfortifybench) | MIT | data | n/a | 540-skill regression corpus that can be vendored. |
| [snyk/agent-scan](https://github.com/snyk/agent-scan) (3k) | Apache-2.0 | Python | **No.** Needs `SNYK_TOKEN` and a cloud API. Scanning MCP configs executes the server commands. | Taxonomy only. |
| skills.sh auditors, ClawHub + VirusTotal, Tencent AI-Infra-Guard | mixed | mixed | **No.** Cloud and LLM. | None for the gate. |

Do not reuse: Nova (GPL-3.0), trufflehog (AGPL), `trailofbits/overtly-malicious-skills` (no license; use as an external test target only), `mannanj/skillguard` (AGPL).

Conclusion: build a small own engine in TypeScript. Vendor rule data with attribution. Offer external scanners only as optional, advisory shell-outs.

## 5. Proposed design

### 5.1 Principles

1. The scanner never says "safe". A clean result reads "no known patterns found; installed files match the reviewed version".
2. Never truncate and never skip a file silently. Anything that cannot be analysed is a finding.
3. The scanner never executes, imports or renders scanned content. It needs no network.
4. The same engine runs at three gates: client install side, client publish side, registry server on upload. The server never trusts a client verdict.
5. Approvals bind to a content hash. Any content change voids them.
6. The approval decision lives under `AGENTPM_HOME`, not in the repo. A committed lock in a stranger's repo is attacker-controlled. (Model: direnv, mise.)

### 5.2 Layer 1: integrity and pinning

- **One canonical source digest.** Per-file SHA-256 over canonical source bytes (git blob bytes or archive file bytes, not the working tree). One line per file: `<sha256>  <posix path>`. Sort by byte order. SHA-256 over that manifest. Symlinks come from git tree mode `120000` and appear as explicit entries. File modes are not part of the digest, because Windows cannot produce them.
  - Reason: CRLF conversion, `.gitattributes eol`, and `core.symlinks=false` make working-tree bytes differ per OS. `vercel-labs/skills` has this exact open bug (#781).
- **Two hashes.** The source digest goes into the committed lock. A separate machine-local hash of the materialized copy stays in the AgentPM database for tamper detection.
- **Fix the git pin.** After checkout, assert `git rev-parse HEAD` equals the requested 40-hex SHA. Check out detached with `<sha>^{commit}`. Verify on cache reuse too. Add `--` and reject leading `-` on every git spawn. Set `GIT_PROTOCOL_FROM_USER=0` and a protocol allow-list for locators that did not come from the user's command line.
- **Scan git objects before checkout.** AgentPM already clones with `--no-checkout`. `git ls-tree -r` shows symlinks, submodules (mode `160000`), `.gitmodules`, `.gitattributes` filters, sizes and path collisions. The result is the same on every OS.
- **Lock data.** Record source, resolved commit, source digest, external references, capabilities and ruleset version per skill. Write it on install **and** on update. Add `agentpm sync --frozen` and `agentpm verify` (also called from `doctor`).
- **Registry.** Publish the digest in `/index.json`. The client verifies before `materializeArchive`. Make `name@version` immutable: yank instead of delete, tombstones for versions and names, case-insensitive unique names, write archive files with flag `wx`.
- **Local sources.** Default to a snapshot copy keyed by digest. Keep live linking as an explicit dev mode, marked `unpinned` in `list` and `doctor`. The pull, adopt and push workflows need this dev mode as a first-class option.

### 5.3 Layer 2: reference and capability inventory

This layer is the main control for the mutable-target worry. It is deterministic because it parses the same files and fields the host parses.

**External references to extract** from every file:

- URLs, with a flag when a fetch verb is near ("fetch", "read the latest", `WebFetch`, `curl`)
- Mutable GitHub forms: raw branch URLs, `releases/latest`
- Package launchers without an exact version: `npx`, `bunx`, `uvx`, `pipx`, `pip install`, `go install`, docker tags without a digest
- Pipe to shell: `curl | sh`, `iwr | iex`
- MCP servers: `url`, `command`, `args`, transport
- Git submodules and LFS pointers
- Symlinks, internal and escaping
- Remote markdown images
- Paths outside the skill: `~/.claude`, `~/.ssh`, `.env`, other skills
- PEP 723 inline script dependencies (`# /// script` blocks run by `uv run`) and index overrides (`--index-url`, `--registry`, bundled `.npmrc`, `pip.conf`, `uv.toml`)
- Self-update instructions

Each reference is classified as **pinned** (40-hex SHA, `@sha256:` digest, exact version) or **mutable**.

**Capabilities to extract:**

- `SKILL.md` frontmatter: `allowed-tools` (flag unrestricted `Bash`, `Write`, interpreters), `hooks`, `context: fork`, `model`
- Dynamic context commands (the `!` backtick syntax) in skills and commands
- Plugin surface, both manifest-declared and auto-discovered: `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `monitors/`, `bin/`, `output-styles/` with force flag, `settings.json` agent override, `agents/` with `permissionMode` or inline `mcpServers`
- Codex: `agents/openai.yaml`, custom agent TOML with `sandbox_mode` and `mcp_servers`
- Bundled ambient config files: `CLAUDE.md`, `AGENTS.md`, `.claude/settings*.json`, `.codex/config.toml`, project-root `.mcp.json`
- Env overrides: `ANTHROPIC_BASE_URL`, `CODEX_HOME`, `NODE_OPTIONS`, proxies
- **Kind escalation:** a `.claude-plugin/` folder inside a payload installed as a skill
- **Name shadowing:** an install whose name collides with an installed skill from another source in an equal or higher precedence location

**Update gate.** On update, sync and pull: re-scan, diff references and capabilities against the lock, show only the delta. New hosts, launchers, hooks, MCP servers and out-of-tree paths need approval. For git sources also check that the old locked commit is an ancestor of the new one. If not, report "repository recreated or force-pushed".

### 5.4 Layer 3: hygiene and hidden channels

High-precision facts. These can block.

- Unicode Tags block (U+E0000 to U+E007F), bidi controls, zero-width characters inside ASCII words, variation-selector smuggling, control and ESC characters
- Escaping or absolute symlinks
- Native executables, bytecode without source (`.pyc`), extension and magic-byte mismatch
- Path rules: traversal, Windows reserved names, trailing dot or space, NFC + case-fold collisions, control characters in names
- Hard limits: file size, file count, total size, depth, line length, leading-whitespace padding
- Verified-format secrets at the publish gates (secretlint is MIT and pure JS; gitleaks rules are MIT)
- A credential deny-list for packing: `.env*`, `*.pem`, `id_*`, `.npmrc` with a token, `.git-credentials`

Vendor the Unicode code-point ranges as data in the rule pack. Do not rely on `\p{...}` classes or `normalize()`. Node 24.0 ships Unicode 16 and Node 24.16 ships Unicode 17, so client and server could disagree.

### 5.5 Layer 4: heuristic rules (advice only)

- Prompt-injection phrases, concealment language ("do not tell the user"), exfiltration shapes, reverse shells, decode-and-exec, persistence paths.
- Run each rule on three views: raw text, normalized text (strip invisibles, fold confusables), and decoded text (base64, hex, percent; depth 2).
- Be Markdown-aware. Separate operative instructions from code fences and "do not do this" sections.
- A phrase hit **inside a hidden channel** (HTML comment, invisible text, decoded blob, padded region) escalates to block.
- Check the rule pack in CI for catastrophic regex backtracking. A scan timeout is a finding, not a pass.
- Record the ruleset version and its hash in every report.

### 5.6 Verdicts and policy defaults

Three verdicts: `pass`, `review`, `block`. Unanalysable content is at least `review`.

The critic measured the proposed defaults against `anthropics/skills`. That repo ships 54 font binaries, a PDF, a `.tar.gz`, 26 executable files, a skill that tells the agent to `WebFetch` a raw `main` branch URL, and an unpinned `npx` call. Strict defaults would block Anthropic's own skills. Another measurement: 38.8% of 17,065 public skills run shell commands and only 4.0% declare it. So:

| Verdict | Default content |
|---|---|
| **block** | Fetch-and-**execute** (pipe to shell). Hidden-channel Unicode. Escaping symlinks. Bytecode without source. Path and archive violations. Digest mismatch. Verified secrets on publish. Phrase rule hit inside a hidden channel. Kind escalation. |
| **review** (needs approval, bound to digest) | Mutable URL the agent is told to read. Unpinned launchers. Remote MCP servers. Any hook. Any `!` command. Broad `allowed-tools`. Archives, binaries, office documents. Reads of credential paths. Name shadowing. Non-allow-listed hosts. |
| **warn** | Heuristic phrase rules. Remote images on allow-listed hosts. Reserved-word names such as `claude-*`. |

Policy knobs in `agentpm.yaml`: `security.allowDomains`, `security.requirePinnedRefs`, `security.mode: standard | strict`. Build a benign fixture corpus **before** any block default ships. Target: 0% false blocks on `anthropics/skills`.

### 5.7 Non-interactive behaviour

- `block`: always fails. Exit code is non-zero. JSON error code `security-blocked` plus the report. `--yes` never overrides it.
- `review` on a TTY: prompt with the top findings.
- `review` without a TTY, or with `--json`: materialize into the cache, **do not link**, return `{ applied: false, requiresConfirmation: true, security }`. This follows the existing `update --json` convention and Composer's "install but do not run plugin code" model.
- Split `InstallOptions.yes` into "skip UX prompts" and a separate security acceptance. `--yes` alone must not accept findings.
- Approvals come from `agentpm approve <skill>`. It refuses non-TTY stdin, because the CLI operator is often an AI agent that can be prompt-injected. Store accepted finding fingerprints with the digest, a reason and a date under `AGENTPM_HOME`.
- `sync` in CI passes only when the lock digest matches **and** the local trust store already approved that digest and capability set.

### 5.8 Code layout and hook points

New package `packages/security` (`@agentpm/security`). It depends only on `@agentpm/shared` and Node built-ins, because `registry-server` depends only on `shared`.

```
packages/security/src/
  types.ts        ScanInput (virtual file list), Finding, Capability, ExternalRef, ScanReport
  tree.ts         lstat walker with no ignore list; filesFromArchive; computeSourceDigest
  rules/          structure.ts  unicode.ts  markdown.ts  remote-refs.ts
                  mcp.ts  hooks.ts  frontmatter.ts  secrets.ts  heuristics.ts
  scan.ts         pure and deterministic: sorted output, no clock, no network
  policy.ts       evaluate(report, policy, previous?) -> pass | review | block, plus delta
  ruleset-version.ts
```

Thin helpers in core: `packages/core/src/security-gate.ts` and `packages/core/src/integrity-lock.ts`. `service.ts` gets call sites only.

| Gate | Hook point |
|---|---|
| install | `service.ts:808`, after materialize, before link |
| archive install | `service.ts:4343`, before `materializeArchive` |
| update | `service.ts:1038`, `:4822`, `:1086`. Also fix the preview/apply race at `:1067-1073`. |
| pull, adopt | `service.ts:2485`, `:2584`. Or route both through one choke point. |
| push | `service.ts:1442-1456`, before `pushToGit`. Assert staged set equals scanned set after `git add`. |
| registry publish (client) | `registry-client.ts:249-257` |
| registry server | `server.ts:416-447`, before the first DB write. `block` returns HTTP 422. `review` stores the version as `quarantined`. |
| shared validation | `validateSkillArchive` in `shared/src/index.ts:200-280` |

Storage: `installs.metadata_json.security` needs no migration for a first version. `RegistryIndexEntry`, `SkillArchive` and `coerceEntry` strip unknown fields, so new fields (`integrity`, `scan`) must be added to type and validator together. The registry DB needs `content_digest`, `status`, `scan_report_json`, `ruleset_version`, `yanked_at`, plus `version_tombstones` and `audit_log` tables. It has no migration system yet; add `PRAGMA user_version`.

UI: sanitize every skill-controlled string before printing (ANSI, OSC, bidi, zero-width), so a skill cannot forge the approval prompt. Add CSP, `nosniff` and `frame-ancestors 'none'` to the registry web UI, and make `esc()` escape quotes.

## 6. Residual risk

State this in the user docs.

- Content the agent fetches at run time cannot be pinned by AgentPM. Fetching the URL at scan time does not help, because the server can show clean content to scanners ("reviewer bait-and-switch").
- The honest mitigations: require approval for fetch-and-follow references, keep a host allow-list, show the external-host inventory in `list` and `doctor`, and let authors vendor documents into the package.
- AgentPM can **generate** host-side egress settings but cannot enforce them: Claude Code `WebFetch(domain:...)` rules, sandbox network allow-list, `disableSkillShellExecution`.
- Paraphrased or translated injection text, instructions inside images, and logic split across files are not reliably detectable by any deterministic scanner.
- **Audit-runtime gap.** Integrity checks run only when someone runs `agentpm`. A same-user process can edit the linked copy. Optional later feature: `agentpm guard` registers a Claude Code `PreToolUse` hook on the `Skill` tool that calls a fast hash-only `agentpm verify`. Other hosts have no such hook. There, copy-instead-of-link plus scheduled verify is the only option.
- An agent with shell access can also write the local trust store. `agentpm approve` refusing non-TTY input reduces this. It does not remove it.

## 7. Open decisions

1. Lock location: new `agentpm.lock`, or new fields in `agentpm.yaml`?
2. Default for `local:` sources: snapshot copy (safer) or live link (current behaviour)?
3. Should `review` findings block non-interactive installs by default, or only in `strict` mode? This affects AI agents that drive the CLI.
4. Rule packs: vendor ATR and Cisco rules now, or ship only own structural rules in version 1?
5. Registry: should `review` uploads be quarantined until an admin approves, or published with a visible warning?
6. Signing (Ed25519 over `name@version:digest` with `node:crypto`): planned for later. It only makes sense after client-side digest pinning exists.

## 8. Suggested phases

| Phase | Content | Release impact |
|---|---|---|
| **0. Hardening** | Git pin verification and cache re-verify. `--` on git spawns. `simple-git >= 3.36.0`. Archive path validator. Origin-scoped registry token. ~~Exact version for `npx skills`~~ (done: the bridge no longer runs `npx`). | patch |
| **1. Integrity** | Canonical digest. Lock data written on install and update. `verify`, `sync --frozen`. Registry digest in index, client verification, immutable versions with yank and tombstones. | minor |
| **2. Scanner core** | `packages/security`: walker, hygiene, hidden channels, reference and capability inventory, policy, verdicts. `agentpm scan <path>`. Benign and malicious fixture corpus. Report-only mode first. | minor |
| **3. Gates** | Wire into install, update, sync, pull, adopt, push, registry publish, and the server. Delta on update. `agentpm approve`. Split `--yes`. Pack deny-list and `.agentpmignore`. | minor; behaviour change for `--yes` |
| **4. Registry UX** | Stored scan report, quarantine queue, findings in web UI and in `agentpm install`. Token scopes and expiry. Audit log. Name-confusion check on first publish. | minor |
| **5. Optional** | Vendored heuristic rule packs. External scanner adapters (SARIF merge). `agentpm guard`. Ed25519 signatures. Release cooldown. | minor |

## 9. Key sources

- OWASP Agentic Skills Top 10: https://github.com/OWASP/www-project-agentic-skills-top-10 (AST05, AST07, AST08, universal skill format draft)
- Trail of Bits, "The sorry state of skill distribution": https://blog.trailofbits.com/2026/06/03/the-sorry-state-of-skill-distribution/
- Adversa AI, eight scanners tested: https://adversa.ai/blog/agent-skill-scanners-bypass-eight-tested/
- Air Security (vendor research): https://www.air.security/blog-posts/the-story-of-skills , https://www.air.security/blog-posts/the-circus-of-skills , https://www.air.security/blog-posts/skilljacking , https://www.air.security/blog-posts/plugin4shell
- microsoft/apm security model: https://microsoft.github.io/apm/enterprise/security/
- GitHub CLI `gh skill`: https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/
- Claude Code docs: https://code.claude.com/docs/en/skills , https://code.claude.com/docs/en/hooks , https://code.claude.com/docs/en/plugins-reference
- Anthropic enterprise skill vetting: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise
- Agent Skills client guide: https://agentskills.io/client-implementation/adding-skills-support
- "Sealing the Audit-Runtime Gap for LLM Skills": https://arxiv.org/abs/2605.05274
- Git clone-time CVEs: CVE-2024-32002, CVE-2025-48384. simple-git advisories: GHSA-hffm-xvc3-vprc, GHSA-r275-fr43-pm7q, GHSA-jcxm-m3jx-f287
- PEP 723 risk: https://safedep.io/pep-723-inline-metadata-security/
- Consent models: https://mise.jdx.dev/paranoid.html , https://nesbitt.io/2026/06/05/install-script-allowlists.html , pnpm GHSA-379q-355j-w6rj
- vercel-labs/skills hash issues: https://github.com/vercel-labs/skills/issues/781 , https://github.com/vercel-labs/skills/issues/806
