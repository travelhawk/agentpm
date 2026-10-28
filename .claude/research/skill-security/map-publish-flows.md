# publish-flows

## agentpm push -> git vault/target (content leaves machine via git)
Entry: D:\DevProjects\private\agentpm\apps\cli\src\index.ts:1664 (CLI 'push') -> D:\DevProjects\private\agentpm\packages\core\src\service.ts:1438 (AgentPmService.push) -> service.ts:1922 (pushToGit)
Steps:
  - CLI parses [pathOrName], --to, -m, --dry-run, --all, --preserve-layout (cli index.ts:1664-1703) and calls service.push; there is no confirmation prompt and no file listing
  - push() resolves the target from GLOBAL config only (service.ts:1441, resolvePushTarget 1473-1543); an unknown --to token is accepted as an ad-hoc locator (1490-1494)
  - resolvePushCandidates/discoverPushCandidates (service.ts:1630-1744, 1780-1889): candidates = inspectRepository(cwd) entries + DB installs whose scopeRoot is cwd (sourcePath = install.linkTarget, i.e. third-party content in cache/library) + managed-library installs
  - target.kind 'registry' throws 'Registry push is not implemented yet.' (service.ts:1466-1468); only git is supported
  - pushToGit: dry-run returns only destinationRelativePaths (1930-1937) - no content inspection
  - preparePushTargetRepository (2040-2082): clone into <cache>/push-target-*/worktree, or reset --hard + clean -fd + fetch + pull --ff-only (all errors swallowed with .catch(() => {}))
  - Per entry: fs.rm(destinationRoot) then walkFiles(entry.sourcePath) + fs.copyFile (1945-1959). walkFiles (packages/fs/src/index.ts:46-70) skips only .git, node_modules, .turbo, dist and silently skips symlinks/special files
  - git add -A --force -- <destinations> (1964-1970), git commit -m <message> (1980-1986, failure swallowed into a warning), git rev-parse HEAD, git push --set-upstream origin HEAD (2002-2008)
  - saveCacheRepo with role 'push-target' and currentRevision (2010-2024); PushResult {success,targetLocator,revision,warnings,entries} returned
Existing checks:
  - Destination collision guard assertNoPushDestinationCollisions (service.ts:1746-1778)
  - Dedupe by realpath identity (1728-1739)
  - walkFiles ignore list: .git, node_modules, .turbo, dist (fs index.ts:13); symlinks are not followed (Dirent.isFile/isDirectory are false for links)
  - Commit message passed as argv, not through a shell
  - No size limit, no secret check, no content check, no confirmation
Gaps:
  - No security scan and no confirmation before content is committed and pushed; --dry-run does not list files
  - 'git add -A --force' (service.ts:1965) overrides the vault's .gitignore, so a .env / key file inside the skill folder is force-committed and pushed
  - Junk/secrets are copied: .env*, *.pem, id_rsa, .npmrc, credentials.json, .idea, .vscode, .DS_Store, __pycache__, .venv, logs, large binaries (only 4 names ignored)
  - Candidates can be install.linkTarget paths (service.ts:1674, 1714): third-party content from cache/library is re-published to the user's vault without review - laundering path for a poisoned skill
  - Symlinks are silently dropped (not reported), while 'dist' and 'node_modules' inside a skill are silently NOT pushed: what is pushed differs from what was installed/linked, and any scanner built on walkFiles inherits these blind spots
  - Mutable-target references inside SKILL.md/scripts/plugin.json/.mcp.json (URLs, npx pkg@latest, curl|sh, git branches, remote MCP servers) are never extracted or reported
  - Fetch/pull errors on the cached target repo are swallowed (2064-2079), so a push can be built on a stale or tampered worktree without notice
  - PushResult has no structured scan field, only warnings: string[] (shared index.ts:426-432)
Hook points:
  - D:\DevProjects\private\agentpm\packages\core\src\service.ts:1442-1456 - in push() right after resolvePushCandidates and before dispatch to pushToGit: scan every entry.sourcePath here so --dry-run also reports findings and a block happens before any clone/copy
  - D:\DevProjects\private\agentpm\packages\core\src\service.ts:1945 - inside pushToGit before the copy loop: last point where blocking costs nothing; scan the exact file list that the loop will copy (reuse one walker for scan + copy so scanned set == pushed set)
  - D:\DevProjects\private\agentpm\packages\core\src\service.ts:1964-1970 - after 'git add': compare 'git diff --cached --name-only' with the scanned file set, and drop '--force' or apply a secrets deny-list before staging
  - D:\DevProjects\private\agentpm\apps\cli\src\index.ts:1664-1732 - add flags (--scan-policy / --allow-finding <id> / report in --json) and print the scan summary; keep the command body thin per CLAUDE.md and put logic in a new package (e.g. packages/security) rather than widening service.ts

