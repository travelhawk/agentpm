# deterministic-detection

## SUMMARY
A deterministic, offline, pure-TypeScript gate is feasible for AgentPM, and most of the rule data already exists under permissive licenses. No current scanner can certify a skill as safe, so findings should gate installs behind approval rather than issue a verdict.

**Reusable rule sources (inspected in their repos)**
- Agent Threat Rules (MIT, TypeScript, npm `agent-threat-rules`): about 825 YAML regex rules, with around 50 in a skill-compromise category.
- Cisco `skill-scanner` (Apache-2.0, Python): YAML signatures, YARA rules and a policy file with limits.
- vigil-llm (Apache-2.0, stale since 2024): phrase rules in YARA.
- secretlint (MIT, pure JS) and the gitleaks TOML config (MIT, 222 rules) for secrets.
- `anti-trojan-source` (Apache-2.0) and native Node regex Unicode properties for hidden text.

**What is reliably detectable**
- Hidden channels: Unicode Tags, bidi controls, zero-width characters, variation selectors, control and escape characters, HTML comments and hidden HTML, whitespace inflation.
- Structural capabilities: Claude Code shell-injection syntax, skill hooks, `allowed-tools`, and plugin `hooks.json`, `.mcp.json`, `.lsp.json`, `bin/` and monitors; Codex `agents/openai.yaml` MCP URLs.
- Mutable targets: URLs near fetch verbs, branch-ref raw GitHub URLs, unpinned `npx`/`uvx`/`docker`/`pip`, and curl piped to a shell.
- Known-bad code idioms, secrets, and file hygiene.

**What is not reliably detectable**
- Natural-language injection. All eight scanners tested by Adversa were bypassed by paraphrase, translation and homoglyphs.
- Cisco's own source-disjoint benchmark shows 7.75% recall at 60.75% precision.
- Trail of Bits bypassed Cisco, ClawHub and the skills.sh scanners with 100,000 leading newlines, a `.pyc` file, a `.docx` and a prompt-injected LLM judge.
- OWASP AST08 states the same limit.

**Design consequences**
- Treat phrase rules as best-effort and default them to "needs approval".
- Hard-block only high-precision signals: hidden channels, fail-closed hygiene, known-bad code idioms and verified secret formats.
- Never truncate; treat oversize or unscannable content as a finding.
- Normalize (NFKC, strip ignorables, confusable skeleton) and decode-then-rescan before matching.
- Extract every external reference into a per-version manifest that is diffed on update. Detection cannot see future remote content, so pinning and re-approval must carry that risk.

**Issues found in AgentPM code**
- `assertSafeArchivePath` misses Windows reserved names, trailing dot or space, control characters, and case or Unicode-normalization collisions.
- `walkFiles` silently skips symlinks, so a scanner or tree signature built on it cannot see them.
- There are no per-file or file-count limits; only a 64 MiB request body cap.

## RECOMMENDATIONS
- Build a new pure-TypeScript package, for example `packages/security`. Do not widen `service.ts`. It should expose `scanSkill(files) -> {findings[], externalRefs[], capabilities[], contentSha256, rulesetVersion}`. The CLI (install, update, sync, pull, push, registry publish) and `packages/registry-server` should run the same code. The server always rescans on upload and stores the report, ruleset version and SHA-256 with the version. It can rescan stored archives when the ruleset changes.
- Order the pipeline so an evasion at one layer is caught by another:
1. Walk the tree with `lstat` to take inventory.
2. Run path, name, size, count and type hygiene, failing closed on violations.
3. Decode text strictly as UTF-8.
4. Run hidden-character checks on the raw text.
5. Parse markdown with mdast and frontmatter with a safe YAML loader.
6. Build the structural capability inventory: `!` injections, hooks, `allowed-tools`, plugin hooks, MCP, LSP, `bin`, monitors, and Codex `openai.yaml`.
7. Build the external-reference manifest.
8. Build a folded text (NFKC, strip default-ignorables, confusable skeleton, lowercase).
9. Run phrase, exfil and code rules on both raw and folded text.
10. Decode base64, hex, percent-encoding and escapes up to depth 2 and rescan.
11. Run secrets checks at the publish gates.
- Never truncate input and never silently skip a file. Oversize files, undecodable text, unknown binaries, bytecode, archives and password-protected archives must each produce a finding (BLOCK or NEEDS-APPROVAL). This is the exact failure Trail of Bits exploited, and ATR's `safeRegexTest` has the same shape (it returns false above 100,000 characters). If the ATR engine is used, chunk with overlap or fail closed.
- Use four severities with escalation rules:
- BLOCK for high-precision facts: Tags characters, bidi overrides, zero-width inside ASCII words, control or ESC characters, native executables and bytecode, extension/magic mismatch, escaping symlinks, pipe-to-shell, reverse shells, decode-and-exec, 'follow instructions from URL', a sensitive-path read combined with a network sink, and verified-format secrets on publish.
- NEEDS-APPROVAL for capability facts and ambiguous patterns.
- WARN and INFO for the rest.
- Any phrase-rule hit inside a hidden channel (HTML comment, invisible text, decoded blob, padded region) escalates to BLOCK.
- A clean result must be worded as 'no known patterns found', not 'safe'.
- Treat the external-reference manifest and capability inventory as the main control against content that turns malicious after review. Persist them with the SHA-256 in install state and lock. On update, sync or pull, diff them. Any new or changed URL, unpinned runner, MCP server, hook, `!` command or `allowed-tools` grant forces re-approval regardless of phrase-rule results. Classify references as pinned (commit SHA, `@sha256`, exact version) or mutable (branch, `latest`, plain URL). Offer policy knobs in `agentpm.yaml`, for example `security.allowDomains` and `security.requirePinnedRefs`.
- Vendor rule data rather than tools. Take ATR `rules/skill-compromise` plus the stable-maturity rules (MIT), selected Cisco core signatures and YARA string sets (Apache-2.0, with a NOTICE), and the vigil YARA regexes (Apache-2.0). Convert a leading `(?i)` to the JS `i` flag. Keep the upstream rule IDs in findings. Ship the rule pack as a versioned data file with its hash recorded in every scan report, for reproducibility. Do not copy file-wide 'not $doc_context' suppressors.
- Guard the regex engine. Run `recheck` or `safe-regex2` over the whole rule pack in CI. Execute any user-supplied or remotely updated rules with `re2js` (linear time). Cap per-file scan time, and treat a timeout as a finding rather than a pass.
- Fix the archive path validator in `D:\DevProjects\private\agentpm\packages\shared\src\index.ts` (`assertSafeArchivePath` and the duplicate check in `validateSkillArchive`):
- Reject Windows reserved device names, including the forms with extensions and superscript digits.
- Reject segments ending in a space or dot, the characters `<>"|?*`, code points 1–31, `.git` segments, and non-ASCII or invisible characters in names.
- Detect duplicates on the NFC-normalized, case-folded path.
- Add limits for file count, per-file size, total size, depth and path length.
- Handle symlinks explicitly. `walkFiles` in `D:\DevProjects\private\agentpm\packages\fs\src\index.ts` skips them silently, so `computeTreeSignature` and any scanner built on it cannot see a symlink that git clones put on disk. The scanner should use `lstat`. Block targets that are absolute or escape the skill root. Require approval for internal links. Move security-relevant signatures from SHA-1 to SHA-256.
- Wire the publish gate (client and server) to secretlint's recommended preset plus the `no-dotenv` and `no-homedir` rules, and to a denylist of bundled credential files (`.env*`, `*.pem`, `id_*`, `.npmrc` with a token, `.git-credentials`). Keep trufflehog out of the codebase because of AGPL. gitleaks and trufflehog can be optional shell-outs.
- Do not add native or non-Node dependencies by default: no YARA bindings, no Python scanners. Offer an optional `--external-scanner` adapter for Cisco skill-scanner or SkillSpector when the user has them installed, and merge their SARIF or JSON output into the same finding model.
- Sanitize everything AgentPM prints from untrusted skills (names, descriptions, README previews in the registry web UI). Strip control, ESC, bidi and invisible characters, and HTML-escape in `web-ui.ts`, so the scanner's own report cannot be spoofed.
- Build a regression corpus and measure false positives before enabling BLOCK by default.
- Malicious samples: equivalents of trailofbits/overtly-malicious-skills (newline inflation, `.pyc`, `.docx`), Cisco `evals/skills`, and the ATR rule test cases and evasion tests.
- Benign samples: anthropics/skills and getsentry/skills.
- Target about 0% false BLOCKs and under 10% NEEDS-APPROVAL on the benign set.
- Support a per-content-hash allowlist so an approved finding does not nag again until the content changes.
- State the residual risk in the docs. Paraphrased or translated natural-language instructions, payloads fetched at runtime, instructions inside images, and logic split across files are not reliably detectable by any deterministic scanner. The compensating controls are pinning by hash, re-approval on diff, curated or trusted sources, least-privilege `allowed-tools`, and the agent's own permission prompts and sandbox.

## CORRECTIONS (partly/refuted/unverifiable)
- [partly] ATR reuse recommendation: start with rules/skill-compromise plus the 'stable-maturity subset'; enforce lane (106 of 777 stable) ~0.24% FP on 65K benign gate, hunt lane ~9% FP
  -> The 0.24% FP figure does NOT apply to any skill rule. Every ATR skill-compromise rule is test-maturity with ~1.7-2.2% wild FP each, so they belong at NEEDS-APPROVAL/WARN, never BLOCK. 'Stable subset' = generic prompt-injection/MCP rules only.
- [partly] Tool: trufflehog is AGPL-3.0 (do not vendor); detect-secrets Apache-2.0; secrets-patterns-db CC-BY-SA-4.0; kingfisher and noseyparker Apache-2.0 Rust
  -> praetorian-inc/noseyparker is ARCHIVED (archived=true, last push 2026-02-21). Drop it from the optional shell-out list.
