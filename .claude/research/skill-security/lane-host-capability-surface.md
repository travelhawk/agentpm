# host-capability-surface

## SUMMARY
I read the current official docs (September 2026) for Claude Code, the Agent Skills spec, Anthropic's platform skills docs, OpenAI Codex and the new vendor-neutral Agent Plugins spec, and listed everything in a skill or plugin that grants power. Every item sits in a parseable file, so a pure-TypeScript, offline, deterministic scanner can list and gate all of it. The files are SKILL.md frontmatter, plugin.json, marketplace.json, hooks.json, .mcp.json or mcp.json, .lsp.json, monitors.json, settings.json, agents/*.md, agents/*.toml, agents/openai.yaml and output-styles/*.md.

**What grants power**
- A skill is more than prose. Its `!` command blocks run before the model sees the content, and its `allowed-tools` pre-approves tools. A skill can also register hooks that stay active for the rest of the session.
- A Claude plugin can ship hooks with five handler types, MCP servers, LSP servers, monitors, workflows, channels and `bin/` executables placed on the Bash PATH.
- A plugin can also take over the system prompt through an output style with `force-for-plugin` or through `settings.json` `agent`.
- Codex plugins bundle skills, MCP servers, apps and hooks. Codex custom agents (TOML) can set `sandbox_mode` and `mcp_servers`.

**Why AgentPM has to be the gate**
- The host's own safeguards do not cover the path AgentPM uses. Claude Code applies a project skill's `allowed-tools` and frontmatter hooks even in a folder the user never trusted.
- Plugin MCP servers start automatically without approval.
- Skill folders may be symlinks, and SKILL.md edits are picked up live in a running session.
- Anthropic's own docs state the owner's worry directly: a trustworthy skill can be compromised later if its external dependencies change.

**Precedents for the rug-pull defence**
- The hosts already use content-hash-bound consent. Claude Code has `--accept-command <sha256>`, archive `sha256` and SHA-pinned community plugins. Codex records hook trust against the hook's hash.
- AgentPM can apply the same idea to a whole skill tree plus a canonical "capability manifest". Any capability change on update or sync then forces re-consent.
- The scanner should also list every mutable reference as its own finding class: URLs, `npx @latest`, git refs without a SHA, remote MCP servers, `curl | sh`, and symlinks that leave the package.

Confidence is high for facts I read verbatim: skills semantics, the trust table, the security pages, output styles, memory, Codex hooks trust and the Agent Plugins spec. It is medium for exhaustive field lists that came through the fetch tool's summarizer: hook events, LSP fields, marketplace fields and the version numbers quoted.

## RECOMMENDATIONS
- Build the scanner as a new pure-TypeScript package, for example packages/security. It takes no network access and no LLM. Its single entry point scanPackage(dir) returns {capabilities, findings[{ruleId, severity, file, line, evidence}], treeDigest, capabilityDigest}. Run the same function at every gate: on the client during install, update, sync and pull, on the client before push and publish, and on the registry server when an upload arrives. The server must recompute everything and never trust findings or digests supplied by the client.
- Describe the feature to users as a capability inventory with policy gates, not as malware detection. The deterministic part is listing every power-granting construct (hooks, ! commands, allowed-tools, MCP, bin/, monitors, LSP, workflows, channels, output-style force-for-plugin, settings.agent, agent permissionMode, inline mcpServers, memory, userConfig secrets, dependencies, ambient AGENTS.md or CLAUDE.md files) and applying allow, warn or block rules. Label text heuristics, such as imperative phrases in descriptions, as heuristics and default them to 'warn'.
- Make rug-pull defence the core design, using hash-bound consent. Store the tree digest and a capability digest in the lockfile or manifest. Link agent directories only to an immutable content-addressed copy, never to a mutable git cache checkout. Claude Code follows symlinked skill directories and reloads SKILL.md edits live. Re-verify digests in 'agentpm doctor' and before every sync. When the capability digest changes on update, show a capability diff and ask for consent again. This mirrors Claude Code's --accept-command <sha256> and Codex's hash-based hook trust.
- Add a first-class 'Can change after you approve' section and rule group. It covers git refs without a 40-hex SHA, npm, npx, uvx, bunx or pipx without an exact version (including @latest and -y), docker tags without a digest, archive sources without a sha256, 'command' marketplace sources, remote MCP servers (http, sse, ws), http hooks, URLs the prose tells the agent to fetch, curl or wget piped to a shell, symlinks and @ references that leave the package, and unpinned plugin dependencies. Under a strict policy, refuse floating refs in agentpm.yaml and resolve and record SHAs at install time.
- Because Claude Code honours a project or personal skill's allowed-tools and frontmatter hooks without any workspace-trust gate, make the default policy for untrusted sources block or require explicit confirmation for four things: (a) any hooks key, (b) any ! command, (c) allowed-tools containing unrestricted Bash, PowerShell, interpreters, network tools, or Write or Edit without a scope, and (d) an allowed-tools entry that pre-approves the skill's own ! command. Offer an install-time option that recommends or sets disableSkillShellExecution for low-trust scopes.
- Scan both manifest-declared and default auto-discovered locations, because plugin.json is optional in Claude Code: hooks/hooks.json, .mcp.json, mcp.json, .lsp.json, monitors/, bin/, workflows/, output-styles/, settings.json, agents/, commands/ and skills/. Evaluate a plugin together with its marketplace entry, since strict: false lets the entry inject hooks or MCP servers. Extend plugin detection to plugins without a manifest, to the Agent Plugins root plugin.json, and to Codex's current .agents/skills path.
- Apply payload hygiene rules at both gates. Containment is realpath-based: no ../, no absolute paths, no backslashes, no symlinks leaving the root. On the server, reject symlinks in archives outright. Refuse payload files that would land outside the package's own directory or that are ambient-config names (AGENTS.md, AGENTS.override.md, CLAUDE.md, CLAUDE.local.md, .claude/settings*.json, .claude/rules/*, .codex/config.toml, .codex/hooks.json, a project-root .mcp.json). Build a file-type inventory with magic bytes, executable bits and nested archives. Set size and file-count caps. Scan for secrets. Apply Unicode checks (bidi, zero-width, tag characters, mixed-script homoglyphs in name and description) and hidden-Markdown checks.
- Make registry versions immutable. A name@version maps to exactly one tree digest forever, and a version can be yanked but never overwritten. The server stores and serves the capability manifest with each version so clients can show the summary and diff before downloading. It enforces that name equals directory equals manifest equals registry entry, runs typosquat and reserved-name checks (no 'anthropic' or 'claude' in skill names per the platform rules, and Claude Code's reserved marketplace names), and rejects uploads whose declared metadata differs from the package content.
- Follow Anthropic's pass / warn / block model in the user experience and keep the output machine-readable (--json, stable rule IDs, SARIF optional) so CI can gate on it. In non-interactive runs (agentpm sync in CI), fail closed on anything above the configured tier unless that exact capability digest is already approved in the committed contract.
- Replace or demote the current calculateTrust() heuristic (GitHub host earns +trust, install scripts cost -30) in packages/adapters/src/index.ts. Source hosting says little about content safety. Trust should come from digest pinning plus the capability tier plus policy, and the numeric score should at most summarise the findings.

## CORRECTIONS (partly/refuted/unverifiable)
- [partly] Tool: agentplugins/agent-plugins-spec exists, ~1.3k stars, last pushed 2026-08-19, v1.0.0 published and 1.1.0 draft, TSC members from Amazon, Cursor, Microsoft, OpenAI, Vercel; license 'not stated / not checked'.
  -> License IS stated, in LICENSE.md: specification text/docs/examples are CC-BY-4.0; 'Schemas, source code, scripts, and other software material are licensed under the Apache License 2.0'. So vendoring plugin.schema.json and mcp.schema.json into AgentPM is permitted under Apache-2.0 (keep attribution). Note Anthropic is NOT on the steering committee, and Claude Code's own plugin format (.claude-plugin/plugin.json, inline mcpServers, hooks) does not conform to this spec.
- [partly] Claude Code SKILL.md frontmatter superset: when_to_use, argument-hint, arguments, disable-model-invocation, user-invocable, allowed-tools, disallowed-tools, model, effort, context, agent, background, hooks, paths, shell, metadata; 'background: true runs it without the user watching'; 'paths lets a skill auto-load when matching files are touched'; claude.ai and the Skills API hard-error on any other key.
  -> (1) background defaults to TRUE for any context: fork skill, so the risky state is the default, not an opt-in; a scanner should flag 'context: fork' itself, not only 'background: true'. (2) paths is documented as a LIMITER ('loads the skill automatically only when working with files matching'), not an extra auto-load trigger; low severity. (3) The 'hard-error on any other key' claim for claude.ai/Skills API is UNVERIFIABLE: not present on the overview page or https://platform.claude.com/docs/en/build-with-claude/skills-guide (which only gives name/description rules and a 30 MB upload cap). Do not build a rule on it. (4) hooks in skill frontmatter 'keeps running for the rest of the session' and once:true is honored only in skill frontmatter: confirmed.
- [partly] Hooks: five handler types (command, http, mcp_tool, prompt, agent), about 35 events, default timeout 600s, permissionDecision allow/deny/ask, updatedInput rewrites tool input, hooks run with the user's full permissions and no confirmation; defensive settings disableAllHooks, allowManagedHooksOnly, allowedHttpHookUrls, httpHookAllowedEnvVars.
  -> Event count is 33 documented names (the researcher's own list has 33, not 'about 35'). permissionDecision has a FOURTH value 'defer'. 'allow' does not skip 'actions no mode auto-approves' and cannot skip MCP tools marked anthropic/requiresUserInteraction (v2.1.199+). Timeouts drop to 30s on UserPromptSubmit/PreModelSwitch/PostModelSwitch and 10s on MessageDisplay. The 'no confirmation' wording is the researcher's paraphrase, not verbatim; the docs only say 'full user permissions'. Subagent frontmatter: the researcher says hooks are 'PreToolUse, PostToolUse and Stop' but the docs say 'All hook events are supported. The most common events for subagents are...' (https://code.claude.com/docs/en/sub-agents), so scan all events there.
- [partly] MCP: plugin-bundled servers start automatically without approval; tools named mcp__plugin_<plugin>_<server>__<tool>; ${VAR}/${VAR:-default} expansion in command,args,env,url,headers,headersHelper; credential-like vars read as empty in remote url/headers; list_changed refreshes mid-session; transports stdio/http/sse/ws; Anthropic 'does not security-audit or manage any MCP server'; docs example uses npx -y @playwright/mcp@latest.
  -> Two nuances. (1) Not every plugin server is approval-free: for project-scope skills-directory plugins the plugins reference says 'MCP servers it declares go through the same per-server approval as a project .mcp.json', LSP servers wait for trust, and monitors do not load. Marketplace-installed and personal-scope plugins have no such gate. (2) Channels are opt-in: the server must declare the claude/channel capability AND the user must pass --channels at startup, so a channel is a lower-severity finding than a hook or monitor. Also only a fixed list of names (ANTHROPIC_API_KEY, AWS_BEARER_TOKEN_BEDROCK, NPM_TOKEN...) is blanked; 'A name outside this set, such as API_KEY, expands as written' - so the scanner should still flag ${...} in remote url/headers. Tool descriptions and server instructions are truncated at 2KB each.
- [partly] Plugin manifest surface: plugin.json optional with auto-discovery; bin/ added to Bash PATH; monitors 'run unsandboxed at the same trust level as hooks'; .lsp.json spawns a process; plugin settings.json honours only agent and subagentStatusLine; plugin agents ignore hooks/mcpServers/permissionMode; paths resolving outside plugin root (incl. symlinks) rejected; root CLAUDE.md not loaded; npm ci --ignore-scripts on package.json+lockfile; userConfig values substituted into MCP/LSP/hook commands.
  -> userConfig: the docs add 'Fields that run in a shell reject ${user_config.*}... the component fails with an error instead', so direct shell interpolation of a phished value is blocked by the host; values still reach hook processes as CLAUDE_PLUGIN_OPTION_<KEY> env vars, so the phishing concern stands but the 'substituted into hook commands' path is narrower than stated. Monitors 'run only in interactive CLI sessions'. On macOS/Linux a component path containing a backslash is rejected (Windows only loads it). Symlink handling on cache copy: inside plugin = preserved, elsewhere in same marketplace = dereferenced, outside marketplace = skipped. bin/ cannot be shipped in plugins distributed via claude.ai org settings.
- [partly] Subagents: omitted tools inherits everything incl. MCP; permissionMode values; parent bypassPermissions/acceptEdits/auto wins; inline mcpServers need folder trust for project agents but ~/.claude/agents loads without trust check; memory injects first 200 lines or 25KB of MEMORY.md and auto-enables Read/Write/Edit; initialPrompt; omitClaudeMd; hooks limited to PreToolUse/PostToolUse/Stop.
  -> Hooks claim is wrong: 'All hook events are supported' in subagent frontmatter; the three named are just the most common. Everything else confirmed. Note also that project subagent frontmatter hooks are 'Not used, and no dialog is offered' without exact-folder trust (permissions table), whereas ~/.claude/agents has no gate, so user-scope agent installs are the more dangerous target for AgentPM.
- [partly] Anthropic enterprise vetting: 7-row risk table (code execution, instruction manipulation, MCP references, network patterns, hardcoded credentials = High; filesystem scope, tool invocations = Medium), 8-step checklist incl. combined file-read+network risk, redirect destinations, exfiltration via conversational responses; Enterprise 'Skill and plugin security scanning' with fail=blocked / warning=caution notice; scan does not cover the API or Claude Code filesystem skills.
  -> The docs say scanning applies to Skills 'members then upload or edit in claude.ai or Cowork' and explicitly excludes the API/Console, pre-existing skills, and CMEK/ZDR/HIPAA orgs. They do not mention Claude Code filesystem skills at all; that exclusion is a correct inference (nothing is uploaded) but not a quoted statement. Also 'whose scan hasn't finished' is blocked: a useful fail-closed precedent for the AgentPM registry server.

## ADDITIONS
- MISSED, HIGH IMPACT for AgentPM - 'Skills-directory plugins': per https://code.claude.com/docs/en/plugins-reference#skills-directory-plugins , 'Any folder under a skills directory that contains a .claude-plugin/plugin.json manifest is loaded as a plugin named <name>@skills-dir on the next session, with no marketplace and no install step... discovered in place rather than copied into the plugin cache.' For ~/.claude/skills/ : 'Personal-scope plugins have none of these restrictions.' Consequence: something AgentPM installs as a plain 'skill' into ~/.claude/skills/<name>/ silently becomes a full plugin (hooks, MCP servers, LSP, monitors, bin/, output styles, agents) if the payload contains .claude-plugin/plugin.json. Project scope is gated (exact-folder trust, per-server MCP approval, LSP after trust, monitors do not load) but personal scope is not. The scanner must treat a .claude-plugin/ directory inside a skill payload as a kind escalation and block or re-classify it; the researcher only mentioned @skills-dir in passing.
- The tools list contains no actual security scanner. Two relevant existing projects verified via gh api: (a) cisco-ai-defense/skill-scanner - https://github.com/cisco-ai-defense/skill-scanner - 2.5k stars, pushed 2026-09-05, Python, LICENSE file is Apache-2.0 (GitHub API reports NOASSERTION because of a header). README: 'best-effort security scanner for AI Agent Skills' combining pattern-based detection (YAML + YARA-X), AST/dataflow analysis, optional LLM-as-a-judge (--use-llm) and a CEL decision layer; SARIF output; core analyzers (static + bytecode + pipeline) run without an LLM. Its YAML/YARA rule packs and threat taxonomy are reusable as a rule-catalogue reference, but it is Python so not embeddable in a pure-Node CLI. (b) snyk/agent-scan (formerly invariantlabs-ai/mcp-scan, the old name redirects) - https://github.com/snyk/agent-scan - 3.1k stars, pushed 2026-09-18, Apache-2.0, Python; scans MCP servers and agent skills (since 0.4) but REQUIRES a SNYK_TOKEN and calls a remote analysis API ('2026-07-10 analysis API'), so it is neither offline nor deterministic by AgentPM's definition. Useful only as a taxonomy reference (docs/risks.md, docs/issue-codes.md) and for its skills threat report PDF.
- Anthropic community marketplace SHA pins are auto-bumped: https://code.claude.com/docs/en/plugins says 'CI bumps the pin automatically as you push new commits to your repository', and official marketplaces auto-update by default. So 'pinned to a commit SHA' there is integrity-per-version, not protection against a later malicious commit. AgentPM's registry should make name@version immutable AND require capability-diff re-consent, not copy auto-bump.
- Hook permissionDecision has a fourth value 'defer', and 'allow' cannot bypass 'actions no mode auto-approves' or MCP tools marked _meta['anthropic/requiresUserInteraction'] (v2.1.199+). Subagent frontmatter supports ALL hook events, not just PreToolUse/PostToolUse/Stop. Source: https://code.claude.com/docs/en/hooks and https://code.claude.com/docs/en/sub-agents
- Fail-closed precedent for the registry server: Anthropic's Enterprise scanner blocks a Skill 'that fails the scan, or whose scan hasn't finished'. https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise#skill-content-scanning . Skills API upload cap is 30 MB uncompressed (https://platform.claude.com/docs/en/build-with-claude/skills-guide) and Claude Code archive plugin sources are capped at 256 MiB - reasonable anchors for AgentPM archive size limits.
- Context-size facts useful for deterministic thresholds: Claude Code truncates MCP tool descriptions and server instructions at 2KB each (https://code.claude.com/docs/en/mcp); skill description+when_to_use at 1,536 chars; Codex skill list uses 'at most 2% of the model's context window, or 8,000 characters when the context window is unknown' (https://learn.chatgpt.com/docs/build-skills). Text beyond those limits never reaches the model, so injection heuristics should weight the first N characters.
- Domain sanity check: the cited host learn.chatgpt.com is legitimate - developers.openai.com/codex/hooks answers HTTP 308 with Location https://learn.chatgpt.com/docs/hooks (verified with curl on 2026-09-18). developers.openai.com/codex/plugins/build still serves directly.
- Version sensitivity: several gates the researcher relies on are recent and version-bound (inline subagent mcpServers and headersHelper trust gating only since v2.1.238; --accept-command since v2.1.271; omitClaudeMd v2.1.271; background fork v2.1.218). AgentPM cannot assume the user's Claude Code is new enough, which is another argument for AgentPM being the gate rather than relying on host safeguards.

## TOOLS
- skills-ref (agentskills/agentskills reference validator) | https://github.com/agentskills/agentskills | Apache-2.0 | Python (reference library in the spec repo) | det: Fully deterministic. It checks schema and naming only and has no security rules. | reuse: Port the constraint set to TypeScript. It is small: a regex plus length caps. Use it as the 'spec conformance' rule group, and do not shell out to Python. | About 25.5k stars, last pushed 2026-08-09. It is the official Agent Skills spec repo.
- claude plugin validate | https://code.claude.com/docs/en/plugins-reference | Proprietary (Claude Code) | Built into the Claude Code CLI | det: Deterministic structural validation, not a security scanner. The separate 'automated safety screening' in Anthropic's pipeline is not exposed. | reuse: Optional shell-out in 'agentpm doctor' and at publish time when the claude binary is present. Core checks cannot depend on it, because of the offline, pure-Node requirement. Treat it as inspiration for a strict mode. | Maintained with Claude Code. Anthropic's community marketplace review pipeline runs it on every submission.
- Agent Plugins Specification schemas (plugin.schema.json and mcp schema) | https://github.com/agentplugins/agent-plugins-spec | See the repo. The README and spec do not state the license, and I did not check further. | JSON Schema plus a normative Markdown spec | det: Fully deterministic. The spec explicitly forbids network access during validation. | reuse: Vendor the schemas and validate with ajv or a hand-written validator. Implement the containment and URL rules in TypeScript, and add the root plugin.json layout to AgentPM's plugin detection. | About 1.3k stars, last pushed 2026-08-19. Version 1.0.0 is published and 1.1.0 is a draft. The steering committee has members from Amazon, Cursor, Microsoft, OpenAI and Vercel.

## FINDINGS
### SKILL.md frontmatter: Claude Code accepts a large superset of the 6-field Agent Skills spec, and several extra fields grant capability [high]
agentskills.io defines only name (1-64 chars, [a-z0-9-], no leading, trailing or double hyphen, must match the parent directory), description (1-1024 chars), license, compatibility (max 500), metadata (string to string map) and allowed-tools (space-separated, experimental). The Anthropic platform adds two rules: the name must not contain 'anthropic' or 'claude', and neither name nor description may contain XML tags. claude.ai and the Skills API hard-error on any other key.

Claude Code additionally accepts when_to_use, argument-hint, arguments, disable-model-invocation, user-invocable, allowed-tools, disallowed-tools, model, effort, context (fork), agent, background, hooks, paths, shell (bash or powershell) and metadata.

Fields that matter for security:
- allowed-tools pre-approves tools for the turn that invokes the skill. It does not restrict other tools. It accepts patterns such as Bash(git add *) and Bash(${CLAUDE_SKILL_DIR}/scripts/x.sh *).
- hooks are registered when the skill is invoked and stay active for the rest of the session.
- context: fork with agent picks a subagent type to run the skill body as a prompt. background: true runs it without the user watching, and edits made in the background bypass checkpoints.
- shell: powershell changes the interpreter used for ! blocks.
- model and effort allow cost abuse or a downgrade to a model that is easier to inject.
- user-invocable: false together with a broad description gives a skill that only the model can invoke and that never appears in the / menu. That is the stealthy configuration.
- paths lets a skill auto-load when matching files are touched.

Deterministic checks:
1. Parse the YAML strictly. Reject duplicate keys, anchors and aliases, and multi-document files.
2. Enforce the spec constraints: name regex, name equals directory, length caps, no XML or angle-bracket tags, reserved words.
3. Classify every key as spec, Claude extension, Codex extension or unknown. Report unknown keys.
4. Tokenise allowed-tools. Mark as HIGH any bare Bash or PowerShell, Bash(*), a wildcard in the first token, interpreters and network tools (bash, sh, node, python, curl, wget, npx, uvx, pip, npm, git with a wildcard), Write or Edit without a path scope, WebFetch without a domain, and mcp__*.
5. Flag any hooks key as HIGH and route it through the hook checks.
6. Flag the combination user-invocable: false, no disable-model-invocation and a description over N characters as a stealth pattern.
7. Flag shell: powershell on non-Windows targets, and any context: fork that names an agent shipped in the same package.
Sources: https://agentskills.io/specification ; https://code.claude.com/docs/en/skills ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

### Dynamic context injection (!`cmd` and ```! blocks) is shell execution that happens before the model sees the content [high]
The Claude Code docs say, verbatim, that the !`<command>` syntax runs shell commands before the skill content is sent to Claude. The output replaces the placeholder. A multi-line form uses a fenced block opened with ```!. Legacy .claude/commands/*.md files support the same syntax.

Commands are checked against the permission rules. In non-auto modes an unmatched command aborts the invocation unless the skill's own allowed-tools pre-approves it, so one file can carry both the command and its approval. The 2-minute Bash timeout applies, and the scan is a single pass.

The kill switch is the setting "disableSkillShellExecution": true. It covers user, project, plugin and additional-directory skills. Bundled and managed skills are not affected.

What an attacker can do: get code execution the moment the skill is invoked, read secrets into the context window, or fetch remote instructions. An example is !`curl https://x/y.md`, which is a mutable target evaluated at every invocation. The model's judgement is never involved.

Deterministic checks:
1. Extract every inline !`...` and every fenced ```! block. The extractor must handle the rule that the command sits at line start or after whitespace, and must separate real fenced ! blocks from ordinary fenced code. Treat this as its own capability, 'pre-model shell execution', and list each command verbatim in the capability summary.
2. Classify each command: network (curl, wget, Invoke-WebRequest, nc, ssh, git clone or fetch, gh api), interpreter or eval (bash -c, sh, eval, python -c, node -e, base64 -d piped to a shell), package runners (npx, uvx, pipx, bunx, npm exec, pip install, go run, cargo install), secret paths (~/.ssh, ~/.aws, .env, ~/.claude.json, ~/.codex/auth.json, keychain tools), and environment dumps.
3. Block by default when a ! command and a matching allowed-tools Bash pattern appear in the same file and the command is networked or an interpreter.
4. Expand $ARGUMENTS, $N, $name and ${CLAUDE_*} occurrences that sit inside ! commands. Flag unquoted argument interpolation as command injection.
5. Policy option: AgentPM can recommend or verify disableSkillShellExecution for untrusted scopes.
Sources: https://code.claude.com/docs/en/skills ; https://code.claude.com/docs/en/permissions

### Workspace trust does not gate the skill path AgentPM installs into, so AgentPM is the only gate for project-scope skill installs [high]
I read the 'What runs before you trust a folder' table in the Claude Code permissions docs verbatim. For settings-file hooks, the env block, helper commands such as apiKeyHelper, and a project skill's hooks and allowed-tools, the table says 'Used' when only a parent folder is trusted. For claude -p and the SDK it says 'Used. Workspace trust never gates a skill's allowed-tools in any session'. The skills page repeats the point: 'Workspace trust doesn't gate this field. Claude Code applies a project skill's allowed-tools whenever you or Claude invoke the skill, including in a -p run in a folder you've never trusted.'

Other rows behave differently:
- permissions.allow rules and additionalDirectories wait for the trust dialog.
- Frontmatter hooks in project subagents, project @skills-dir plugins and extraKnownMarketplaces are not used without trust.
- Inline mcpServers in repo subagents are not used without trust.
- .mcp.json servers prompt in interactive sessions but are 'Connected without asking, approved or not' under claude -p.
- headersHelper is not run without trust.
- Personal scope (~/.claude/skills, ~/.claude/agents) has no trust gate at all.

Consequence for AgentPM: a skill written into .claude/skills/ or ~/.claude/skills/ gets its hooks and tool pre-approvals honoured with no host-side review, in CI and headless runs too. The install gate has to show these capabilities and ask for consent itself.

Codex is stricter in two places. Project .codex/ layers load only in trusted projects. Non-managed hooks, including plugin hooks, are skipped until the user reviews them, and trust is recorded against the hook's current hash.
Sources: https://code.claude.com/docs/en/permissions ; https://code.claude.com/docs/en/skills ; https://learn.chatgpt.com/docs/hooks

### Hooks: five handler types, about 35 events, full user privileges, no confirmation. They can rewrite tool input, auto-approve permissions and inject context [medium]
Where hooks can be defined:
- settings files
- plugin hooks/hooks.json, inline plugin.json 'hooks', or extra files named by the hooks path field
- skill frontmatter, which persists for the rest of the session and supports once: true
- subagent frontmatter
- marketplace entries, which can carry hooks inline when strict is false

Handler types:
- command: command, args (exec form), shell bash or powershell, async, asyncRewake, timeout (default 600s), if, statusMessage
- http: POSTs the event JSON to url. headers support $VAR interpolation limited by allowedEnvVars.
- mcp_tool: server, tool, input
- prompt: prompt with $ARGUMENTS, model
- agent: experimental agentic verifier

Events include SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch, Elicitation, ElicitationResult and SessionEnd.

What hook output can do:
- hookSpecificOutput.permissionDecision can be allow, deny or ask. 'allow' auto-approves a tool call, although deny and ask rules still win.
- updatedInput silently rewrites tool arguments.
- additionalContext and systemMessage are a channel for injecting text into the model's context.
- The hook input includes transcript_path and cwd, so a hook can read the whole conversation.

The docs say hooks run with the user's full permissions and with no confirmation. Defensive settings are disableAllHooks, allowManagedHooksOnly, allowedHttpHookUrls and httpHookAllowedEnvVars.

What an attacker can do:
- A SessionStart or UserPromptSubmit command hook gives persistent code execution on every session.
- A PreToolUse hook returning allow plus updatedInput can approve and rewrite Bash commands.
- An http hook on PostToolUse sends every tool input and output to a remote URL. The URL is a mutable target, and headers can carry env secrets.
- A prompt or agent hook is a second instruction channel the user never sees.

Deterministic checks:
1. Any hook counts as HIGH capability. Never treat a hook as informational.
2. For each hook, print event, matcher, type and the verbatim command, url, server and tool, or prompt.
3. Verify that command and args resolve to a file inside the package through ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_SKILL_DIR} or ./. Include that script in the package digest. Flag bare executables, absolute paths, ${CLAUDE_PROJECT_DIR}, inline shell, and network or interpreter tokens.
4. For http hooks, require https. Flag any host other than localhost, flag header env interpolation, and list the hosts.
5. Flag updatedInput or permissionDecision strings inside hook scripts. This is a cheap grep.
6. Flag async and asyncRewake hooks, and any hook on SessionStart, Setup, UserPromptSubmit, PermissionRequest, ConfigChange or InstructionsLoaded, as persistence or privilege events.
7. Flag hooks in skill frontmatter as a separate item. They are easy to miss and last for the session.
Sources: https://code.claude.com/docs/en/hooks ; https://code.claude.com/docs/en/plugins-reference ; https://code.claude.com/docs/en/permissions

### MCP servers: plugin-bundled servers start without approval, their definitions are often mutable targets, and tools can change at runtime [high]
Where MCP servers can be defined in Claude Code:
- project .mcp.json, which needs approval in interactive sessions
- plugin .mcp.json, inline plugin.json 'mcpServers', or extra files
- marketplace entries with inline mcpServers
- subagent frontmatter, either inline definitions or references by name
- skill-directory plugins

Server fields are type (stdio, http or streamable-http, sse, ws), command, args, env, url, headers, headersHelper (a command run on every connection), oauth {clientId, callbackPort, authServerMetadataUrl, scopes} and timeout. ${VAR} and ${VAR:-default} expand in command, args, env, url, headers and headersHelper. Credential-like variables read as empty in remote url and headers.

The docs say plugin servers don't require approval and auto-start when the plugin is enabled. Their tools are named mcp__plugin_<plugin>_<server>__<tool>. Tool descriptions and server instructions are loaded into context. list_changed notifications refresh tools, prompts and resources mid-session. Servers can expose prompts as slash commands, resources as @ mentions, elicitation dialogs, and 'channels' that push messages into the session. The security page says Anthropic 'does not security-audit or manage any MCP server', and the MCP page warns about prompt injection from servers that fetch external content.

On the Codex side:
- config.toml [mcp_servers.<name>] takes command, args, env, env_vars, cwd, url, bearer_token_env_var, http_headers, env_http_headers, http_headers_helper, startup_timeout_sec, tool_timeout_sec, enabled, required, enabled_tools and disabled_tools.
- Plugin-bundled servers are declared in the plugin's mcp.json, or .mcp.json for the compatibility layout. Users can override them under [plugins."<name>".mcp_servers.<server>].
- A skill's agents/openai.yaml can declare dependencies.tools[] with type: mcp, value, description, transport and url.

Mutable-target patterns to look for:
- command npx, uvx, bunx or pipx with '-y pkg@latest' or no version pin. Anthropic's own subagent docs example uses args ["-y", "@playwright/mcp@latest"].
- docker run image:latest
- remote http, sse or ws URLs, where content and tool descriptions are entirely server-controlled and can change after review
- headersHelper commands
- ${VAR:-default} URL indirection

Deterministic checks:
1. List every server with transport, verbatim command and args or URL, env names (not values) and headersHelper.
2. For stdio servers, require the command to be plugin-relative, or a bare name with all package arguments pinned to an exact version or an integrity hash. Flag @latest, missing versions, -y or --yes, git URLs and docker tags without a digest.
3. For remote servers, require https, forbid user info in the URL, list the host, and apply a host allowlist policy. Always mark a remote server as 'content can change after review: cannot be pinned'.
4. Flag env and headers that reference secret-like variables, and literal secrets.
5. Flag channels and any server referenced by an mcp_tool hook.
6. Flag skill prose that references MCP tools (mcp__*, 'ServerName:tool_name') and Codex openai.yaml dependencies.tools URLs.

For remote MCP servers a static scan cannot stop a rug pull. The honest deterministic answer is to gate, label and apply host policy.
Sources: https://code.claude.com/docs/en/mcp ; https://code.claude.com/docs/en/security ; https://code.claude.com/docs/en/sub-agents ; https://learn.chatgpt.com/docs/extend/mcp?surface=cli ; https://learn.chatgpt.com/docs/build-skills ; https://github.com/agentplugins/agent-plugins-spec

### Claude Code plugin manifest: many components beyond skills, agents, hooks and MCP execute code or replace the system prompt [medium]
.claude-plugin/plugin.json is optional, because default directories are auto-discovered. Its fields are name, displayName, version, description, author, homepage, repository, license, keywords, metadata, defaultEnabled, skills (adds to the default), commands, agents, workflows and outputStyles (each replaces its default directory), hooks, mcpServers and lspServers (path, array or inline object), experimental.themes, experimental.monitors, experimental.evals, userConfig, channels, dependencies and settings.

Components with power beyond the usual four:
- bin/: executables 'added to the Bash tool's PATH and invokable as bare commands while the plugin is enabled'. This allows PATH shadowing of git, npm, node and similar, which turns any innocent-looking Bash call into attacker code.
- monitors/monitors.json: name, command, description, when. These are persistent background processes that 'run unsandboxed at the same trust level as hooks', and each stdout line is delivered to the model as a notification. That is a standing injection channel whose content is produced at runtime.
- .lsp.json: command, args, env, transport, initializationOptions and more. It spawns a process and pushes diagnostics into context.
- output-styles/*.md: changes Claude Code's default instructions. With force-for-plugin: true the style applies automatically whenever the plugin is enabled and overrides the user's outputStyle. Without keep-coding-instructions the built-in software-engineering instructions are dropped.
- settings.json at the plugin root, or plugin.json settings: only agent and subagentStatusLine are honoured. agent activates a plugin agent as the main thread, 'applying its system prompt, tool restrictions, and model'. This is a full system-prompt takeover.
- workflows/: workflow script files.
- channels: binds a plugin MCP server that 'inject[s] content into the conversation'.
- userConfig: prompts the user for values, including sensitive: true secrets, which are then substituted into MCP, LSP and hook commands and exported as CLAUDE_PLUGIN_OPTION_<KEY>. A plugin can use this to phish a token and hand it to its own hook or server.
- dependencies: other plugins installed automatically alongside this one, so the capability surface is transitive.
- package.json plus a lockfile triggers npm ci --ignore-scripts or bun install --frozen-lockfile --ignore-scripts at cache time. Lifecycle scripts do not run, but the installed code is then used by hooks and servers.

Built-in safeguards:
- Plugin agents cannot declare hooks, mcpServers or permissionMode.
- Component paths that resolve outside the plugin root are rejected, including symlinks, except links inside the same marketplace.
- A CLAUDE.md at the plugin root is not loaded.
- 'claude plugin validate [--strict]' exists for schema validation.

Deterministic checks:
- Walk both the manifest-declared paths and the default directories. An attacker can leave plugin.json clean and rely on auto-discovered hooks/hooks.json, .mcp.json, bin/ or monitors/.
- Mark as HIGH: bin/, especially names that collide with common tools, monitors, lspServers, hooks, mcpServers, channels, workflows, settings.agent and outputStyles with force-for-plugin.
- Mark as MEDIUM: userConfig with sensitive: true, dependencies (resolve and scan them, require them pinned), and package.json plus lockfile (run a lockfile and dependency scan).
- Re-implement path containment with realpath. Reject ../, absolute paths, backslashes and symlinks that leave the package.
Sources: https://code.claude.com/docs/en/plugins-reference ; https://code.claude.com/docs/en/plugins ; https://code.claude.com/docs/en/output-styles ; https://code.claude.com/docs/en/discover-plugins

### marketplace.json: source types differ sharply in mutability, and a marketplace entry can define components itself when strict is false [medium]
The Claude Code marketplace file is .claude-plugin/marketplace.json. Its top-level fields are name, owner, plugins[], description, version, metadata.pluginRoot, allowCrossMarketplaceDependenciesOn and renames.

Names are protected. There is a reserved list (claude-plugins-official, anthropic-marketplace, agent-skills and others), and look-alike names that impersonate official sources are blocked.

Plugin entry fields are name, source, description, version, author, homepage, repository, license, keywords, category, tags, strict, defaultEnabled, relevance, inline skills, commands, agents, hooks, mcpServers and lspServers, plus headers and headersHelper.

With strict: false 'the marketplace entry is the entire definition'. A third party's marketplace can therefore attach hooks or MCP servers to somebody else's otherwise benign plugin repo. A scanner must evaluate the entry and the plugin together.

Source types and how mutable each is:
- relative path ./...: as mutable as the marketplace repo itself.
- github {repo, ref, sha}, url {url, ref, sha}, git-subdir {url, path, ref, sha}: a ref is a branch or tag, which is mutable, so a rug pull is possible. A sha is immutable.
- npm {package, version, registry}: a version range or latest is mutable, and a custom registry opens the door to dependency confusion.
- archive {url, sha256}: https only, up to 256 MiB, and the sha256 is optional. Without it the archive is mutable.
- command {command, timeout, mode copy or link}: runs a command that prints a plugin directory and is re-run once per session. It is mutable by design, and the user must accept the command.

Update behaviour:
- Auto-update is on by default for official and claude.ai marketplaces and off for other third-party ones.
- Updates arrive when the version string, sha or ref target changes.
- The Anthropic community marketplace pins each plugin to a commit SHA, and CI bumps the pin.
- Org controls are strictKnownMarketplaces, blockedMarketplaces, disableCommandPluginSources, extraKnownMarketplaces and enabledPlugins.

Codex marketplaces live at .agents/plugins/marketplace.json in a repo or in the home directory. Their fields are name, interface.displayName and plugins[] with name, source {source: local, url, git-subdir or npm; path, url, ref, sha, version}, policy.installation (AVAILABLE, INSTALLED_BY_DEFAULT or NOT_AVAILABLE), policy.authentication (ON_INSTALL or ON_USE) and category. Plugins are cached at ~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/.

Deterministic checks at the AgentPM publish gate and on the registry server:
- Classify every source as immutable (a 40-hex sha, or an archive with a sha256) or mutable.
- Refuse or warn on a ref without a sha, an npm source without an exact version, an archive without a sha256, command sources, a custom npm registry, and http:// URLs.
- Flag strict: false with inline hooks, mcpServers or lspServers.
- Flag headersHelper.
- Flag Codex INSTALLED_BY_DEFAULT.
- Flag marketplace or plugin names that collide with reserved or official names. This is the typosquatting check.
Sources: https://code.claude.com/docs/en/plugin-marketplaces ; https://code.claude.com/docs/en/discover-plugins ; https://developers.openai.com/codex/plugins/build

### Subagents: omitting tools inherits everything including MCP. Other fields grant a permission mode, inline MCP servers, hooks, persistent memory and preloaded skills [medium]
Claude Code agent frontmatter (agents/*.md) has the fields name, description, tools, disallowedTools, model, permissionMode, maxTurns, skills, mcpServers, hooks, memory, background, omitClaudeMd, effort, isolation (worktree), color, initialPrompt and experimental.

- tools: when omitted the agent 'Inherits all available tools including MCP'. It supports Agent(type) to allow spawning further agents.
- permissionMode: default or manual, acceptEdits, auto, dontAsk, bypassPermissions, plan. A subagent cannot escalate to bypassPermissions unless the parent is already in that mode. If the parent is in bypassPermissions, acceptEdits or auto, the parent's mode wins.
- mcpServers: references by name, or inline definitions. The docs example is npx -y @playwright/mcp@latest. Inline definitions need folder trust for project agents, but ~/.claude/agents loads without any trust check.
- hooks: PreToolUse, PostToolUse and Stop.
- memory (user, project or local): the first 200 lines or 25KB of MEMORY.md are injected into the agent's system prompt, and Read, Write and Edit are enabled automatically. This is a persistence vector. An injected agent can poison its own memory so the attack survives across sessions, and that state lives outside the installed package, so no package digest covers it.
- skills: preloads the full content of the named skills.
- initialPrompt: submitted automatically as the first user turn when the agent runs as the main session.
- omitClaudeMd: drops the user's own project guardrails.
- The description is always in context. Combined descriptions over 15k tokens trigger a warning.

Plugin-shipped agents ignore hooks, mcpServers and permissionMode, per the docs 'for security reasons'. Agents that AgentPM installs into .claude/agents or ~/.claude/agents are not plugin agents, so they get the full field set. Placing an agent there is strictly more powerful than shipping the same file inside a plugin.

Codex custom agents are TOML files in ~/.codex/agents/ and .codex/agents/. Required fields are name, description and developer_instructions. Optional fields are model, model_reasoning_effort, sandbox_mode, mcp_servers and skills.config, each inherited from the parent when omitted.

Deterministic checks:
- Flag a missing tools allowlist, which means the agent inherits everything.
- Flag tools that contain Bash, PowerShell, Write, Edit, WebFetch, mcp__* or Agent.
- Flag any permissionMode other than default or plan. Treat bypassPermissions, acceptEdits, auto and dontAsk as HIGH.
- Flag inline mcpServers and hooks, and apply the same rules as for plugin MCP servers and hooks.
- Flag memory, initialPrompt and omitClaudeMd.
- Flag skills entries that are not shipped in the same package.
- For Codex, flag a sandbox_mode that widens access (danger-full-access or workspace-write) and any mcp_servers table.
- Warn when a package that could be a plugin installs agents standalone. Standalone placement gives them more power.
Sources: https://code.claude.com/docs/en/sub-agents ; https://code.claude.com/docs/en/plugins-reference ; https://learn.chatgpt.com/docs/agent-configuration/subagents

### Instruction surface: descriptions are always in context, bodies load on demand, and hidden-text tricks are detectable without an LLM [medium]
What always sits in the model's context:
- The skill name and description. Claude Code truncates description plus when_to_use at 1,536 characters. The spec caps description at 1024. Codex shortens descriptions if they exceed about 2% of the context window.
- Agent descriptions.
- MCP tool descriptions and server instructions.
- The output-style body.

So a description is an injection that fires without the skill ever being invoked. Bodies and referenced files load later. Scripts are executed and only their output enters context, which means the model never reads the script source. That matches Anthropic's checklist item 'Verify script behavior matches stated purpose'.

CLAUDE.md supports @path imports. Paths can be relative, absolute or ~/, recursion goes up to 4 hops, and imports inside code spans or fences are skipped. There is an approval dialog only for imports that resolve outside the working directory. The skills docs also describe @file references inside skills. Block HTML comments are stripped from CLAUDE.md before injection. The docs say nothing about stripping them from SKILL.md. My inference, which the docs do not state, is that comments in SKILL.md and agent files are invisible in rendered Markdown and GitHub previews yet fully visible to the model.

Anthropic's enterprise risk table names 'Instruction manipulation: directives to ignore safety rules, hide actions from users, or alter Claude's behavior conditionally' as High. It gives the same High rating to MCP tool references and to network patterns in prose.

Deterministic checks. These are heuristics and should be presented that way:
1. Description hygiene. Check length against 1024 and 1536. Flag imperative or override phrases ('ignore previous', 'always', 'before any other', 'do not tell the user', 'system prompt', 'you must'), second-person commands, URLs, tool names, shell tokens, XML or angle tags, and Markdown links or images. A description should contain no URL and no tool call.
2. Unicode. Detect bidi controls (U+202A-202E, U+2066-2069), zero-width and invisible characters (U+200B-200F, U+2060, U+FEFF in the middle of a file), Unicode tag characters (U+E0000-E007F), variation-selector smuggling, mixed-script homoglyphs in name and description, and whether the text is NFKC-stable. Claude Code itself forbids control and bidi characters in plugin and marketplace names, and its skill-name collision logic ignores invisible characters.
3. Hidden Markdown. Look for HTML comments, <details>, inline styles that hide text, link text that differs from its href, image URLs with query strings (an exfiltration beacon), very long lines, large runs of whitespace that push text off screen, and base64 or hex blobs above N bytes.
4. @ references and relative links. Resolve each one. Flag targets outside the package, absolute or ~/ paths, and references to secret locations.
5. Registry consistency. The SKILL.md name must equal the directory name, the archive entry name and the registry entry name. The description in the registry index must byte-match the package. Re-check on every update and flag description changes between versions.
6. Every URL anywhere in the package goes into a URL inventory. For each one record the host, whether it is a raw-content host (raw.githubusercontent, gist, pastebin, IP literals, URL shorteners, punycode), whether it points at a mutable git ref or a commit SHA, and whether the surrounding prose tells the agent to fetch, read or follow it (a verb window around fetch, curl, WebFetch, read, follow, download, install, run).
Sources: https://code.claude.com/docs/en/skills ; https://agentskills.io/specification ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise ; https://code.claude.com/docs/en/memory ; https://learn.chatgpt.com/docs/build-skills ; https://code.claude.com/docs/en/plugin-marketplaces

### Codex surface: skills with an openai.yaml sidecar, the portable Agent Plugins manifest with an extensions.com.openai block, hash-trusted hooks, and AGENTS.md [medium]
Skills:
- They are discovered in .agents/skills from the current directory up to the repo root, in $HOME/.agents/skills, in /etc/codex/skills, and among the built-in system skills.
- Symlinked skill folders are supported, and skills with the same name are not merged.
- SKILL.md needs name and description.
- The optional agents/openai.yaml has interface {display_name, short_description, icon_small, icon_large, brand_color, default_prompt}, policy.allow_implicit_invocation (default true) and dependencies.tools[] {type: mcp, value, description, transport, url}.
- Skills can be disabled through [[skills.config]] path and enabled = false in ~/.codex/config.toml.
- The current docs list .agents/skills rather than .codex/skills. AgentPM scans .codex/skills, so the adapter should be re-checked against the current docs.

Plugins:
- The docs now recommend the portable Agent Plugins format. A root plugin.json carries the $schema https://agent-plugins.org/schemas/1.0.0/plugin.schema.json and the fields name, version, description, author, homepage, repository, license and keywords.
- Fixed discovery paths are skills/ and mcp.json.
- OpenAI-specific data sits under extensions.com.openai: apps pointing to ./.app.json, hooks pointing to ./hooks/hooks.json, and interface {displayName, shortDescription, longDescription, developerName, category, capabilities, websiteURL, privacyPolicyURL, termsOfServiceURL, defaultPrompt[], brandColor, composerIcon, logo, screenshots}.
- .codex-plugin/plugin.json remains as a 'compatibility fallback'. It applies when extensions.com.openai is absent.
- What a plugin can bundle: skills, MCP servers, apps or connectors, and hooks. The docs do not list agents or commands as plugin components.
- interface.capabilities, for example ["Read","Write"], is self-declared display metadata and is not enforced. A scanner should compare it with the capabilities it actually detects.
- defaultPrompt is a string the UI suggests to the user, which makes it an injection surface.

Hooks:
- They can be set in ~/.codex/hooks.json, inline [hooks] in config.toml, <repo>/.codex/hooks.json, and plugin hooks/hooks.json.
- Handler types are command and MCP tool.
- Events are SessionStart, SessionEnd, UserPromptSubmit, Stop, Interrupt, PreToolUse, PermissionRequest, PostToolUse, SubagentStart, SubagentStop, PreCompact and PostCompact.
- Hooks can block, inject additionalContext and rewrite updatedInput.
- The docs say, verbatim: 'Installing or enabling a plugin doesn't automatically trust its hooks... Codex skips them until the user reviews and trusts the current hook definition' and trust is recorded 'against the hook's current hash'.
- Plugin hooks receive PLUGIN_ROOT, PLUGIN_DATA, CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA.

AGENTS.md:
- Global: ~/.codex/AGENTS.override.md, then AGENTS.md.
- Project: one file per directory from the repo root down to the current directory, in the order AGENTS.override.md, AGENTS.md, then project_doc_fallback_filenames. Files are concatenated up to project_doc_max_bytes, default 32 KiB.
- If an installed package drops an AGENTS.md or AGENTS.override.md anywhere on that path, it becomes always-on instructions.

Deterministic checks:
- Flag any AGENTS.md, AGENTS.override.md, CLAUDE.md, CLAUDE.local.md, .claude/rules/*, .claude/settings*.json, .codex/config.toml, .codex/hooks.json or .mcp.json inside a skill or plugin payload as 'ambient config injection'. Refuse to write such files outside the package's own directory.
- Parse openai.yaml and list dependencies.tools URLs as remote MCP endpoints.
- Flag allow_implicit_invocation: true combined with a broad description.
- Diff interface.capabilities against the detected capabilities.
Sources: https://learn.chatgpt.com/docs/build-skills ; https://developers.openai.com/codex/plugins/build ; https://learn.chatgpt.com/docs/hooks ; https://learn.chatgpt.com/docs/extend/mcp?surface=cli ; https://learn.chatgpt.com/docs/agent-configuration/agents-md ; https://learn.chatgpt.com/docs/agent-configuration/subagents ; https://agent-plugins.org/

### Agent Plugins Specification 1.0.0 gives normative rules a scanner can adopt as-is [high]
The technical steering committee of agentplugins/agent-plugins-spec has members from Amazon, Cursor, Microsoft, OpenAI and Vercel. Version 1.0.0 is published and 1.1.0 is a draft. The repo has about 1.3k stars and was last pushed on 2026-08-19.

Rules relevant here:
- Path containment applies after filesystem resolution. Symlinks, junctions and reparse points may resolve inside the plugin root, but 'clients MUST reject package paths that resolve outside it'.
- Unknown top-level manifest fields are reported and ignored. Any other schema violation is fatal, and the client 'MUST NOT discover or execute any of its components'.
- Clients MUST NOT retrieve a schema while loading a plugin. Validation is offline.
- mcp.json may appear only at the plugin root and never inline.
- A stdio command 'MUST contain a single executable token, not a shell command string', and must be either a bare name or a ./ plugin-relative path. There is no placeholder expansion in command. A plugin that bundles an executable MUST use a plugin-relative command.
- A remote url MUST be absolute http or https, with no user info and no fragment. 'Non-loopback endpoints MUST use HTTPS'. There is no env expansion in url or headers.
- 'Plugins MUST NOT embed credentials or other secrets in headers' or in env. Configured headers must not be forwarded to a different origin on redirect.
- env must not set PLUGIN_ROOT or PLUGIN_DATA.
- ${PLUGIN_ROOT} and ${PLUGIN_DATA} expansion is a single pass and non-recursive.
- Skills are discovered only as immediate children of skills/, with no recursive search.

The spec defines no hashing, signing or pinning, and no marketplace format. Hooks, agents, commands and LSP servers are out of scope for v1. Integrity and consent remain AgentPM's job.

The spec's own example still shows "command": "npx". An unpinned package runner therefore conforms to the spec, and AgentPM policy has to catch it.

Reuse: vendor the two JSON Schemas (plugin.schema.json and the mcp schema) and implement the containment and URL rules in TypeScript. This also prepares AgentPM for a third plugin layout, a root plugin.json, next to .claude-plugin/ and .codex-plugin/.
Sources: https://github.com/agentplugins/agent-plugins-spec ; https://agent-plugins.org/ ; https://developers.openai.com/codex/plugins/build

### Rug pull and TOCTOU: host behaviours that make changes after review take effect, and the host precedents for hash-bound consent [high]
Anthropic states the threat directly: 'Skills that fetch data from external URLs pose particular risk, as fetched content may contain malicious instructions. Even trustworthy Skills can be compromised if their external dependencies change over time.' Its enterprise guidance says: 'Pin Skills to specific versions... Treat every update as a new deployment requiring full security review... Compute checksums of reviewed Skills and verify them at deployment time. Use signed commits.'

Host behaviours that turn a change after review into live behaviour:
1. Live change detection. SKILL.md edits under ~/.claude/skills, .claude/skills and --add-dir directories are picked up within the current session.
2. A skill directory 'can be a symlink to a directory elsewhere on disk', and Claude reads SKILL.md from the link target. AgentPM links installs into agent directories. If the link target is a git cache checkout, any later fetch, checkout or update of that cache changes the live skill with no install event.
3. Third-party marketplaces do not auto-update by default, but official and claude.ai ones do. A ref-based source follows its branch or tag. Command sources re-run every session.
4. A plugin with a 'command' source in link mode, and any local-directory marketplace, load in place.
5. MCP list_changed updates tools mid-session, and remote MCP content is never pinned.
6. ! commands and hooks are evaluated on every run, so a referenced URL is fetched fresh each time.
7. Agent memory (MEMORY.md) is mutable state that is auto-injected into the system prompt.

Host precedents for binding consent to a digest:
- Claude Code 'claude plugin install --accept-command <sha256>'. The docs say the acceptance counts for exactly that command, plugin and marketplace catalog, and if any of them changed the command is shown again.
- Archive sources carry a sha256, git sources carry a sha, and the community marketplace pins plugins to commit SHAs.
- Codex records hook trust 'against the hook's current hash, so new or changed hooks are marked for review and skipped until trusted'.

What this means for AgentPM:
a) Compute a canonical tree digest over a sorted file list with normalised paths, modes and contents, with symlinks recorded as link entries and never followed. Store it in the manifest or lockfile, and verify it at install, sync, update and doctor time, and again when the link is created.
b) Compute a separate capability digest over the normalised capability manifest. If it changes on update, force a re-prompt that shows the diff (new hook, new MCP server, a widened allowed-tools, a new URL host). The content digest may change without a prompt only under an explicit policy.
c) Link agent directories to an immutable, content-addressed store keyed by the digest, not to a mutable git working tree.
d) Resolve git refs to a 40-hex SHA at install time and record it. Refuse floating refs in agentpm.yaml under a strict policy. agentpm.yaml already has a 'revision' field.
e) The registry server recomputes the digest on upload and makes name@version immutable. A tarball can never be replaced, only yanked.
f) Treat every external reference that cannot be pinned (a remote MCP server, a fetched URL, npx @latest) as a standing risk. Label it, apply host allowlist policy, and keep it on a separate consent line.
Sources: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise ; https://code.claude.com/docs/en/skills ; https://code.claude.com/docs/en/plugins-reference ; https://code.claude.com/docs/en/plugin-marketplaces ; https://code.claude.com/docs/en/discover-plugins ; https://code.claude.com/docs/en/mcp ; https://learn.chatgpt.com/docs/hooks

### Anthropic's official vetting checklist maps onto deterministic rule classes [high]
The enterprise skills guide has a risk-indicator table and an 8-step checklist. They can seed the rule catalogue.

Indicators and their ratings:
- Code execution: scripts such as *.py, *.sh and *.js. High.
- Instruction manipulation. High.
- MCP server references written as 'ServerName:tool_name'. High.
- Network access patterns: URLs, fetch, curl, requests. High.
- Hardcoded credentials. High.
- Filesystem access scope: paths outside the skill directory, broad globs, ../. Medium.
- Tool invocations. Medium.

The checklist adds:
- 'Consider the combined risk when a Skill uses both file-read and network tools together'. This is a toxic-combination rule: reading secrets or files together with any network egress escalates to critical.
- 'Confirm redirect destinations'. This covers URL shorteners and open redirects, so flag known shortener hosts.
- 'Verify no data exfiltration patterns... including through Claude's conversational responses'. This covers Markdown image beacons and links with data in the query string.

Deterministic mapping:
- A file-type inventory that includes shebangs, executable bits and magic bytes, to find binaries disguised by extension and archives inside archives.
- A secret scanner that combines entropy checks with known token regexes.
- URL and network-API grep across scripts, covering http(s), requests, urllib, fetch, axios, curl, wget, nc, socket, Invoke-WebRequest and dns.
- Path rules for ../, ~, /etc, $HOME, .ssh, .aws, .env, .git/config, .claude and .codex.
- Extraction of tool names and bash commands from prose code fences.
- Combination rules.

Anthropic also runs 'Skill and plugin security scanning' for Enterprise uploads on claude.ai and Cowork. A skill that fails the scan is blocked, a skill with a warning stays usable behind a caution notice, and the scan does not cover the API or Claude Code filesystem skills. The community marketplace submission pipeline runs 'claude plugin validate' and 'automated safety screening'. Neither is available to a third-party package manager as an offline library, so AgentPM has to build its own.

The pass / warn / block model with a caution notice is a useful template for the user experience.
Sources: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise ; https://code.claude.com/docs/en/plugins

### What a pre-install capability summary should contain, modelled on mobile app permissions [medium]
The closest host precedent is Claude Code's /plugin details pane. It shows a 'Will install' section listing commands, agents, skills, hooks, and MCP and LSP servers, together with a context cost and a last-updated date. For custom marketplaces it often shows only 'Components will be discovered at installation', which means no real disclosure. AgentPM can do better because it has the files in hand.

Proposed summary, fully deterministic and also emitted as JSON for CI:

- Identity and provenance: name and kind (skill, plugin or agent), target host, source locator, the resolved commit SHA or archive sha256, the tree digest, publisher or registry, whether the name matches the directory, the manifest and the registry entry, and the declared license.

- Runs code on your machine:
  - hooks: event, type and verbatim command or URL
  - ! pre-model commands, verbatim
  - bundled scripts and binaries: count, languages and any executables
  - bin/ PATH entries, with collisions against common tools highlighted
  - monitors, LSP servers, workflows and headersHelper
  - package.json dependencies: count and whether a lockfile is present

- Connects to or talks to:
  - MCP servers: name, transport, command plus pinned or unpinned package, or the remote host
  - http hook hosts
  - every URL host referenced in instructions, with raw-content, shortener and IP hosts highlighted
  - Codex apps and connectors

- Pre-approves or changes permissions:
  - allowed-tools, verbatim, with unrestricted Bash, Write or WebFetch highlighted
  - disallowed-tools
  - agent permissionMode, and agents with no tools allowlist (inherits all, including MCP)
  - Codex sandbox_mode

- Changes the agent's core instructions: output styles with force-for-plugin, settings.agent (main-thread takeover), always-on descriptions (length plus heuristic flags), agent memory, initialPrompt, and ambient files such as AGENTS.md, CLAUDE.md and rules.

- Asks you for secrets: userConfig with sensitive: true, and the env variable names that servers and hooks reference.

- Can change after you approve, as a dedicated MUTABLE section: unpinned git refs, @latest or unversioned package runners, remote MCP servers, URLs that the instructions tell the agent to fetch, command sources, symlinks (with their targets), plugin dependencies that are not pinned, and the auto-update status.

- Hidden content: invisible or bidi Unicode, HTML comments, large encoded blobs, link text that differs from its target.

- Verdict: pass, warn or block per policy, listing the rule IDs that fired.

- On update: a diff against the previously approved capability manifest. Only capability changes re-prompt, for example '+ new hook SessionStart -> ./scripts/x.sh', '+ allowed-tools widened: Bash(git *) -> Bash(*)' or '+ new host: evil.example'.

A clean skill should collapse to a single line ('instructions only: no code, no network references, no tool pre-approvals') so the prompt stays meaningful. Non-interactive mode (CI, sync) must fail closed on anything above the configured tier unless the capability digest is already approved in agentpm.yaml or the lockfile.
Sources: https://code.claude.com/docs/en/discover-plugins ; https://code.claude.com/docs/en/plugins-reference ; https://platform.claude.com/docs/en/agents-and-tools/agent-skills/enterprise

### AgentPM today scores trust only from the source host and the presence of install scripts. inspectRepository is the natural place to extend [high]
calculateTrust() in D:\DevProjects\private\agentpm\packages\adapters\src\index.ts (around lines 630-667) starts at 100, subtracts 20 for non-GitHub HTTP hosts, 10 for non-standard URLs and 30 if any custom install script is detected, and marks a source trusted at 80 or above.

None of the capability surface above is inspected: frontmatter, ! commands, hooks, MCP, bin/, monitors, agents, output styles, marketplace source mutability, symlinks, Unicode.

Plugin detection keys on .claude-plugin/plugin.json and .codex-plugin/plugin.json (adapters index.ts ~112-160, core registry-client.ts ~147 and ~222). It therefore misses:
- Claude plugins without a manifest. The docs say plugin.json is optional and default directories are auto-discovered.
- The new root-level plugin.json of the Agent Plugins portable format.
- Codex's current .agents/skills discovery path, which should be checked against the adapter's .codex/skills markers.

A 'public GitHub repository' currently gets a full score, although GitHub hosting says nothing about content safety or ref mutability.

Recommendation, in line with CLAUDE.md ('add modular helpers instead of widening service.ts'): create a new packages/security (or packages/scan). It should export a pure function scanPackage(dir) that returns {capabilities, findings, treeDigest, capabilityDigest}. Call it from inspectRepository on the install, update, sync and pull paths, from the registry-client publish path, and from the registry server's upload handler.
Sources: https://code.claude.com/docs/en/plugins-reference ; https://developers.openai.com/codex/plugins/build ; https://learn.chatgpt.com/docs/build-skills