## agentpm registry publish (client packs folder and uploads archive)
Entry: D:\DevProjects\private\agentpm\apps\cli\src\index.ts:2258 (CLI 'registry publish') -> D:\DevProjects\private\agentpm\packages\core\src\registry-client.ts:194 (publishSkillToRegistry)
Steps:
  - CLI validates --visibility and --kind enums only (cli index.ts:2285-2297), resolves registry URL, calls publishSkillToRegistry
  - normalizeRegistryUrl accepts http:// and https:// (registry-client.ts:33-41); token from AGENTPM_REGISTRY_TOKEN_<HOST>, AGENTPM_REGISTRY_TOKEN, or credentials.json (registry index.ts:268-281)
  - Name = --name or folder basename, regex /^[a-z0-9][a-z0-9._-]*$/i (registry-client.ts:211-216)
  - Marker guard: requires SKILL.md or .claude-plugin/plugin.json or .codex-plugin/plugin.json unless --kind is forced (218-228)
  - inferSkillMetadata reads plugin.json description or SKILL.md/README.md frontmatter/first paragraph (143-192)
  - Version: --version, else GET /v1/skills/:name and bumpPatch(latestVersion), else 0.1.0 (232-247)
  - packDirectoryToArchive(sourcePath, metadata) (registry-client.ts:249-256 -> fs index.ts:186-220): walkFiles, assertSafeArchivePath per relative path, whole file read into memory, utf8 or base64 by isProbablyBinary, executable flag from mode & 0o111
  - PUT /v1/skills/:name with body {archive, visibility?} via registryApiRequest (258-266; registry index.ts:352-412)
  - Returns {name, version, checksum, visibility, registry}; the server checksum is displayed/returned but never compared with anything computed locally
Existing checks:
  - URL scheme check, name regex, skill/plugin marker guard (bypassable with --kind)
  - assertSafeArchivePath on each packed path (shared index.ts:188-198)
  - walkFiles ignore list (.git, node_modules, .turbo, dist); symlinks skipped, never followed
  - Requires a stored/env token before packing
Gaps:
  - No pre-publish scan of any kind; no confirmation; no file listing; no --dry-run for publish
  - Secrets/junk get packed by accident: .env*, keys, .npmrc, credentials.json, IDE folders, OS junk, caches, large binaries. No .agentpmignore/.gitignore support, no deny-list, no per-file/total size cap on the client (server rejects only above 64 MiB total body)
  - Default visibility is PUBLIC when --visibility is omitted (server.ts:460), so an accidental publish of a folder with secrets is world-readable on a publicRead server
  - http:// registries accepted without warning for non-loopback hosts: password, token and archive travel in clear text
  - Client does not compute a content digest before upload and cannot verify that the server stored what was sent; the returned checksum is over the server's own re-serialization
  - Symlinks silently dropped; dist/ and node_modules/ silently excluded - the published artifact can differ from the reviewed folder without any notice
  - Auto version bump trusts server-reported latestVersion; bumpPatch falls back to '<version>.1' for non-semver strings
  - On Windows the executable bit is never set (mode & 0o111 is 0), so executable metadata depends on publisher OS
Hook points:
  - D:\DevProjects\private\agentpm\packages\core\src\registry-client.ts:249-257 - between packDirectoryToArchive and the PUT: scan the in-memory SkillArchive (exactly the bytes that will be uploaded). A pure function scanSkillArchive(archive) -> ScanReport working on {path, encoding, content, executable}[] can be shared verbatim with the server and with the install path
  - D:\DevProjects\private\agentpm\packages\fs\src\index.ts:186-220 (packDirectoryToArchive) and :13/:46-70 (IGNORED_NAMES/walkFiles) - place for secrets/junk deny-list, ignore-file support, reporting of skipped symlinks and ignored directories, per-file/total/file-count caps
  - D:\DevProjects\private\agentpm\packages\core\src\registry-client.ts:258-276 - send client-computed contentDigest + scan summary with the PUT body and compare the server's echoed digest with the local one before reporting success
  - D:\DevProjects\private\agentpm\apps\cli\src\index.ts:2258-2326 - add --dry-run (print file list + findings), policy/override flags, scan report in --json output

## Registry server publish handler (PUT /v1/skills/:name) - content ACCEPTED by registry
Entry: D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:405
Steps:
  - authenticate() on every request: Bearer token -> sha256 -> tokens table -> active user (server.ts:189-208)
  - requireRole admin|publisher (406)
  - readJsonBody with maxArchiveBytes (default 64 MiB, server.ts:31, 80-118, 407): whole body buffered in memory then JSON.parse
  - validateSkillArchive(body.archive) (408-416 -> shared index.ts:200-280): formatVersion===1, name regex, version regex /^[A-Za-z0-9][A-Za-z0-9._+-]*$/, kind/target enums, >=1 file, safe paths, no exact-duplicate paths, encoding enum, string content; unknown fields are dropped and the archive is rebuilt normalized
  - archive.name must equal URL name and match NAME_PATTERN (417-422); visibility enum check (423-430)
  - Ownership: existing skill must be owned by caller or caller is admin; hidden private skill reads as 404 (432-440)
  - Version uniqueness: existing (skill, version) -> 409 (441-446) plus UNIQUE(skill_id, version) in DB (db.ts:168)
  - Skill row is created/updated FIRST (448-462): description/tags/visibility updated from the new archive; kind/target are only set at creation
  - serialized = JSON.stringify(archive); checksum = sha256(serialized) (464-465)
  - mkdir <dataDir>/archives/<name>/, path containment check, fs.writeFile <version>.json with default flags i.e. overwrite (466-475)
  - db.addSkillVersion {skillId, version, checksum, archivePath, sizeBytes, publishedBy} (477-484); respond 201 {name, version, checksum, visibility}