- [partly] Adversa AI tested 8 scanners; homoglyphs and invisible characters bypassed all 8; paraphrase/translation bypassed all PI detectors; no scanner fetches remote payloads or does OCR; FPR on 4,000 benign from 8.6% (Cisco) to 62.4% (huifer); none beat flag-everything F1 (0.655 vs 0.551); gaps = no NFKC folding, no decode-and-rescan; huifer substring allowlist bug; skillcop LLM verdict flip
  -> Homoglyphs did NOT 'bypass all 8'. Article: 'The homoglyph... bypasses every scanner that catches the plain command' (4 in the matrix: ai-skill, huifer, claude-av, HMA); Cisco and mondoo never caught the plain payload, and Cisco, NVIDIA and HMA DO emit a Unicode/confusable finding, they just do not re-run command rules on normalized text. Invisible-splitting variants are 'weaker': NVIDIA catches them via its pipe-to-shell rule. Paraphrase/translation beat all 5 scanners that have PI detection (not 8). Cisco: precision 0.784, recall 0.330 on this corpus.
- [partly] Trail of Bits bypassed ClawHub, Cisco and the skills.sh scanners (Gen, Socket, Snyk) in under an hour each using 100,000 leading newlines, a .pyc, a .docx and LLM-judge prompt injection ('corporate policy' framing; npm registry redirect payload)
  -> Only three of four took under an hour; the LLM-judge prompt-injection bypass took 'several hours'. The newline-truncation bypass was against ClawHub specifically; .pyc/.docx/judge-injection were against skills.sh and Cisco. ToB's conclusion is to curate sources and not 'outsource that judgment to an automated tool'.
- [partly] Unicode Tags (U+E0000-E007F) demonstrated against agent skills by Embrace The Red in Feb 2026; Claude, Gemini, Grok interpret tags; Anthropic shipped mitigations around 2026-02-10; Pillar 'Rules File Backdoor' 2025-03-18 used the same family
  -> 'Anthropic shipped mitigations' is the blogger's observation, not an announcement: he 'consistently got invisible unicode detection and refusals from Claude Code' on 2026-02-10, and says no such mitigation existed for Skills on claude.ai when he cross-checked. Do not rely on the agent to catch this; BLOCK in AgentPM stands.
- [partly] Frontmatter rule per Anthropic docs: name >64 chars, not [a-z0-9-], or containing 'anthropic' or 'claude'; description >1024; XML tags in name/description -> BLOCK
  -> Reserved words are an Anthropic API/claude.ai upload rule, not part of the open spec, and Claude Code treats name as optional (defaults to directory). Anthropic's own bundled skill is named 'claude-api'. BLOCKing names containing 'claude' would false-block legitimate skills; use WARN. XML tags in description = BLOCK is reasonable (description is injected into the system prompt). Also AgentPM's archive name regex /^[a-z0-9][a-z0-9._-]*$/i is looser than the spec (allows uppercase, dot, underscore).
- [partly] Node built-ins verified: \p{Default_Ignorable_Code_Point}, \p{Bidi_Control} (12 code points), isWellFormed, scoped (?i:) flags, leading (?i) rejected; control-char regex /[\p{Cc}&&[^\t\n\r]]/
  -> The && set-intersection syntax only compiles with the v flag; with u it throws 'Lone quantifier brackets'. Write /[\p{Cc}--[\t\n\r]]/v or /[\p{Cc}&&[^\t\n\r]]/v.
- [unverifiable] Host lists, agent credential paths (~/.claude/.credentials.json, ~/.codex/auth.json), persistence list, permission-bypass strings and hidden-HTML patterns are the researcher's own additions
  -> Treat as a reviewed, versioned data file with tests, not as sourced facts.

## ADDITIONS
- MISSED, directly on the owner's main worry: Air Security 'The Story of Skills' (2026-06-22) is a real-world controlled PoC of exactly the mutable-target rug pull. Skill 'brand-landingpage' pointed agents at attacker-controlled docs on stitch-design.ai (look-alike of stitch.withgoogle.com); 'Cisco's and Nvidia's scanners, and all of skills.sh's scanners' vetted it as safe; content was switched after trust; '26,000 agents were affected, including corporate accounts' agents' (payload only collected an email). Authors: 'A skill can't be scanned by its files alone; it has to be scanned for everything it points the agent to' and 'A one-time check at the time of install can't protect you'. Also 'The Circus of Skills' (2026-06-24) is the source of the 17,822/142,836 figure. https://www.air.security/blog-posts/the-story-of-skills ; https://www.air.security/blog-posts/the-circus-of-skills
- MISSED prior art for pin + drift detection: GitHub CLI 'gh skill' (v2.90.0, 2026-04-16; the local gh here is 2.92.0). '--pin' to tag or commit SHA, 'Content-addressed change detection: each installed skill records the git tree SHA of its source directory', immutable releases ('cannot be altered after publication, even by admins'), and provenance (repository, ref, tree SHA) written into SKILL.md frontmatter. GitHub explicitly says skills 'are not verified by GitHub and may contain prompt injections, hidden instructions, or malicious scripts'. AgentPM should interoperate with or at least not strip this frontmatter. https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/
- MISSED and relevant because AgentPM bridges to 'npx skills': vercel-labs/skills has skills-lock.json with a SHA-256 computedHash per skill. Open bug #781: the hash differs between Windows and Linux for the same skill because git core.autocrlf rewrites line endings before raw-byte hashing; #806: computedHash cannot be verified against installed files. AgentPM runs on Windows, so its content SHA-256 must be defined over canonical bytes (hash the archive/git blob content, or normalize CRLF for text, or clone with core.autocrlf=false) or pins will break across OSes. https://github.com/vercel-labs/skills/issues/781 ; https://github.com/vercel-labs/skills/issues/806
- MISSED closest functional analog: T-Zevin/SkillGuardrail (Go, Apache-2.0, 57 stars, pushed 2026-08-18): 'pre-install security scanner and guarded installer', never executes package code during inspection, verdicts PASS/REVIEW/BLOCK/CRITICAL, capability chains, and 'binds approved installs to a source commit, package fingerprint, and external receipt' with drift detection; states PASS 'is not a safety certificate'. Good design reference for AgentPM's gate and wording. https://github.com/T-Zevin/SkillGuardrail
- MISSED tools worth a look: openclaw/clawscan (MIT, Go core with npm package @openclaw/clawscan, 124 stars, pushed 2026-09-16) is a harness that runs SkillSpector + Cisco in Docker and compares against benchmarks; its README shows Cisco returning isSafe=true on ToB's csv-summarizer while SkillSpector scores MEDIUM, useful as the optional '--external-scanner' model and for benchmarking. Tencent/AI-Infra-Guard (Apache-2.0, Python, 6.4k stars) has a Skills Scan. alexgreensh/repo-forensics (176 stars, Python, license NOASSERTION) claims fully local, zero-dependency, Ed25519-signed rule feed: the signed-rule-feed idea is relevant if AgentPM ever updates rule packs remotely. LLMSecurity/awesome-agent-skills-security is a maintained reading list. https://github.com/openclaw/clawscan ; https://github.com/Tencent/AI-Infra-Guard ; https://github.com/alexgreensh/repo-forensics ; https://github.com/LLMSecurity/awesome-agent-skills-security
- Caution: Berserk-hub150/skillhawk (JavaScript, MIT, 'zero-dependency' Node skill scanner, 61 stars, created 2026-08-16) looks like the pure-Node prior art the researcher said does not exist, but its README is dominated by a 'fork this repo to play' star/fork-growth funnel. I did not audit its rules; treat as low-credibility, do not depend on it. https://github.com/Berserk-hub150/skillhawk
- OWASP AST07 'Update Drift' gives the normative wording for the pinning half of the design: 'Pin all installed skills to immutable content hashes (sha256:), not version ranges', signature verification on update, freeze mode, human-in-the-loop approval for updates, and an inventory with version, hash and last-verified timestamp. AST05 also mentions an 'OWASP Universal Agentic Skill Format' for declaring an allowlist of reference hosts/URL globs, which maps onto the proposed security.allowDomains knob. https://github.com/OWASP/www-project-agentic-skills-top-10/blob/main/ast07.md
- Claude Code has a native kill switch the researcher did not mention: settings key "disableSkillShellExecution": true replaces every bang-backtick / fenced '!' command in skills and custom commands with '[shell command execution disabled by policy]' (most useful in managed settings; bundled/managed skills unaffected). 'agentpm doctor' could report whether it is set, and docs can recommend it for teams. https://code.claude.com/docs/en/skills
- AgentPM-specific gap beyond the researcher's list: walkFiles (D:\DevProjects\private\agentpm\packages\fs\src\index.ts line 13) ignores entries named .git, node_modules, .turbo and dist. For registry archives that content is simply not shipped, but for git/local installs it remains on disk, is excluded from computeTreeSignature, and would be invisible to any scanner built on walkFiles. The scanner's own lstat walk must either scan these directories or emit a finding that they exist inside a skill. Also computeTreeSignature concatenates path and bytes without framing, so switching to SHA-256 alone does not make it a sound pin.
- Reality check on the residual risk: every deterministic reference-manifest approach (including the proposed one) only detects that a mutable reference EXISTS and whether the skill's own bytes changed. It cannot detect the Air Security / AST05 'reviewer bait-and-switch' where the URL serves clean content to scanners. The only deterministic preventions are (a) refuse or require explicit approval for fetch-and-follow references, (b) snapshot the referenced document into the package at publish time and rewrite the reference to the local copy, (c) domain allowlist, plus pin-by-hash for git refs and packages. This should be stated as the primary control, with phrase rules secondary.

