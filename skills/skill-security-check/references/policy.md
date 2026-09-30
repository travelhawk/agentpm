# Verdict policy and rule catalogue

Scanner version 0.1.0. Rule ids appear in the report's "Rule" column.

## Verdicts

| Verdict | Meaning                                                              | Exit code |
| ------- | -------------------------------------------------------------------- | --------- |
| PASS    | No known risk pattern. Not a safety certificate.                     | 0         |
| REVIEW  | A person must check the flagged items and approve this exact digest. | 1         |
| REJECT  | Do not install. No override inside the workflow.                     | 2         |

The worst finding decides the verdict. INFO findings never change it.

## Where the line sits

Two questions, asked in this order.

1. **Does this pattern have an honest use in a skill?** If not, it is a REJECT.
   Reverse shells, decode-and-run, browser credential theft, disabling
   antivirus, wiping a disk, exfiltrating secrets, pulling instructions from the
   web, disguised domains, raw-content hosts. These are near-zero false positive
   patterns, and they are the ones the gate exists for.
2. **Is this a real capability?** Then it is a REVIEW, and a person decides.
   Reaching the network, installing packages, running other programs, reading
   credential files, changing agent configuration.

Everything else is INFO: it appears in the report, it does not move the verdict.

A gate that rejects almost everything gets ignored, and an ignored gate protects
nothing. So capability alone does not block. `--strict` restores the older
all-or-nothing policy for anyone who wants it.

## The decision summary

Every report opens with a `## Decision summary` before the rule-level detail.
It exists so the REVIEW step is cheap enough to actually happen.

| Block                          | What it holds                                                                                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose                        | The skill's own `description`, sanitised and cut to two sentences. It is the author's claim, labelled as one, and never a finding.                                    |
| Size                           | Files, scripts, binaries, kilobytes.                                                                                                                                  |
| What it can do on this machine | One row per capability, worst first: the plain-language name, how many places, and up to three of them. Built from the finding categories, not from individual rules. |
| External addresses it names    | **One row per host**, worst first, capped at 20 with the rest in External references. Each row says what the skill does with that host and where.                     |
| Findings that need a decision  | Up to six, one per rule, in plain words with `file:line`.                                                                                                             |
| Next step                      | What to do with this verdict.                                                                                                                                         |

The host table is the main mitigation for external addresses. A domain the
scanner allows is still a party the skill involves, and the reader is the one
who knows whether that party belongs to the job.

## External addresses

The question is not which file an address sits in. It is whether the skill acts
on it. `--strict` collapses the whole table back to REJECT.

| Severity | Rule               | When                                                                                                                                                                                                                                                 |
| -------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REJECT   | `url-obfuscated`   | Hidden in base64, hex, percent or char-code encoding, split string pieces, reversed strings, or written with disguised dots (`vendor[.]com`, `vendor(dot)com`, `vendor。com`).                                                                       |
| REJECT   | `url-mutable-host` | A host that exists to hand raw bytes to a machine: `raw.githubusercontent.com`, gists, pastebins, URL shorteners, tunnels. Naming one in prose is an invitation to fetch it, so the context makes no difference.                                     |
| REJECT   | `url-mutable-host` | A moving branch ref on an ordinary host (`/blob/main/`, `/archive/refs/heads/`, `/releases/latest`) **that the skill fetches**. A `/blob/` link renders a page for a person, so a bare mention is not enough.                                        |
| REVIEW   | `url-fetched`      | The skill acts on the address: it is fetched or loaded, sits in a script, a JSON/YAML/TOML config file or the frontmatter, shares a line with a `net-*` or `remote-*` finding, or is a connection target (`IP:port`, `git@host:owner/repo`, `.git`). |
| REVIEW   | `url-fetched`      | A mention of a host that is fetched **anywhere else** in the same skill. One fetch taints every mention, or a skill could fetch a domain in a script and "merely mention" it in the prose to look harmless.                                          |
| REVIEW   | `url-destination`  | An address named as a place to send things: "send the results to …", "upload it to …". "Upload the game to itch.io" has the same shape as "send the files to evil.example", and only a person knows which one is the job.                            |
| INFO     | `url-contact`      | Attribution. A full URL needs a licence or contact file **and** a copyright/author/SPDX line **and** a plain-text context; a bare domain or e-mail needs only the line, since neither is a fetch target. Licence hosts always qualify.               |
| INFO     | `url-doc-link`     | A plain mention or documentation link that the skill never reaches. It is still in the address table.                                                                                                                                                |