Existing checks:
  - Auth + role (admin/publisher), ownership check, 404-masking for hidden private skills
  - Body size cap 64 MiB (configurable via maxArchiveBytes option; not exposed on CLI 'registry serve')
  - Structural archive validation (shared validateSkillArchive) incl. path traversal/absolute/backslash/colon/NUL rejection
  - Version regex prevents path separators; defense-in-depth path.relative containment check (471-474)
  - 409 on re-publish of an existing version; DB UNIQUE constraint
  - sha256 checksum stored per version
Gaps:
  - No content scan at all: no prompt-injection heuristics, hidden-Unicode detection, mutable-reference extraction (URLs, npx @latest, curl|sh, git branch refs, remote MCP servers, plugin hooks), secret detection, or executable/binary policy
  - No quarantine/approval state: a publisher's upload is instantly in /index.json and downloadable; no admin review step, no status column
  - Not transactional and wrong order: skill metadata (description, tags, visibility) is mutated BEFORE the archive is written and the version row inserted (448-462 vs 475-484). A failed write leaves changed metadata, or an empty skill row that squats the name
  - Case-collision content swap (by code reading, not runtime-tested): skills.name UNIQUE uses SQLite BINARY collation (db.ts:148) while NAME_PATTERN is case-insensitive, so 'MySkill' and 'myskill' are different rows with different owners but share one directory on Windows/macOS; fs.writeFile at 475 has no 'wx' flag, so user B can overwrite user A's <version>.json. The stored checksum is never verified on read, so the swap is served silently. DELETE of one also rm -rf's the other's directory (560)
  - kind/target drift: later versions can change archive.kind (e.g. skill -> plugin with hooks) while the skills row and the index keep advertising the original kind/target (updateSkillMetadata never touches them, db.ts:332-365)
  - validateSkillArchive gaps: no per-file size, file-count, path-length, description/tag length limits; no case-fold or Unicode-normalization duplicate detection (SKILL.md vs skill.md overwrite each other on case-insensitive FS = scanner evasion); no Windows reserved names / trailing dot-space checks; control, bidi and zero-width characters allowed in paths; base64 content not verified to be valid base64; nothing blocks .env, .git/, .ssh paths
  - Version string 'latest' is a legal version but is shadowed by the 'latest' alias in the download route (575)
  - No namespaces/scopes: any publisher can claim any free name (typosquatting, squatting); deleted names can be re-registered by someone else while clients still have the source configured
  - No rate limit or per-user quota on publish; 64 MiB JSON.parse blocks the single event loop
  - No audit log of publish/delete/visibility/ownership changes
Hook points:
  - D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:416-447 - directly after validateSkillArchive/name/ownership/version checks and BEFORE the first DB write at 448: run the shared deterministic scanner on the normalized archive. Verdict 'block' -> 422 with the findings report; verdict 'review' -> store with status='quarantined' (not indexed, downloadable only by owner/admin); 'pass' -> approved. Never trust a client-supplied scan report, always recompute
  - D:\DevProjects\private\agentpm\packages\shared\src\index.ts:200-280 (validateSkillArchive) and :186-198 (assertSafeArchivePath) - structural hardening that then applies at publish, server accept, server read, and client install simultaneously: limits, case-fold/NFC duplicate paths, reserved names, control/bidi chars in paths, forbidden path prefixes
  - D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:448-484 - wrap skill upsert + file write + addSkillVersion in one ordered unit (write file with flag 'wx' first, then a single SQLite transaction), and persist contentDigest, scan report, scanner/ruleset version next to checksum
  - D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:142-147 (RegistryServerOptions) and D:\DevProjects\private\agentpm\apps\cli\src\index.ts:2112-2130 ('registry serve') - place for server policy options: scan policy level, quarantine on/off, max sizes, allowed URL hosts