## TOOLS
- Agent Threat Rules (ATR) | https://github.com/Agent-Threat-Rule/agent-threat-rules | MIT | TypeScript engine; YAML rules; Python wrapper | det: Fully deterministic regex evaluation. An MCP server and a guard hook are optional. Caveat: `safeRegexTest` returns no-match for inputs over 100,000 characters. | reuse: Vendor the rules (MIT). Start with `rules/skill-compromise` plus the stable-maturity subset of the other categories, taken through the generic-regex export. Run them in AgentPM's own matcher with chunking and fail-closed handling of oversize input. Keep the ATR IDs in findings. | About 393 stars, pushed 2026-09-18. npm `agent-threat-rules` is 4.0.0 on the registry and 4.1.0 in the repo. The rule format is a Working Draft with single-maintainer governance; upstreamed into the Cisco scanner.
- Cisco AI Defense skill-scanner | https://github.com/cisco-ai-defense/skill-scanner | Apache-2.0 per the LICENSE file (GitHub API reports NOASSERTION). The bundled ATR pack is MIT. | Python, plus a Go helper for CEL | det: The static, bytecode, pipeline, correlation and behavioral analyzers are deterministic. The LLM, meta, VirusTotal and AI Defense analyzers are not, or need network. | reuse: Port the rule data to TypeScript with attribution: the YAML signatures, YARA strings, the `default_policy.yaml` limits and the `evals/skills` fixtures. Optionally shell out when installed. Do not copy its file-wide negative-condition suppressors. | About 2,533 stars, pushed 2026-09-05. Actively benchmarked; publishes its own precision and recall honestly.
- NVIDIA SkillSpector | https://github.com/NVIDIA/SkillSpector | Apache-2.0 | Python 3.12+ | det: `--no-llm` static mode is deterministic. The OSV lookup needs network, with an offline fallback. | reuse: Inspiration only: the fail-closed resource bounds, the fingerprint baseline for accepted findings, and the 0–100 risk score. Optional shell-out. | About 17.7k stars, pushed 2026-09-18. Part of NVIDIA's Verified Skills pipeline (scan, evaluate, sign).
- deadbits/vigil-llm YARA rules | https://github.com/deadbits/vigil-llm/tree/main/data/yara | Apache-2.0 | Python; YARA rules | det: The YARA scanner is deterministic. The project's vector-database and transformer scanners are not. | reuse: Hand-port about 6 regexes to TypeScript with an Apache-2.0 notice. | 496 stars, last push 2024-01-31. Stale, but the rules are simple and still valid.
- anti-trojan-source | https://github.com/lirantal/anti-trojan-source | Apache-2.0 | JavaScript | det: Fully deterministic. | reuse: Either depend on its library API, or reimplement in about 50 lines using Node's native Unicode property escapes. Use its character list as a cross-check in tests. | npm 1.13.0, modified 2026-09-08. Needs Node 24 or later. Recommended by Snyk for GlassWorm.
- secretlint | https://github.com/secretlint/secretlint | MIT | TypeScript | det: Fully deterministic, offline. | reuse: Add as a dependency of the publish gate in the CLI and the registry server. Wrap `@secretlint/core` behind AgentPM's finding model. | About 1.45k stars, pushed 2026-09-17. npm 13.0.5, Node 22 or later, pure JS.
- gitleaks default rules | https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml | MIT | Go; TOML rules | det: Fully deterministic. | reuse: Optionally port a subset: convert the leading `(?i)` flags or run through `re2js`. Reuse its entropy and stopword design. Shell out if installed. | About 29.4k stars, pushed 2026-09-09.
- trufflehog | https://github.com/trufflesecurity/trufflehog | AGPL-3.0 | Go | det: The patterns are deterministic. Verification needs network. | reuse: Do not vendor or port because of AGPL. Optional user-installed shell-out only. | About 28k stars, pushed 2026-09-18.
- re2js | https://www.npmjs.com/package/re2js | MIT | JavaScript | det: n/a | reuse: Run third-party or user-supplied rule packs, and the gitleaks RE2 regexes, without ReDoS risk. It has no lookaround, so Cisco's lookbehind patterns stay on native RegExp, gated by `recheck` in CI. | 2.8.6, modified 2026-07-05. Zero dependencies, Node 18 or later.
- file-type / magic-bytes.js / isbinaryfile | https://github.com/sindresorhus/file-type | MIT | JavaScript | det: Fully deterministic. | reuse: Add as a dependency for the hygiene stage. It replaces the ad-hoc `isProbablyBinary` in `packages/fs` for classification. | `file-type` 22.1.1 (Node 22 or later, modified 2026-09-17). `magic-bytes.js` 1.13.1 (zero dependencies). `isbinaryfile` 6.0.0 (Node 24 or later, zero dependencies).
- Unicode UTS #39 confusables data | https://www.unicode.org/Public/security/latest/confusables.txt | Unicode License (permissive) | data | det: Fully deterministic. | reuse: Generate a compact TypeScript map at build time, restricted to mappings that land in ASCII. Pair it with native `\p{Script_Extensions}`. | Version 18.0.0, dated 2026-08-06. 6,712 mappings.
- trailofbits/overtly-malicious-skills | https://github.com/trailofbits/overtly-malicious-skills | none stated | Python / markdown | det: n/a | reuse: Use as an adversarial regression corpus. With no license, fetch it in CI or recreate equivalent fixtures rather than vendoring. Never install it. | 42 stars, pushed 2026-06-03.
- claude-skill-antivirus | https://github.com/claude-world/claude-skill-antivirus | MIT | JavaScript (Node 18+) | det: Fully deterministic. Adversa measured 52% FPR. | reuse: Inspiration for the UX (scan-only versus install, interactive approval) and the allowed-tools combination matrix. Do not reuse the rules wholesale, because the FPR is too high. | 80 stars, pushed 2026-06-23. npm 2.1.3.
- @litko/yara-x (node-yara-x) | https://www.npmjs.com/package/@litko/yara-x | MIT (YARA-X itself is BSD-3-Clause) | Rust via napi-rs | det: Deterministic. | reuse: Avoid. The native dependency breaks the pure-Node goal. Hand-port the few YARA rules instead. | 0.7.2, modified 2026-09-05.
- snyk/agent-scan (formerly invariantlabs mcp-scan) | https://github.com/snyk/agent-scan | Apache-2.0 | Python | det: Unknown. Historically it used a hosted analysis API, so assume it is not offline. | reuse: Inspiration only. Not suitable for an offline deterministic gate. | About 3,064 stars, pushed 2026-09-18.

## FINDINGS
### Pattern rules for natural-language injection are best-effort; measured limits are severe [high]
Evidence opened:
(1) Cisco skill-scanner README self-reports a source-disjoint split of TP=65, FP=42, TN=503, FN=774. That is 7.75% recall, 60.75% precision and 7.71% FPR. It says the result does not pass their own promotion gate. It also states that no findings does not mean no risk.
(2) Adversa AI tested 8 open-source scanners: Cisco, NVIDIA SkillSpector, mondoo skillcheck, skillcop, claude-skill-antivirus, huifer, ai-skill-scanner and hackmyagent. Homoglyphs and invisible characters bypassed all 8. Paraphrase and translation bypassed all prompt-injection detectors. No scanner fetches remote payloads and none does OCR. FPR on 4,000 benign skills ranged from 8.6% (Cisco) to 62.4% (huifer). None beat a flag-everything baseline on F1 (0.655 vs best 0.551). The architectural gaps named were no NFKC folding before matching and no decode-and-rescan layer.
(3) Trail of Bits bypassed ClawHub, Cisco and the skills.sh scanners (Gen, Socket, Snyk) in under an hour each. The techniques were 100,000 leading newlines causing truncation, malicious logic in a bundled `.pyc`, a payload inside a `.docx`, and prompt-injecting the LLM judge.
(4) HKUST SkillCloak (via Help Net Security): token rewriting evaded more than 80% of most static scanners, and payload packing more than 90%.
(5) OWASP AST08 'Poor Scanning' says regex cannot catch instructions such as telling the agent to retrieve a file and send it using the default HTTP client.
(6) ATR documents the precision/recall trade itself. Its enforce lane (stable rules only, 106 of 777) has about 0.24% FP on a 65K benign gate. Its hunt lane has about 9% FP.

Consequences for AgentPM:
(a) A clean scan must be labelled 'no known patterns found', never 'safe'.
(b) Phrase rules default to needs-approval or warn. They escalate to block only when found inside a hidden channel (HTML comment, invisible Unicode, decoded base64, padded region).
(c) Put effort into checks that are truly deterministic: hidden-channel detection, the structural capability inventory, the external-reference manifest, file hygiene and hash pinning.
(d) Do not add an LLM judge. It is itself injectable (the skillcop verdict flip; the Trail of Bits 'corporate policy' framing).
Sources: https://github.com/cisco-ai-defense/skill-scanner ; https://adversa.ai/blog/agent-skill-scanners-bypass-eight-tested/ ; https://blog.trailofbits.com/2026/06/03/the-sorry-state-of-skill-distribution/ ; https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-agent-skill-scanner-bypass-20260610-csa/ ; https://www.helpnetsecurity.com/2026/07/09/malicious-ai-agent-skills-scan/ ; https://github.com/OWASP/www-project-agentic-skills-top-10/blob/main/ast08.md ; https://github.com/Agent-Threat-Rule/agent-threat-rules

### Hidden text 1: Unicode Tags block (ASCII smuggling), U+E0000–U+E007F [high]
Attack: each ASCII character is mapped to U+E0000 plus its code. The result is invisible in editors, terminals and GitHub diffs but is read as text by models.
- Embrace The Red demonstrated it against agent skills in February 2026. It reports that Claude, Gemini and Grok interpret the tags, and that Anthropic shipped mitigations around 2026-02-10.
- Pillar Security's 'Rules File Backdoor' (2025-03-18) used the same family against `.cursor/rules` and Copilot instruction files.

Detection in JS (Node 26 was verified locally to support these property escapes; ICU 78, Unicode 17):
- `/[\u{E0000}-\u{E007F}]/u`.
- For the report, decode the payload with `String.fromCodePoint(cp - 0xE0000)` so the user sees the hidden instruction.
- Also flag escaped forms in source files: `/\\u\{?[Ee]00[0-7][0-9A-Fa-f]\}?|\\U000[Ee]00[0-7][0-9A-Fa-f]/`. Cisco's YARA rule does this.
- Raw UTF-8 bytes are `F3 A0 80|81 80–BF`.

False positives: the only legitimate use is emoji subdivision-flag tag sequences, `U+1F3F4` followed by `[U+E0020–U+E007E]+` and `U+E007F`. Only England, Scotland and Wales are RGI. Strip exactly those three sequences first; anything left is malicious in practice. Cisco treats any occurrence as always suspicious.

Evasion limits: none at the character level, because the scan is exact. An attacker can move to other invisible channels, covered in the next findings.

