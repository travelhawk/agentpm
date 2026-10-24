# client-install-flows

## install - core pipeline with a git source (github:, https, ssh, file://); all other install variants converge here
Entry: D:/DevProjects/private/agentpm/apps/cli/src/index.ts:1411 (install/add command) -> D:/DevProjects/private/agentpm/packages/core/src/service.ts:727 (AgentPmService.install)
Steps:
  - CLI:1411-1487 parses --from, --add-source, --global/--project/--workspace, --workspace-root, --all, --skill, --ref, --target, --kind, --yes, --json and calls service.install. There is no --revision CLI flag; revision only arrives from agentpm.yaml via sync.
  - SVC:733-739 resolve scope (prompt if no flag, default 'project' without prompts SVC:4258-4280) and scopeRoot (CFG:791-806: home for global, cwd for project, workspaceRoot verbatim for workspace).
  - SVC:740 resolveSelections (SVC:3953). With --from: resolveSourceForInstall (SVC:3713) -> classifySource/normalizeLocator (SVC:3272-3322), optional confirm 'Add this repo as a permanent AgentPM source?' (skipped by --yes), else a transient source row; listSourceEntries -> prepareInspectionTarget (SVC:3684) -> prepareGitContent with requireFullCheckout. FIRST NETWORK FETCH: the repo is already cloned into the cache here just to index entries.
  - Per selection SVC:745 prepareContentForEntry (SVC:4282) -> prepareGitContent (SVC:3806): cacheKey = makeId('cache', locator); materializeGitRelease (GIT:160).
  - GIT:165-171 resolve target revision: options.revision, else 'git ls-remote <locator> <ref|HEAD>' first line (GIT:146-157). releasePath = <AGENTPM_HOME>/cache/repos/<cacheKey[0:16]>/r/<revision[0:12]> (GIT:52, SVC:311). If releasePath exists it is returned as-is (GIT:173-175).
  - GIT:178-188 'git clone --quiet --depth 1 --filter=blob:none --no-checkout [--branch <ref> when ref is not hex] <transportLocator> <releasePath>'; GIT:191-194 cone sparse-checkout of [entry.path, .codex, .claude, .agents, skills, subagents, install.*] (SVC:4330, GIT:16-26); GIT:196-220 when revision/ref is 7-40 hex: 'git fetch origin <sha> --depth 1' + checkout FETCH_HEAD, else checkout HEAD; returns rev-parse HEAD.
  - SVC:3877 inspectRepository (ADP:669): layout detection per adapter, plugin detection, detectInstallScripts (name match only, ADP:107/771), calculateTrust (ADP:630). saveCacheRepo (SVC:3929).
  - SVC:764-805 filter detected entries by --target/--kind, collectInstallCandidates, resolveInstallCandidate (picker, or error when --yes/non-interactive).
  - SVC:807-813 adapter.install -> InstallMapping; linkTarget = <releasePath>/<sourceRelativePath>; targetPath = <scopeRoot>/<native skill root>/<subPath> (ADP:476-569).
  - SVC:815-816 ensureDir + relinkManagedContent (SVC:2162) -> ensureManagedLink (FS:116-140). This is the instant third-party content becomes visible to the agent.
  - SVC:818-868 db.saveInstall: installedRevision = commit SHA, contentRef = --ref or catalog ref, cacheKey, layoutSignature, metadata {sourceLocator, sourceKind}.
  - SVC:870-871 .git/info/exclude + .gitignore; SVC:897-900 updateExistingProjectConfig writes source + ref + revision into an existing agentpm.yaml.
Existing checks:
  - Install scripts (install.sh/ps1/js/mjs/cjs/ts) are detected by filename and never executed (ADP:107, ADP:682-687); they lower the trust score by 30 (ADP:655-660). BUT install() never reads report.trust/report.scripts/report.warnings; they are shown only by 'agentpm inspect' (CLI:368-430).
  - ensureManagedLink refuses to replace a non-link path or a link that resolves elsewhere (FS:123-136); relinkManagedContent only re-points stale links that resolve into cacheDir or skillsLibraryDir (SVC:2170-2177).
  - Skill/agent entry names are directory basenames (ADP:366), so a name cannot traverse out of the native root.
  - Clone is shallow, blob-filtered, --no-checkout, and does not pass --recurse-submodules, so submodules are not populated by AgentPM itself; repository hooks are not transferred by clone.
  - Same-name ambiguity yields a picker or a hard error non-interactively (SVC:956-995, SVC:4180-4221).
  - Pinned hex revision is fetched by SHA (content-addressed) (GIT:196-208).
Gaps:
  - No content inspection of any kind before linking: SKILL.md/frontmatter is never parsed; no extraction of URLs, fetch instructions, shell commands, 'curl | sh', 'npx pkg@latest', MCP servers, hooks, allowed-tools; no hidden-Unicode / HTML-comment checks; no size, binary or executable checks.
  - Mutable link target: the agent dir is a junction/symlink into <AGENTPM_HOME>/cache. No tree hash is stored for git installs and an existing release dir is reused without verification (GIT:173). Any local process, including a prompt-injected agent with file-write tools, can edit the cached skill in place; every project linked to that release is affected and neither update (compares commit SHA strings, SVC:1018) nor doctor (SVC:2932-3015) can notice.
  - walkFiles blind spots (FS:13, FS:46-70): symlinks and directories named node_modules/dist/.turbo/.git are invisible to signature, diff and install-script detection but are reachable through the link. On POSIX git checks out real symlinks (core.symlinks is not forced to false), so a skill can ship 'notes.md -> ~/.ssh/id_rsa' or 'refs -> /' and the agent will follow it.
  - Git invocation is not hardened (GIT:93-132, GIT:178-220): inherits the user's global/system git config and full process env; no -c core.symlinks=false, -c core.hooksPath=<empty>, -c submodule.recurse=false, -c protocol.file.allow=user / GIT_ALLOW_PROTOCOL allow-list, GIT_LFS_SKIP_SMUDGE=1 (an installed git-lfs smudge filter runs at checkout and contacts the URL in the repo's .lfsconfig), -c core.fsmonitor=false. Locator and ref are positional without a '--' end-of-options separator (GIT:146, GIT:184), so a locator beginning with '-' (from agentpm.yaml sources or a registry index 'repo') is an option-injection candidate (--upload-pack class). Code-derived, untested.
  - Floating by default: without --ref the default-branch HEAD is installed; branches and tags are mutable; for annotated tags ls-remote's first line is the tag object SHA (GIT:150-153), not the peeled commit. After checkout there is no assertion that rev-parse HEAD equals the requested revision (GIT:222).
  - resolveGitRevision receives the raw locator (e.g. 'github:owner/repo') while clone receives the transport-normalized URL (GIT:164-171 vs GIT:146) - inconsistent normalization; low confidence on practical impact, but it means the revision check and the clone may not address the same remote string.
  - --yes is a single switch for every prompt; there is no risk tiering, so any future security confirmation would be silently skipped by existing automation unless it is deliberately decoupled.
  - Third-party strings (entry names, paths, registry descriptions) are rendered in pickers and console output without control-character/ANSI stripping; only skills.sh bridge output is stripped (BRIDGE:62). Low confidence/low severity.
Hook points:
  - PRIMARY GATE - D:/DevProjects/private/agentpm/packages/core/src/service.ts:808-815 (after adapter.install() computed linkTarget, before relinkManagedContent at :816). Exact subtree, kind, adapter, scope, source and revision are all known; nothing has been linked yet. Call a helper such as runInstallGate({ dir: linkTarget, repoRoot, entry: detectedEntry, source, revision, previousInstall }) -> allow | warn | confirm | block; throw AgentPmError before linking on block/declined. Every install variant (git, local, registry index, archive, plugin, skills.sh bridge, sync) passes through this line.
  - PERSIST - D:/DevProjects/private/agentpm/packages/core/src/service.ts:837-868 (db.saveInstall): store treeSha256, rulesetVersion, verdict, capabilities and accepted finding fingerprints (metadata.security or new columns); SVC:897-900 / SVC:1545-1570 write the same into agentpm.yaml or agentpm.lock.
  - EARLY VISIBILITY - D:/DevProjects/private/agentpm/packages/adapters/src/index.ts:669 (inspectRepository) or its callers SVC:3877 / SVC:3692 / SVC:4358: attach a repo-level security summary to InspectionReport so 'agentpm inspect', 'source skills' and the install picker (SVC:4013-4021) can show risk badges before the user selects. Keep the blocking decision at SVC:808 because it is scoped to the exact subtree.
  - GIT HARDENING - D:/DevProjects/private/agentpm/packages/git/src/index.ts:178-220 and :146: central gitHardeningArgs()/env helper (config overrides listed in gaps, '--' before positional locator, reject locators/refs starting with '-'), and assert rev-parse HEAD === requested full SHA when pinned.
  - CACHE REUSE - D:/DevProjects/private/agentpm/packages/git/src/index.ts:173 (and SVC:4353 for archives): before trusting an existing release dir, recompute the tree hash and compare with the hash recorded when it was first materialized; on mismatch re-materialize and report tampering.

## install from a local folder source (live link)
Entry: D:/DevProjects/private/agentpm/packages/core/src/service.ts:4298 (prepareContentForEntry, contentKind === 'local'), reached from SVC:727
Steps:
  - classifySource (SVC:3272-3296): anything not recognised as git/registry is 'local'; an 'owner/repo' shorthand is ALSO treated as local when that relative path exists under cwd (SVC:3274-3278).
  - prepareContentForEntry returns repoRoot = the local folder itself; nothing is copied or snapshotted (SVC:4298-4311).
  - inspectRepository on the folder; adapter mapping; linkTarget = <local folder>/<entry path> (SVC:809-812).
  - relinkManagedContent links the agent dir directly to the live folder (SVC:816).
  - installedRevision = computeTreeSignature(sha1) of the subtree at install time (SVC:818-824).
  - Update check: previewLocalInstallUpdate (SVC:4722-4747) recomputes the signature and reports 'Live local folder install; detailed diff is not available.'
Existing checks:
  - sha1 tree signature recorded at install and compared on 'agentpm update' (with the walkFiles blind spots).
  - Same link-replacement guards as the core pipeline.
Gaps:
  - Mutable target by design: any change in the source folder is live in the agent immediately, with no update step and therefore no gate. The folder can be a network share, a synced folder or another user's writable path.
  - The stored signature is only consulted by 'update'; doctor does not compare it (SVC:2932-3015).
  - owner/repo-vs-local-path ambiguity (SVC:3274-3278): a directory named like a GitHub shorthand in cwd silently changes the source of truth from GitHub to local content.
  - No diff on update for local installs (diff: [] at SVC:4740), so even the path-level change list is missing.
Hook points:
  - Same PRIMARY GATE at D:/DevProjects/private/agentpm/packages/core/src/service.ts:808-815.
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:4298-4311: policy option 'snapshot local sources' (copy the scanned subtree into a content-addressed dir under the cache/library and link to that) so scanned bytes == linked bytes; keep live-link as an explicit opt-in (e.g. --link-live) flagged as an accepted risk in the install record.
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:2932 (doctor per-install loop): add 'content-drift' (tree hash differs from recorded) and 'scan-stale' (ruleset version older than current) issues; same check can back a new 'agentpm audit/verify' command.

## install from a static registry index (entries with 'repo')
Entry: D:/DevProjects/private/agentpm/packages/core/src/service.ts:3100 (reindexSource) -> D:/DevProjects/private/agentpm/packages/registry/src/index.ts:299 (loadRegistryIndex)
Steps:
  - addSource/refresh/update --refresh -> reindexSource -> loadRegistryIndex -> readRegistryLocator (REG:307-320): local file, or httpGet (REG:122-182) over http or https with Bearer token from AGENTPM_REGISTRY_TOKEN_<HOST>, AGENTPM_REGISTRY_TOKEN, or stored per-origin credential (REG:283-297); up to 5 redirects.
  - parseRegistryContent (REG:93-120): JSON.parse or js-yaml load; coerceEntry (REG:26-76) validates field types, requires repo or archive, validates kind/target enums.
  - catalogEntriesFromRegistry (SVC:3133-3180): repo resolved via resolveRegistryRepo (SVC:4846-4856: absolute URL/ssh kept; otherwise relative to the index URL or index file directory); ref and path from the index are stored in catalog_entries.
  - install <name> resolves the catalog entry (SVC:4140-4173) and continues in the core git pipeline with entry.repo, entry.ref (SVC:4294-4295) and entry.path as sparse path.
Existing checks:
  - Shape validation of index entries; duplicate catalog id detection (SVC:3153-3157).
  - Authorization header is stripped on cross-origin redirects (REG:149-158).
  - Credentials file written with mode 0600 (REG:235-239).
Gaps:
  - The index is unauthenticated data: no signature, no per-entry integrity (no commit SHA / tree hash field in RegistryIndexEntry SHR:145-157). 'ref' is normally a mutable branch or tag. Whoever controls the index (or the path to it) decides which repo and ref a name resolves to, and can repoint it between two installs/updates.
  - Plain http: is accepted for any host, not only localhost (REG:129), so index and archive are MITM-able; no response size cap and no timeout (REG:162-176).
  - 'repo' is accepted verbatim: any scheme, file:// or a path relative to the index location, and strings starting with '-' (see git option-injection gap).
  - Name-only install searches all sources (SVC:4145-4152); a public source can shadow a private skill name (dependency-confusion pattern). Multiple matches do prompt/error, but a single match from an unexpected source is installed silently.
Hook points:
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:3103-3105 (after loadRegistryIndex, before replaceCatalogEntries): validate locators (scheme allow-list, reject leading '-', flag http:), store a digest of the index in sources.metadata and report entries whose repo/ref/archive changed since the last index (repoint detection).
  - D:/DevProjects/private/agentpm/packages/shared/src/index.ts:145 + D:/DevProjects/private/agentpm/packages/registry/src/index.ts:26-76: add optional 'revision' (full commit SHA) and 'integrity' (tree sha256) fields to index entries so a static index can pin content; verify them in the gate.
  - Content gate remains D:/DevProjects/private/agentpm/packages/core/src/service.ts:808-815.

## install from a registry-server archive (JSON skill archive)
Entry: D:/DevProjects/private/agentpm/packages/core/src/service.ts:4338 (prepareArchiveContent), reached from SVC:4290
Steps:
  - Catalog entry has metadata.archive === true and entry.repo = absolute archive URL (index entries are root-relative '/v1/skills/<name>/versions/<version>/archive', SRV:295, resolved against the index URL SVC:4851-4852).
  - fetchSkillArchive(url) (REG:322-343): httpGet with getRegistryHeaders(url) (token selection by the ARCHIVE url), or read a local file; JSON.parse; validateSkillArchive (SHR:200-280).
  - SVC:4344 revision = sha256(raw); cacheKey = makeId('cache','archive',sourceId,name); releasePath = cache/repos/<key16>/r/<revision[0:12]>; rootDir = releasePath/skills/<archive.name> for skill/subagent, else releasePath/<archive.name>.
  - SVC:4353-4356: if rootDir does not exist -> rm releasePath, materializeArchive(archive, rootDir) (FS:222-245: assertSafeArchivePath again, path.relative containment, writeFile, chmod 0755 when executable and not win32). If it exists it is reused unverified.
  - SVC:4358 inspectRepository(releasePath, url, 'local'); saveCacheRepo with metadata {archive, archiveVersion, archiveKind}.
  - Back in install(): mapping, link into agent dir (SVC:816), saveInstall with contentKind 'local', contentLocator = archive URL, installedRevision = sha256(raw), metadata {archive:true, archiveVersion} (SVC:859-865).
Existing checks:
  - assertSafeArchivePath (SHR:186-198): rejects empty, leading '/', drive letters, '.', '..', and segments containing backslash, ':' or NUL.
  - validateSkillArchive (SHR:200-280): formatVersion, name /^[a-z0-9][a-z0-9._-]*$/i, version charset (no separators), kind/target enums, non-empty files, duplicate path rejection (case-sensitive), encoding enum.
  - materializeArchive re-asserts each path and verifies containment with path.relative (FS:229-234). The format cannot express symlinks, so archive installs are symlink-free.
  - Server side (context): 64 MiB body cap (SRV:31), re-publishing an existing version returns 409 (SRV:441-446), sha256 checksum stored per version (SRV:464-484).
Gaps:
  - The client never verifies a checksum. /index.json carries no checksum (SRV:290-300), the client never calls GET /v1/skills/:name where versions[].checksum is exposed (SRV:394-397), and sha256(raw) at SVC:4344 is only trust-on-first-use. Version immutability is server policy; a compromised or malicious registry (or an http MITM) can serve different bytes for the same name+version and the client has nothing to compare against. Cheap win: the server checksum is sha256 of the exact serialized file it serves (SRV:464-475), which is what the client already hashes.
  - Token leak: fetchSkillArchive picks credentials by the archive URL; the global AGENTPM_REGISTRY_TOKEN env value is sent to ANY host (REG:287-296). A malicious index can list an absolute archive URL on an attacker host and harvest the token. Only the stored credential is origin-scoped; redirect stripping does not help because this is a first request, not a redirect.
  - No client-side resource limits: response size, file count, per-file/total bytes, path length/depth. No Windows reserved names (CON, NUL, AUX, COMn), trailing dot/space, or case-fold/Unicode-normalization duplicate detection; on NTFS/APFS 'SKILL.md' and 'skill.md' collapse and the last write wins, so what a server-side scanner judged can differ from what lands on disk.
  - archive.name/kind/target are not cross-checked against the catalog entry (name, archiveKind): the index can advertise a harmless skill 'x' while the archive is a plugin 'y'.
  - executable flag is honoured silently (FS:241-243).
  - Existing rootDir is reused without re-verification (SVC:4353) -> same mutable-cache problem; the release dir name is only 12 hex chars of the sha256.
  - Pinning is ineffective for archives: installedRevision (sha256) is written to agentpm.yaml as 'revision' but prepareArchiveContent ignores overrides.revision, so sync always installs whatever the index currently serves.
Hook points:
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:4343-4344 - right after fetch: (1) compare sha256(raw) with the expected checksum from the index entry (new 'sha256'/'integrity' field: SHR:145, REG:62-75, SRV:290-300) and with lock data when syncing/pinned; (2) scan the IN-MEMORY archive (scanSkillFiles(filesFromArchive(archive))) BEFORE materializeArchive at SVC:4355 so blocked content never touches disk.
  - D:/DevProjects/private/agentpm/packages/shared/src/index.ts:200-280 (validateSkillArchive): add structural limits, case-fold/NFC duplicate detection and reserved-name checks once; both the client and the registry server (SRV:410) get them.
  - D:/DevProjects/private/agentpm/packages/registry/src/index.ts:283-297 + :322-328: only attach a token when the archive URL origin equals the registry source origin (pass the source origin into fetchSkillArchive).
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:4341-4352: assert archive.name === entry.name and archive.kind === entry.metadata.archiveKind.
  - Then the common PRIMARY GATE at D:/DevProjects/private/agentpm/packages/core/src/service.ts:808-815 (on-disk tree, final verdict, persistence).

## plugin install (Claude Code / Codex plugins, managed marketplace)
Entry: D:/DevProjects/private/agentpm/packages/adapters/src/index.ts:205 (detectPluginGroupsForMarker) and D:/DevProjects/private/agentpm/packages/core/src/service.ts:874 (plugin branch of install)
Steps:
  - Detection: any '<dir>/.claude-plugin/plugin.json' or '<dir>/.codex-plugin/plugin.json' marks a plugin root (ADP:212-220); marketplace manifests ('.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json', 'api_marketplace.json') add plugins by relative source path (ADP:224-249). Name = safePluginName(manifest.name) or dir basename (ADP:173-177).
  - A plugin at the repo root forces a full checkout (SVC:4316-4324); nested plugins use their subtree as sparse path.
  - Mapping: targetRelativePath = .agentpm/plugins/<claude|codex>/plugins/<safeName> (ADP:506-516, ADP:133-138); link created at SVC:816.
  - syncPluginMarketplace (SVC:4623-4720): lists dirs under plugins/, reads each plugin.json, copies description/version into a generated marketplace.json (Claude: .claude-plugin/marketplace.json; Codex: .agents/plugins/marketplace.json with policy installation AVAILABLE / authentication ON_INSTALL).
  - SVC:883-890 prints the host commands ('claude plugin marketplace add <root>' / 'claude plugin install <name>@<marketplace>'); AgentPM itself does not enable the plugin.
  - Update: applyUpdatePreviews re-syncs affected marketplaces (SVC:1133-1153).
Existing checks:
  - SAFE_PLUGIN_NAME /^[a-z0-9][a-z0-9._-]*$/i enforced at detection and again at install (ADP:168-177, ADP:507-509).
  - Marketplace plugin source must be a string/object path that starts with '.' (ADP:190-203); non-local sources are ignored.
  - Install ids include the adapter so Claude and Codex variants do not overwrite each other (SVC:829-836).
Gaps:
  - Plugins are the highest-capability entry kind and nothing inside them is inspected: hooks (hooks/hooks.json -> shell commands on agent events), .mcp.json / mcpServers (arbitrary local commands such as 'npx -y pkg@latest', or remote http/sse URLs = permanently mutable tool descriptions), commands/*.md (allowed-tools frontmatter), agents/*.md, bin/, LSP configs.
  - Marketplace source containment: '../../..' also starts with '.', so pluginRoot = path.resolve(root, source) (ADP:241) can point outside the repository; only existence is checked. relativePath becomes '../..' and linkTarget = path.join(repoRoot, '../..') (SVC:809-812), linking an arbitrary existing local directory as a plugin. Code-derived, untested.
  - plugin.json 'description' and 'version' are copied verbatim from third-party content into a manifest the host agent reads (SVC:4656-4710): an injection surface with no length limit, control-char or hidden-Unicode filtering.
  - A root-level plugin links the entire release checkout, including its .git directory, into the plugin root.
Hook points:
  - PRIMARY GATE at D:/DevProjects/private/agentpm/packages/core/src/service.ts:808-815 with a kind-aware ruleset: for kind 'plugin' parse plugin.json, hooks/hooks.json, .mcp.json, commands/ and agents/ frontmatter and emit capabilities (hook:<event>, mcp:stdio:<command>, mcp:remote:<host>, exec:<script>) so new capabilities can be diffed on update.
  - D:/DevProjects/private/agentpm/packages/adapters/src/index.ts:241: require isWithinDirectory(rootPath, pluginRoot) (helper exists at FS:252) before accepting a marketplace-listed plugin.
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:4656-4674: sanitize/limit description and version before writing marketplace.json (or take them from the scan report).
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:1149-1153: re-sync only after the update gate passed.

## update / diff (git, archive and local installs; also 'skills update')
Entry: D:/DevProjects/private/agentpm/apps/cli/src/index.ts:1495 (update) and :1020 (skills update) -> D:/DevProjects/private/agentpm/packages/core/src/service.ts:997 (previewUpdates) and :1076 (applyUpdatePreviews)
Steps:
  - CLI:1504-1512 optional --refresh (reindex all sources), then service.previewUpdates({names}).
  - Archive installs: previewArchiveInstallUpdate (SVC:4749-4843) reindexes the registry source, picks the catalog entry by name, downloads and materializes the latest archive, compares sha256 with installedRevision, runs adapter.update and diffTrees.
  - Local installs: previewLocalInstallUpdate (SVC:4722-4747) compares sha1 tree signatures; no diff.
  - Git installs: resolveGitRevision(contentLocator, contentRef ?? HEAD) (SVC:1013-1017); if it differs, prepareGitCandidateFromInstall (SVC:4388-4436) materializes the new revision (sparse path = the install's sourceRelativePath only), adapter.update -> risk safe|remap|breaking (ADP:570-601), diffTrees lists added/removed/changed paths (SVC:1043-1046).
  - CLI prints previews (CLI:1525); with --json and no --yes it returns {applied:false, requiresConfirmation} (CLI:1514-1523); otherwise one confirm 'Do you want to update these skills?' (CLI:1540-1552) unless --yes.
  - service.update({apply:true}) RE-RUNS previewUpdates (SVC:1067-1073), then applyUpdatePreviews: confirm only for remap/breaking layout risk (SVC:1086-1098), removeManagedLink + ensureManagedLink to the new release (SVC:1101-1105), saveInstall with new installedRevision (SVC:1125-1131), plugin marketplace re-sync.
Existing checks:
  - Layout-migration risk classification with confirmation for remap/breaking (skipped by --yes).
  - Path-level diff (added/removed/changed) shown to the user for git and archive installs.
  - JSON dry-run convention (requiresConfirmation) when --json is used without --yes.
Gaps:
  - TOCTOU between preview and apply: the revision the user saw and confirmed (first previewUpdates) is not the revision that is applied; apply re-resolves the ref and re-downloads the archive (SVC:1068). A push between the two calls is applied unseen.
  - No capability/content diff: 'changed: SKILL.md' does not tell the user that the new version adds a remote fetch instruction, a new URL host, a hook, an MCP server or an executable. diffTrees is blind to symlinks and ignored directories and uses sha1.
  - Updates always float: contentRef holds the branch/tag (or null -> HEAD) even for installs created from a pinned revision (SVC:855), so 'update' silently unpins. agentpm.yaml is not rewritten after update (no updateExistingProjectConfig call in SVC:1076-1156), so the lock goes stale.
  - --yes applies everything including 'breaking' layouts; there is no security tier.
  - The previous version's release dir stays in the cache and is never compared semantically with the new one (the data for a delta is available: install.linkTarget vs nextLinkTarget).
Hook points:
  - SCAN CANDIDATE - D:/DevProjects/private/agentpm/packages/core/src/service.ts:1038-1058 (git) and :4822-4842 (archive): after the candidate is materialized, scan nextLinkTarget, load the previous report (from the install record, or rescan install.linkTarget), compute capabilityDelta, and attach security {verdict, treeSha256, newFindings, newCapabilities} to UpdatePreview (SHR:377).
  - GATE - D:/DevProjects/private/agentpm/packages/core/src/service.ts:1086 (before removeManagedLink at :1101): block on verdict 'block'; require confirmation when new capabilities/high findings appear even if layout risk is 'safe'; unchanged-capability updates can pass with a warning.
  - CLOSE TOCTOU - D:/DevProjects/private/agentpm/packages/core/src/service.ts:1067-1073: let apply consume the previews the user saw (or pass candidateRevision + treeSha256 back in and refuse if the re-resolved value differs).
  - PERSIST - D:/DevProjects/private/agentpm/packages/core/src/service.ts:1125-1131: write new treeSha256/verdict/capabilities and refresh agentpm.yaml/agentpm.lock.
  - CLI printers: D:/DevProjects/private/agentpm/apps/cli/src/index.ts:1525 (printUpdates) and the JSON payloads at :1514-1566 should include the security section.

## sync (agentpm.yaml contract with ref/revision)
Entry: D:/DevProjects/private/agentpm/apps/cli/src/index.ts:1902 -> D:/DevProjects/private/agentpm/packages/core/src/service.ts:1356 (syncManifest)
Steps:
  - loadProjectConfig (CFG:527-576): parse agentpm.yaml, merge .agentpmrc as a local override; normalizeSkillSpec (CFG:263-308) validates types only.
  - ensureConfiguredSources (SVC:3354-3371): every source locator in the YAML that is unknown is added via addSource -> immediate clone/index fetch + catalog indexing.
  - For each skill spec: resolve the source binding, then this.install([], { from, scope, workspaceRoot, skills: items, ref, revision, target, yes: true, updateProjectConfig: false }) (SVC:1387-1397).
  - install() runs the core pipeline; with a hex revision the checkout is fetch-by-SHA (GIT:196-208); archives and local sources ignore revision.
Existing checks:
  - YAML shape/type validation; target/adapter conflict detection (CFG:283-289).
  - A full hex 'revision' pins git content by commit SHA.
Gaps:
  - Highest-risk entry point: sync hard-codes yes:true and has no prompt or flag at all (CLI:1902-1913). Cloning an untrusted project and running 'agentpm sync' (or an agent doing so) clones arbitrary sources and links their skills into agent directories with zero interaction and zero inspection.
  - 'revision' and 'ref' are unvalidated free strings (CFG:297-298). A non-hex revision (e.g. 'main') silently degrades to a floating HEAD checkout (GIT:196-219) that is cached forever under r/<revision[0:12]> and reused (GIT:173). A revision containing path separators or '..' flows into path.join in resolveReleasePath (GIT:52-54) -> cache-path escape, and the 'exists -> reuse' short-circuit then treats an arbitrary existing local directory as the release. Code-derived, untested.
  - 'workspaceRoot' from the committed YAML is used verbatim as scopeRoot (CFG:805, SVC:1390): a repository can direct links into another directory, e.g. the user's home agent dirs.
  - Lock strength: git = commit SHA only (no subtree hash, SHA-1 object ids); archive = sha256 recorded but never enforced; local = sha1 signature recorded but never enforced. There is no recorded scan verdict or accepted-capabilities list, so a teammate cannot tell whether what they sync was ever reviewed.
  - Sources listed in YAML are cloned and indexed before any per-skill decision, so merely having a malicious source locator triggers git network operations (relevant to the git hardening gap).
Hook points:
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:1369-1399: make sync lock-driven. For each spec look up the lock entry (integrity + rulesetVersion + accepted capabilities); pass it into install() so the PRIMARY GATE (SVC:808-815) can (a) verify computed treeSha256 === lock integrity -> allow without prompting, (b) on mismatch or missing lock: TTY -> show report and confirm, non-TTY/--json -> fail closed with a structured error. Replace the blanket yes:true with separate fields (yes for UX prompts, a security policy/acceptance for the gate).
  - D:/DevProjects/private/agentpm/packages/config/src/index.ts:297-298 and :401-405: validate revision as full 40/64-hex (or archive 'sha256:<hex>') and ref against a safe ref charset; reject leading '-'.
  - D:/DevProjects/private/agentpm/packages/config/src/index.ts:791-806 / D:/DevProjects/private/agentpm/packages/core/src/service.ts:1390: constrain workspaceRoot from committed config to the project tree (or require confirmation when it resolves outside cwd).
  - D:/DevProjects/private/agentpm/packages/git/src/index.ts:52-54: derive the release dir from a validated hex revision only.

## pull (canonical skills repo -> shared library -> fan-out to all agents)
Entry: D:/DevProjects/private/agentpm/apps/cli/src/index.ts:1743 -> D:/DevProjects/private/agentpm/packages/core/src/service.ts:2376 (pull)
Steps:
  - resolvePushTarget (SVC:1473) from --from / project / global config; registry targets are rejected (SVC:2380-2384).
  - preparePushTargetRepository (SVC:2040-2082): persistent FULL working clone at cache/repos/<key>/worktree ('git clone --quiet <url> <path>', with checkout); on later runs reset --hard, clean -fd, fetch --prune, pull --ff-only, each with errors swallowed (.catch(() => {})).
  - rev-parse HEAD -> revision (SVC:2392-2399); inspectRepository; all kind==='skill' entries are selected unless names were given (SVC:2402-2415).
  - chooseAgentTargets (SVC:2208-2237): explicit --target, else detected agents (.codex/.claude/.agents), all of them when --yes or no TTY. Default scope is GLOBAL (home dir) (SVC:2386-2387).
  - Per skill: computeTreeSignature(incoming) vs library copy (SVC:2463-2467); unchanged and already linked -> skipped; changed -> copyTreeInto(sourceSkillPath, <AGENTPM_HOME>/skills/<name>) which rm -rf's the library entry and copies regular files (SVC:2182-2191, SVC:2485-2489).
  - linkSkillIntoAgents (SVC:2286-2374): for each agent link <scopeRoot>/<native skill root>/<name> -> library entry; pre-existing unmanaged dir -> confirm or skip; saveInstall per agent with installedRevision = contentRef = HEAD SHA, metadata {library:true}.
Existing checks:
  - Unchanged content is skipped by sha1 tree signature.
  - Unmanaged existing directories are never clobbered silently (confirm, or skip with a warning under --yes).
  - copyTreeInto uses walkFiles, so symlinks and node_modules/dist/.git are dropped as a side effect; the library copy is symlink-free.
Gaps:
  - Blast radius: defaults are ALL skills, ALL detected agents, GLOBAL scope. One bad or compromised commit in the canonical repo lands in ~/.claude, ~/.codex and ~/.agents on the next pull, with no preview, diff or confirmation of changed content; the library entry is overwritten in place.
  - Always the default-branch HEAD; no ref/revision pinning for pull.
  - fetch/pull failures are swallowed, so pull can silently operate on a stale or half-updated worktree; full clone with checkout means LFS smudge filters and (on POSIX) symlinks are materialized in the worktree before anything is inspected.
  - The library is one mutable shared directory per skill name: no versions, no rollback, no recorded tree hash (install records store the repo HEAD SHA, which changes for unrelated commits), so later tampering of ~/.agentpm/skills/<name> is undetectable.
  - Name collisions between a pulled skill and an adopted/unrelated library skill of the same name overwrite the library entry (only adopt has a different-content guard).
Hook points:
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:2485 (inside 'if (contentChanged)', before copyTreeInto at :2487): scan sourceSkillPath, compare with the previous report for the library entry, gate (block/confirm/warn). Scanning only when content changed keeps pull fast; when unchanged, verify the recorded treeSha256 of the library entry instead.
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:2346-2368 (saveInstall in linkSkillIntoAgents): persist treeSha256 + verdict per agent install; consider a content-addressed library layout (skills/<name>/<treeSha256>/) so links point at immutable versions and rollback is possible.
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:2057-2079: apply the same git hardening helper; stop swallowing fetch/pull errors (or surface them as warnings in PullResult).
  - CLI JSON/TTY handling at D:/DevProjects/private/agentpm/apps/cli/src/index.ts:1767-1804: PullResult needs blocked[] / requiresConfirmation[] lists so --json callers see which skills were held back.

## adopt (bring an existing local skill under management and fan it out)
Entry: D:/DevProjects/private/agentpm/apps/cli/src/index.ts:1814 -> D:/DevProjects/private/agentpm/packages/core/src/service.ts:2520 (adopt)
Steps:
  - Resolve token as a directory/symlink path or as a skill name found by inspectRepository(cwd) (SVC:2526-2553); resolveNativeScope derives scopeRoot and origin adapter from the path (SVC:2243-2279).
  - If the library already has <name>: compare sha1 signatures; different content -> confirm or abort (SVC:2587-2615); else copyTreeInto(contentPath, library/<name>) (SVC:2617-2618).
  - Replace the original directory with a managed link to the library (rm -rf + ensureManagedLink, SVC:2623-2626).
  - ensureSource('local', skillsLibraryDir); revision = computeTreeSignature(library) (SVC:2628-2633); chooseAgentTargets; linkSkillIntoAgents into origin agent + selected agents (SVC:2649-2662).
Existing checks:
  - Abort/confirm when a different skill with the same name already exists in the library.
  - Self-link guard when the origin already is the library entry (SVC:2562-2582).
  - Unmanaged target directories are confirmed or skipped.
Gaps:
  - Adopt is a trust-escalation step: content of unknown provenance that lived in one agent dir (possibly hand-copied from the internet, or installed by another tool) is fanned out to all agents, and from the library it becomes a default candidate for 'agentpm push' / 'registry publish'. No inspection happens.
  - copyTreeInto drops symlinks and ignored directories, then the ORIGINAL is deleted (SVC:2624): silent content loss, and the adopted tree differs from what the user had.
  - Path token is not constrained to the workspace; resolveNativeScope falls back to dirname(dirname(path)) for unknown layouts.
Hook points:
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:2584 (after origin resolution, before the library copy at :2618 and before the destructive rm at :2624): scan contentPath; policy here can be 'warn + record' by default (user-owned content) but must still block critical findings (e.g. symlink escapes, hidden-Unicode instructions) and must record treeSha256 + verdict so the later publish gate and update deltas have a baseline.
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:2649-2662: persist scan data through linkSkillIntoAgents (shared with pull).

## skills.sh provider bridge ('agentpm skills search/install/update', shells out to 'npx skills')
Entry: D:/DevProjects/private/agentpm/apps/cli/src/index.ts:896 (skills install) -> D:/DevProjects/private/agentpm/packages/core/src/service.ts:626 (installProviderSkill); search at D:/DevProjects/private/agentpm/packages/core/src/provider-bridge.ts:234
Steps:
  - Search: runSkillsCli(['find', query]) (BRIDGE:142-177) executes 'npx skills find <query>' (on win32: cmd.exe /d /s /c npx skills find <query>) with DISABLE_TELEMETRY=1, NO_COLOR=1, 10 MB buffer; stdout (or the error's stdout) is ANSI-stripped and parsed with a regex into owner/repo@skill selectors (BRIDGE:179-232).
  - Install: resolveProviderInstallInput (BRIDGE:281-318): selector 'owner/repo@skill' -> installLocator 'github:owner/repo' + skills [skill]; a free-text query runs a search and an interactive picker (SVC:635-661).
  - The actual content fetch does NOT go through npx: installProviderSkill calls this.install([], { from: installLocator, skills, ... }) (SVC:671-676), i.e. the core git pipeline (clone into cache, link).
  - Install records are tagged with provider metadata (SVC:677-691) and agentpm.yaml gets provider/selector (SVC:1561-1568); 'skills update' reuses previewUpdates/applyUpdatePreviews (SVC:707-721).
Existing checks:
  - Only the 'find' subcommand of the external CLI is used; arguments are passed as an argv array (no shell string on POSIX).
  - Provider output is ANSI-stripped and must match a strict selector regex, else an error is raised.
  - Content installation reuses the normal AgentPM pipeline, so one gate at SVC:808 covers skills.sh installs too.
Gaps:
  - 'npx skills' is itself an unpinned mutable target: no version, resolved from the npm registry (or a local/project 'skills' bin if one exists in cwd's node_modules/.bin) and executed with the user's full environment, including AGENTPM_REGISTRY_TOKEN* and cloud credentials. In non-interactive contexts npx installs without asking.
  - On Windows the query is routed through cmd.exe /c; metacharacter handling relies on Node's argv quoting, which does not neutralize cmd.exe parsing of quotes/carets. The query is user input, but in agent-driven use it may originate from untrusted text. Low/medium confidence, untested.
  - Public catalogue = lowest-trust source, installed always from the default-branch HEAD of owner/repo with no pin; popularity text ('installs') is provider-controlled and not a trust signal.
  - Error path returns the child's stdout as if it were a successful result (BRIDGE:163-170).
Hook points:
  - Content gate: inherited PRIMARY GATE at D:/DevProjects/private/agentpm/packages/core/src/service.ts:808-815; SVC:671 can pass a stricter default policy for provider installs (e.g. policy 'strict' and mandatory confirmation, never satisfied by --yes alone).
  - D:/DevProjects/private/agentpm/packages/core/src/provider-bridge.ts:142-160: pin the bridge package ('npx --yes skills@<exact version>' from a constant), pass a minimal env allow-list (PATH, HOME/USERPROFILE, proxy vars) instead of the whole process env, and validate the query charset before the cmd.exe path.
  - D:/DevProjects/private/agentpm/packages/core/src/service.ts:677-691: record the resolved commit SHA + treeSha256 so provider installs are pinned in agentpm.yaml/lock.

## source add / refresh / inspect / source skills (content enters the machine for indexing, nothing is linked)
Entry: D:/DevProjects/private/agentpm/packages/core/src/service.ts:338 (addSource), :500 (refreshSources), :542 (inspect), :367 (listSourceEntries) -> :3684 (prepareInspectionTarget)
Steps:
  - classifySource + normalizeLocator; source row upserted (SVC:338-359).
  - Git sources: prepareGitContent with requireFullCheckout (SVC:3706-3710) -> full (non-sparse) checkout into the persistent cache, or a temporary release under os.tmpdir()/agentpm-inspect-* when an active sparse install must not be disturbed (SVC:3832-3855, GIT:226-240), cleaned up afterwards (GIT:252-257).
  - Local sources: inspected in place. Registry sources: index downloaded and parsed (SVC:3102-3107).
  - inspectRepository builds the report; catalog entries replace the previous ones (SVC:3117-3122). 'agentpm inspect' prints trust, scripts and warnings (CLI:368-430).
Existing checks:
  - Install-script detection and trust score are surfaced here (and only here).
  - Temporary releases are removed after inspection.
Gaps:
  - Git network + checkout happens for any locator handed to these commands, including locators auto-added from agentpm.yaml by sync/resolve (SVC:3354-3371, SVC:2678-2680) - relevant for git hardening.
  - Trust score is superficial (host is github.com, scripts present) and gives a 'trusted 100/100' label to any public GitHub repo without install scripts (ADP:630-667), which is actively misleading once a real scanner exists.
  - No content-level information is shown to the user before they pick a skill.
Hook points:
  - D:/DevProjects/private/agentpm/packages/adapters/src/index.ts:669-710 or the callers at D:/DevProjects/private/agentpm/packages/core/src/service.ts:3692 / :3877: add a per-entry security summary (verdict + top findings + capabilities) to InspectionReport; replace or feed calculateTrust with scanner output.
  - D:/DevProjects/private/agentpm/apps/cli/src/index.ts:368-430 (inspect printer): render findings; add a dedicated 'agentpm scan <path|locator|install-name>' command that reuses the same report (JSON with --json).

## DATA MODEL
- Path abbreviations used below (all absolute): SVC = D:/DevProjects/private/agentpm/packages/core/src/service.ts; CLI = D:/DevProjects/private/agentpm/apps/cli/src/index.ts; GIT = D:/DevProjects/private/agentpm/packages/git/src/index.ts; FS = D:/DevProjects/private/agentpm/packages/fs/src/index.ts; ADP = D:/DevProjects/private/agentpm/packages/adapters/src/index.ts; REG = D:/DevProjects/private/agentpm/packages/registry/src/index.ts; SHR = D:/DevProjects/private/agentpm/packages/shared/src/index.ts; DB = D:/DevProjects/private/agentpm/packages/db/src/index.ts; CFG = D:/DevProjects/private/agentpm/packages/config/src/index.ts; BRIDGE = D:/DevProjects/private/agentpm/packages/core/src/provider-bridge.ts; UI = D:/DevProjects/private/agentpm/packages/ui/src/index.tsx; SRV = D:/DevProjects/private/agentpm/packages/registry-server/src/server.ts. All findings are from reading the working tree (service.ts has uncommitted local modifications); nothing was executed, so items marked 'code-derived, untested' are medium confidence.
- Core architectural fact for the mutable-target worry: installs are never copies. The agent dir entry (e.g. <scope>/.claude/skills/<name>) is a junction (win32) or dir symlink (FS:138-139) pointing INTO AgentPM storage: git -> <AGENTPM_HOME>/cache/repos/<key16>/r/<rev12>/<path>; archive -> same layout under an archive cache key; local source -> the live source folder itself (SVC:4298-4311); pull/adopt -> the shared mutable library <AGENTPM_HOME>/skills/<name>. So 'what was scanned' and 'what the agent reads later' are only the same bytes if the link target is immutable or re-verified. Today nothing re-verifies it.
- InstallRecord (SHR:57-79) / installs table (DB:163-185): id, name, source_id, catalog_entry_id, adapter, scope, scope_root, target_path (unique), link_target, source_relative_path, source_root_relative_path, selected_items_json, content_kind ('git'|'local'; archives are 'local' + metadata.archive=true), content_locator, content_ref, cache_key, installed_revision, layout_signature, metadata_json, timestamps. installed_revision is overloaded: git commit SHA (git installs, pull), sha256 of the raw archive JSON (archive installs, SVC:4344), sha1 tree signature (local installs SVC:818-824, adopt SVC:2633). There is NO content tree hash for git installs and no scan data anywhere.
- metadata_json is free-form, so a first iteration can store security data without a migration: installs.metadata_json.security = { treeSha256, rulesetVersion, verdict, capabilities[], findingFingerprints[], acceptedFingerprints[], acceptedAt, scannedAt }. DB.migrate() (DB:120-190) is only 'create table if not exists' with no schema_version table, so new columns need a guarded 'alter table add column' (PRAGMA table_info) helper; a cleaner option is a new table security_scans(tree_sha256, ruleset_version, kind, verdict, findings_json, capabilities_json, scanned_at, primary key(tree_sha256, ruleset_version)) so identical trees are scanned once and results are shared across installs/agents. cache_repos.metadata_json can hold per-release integrity (releases[rev] = treeSha256) to verify cache reuse at GIT:173 / SVC:4353.
- computeTreeSignature (FS:72-81) is not suitable as a security integrity hash as-is: SHA-1; path and content are concatenated with no length prefix or separator (ambiguous encoding); it is built on walkFiles (FS:46-70), which silently skips symlinks (Dirent.isFile()/isDirectory() are false for links) and skips any directory named .git, node_modules, .turbo or dist (FS:13). Those skipped things remain reachable by the agent through the link. diffTrees (FS:94) and detectInstallScripts (ADP:771) inherit the same blind spots. A scanner needs its own lstat-based walker with no ignore list (or treat ignored dirs/symlinks as findings) and a sha256 over sorted, length-prefixed (path, mode, content) tuples with NFC + case-fold collision detection.
- agentpm.yaml lock data today: ManifestInstallSpec (SHR:288-300) carries ref and revision as free strings; install writes ref=contentRef and revision=installedRevision back via installRecordToManifestSpec (SVC:1545-1570) and upsertProjectConfigInstalls (CFG:587-620). Adding integrity/verdict fields requires touching every whitelist: SHR:288 ManifestInstallSpec, SHR:320 ProjectSkillObjectSpec, CFG:263 normalizeSkillSpec, CFG:401 legacy installs parser, CFG:446 isSimpleProjectInstall (otherwise entries collapse to a bare string and drop the lock), CFG:460 manifestInstallToProjectSkillSpec, SVC:1297 initManifest, SVC:1545 installRecordToManifestSpec. Because the YAML is human-edited and rewritten wholesale, a separate committed agentpm.lock (name -> {source, revision, integrity: sha256-..., rulesetVersion, capabilities[], acceptedFindings[]}) is the lower-risk design; sync then verifies integrity and accepted capabilities instead of prompting.
- applyUpdatePreviews (SVC:1076-1156) updates the DB but never calls updateExistingProjectConfig, so after 'agentpm update' the revision in agentpm.yaml is stale and the next 'sync' re-pins the old revision. Any lock/integrity design must also be written on update (SVC:1125).
- InspectionReport (SHR:118-129) already has trust {trusted, score, reasons}, scripts[], warnings[]. They are computed in ADP:630-710 but never read by install/update/sync/pull; they are only printed by 'agentpm inspect' (CLI:368-430). This is the natural carrier for a repo-level security summary (add optional security?: ScanSummary) for inspect, 'source skills' and pickers. UpdatePreview (SHR:377-387) is the carrier for a capability delta on update (add security?: { verdict, treeSha256, newFindings, newCapabilities }).
- Prompt API (SHR:511-534): confirm?(message, details[]) -> Promise<boolean>; selectOne/selectMany/input/isInteractive. The CLI implementation (UI:265-283, UI:369-377) THROWS AgentPmError('Interactive confirmation requires a TTY.') when stdin/stdout are not TTYs, so with the real CLI a confirm in a non-interactive run fails closed. Service code calls this.prompts.confirm?.(...); when prompts is {} (library/tests, SVC:286) the result is undefined -> falsy. Existing fail-open exception: ensureGitignored adds the entry when there is no confirm (SVC:3633-3635). Status messages go to stderr via onStatus (CLI:788-794) so stdout stays valid JSON.
- Existing non-interactive convention to mirror: 'update --json' without --yes returns { applied:false, requiresConfirmation:true, preview } and exits 0 without applying (CLI:1514-1523, CLI:1034-1041). 'doctor --fix --json' does the same (CLI:1972). --yes today means 'skip every prompt' (source-add confirm SVC:3741, candidate picker SVC:980, gitignore SVC:3624, layout remap/breaking confirm SVC:1086-1098, agent selection SVC:2221, replace-unmanaged-dir confirm SVC:2314). sync hard-codes yes:true (SVC:1395) and the sync CLI command has no flags except --json (CLI:1902).
- RegistryIndexEntry (SHR:145-157) has no checksum/integrity/commit field. The registry server computes and stores sha256 per version (SRV:464-484) and exposes it only in GET /v1/skills/:name versions[] (SRV:394-397) and the publish response, not in /index.json (SRV:290-300). The client never fetches or compares it; SVC:4344 sha256(raw) is a purely local identity.
- Package dependency direction: shared <- fs <- adapters/git/registry/config <- core <- cli; registry-server depends ONLY on @agentpm/shared and node builtins (no external packages). A scanner that must run on both the client and the registry server therefore has to depend on nothing but @agentpm/shared + node builtins and must accept an in-memory file list (SkillArchive.files) as well as a directory.

## RECOMMENDATIONS
- Module layout (AGENTS.md:28 'add helpers instead of widening already-large files'): create packages/security (@agentpm/security) depending ONLY on @agentpm/shared + node builtins so that @agentpm/registry-server (which depends only on shared) can run the identical scanner on uploads at D:/DevProjects/private/agentpm/packages/registry-server/src/server.ts:410 (after validateSkillArchive, before writeFile at :475), and publish-side client code can run it before packDirectoryToArchive in D:/DevProjects/private/agentpm/packages/core/src/registry-client.ts:249 and before pushToGit (service.ts:1922).
- Suggested files in packages/security/src: types.ts (ScanInput = virtual file list {path, bytes, mode, symlinkTarget?}; Finding {ruleId, severity, category, file, line, excerpt, fingerprint}; Capability; ScanReport {rulesetVersion, treeSha256, verdict, findings, capabilities}); tree.ts (readSkillTree(dir) with lstat, no ignore list, size caps, symlinks recorded not followed; filesFromArchive(archive); computeTreeIntegrity = sha256 over sorted length-prefixed path+mode+content with NFC/case-fold collision detection); rules/structure.ts (symlink escape, reserved names, executables/binaries, oversize, nested .git/node_modules/dist); rules/unicode.ts (bidi controls, zero-width, Unicode tag block U+E0000-E007F, mixed-script homoglyph names); rules/markdown.ts (HTML comments, hidden/collapsed instructions, data: URIs, instruction-override phrases as low-weight heuristics); rules/remote-refs.ts (every URL with host classification: raw IP, http:, shorteners, paste/gist/raw hosts; 'fetch/curl/wget/WebFetch and follow' patterns; unpinned npx/uvx/pipx/docker tags, @latest, git branch refs, curl|sh, iwr|iex); rules/mcp.ts (.mcp.json, mcpServers, remote url/sse, stdio commands); rules/hooks.ts (hooks.json, settings hooks, allowed-tools such as Bash(*)); rules/frontmatter.ts (name vs directory mismatch, overlong/obfuscated description); scan.ts (pure, deterministic: sorted output, no clock, no network); policy.ts (evaluate(report, policy, previous?) -> allow|warn|confirm|block, capabilityDelta); ruleset-version.ts. Every rule file is table-driven so rules are testable fixtures under tests/fixtures/security/.
- Core integration as thin helpers, not in service.ts: packages/core/src/security-gate.ts exporting runInstallGate(ctx) (scan + policy + prompt/--yes/--json semantics + persistence payload) and packages/core/src/integrity-lock.ts (read/write agentpm.lock or the new agentpm.yaml fields). service.ts then needs roughly five call sites: :808 (install), :1038/:4822 + :1086 (update), :2485 (pull), :2584 (adopt), :4343 (archive pre-materialize). Update docs/summaries/runtime-architecture.md and add docs/summaries/security.md in the same diff (CLAUDE.md rule).
- Mutable-target defence in layers: (1) scan and classify every external reference as a capability (remote-instruction URL, MCP remote, unpinned package runner, pipe-to-shell, branch/tag git ref) and require explicit acceptance for the classes that let someone else change agent behaviour later; (2) make AgentPM's own targets immutable or verified: content-addressed release/library directories, tree hash recorded at install, verified on cache reuse (git/src/index.ts:173, service.ts:4353), by doctor (service.ts:2932) and by a new 'agentpm audit' command; snapshot local sources by default; (3) pin resolution: full-SHA validation, write resolved SHA + treeSha256 to the lock on install AND update, make sync lock-driven; (4) on update show a capability delta, not just changed paths, and bind the confirmation to the exact revision/tree hash that gets applied (fix the preview/apply TOCTOU at service.ts:1067-1073).
- Non-interactive semantics (mirror the existing requiresConfirmation convention at apps/cli/src/index.ts:1514-1523): verdict 'block' -> always fail, non-zero exit, JSON error with code 'security-blocked' and the report; never overridable by --yes, only by an explicit, auditable override (--allow-finding <fingerprint> / project policy file) that is recorded in the install record. Verdict 'confirm' -> TTY: prompts.confirm(message, details[]) with top findings; non-TTY or --json without acceptance: do not link, return { applied:false, requiresConfirmation:true, security } ; --yes alone must NOT accept security findings (introduce --accept-risk or lock-file acceptance matched by treeSha256 + capability set). Verdict 'warn' -> proceed, print findings to stderr via onStatus (keeps stdout JSON clean) and include 'security' in the JSON result. sync: no prompts by design; allow only when lock integrity and accepted capabilities match, otherwise fail closed with instructions to run 'agentpm install/update' interactively and commit the lock.
- Split InstallOptions.yes (service.ts:114-127) into UX-prompt auto-accept and a separate security policy field, because syncManifest passes yes:true (service.ts:1395) and pull/adopt use yes for agent selection; otherwise the new gate is bypassed by existing automation on day one.
- Quick hardening wins found while mapping (independent of the scanner): '--' and leading-dash rejection plus config/env hardening for every git spawn (git/src/index.ts:146, :184; service.ts:2057-2079); validate 'revision' as full hex before it reaches resolveReleasePath (git/src/index.ts:52; config/src/index.ts:297-298); containment check for marketplace plugin sources (adapters/src/index.ts:241, helper isWithinDirectory at fs/src/index.ts:252); origin-scope the bearer token for archive downloads (registry/src/index.ts:283-297, :322-328); publish the server's sha256 in /index.json (registry-server/src/server.ts:290-300) and verify it in prepareArchiveContent (service.ts:4343-4344); archive structural limits + case-fold/reserved-name checks in validateSkillArchive (shared/src/index.ts:200-280); constrain workspaceRoot from committed config (config/src/index.ts:805); make walkFiles symlink-aware or add a separate lstat walker (fs/src/index.ts:46-70); pin 'npx skills' to an exact version with a minimal env (provider-bridge.ts:142-160).
- Storage of verdicts: keep scan results keyed by (treeSha256, rulesetVersion) so re-scans are skipped for identical trees, results are reproducible, and a ruleset upgrade marks installs 'scan-stale' in doctor. Store accepted finding fingerprints (ruleId + file + normalized excerpt hash) rather than a blanket 'approved' flag, so an update that introduces a NEW finding or capability re-triggers the gate while unchanged accepted findings stay quiet.
- Confidence note: every item above comes from reading the working tree on 2026-09-18 (service.ts and fs/index.ts have uncommitted local modifications); no builds, tests or exploits were run. Items explicitly marked 'code-derived, untested' (git option injection, revision path escape, marketplace source escape, cmd.exe query handling) should be confirmed with a focused test before being described as vulnerabilities.