## Archive storage, version lifecycle and immutability
Entry: D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:464 (write) / :240 (read) / :550 and :587 (delete); schema at D:\DevProjects\private\agentpm\packages\registry-server\src\db.ts:126
Steps:
  - Archives are plain JSON files at <dataDir>/archives/<name>/<version>.json (server.ts:466-475); metadata in <dataDir>/registry.sqlite
  - skill_versions row: id, skill_id, version, checksum, archive_path (absolute path), size_bytes, published_by, published_at, UNIQUE(skill_id, version) (db.ts:159-169)
  - Read path readArchiveFromDisk (240-243): fs.readFile + JSON.parse + validateSkillArchive; the stored checksum is NOT compared
  - DELETE /v1/skills/:name (550-563): owner/admin; db.deleteSkill (versions cascade) + rm -rf archives/<name>
  - DELETE /v1/skills/:name/versions/:version (587-607): owner/admin; row delete + file rm
  - PATCH /v1/skills/:name (495-548): owner/admin can change description, tags, visibility; admin can transfer ownership
  - Schema management is CREATE TABLE IF NOT EXISTS only (db.ts:126-173): no schema version, no ALTER path
Existing checks:
  - UNIQUE(skill_id, version) + 409 on re-publish
  - Owner/admin authorization for delete/patch; admin-only ownership transfer
  - Path containment check before write
Gaps:
  - Versions are NOT effectively immutable: owner/admin can DELETE a version and PUT the same version string again with different content (no tombstones); delete skill + re-create reuses name and versions, possibly under a different owner; case-collision overwrite (see publish flow); files on disk are not verified against the stored checksum on read
  - This is the registry-side rug-pull vector: a reviewed name@version can later serve different bytes; the client (service.ts:4343-4356) just computes a new revision from the new bytes and treats it as a normal update
  - archive_path is stored absolute, so moving dataDir breaks reads; irrelevant to security but relevant when adding quarantine directories
  - No status/yank concept: the only way to pull a bad version is hard delete, which also destroys evidence and enables version reuse
  - No migration framework: adding scan/signature columns needs PRAGMA user_version + ALTER TABLE ADD COLUMN logic that does not exist yet
  - No audit trail table
Hook points:
  - D:\DevProjects\private\agentpm\packages\registry-server\src\db.ts:159-169 - extend skill_versions with content_digest, status (approved|quarantined|rejected|yanked), scan_report_json, scanner_version, ruleset_version, scanned_at, signature, signer_key_id; add version_tombstones(skill_name COLLATE NOCASE, version, content_digest, deleted_at) and audit_log tables; make skills.name COLLATE NOCASE
  - D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:587-607 and :550-563 - replace hard delete with yank (status change + tombstone) so a version string can never be reused with different content
  - D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:240-243 - verify sha256 of the file bytes against skill_versions.checksum on every read; mismatch -> 500 + mark version quarantined
  - Rescan hook: a startup/admin-triggered job iterating skill_versions where scanner_version < current and re-running the deterministic scanner (cheap, offline) so ruleset updates apply to already-stored archives

## Index generation (/index.json, /v1/index.json) and client indexing
Entry: D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:276
Steps:
  - publicRead=false and no auth -> 401 (280-282)
  - For each skill visible to caller: latest = listSkillVersions()[0], ordered by published_at DESC, not semver (db.ts:421-426)
  - Entry = {name, description, archive: '/v1/skills/<name>/versions/<version>/archive', version, kind, target, tags} (290-300); response {version:1, entries}
  - Client: loadRegistryIndex -> parseRegistryContent -> coerceEntry (registry index.ts:26-120) keeps only known fields; archive URL resolved by resolveRegistryRepo (service.ts:4846-4856) - absolute URLs to ANY origin are accepted
  - catalogEntriesFromRegistry stores metadata {archive:true, archiveVersion, archiveKind} in catalog_entries.metadata_json (service.ts:3133-3177)
Existing checks:
  - Visibility filtering per caller (canReadSkill)
  - Index points at a version-specific archive URL, not at the 'latest' alias
  - Client-side coerceEntry type/enum checks; conflicting adapterHint/target rejected
Gaps:
  - Index carries no checksum/integrity, no scan verdict, no scanner version, no signature - the client has nothing to verify a download against
  - 'Latest' = most recently published, so publishing an old-line patch after a newer major silently downgrades what the index advertises
  - coerceEntry silently strips unknown fields, so new integrity/scan fields must be added explicitly to RegistryIndexEntry (shared index.ts:145-157) and coerceEntry, otherwise they vanish
  - Static third-party indexes can point 'archive' at any origin; getRegistryHeaders (registry index.ts:283-297) attaches the global AGENTPM_REGISTRY_TOKEN env token to whatever host the archive URL names (only cross-origin REDIRECTS strip it, 149-158) - token leak to an attacker-controlled index/archive host
  - kind/target in the index come from the skills row (first publish), not from the latest archive
  - Description and tags are attacker-controlled free text that lands in agent-visible search output (prompt-injection surface in metadata, not only in files)