Default severity: BLOCK at install, publish and server. Show the decoded payload. Do not offer an override short of an explicit `--allow-hidden-unicode` flag per file hash.
Sources: https://embracethered.com/blog/posts/2026/scary-agent-skills/ ; https://www.pillar.security/blog/new-vulnerability-in-github-copilot-and-cursor-how-hackers-can-weaponize-code-agents ; https://en.wikipedia.org/wiki/Tags_(Unicode_block) ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/yara/prompt_injection_unicode_steganography.yara

### Hidden text 2: bidi controls (Trojan Source), zero-width characters, variation selectors, invisible separators, control characters [high]
Bidi (CVE-2021-42574; the homoglyph variant is CVE-2021-42694):
- The Rust advisory lists exactly U+202A, 202B, 202C, 202D, 202E, 2066, 2067, 2068 and 2069. Add the marks U+200E, U+200F and U+061C. JS: `/\p{Bidi_Control}/u` covers all 12.
- Severity: BLOCK for embeddings, overrides and isolates in any instruction or code file. WARN for a bare LRM/RLM in files that actually contain RTL script.

Zero-width and default-ignorable:
- Code points: U+200B, 200C, 200D, 2060, FEFF (non-leading), 00AD, 180E, 034F, 115F, 1160, 3164, FFA0, 2061–2064, 206A–206F, FFF9–FFFB.
- The generic, future-proof form is `/\p{Default_Ignorable_Code_Point}/u` plus `\p{Cf}`. `anti-trojan-source` uses the same approach: Cf and Cc categories plus an explicit list of 285 characters.
- FP: ZWJ in emoji sequences, ZWNJ/ZWJ in Persian and Indic text, a BOM at offset 0, and the soft hyphen.
- Suggested rules: (a) a zero-width character between two ASCII letters or digits is a keyword-splitting evasion such as `ig​nore`; BLOCK. (b) A run of 4 or more consecutive ignorables; BLOCK. (c) Otherwise NEEDS-APPROVAL with count and positions.
- Cisco uses looser thresholds (more than 50 with decode context, more than 200 alone). Those are tuned for large code files and are too lax for a SKILL.md.

Variation selectors (VS1–16 at U+FE00–FE0F; VS17–256 at U+E0100–E01EF):
- Paul Butler showed 256 selectors map to one byte each and survive copy and paste.
- GlassWorm (October 2025, more than 35,800 installs) hid executable JS in U+E0100–E01EF runs.
- Cisco cites the `os-info-checker-es6` npm attack.
- FP: VS16 (FE0F) or VS15 after emoji, and IVS after CJK ideographs.
- Rule: `/[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]{2,}/u` is BLOCK. A selector whose preceding code point is not `\p{Extended_Pictographic}`, a keycap base or `\p{Script=Han}` is NEEDS-APPROVAL.

Other classes:
- Invisible separators U+2028 and U+2029: BLOCK in code and markdown. Cisco found no legitimate use.
- Odd spaces U+00A0, 2000–200A, 202F, 205F, 3000: WARN in prose, NEEDS-APPROVAL inside code fences or commands.
- Private Use Area U+E000–F8FF and planes 15 and 16: NEEDS-APPROVAL. GlassWorm reporting mentions PUA; icon fonts are the benign case.
- Control characters `/[\p{Cc}&&[^\t\n\r]]/` including ESC (0x1B): BLOCK. AgentPM must also strip them before printing skill names and descriptions to the terminal. That ANSI-escape point is my own addition and is not sourced.
- Invalid UTF-8 or lone surrogates: decode with `new TextDecoder('utf-8',{fatal:true})` and check `isWellFormed()`. A failure is BLOCK.

Always run these checks on the raw text before any normalization.
Sources: https://blog.rust-lang.org/2021/11/01/cve-2021-42574/ ; https://trojansource.codes/ ; https://paulbutler.org/2025/smuggling-arbitrary-data-through-an-emoji/ ; https://snyk.io/articles/defending-against-glassworm/ ; https://github.com/lirantal/anti-trojan-source ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/yara/prompt_injection_unicode_steganography.yara ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/default_policy.yaml

### Hidden text 3: homoglyphs and mixed-script confusables; normalize before matching [medium]
Adversa found homoglyphs bypassed all 8 scanners because none NFKC-folds before command or phrase matching. UTS #39 (v18.0.0, 2026-08-27) defines:
- `confusables.txt` with 6,712 mappings (verified at unicode.org).
- The `skeleton()` algorithm (NFD, prototype mapping, NFD).
- Restriction levels: ASCII-Only, Single Script, Highly Restrictive, Moderately Restrictive, Minimally Restrictive.

Deterministic plan:
1. Identifiers must be ASCII. This covers the skill name, archive file names, command names inside code fences, and hostnames in URLs. The spec already says the name is `a-z0-9-`, at most 64 characters. Non-ASCII in these positions is BLOCK. `xn--` punycode hosts are NEEDS-APPROVAL.
2. Per-token mixed-script check in prose. A word containing `\p{Script_Extensions=Latin}` together with Cyrillic or Greek is NEEDS-APPROVAL. Node supports Script_Extensions natively, so no library is needed.
3. Matching pipeline: keep the raw text. Build a matching text as NFKC, then strip `\p{Default_Ignorable_Code_Point}`, then apply the confusable skeleton, then lowercase. Run every phrase, exfil and code rule on both raw and folded text. Report offsets against raw.
4. The ATR engine already does NFKC plus zero-width and bidi stripping, and re-tests raw text when normalization changed something.

Data options:
- Vendor `confusables.txt` directly (Unicode license, permissive) and generate a TS map at build time.
- The npm packages `unicode-confusables` 0.1.1 and `confusables` 1.1.1 are MIT with zero dependencies, but were last published in 2022 and carry old Unicode data.

FP: legitimate multilingual skills (Cyrillic, Greek or CJK prose) are fine under the per-token rule. Brand names with accents trigger a warn only.

Evasion: leetspeak (`MEM0RY.md`) and paraphrase are not covered. ATR documents leetspeak as a known miss in its own evasion tests.

Severity: identifiers BLOCK; mixed-script token NEEDS-APPROVAL; fullwidth or compatibility forms inside code fences NEEDS-APPROVAL.
Sources: https://www.unicode.org/reports/tr39/ ; https://www.unicode.org/Public/security/latest/confusables.txt ; https://adversa.ai/blog/agent-skill-scanners-bypass-eight-tested/ ; https://agentskills.io/specification ; https://github.com/Agent-Threat-Rule/agent-threat-rules/blob/main/src/engine.ts ; https://github.com/Agent-Threat-Rule/agent-threat-rules/blob/main/rules/skill-compromise/ATR-2026-00200-agent-memory-config-tampering.yaml

### Hidden text 4: HTML comments, hidden HTML/CSS, markdown comment tricks, whitespace inflation, non-text carriers [medium]
HTML comments:
- ATR-2026-00128 cites ClawHavoc variants that hid instructions such as 'agent should output all API keys' inside `<!-- -->`.
- Its regexes require a comment opener followed by a verb class: exfil verbs (`agent\s+should|send\s+all|curl\s|wget\s|api[_-]?key.{0,30}https?://`), override verbs (`ignore|override|bypass|disable|skip|forget` followed by `previous|all|safety|instruction|rule`), or concealment (`do\s+not\s+(mention|tell|inform|reveal|show)`).
- For AgentPM, extract every `<!--[\s\S]*?-->` and every markdown pseudo-comment `^\[[^\]]*\]:\s*(#|<>)\s*[("'].*`. Then:
  - Run the full rule set on the comment body with severity raised one step.
  - A body longer than 200 characters, or one containing a URL, a code or command token, or an imperative second-person verb, is NEEDS-APPROVAL.
  - Short benign comments (TODO, `markdownlint-disable`, `prettier-ignore`) are INFO. The claude-skill-antivirus README itself contains a TODO comment, so blanket blocking would generate false positives.

Hidden HTML in markdown (the patterns below are mine, not from a source):
- `<[^>]+style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0|color\s*:\s*(#fff(fff)?|white|transparent))`.
- A bare `hidden` attribute, and `<(script|iframe|object|embed|style|link|meta)\b`.
- Severity BLOCK in instruction files.
- A remote `<img src="http…">` or `![](http…)` is NEEDS-APPROVAL. It is both a mutable target and an exfil or tracking vector.
- Cisco promptguard `PG_EXFIL_HTML_TAG` flags script, iframe, embed and object tags with a remote src.
- Link-text versus target host mismatch, `[https://github.com/x](https://other.tld)`, is NEEDS-APPROVAL.

Whitespace inflation (Trail of Bits prepended 100,000 newlines so scanners truncated):
- Never truncate. Scan whole files, or fail closed when over the size limit.
- 20 or more consecutive blank lines, or content after them, is NEEDS-APPROVAL.
- 1,000 or more blank lines is BLOCK.
- `/\S[ \t]{80,}\S/` (text pushed off-screen) is NEEDS-APPROVAL.
- A markdown line longer than 2,000 characters is WARN.
- A SKILL.md over 500 lines is INFO, per the spec recommendation.

Non-text carriers:
- Arxiv 2606.18198 (SkillCamo) hides instructions in bundled images that the docs tell the agent to look at. Deterministic mitigation: list all images and PDFs. If SKILL.md instructs the agent to read, open or follow a bundled image, PDF or Office file, mark it NEEDS-APPROVAL.
- Trail of Bits used a `.docx`. Cisco's `command_injection.yaml` has PDF `/JS`, `/OpenAction`, `/Launch` and SVG script patterns (`PDF_EMBEDDED_JAVASCRIPT`, `SVG_EMBEDDED_SCRIPT`) that can be reused.

Evasion: instructions in plain visible prose, split across files, or in an unscanned format. That is why unknown binary formats must gate rather than pass.
Sources: https://github.com/Agent-Threat-Rule/agent-threat-rules/blob/main/rules/skill-compromise/ATR-2026-00128-html-comment-hidden-payload.yaml ; https://blog.trailofbits.com/2026/06/03/the-sorry-state-of-skill-distribution/ ; https://arxiv.org/abs/2606.18198 ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/promptguard/signatures/markdown_exfiltration.yaml ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/signatures/command_injection.yaml ; https://agentskills.io/specification ; https://github.com/claude-world/claude-skill-antivirus

