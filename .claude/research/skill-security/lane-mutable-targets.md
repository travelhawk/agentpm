# mutable-targets

## SUMMARY
The owner's worry is a recognised, measured attack class with a name: OWASP Agentic Skills Top 10 AST05 "Untrusted External Instructions" and AST07 "Update Drift" ("there is no lockfile for prose"). It was exploited or demonstrated repeatedly in 2026. Snyk ToxicSkills found 2.9% of ClawHub skills fetch and execute remote content at run time. Air Security found 12.4% of 142,836 skills rest on untrusted external instruction sources. SkillJacking showed 925 skills hijackable by re-registering deleted GitHub accounts. Plugin4Shell (disclosed 2026-09-17) bypassed SHA pinning in Claude Code, Codex, Copilot and Gemini CLI because the clients never verified HEAD after checkout.

Mature ecosystems (npm, Go, Cargo, pip, Deno, Nix, Docker, GitHub Actions, Homebrew, Terraform, MCP tool pinning) converge on seven transferable rules:
1. Names, tags, branches and URLs are mutable. Only content hashes and full commit SHAs are pins.
2. Resolve loose specs once into a committed lockfile that records the resolved commit plus an integrity hash.
3. Verify on the client after materialisation, all-or-nothing, with a frozen mode for sync and CI.
4. Upgrades are an explicit command that shows a diff.
5. Registry versions are never reusable, even after delete.
6. Approval binds to content, not to a name, so any change forces re-approval (trust on first use plus re-consent).
7. Add a cooldown for fresh releases.

A deterministic scanner can find practically every kind of mutable reference: URLs, unpinned npx/uvx/pip/docker, curl|sh and iwr|iex, MCP urls and commands, submodules, LFS pointers, symlinks, Claude `!`cmd`` dynamic context, hooks, and paths outside the skill. It cannot reliably decide whether a URL will be consumed as instructions or as data. So the policy should be host-allowlist plus explicit approval rather than semantic judgement.

A package manager adds what a scanner cannot:
- a SHA-256 tree-hash lock over the whole skill;
- verification on install, sync and update;
- drift detection on the installed copy and on link targets;
- snapshot copies instead of links to mutable local sources;
- immutable registry versions;
- re-scan on update, with a diff of NEW external references and NEW capabilities gated by approvals bound to the tree hash.

Residual risk: content the agent fetches at run time cannot be pinned by AgentPM, and cloaking defeats scan-time fetching. The honest mitigations are to block or force-approve fetch-and-follow patterns, require vendored snapshots at publish, record an external-host inventory in the lock, and emit agent-side egress controls (WebFetch domain rules, sandbox network allowlist, disableSkillShellExecution). AgentPM can generate these but cannot enforce them.

Reading the AgentPM code surfaced four concrete gaps (not tested end to end):
- packages/git checks out FETCH_HEAD and never compares HEAD to the pinned revision. This is the same pattern as the Plugin4Shell Gemini CLI variant.
- computeTreeSignature is SHA-1 with no field delimiters and silently skips symlinks.
- The registry server lets an owner delete a version and republish the same version number. The checksum is not in the index and the client does not verify it.
- Local sources are linked in place, so they stay mutable after install.