Attribution is checked before the taint, because a taint is only as precise as a
host name. A skill that fetches one `github.com` URL would otherwise flag the
copyright line of every font licence it ships.

Exempt, reported as INFO: `localhost`, `127.x`, `*.test`, `*.example`,
`*.invalid`, `*.local`, `example.com/.org/.net` and their subdomains,
single-label placeholder hosts such as `https://host/`, JSON `$schema`, and XML
namespace URIs — both by prefix (`xmlns=`, `targetNamespace=`) and by host
(`schemas.openxmlformats.org`, `w3.org`, `purl.org`, …), because one Office
document carries dozens and no parser fetches them.

## REJECT: attack tooling

| Rule                                                                                            | What it catches                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec-reverse-shell`                                                                            | `nc -e`, `bash -i >&`, `pty.spawn`, `TCPClient`, meterpreter, msfvenom.                                                                                         |
| `exec-decode-run`                                                                               | Decoding base64 or hex and piping the result into a shell or `eval`.                                                                                            |
| `exec-destructive-root`                                                                         | Wiping a disk, a home folder or the backup catalogue.                                                                                                           |
| `exec-security-off`                                                                             | Turning off Defender, the firewall, SELinux, Gatekeeper or SIP; stripping the quarantine attribute.                                                             |
| `cred-browser`                                                                                  | Browser login databases and cookie stores, wallets, `lsass`, mimikatz.                                                                                          |
| `net-lolbin`                                                                                    | `bitsadmin`, `certutil -urlcache`, `mshta`, `regsvr32 /i:` — download helpers with no honest use in a skill.                                                    |
| `net-dev-tcp`                                                                                   | `/dev/tcp` shell network redirection.                                                                                                                           |
| `unicode-tags`, `unicode-vs-*`, `unicode-bidi`, `unicode-zero-width`, `unicode-terminal-escape` | Invisible tag characters, variation-selector runs, bidi overrides (Trojan Source), zero-width characters inside words, terminal escapes.                        |
| `hidden-*`                                                                                      | Any network, dependency, execution or injection pattern found inside an HTML comment, invisible text or decoded data. Hidden text gets no benefit of the doubt. |
| `bin-executable-*`, `bin-magic-mismatch`                                                        | Native executables, bytecode, shortcuts, macro documents, and files whose content does not match their extension.                                               |
| `fs-symlink-escape`, `fs-special-file`, `fs-name-hidden-chars`                                  | Links that leave the skill, device files, and file names with invisible characters.                                                                             |
| `av-threat`                                                                                     | A working antivirus engine detected malware.                                                                                                                    |
| `git-file-missing`                                                                              | A file is in the Git tree but not on disk, for example because the antivirus quarantined it.                                                                    |
| `file-unreadable`                                                                               | A file could not be read.                                                                                                                                       |
| `scan-incomplete`                                                                               | The sandboxed analysis timed out (120 s, possibly crafted input), crashed, or was blocked from reading part of the skill. The gate fails closed.                |

## REJECT: data leaving, instructions arriving

| Rule                   | What it catches                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `remote-exfil`         | "Send / upload / post / forward … to a server, endpoint, webhook, URL, domain, site, API, inbox, pastebin, gist, bucket, Discord, Telegram …". The sink vocabulary is what makes it unambiguous. |
| `remote-exfil-secrets` | Sending `.env`, SSH keys, credentials, API keys, tokens, passwords, cookies or wallets anywhere.                                                                                                 |
| `remote-instructions`  | Loading instructions, rules, prompts, checklists, policies or scripts from the web, a server, a URL, a domain or "online", or "the latest rules from …". This is dynamic prompt injection.       |

A prohibition such as "never send files to an external server" lowers these to
REVIEW, never to PASS: the wording could be a trick.

## REJECT: dependencies whose content can still change

| Rule                                                       | What it catches                                                                                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dep-untrusted-source`, `dep-name-invalid`, `dep-poisoned` | A URL, a git target, a tarball, a custom index, a path leaving the skill, a container tag with no digest, or a name that cannot legally be that package. See `trust.md`.                       |
| `dep-registry-override`                                    | `.npmrc`, `pip.conf`, `uv.toml`, `NuGet.config` or a `config set registry` command. Every package in the skill becomes REJECT, because a redirected index changes what every name resolves to. |
| `dep-install-hook`                                         | Lifecycle scripts that run on install.                                                                                                                                                         |

Package installs that are pinned, or pinned loosely, land on INFO or REVIEW
instead. `trust.md` has the full class table, the pin grammar per ecosystem, and
the trust override file.

## REVIEW: needs a person

Capability, not malice. These are the rows the decision summary is built for.

| Rule                                                                                                                    | What it catches                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `net-*`                                                                                                                 | `curl`, `wget`, PowerShell web cmdlets, `git clone/fetch/pull`, `ssh/scp`, `nc host port`, `fetch()`, Node `http.get`, Python `requests`/`urllib`/`socket`, .NET `WebClient`, prose telling the agent to use WebFetch or WebSearch. |
| `remote-web-lookup`                                                                                                     | Taking guidance from live web content: "search the web … and follow", "look up … online".                                                                                                                                           |
| `md-dynamic-command`                                                                                                    | `` !`cmd` `` context commands. The host runs them when the skill loads, before the model sees the skill.                                                                                                                            |
| `exec-*` (other)                                                                                                        | `eval`, shell execution, `child_process`, deserialisation, `sudo`, turning off agent permission prompts.                                                                                                                            |
| `persist-*`                                                                                                             | Cron jobs, autostart entries, shell profile writes, agent or editor configuration changes.                                                                                                                                          |
| `cred-*` (other)                                                                                                        | Reads of SSH keys, cloud credentials, OS credential stores, environment dumps.                                                                                                                                                      |
| `inject-*`                                                                                                              | Prompt-injection phrases in visible text: overriding instructions, hiding actions from the user, covert actions, role spoofing, skipping safety checks, self-updating instructions.                                                 |
| `secret-*`                                                                                                              | Bundled private keys, tokens or credential files.                                                                                                                                                                                   |
| `fm-webfetch`, `fm-bash-network`, `fm-bash-unrestricted`, `fm-hooks`, `fm-mcp-tool`, `fm-websearch`                     | `allowed-tools` entries that pre-approve web fetches, network commands, broad shell access or hooks without a prompt.                                                                                                               |
| `mcp-server`, `fm-mcp`, `plugin-*`, `bundled-*`                                                                         | MCP server definitions, plugin manifests, hooks, `bin/`, LSP servers, bundled agent settings, bundled `CLAUDE.md` or `AGENTS.md`.                                                                                                   |
| `dep-agent-install`                                                                                                     | Commands that install further skills, plugins or MCP servers. What they pull was never scanned.                                                                                                                                     |
| `dep-remote-import`, `dep-git-submodule`, `dep-git-lfs`                                                                 | `npm:`/`jsr:` import specifiers, submodules, LFS pointers.                                                                                                                                                                          |
| `dep-registry-pinned-scripts`, `dep-trusted-unpinned`, `dep-unknown-name`, `dep-executes-fetched`, `dep-name-near-miss` | Package installs whose content is not fully nailed down. See `trust.md`.                                                                                                                                                            |
| `dep-ambient-install`                                                                                                   | `npm install`, `uv sync`, `bundle install` with no file named: installs the dependencies of whatever project the agent is standing in.                                                                                              |
| `dep-manifest-missing`                                                                                                  | Installs from a file it names, such as `pip install -r requirements.txt`, when that file is not in the skill. Usually the host project's manifest, occasionally not.                                                                |
| `dep-container-file`, `dep-js-vendored`, `dep-manifest-*`                                                               | Dockerfiles and compose files, vendored `node_modules`, and manifests the scanner cannot fully parse (`setup.py`, `Pipfile`, `pom.xml`, `Gemfile`, unhashed lockfiles).                                                             |
| `script-minified`                                                                                                       | A bundled or minified script. Nobody can review it by reading it, so it has to be judged by where it came from.                                                                                                                     |
| `bin-opaque`, `bin-unknown`                                                                                             | Archives, PDFs and office documents whose content was not analysed.                                                                                                                                                                 |
| `policy-override`                                                                                                       | The local trust override could not be used: unknown keys, wrong schema, a symlink, too large, or malformed JSON. Never a silent fallback.                                                                                           |
| `unicode-*` (other), `text-*`, `md-html-comment`                                                                        | Direction marks, filler characters, homoglyph words, long lines, blank-line padding, large encoded blobs, text in HTML comments.                                                                                                    |
| `av-none-working`                                                                                                       | The skill has scripts or binaries and no antivirus engine passed its canary test.                                                                                                                                                   |
| `no-skill-md`, `fs-*` (other)                                                                                           | Not a standard skill folder, symlinks inside the skill, unportable or colliding names, size limits.                                                                                                                                 |

A REVIEW pattern that appears inside a prohibition ("never pass `--yolo`") is downgraded to INFO. REJECT rules are never downgraded.

## Bare domains without a full URL

An agent reads a domain name as a place to go, so bare domains are collected the
same way full URLs are and land on the same severity ladder.

Common TLDs (`.com`, `.net`, `.org`, `.io`, `.ai`, `.dev` and others) count
anywhere. TLDs that also look like words (`.info`, `.me`, `.de`, `.to` and
others) count after "to", "from", "at", "visit", "fetch" and similar words. In
scripts, only strings and comments are checked, so `user.org` property access is
not flagged.

Known limits: TLDs that are also file extensions (`.md`, `.py`, `.sh`, `.zip`,
`.app`) are not treated as bare domains. Real product names such as `claude.ai`
or `itch.io` are treated like any other domain.

## Content digest, ruleset hash and policy hash

The **content digest** is SHA-256 over sorted lines of `<sha256 of file>  <posix path>`, one per file, with symlinks as `symlink:<sha256 of target>`. File modes and the `.git` folder are not part of it. The same bytes give the same digest on every OS.

The report footer adds two more hashes:

- **ruleset** — SHA-256 over `scan.mjs`, `remote-content.mjs`, `package-policy.mjs` and `trust-data.mjs` together. Hashing `scan.mjs` alone would let the parsers or the trust data change unnoticed.
- **policy** — SHA-256 over the effective trust data and the mode (`standard` or `strict`), after any local override was applied.

An approval binds to all three. If the skill's bytes, the rules, or the policy change, the skill needs a new decision.

## Modes and flags

| Flag             | Effect                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `--strict`       | Every external address rejects, and `unknown-name` and `executes-fetched` packages reject. Trust-override additions are ignored. |
| `--trust <file>` | Load the trust override from this path instead of `$AGENTPM_HOME/skill-trust.json` or `~/.agentpm/skill-trust.json`.             |
| `--no-trust`     | Ignore any override and use the bundled trust data only.                                                                         |
| `--no-av`        | Skip the antivirus step. A skill with scripts or binaries then gets at most REVIEW.                                              |
| `--summary`      | One line per skill instead of full reports. Useful over a folder of skills.                                                      |
| `--json`         | Machine-readable results, including `description`, `capabilities` and `hosts` from the decision summary.                         |
| `--no-sandbox`   | Run the static analysis in-process instead of in the permission-model child. For debugging.                                      |