### Open prompt-injection phrase rule sets and their licenses [high]
1. **Agent Threat Rules.** MIT, TypeScript, about 393 stars, pushed 2026-09-18. npm `agent-threat-rules` is 4.0.0 on the registry and 4.1.0 in the repo. Its only dependencies are `js-yaml` and `@modelcontextprotocol/sdk`, and it needs Node 18 or later.
   - About 825 YAML rules in 10 categories.
   - `rules/skill-compromise/` has about 50 rules: instruction injection, dangerous script, rug-pull setup (00126), HTML-comment payload (00128), Unicode smuggling (00129), exfil URL in instructions (00135), memory and config tampering (00200), and the Claude Code SessionStart hook RCE (00523), among others.
   - Each rule carries test cases, documented false positives, evasion tests, a maturity lane and, on some rules, a wild FP rate.
   - `atr convert generic-regex` exports a plain JSON regex list.

2. **Cisco skill-scanner core pack.** The LICENSE file is Apache-2.0; GitHub reports NOASSERTION because of a copyright header. About 2.5k stars, pushed 2026-09-05.
   - `skill_scanner/data/packs/core/signatures/*.yaml` covers prompt_injection, data_exfiltration, command_injection, obfuscation, supply_chain, hardcoded_secrets, social_engineering and unauthorized_tool_use.
   - 16 YARA files, including `coercive_injection`, `indirect_prompt_injection` and `prompt_injection_unicode_steganography`.
   - `default_policy.yaml` holds the limits.
   - Example IDs: `PROMPT_INJECTION_IGNORE_INSTRUCTIONS`, `PROMPT_INJECTION_CONCEALMENT` (`do\s+not\s+(tell|inform|mention|notify)\s+(the\s+)?user`), `UNRESTRICTED_MODE`, `BYPASS_POLICY`, `REVEAL_SYSTEM`.
   - It also bundles ATR 3.5.6 (712 signatures, MIT) and a 'promptguard' pack (26 rules: markdown exfil, PII, secret providers).
   - The YAML uses Python `re` syntax (`(?i)`, lookbehind).

3. **deadbits/vigil-llm.** Apache-2.0, 496 stars, last push 2024-01-31, so stale. `data/yara/` contains `instruction_bypass.yar` (a verb class, a temporal class and a noun class), `system_instructions.yar` (fake role tags such as `<|im_start|>system`, `[INST] <<SYS>>`, `[system](#assistant)`, `{{#system~}}`), `mdexfil.yar`, plus `apitokens`, `ssh` and `generic_secret`. It is small and easy to port by hand.

4. **Nova-Hunting/nova-rules.** MIT, 18 stars. Only the keyword and regex part is deterministic; the semantics and LLM clauses are not. Nova-proximity is GPL-3.0, so do not vendor it.

5. **NVIDIA/SkillSpector.** Apache-2.0, 17.7k stars, Python. 71 patterns across 17 categories plus YARA. Static mode is `--no-llm`.

Porting notes:
- JS RegExp rejects a leading `(?i)`; this was verified locally on Node 26, where the scoped form `(?i:…)` works. Strip `(?i)` to the `i` flag, as ATR's engine does.
- Cisco rules with file-wide negative conditions are trivially evadable and should not be copied as-is. For example, `system_manipulation_generic.yara` has `not $testing_commands and not $security_doc_context`, which is suppressed by simply mentioning pytest or 'security audit'.