## RECOMMENDATIONS
- P0: fix pin verification in packages/git/src/index.ts. After checkout, assert that `git rev-parse HEAD` equals the requested 40-hex revision; on mismatch, delete the release directory and fail. Check out with `--detach` using `<sha>^{commit}`. Refuse remote refs named FETCH_HEAD or matching /^[0-9a-f]{40}$/. This closes the Plugin4Shell pattern, which I found plausible in the code but did not test.
- P0: make registry versions truly immutable. Tombstone deleted versions and deleted skill names (npm's never-reuse rule). Prefer yank over delete. Add an `integrity` tree hash to the index.json entries and the API. Have the client verify the download against the index and against agentpm.lock. Stop hashing JSON.stringify output; hash the canonical file manifest instead. Add an append-only hash-chained publish log.
- P0: add one canonical SHA-256 tree hash in packages/fs. Use a Go h1-style sorted manifest of `sha256  mode  path` lines with explicit symlink entries, and reject control characters in names. Use it for every security decision. Keep the SHA-1 computeTreeSignature, if at all, only for non-security change detection.
- P1: introduce a committed agentpm.lock. Each skill entry records source, resolved commit or version, integrity, a per-file digest map, externalRefs[], capabilities[] and the ruleset version. Add `agentpm sync --frozen`, which fails on a missing lock or an integrity mismatch, and `agentpm verify`, which re-hashes installed targets and managed link realpaths (also wired into doctor).
- P1: build one deterministic 'reference and capability extractor' module, pure TypeScript with no network. It implements the 15-row catalogue: URLs with fetch-and-follow context, mutable GitHub URL forms, unpinned npx/uvx/pipx/pip/docker, pipe-to-shell, MCP url and command, submodules, LFS pointers, symlinks, remote images, Claude `!`cmd`` and hooks, out-of-tree paths, and self-update instructions. Run the same module at the client install gate, at the push and publish gate, and inside registry-server on upload. Never trust the client's verdict.
- P1: define the policy defaults. BLOCK pipe-to-shell, escaping symlinks, LFS pointers and submodules at publish, self-update instructions, and network commands in dynamic-context blocks. REQUIRE PIN for package launchers, docker images and GitHub raw URLs. REQUIRE APPROVAL for non-allowlisted hosts, remote MCP servers, hooks and reads of credential paths. WARN for remote images on allowlisted hosts. Provide an org or project domain allowlist in agentpm.yaml.
- P1: add an update gate that shows a delta. On update, sync or pull, re-scan and diff externalRefs and capabilities against the lock. NEW hosts, launchers, hooks, MCP servers and out-of-tree paths require explicit approval; non-interactive runs fail unless the item is pre-approved. Bind approval records to the integrity hash so that any content change voids them. Store approvals outside the skill.
- P2: for git updates, check history continuity (the old locked commit must be an ancestor of the new one) and, where available, an unchanged GitHub numeric repo id. Otherwise report 'repository recreated or force-pushed' and require approval. This covers SkillJacking and repo-jacking.
- P2: default `local:` sources to a snapshot copy in the cache keyed by tree hash. Keep live linking as an explicit dev mode marked `unpinned` in the lock and in doctor. Make the cache release directories read-only on a best-effort basis.
- P2: at the publish gate, require external documentation to be vendored into the package (the Nix rule that a fetch is allowed only with a declared hash). Reject marketplace or plugin sources without a `sha` in strict mode.
- P2: add an optional `minimumReleaseAge` cooldown on registry `publishedAt` for update and sync, following the pnpm model. Treat ownership transfer as a trust-downgrade event that requires re-approval.
- P2: handle the residual run-time risk honestly. Show the per-skill external-host inventory in list and doctor. Generate, but do not auto-apply, agent-side egress policy: Claude Code `WebFetch(domain:...)` rules, deny rules for curl and wget paired with the sandbox network allowlist, and `disableSkillShellExecution`. Recommend run-time MCP tool pinning. Word the UI as 'installed files match the reviewed version', never as 'safe'.
- P3: sanitise every skill-controlled string printed during review (ANSI and OSC escapes, bidirectional and zero-width characters), so that the approval prompt itself cannot be forged.
- Reuse strategy. Port SkilLock's capability-lock, delta and approvals design to TypeScript. Vendor a curated, version-pinned subset of the MIT-licensed ATR regex rules (the skill-compromise category) as a supplementary signal. Adopt the agents-shipgate definitions of pinned forms. Offer snyk/agent-scan and cisco skill-scanner only as optional shell-outs, because neither is offline, deterministic or Node-native.

## CORRECTIONS (partly/refuted/unverifiable)
- [partly] TOOL vercel-labs/skills: MIT, TypeScript, ~32k stars, pushed 2026-09-17; committed skills-lock.json with computedHash = sha256 over relativePath+content with no delimiters, skips non-regular files, records a branch/tag ref rather than a commit, hash used for update detection not verification
  -> Outdated in one point: PR #1439 'support installing skills pinned to a commit SHA' was merged 2026-09-06 (https://github.com/vercel-labs/skills/pull/1439), so SHA installs now exist. Note the PR deliberately tries `git clone --branch <sha>` first and only then falls back to `fetch <sha>` + `checkout FETCH_HEAD`, with no post-checkout HEAD verification described — i.e. the same Plugin4Shell-shaped pattern. Also the sort uses localeCompare (locale-dependent), another reason not to copy the hash construction.
- [partly] A5: Air Security Plugin4Shell disclosed 2026-09-17 bypassed SHA pinning in Claude Code, Codex, GitHub Copilot and Gemini CLI via a default branch named as the 40-hex SHA (or FETCH_HEAD for Gemini CLI); 'per Air' the fix in Claude Code 2.1.179 and Codex 0.146.0 is post-checkout rev-parse HEAD verification; the pin is resolved on the client so no marketplace can enforce it
  -> The article does not describe what the vendor patches actually do; the rev-parse-HEAD-equals-pin check is Air's recommended remediation ('It has to check the resolved HEAD, not the ref that was requested'), not a documented description of the Anthropic/OpenAI patches. Also missing from the finding: GitHub Copilot has NOT shipped a fix and Google will not patch Gemini CLI (deprecated). No CVE IDs are given.
- [partly] C1 (AgentPM): local sources are linked in place — prepareInspectionTarget sets repoRoot to the live folder with cacheKey null (service.ts 3689-3703)
  -> The prepared-content part is confirmed; I did not trace the install path to prove that the agent directory ends up symlinked to the live folder (the researcher also hedged with 'appears'). Verify the link-vs-copy behaviour in the installer before acting.
- [partly] B3: Agent SkillSlip (Aonan Guan, 2026-03-08): unvalidated `name` field in path.join; Vercel add-skill preserved symlinks; 'fixed in v1.0.21 with sanitizeName and dereferencing'; Gemini CLI and Claude Code variants unpatched at time of writing
  -> Two separate Vercel fixes: name-field traversal fixed in v1.0.21 (PR #8); symlink dereferencing fixed later in v1.0.24 (PR #108). Patch status of Claude Code/Gemini is as of March 2026 and was not re-checked for today.
- [partly] B2: 15-row catalogue of mutable reference types with detection and policy; pinned forms per agents-shipgate #825 and Archestra
  -> The catalogue and its block/approve/warn policy column are the researcher's own synthesis (they say so); no cited source validates the detection heuristics (e.g. imperative-verb-near-URL window) or their false-positive rates. 'Practically every kind of mutable reference' is over-confident: URLs built at run time, references inside .docx/.pyc/archives/images (Trail of Bits bypasses), and instructions in natural language without a literal URL are not covered. Treat row-level policies as proposals that need a fixture corpus before defaulting to BLOCK.

## ADDITIONS
- MISSED COMPARABLE: microsoft/apm (Agent Package Manager, MIT, Python, ~3.8k stars, pushed 2026-09-18) is the closest existing design to what AgentPM wants and was cited only for its advisory. It already ships a deterministic, no-LLM install gate: apm.lock.yaml records `resolved_commit` (40-hex) plus `content_hash: sha256:...` over sorted file paths and verifies cached packages against it; every install scans for hidden Unicode (tag chars U+E0001-E007F, bidi overrides, variation selectors 17-256 = block; zero-width = warn; `--force` override); lifecycle scripts are opt-in; MCP servers declared by TRANSITIVE dependencies are blocked by default (`--trust-transitive-mcp`); path containment + symlink rejection; `apm audit --ci`, drift detection, `apm-policy.yml` org allowlists with tighten-only inheritance, CycloneDX/SPDX export from the lockfile. https://github.com/microsoft/apm and https://microsoft.github.io/apm/enterprise/security/
- MISSED PRIOR ART: GitHub CLI `gh skill` (v2.90.0, 2026-04-16, public preview) — `--pin` to tag or commit SHA, records the git TREE SHA of the skill directory and compares trees on update for real content drift, `gh skill publish` can enable immutable releases, writes provenance (repo, ref, tree SHA) into SKILL.md frontmatter. Relevant design point for AgentPM: git tree SHA is a free, already-canonical content hash for git sources (but is SHA-1 and does not cover archive/local sources, so a SHA-256 manifest is still needed). Note that storing provenance inside the skill file conflicts with the researcher's (correct) rule that trust records must live outside the skill. https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/
- MISSED PRIMARY SOURCE: Trail of Bits, 'The sorry state of skill distribution' (2026-06-03) bypassed ClawHub's detector, Cisco skill-scanner and all three skills.sh scanners, mostly in under an hour each: 100,000 leading newlines to force truncation, payload inside a .docx (ZIP) the SKILL.md tells the agent to extract, poisoned .pyc next to clean .py, and prompt-injecting the scanner's LLM judge. Test corpus: https://github.com/trailofbits/overtly-malicious-skills (42 stars, no license). Implications for a deterministic scanner: never truncate, enforce size/line limits as hard failures, reject or flag binaries/archives/bytecode (.pyc, .docx, .zip, .wasm) at the publish gate, and use this repo as a regression fixture set. https://blog.trailofbits.com/2026/06/03/the-sorry-state-of-skill-distribution/ ; CSA note: https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-agent-skill-scanner-bypass-20260610-csa/ ; Adversa test of eight scanners: https://adversa.ai/blog/agent-skill-scanners-bypass-eight-tested/
- MISSED TOOL: NVIDIA/SkillSpector (Apache-2.0, Python, ~17.7k stars, pushed 2026-09-18) — by far the most-starred skill scanner, listed on the OWASP AST solutions page (AST01-04, 08-10) and one of the scanners Air's 'Story of Skills' says cleared the malicious skill. Should be evaluated in the scanner lane as an optional shell-out alongside Cisco and Snyk. https://github.com/NVIDIA/SkillSpector
- REPRODUCED, not just plausible: the FETCH_HEAD pin bypass works against AgentPM's exact git sequence (clone --depth 1 --filter=blob:none --no-checkout; fetch origin <sha> --depth 1; checkout FETCH_HEAD) on git 2.54.0.windows.1 when the remote's default branch is named FETCH_HEAD: git prints 'refname FETCH_HEAD is ambiguous', stays on the branch, and HEAD is the attacker commit while the release directory is keyed by the pinned SHA. materializeGitRelease also returns early when releasePath exists (lines 173-175) with no re-verification, so a poisoned cache entry is trusted forever. File: D:\DevProjects\private\agentpm\packages\git\src\index.ts
- vercel-labs/skills merged commit-SHA installs on 2026-09-06 (PR #1439). Its implementation tries `git clone --depth 1 --branch <sha>` FIRST and only falls back to fetch+`checkout FETCH_HEAD` on failure; by the PR's own reasoning a branch literally named with the 40-hex string resolves on the first attempt. That is the Plugin4Shell shape, and AgentPM's provider-bridge shells out to this tool, so AgentPM should not treat `npx skills` SHA pins as verified. https://github.com/vercel-labs/skills/pull/1439
- Plugin4Shell status detail omitted by the researcher: GitHub Copilot is unpatched ('Microsoft ... has not shipped a fix') and Gemini CLI will not be patched (deprecated). Any AgentPM-installed plugin/marketplace entry consumed by those clients cannot rely on the client honouring `sha`. https://www.air.security/blog-posts/plugin4shell
- Anthropic now offers server-side 'Skill and plugin security scanning' for Claude Enterprise (claude.ai / Cowork uploads only; not the Skills API, not Claude Code filesystem skills). It confirms that vendor-side scanning does not cover the path AgentPM manages. https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise
- Registry name reuse: AgentPM's registry server whole-skill DELETE (server.ts ~550-561) removes the skill and its archives, freeing the name for anyone — the registry analogue of SkillJacking. Tombstone names, not only versions.
- Source-concentration caveat: five of the headline incident/measurement sources (Plugin4Shell, Circus of Skills, SkillJacking, Story of Skills, plus the Security Boulevard op-ed by Asaf Saar) come from or align with one vendor, Air Security. The numbers are self-reported. They are directionally corroborated by independent sources (Snyk ToxicSkills, Trail of Bits, OWASP AST, Anthropic docs), but should be quoted as vendor research.

## TOOLS
- snyk/agent-scan (formerly invariantlabs-ai/mcp-scan) | https://github.com/snyk/agent-scan | Apache-2.0 | Python | det: Mostly not. The core verdicts come from a remote Snyk or Invariant analysis API, which requires a SNYK_TOKEN. Only discovery, hidden-Unicode detection and hash pinning are local and deterministic. Scanning MCP configs executes the configured servers. | reuse: Inspiration for the issue taxonomy (W012 is exactly the owner's worry). Offer an optional `agentpm scan --with agent-scan` shell-out for users who have it. Do not make it a dependency: it is not offline, not deterministic and not Node. | About 3.1k stars, pushed 2026-09-18, very active. The README says CLI output is experimental and that the v0.5 issue codes are being deprecated in favour of v0.6 risk indicators.
- skills-lock/skil-lock (SkilLock) | https://github.com/skills-lock/skil-lock | Apache-2.0 (SPEC.md is CC BY 4.0) | Go | det: Fully deterministic and parse-based with no LLM, as stated explicitly in its OWASP solutions entry. It does not pin or verify fetched external content, so it covers AST05 only partially. | reuse: Port the design to TypeScript: a capability-surface lock, a delta gate and an approvals file scoped to a delta. Do not shell out, because it is a Go binary and immature. Its six detector categories are a good starting schema for AgentPM's `capabilities` and `externalRefs` lock fields. | 6 stars, created 2026-05-13, pushed 2026-09-09, v0.2.5. It is a very young, single-vendor project. It is listed on the OWASP AST solutions page.
- trailofbits/mcp-context-protector | https://github.com/trailofbits/mcp-context-protector | Apache-2.0 | Python | det: The pinning and the blocking are deterministic. The guardrail scanning of responses is optional and model-based. | reuse: Inspiration only, for the approval-record design: approve a specific content hash, block on any deviation, and use a separate CLI approval step. Recommend it, or agent-scan pinning, to users for the run-time MCP layer that AgentPM cannot cover. | 225 stars, last push 2026-04-14. It is a research-grade reference implementation.
- vercel-labs/skills (npx skills) | https://github.com/vercel-labs/skills | MIT | TypeScript | det: Deterministic. The hash is unstructured (no delimiters between path and content). It ignores non-regular files. It locks a branch or tag ref rather than a commit. The hash is not verified before use. | reuse: AgentPM already shells out to it through provider-bridge. Borrow the lockfile ergonomics: sorted keys and no timestamps give clean merges, and there is one lock per project. Do not copy the hash construction. It is also a cautionary example: SkillJacking worked because it clones live from mutable GitHub namespaces. | About 32k stars, pushed 2026-09-17.
- Agent-Threat-Rule/agent-threat-rules (ATR) | https://github.com/Agent-Threat-Rule/agent-threat-rules | MIT | TypeScript engine plus YAML rules (npm package agent-threat-rules; Python wrapper pyatr) | det: The pattern tier is pure regex and deterministic. The rule I inspected is marked `status: experimental` and `maturity: test`, so false-positive rates are unproven. | reuse: Vendor a curated subset of the skill-compromise and exfiltration YAML rules. The MIT licence makes this easy, and the regexes are portable to a small TypeScript matcher or to the npm engine. Pin the ruleset version in agentpm.lock so that verdicts are reproducible. | 393 stars, pushed 2026-09-18. Governance is single-maintainer, and the spec is a working draft at 3.0.0-alpha.1. The README claims the rules are merged into Microsoft AGT, Cisco AI Defense, MISP and SigmaHQ; I did not verify that independently.
- ThreeMoonsLab/agents-shipgate | https://github.com/ThreeMoonsLab/agents-shipgate | Apache-2.0 | not checked (CLI plus GitHub Action) | det: Fully deterministic by design. The #825 feature is a proposal and has not shipped. | reuse: Inspiration only. Reuse its precise definition of pinned forms (pkg@1.2.3, pkg==1.2.3, git+...@<40-hex>, image@sha256:...). Reuse its rule that unknown launchers produce no guess, and its wording of 'mutable' rather than 'unsafe'. | 89 stars, pushed 2026-09-17.
- cisco-ai-defense/skill-scanner | https://github.com/cisco-ai-defense/skill-scanner | Apache-2.0 per the README badge (the GitHub API reports NOASSERTION) | Python (the CEL layer uses cel-go) | det: The static and YARA core is deterministic: the README reports five CEL-shadow runs that were exact and deterministic. The LLM and cloud analyzers are optional. | reuse: Its rule packs are useful as a reference for another lane. For this lane, its published recall is evidence that scanning cannot be the primary rug-pull control. An optional shell-out at most. | About 2.5k stars, pushed 2026-09-05. It publishes candid benchmark numbers: 7.75% recall on a source-disjoint split.
- mcptrust/mcptrust | https://github.com/mcptrust/mcptrust | Apache-2.0 | not checked | det: Deterministic according to the repo description. I did not read the code. | reuse: Inspiration only. It is a small and unproven project. It confirms that the lockfile-for-MCP idea exists, but it is not something to depend on. | 6 stars, last push 2026-03-19. It may be dormant.
- golang.org/x/mod/sumdb/dirhash (h1 algorithm) | https://pkg.go.dev/golang.org/x/mod/sumdb/dirhash | BSD-3-Clause | Go (specification) | det: Fully deterministic. | reuse: Port to TypeScript in about 30 lines with node:crypto. Extend each manifest line with the file mode and a symlink marker. Use it as the `integrity` value shared by git, archive and local sources. | It is part of the Go toolchain and is mature.

## FINDINGS
### A1. Tags, branches and version labels are mutable; only content-addressed identifiers are pins (tj-actions, Docker, GitHub Actions) [high]
In March 2025 an attacker with a stolen bot PAT retroactively repointed the version tags of tj-actions/changed-files (CVE-2025-30066) to a malicious commit. Every workflow that referenced a tag ran it; workflows pinned to a commit hash were not impacted (Wiz). CISA added it to KEV, and reviewdog/action-setup (CVE-2025-30154) was the upstream compromise. GitHub's own hardening guide says pinning to a full-length commit SHA is currently the only way to use an action as an immutable release, because a tag can be moved or deleted by anyone who gains repo access. Docker says the same about tags versus sha256 digests. GitHub 'immutable releases' lock a release tag and its assets, and block tag reuse even if the repo is deleted and recreated, but they do not cover branches or non-release tags.

Transferable rule for skills: `ref: main` or `ref: v1.2.0` is a request, not a pin. AgentPM should always resolve to a 40-hex commit and record it, and treat anything unresolved as unpinned.
Sources: https://www.wiz.io/blog/github-action-tj-actions-changed-files-supply-chain-attack-cve-2025-30066 ; https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-tj-actionschanged-files-cve-2025-30066-and-reviewdogaction ; https://docs.github.com/en/actions/reference/security/secure-use ; https://docs.docker.com/dhi/core-concepts/digests/ ; https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/immutable-releases

### A2. Lockfile pattern: loose manifest, exact resolved identity plus integrity hash in a committed lock, frozen verification, explicit upgrade [high]
How each ecosystem does it:
- npm: package-lock records `resolved` (where the package came from; for git dependencies the full URL with commit SHA) and `integrity` (an SRI sha512 string).
- Cargo: Cargo.lock pins a git dependency to the exact commit even when Cargo.toml names only a repo or branch. `cargo update` is the only way it moves.
- pip: hash-checking mode is all-or-nothing. Every requirement and every transitive dependency must be hashed and pinned with `==`, because a partially hashed file lets bad code slip in through the unhashed entry.
- Deno: deno.lock stores an integrity hash for every dependency, including https imports. `--frozen` and `deno ci` error instead of silently re-resolving. `vendor: true` snapshots remote code locally.
- Terraform: .terraform.lock.hcl records version plus hashes and describes its own model as trust on first use. A mismatch is a hard error, and `init -upgrade` is the explicit move.
- Nix: fixed-output derivations are allowed network access only because the output hash is declared in advance. A mismatch fails the build.
- Homebrew: every url needs a sha256. Git sources carry tag plus revision. Extra downloads are `resource` blocks with their own checksums.

Rules that transfer to skills:
1. Two files: agentpm.yaml expresses intent, agentpm.lock records what was resolved.
2. The lock stores both the commit SHA and a content hash of the skill subtree.
3. Verification is all-or-nothing. A lock with some unpinned entries must be loudly flagged.
4. `agentpm sync --frozen` for CI and teams fails on a missing lock or a mismatch.
5. The lock changes only through an explicit `update` that prints a diff.
6. Anything fetched from a URL is acceptable only with a pre-declared hash (the Nix rule). This is exactly the vendored-snapshot rule for external docs.
Sources: https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json ; https://doc.rust-lang.org/cargo/guide/cargo-toml-vs-cargo-lock.html ; https://pip.pypa.io/en/stable/topics/secure-installs/ ; https://docs.deno.com/runtime/packages/ ; https://developer.hashicorp.com/terraform/language/files/dependency-lock ; https://nix.dev/manual/nix/2.24/language/advanced-attributes ; https://docs.brew.sh/Formula-Cookbook

### A3. How to hash a directory tree correctly (Go h1 dirhash, Terraform h1, Nix NAR); existing skill tools and AgentPM's current signature fall short [high]
Go's `h1:` hash is SHA-256 over a sorted manifest with one line per file: `<hex sha256 of content><two spaces><path>\n`. File names containing newlines are disallowed. It is equivalent to `sha256sum $(find . -type f | sort) | sha256sum`. Terraform's `h1:` hashes package contents rather than the zip, so the same content verifies whether it is packed or unpacked. Nix uses a recursive (NAR) mode for directories. This matters for AgentPM because the same skill arrives as a git checkout, a JSON archive and a local folder, and should produce one identical integrity value.

vercel-labs/skills (`npx skills`, about 32k stars) has a committed `skills-lock.json` with `computedHash`. That hash is sha256 over concatenated `relativePath + content` with no delimiters. It skips everything that is not a regular file, records a branch or tag `ref` rather than a commit, and uses the hash for update detection, not for verification before use.

AgentPM's own `computeTreeSignature` (D:\DevProjects\private\agentpm\packages\fs\src\index.ts lines 72-81) has the same shape, and uses SHA-1:
- It does `hash.update(relativePath); hash.update(content)` with no length or field separation, so path and content boundaries are ambiguous.
- `walkFiles` keeps only `entry.isFile()`, so symlinks are silently excluded from the signature.
- The executable bit is not covered.

For a security lock, use SHA-256 with a structured manifest of `sha256  mode  path` lines, sorted bytewise on POSIX-normalised paths. Include explicit entries for symlinks (or reject them). Reject path names containing newlines or control characters. Keep the per-file digests in the lock so drift reports can name the changed file.
Sources: https://pkg.go.dev/golang.org/x/mod/sumdb/dirhash ; https://developer.hashicorp.com/terraform/language/files/dependency-lock ; https://nix.dev/manual/nix/2.24/language/advanced-attributes ; https://github.com/vercel-labs/skills ; D:\DevProjects\private\agentpm\packages\fs\src\index.ts

### A4. Local trust-on-first-use is not enough for a registry: versions must be globally immutable (Go sumdb, npm never-reuse rule); the AgentPM registry currently allows delete then republish [high]
go.sum is trust on your first use. The checksum database (a Merkle-tree transparency log) exists so that everyone gets the same go.sum lines, and so that even the author of a module cannot change the bits associated with a specific version without detection. npm's policy is that once `package@version` has been used it can never be used again, even after unpublish. OWASP AST recommends `content_hash` in the manifest, ed25519 signatures and Merkle-root transparency logs for registries.

AgentPM registry server today (D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts):
- Re-publishing an existing version returns 409 (lines 441-446). That is good.
- `DELETE /v1/skills/:name/versions/:version` (lines 587-606) removes both the row and the archive file, and there is no tombstone. An owner, or a stolen publisher token, can delete 1.2.0 and publish different bytes as 1.2.0. That is a rug pull against everyone who reviewed 1.2.0.
- The sha256 checksum is computed over `JSON.stringify(archive)` (line 465). It is returned to the publisher and on the skill detail endpoint, but RegistryIndexEntry has no checksum or integrity field.
- On the client, `prepareArchiveContent` (D:\DevProjects\private\agentpm\packages\core\src\service.ts lines 4338-4374) hashes the downloaded bytes only to name the cache directory. It never compares them to an expected value.

Fixes that are cheap and deterministic:
- Tombstone deleted versions and deleted names. Yank instead of delete.
- Publish `integrity` (the tree hash of the files, not of the JSON serialisation) in index.json.
- Have the client verify against the index and against agentpm.lock.
- Keep an append-only hash-chained publish log as a cheap transparency log.
- Treat an ownership transfer as a trust-downgrade event that requires re-approval (the analogue of pnpm `trustPolicy: no-downgrade`).
Sources: https://go.dev/blog/module-mirror-launch ; https://docs.npmjs.com/policies/unpublish ; https://owasp.github.io/www-project-agentic-skills-top-10/ ; https://pnpm.io/supply-chain-security ; D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts ; D:\DevProjects\private\agentpm\packages\core\src\service.ts

### A5. A pin is only as good as its client-side verification: Plugin4Shell (2026-09-17) and the matching pattern in AgentPM's git package [medium]
Air Security's Plugin4Shell, publicly disclosed on 2026-09-17, bypassed SHA pinning in Claude Code, Codex, GitHub Copilot and Gemini CLI. The clients ran `git clone` and then `git checkout <sha>`. An attacker-controlled repo can have a default branch literally named with that 40-hex string, and git prefers a ref over a commit of the same name. Gemini CLI fetched the SHA and ran `git checkout FETCH_HEAD`; a default branch named `FETCH_HEAD` wins there too. Per Air, the fix shipped in Claude Code 2.1.179 and Codex 0.146.0 is post-checkout verification that `git rev-parse HEAD` equals the pinned SHA. Their lesson is that the pin is resolved on the client, so no marketplace can enforce it.

The positive counterpart is John Stawinski's write-up of 2026-06-18. Five plugins in Anthropic's community marketplace pointed at re-registrable GitHub namespaces, and the SHA pins in marketplace.json are what stopped a repo-jacked repository from being installed.

AgentPM (D:\DevProjects\private\agentpm\packages\git\src\index.ts lines 196-223) uses exactly the FETCH_HEAD pattern:
- It runs `git fetch origin <revision> --depth 1`, then `repo.checkout(['FETCH_HEAD'])`, then returns `revparse HEAD`.
- It never compares the result to `options.revision`.
- The release directory is keyed by the requested revision (line 172) before the content is fetched. Wrong content would therefore be cached under the trusted revision's path.

I did not execute an exploit. Whether a hosted default branch named FETCH_HEAD, or named with 40 hex characters, reproduces against AgentPM's `--no-checkout` clone is untested, so treat this as plausible and verify.

Recommended hardening:
- Check out with `--detach` using the fully qualified object (`<sha>^{commit}`).
- Afterwards assert that `rev-parse HEAD` equals the pinned SHA. If it does not, delete the release directory and fail.
- Refuse remote branch or tag names that match /^[0-9a-f]{40}$/ or FETCH_HEAD.
- Verify the tree hash from the lock in addition to the commit.
Sources: https://www.air.security/blog-posts/plugin4shell ; https://johnstawinski.com/2026/06/18/repo-jacking-anthropics-claude-community-plugins-and-the-shas-that-saved-them/ ; https://code.claude.com/docs/en/plugin-marketplaces ; D:\DevProjects\private\agentpm\packages\git\src\index.ts

### A6. MCP rug pulls: approval must bind to content, not to a name; any change forces re-approval (tool pinning, trust-on-first-use wrappers, MCPoison) [high]
- mcp-scan is now snyk/agent-scan. It introduced 'tool pinning': it hashes MCP tool descriptions and reports changes, to detect rug pulls. The public docs do not specify storage details, which I checked.
- Trail of Bits' mcp-context-protector is the clearest trust-on-first-use design. It stores approved server configurations (server instructions, tool descriptions and input schemas, compared semantically with order ignored) in ~/.mcp-context-protector/servers.json. Any deviation blocks all tool calls until the user re-approves through a CLI. It re-checks on `notifications/tools/list_changed`.
- Check Point's MCPoison (CVE-2025-54136, August 2025) is the counter-example. Cursor bound approval to the MCP key name. After one approval, the command could be swapped silently. The fix in Cursor 1.3 forces re-approval on any change, even an added space.
- ETDI (arXiv 2506.01333) proposes immutable, versioned, signed tool definitions with re-approval on change.

Transferable rule: every AgentPM approval record (an approved external host, an approved hook command, an approved MCP server, an approved unpinned launcher) must be stored together with the tree hash it was granted for. When the hash changes, the approval is void and the diff is shown again. Approvals live in a local file, or a committed one for teams. They must never live inside the skill itself.
Sources: https://invariantlabs.ai/blog/introducing-mcp-scan ; https://invariantlabs-ai.github.io/docs/mcp-scan/ ; https://github.com/trailofbits/mcp-context-protector ; https://research.checkpoint.com/2025/cursor-vulnerability-mcpoison/ ; https://arxiv.org/abs/2506.01333

### A7. Cooldown and source-restriction rules from pnpm transfer directly [medium]
pnpm's supply-chain guidance lists six controls:
- lifecycle scripts are blocked by default, with an allowlist;
- `minimumReleaseAge` (default 1440 minutes) means brand-new versions are not installed until the ecosystem has had time to detect malware;
- `trustPolicy: no-downgrade`;
- `blockExoticSubdeps` means transitive dependencies may not come from git or tarball URLs;
- a committed lockfile;
- registry-qualified lockfile keys, so a same-name package on another registry cannot substitute.

For AgentPM:
- AgentPM already never runs install scripts. Keep that.
- Add an optional `minimumReleaseAge` for update and sync against registry `publishedAt`. The server timestamp is trustworthy; git commit dates are forgeable and only a heuristic.
- Key lock entries by source and name, so a registry entry cannot shadow a git source with the same skill name. This is related to the existing --kind disambiguation work.
- Treat skills that themselves pull other skills or packages from URLs as 'exotic' and gate them.
Sources: https://pnpm.io/supply-chain-security

### B1. The threat is documented, measured and already exploited: OWASP AST05 and AST07, Snyk ToxicSkills, Air Security, Anthropic's own docs [high]
OWASP Agentic Skills Top 10 (v1.0, 2026 edition; the AST05 page was last updated June 2026). AST05 'Untrusted External Instructions' makes three points. Referenced content becomes part of the skill's instructions. There is no field to pin a document's hash and no lockfile for prose. Signing the skill says nothing about what a URL returns at run time. It lists three scenarios:
- author rug pull;
- reviewer bait-and-switch, where clean content is served to scanners keyed on IP, user agent or timing;
- transitive reference chaining.

Its mitigations are, in order: pin and verify referenced content by hash; prefer inlining or snapshots in the signed package; allowlist reference domains; audit references transitively; keep a fleet-wide inventory of referenced sources; rescan continuously.

AST07 'Update Drift' says to pin installed skills to sha256 content hashes rather than version ranges, to add a freeze mode, to require human approval of updates, and to keep an inventory with hash and last-verified timestamp. It names hot-reload abuse, where a writable skill directory is modified mid-session.

Numbers:
- Snyk ToxicSkills (2026-02-05, 3,984 skills): 17.7% of ClawHub skills fetch untrusted third-party content. 2.9% of ClawHub skills, and 21% of the malicious samples, dynamically fetch and execute remote content. Snyk notes that the published skill appears benign during review, but attackers can modify behaviour at any time by updating the fetched content.
- Air Security 'Circus of Skills' (2026-06-24, 142,836 skills): 17,822 skills (about 12.4%, 6.7M installs) reference at least one untrusted external instruction source. The sources were young domains, anonymous GitHub owners, fresh packages, free-tier hosts and `releases/latest` binaries.
- Air Security 'SkillJacking' (2026-07-02): skills.sh clones live from GitHub. Researchers re-registered a deleted account and controlled a skill with 11,483 installs. In total 925 skills (about 134K agents) were hijackable, and the takeover tripped no scanner.
- Air Security 'Story of Skills' (2026-06-22): a proof of concept in which a skill pointing at look-alike external docs led to agent takeover, and scanners cleared it.

Anthropic's own docs state that skills fetching external URLs pose particular risk, and that even trustworthy skills can be compromised if their external dependencies change over time. The Anthropic enterprise guide tells admins to compute checksums of reviewed skills and verify them at deployment, to pin versions, and to treat every update as a new deployment requiring full security review.
Sources: https://github.com/OWASP/www-project-agentic-skills-top-10 ; https://owasp.github.io/www-project-agentic-skills-top-10/ ; https://securityboulevard.com/2026/08/the-skill-layer-is-a-dependency-problem-without-a-lockfile-what-the-owasp-agentic-skills-top-10-gets-right/ ; https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/ ; https://www.air.security/blog-posts/the-circus-of-skills ; https://www.air.security/blog-posts/skilljacking ; https://www.air.security/blog-posts/the-story-of-skills ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise

### B2. Catalogue of mutable references: deterministic detectability and fitting policy for each [medium]
All of these are detectable with parsing plus regex and no LLM. The policy column is my recommendation, synthesised from OWASP AST05 and AST07, the agents-shipgate pin rules, the Archestra guidance and the Anthropic checklist. 'Publish' means the push and registry-server gate. 'Install' means the client gate.

1. Fetch-and-follow URLs, such as 'read the latest instructions from https://...' or a curl of a .md or .txt file that the agent is told to obey.
   Detect: extract every URL from markdown links, autolinks, bare text, code fences, HTML tags and scripts. Classify a URL as instruction-bearing when an imperative verb (fetch, read, follow, load, download, WebFetch, curl, 'latest') appears within a small token window. Also classify it that way when the host is a raw-content host (raw.githubusercontent.com, gist, pastebin) or the path ends in .md, .txt, .sh or .ps1.
   Policy: block by default at publish and require a vendored snapshot. At install, require explicit per-host approval recorded against the tree hash. Offer an org domain allowlist.
   Limit: a regex cannot prove whether fetched text will be treated as data or as instructions. Treat every non-allowlisted host as approval-needed instead of guessing.

2. Mutable GitHub URL forms: `/main/`, `/master/`, `/HEAD/`, `releases/latest`, `archive/refs/heads/...`.
   Detect: regex.
   Policy: require a SHA permalink (a 40-hex path segment), or vendoring with a recorded sha256.

3. Git branch or tag versus commit SHA. This covers the AgentPM source spec, the `source` objects in Claude marketplace.json (`ref` without `sha`), `git clone` inside skill text, and `pip install git+https://...@main`.
   Detect: yes.
   Policy: AgentPM always resolves and locks a 40-hex SHA and verifies HEAD after checkout. A marketplace entry without `sha` produces a warning, and a strict-mode publish requires the pin. An in-skill clone without a SHA requires approval.

4. Git submodules (.gitmodules, gitlink mode 160000).
   The gitlink itself is pinned to a SHA, but the URL is arbitrary. AgentPM's shallow sparse clone does not fetch submodules, so content is silently missing or is fetched later by the agent.
   Policy: never recurse automatically. Block at publish. At install, warn and list the URLs.

5. Git LFS pointers. These are the exact three-line signature starting `version https://git-lfs.github.com/spec/v1`, followed by `oid sha256:` and `size`.
   The content hash is pinned by the oid, but the bytes live on a separate server. Without a smudge filter, the pointer text itself gets installed.
   Policy: block at publish, because archives must carry the real bytes. Warn at install. If the content is ever fetched, verify that its sha256 equals the oid.

6. Symlinks (lstat, git mode 120000).
   Policy: if the link stays inside the tree, dereference it to a copy or reject it. If the link is absolute, contains `..`, or has a realpath outside the root, always block it. Keep the JSON archive format free of any link entry type, as it is today.

7. Remote images and HTML (`![](http...)`, `<img>`, `<script>`, `<iframe>`, `<link>`).
   These are an exfiltration channel and a content-swap vector.
   Policy: block when the URL contains template or query interpolation. Otherwise warn, and require local vendoring at publish.

8. Package runners without pins: `npx -y pkg`, `pkg@latest`, bunx, `pnpm dlx`, `uvx pkg`, `pipx run`, `pip install pkg` without `==`, `npm i -g`, `go install x@latest`, `cargo install` without a version, brew.
   Detect: shell-token regex in code fences, scripts, hooks, and MCP command and args.
   Pinned forms, per agents-shipgate issue #825 and Archestra: `pkg@1.2.3`, `pkg==1.2.3`, `git+...@<40hex>`, `image@sha256:...`.
   Policy: require an exact pin at publish. At install, require approval and record the capability 'executes third-party package'.
   Limit: a version pin is weaker than a hash pin. Say so in the UI.

9. Pipe-to-shell: `curl|sh`, `wget -O- | bash`, `bash <(curl ...)`, `eval "$(curl ...)"`, `source <(curl ...)`, `iwr ... | iex`, `irm ... | iex`, `python -c "$(curl ...)"`.
   Detect: high-precision regex.
   Policy: block at both gates. An override is possible only through an explicit flag plus a recorded approval.

10. MCP servers (.mcp.json, plugin.json mcpServers, Codex mcp_servers).
   A remote `url` is mutable by construction, because tool descriptions can change at any time. `command` and `args` can be unpinned launchers.
   Detect: parse the JSON or TOML.
   Policy: a remote url needs approval plus a host allowlist. A stdio server needs a pinned launcher. On update, surface every new or changed server as a NEW capability. Recommend run-time tool pinning (agent-scan, mcp-context-protector), because AgentPM cannot pin tool descriptions.

11. Docker images by tag, by `:latest` or with no tag, versus `@sha256:`.
   Detect: regex on `docker run`, `docker pull`, FROM and compose files.
   Policy: require a digest at publish. Require approval at install.

12. Dynamic context and hooks. In Claude Code, inline `!`cmd`` and fenced ```! blocks run during skill rendering, before the model sees anything. `allowed-tools` pre-approves them. The frontmatter `hooks` field, plugin hooks and the `shell` field are part of the same surface.
   Detect: parse the frontmatter and the body.
   Policy: list every command in the install summary. Block any network-capable command (curl, wget, gh api, git fetch or clone, npx and similar) inside a dynamic-context block. Require approval for the rest. Diff on update.

13. References outside the skill: `~/.claude`, `~/.codex`, `~/.ssh`, `~/.aws`, `.env`, `../`, other skills' directories, absolute paths, and writes to CLAUDE.md, AGENTS.md, settings.json or memory files (persistence).
   Detect: path regex.
   Policy: block writes to agent configuration and memory. Require approval for reads of credential paths. Warn on `../`.

14. Self-update instructions: 'check for a newer version at ...', `git pull` inside the skill directory, `npx skills add`, `agentpm install` run from inside a skill.
   Policy: block. The only update channel is AgentPM.

15. Shorteners, ephemeral hosts, raw IP addresses and punycode: bit.ly, tinyurl, *.ngrok.io, *.vercel.app, *.github.io, pastebin and similar.
   Detect: host lists.
   Policy: block shorteners. Require approval for ephemeral hosts.
Sources: https://github.com/OWASP/www-project-agentic-skills-top-10 ; https://github.com/ThreeMoonsLab/agents-shipgate/issues/825 ; https://archestra.ai/blog/pin-mcp-server-versions ; https://code.claude.com/docs/en/skills ; https://code.claude.com/docs/en/plugin-marketplaces ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise ; https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md ; https://github.com/snyk/agent-scan

### B3. Installer-level structural hazards seen in the wild: symlinks, name and path traversal, archive slip, terminal escape injection [high]
- 'Agent SkillSlip' (Aonan Guan, 2026-03-08): the `name` field from SKILL.md or marketplace.json was used in path.join with no validation. Vercel add-skill preserved symlinks from git repos, which let content escape the workspace; that was fixed in v1.0.21 with sanitizeName and dereferencing. The post reports the Gemini CLI and Claude Code variants as unpatched at the time of writing.
- microsoft/apm advisory GHSA-xhrw-5qxx-jpwr (2026-05-03, CVSS 7.1): plugin.json component paths (agents, skills, commands, hooks) could be absolute or contain `../`, which copied arbitrary host files into the project during `apm install`. The fix was realpath containment.
- CVE-2026-28486: an OpenClaw archive path traversal in skills, hooks and plugins install. It surfaced in search results only; I did not open it.
- Seal Security (2026-07-21): ANSI and OSC-8 escape injection through file names in `skills add` output. It lets an attacker erase or forge install-review lines, and the vendor deemed it out of scope.

AgentPM already has `assertSafeArchivePath` for archive entries (D:\DevProjects\private\agentpm\packages\shared\src\index.ts lines 186-198). The remaining deterministic checks are:
- For git and local sources, lstat every entry and reject any symlink or junction whose realpath leaves the skill root.
- Validate plugin.json and marketplace component paths the same way.
- Strip control and escape characters from any skill-controlled string printed during review. The scanner's own output is part of the trust boundary.
- Reject file names containing newlines or control characters. Go dirhash has the same rule, and it keeps the tree-hash manifest unambiguous.
Sources: https://oddguan.com/blog/agent-skillslip-google-gemini-cli-anthropic-claude-code-vercel-add-skill-path-traversal/ ; https://github.com/microsoft/apm/security/advisories/GHSA-xhrw-5qxx-jpwr ; https://www.seal.security/blog/dont-trust-your-eyes---ansi-escape-injection-in-the-skills-cli-by-vercel-labs ; https://pkg.go.dev/golang.org/x/mod/sumdb/dirhash ; D:\DevProjects\private\agentpm\packages\shared\src\index.ts

### B4. Existing scanners flag the pattern but are not a deterministic, offline answer, and their own numbers show scanning alone is insufficient [high]
- snyk/agent-scan (formerly invariantlabs mcp-scan; Apache-2.0, about 3.1k stars, pushed 2026-09-18) has the most on-point issue code, W012 'Unverifiable external dependency': the skill fetches instructions or code from an external URL at run time, which defeats any form of version pinning. It also has E005 for suspicious download URLs and W011 for untrusted third-party content. It requires a SNYK_TOKEN and a remote analysis API. Its README says CLI output is experimental and that the v0.5 issue codes are being deprecated. Scanning MCP configs executes the configured servers. So it is neither offline nor deterministic nor pure Node. At most it is an optional shell-out.
- cisco-ai-defense/skill-scanner (README badge says Apache-2.0, about 2.5k stars) publishes unusually honest numbers. On a source-disjoint split it reports 60.75% precision and 7.75% recall, and the README states that 'no findings' does not mean no risk.
- OWASP AST08 and the Security Boulevard piece note that scanners are defeated by padding (100k newlines caused one scanner to truncate the file) and by serving clean content to scanners.
- Air's SkillJacking takeover tripped no scanner, because no content changed at scan time.

Conclusion for AgentPM: pattern scanning is useful as a gate for the obvious cases, such as pipe-to-shell, unpinned launchers and hidden Unicode. The structural controls (tree-hash lock, immutable versions, update diff, approvals bound to a hash) are what actually address rug pulls, and they are fully deterministic.
Sources: https://github.com/snyk/agent-scan ; https://github.com/cisco-ai-defense/skill-scanner ; https://securityboulevard.com/2026/08/the-skill-layer-is-a-dependency-problem-without-a-lockfile-what-the-owasp-agentic-skills-top-10-gets-right/ ; https://www.air.security/blog-posts/skilljacking ; https://github.com/OWASP/www-project-agentic-skills-top-10

### C1. What AgentPM can do that a scanner cannot: tree-hash lock, verification on every sync, drift detection, snapshot copies, update diff of new references and capabilities [medium]
This is a design synthesis. The file format and the commands are my proposal, not an existing standard.

1. agentpm.lock. It is committed, sorted and timestamp-free, so merges stay clean; vercel-labs/skills uses the same trick. Each skill entry holds:
   - source, and resolved (the git URL plus 40-hex commit, or the registry URL plus version);
   - optionally the GitHub numeric repo id;
   - `integrity: sha256-<tree hash>` and a per-file sha256 map;
   - `externalRefs[]` with {kind, value, host, pinned, context};
   - `capabilities[]`: shell, network, scripts, hooks, mcp, dynamic-context, fs-outside-skill, package-exec;
   - the scanner ruleset version.

2. Verification points:
   - after materialising, and before any link is created;
   - on every `sync` and `pull`, with `--frozen` failing on a missing or mismatched lock;
   - on `update`;
   - before `push` and `registry publish`;
   - on the server at upload, where it recomputes the hash and rejects a mismatch with the client-declared integrity;
   - in `agentpm verify` and `doctor`.

3. Drift detection after install. Re-hash the installed target and the realpath of every managed link. Report the changed file using the per-file map. Flag link targets that were replaced or that point outside the cache. OWASP AST07 names hot-reload abuse of a writable skill directory, so this matters. Make the cache release directories read-only where the platform allows it.

4. Copy instead of link for mutable sources. Git and registry installs already link into revision-addressed cache directories, which is a good basis. Local sources are different: `prepareInspectionTarget` sets repoRoot to the live folder with cacheKey null (D:\DevProjects\private\agentpm\packages\core\src\service.ts lines 3689-3703). That appears to mean the agent directory is linked to a folder anyone can edit later. Default to a snapshot copy keyed by tree hash. Keep live linking as an explicit dev mode that is marked `unpinned` in the lock and in doctor.

5. Update gate, modelled on SkilLock, whose motto is that a hash tells you something changed while a capability delta tells you what. On update, diff the old and new `externalRefs` and `capabilities`. If the update adds nothing, it goes through with a summary. Any NEW host, NEW unpinned launcher, NEW hook or dynamic-context command, NEW MCP server, or NEW out-of-tree path requires explicit approval. In non-interactive mode it fails unless the item is pre-approved.

6. Approvals are trust-on-first-use records bound to the tree hash (the MCPoison lesson). They hold {skill, item, integrity, approvedBy, at} and are stored outside the skill. Any content change voids them.

7. History-continuity check on git updates. Require the old locked commit to be an ancestor of the new one (`git merge-base --is-ancestor`, which needs a deeper fetch). If the numeric repo id changed or the ancestry broke, report 'repository was recreated or force-pushed' and require approval. This is the SkillJacking and repo-jacking case.

8. Optional cooldown (minimumReleaseAge) on registry `publishedAt`.

9. Registry rules: tombstoned versions and names, yank instead of delete, integrity in index.json, an append-only publish log, and the same deterministic reference scan re-run server side. Never trust the client's verdict.
Sources: https://github.com/skills-lock/skil-lock ; https://github.com/vercel-labs/skills ; https://github.com/OWASP/www-project-agentic-skills-top-10 ; https://research.checkpoint.com/2025/cursor-vulnerability-mcpoison/ ; https://www.air.security/blog-posts/skilljacking ; https://pnpm.io/supply-chain-security ; D:\DevProjects\private\agentpm\packages\core\src\service.ts ; D:\DevProjects\private\agentpm\packages\fs\src\index.ts

### C2. Residual risk and the honest mitigation: run-time fetches cannot be pinned by AgentPM [high]
AgentPM controls bytes on disk. It does not sit in the agent's tool loop. Four things follow:

1. A URL left in a skill returns whatever the host serves at run time. Fetching it at scan time proves nothing, because of the bait-and-switch scenario OWASP AST05 describes (different content by IP, user agent or timing), and it would break the offline and deterministic requirement. So do not fetch. Classify and gate instead.
2. Even a pinned npm or PyPI version executes code that AgentPM never hashed.
3. A remote MCP server can change its tool descriptions after approval.
4. A benign skill that legitimately browses the web still exposes the agent to indirect injection. Simon Willison's lethal trifecta applies: private data plus untrusted content plus an exfiltration channel. He argues that guardrail products that catch 95% of attacks are a failing grade.

Honest mitigations, in order of strength:

a. Remove the reference. The publish gate requires external docs to be vendored into the package, so the content sits under the tree hash. This is the OWASP 'prefer inlining over fetching' mitigation and the Nix rule that a fetch is allowed only with a pre-declared hash. Where content must stay live, route it through the registry as a new immutable version.

b. Make what remains explicit and consented. Keep a per-host inventory in the lock. Require approval bound to the tree hash. Offer an org allowlist. Show the inventory in `agentpm list` and `doctor`, so that when a host is later compromised every affected skill can be found. This is the OWASP fleet-visibility mitigation.

c. Hand enforcement to the layer that can do it. Generate, but do not silently apply, agent-side policy. For Claude Code that means `WebFetch(domain:...)` allow and deny rules, deny rules for curl and wget paired with the sandbox network allowlist, and `disableSkillShellExecution`, which neutralises `!`cmd`` blocks. The Claude Code docs themselves warn that Bash argument patterns are fragile and that only the sandbox allowlist really holds. Also recommend run-time MCP tool pinning (agent-scan or mcp-context-protector).

d. Say it in the UI. An 'integrity verified' message must read 'installed files match the reviewed version'. It must never read 'skill is safe'.

Two attacks that this does not stop:
- A patient author can ship a clean, fully vendored skill and then publish a malicious new version. The defences are the update diff gate, the cooldown and human review.
- A skill that tells the agent to fetch a URL constructed at run time from variables will evade static URL extraction. The mitigation is to flag any network tool verb (curl, wget, WebFetch, fetch) without a literal allowlisted host as 'dynamic network access' that requires approval.
Sources: https://github.com/OWASP/www-project-agentic-skills-top-10 ; https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/ ; https://code.claude.com/docs/en/permissions ; https://code.claude.com/docs/en/skills ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview ; https://nix.dev/manual/nix/2.24/language/advanced-attributes