Hook points:
  - D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:283-302 - only emit versions with status='approved'; add integrity (sha256 content digest), scan {scannerVersion, rulesetVersion, verdict, maxSeverity, counts, scannedAt} and later signature to each entry
  - D:\DevProjects\private\agentpm\packages\shared\src\index.ts:145-157 (RegistryIndexEntry) + D:\DevProjects\private\agentpm\packages\registry\src\index.ts:26-76 (coerceEntry) - add the optional fields so they survive parsing, for both the server index and hand-written static indexes
  - D:\DevProjects\private\agentpm\packages\core\src\service.ts:3169-3175 - carry integrity/scan fields into catalog metadata so install can enforce 'digest must match index' before materializing

## Archive download endpoint and client fetch
Entry: D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:566 (GET /v1/skills/:name/versions/:version/archive); client at D:\DevProjects\private\agentpm\packages\registry\src\index.ts:322 (fetchSkillArchive) and D:\DevProjects\private\agentpm\packages\core\src\service.ts:4338 (prepareArchiveContent)
Steps:
  - canReadSkill check (public -> publicRead or any auth; private -> ANY authenticated active user) (225-230, 571)
  - version 'latest' alias -> newest by published_at; else exact lookup (574-580)
  - readArchiveFromDisk -> validateSkillArchive -> incrementDownloads -> sendJson pretty-printed with Cache-Control: no-store (581-584, 70-78)
  - GET /v1/skills/:name (377-403) additionally returns readme text (first of SKILL.md, README.md, readme.md, AGENT.md, else any .md) plus per-version checksum/size/publisher
  - Client fetchSkillArchive: httpGet (no timeout, no response size cap, up to 5 redirects) -> JSON.parse -> validateSkillArchive; returns {archive, raw}
  - Client revision = sha256(raw response text) (service.ts:4344); materializeArchive writes files under the cache release dir with containment check and chmod 0755 for executable files (fs index.ts:222-245)
Existing checks:
  - Visibility/auth gate with 404 masking
  - Archive re-validated on read (server) and on fetch (client)
  - materializeArchive containment check + assertSafeArchivePath
  - Authorization header stripped on cross-origin redirects
Gaps:
  - No end-to-end integrity: server checksum = sha256(JSON.stringify(archive)) compact, download is re-serialized pretty-printed, client hashes the pretty text - the two hashes can never match and the client never sees the server checksum anyway (not in index, not in a header)
  - Stored checksum not verified on read, so on-disk tampering or the case-collision overwrite is served as-is
  - 'latest' alias is a mutable target by design; usable by hand-written indexes
  - Any authenticated user, including role 'reader', can read every private skill - no per-skill ACL
  - Download counter increments on every GET with no dedupe (trivially inflated popularity signal)
  - Client httpGet has no max body size and no timeout (registry index.ts:122-182) - a malicious registry can exhaust memory
  - No scan on the client side before materializeArchive (covered by the install-flows area, but it is the mirror hook of the publish scan and should reuse the same scanSkillArchive function)
Hook points:
  - D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:574-584 - gate on version status (quarantined/rejected/yanked -> 404 or 451-style error except for owner/admin), verify checksum, and send the stored bytes verbatim plus headers such as ETag/X-AgentPM-Content-Digest and X-AgentPM-Scan so clients can verify without parsing
  - D:\DevProjects\private\agentpm\packages\core\src\service.ts:4343-4356 - between fetchSkillArchive and materializeArchive: recompute the canonical content digest, compare with the index/lock value, then run the same deterministic scanner before anything touches disk

## Web UI rendering of skill content (XSS review)
Entry: D:\DevProjects\private\agentpm\packages\registry-server\src\web-ui.ts:4 (WEB_UI_HTML), served at D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:265
Steps:
  - Single inline HTML+JS page, no external assets; served with only Content-Type header (server.ts:265-269)
  - API token kept in localStorage 'agentpm-registry-token' (web-ui.ts:181, 434) and sent as Bearer
  - All server strings are passed through esc() (textContent -> innerHTML round trip, web-ui.ts:201-205) before innerHTML concatenation: skill name, description, tags, kind, target, versions, owner, stats, error messages (232-309, 340-401)
  - README is rendered as escaped plain text inside <div class=readme> with white-space: pre-wrap (309); there is no markdown-to-HTML rendering
  - Attribute contexts: data-user, data-name, data-id use esc() inside double quotes (341, 346, 372, 374, 401)
Existing checks:
  - Consistent esc() for every text-context interpolation; README never interpreted as HTML/markdown
  - Attribute values are constrained server-side: usernames by USERNAME_PATTERN (server.ts:30, 626), skill names by NAME_PATTERN/validateSkillArchive, token ids are UUIDs
  - Bearer-token auth (no cookies), so classic CSRF does not apply
Gaps:
  - No exploitable XSS found by code reading today, but esc() does NOT escape double quotes, so the attribute interpolations at web-ui.ts:341/346/372/374/401 are safe only because of server-side regexes - any future loosening of name/username rules becomes stored XSS
  - No Content-Security-Policy, X-Content-Type-Options, X-Frame-Options/frame-ancestors, or Referrer-Policy on the HTML response (server.ts:266); combined with the token in localStorage, a single XSS would mean full account (possibly admin) takeover; clickjacking of delete/visibility buttons is possible
  - Invisible content is not surfaced to human reviewers: zero-width, bidi-override and Unicode tag characters in README/description render invisibly, so a reviewer looking at the UI sees a clean skill while the agent sees injected text
  - Only the README is shown; other files (scripts, references, plugin.json hooks, .mcp.json) are not viewable, so UI review cannot catch payloads elsewhere
  - No display of checksum, scan verdict, or findings; no quarantine/approval UI for admins (the Curation tab only toggles visibility/deletes, web-ui.ts:155-160, 364-390)
  - One-time passwords and new tokens are written into the DOM via textContent (450-461) - fine for XSS, but they stay visible until navigation
Hook points:
  - D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:265-269 - add CSP (default-src 'none'; script-src/style-src with a hash or nonce; connect-src 'self'; frame-ancestors 'none'), nosniff, Referrer-Policy
  - D:\DevProjects\private\agentpm\packages\registry-server\src\web-ui.ts:201-205 - make esc() also escape quotes (or build DOM nodes with setAttribute) so attribute contexts are safe independent of server regexes
  - D:\DevProjects\private\agentpm\packages\registry-server\src\web-ui.ts:280-309 (openDetail) and D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:391-401 - render scan verdict, findings list, extracted external references (URLs/packages/MCP servers), content digest, and a visible-escape view of hidden Unicode; add an admin quarantine queue next to the Curation tab (web-ui.ts:155-160)

## Auth, roles and tokens (who may publish / read)
Entry: D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:189 (authenticate), :306 (login), :609-730 (users/tokens); hashing in D:\DevProjects\private\agentpm\packages\registry-server\src\auth.ts
Steps:
  - First start bootstraps user 'admin' with generated password and token; CLI prints both to stdout once (server.ts:149-156; cli index.ts:2136-2147)
  - Login: POST /v1/auth/login, scrypt verify (async), in-memory throttle 10 failures per (ip, username) per 15 min (158-187, 306-334); each successful login mints a NEW token
  - Tokens: 'agpm_' + 24 random bytes base64url, stored as sha256 hash, revocable, last_used_at touched; no expiry, no scopes (auth.ts:36-42; db.ts:137-145)
  - Roles: admin (users, all skills, ownership transfer), publisher (publish + manage own skills), reader (authenticated read). POST /v1/users and PATCH /v1/users/:name are admin-only
  - Any authenticated user can create/list/revoke own tokens; admin can list/revoke all
  - Client stores tokens per origin in <AGENTPM_HOME>/credentials.json with mode 0o600 (registry index.ts:229-240); env tokens take precedence
Existing checks:
  - scrypt password hashing with per-user salt, timingSafeEqual
  - Tokens hashed at rest, revocation, inactive users rejected
  - Login throttle, admin cannot deactivate self, min password length 8 on PATCH
  - Default bind 127.0.0.1
Gaps:
  - No token expiry and no scopes: a web-ui login token equals full account power (admin included) forever; tokens accumulate on every login
  - No publish-only / read-only token type for CI; a leaked CI token can also delete skills and mint new tokens
  - Server speaks plain HTTP only; docs/examples suggest --host 0.0.0.0; client accepts http:// for non-loopback registries without warning
  - loginFailures Map grows without bound (memory DoS by varying usernames); throttle is per process and keyed on remoteAddress (useless behind a proxy)
  - POST /v1/users accepts any non-empty password (length rule only on PATCH)
  - Private skills are readable by every authenticated user incl. 'reader'; no per-skill/team ACL
  - No audit log, no 2-person rule or approval for publish, no signing identity bound to a user (nothing to anchor later signatures to)
  - credentials.json mode 0o600 has no effect on Windows
Hook points:
  - D:\DevProjects\private\agentpm\packages\registry-server\src\db.ts:137-145 - add tokens.scopes and tokens.expires_at; enforce in authenticate() (server.ts:189-208) and requireRole (217-223); add a 'publish' scope so scan-gated publishing can be delegated to CI safely
  - D:\DevProjects\private\agentpm\packages\registry-server\src\db.ts:128-136 - add users.public_key / key id columns as the anchor for later publisher signatures (e.g. ed25519 over the content digest), verified in the PUT handler next to the scan
  - D:\DevProjects\private\agentpm\packages\registry-server\src\server.ts:405-406 - admin-approval policy: publisher uploads land as 'quarantined' unless scan verdict is clean AND policy allows auto-approve; admins approve via a new PATCH on the version

## DATA MODEL
- SkillArchive (D:\DevProjects\private\agentpm\packages\shared\src\index.ts:175-184) = {formatVersion:1, name, version, kind, target?, description?, tags?, files[{path, encoding utf8|base64, content, executable?}]}. It has NO integrity, scan, provenance or signature field. validateSkillArchive (200-280) rebuilds the object and DROPS unknown fields, so any new field (integrity, scan, signature, provenance) must be added to the type and the validator explicitly; adding optional fields can stay formatVersion 1, mandatory ones need formatVersion 2.
- Two incompatible hashes exist today: server skill_versions.checksum = sha256(JSON.stringify(normalizedArchive)) (server.ts:464-465) and client installedRevision = sha256(raw pretty-printed HTTP body) (service.ts:4344). Neither is a canonical content digest and they can never be compared. Recommended single definition used everywhere (publish, server, install, git installs, lockfile): sha256 over sorted lines of '<path>\0<size>\0<sha256(file bytes)>\0<x|->' - independent of JSON serialization and computable for a directory as well as an archive.
- computeTreeSignature (D:\DevProjects\private\agentpm\packages\fs\src\index.ts:72-81) is SHA-1 over path+content with no separators/length prefix (ambiguous concatenation) and inherits walkFiles blind spots (.git, node_modules, .turbo, dist, symlinks are excluded). It is fine for change detection but must not be reused as the security content hash.
- Registry server DB (D:\DevProjects\private\agentpm\packages\registry-server\src\db.ts:126-173): skill_versions already has checksum, size_bytes, published_by, published_at, archive_path. Candidate new columns: content_digest, status, scan_report_json (compact summary: verdict, maxSeverity, counts per rule id, extracted external references), scanner_version, ruleset_version, scanned_at, signature, signer_key_id, yanked_at/yank_reason. New tables: version_tombstones, audit_log. There is no migration/versioning mechanism (only CREATE TABLE IF NOT EXISTS), so PRAGMA user_version + ALTER TABLE handling must be introduced first.
- skills.name is UNIQUE with default BINARY collation while NAME_PATTERN is case-insensitive and archives live at archives/<name>/ - make the column COLLATE NOCASE (or store a lowercased canonical name) and write archive files with flag 'wx'.
- RegistryIndexEntry (shared index.ts:145-157) = {name, description?, repo?, archive?, version?, kind?, ref?, path?, adapterHint?, target?, tags?}. Candidate additions: integrity (content digest), scan {scannerVersion, rulesetVersion, verdict, maxSeverity}, signature(s). coerceEntry (D:\DevProjects\private\agentpm\packages\registry\src\index.ts:26-76) strips unknown fields and must be extended in the same change. For git-backed entries 'ref' is a mutable branch/tag unless it is a full commit SHA - the index schema could add 'revision' (commit SHA) + integrity to pin them.
- Client state DB (D:\DevProjects\private\agentpm\packages\db\src\index.ts): catalog_entries, cache_repos and installs all have a schema-free metadata_json column, and installs has installed_revision + layout_signature. Content digest, scan summary, scanner/ruleset version and accepted-finding overrides can be stored there without a migration. ManifestInstallSpec (shared index.ts:288-300) has 'revision' which is the natural place to pin a content digest for archive installs in agentpm.yaml (whether sync enforces it for archives was not verified in this area).
- PublishSkillResult (D:\DevProjects\private\agentpm\packages\core\src\registry-client.ts:127-133) and PushResult (shared index.ts:426-432) have no structured scan field; PushResult only has warnings: string[]. Add scan?: ScanReportSummary to both so --json consumers and CI can gate on it.
- Version immutability today: partially enforced (409 + UNIQUE), but defeated by delete-then-republish of the same version, delete-skill-then-recreate (possibly by another owner), the case-insensitive filesystem collision, and the absence of checksum verification on read. There are no tombstones and no yank state. The 'latest' archive alias and 'latest = newest published_at' are additional mutable pointers.
- Accidental packing: IGNORED_NAMES is only {.git, node_modules, .turbo, dist} (fs index.ts:13). .env*, private keys, .npmrc, credentials.json, .aws/, IDE dirs, OS junk, caches, venvs and large binaries are packed by 'registry publish' and copied by 'push' (where 'git add --force' additionally defeats the vault's .gitignore). Symlinks/special files are skipped silently (not followed, so no outside-tree exfiltration at pack time). No ignore-file support exists.
- The archive format cannot represent symlinks, which is good for the registry path; git-based installs and vault pulls are where symlink/mutable-ref risks live (install-flows area). pull() (service.ts:2376-2510) reuses preparePushTargetRepository and copies vault content into the library at 2485-2488 without any scan - same scanner, mirror hook.
- detectInstallScripts (D:\DevProjects\private\agentpm\packages\adapters\src\index.ts:771-783) is the only existing risk heuristic: filename pattern match producing a warning string. It shows the existing convention (risks are reported, not executed) that the new scanner can extend into structured findings.

## RECOMMENDATIONS
- Build ONE pure, deterministic scanner in a new package (e.g. packages/security; Node built-ins only, no network) with the signature scan(files: {path, bytes|content, executable}[] , meta) -> ScanReport {scannerVersion, rulesetVersion, contentDigest, verdict pass|review|block, findings[{ruleId, severity, path, line, excerpt}], references[{type url|npm|pip|git|mcp|docker|include, value, pinned:boolean}]}. Feed it from three adapters: directory walker (push, pull, git installs), SkillArchive (publish, server, archive install). This keeps service.ts thin as CLAUDE.md requires and guarantees client and server reach the same verdict for the same bytes.
- The scanner must use its own lstat-based walker with NO ignore list and must report symlinks, ignored directories (dist, node_modules), special files and case-fold duplicate paths as findings, because walkFiles silently hides exactly those.
- Client publish gate: registry-client.ts:249-257 (scan the packed archive, block on 'block', require explicit --allow-finding <ruleId> or policy file for 'review', add --dry-run that prints file list + findings). Client push gate: service.ts:1442-1456 (before pushToGit, so --dry-run reports it) plus a staged-set == scanned-set assertion after 'git add' at 1964-1970; remove '--force' from git add or apply a secrets deny-list first.
- Server gate: server.ts:416-447, before the first DB write. Always re-scan server-side (never trust a client report). block -> HTTP 422 with report; review -> store with status 'quarantined' (excluded from /index.json at 283-302 and from downloads at 574-584 except owner/admin); pass -> approved. Persist scan summary + scannerVersion + rulesetVersion + contentDigest on skill_versions and expose them in the index, in GET /v1/skills/:name, and in the web UI.
- Make versions truly immutable: replace hard delete with yank + tombstones, forbid reuse of any (name, version) ever seen with a different contentDigest, write archive files with 'wx', make skill names case-insensitively unique, verify checksum on every read, reorder the PUT handler (file write, then one SQLite transaction for skill + version) and introduce PRAGMA user_version migrations.
- Establish end-to-end integrity before signatures: one canonical contentDigest (see data_model_notes), emitted by the client at publish, recomputed by the server, published in the index entry, verified by the client before materializeArchive, and pinned in agentpm.yaml 'revision'. Serve stored archive bytes verbatim with a digest header instead of re-pretty-printing. Signatures (e.g. ed25519 per-user key over contentDigest + name + version) can then be added as one more optional field on skill_versions / index entry / archive without changing the flow.
- Mutable-target (rug-pull) handling belongs in the ruleset: extract every external reference from SKILL.md, agent/command markdown, scripts, plugin.json hooks and .mcp.json; classify pinned vs unpinned (URL without digest, npx/uvx/pip without exact version or with @latest, curl|sh / iwr|iex, git clone of a branch, docker tag without digest, remote MCP/SSE URL, instructions telling the agent to fetch-and-follow remote text). Unpinned fetch-and-execute/fetch-and-follow = block by default; other unpinned references = review, and the reference list is stored with the version so a later rescan or diff between versions can flag newly added hosts.
- Harden validateSkillArchive (shared index.ts:200-280) since it runs on every side: per-file, total and file-count limits, path length, NFC + case-fold duplicate detection, Windows reserved names, control/bidi/zero-width characters in paths, forbidden prefixes (.git/, .ssh/, .env*), valid-base64 check, length caps on description/tags, and reject the version string 'latest'. Treat description and tags as scanned content too, because they reach agents through search output.
- Web UI: no exploitable XSS found by reading, but add CSP + nosniff + frame-ancestors 'none' at server.ts:265-269, make esc() escape quotes (web-ui.ts:201-205), show findings/references/digest and a hidden-Unicode-revealed view in the detail page, add an admin quarantine queue, and allow viewing all files of a version, not just the README.
- Tokens and transport: add scopes (read / publish / admin) and expiry to tokens, warn or refuse http:// for non-loopback registries in registry-client.ts:33-41, bound the loginFailures map, enforce the password length rule on user creation, add an audit_log table, and stop sending the global AGENTPM_REGISTRY_TOKEN to archive URLs whose origin differs from the index origin (registry index.ts:283-297).
- Secrets/junk: add a default deny-list + .agentpmignore support in packDirectoryToArchive/walk used for publish and push, and make secret detection (high-entropy tokens, PEM blocks, known key prefixes incl. 'agpm_') a blocking rule at the client gate and a rejecting rule at the server gate. Consider defaulting publish visibility to private, or requiring an explicit --visibility on first publish.
- Tests live in D:\DevProjects\private\agentpm\tests\registry-and-plugins.test.ts for the registry paths; per repo rules update D:\DevProjects\private\agentpm\docs\summaries\registry-server.md, registry.md, shared.md and runtime-architecture.md in the same diff as the implementation. Note the working tree currently has uncommitted modifications in service.ts, packages/fs/src/index.ts, packages/core/src/index.ts and apps/cli/src/index.ts, so the line numbers above refer to the working-tree state read on 2026-09-18 and will shift after the requested 'pull changes'.