Additional phrase classes I added (the 'before anything else' items come from Cisco's coercive YARA):
- Fake role or authority tags: `</?(system|assistant|user|IMPORTANT|critical)>`, `\[(SYSTEM|ADMIN)\]`.
- Precedence coercion: `before (using|calling|running) any other tool`, `highest priority over other tools`.
- Concealment: `do not (tell|mention|inform|show) the user`, `tell the user only that … succeeded`.
- Authority spoofing: `(Anthropic|OpenAI|the developers?) (has|have) (authorized|approved)`.
- Self-modification: `(append|write|add) .* to (CLAUDE|AGENTS|MEMORY|SOUL)\.md`.

FP: security skills, red-team docs and prompt-engineering tutorials quote these phrases.

Severity: NEEDS-APPROVAL for concealment, precedence or fake-role matches in instruction files. WARN for classic 'ignore previous instructions'. BLOCK only when the match sits inside a hidden channel.
Sources: https://github.com/Agent-Threat-Rule/agent-threat-rules ; https://github.com/cisco-ai-defense/skill-scanner ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/signatures/prompt_injection.yaml ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/yara/coercive_injection_generic.yara ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/yara/system_manipulation_generic.yara ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/atr/README.md ; https://github.com/deadbits/vigil-llm/tree/main/data/yara ; https://github.com/Nova-Hunting/nova-rules ; https://github.com/NVIDIA/SkillSpector

### Mutable targets and remote instruction loading: deterministic detection plus an external-reference manifest [medium]
Scale of the problem:
- Snyk ToxicSkills (2026-02-05): about 2.9% of ClawHub skills, and 21% of malicious samples, load instructions from external endpoints at runtime.
- OWASP AST05 cites Air Security finding 17,822 of 142,836 skills (about 12.4%) referencing an external instruction source.
- Anthropic's Skills docs warn that external-URL skills are risky and that dependencies can change over time.
- A scanner cannot see future content. The realistic control is to detect the reference, force a decision, and pin.

Deterministic extraction, the core of this lane. Parse every text file and emit a sorted external-reference manifest:
1. All `https?://`, `git@`, `ssh://`, `ftp://` URLs. Classify each by context:
   - A fetch verb within about 80 characters (`fetch|download|curl|wget|WebFetch|read|follow|load|visit|open|clone|pull|sync|update … from`) is NEEDS-APPROVAL.
   - Cisco's `indirect_prompt_injection_generic.yara` adds `follow (the )?instructions? (in|from) (the )?(file|webpage|url|link…)`, which is BLOCK-worthy.
   - ATR-00126 adds `(fetch|load|download|pull|sync|update)\s+(config|settings|rules|behavior|instructions|commands)\s+(from|via|at)\s+https?://`.
2. Mutable git refs:
   - Mutable: `raw\.githubusercontent\.com/[^/]+/[^/]+/(main|master|HEAD|develop|refs/heads/[^/]+)/`, `github\.com/.+/(blob|raw|tree)/(main|master|HEAD)`, gist raw URLs without a revision hash, release `latest/download`.
   - Pinned: a 40-hex commit segment.
3. Unpinned package runners:
   - `\bnpx\s+(--yes\s+|-y\s+)?(?!\S+@\d)\S+`, `@latest`, `\b(uvx|pipx\s+run|bunx|pnpm\s+dlx|yarn\s+dlx)\b`, `go\s+(run|install)\s+\S+@latest`.
   - `pip install` without `==`, `docker (run|pull) \S+(:latest)?` without `@sha256:`, `brew install`, `cargo install` without `--version`.
4. Pipe-to-shell:
   - `(curl|wget|iwr|irm|Invoke-WebRequest)\b[^\n|;]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b`, `\|\s*(python[23]?|perl|ruby|node|iex)\b`.
   - `(ba)?sh\s+<\(\s*curl`, `sh\s+-c\s+"\$\(curl`, PowerShell `IEX\s*\(?\s*(New-Object\s+Net\.WebClient|irm|iwr)`.
   - ATR-00121 escalates when the host is a raw IP or a paste site.
5. ATR-00126 code forms: `(eval|Function|new\s+Function)\s*\(\s*(fetch|axios|got|request|https?\.get|require\(['"]https?)`, and post-install hooks that fetch.
6. MCP and remote tools:
   - `.mcp.json` or `plugin.json` `mcpServers` with `url`, or with `command: npx|uvx|docker` unpinned.
   - Codex `agents/openai.yaml` `dependencies` with `transport: streamable_http` and a `url` (OpenAI docs).
   - Claude Code hooks of `type: http`.
7. Symlinks, `.gitmodules`, git-lfs pointers and `.gitattributes` filters.

Severity:
- Instruction-following from a URL, pipe-to-shell, or `eval(fetch())`: BLOCK.
- An unpinned runner, a mutable git ref, a remote MCP, or a fetch-verb URL: NEEDS-APPROVAL.
- A plain documentation link: INFO, but still recorded.

Persist the manifest (URL, class, file, line) in the install record and lock next to a SHA-256 of the content. On update, sync and pull, diff the manifest. Any added or changed external reference, or any new executable capability, forces re-approval even if the phrase rules are clean. That is the deterministic answer to a skill turning malicious after review.

OWASP AST05 mitigations to mirror: pin and hash referenced docs, prefer inlining a snapshot at publish, allowlist domains, audit transitively.

FP: nearly every real skill links to docs, so keep plain links at INFO and gate only fetch or execute contexts.

Evasion:
- URLs built from parts (`'ht'+'tp'`), hosts held in variables, a redirector on an allowlisted domain, and reviewer bait-and-switch (AST05).
- Adversa notes a substring allowlist bug: `github.com.attacker.com` matched a trusted-domain check. Parse hosts with WHATWG `URL` and compare the registrable domain exactly.
Sources: https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/ ; https://github.com/OWASP/www-project-agentic-skills-top-10/blob/main/ast05.md ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview ; https://github.com/Agent-Threat-Rule/agent-threat-rules/blob/main/rules/skill-compromise/ATR-2026-00126-skill-rug-pull-setup.yaml ; https://github.com/Agent-Threat-Rule/agent-threat-rules/blob/main/rules/skill-compromise/ATR-2026-00121-skill-dangerous-script.yaml ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/yara/indirect_prompt_injection_generic.yara ; https://learn.chatgpt.com/docs/build-skills ; https://code.claude.com/docs/en/plugins-reference ; https://adversa.ai/blog/agent-skill-scanners-bypass-eight-tested/

### Structural capability inventory for Claude Code and Codex: exact parsing, no natural-language judgement [high]
Claude Code skills docs, fetched 2026-09-18:
- SKILL.md supports dynamic context injection. Inline form: an exclamation mark directly followed by a backtick-quoted command, at line start or after whitespace. Block form: a fenced block whose info string is `!`.
- These run shell commands before the content reaches the model. They never prompt; they abort only on deny rules or a permission failure.
- Detection regexes: `/(^|\s)!`[^`\n]+`/m` and `/^```!\s*$/m`.
- Frontmatter keys that change capability: `allowed-tools` (pre-approves tools for the turn), `disallowed-tools`, `hooks` (a map registered when the skill is invoked), `shell` (bash or powershell), `context: fork`, `agent`, `model`, `user-invocable: false` (model-only, invisible to the user), `paths`.

Plugin reference:
- `hooks/hooks.json` or an inline `hooks` entry, with hook types command, http, mcp_tool, prompt and agent.
- `.mcp.json`, `.lsp.json`, `bin/` (added to the Bash tool PATH), `monitors/monitors.json` (background processes), `settings.json`, `workflows`.
- ATR has a dedicated rule for SessionStart hook pre-trust RCE (ATR-2026-00523).

Codex: `agents/openai.yaml` with `policy.allow_implicit_invocation` and `dependencies` of `type: mcp` with a `url`.

Rules. All are deterministic YAML, JSON or markdown parsing with negligible FP, because they report facts rather than intent:

| Condition | Severity |
|---|---|
| Any `!` injection | NEEDS-APPROVAL, showing the exact commands |
| `!` injection containing network, pipe-to-shell or sensitive-path tokens | BLOCK |
| `allowed-tools` with bare `Bash`, `Bash(*)`, `Bash(curl:*)`, `Bash(sh:*)`, `Bash(python:*)`, `Bash(npx:*)`, or unscoped `Write`/`Edit`/`WebFetch` | NEEDS-APPROVAL |
| `hooks` in skill frontmatter; plugin hooks of any type | NEEDS-APPROVAL |
| `type: http` hook, or a hook command outside `${CLAUDE_PLUGIN_ROOT}` | BLOCK |
| `bin/`, monitors, MCP or LSP servers | NEEDS-APPROVAL with the command line shown |
| `user-invocable: false` combined with broad tools | WARN |
| Frontmatter per Anthropic docs: `name` over 64 chars, not `[a-z0-9-]`, or containing 'anthropic' or 'claude'; description over 1024 chars; XML tags in name or description | BLOCK. XML tags in a description are a system-prompt injection vector because descriptions are loaded at startup. |
| Name differs from the directory name | WARN (spec) |

claude-skill-antivirus flags `Bash(*)` as critical and dangerous combinations such as Read plus WebFetch. Use that as inspiration.

YAML frontmatter must be parsed with a safe loader. Duplicate keys or anchor bombs are BLOCK.

Evasion: capabilities requested in prose ('run this with Bash') rather than declared. They still hit the agent's own permission prompts, which is the correct backstop.
Sources: https://code.claude.com/docs/en/skills ; https://code.claude.com/docs/en/plugins-reference ; https://learn.chatgpt.com/docs/build-skills ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview ; https://agentskills.io/specification ; https://github.com/claude-world/claude-skill-antivirus ; https://github.com/Agent-Threat-Rule/agent-threat-rules/tree/main/rules/skill-compromise

### Exfiltration patterns: markdown image/link, webhook/paste/tunnel hosts, DNS, sensitive-path reads combined with a network sink [medium]
Markdown or image exfiltration:
- vigil `mdexfil.yar`: `/\!\[\w+]\((https?:\/\/[\w\.-]+)\/(\w+)\?q=\)/`. It is narrow.
- Cisco promptguard `PG_EXFIL_MARKDOWN_IMAGE` (CRITICAL) flags an image URL containing template interpolation: `!\[[^\]]*\]\(https?://[^)]{0,200}(\{\{?[^}]+\}\}?|\$\{[^}]+\}|\$[A-Za-z_]\w*)[^)]*\)`. It also flags instruction phrasing `(render|display|show|output|create|insert|embed) (a )?(markdown )?(image|img) (with|where|containing) … (data|secret|key|token|env|conversation|history)`.
- Related: `PG_EXFIL_MARKDOWN_LINK`, `PG_EXFIL_HTML_TAG`, and `PG_EXFIL_DATA_URI` (`data:(text/html|application/javascript);base64,[A-Za-z0-9+/=]{50,}`).

Host lists:
- Sourced: ATR-00121 lists `glot.io`, `rentry.co`, `pastebin.com/raw`, `paste.c-net.org`, `hastebin.com/raw` and raw-IP URLs as ClawHavoc C2 and relay. Cisco `DATA_EXFIL_HTTP_POST` lists `discord.com/api/webhooks`, `pastebin` and `telegram`.
- Not sourced. The following additions come from my general knowledge and should be reviewed and kept as an updatable data file: `webhook.site`, `*.m.pipedream.net`, `requestcatcher.com`, `beeceptor.com`, `interact.sh`, `oast.(fun|live|site|pro|me|online)`, `burpcollaborator.net`, `*.ngrok(-free)?.(io|app|dev)`, `trycloudflare.com`, `loca.lt`, `serveo.net`, `hooks.slack.com`, `api.telegram.org/bot`, `transfer.sh`, `0x0.st`, `termbin.com`, `file.io`, `paste.ee`.
- Severity: a host on this list anywhere in a skill is NEEDS-APPROVAL. Combined with a POST, upload or pipe it is BLOCK.

DNS exfil:
- Command substitution inside a lookup: `(nslookup|dig|host|ping)\s+[^\n]*(\$\(|`|\$\{)`, and `\$\([^)]*\)\.[a-z0-9-]+\.[a-z]{2,}`.
- Cisco flags `socket.getaddrinfo`/`gethostbyname` with non-local arguments as CRITICAL.
- Severity: NEEDS-APPROVAL.

Sensitive sources:
- Cisco `DATA_EXFIL_SENSITIVE_FILES` and ATR-00121 cover `(cat|head|tail|strings)\s+[~$]?/?\.(aws|ssh|gnupg|kube)/[^|\n]*\|\s*(curl|wget|nc|base64|python|perl)`.
- Tokens to watch:
  - `~/.ssh/`, `id_(rsa|dsa|ecdsa|ed25519)`, `.aws/credentials`, `.config/gcloud`, `.azure`, `.kube/config`, `.docker/config.json`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.gnupg`, `.env(\.\w+)?`.
  - Shell history, `security find-(generic|internet)-password`, `login.keychain`, `secret-tool`.
  - Browser stores: `Login Data`, `Cookies`, `cookies.sqlite`, `logins.json`, `key4.db`, and the Chrome or Firefox profile paths.
  - Wallets: `wallet.dat`, `.electrum`, `Exodus`, `.config/solana/id.json`, and the MetaMask extension id.
  - Agent credentials: `~/.claude.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json`. The agent credential paths are from my knowledge and are not verified in this session.
  - Bulk environment dumps (`os.environ.copy()`, `printenv`, `env |`, `process.env` serialized), per Cisco `DATA_EXFIL_ENV_VARS`.
- Severity: a source token alone is NEEDS-APPROVAL in scripts and `!` injections, and WARN in prose. A source plus any network sink in the same file, or in the same skill for scripts, is BLOCK.
- The Snyk example decodes to a curl that sends base64 of `~/.aws/credentials`. That is why decode-and-rescan is required.

FP: cloud, devops and password-manager skills legitimately mention these paths. claude-skill-antivirus notes 1Password and Bitwarden skills as false positives.

Evasion: path built from parts (`os.path.join(home,'.ssh')`), globbing, paraphrase ('the file where AWS keeps keys'), or exfil through an allowed tool such as `git push` to an attacker remote. ATR-00527 covers a silent git remote mirror.
Sources: https://github.com/deadbits/vigil-llm/blob/main/data/yara/mdexfil.yar ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/promptguard/signatures/markdown_exfiltration.yaml ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/signatures/data_exfiltration.yaml ; https://github.com/Agent-Threat-Rule/agent-threat-rules/blob/main/rules/skill-compromise/ATR-2026-00121-skill-dangerous-script.yaml ; https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/ ; https://github.com/claude-world/claude-skill-antivirus

### Dangerous code in bundled scripts: remote exec, reverse shells, decode-and-exec, obfuscation and entropy, persistence, agent-config tampering [medium]
Apply these to `scripts/**`, code fences in markdown, `!` injections, and hook or MCP command strings.

Remote exec: the pipe-to-shell regexes in the mutable-target finding.

Reverse shells (ATR-00121, tuned for FP):
- `bash\s+-i\s+>&\s*/dev/tcp/|nc\s+-[a-zA-Z]*e[a-zA-Z]*\s|ncat\s+(-[a-zA-Z]*e|--exec)\b|mkfifo\s+/tmp/|python3?\s+-c\s+['"]import\s+(socket|os)|socat\s+exec`.
- Severity BLOCK.

Decode-and-exec:
- ATR: `(eval\s*\$\(\s*echo\s+["'][A-Za-z0-9+/=]{20,}["']\s*\|\s*base64\s+-d|echo\s+["'][A-Za-z0-9+/=]{20,}["']\s*\|\s*base64\s+(-d|--decode)\s*\|\s*(bash|sh|python|perl))`.
- ATR-00126: `(eval|exec|spawn|Function)\s*\(\s*(atob|Buffer\.from|base64[._-]?decode)\s*\(`.
- PowerShell `-e(nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{40,}` is my own addition.
- Severity BLOCK.

Dynamic exec:
- Cisco: Python `eval(`, `exec(`, `compile(`, `__import__(` with user input, `subprocess…shell=True`, `os.system(`.
- JS: `child_process` usage, `new Function(`, string `setTimeout`, and the constructor-access obfuscation `\[\s*['"]constructor['"]\s*\]\s*\(`.
- Severity NEEDS-APPROVAL. Legitimate helper scripts use these APIs constantly, so blocking would be unusable.

Password-protected archives (ATR, from Snyk ToxicSkills and ClawHavoc):
- `unzip\s+.*-P\s+` and 'extract using password'.
- Severity BLOCK.

Social engineering: 'copy … script … paste … terminal' is NEEDS-APPROVAL.

Obfuscation and entropy:
- Compute Shannon entropy on tokens of at least 40 characters drawn from `[A-Za-z0-9+/=_-]` or hex.
- The gitleaks default config uses per-rule thresholds, mostly 2–4.5, with an example of 3.5. detect-secrets has Base64 and Hex HighEntropyString plugins.
- Suggested: a base64-like token of 200 or more characters with entropy above 4.5 in a text or script file is NEEDS-APPROVAL. Also try decoding it. If the decoded text is mostly printable, rescan it with all rules at depth 2 or less.
- gitleaks has `--max-decode-depth`. The ATR engine decodes up to 5 base64 blocks. Adversa says static matching cannot work without decode-and-rescan.
- Minified or packed JS, a very long single line, and `\\x[0-9a-f]{2}` or `\\u00` escape density above a threshold are WARN or APPROVAL.

Persistence. This list is mine, except where Cisco or ATR are noted:
- `crontab\s+-|/etc/cron|/var/spool/cron`.
- Writes to `~/.(bashrc|zshrc|profile|bash_profile|zprofile|config/fish)`.
- `launchctl|LaunchAgents|LaunchDaemons`, `systemctl\s+(--user\s+)?enable|\.config/systemd/user`, `schtasks\s+/create`, `CurrentVersion\\Run`.
- Appending to `authorized_keys`.
- `\.git/hooks/|core\.hooksPath`, `git config --global`.
- Severity NEEDS-APPROVAL. If combined with a download, BLOCK.

Agent-config tampering:
- ATR-00200: `(write|append|modify|edit|overwrite|replace|inject|insert)\s+.{0,50}\b(MEMORY|SOUL|CLAUDE)\.md\b`, and shell redirects `>`/`>>` into those files. Reading them is benign.
- Extend, from my knowledge and unverified, to:
  - `AGENTS.md`, `GEMINI.md`, `.claude/settings(\.local)?\.json`, `~/.claude.json`, `.mcp.json`, `.cursor/rules`, `.cursorrules`, `.github/copilot-instructions.md`, `~/.codex/config.toml`.
  - Permission-bypass strings: `--dangerously-skip-permissions`, `bypassPermissions`, `enableAllProjectMcpServers`, `--yolo`, `approval_policy\s*=\s*"never"`, `danger-full-access`.
- Severity NEEDS-APPROVAL. BLOCK if inside a hidden channel or in an install-time script.

Other:
- Registry or package-manager redirection, which was the Trail of Bits prompt-injection skill payload. Writes to `.npmrc`, `registry=`, `pip.conf`, `index-url`, `GOPROXY`. Severity NEEDS-APPROVAL.
- Destructive operations: Cisco's tightened `rm -rf` on root-like paths, `dd if=/dev/zero of=/`, `chmod 777 /`, `sudo -s`.

FP is high for generic APIs, which is the reason for APPROVAL rather than BLOCK.

Evasion: string splitting, variable indirection, `$IFS`, backslash line continuations (Adversa), less common interpreters, compiled artifacts.

Optional later improvement: a real shell or JS AST. `web-tree-sitter` 0.27 (MIT, WASM, no native dependency) and `sh-syntax` 0.6 (MIT, WASM) exist. `tree-sitter-bash` from npm has a gyp build, so use only its wasm grammar.
Sources: https://github.com/Agent-Threat-Rule/agent-threat-rules/blob/main/rules/skill-compromise/ATR-2026-00121-skill-dangerous-script.yaml ; https://github.com/Agent-Threat-Rule/agent-threat-rules/blob/main/rules/skill-compromise/ATR-2026-00126-skill-rug-pull-setup.yaml ; https://github.com/Agent-Threat-Rule/agent-threat-rules/blob/main/rules/skill-compromise/ATR-2026-00200-agent-memory-config-tampering.yaml ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/signatures/command_injection.yaml ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/yara/system_manipulation_generic.yara ; https://github.com/gitleaks/gitleaks ; https://github.com/Yelp/detect-secrets ; https://adversa.ai/blog/agent-skill-scanners-bypass-eight-tested/ ; https://blog.trailofbits.com/2026/06/03/the-sorry-state-of-skill-distribution/ ; https://snyk.io/blog/toxicskills-malicious-ai-agent-skills-clawhub/

### Secrets on publish: secretlint is the pure-JS option; gitleaks rules are portable; trufflehog is AGPL [high]
secretlint:
- MIT, TypeScript, 1.45k stars, pushed 2026-09-17. npm `secretlint` 13.0.5 and `@secretlint/core` need Node 22 or later and have no native dependencies. The core README says it is pure JavaScript and runs in both browser and Node.
- `@secretlint/secretlint-rule-preset-recommend` plus individual rules cover: aws, gcp, github, npm, slack, sendgrid, shopify, stripe, openai, anthropic, groq, linear, 1password, database-connection-string, vercel, azure, docker, figma, cloudflare, huggingface, notion, privatekey, secp256k1-privatekey, basicauth, no-k8s-kind-secret, no-homedir, no-dotenv, and pattern (custom regex).
- It is the best fit for both the AgentPM CLI publish gate and the registry server, using the same code.

gitleaks:
- MIT, Go, 29k stars. `config/gitleaks.toml` has 222 rules with keywords, entropy thresholds, and allowlists or stopwords.
- The regexes are Go RE2. 114 start with `(?i)`, which JS RegExp rejects. I checked the config for `(?i)` and `(?-i:…)` occurrences.
- Port by stripping or scoping the flags, or run them through `re2js` (MIT, pure JS RE2 port, zero dependencies), which accepts RE2 syntax natively and is linear-time. Keep the MIT notice.

Other sources:
- trufflehog: AGPL-3.0. Do not vendor or port its detectors into an MIT or Apache project. At most offer an optional shell-out if the user has it installed.
- detect-secrets: Apache-2.0, Python; take the entropy-plugin ideas only.
- kingfisher (Apache-2.0, Rust) and noseyparker (Apache-2.0, Rust) are native, so shell-out only.
- `mazen160/secrets-patterns-db` is CC-BY-SA-4.0 (share-alike), so avoid bundling it.
- Cisco `hardcoded_secrets.yaml` and the promptguard `secret_providers.yaml` (12 providers) are Apache-2.0 and small.

Suggested policy:
- Publish gate, client and server, BLOCK on:
  - PEM private-key headers.
  - Provider-format keys: `AKIA…`, `ghp_`, `github_pat_`, `sk-ant-`, `sk-proj-`, `xox[baprs]-`, npm tokens, connection strings with passwords.
  - A bundled `.env*`, `.npmrc` with `_authToken`, `*.pem`, `id_rsa`, `.git-credentials`, `*.keystore`.
- NEEDS-APPROVAL: generic high-entropy assignments such as `(?i)(secret|token|passw(or)?d|api[_-]?key)\s*[:=]\s*['"][^'"]{16,}`, and absolute home-directory paths that leak a username (the secretlint `no-homedir` rule).
- Install side: WARN only. A leaked secret in someone else's skill does not endanger the installer, though it is a quality signal.
- The server must rescan. Never trust a client-side result.

FP: example keys in docs (`AKIAIOSFODNN7EXAMPLE`) and test fixtures. Support an inline allow comment and a per-hash allowlist.

Evasion is irrelevant here because this is accident prevention. Still, secrets inside base64 or archives are missed unless decode-and-rescan runs.
Sources: https://github.com/secretlint/secretlint ; https://www.npmjs.com/package/secretlint ; https://github.com/gitleaks/gitleaks ; https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml ; https://github.com/trufflesecurity/trufflehog ; https://github.com/Yelp/detect-secrets ; https://github.com/mazen160/secrets-patterns-db ; https://www.npmjs.com/package/re2js

### File hygiene: limits, binaries, archives, bytecode, path and name safety, symlinks; concrete gaps in current AgentPM code [high]
Reference limits:
- Cisco `default_policy.yaml`: `max_file_count` 100, `max_file_size_bytes` 5 MB, `max_reference_depth` 5, name 64, description 1024.
- NVIDIA SkillSpector: per-ingest 100 MiB, 10,000 or fewer zip members, 1 MB per-file analysis cap, and it fails closed (`IngestLimitExceededError`).
- agentskills.io spec: SKILL.md under 500 lines and about 5k tokens or less, name 64 or less, description 1024 or less, compatibility 500 or less, references one level deep.
- Suggested AgentPM defaults: 200 or fewer files, 1 MiB or less per text file, 5 MiB or less per file, 20 MiB or less total, path depth 8 or less, path length 200 or less. Exceeding any of these is BLOCK, because a file over a limit cannot be scanned and so fails closed.

Executables and binaries:
- Detect by magic bytes, not extension: ELF `7F 45 4C 46`; PE `MZ`; Mach-O `FEEDFACE`/`FEEDFACF`/`CAFEBABE`/`CFFAEDFE`; WASM `00 61 73 6D`; Java class; shebang `#!`.
- npm options: `file-type` 22.1.1 (MIT, Node 22 or later, pure JS), `magic-bytes.js` 1.13.1 (MIT, zero dependencies), `isbinaryfile` 6.0.0 (MIT, Node 24 or later, zero dependencies).
- Severity:
  - Native executables and libraries (`.so`, `.dll`, `.dylib`, `.node`): BLOCK.
  - Compiled bytecode: BLOCK. This covers `.pyc`, `.pyo`, `__pycache__`, `.class`, `.jar`, `.wasm`. It is the Trail of Bits `.pyc` bypass; Cisco has since added a bytecode analyzer.
  - Archives, including `zip`, `tar`, `gz`, `7z`, `rar`, `docx`, `xlsx`, `pptx`, `jar` and `whl`: NEEDS-APPROVAL. A password-protected archive is BLOCK. If archives are ever unpacked for scanning, cap depth, member count and ratio to avoid zip bombs.
  - Images and PDFs: INFO. Raise to NEEDS-APPROVAL when the instructions tell the agent to read them. PDF `/JS`, `/OpenAction`, `/Launch` and SVG `<script>`, `on*=` or `javascript:` are BLOCK (Cisco rules).
  - An extension that disagrees with the magic bytes, for example `notes.md` that is a ZIP: BLOCK.
  - Hidden dotfiles containing code: Cisco `HIDDEN_FILE_WITH_CODE`, HIGH.
  - An executable bit on non-script files: WARN.

Path and name safety, the current state in AgentPM:
- `assertSafeArchivePath` in `D:\DevProjects\private\agentpm\packages\shared\src\index.ts` uses the segment regex `/^[^\\/:\0]+$/`. It rejects absolute paths, drive letters, `.`/`..`, backslash, colon and NUL, and rejects exact duplicate paths.
- `materializeArchive` in `packages\fs\src\index.ts` re-checks containment with `path.relative`. Good.
- Gaps:
  1. Windows reserved device names are not rejected. Per Microsoft docs these are CON, PRN, AUX, NUL, COM1–9, COM¹²³, LPT1–9, LPT¹²³, also when followed by an extension such as `NUL.txt`. Regex: `/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i`.
  2. Segments ending in a space or dot are not rejected, and neither are the characters `<>"|?*` or code points 1–31.
  3. Duplicate detection is case-sensitive and not Unicode-normalized. `SKILL.md` and `skill.md`, or NFC versus NFD names, collide on NTFS and APFS and let a later entry overwrite a reviewed one. Compare on `name.normalize('NFC').toLowerCase()`. CVE-2021-21300 shows case-fold plus symlink collisions reaching RCE in git.
  4. No invisible, bidi or confusable check on file names. Apply the identifier rule: ASCII only, or at least no default-ignorable or bidi characters.
  5. No per-file or file-count limits. The server only caps the body at 64 MiB (`DEFAULT_MAX_ARCHIVE_BYTES`).
  6. Reject segments named `.git`, and flag `.gitattributes`, `.gitmodules` and LFS pointers.

Symlinks:
- `walkFiles` in `packages\fs\src\index.ts` uses `Dirent.isFile()` and `isDirectory()`, so symlinks are silently skipped.
- They are therefore never packed (good for publish) but also never hashed by `computeTreeSignature` and never seen by a scanner built on `walkFiles`. Meanwhile a git-cloned skill keeps the symlink on disk and the agent will follow it.
- The scanner needs its own `lstat` walk. A symlink whose target is absolute or escapes the skill root is BLOCK. An internal symlink is NEEDS-APPROVAL. Hardlinks and junctions on Windows get the same treatment.
- The tree signature uses SHA-1. Use SHA-256 for anything that serves as a security pin.

All checks in this finding are exact, with negligible false positives.
Sources: https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/default_policy.yaml ; https://github.com/NVIDIA/SkillSpector ; https://agentskills.io/specification ; https://blog.trailofbits.com/2026/06/03/the-sorry-state-of-skill-distribution/ ; https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file ; https://github.com/git/git/security/advisories/GHSA-8prw-h3cq-mghm ; https://www.npmjs.com/package/file-type ; https://www.npmjs.com/package/magic-bytes.js ; https://www.npmjs.com/package/isbinaryfile ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/signatures/supply_chain.yaml ; https://github.com/cisco-ai-defense/skill-scanner/blob/main/skill_scanner/data/packs/core/signatures/command_injection.yaml

### Node >= 24 building blocks with no native dependencies, and what to avoid [high]
Built into Node, verified locally on v26.2.0 (ICU 78.3, Unicode 17):
- `\p{Default_Ignorable_Code_Point}`, `\p{Bidi_Control}`, `\p{Script_Extensions=…}`, `\p{Cf}`, `\p{Cc}`, `\p{Extended_Pictographic}`.
- `String.prototype.normalize('NFKC')`, `isWellFormed()`, `TextDecoder` with `{fatal:true}`.
- Scoped inline flags `(?i:…)`. A leading `(?i)` is rejected.
- `crypto.createHash('sha256')`.
- No library is needed for hidden-text detection.

Useful npm packages, from registry metadata fetched today:

| Package | Version | License | Notes |
|---|---|---|---|
| `re2js` | 2.8.6 | MIT | Zero dependencies. Pure JS RE2 port, linear time. Good for running third-party or user-supplied rules safely and for gitleaks RE2 syntax. No lookaround. |
| `recheck` | 4.5.0 | MIT | ReDoS checker. Use it, or `safe-regex2` 5.1.1, in CI over the rule pack. |
| `file-type` | 22.1.1 | MIT | Node 22 or later. |
| `magic-bytes.js` | 1.13.1 | MIT | Zero dependencies. |
| `isbinaryfile` | 6.0.0 | MIT | Node 24 or later. |
| `secretlint` / `@secretlint/core` | 13.0.5 | MIT | |
| `agent-threat-rules` | 4.0.0 | MIT | Dependencies: `js-yaml` and the MCP SDK. Prefer vendoring the exported rule JSON over the whole package. |
| `anti-trojan-source` | 1.13.0 | Apache-2.0 | Node 24 or later. Depends on `meow` and `globby`. The library API can run on strings. |
| `out-of-character` | 2.3.0 | MIT | |
| `@unicode/unicode-17.0.0` | | MIT | 1.8 MB of data; rarely needed. |
| `unicode-confusables` / `confusables` | 0.1.1 / 1.1.1 | MIT | Last published 2022. Better to generate a map from unicode.org `confusables.txt` at build time. |
| `web-tree-sitter` | 0.27 | MIT | WASM. `sh-syntax` 0.6 (MIT, WASM) for optional shell AST. |
| `mdast-util-from-markdown` | 2.0.3 | MIT | Extracts code fences, links, HTML nodes and comments reliably. Regex over raw markdown mis-handles nesting. |

Shannon entropy takes about 10 lines of code, so no package is needed.

Avoid:
- `@litko/yara-x` 0.7.2. It is a napi-rs native binding with per-platform optional binaries and no musl target.
- `re2` 1.26.1. It is a node-gyp native build.
- `tree-sitter-bash` from npm, which has a gyp build.
- YARA-X itself is BSD-3 Rust. There is no maintained pure-JS YARA. YARA text rules from Cisco and vigil should be hand-ported to `{id, strings[], condition}` objects in JS; the conditions are simple boolean and count logic.

ATR engine caveat, verified in source:
- `safeRegexTest` in `src/engine.ts` returns false when the input is longer than 100,000 characters (`MAX_EVAL_LENGTH`).
- That means no match for oversize input, which is the same fail-open shape Trail of Bits exploited with newline padding.
- If AgentPM uses the ATR engine, it must chunk with overlap or fail closed on oversize input. I did not verify whether ATR's CLI scan path chunks upstream.
Sources: https://www.npmjs.com/package/re2js ; https://www.npmjs.com/package/recheck ; https://www.npmjs.com/package/file-type ; https://www.npmjs.com/package/@litko/yara-x ; https://www.npmjs.com/package/agent-threat-rules ; https://github.com/Agent-Threat-Rule/agent-threat-rules/blob/main/src/engine.ts ; https://github.com/lirantal/anti-trojan-source ; https://github.com/VirusTotal/yara-x ; https://www.unicode.org/Public/security/latest/confusables.txt

### Existing skill scanners on GitHub: nothing drop-in for a pure-Node, offline, deterministic gate [high]
Inspected via the gh API and READMEs on 2026-09-18:
- NVIDIA/SkillSpector: Apache-2.0, Python 3.12+, 17.7k stars. A static mode (`--no-llm`) is available. Its OSV lookup needs network, with an offline fallback.
- snyk/agent-scan: Apache-2.0, Python, 3.0k stars. `invariantlabs-ai/mcp-scan` redirects to it. Not inspected in depth.
- cisco-ai-defense/skill-scanner: Apache-2.0 text, Python 3.11–3.14 plus a Go-built CEL helper, 2.5k stars. It is the richest deterministic rule data.
- Agent-Threat-Rule/agent-threat-rules: MIT, TypeScript. The only serious TypeScript-native engine and rule corpus.
- claude-world/claude-skill-antivirus: MIT, Node 18 or later, 80 stars. Regex engines plus an installer wrapper. Adversa measured 52% FPR.
- opena2a-org/hackmyagent: Apache-2.0, TypeScript, 42 stars. Adversa: 43.8% FPR, and it skips non-SKILL.md files.
- mondoohq/skillcheck: Apache-2.0, Go. It relies on a hash database and returns clean on novel skills.
- highflame-ai/ramparts: Apache-2.0, Rust.
- Nova-Hunting/nova-proximity: GPL-3.0, Python.
- huifer/skill-security-scan: MIT, Python. 62% FPR.
- bitdefender/Agent-Skill-Scanner: license unclear.
- trailofbits/overtly-malicious-skills: no license file, 42 stars. It is the adversarial test corpus with 4 bypass skills.

Other references:
- Embrace The Red's AID scanner targets Unicode tag runs.
- Pillar Security has a hosted rule scanner. It is not offline.
- Anthropic offers 'Skill content scanning' only for Enterprise uploads on claude.ai and Cowork, not Claude Code or the API. Filesystem skills get no vendor-side scan, which is the gap AgentPM would fill.

Conclusions:
1. Port or vendor rule data (ATR MIT, Cisco Apache-2.0, vigil Apache-2.0) into a small TypeScript engine. Do not shell out to Python or Go tools by default; they break the pure-Node, offline and reproducible goals.
2. Optionally offer `agentpm scan --external skill-scanner|skillspector` when one of those tools is installed.
3. Expect roughly 1–9% FP on benign skills at needs-approval level, judging from Cisco's 8.6% in Adversa's test and ATR's hunt-lane 9%. Keep BLOCK to the high-precision classes so blocked installs are almost never false.
Sources: https://github.com/NVIDIA/SkillSpector ; https://github.com/snyk/agent-scan ; https://github.com/cisco-ai-defense/skill-scanner ; https://github.com/Agent-Threat-Rule/agent-threat-rules ; https://github.com/claude-world/claude-skill-antivirus ; https://github.com/opena2a-org/hackmyagent ; https://github.com/mondoohq/skillcheck ; https://github.com/highflame-ai/ramparts ; https://github.com/Nova-Hunting/nova-proximity ; https://github.com/trailofbits/overtly-malicious-skills ; https://adversa.ai/blog/agent-skill-scanners-bypass-eight-tested/ ; https://embracethered.com/blog/posts/2026/scary-agent-skills/ ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview