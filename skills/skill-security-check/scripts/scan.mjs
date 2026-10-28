
// skill-security-check scanner: a static, offline pre-install check for agent skills.
//
// It reads bytes and text only. It never executes, imports or renders the
// scanned content and never opens a network connection. The only child
// processes are local antivirus engines, the bundled engine (tiny-av.mjs)
// and `git ls-tree` on a checkout.
//
// Usage: node scan.mjs <path> [--json] [--summary] [--single] [--no-av]
//                             [--no-sandbox] [--strict] [--trust <file>] [--no-trust]
// The static analysis runs in a child process under Node's permission model.
// Exit codes: 0 PASS, 1 REVIEW, 2 REJECT, 3 usage or internal error.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  TRUST_SCHEMA_VERSION,
  displaySpec,
  importToDistribution,
  nameSimilarity,
  normalizeName,
  parseInstallCommand,
  parseManifest,
  resolveDependencies,
} from './package-policy.mjs';
import {
  CONTACT_FILE_RE,
  CONTACT_LINE_RE,
  REMOTE_RULES,
  findDomains,
} from './remote-content.mjs';
import { BUNDLED_TRUST, trustedKeys } from './trust-data.mjs';

const SCANNER_VERSION = '0.1.0';
const REJECT = 'reject';
const REVIEW = 'review';
const INFO = 'info';
const RANK = { [INFO]: 0, [REVIEW]: 1, [REJECT]: 2 };
const VERDICT = { 0: 'PASS', 1: 'REVIEW', 2: 'REJECT' };

const LIMITS = {
  maxFiles: 5000,
  maxTextBytes: 4 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxLineChars: 20000,
  maxBlankRun: 60,
  // Hand-written code wraps. A line past this is a bundler's output.
  minifiedLineLength: 1000,
  maxDepth: 24,
  maxLinesPerFinding: 5,
};

// ---------------------------------------------------------------------------
// File type tables
// ---------------------------------------------------------------------------

const MARKDOWN_EXTS = new Set([
  '.md',
  '.mdx',
  '.markdown',
  '.txt',
  '.rst',
  '.adoc',
]);
const JS_EXTS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
]);
const PY_EXTS = new Set(['.py', '.pyw']);
const SCRIPT_EXTS = new Set([
  ...JS_EXTS,
  ...PY_EXTS,
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ksh',
  '.nu',
  '.ps1',
  '.psm1',
  '.psd1',
  '.bat',
  '.cmd',
  '.vbs',
  '.vbe',
  '.wsf',
  '.js',
  '.rb',
  '.pl',
  '.pm',
  '.php',
  '.lua',
  '.r',
  '.go',
  '.rs',
  '.swift',
  '.kt',
  '.kts',
  '.java',
  '.cs',
  '.csx',
  '.fsx',
  '.groovy',
  '.tcl',
  '.awk',
  '.applescript',
  '.ahk',
]);
// Config is code. A URL in JSON, YAML or TOML is read by a tool and acted on, so
// it never earns the leniency a link in prose does.
const CONFIG_EXTS = new Set([
  '.json',
  '.jsonc',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
]);
const TEXT_EXTS = new Set([
  ...MARKDOWN_EXTS,
  ...SCRIPT_EXTS,
  '.json',
  '.jsonc',
  '.json5',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.xml',
  '.html',
  '.htm',
  '.svg',
  '.css',
  '.scss',
  '.csv',
  '.tsv',
  '.env',
  '.lock',
  '.sql',
  '.graphql',
  '.tex',
  '.properties',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
]);
// Extensions that are executable, bytecode or shell-integrated. Never reviewable as text.
const EXECUTABLE_EXTS = new Map([
  ['.exe', 'Windows executable'],
  ['.dll', 'Windows library'],
  ['.sys', 'Windows driver'],
  ['.scr', 'Windows screensaver executable'],
  ['.com', 'DOS executable'],
  ['.cpl', 'control panel item'],
  ['.ocx', 'ActiveX control'],
  ['.msi', 'Windows installer'],
  ['.msix', 'Windows app package'],
  ['.appx', 'Windows app package'],
  ['.so', 'shared library'],
  ['.dylib', 'macOS library'],
  ['.bin', 'raw binary'],
  ['.elf', 'ELF binary'],
  ['.o', 'object file'],
  ['.a', 'static library'],
  ['.lib', 'static library'],
  ['.node', 'native Node.js addon'],
  ['.pyc', 'Python bytecode'],
  ['.pyo', 'Python bytecode'],
  ['.pyd', 'Python native extension'],
  ['.class', 'Java bytecode'],
  ['.jar', 'Java archive'],
  ['.war', 'Java archive'],
  ['.wasm', 'WebAssembly module'],
  ['.apk', 'Android package'],
  ['.ipa', 'iOS package'],
  ['.deb', 'Debian package'],
  ['.rpm', 'RPM package'],
  ['.pkg', 'installer package'],
  ['.dmg', 'disk image'],
  ['.iso', 'disk image'],
  ['.lnk', 'Windows shortcut'],
  ['.url', 'Internet shortcut'],
  ['.scf', 'shell command file'],
  ['.hta', 'HTML application'],
  ['.chm', 'compiled help'],
  ['.gadget', 'Windows gadget'],
  ['.xll', 'Excel add-in'],
  ['.xlam', 'Excel add-in'],
  ['.docm', 'macro-enabled document'],
  ['.xlsm', 'macro-enabled workbook'],
  ['.pptm', 'macro-enabled presentation'],
]);
// Magic label each extension must carry.
const EXPECTED_MAGIC = new Map([
  ['.png', 'png'],
  ['.jpg', 'jpeg'],
  ['.jpeg', 'jpeg'],
  ['.gif', 'gif'],
  ['.webp', 'webp'],
  ['.ico', 'ico'],
  ['.bmp', 'bmp'],
  ['.pdf', 'pdf'],
  ['.zip', 'zip'],
  ['.docx', 'zip'],
  ['.xlsx', 'zip'],
  ['.pptx', 'zip'],
  ['.odt', 'zip'],
  ['.ods', 'zip'],
  ['.gz', 'gzip'],
  ['.tgz', 'gzip'],
  ['.7z', '7z'],
  ['.rar', 'rar'],
  ['.bz2', 'bzip2'],
  ['.xz', 'xz'],
  ['.ttf', 'font'],
  ['.otf', 'font'],
  ['.woff', 'font'],
  ['.woff2', 'font'],
  ['.mp3', 'audio'],
  ['.wav', 'audio'],
  ['.ogg', 'audio'],
  ['.mp4', 'video'],
  ['.mov', 'video'],
]);
const EXECUTABLE_MAGIC = new Set([
  'pe',
  'elf',
  'macho',
  'java-class-or-macho-fat',
  'wasm',
]);
const OPAQUE_MAGIC = new Set([
  'zip',
  'gzip',
  'bzip2',
  'xz',
  '7z',
  'rar',
  'tar',
  'pdf',
  'ole',
]);
const MEDIA_MAGIC = new Set([
  'png',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'font',
  'audio',
  'video',
]);

const PY_STDLIB = new Set(
  `__future__ abc aifc annotationlib antigravity argparse array ast asynchat
asyncio asyncore atexit audioop base64 bdb binascii bisect builtins bz2 cProfile calendar cgi
cgitb chunk cmath cmd code codecs codeop collections colorsys compileall compression concurrent
configparser contextlib contextvars copy copyreg crypt csv ctypes curses dataclasses datetime dbm
decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl
filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob
graphlib grp gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io
ipaddress itertools json keyword lib2to3 linecache locale logging lzma mailbox mailcap marshal
math mimetypes mmap modulefinder msilib msvcrt multiprocessing netrc nis nntplib nt ntpath
nturl2path numbers opcode operator optparse os ossaudiodev pathlib pdb pickle pickletools pipes
pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr
pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy
sched secrets select selectors shelve shlex shutil signal site smtplib sndhdr socket socketserver
spwd sqlite3 sre_compile sre_constants sre_parse ssl stat statistics string stringprep struct
subprocess sunau symtable sys sysconfig syslog tabnanny tarfile telnetlib tempfile termios
textwrap this threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc
tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave weakref
webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo`.split(
    /\s+/,
  ),
);

// ---------------------------------------------------------------------------
// Line rules. Every rule runs on every text line, including Markdown, because
// the agent executes commands it reads in SKILL.md prose.
// ---------------------------------------------------------------------------

const rule = (id, severity, category, re, message) => ({
  id,
  severity,
  category,
  re,
  message,
});
// Matches global options such as "-c key=value", "-C dir", "--prefix dir" or "--quiet".
const OPTS = String.raw`(?:-{1,2}[\w.-]+(?:=\S+)?\s+(?:[^\s-]\S*\s+)??)*`;
const withOpts = (source, flags = '') =>
  new RegExp(source.replaceAll('{OPTS}', OPTS), flags);

// Reaching the network is a capability, not proof of malice: a skill that
// calls an API is doing its job. These rules say "this skill can talk to the
// outside" and hand the decision to a person. Only the tools with no honest
// use in a skill stay REJECT: the download helpers attackers use to stay off
// the radar, and raw sockets.
const NETWORK_RULES = [
  rule(
    'net-cli',
    REVIEW,
    'network',
    /\b(?:curl|wget|aria2c)(?:\.exe)?\s+\S/i,
    'Downloads or sends data with a network CLI',
  ),
  rule(
    'net-powershell',
    REVIEW,
    'network',
    /\b(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|iwr|irm)\b/i,
    'PowerShell network request',
  ),
  rule(
    'net-lolbin',
    REJECT,
    'network',
    /\bbitsadmin\b|\bcertutil\b[^\n]*-urlcache|\bmshta\b|\bregsvr32\b[^\n]*\/i:/i,
    'Windows download helper (living-off-the-land binary)',
  ),
  rule(
    'net-socket-cli',
    // `nc host port` also writes a metric to statsd. The form with no honest
    // use is `nc -e` or `nc -c`, and exec-reverse-shell keeps the REJECT there.
    REVIEW,
    'network',
    /\b(?:nc|ncat|netcat|socat|telnet)\s+(?:-[\w-]+\s+)*[\w.-]+\s+\d{1,5}\b/,
    'Raw socket connection with a network tool',
  ),
  rule(
    'net-dev-tcp',
    REJECT,
    'network',
    /\/dev\/(?:tcp|udp)\//,
    'Bash network redirection (/dev/tcp)',
  ),
  rule(
    'net-git-remote',
    REVIEW,
    'network',
    withOpts(
      String.raw`\bgit\s+{OPTS}(?:clone|fetch|pull|submodule|ls-remote|remote\s+add|archive\s+--remote)\b`,
      'i',
    ),
    'Fetches a remote Git repository',
  ),
  rule(
    'net-ssh',
    REVIEW,
    'network',
    /\b(?:ssh|scp|sftp)\s+(?:-[\w-]+\s+)*[\w.-]+@[\w.-]+/,
    'Connects to a remote host over SSH',
  ),
  rule(
    'net-js-fetch',
    REVIEW,
    'network',
    /(?<![.\w$])fetch\s*\((?!\s*["'`](?:\.{0,2}\/|#))|\b(?:window|globalThis|self)\.fetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bnavigator\.sendBeacon\b|\bEventSource\s*\(/,
    'Makes an HTTP request from JavaScript',
  ),
  rule(
    'net-js-module',
    REVIEW,
    'network',
    /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"](?:node:)?(?:https?|http2|net|dgram|tls|dns)['"]/,
    'Imports a Node.js network module (check whether it only serves locally)',
  ),
  rule(
    'net-js-client',
    REVIEW,
    'network',
    /\bhttps?\.(?:get|request)\s*\(|\bnet\.(?:connect|createConnection)\s*\(|\bnew\s+net\.Socket\b|\btls\.connect\s*\(|\bdgram\.createSocket\s*\(/,
    'Opens an outgoing network connection from Node.js',
  ),
  rule(
    'net-js-lib',
    REVIEW,
    'network',
    /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"](?:axios|node-fetch|undici|got|superagent|request|ws|socket\.io-client|ky)['"]/,
    'Imports an HTTP client library',
  ),
  rule(
    'net-python',
    REVIEW,
    'network',
    // `socket.socket(socket.AF_UNIX, …)` is a local pipe, not a network call.
    // LibreOffice and other local helpers use it, so it is excluded by name.
    /\brequests\.(?:get|post|put|patch|delete|head|request|Session)\b|\bhttpx\.|\baiohttp\b|\burllib\.request\b|\burlopen\s*\(|\burllib3\b|\bhttp\.client\b|\bsocket\.(?:socket|create_connection)\s*\((?![^)\n]*AF_UNIX)|\b(?:ftplib|smtplib|telnetlib|paramiko|pycurl)\b|\bwebbrowser\.open/,
    'Makes a network request from Python',
  ),
  rule(
    'net-dotnet',
    REVIEW,
    'network',
    /\bNet\.WebClient\b|\bDownload(?:String|File|Data)(?:Async)?\b|\bHttpClient\b|\bSystem\.Net\.Sockets\b|\bNet\.Sockets\.TCPClient\b/i,
    'Makes a network request from .NET or PowerShell',
  ),
  rule(
    'net-other-lang',
    REVIEW,
    'network',
    /\bNet::HTTP\b|\bopen-uri\b|\bURI\.open\b|\bhttp\.(?:Get|Post|NewRequest)\s*\(|\bLWP::UserAgent\b|\bfile_get_contents\s*\(\s*['"]https?:/,
    'Makes a network request (Ruby, Go, Perl or PHP)',
  ),
  rule(
    'net-agent-fetch',
    REVIEW,
    'network',
    /\b(?:WebFetch|web_fetch|fetch_url|read_url)\b/,
    'Tells the agent to fetch web content',
  ),
  rule(
    'net-agent-search',
    REVIEW,
    'network',
    /\b(?:WebSearch|web_search)\b/,
    'Tells the agent to search the web',
  ),
];

const DEPENDENCY_RULES = [
  // Install commands and manifests are handled by the dependency pass, which
  // decides once per package instead of once per line. What stays here is the
  // things that are not a package from a registry.
  rule(
    'dep-remote-import',
    REVIEW,
    'dependency',
    /['"](?:npm|jsr):[@\w]/,
    'Imports a package straight from a registry specifier',
  ),
  rule(
    'dep-agent-install',
    REVIEW,
    'dependency',
    /\b(?:claude|codex|gemini)\s+(?:mcp|plugins?)\s+(?:add|install)\b|\b(?:agentpm|skills)\s+(?:install|add|sync|pull)\b|\/plugin\s+(?:install|marketplace\s+add)\b/,
    'Installs further skills, plugins or MCP servers (transitive dependency)',
  ),
];

const EXEC_RULES = [
  rule(
    'exec-pipe-shell',
    REVIEW,
    'execution',
    /\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b(?!\S)|\|\s*(?:python3?|node|perl|ruby|php)\s*(?:-\s*)?$|\|\s*(?:iex|Invoke-Expression)\b/i,
    'Pipes data straight into an interpreter',
  ),
  rule(
    'exec-eval',
    REVIEW,
    'execution',
    /\beval\s*\(|\bnew\s+Function\s*\(|\bInvoke-Expression\b|\biex\s*[($]|\bexec\s*\(\s*(?:compile|base64|bytes|open|requests|urllib)|\b__import__\s*\(|\bimportlib\.import_module\s*\(|\bimport\s*\(\s*[^'"`\s)]/i,
    'Evaluates dynamically built code',
  ),
  rule(
    'exec-shell-true',
    REVIEW,
    'execution',
    /\bshell\s*=\s*True\b|\bos\.system\s*\(|\bos\.popen\s*\(|\bsubprocess\.(?:getoutput|getstatusoutput)\s*\(/,
    'Runs shell commands from Python',
  ),
  rule(
    'exec-child-process',
    REVIEW,
    'execution',
    /\bchild_process\b|\b(?:execSync|spawnSync|execFileSync)\s*\(|\bBun\.spawn\b|\bDeno\.(?:Command|run)\b/,
    'Starts other programs from JavaScript',
  ),
  rule(
    'exec-deserialize',
    REVIEW,
    'execution',
    /\bpickle\.loads?\s*\(|\bmarshal\.loads\s*\(|\byaml\.load\s*\((?![^)]*Loader\s*=\s*yaml\.SafeLoader)|\bctypes\.(?:CDLL|WinDLL|windll|cdll)\b/,
    'Loads code or native libraries at run time',
  ),
  rule(
    'exec-destructive-root',
    REJECT,
    'destructive',
    /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME|\/\*|~\/\*)(?:\s|$|;)|\bmkfs(?:\.\w+)?\s|\bdd\s+[^\n]*of=\/dev\/(?:sd|nvme|disk|hd)|\bformat\s+[a-z]:\s*\/|\bRemove-Item\b[^\n]*-Recurse[^\n]*(?:\b[A-Z]:\\\s*$|\$env:USERPROFILE\s*$|\$HOME\s*$)|\bdiskpart\b|\bvssadmin\s+delete\b|\bwbadmin\s+delete\b/i,
    'Destroys a whole disk, home folder or backups',
  ),
  rule(
    'exec-privilege',
    REVIEW,
    'privilege',
    /\bsudo\s+\w|\bchmod\s+(?:-R\s+)?(?:777|[ug]?\+s)\b|\bSet-ExecutionPolicy\b|\brunas\s+\/|\bStart-Process\b[^\n]*-Verb\s+RunAs/i,
    'Raises privileges or weakens file permissions',
  ),
  rule(
    'exec-security-off',
    REJECT,
    'defense-evasion',
    /\bSet-MpPreference\b[^\n]*-Disable|\bAdd-MpPreference\b[^\n]*-Exclusion|\bnetsh\s+advfirewall\s+set\b[^\n]*off|\bsetenforce\s+0\b|\bspctl\s+--master-disable\b|\bcsrutil\s+disable\b|\bxattr\s+-d\s+com\.apple\.quarantine\b|\bUnblock-File\b/i,
    'Turns off antivirus, firewall or OS protection',
  ),
  rule(
    'exec-agent-guardrails-off',
    REVIEW,
    'defense-evasion',
    /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|\bbypassPermissions\b|--yolo\b|\bdisableSkillShellExecution\b|--no-sandbox\b/i,
    'Turns off agent permission prompts or sandboxing',
  ),
  rule(
    'exec-reverse-shell',
    REJECT,
    'remote-control',
    /\bbash\s+-i\s*>&|\bnc(?:at)?\b[^\n]*\s-[a-z]*[ec]\s|\bsocket\.socket\([^\n]*\)[^\n]*\bconnect\(|\bos\.dup2\s*\([^\n]*fileno|\bpty\.spawn\s*\(|\bmkfifo\b[^\n]*\bnc\b|New-Object\s+System\.Net\.Sockets\.TCPClient|\bmeterpreter\b|\bmsfvenom\b/i,
    'Reverse shell or remote control pattern',
  ),
  rule(
    'exec-decode-run',
    REJECT,
    'obfuscation',
    /(?:base64\s+(?:-d|--decode|-D)|\bb64decode\b|\batob\s*\(|FromBase64String|Buffer\.from\([^)]*['"]base64['"]|\bxxd\s+-r|\bopenssl\s+(?:enc\s+)?-d)[^\n]*(?:\|\s*(?:ba|z)?sh\b|\beval\b|\bexec\b|\biex\b|Invoke-Expression|\bFunction\s*\(|os\.system|subprocess)/i,
    'Decodes hidden data and runs it',
  ),
];

const PERSISTENCE_RULES = [
  rule(
    'persist-autostart',
    REVIEW,
    'persistence',
    /\bcrontab\s+(?:-[a-z]\s+)*[^\s-]|\bcrontab\s+-e\b|CurrentVersion\\Run(?:Once)?\b|\bschtasks\b[^\n]*\/create|\bRegister-ScheduledTask\b|\blaunchctl\s+(?:load|bootstrap|enable)\b|LaunchAgents\/|LaunchDaemons\/|\bsystemctl\s+(?:--user\s+)?enable\b|Start Menu\\Programs\\Startup|\\Startup\\/i,
    'Registers something to run automatically later',
  ),
  rule(
    'persist-shell-profile',
    REVIEW,
    'persistence',
    />>?\s*(?:~|\$HOME|\$\{HOME\})\/\.(?:bashrc|zshrc|profile|bash_profile|zprofile|zshenv|config\/fish\/config\.fish)\b|\$PROFILE\b[^\n]*(?:Add-Content|Set-Content|Out-File|>>)/i,
    'Writes to a shell startup file',
  ),
  rule(
    'persist-agent-config',
    REVIEW,
    'agent-config',
    // skill-trust.json and agentpm.yaml security keys are in here because a
    // skill that talks the agent into widening the scanner's own trust list is
    // attacking the gate rather than passing it.
    /\.claude[\\/](?:settings(?:\.local)?\.json|hooks|agents|commands|skills|plugins)\b|\.claude\.json\b|\.codex[\\/](?:config\.toml|skills|agents)\b|\.gemini[\\/]settings\.json|\.cursor[\\/]mcp\.json|\.vscode[\\/](?:settings|mcp|tasks)\.json|\bmcp_servers\b|\bmcpServers\b|\bskill-trust\.json\b|\bsecurity\.(?:mode|allowDomains|allowPackages|trust)\b/i,
    'Reads or changes agent or editor configuration',
  ),
];

const CREDENTIAL_RULES = [
  rule(
    'cred-paths',
    REVIEW,
    'credentials',
    /(?:~|\$HOME|%USERPROFILE%|\$env:USERPROFILE|\/home\/\w+|\/Users\/\w+)[\\/]\.(?:ssh|aws|azure|gnupg|kube|docker|config[\\/]gcloud|config[\\/]gh)\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|\.git-credentials\b|\.netrc\b|\.pypirc\b|\.aws[\\/]credentials\b/i,
    'Reads credential or key files',
  ),
  rule(
    'cred-os-store',
    REVIEW,
    'credentials',
    /\bsecurity\s+(?:find|dump)-(?:generic-password|internet-password|keychain)\b|\bcmdkey\s+\/list\b|\bvaultcmd\b|\bGet-StoredCredential\b|\bsecret-tool\s+lookup\b|\/etc\/shadow\b|\bkeyring\.get_password\b/i,
    'Reads the OS credential store',
  ),
  rule(
    'cred-browser',
    REJECT,
    'credentials',
    /(?:Chrome|Chromium|Edge|Brave|Firefox|Opera)[^\n]*(?:Login Data|Cookies|Web Data|Local State|key4\.db|logins\.json)|\bwallet\.dat\b|\bmimikatz\b|\blsass(?:\.exe|\.dmp)?\b|\bsekurlsa\b/i,
    'Targets browser secrets, wallets or system credentials',
  ),
  rule(
    'cred-env-dump',
    REVIEW,
    'credentials',
    /JSON\.stringify\(\s*process\.env\s*\)|\bjson\.dumps\(\s*(?:dict\()?os\.environ|\bprintenv\s*(?:\||>|$)|\benv\s*\|\s*(?:curl|nc|base64)|\bGet-ChildItem\s+env:|\bdir\s+env:/i,
    'Dumps all environment variables (often holds API keys)',
  ),
];

const INJECTION_RULES = [
  rule(
    'inject-override',
    REVIEW,
    'prompt-injection',
    /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:(?:the|your)\s+)?(?:previous|prior|above|earlier|system|original|other)\s+(?:instructions?|prompts?|rules?|messages?|guidelines?|context)/i,
    'Tries to override earlier or system instructions',
  ),
  rule(
    'inject-conceal',
    REVIEW,
    'prompt-injection',
    /\b(?:do\s+not|don't|never)\s+(?:tell|inform|mention|reveal|show|notify|alert|disclose\s+to)\s+(?:this\s+(?:to\s+)?)?(?:the\s+)?(?:user|human|operator|developer)\b|\bwithout\s+(?:asking|telling|informing|notifying|the\s+knowledge\s+of)\s+(?:the\s+)?(?:user|human)\b|\bhide\s+(?:this|it|the\s+\w+)\s+from\s+(?:the\s+)?user\b/i,
    'Tells the agent to hide actions from the user',
  ),
  rule(
    'inject-stealth',
    REVIEW,
    'prompt-injection',
    /\b(?:silently|secretly|covertly|quietly|discreetly)\s+(?:run|execute|send|upload|post|install|download|copy|delete|modify|forward|exfiltrate|add|write)\b|\bexfiltrat/i,
    'Asks for hidden or covert actions',
  ),
  rule(
    'inject-role',
    REVIEW,
    'prompt-injection',
    /<\/?(?:system|assistant|im_start|im_end)>|<\|im_(?:start|end)\|>|\[\/?(?:INST|SYSTEM)\]|\byou\s+are\s+now\s+(?:in\s+)?(?:developer|admin|god|jailbreak|unrestricted|DAN)\b|\bnew\s+system\s+prompt\b/i,
    'Spoofs chat roles or tries a jailbreak',
  ),
  rule(
    'inject-safety-off',
    REVIEW,
    'prompt-injection',
    /\b(?:bypass|disable|turn\s+off|ignore|skip)\s+(?:the\s+|all\s+|any\s+)?(?:safety|security|guardrails?|sandbox(?:ing)?|permission\s+(?:checks?|prompts?)|confirmations?)\b|\b(?:always|automatically)\s+(?:approve|accept|allow|grant)\b/i,
    'Asks the agent to skip safety checks or approvals',
  ),
  rule(
    'inject-self-update',
    REVIEW,
    'prompt-injection',
    /\b(?:update|replace|overwrite|refresh)\s+(?:this|the|your)\s+(?:skill|instructions|SKILL\.md)\b|\b(?:latest|current)\s+(?:instructions|version\s+of\s+(?:this|the)\s+skill)\s+(?:from|at)\b/i,
    'Self-updating instructions (content can change after review)',
  ),
];

const SECRET_RULES = [
  rule(
    'secret-private-key',
    REVIEW,
    'secret',
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/,
    'Bundles a private key',
  ),
  rule(
    'secret-token',
    REVIEW,
    'secret',
    /\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bsk-ant-[A-Za-z0-9_-]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|\bAIza[0-9A-Za-z_-]{35}\b|\bglpat-[A-Za-z0-9_-]{20,}|\bnpm_[A-Za-z0-9]{36}\b/,
    'Bundles an API token',
  ),
];

const LINE_RULES = [
  ...NETWORK_RULES,
  ...DEPENDENCY_RULES,
  ...EXEC_RULES,
  ...PERSISTENCE_RULES,
  ...CREDENTIAL_RULES,
  ...INJECTION_RULES,
  ...SECRET_RULES,
];

const NEGATION_RE =
  /\b(?:never|not|don't|do\s+not|must\s+not|avoid|without|instead\s+of|refuse|forbid(?:den)?|prohibit(?:ed)?)\b/i;

// Rules re-run on text recovered from a hidden channel. Any hit there is a REJECT.
const HIDDEN_CHANNEL_RULES = [
  ...REMOTE_RULES,
  ...NETWORK_RULES,
  ...DEPENDENCY_RULES,
  ...EXEC_RULES,
  ...INJECTION_RULES,
];

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

const URL_RE =
  /\b(?:https?|ftps?|wss?|git|ssh|sftp|smb|s3|gs|hxxps?|file):\/\/[^\s"'<>`)\]}\\|]*/gi;
const SSH_GIT_RE = /\bgit@[a-z0-9.-]+\.[a-z]{2,}:[\w./~-]+/gi;
const PROTO_REL_RE =
  /\b(?:src|href|action|url)\s*[=(]\s*["']?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const WWW_RE =
  /(?<![\w@./-])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s"'<>`)\]}]*)?/gi;
const BARE_HOST_PATH_RE =
  /(?<![\w@./:-])[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63})*\.(?:com|net|org|io|dev|app|ai|co|xyz|me|gg|ly|cc|ru|cn|top|site|online|link|info|biz|st|to|tk|cloud|page|so|run|gd|sh)\/[\w./%?=&#~+-]*/g;
const IP_PORT_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}\b/g;
const REVERSED_URL_RE = /\/\/:s?ptth/i;
const IDENTIFIER_PREFIX_RE =
  /(?:xmlns(?::[\w-]+)?\s*=\s*["']|\b(?:target)?[Nn]amespace\s*=\s*["']|["']\$schema["']\s*:\s*["']|\$schema:\s*["']?|<!DOCTYPE[^>]*["']|\brdf:about\s*=\s*["'])$/i;

// XML, XSD and RDF use http URLs as names. No parser fetches them, and one
// Office document carries dozens, so the host settles it without a prefix.
const IDENTIFIER_URL_RE =
  /^(?:https?:\/\/)?(?:schemas\.openxmlformats\.org|schemas\.microsoft\.com|(?:www\.)?w3\.org|purl\.org|xmlns\.com|docbook\.org|schemas\.xmlsoap\.org|relaxng\.org|docs\.oasis-open\.org|ns\.adobe\.com|json-schema\.org|spec\.openapis\.org|(?:www\.)?iso\.org)\//i;

function urlHost(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url);
  let host = m ? m[1] : url.replace(/^git@/i, '').split(/[:/]/)[0];
  host = host.replace(/^[^@]*@/, '').toLowerCase();
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.replace(/:.*$/, '');
}

// Hosts that cannot resolve on the internet: single labels such as 'host' or '${HOST}'.
function isPlaceholderHost(host) {
  return !host.includes('.') && !host.startsWith('[');
}

function isLocalHost(host) {
  const h = host.replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    /^127\.\d+\.\d+\.\d+$/.test(h) ||
    /\.(?:test|example|invalid|local)$/.test(h) ||
    /(?:^|\.)example\.(?:com|org|net)$/.test(h) ||
    h === 'example'
  );
}

function isPrivateIp(host) {
  return /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/.test(
    host,
  );
}

function findUrls(text) {
  const out = [];
  const push = (re, kind) => {
    re.lastIndex = 0;
    for (const m of text.matchAll(re))
      out.push({ value: m[0], index: m.index, kind });
  };
  push(URL_RE, 'url');
  push(SSH_GIT_RE, 'git-ssh');
  push(PROTO_REL_RE, 'protocol-relative');
  push(WWW_RE, 'bare-host');
  push(BARE_HOST_PATH_RE, 'bare-host');
  push(IP_PORT_RE, 'ip-port');
  // Drop matches nested inside a longer match (for example the host part of a full URL).
  out.sort((a, b) => a.index - b.index || b.value.length - a.value.length);
  const kept = [];
  let end = -1;
  for (const u of out) {
    if (u.index < end) continue;
    kept.push(u);
    end = u.index + u.value.length;
  }
  return kept.map((u) => ({
    ...u,
    value: u.value.replace(/[.,;:!?*_~]+$/, ''),
  }));
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

class Findings {
  constructor() {
    this.map = new Map();
    this.refs = new Map();
  }

  add({
    rule: id,
    severity,
    category,
    file = '',
    line = 0,
    message,
    evidence = '',
  }) {
    const key = `${id}\u0000${file}\u0000${message}`;
    const existing = this.map.get(key);
    if (existing) {
      existing.count += 1;
      if (
        line &&
        existing.lines.length < LIMITS.maxLinesPerFinding &&
        !existing.lines.includes(line)
      )
        existing.lines.push(line);
      return;
    }
    this.map.set(key, {
      rule: id,
      severity,
      category,
      file,
      lines: line ? [line] : [],
      count: 1,
      message,
      evidence: sanitize(evidence),
    });
  }

  ref(kind, value, file, line) {
    const key = `${kind}\u0000${value}`;
    const entry = this.refs.get(key) ?? {
      kind,
      value: sanitize(value, 200),
      locations: [],
    };
    if (entry.locations.length < 5)
      entry.locations.push(line ? `${file}:${line}` : file);
    this.refs.set(key, entry);
  }

  list() {
    return sortFindings([...this.map.values()]);
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function invisibleClass(cp) {
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'tag';
  if (cp >= 0xe0100 && cp <= 0xe01ef) return 'variation-selector-supplement';
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 'variation-selector';
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069))
    return 'bidi';
  if (cp === 0x200e || cp === 0x200f || cp === 0x061c) return 'bidi-mark';
  if (
    cp === 0x200b ||
    cp === 0x2060 ||
    (cp >= 0x2061 && cp <= 0x2064) ||
    cp === 0x180e ||
    cp === 0xfeff
  )
    return 'zero-width';
  if (cp === 0x200c || cp === 0x200d) return 'zero-width-joiner';
  if (
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x3164 ||
    cp === 0xffa0 ||
    cp === 0x2800
  )
    return 'blank-filler';
  if (cp === 0x00ad) return 'soft-hyphen';
  if (cp === 0x1b || cp === 0x9b) return 'terminal-escape';
  if ((cp < 0x20 && cp !== 0x09) || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f))
    return 'control';
  return null;
}

function sanitize(value, max = 140) {
  let out = '';
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0);
    out +=
      invisibleClass(cp) && cp !== 0x09
        ? `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`
        : ch;
    if (out.length > max) {
      out = `${out.slice(0, max)}…`;
      break;
    }
  }
  return out.replace(/`/g, "'");
}

function snippet(line, index = 0, length = 0) {
  const start = Math.max(0, index - 50);
  const end = Math.min(line.length, index + Math.max(length, 1) + 70);
  return `${start > 0 ? '…' : ''}${line.slice(start, end).trim()}${end < line.length ? '…' : ''}`;
}

const isAsciiAlnum = (cp) =>
  (cp >= 0x30 && cp <= 0x39) ||
  (cp >= 0x41 && cp <= 0x5a) ||
  (cp >= 0x61 && cp <= 0x7a);

function printableRatio(s) {
  if (!s.length) return 0;
  let ok = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if ((c >= 0x20 && c < 0x7f) || c === 0x0a || c === 0x0d || c === 0x09)
      ok += 1;
  }
  return ok / s.length;
}

// Returns readable text hidden in encoded runs on a line (base64, hex, percent, char codes).
function decodeHiddenRuns(line) {
  const found = [];
  const consider = (decoded, how, depth) => {
    if (decoded.length < 6 || printableRatio(decoded) < 0.9) return;
    found.push({ text: decoded, how });
    if (depth < 2)
      for (const inner of decodeHiddenRuns(decoded))
        found.push({ text: inner.text, how: `${how} > ${inner.how}` });
  };
  for (const m of line.matchAll(/[A-Za-z0-9+/_-]{20,}={0,2}/g)) {
    const raw = m[0];
    if (/^[0-9a-f]+$/i.test(raw) || !/[A-Z]/.test(raw) || !/[a-z]/.test(raw))
      continue;
    const std = raw.replace(/-/g, '+').replace(/_/g, '/');
    consider(Buffer.from(std, 'base64').toString('latin1'), 'base64', 1);
  }
  for (const m of line.matchAll(/(?:\\x[0-9a-fA-F]{2}){6,}/g)) {
    consider(
      m[0].replace(/\\x([0-9a-fA-F]{2})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      ),
      'hex escapes',
      1,
    );
  }
  for (const m of line.matchAll(/(?:\\u00[0-9a-fA-F]{2}){6,}/g)) {
    consider(
      m[0].replace(/\\u00([0-9a-fA-F]{2})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      ),
      'unicode escapes',
      1,
    );
  }
  for (const m of line.matchAll(/(?:%[0-9a-fA-F]{2}){6,}/g)) {
    try {
      consider(decodeURIComponent(m[0]), 'percent encoding', 1);
    } catch {
      /* not decodable */
    }
  }
  for (const m of line.matchAll(/(?:fromCharCode|chr)\s*\(([\d\s,]{10,})\)/g)) {
    const codes = m[1]
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => n > 0 && n < 0x110000);
    consider(String.fromCharCode(...codes), 'char codes', 1);
  }
  for (const m of line.matchAll(/\b(?:[01]{8}\s?){6,}/g)) {
    const bytes = m[0].replace(/\s/g, '').match(/[01]{8}/g) ?? [];
    consider(
      bytes.map((b) => String.fromCharCode(parseInt(b, 2))).join(''),
      'binary digits',
      1,
    );
  }
  return found;
}

// Joins string literals split with + or . so that "ht" + "tps://x" becomes one string.
function joinSplitStrings(line) {
  return line.replace(/(["'`])\s*(?:\+|\.\.?|\s)\s*(["'`])/g, '');
}

function parseFrontmatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!m) return null;
  const fields = new Map();
  let current = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const key = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw);
    if (key) {
      current = key[1].toLowerCase();
      fields.set(current, key[2]);
    } else if (current && /^\s+/.test(raw)) {
      fields.set(current, `${fields.get(current)}\n${raw}`);
    }
  }
  return { fields, lineCount: m[0].split(/\r?\n/).length - 1 };
}

// ---------------------------------------------------------------------------
// Binary sniffing
// ---------------------------------------------------------------------------

function sniff(buf) {
  const b = (i) => buf[i];
  const ascii = (start, s) =>
    buf.length >= start + s.length &&
    buf.toString('latin1', start, start + s.length) === s;
  if (ascii(0, 'MZ')) return 'pe';
  if (b(0) === 0x7f && ascii(1, 'ELF')) return 'elf';
  const u32 = buf.length >= 4 ? buf.readUInt32BE(0) : 0;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(u32))
    return 'macho';
  if (u32 === 0xcafebabe) return 'java-class-or-macho-fat';
  if (ascii(0, '\0asm')) return 'wasm';
  if (ascii(0, 'PK\x03\x04') || ascii(0, 'PK\x05\x06')) return 'zip';
  if (b(0) === 0x1f && b(1) === 0x8b) return 'gzip';
  if (ascii(0, 'BZh')) return 'bzip2';
  if (ascii(0, '\xfd7zXZ\0')) return 'xz';
  if (ascii(0, "7z\xbc\xaf'\x1c")) return '7z';
  if (ascii(0, 'Rar!')) return 'rar';
  if (ascii(257, 'ustar')) return 'tar';
  if (ascii(0, '%PDF')) return 'pdf';
  if (u32 === 0xd0cf11e0) return 'ole';
  if (ascii(0, '\x89PNG')) return 'png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpeg';
  if (ascii(0, 'GIF8')) return 'gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  if (ascii(0, 'RIFF') && ascii(8, 'WAVE')) return 'audio';
  if (ascii(0, 'BM')) return 'bmp';
  if (u32 === 0x00000100) return 'ico';
  if (
    u32 === 0x00010000 ||
    ascii(0, 'OTTO') ||
    ascii(0, 'wOFF') ||
    ascii(0, 'wOF2') ||
    ascii(0, 'true')
  )
    return 'font';
  if (
    ascii(0, 'ID3') ||
    ascii(0, 'OggS') ||
    (b(0) === 0xff && (b(1) & 0xe0) === 0xe0)
  )
    return 'audio';
  if (ascii(4, 'ftyp')) return 'video';
  return null;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Tree walk
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED =
  /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i;

function walk(root, findings) {
  const entries = [];
  const stack = [{ rel: '', depth: 0 }];
  const seenNames = new Map();
  while (stack.length) {
    const { rel, depth } = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let names;
    try {
      names = fs.readdirSync(abs).sort();
    } catch (error) {
      findings.add({
        rule: 'fs-unreadable-dir',
        severity: REVIEW,
        category: 'unanalysable',
        file: rel || '.',
        message: `Folder could not be read (${error.code ?? error.message})`,
      });
      continue;
    }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = path.join(abs, name);
      checkName(name, childRel, findings, seenNames);
      let st;
      try {
        st = fs.lstatSync(childAbs);
      } catch (error) {
        findings.add({
          rule: 'fs-unreadable',
          severity: REVIEW,
          category: 'unanalysable',
          file: childRel,
          message: `Entry could not be read (${error.code ?? error.message})`,
        });
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = '';
        try {
          target = fs.readlinkSync(childAbs);
        } catch {
          /* dangling or unreadable link */
        }
        entries.push({ rel: childRel, abs: childAbs, type: 'symlink', target });
      } else if (st.isDirectory()) {
        if (name === '.git' && rel === '') {
          entries.push({ rel: childRel, abs: childAbs, type: 'gitdir' });
          continue;
        }
        if (depth + 1 > LIMITS.maxDepth) {
          findings.add({
            rule: 'fs-too-deep',
            severity: REVIEW,
            category: 'unanalysable',
            file: childRel,
            message: `Folder nesting deeper than ${LIMITS.maxDepth} levels was not scanned`,
          });
          continue;
        }
        stack.push({ rel: childRel, depth: depth + 1 });
      } else if (st.isFile()) {
        entries.push({
          rel: childRel,
          abs: childAbs,
          type: 'file',
          size: st.size,
        });
      } else {
        findings.add({
          rule: 'fs-special-file',
          severity: REJECT,
          category: 'filesystem',
          file: childRel,
          message: 'Special file (device, socket or FIFO)',
        });
      }
    }
  }
  return entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function checkName(name, rel, findings, seenNames) {
  if ([...name].some((ch) => invisibleClass(ch.codePointAt(0)))) {
    findings.add({
      rule: 'fs-name-hidden-chars',
      severity: REJECT,
      category: 'filesystem',
      file: rel,
      message: 'File name contains control or invisible characters',
      evidence: name,
    });
  }
  if (
    WINDOWS_RESERVED.test(name) ||
    /[. ]$/.test(name) ||
    /[<>:"|?*]/.test(name)
  ) {
    findings.add({
      rule: 'fs-name-unportable',
      severity: REVIEW,
      category: 'filesystem',
      file: rel,
      message: 'File name is reserved or invalid on Windows',
      evidence: name,
    });
  }
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const folded = `${dir}/${name.normalize('NFC').toLowerCase()}`;
  const other = seenNames.get(folded);
  if (other && other !== rel) {
    findings.add({
      rule: 'fs-name-collision',
      severity: REVIEW,
      category: 'filesystem',
      file: rel,
      message: `Name differs only by case or Unicode form from ${other}`,
    });
  }
  seenNames.set(folded, rel);
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

function analyzeFile(entry, ctx) {
  const { findings } = ctx;
  const ext = path.extname(entry.rel).toLowerCase();
  const base = path.basename(entry.rel);
  let buf;
  try {
    buf = fs.readFileSync(entry.abs);
  } catch (error) {
    const hint = ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)
      ? '; an antivirus engine may have blocked it'
      : '';
    findings.add({
      rule: 'file-unreadable',
      severity: REJECT,
      category: 'unanalysable',
      file: entry.rel,
      message: `File could not be read (${error.code ?? error.message})${hint}`,
    });
    return;
  }
  entry.sha256 = createHash('sha256').update(buf).digest('hex');
  ctx.totalBytes += buf.length;

  const magic = sniff(buf);
  const expected = EXPECTED_MAGIC.get(ext);

  if (EXECUTABLE_EXTS.has(ext)) {
    findings.add({
      rule: 'bin-executable-ext',
      severity: REJECT,
      category: 'binary',
      file: entry.rel,
      message: `${EXECUTABLE_EXTS.get(ext)} cannot be reviewed`,
    });
    ctx.binaries.push(entry.rel);
    return;
  }
  if (magic && EXECUTABLE_MAGIC.has(magic)) {
    findings.add({
      rule: 'bin-executable-magic',
      severity: REJECT,
      category: 'binary',
      file: entry.rel,
      message: `Native executable or bytecode (${magic}) cannot be reviewed`,
    });
    ctx.binaries.push(entry.rel);
    return;
  }
  if (
    expected &&
    magic !== expected &&
    !(expected === 'font' && magic === 'font')
  ) {
    findings.add({
      rule: 'bin-magic-mismatch',
      severity: REJECT,
      category: 'binary',
      file: entry.rel,
      message: `Extension ${ext} does not match content (${magic ?? (looksBinary(buf) ? 'unknown binary' : 'text')})`,
    });
    return;
  }
  if (magic && OPAQUE_MAGIC.has(magic)) {
    findings.add({
      rule: 'bin-opaque',
      severity: REVIEW,
      category: 'binary',
      file: entry.rel,
      message: `Archive or document (${magic}); its content was not analysed`,
    });
    ctx.binaries.push(entry.rel);
    return;
  }
  if (magic && MEDIA_MAGIC.has(magic)) {
    findings.add({
      rule: 'bin-media',
      severity: INFO,
      category: 'binary',
      file: entry.rel,
      message: `Media file (${magic})`,
    });
    return;
  }
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString('utf16le');
    findings.add({
      rule: 'text-utf16',
      severity: REVIEW,
      category: 'hidden-channel',
      file: entry.rel,
      message: 'UTF-16 text file (unusual for skills; many tools skip it)',
    });
  } else if (magic || looksBinary(buf)) {
    const sev = TEXT_EXTS.has(ext) ? REJECT : REVIEW;
    findings.add({
      rule: TEXT_EXTS.has(ext) ? 'bin-magic-mismatch' : 'bin-unknown',
      severity: sev,
      category: 'binary',
      file: entry.rel,
      message: TEXT_EXTS.has(ext)
        ? `Extension ${ext} promises text but the file is binary`
        : 'Unknown binary content was not analysed',
    });
    ctx.binaries.push(entry.rel);
    return;
  } else {
    text = buf.toString('utf8');
  }
  if (buf.length > LIMITS.maxTextBytes) {
    findings.add({
      rule: 'text-too-large',
      severity: REVIEW,
      category: 'unanalysable',
      file: entry.rel,
      message: `Text file larger than ${LIMITS.maxTextBytes / 1024 / 1024} MB was not analysed`,
    });
    return;
  }
  analyzeText(entry, text, ext, base, ctx);
}

function analyzeText(entry, text, ext, base, ctx) {
  const { findings } = ctx;
  const file = entry.rel;
  const lines = text.split(/\r\n|\n|\r/);
  const firstLine = lines[0] ?? '';
  const shebang = firstLine.startsWith('#!') ? firstLine : '';
  const isScript = SCRIPT_EXTS.has(ext) || Boolean(shebang);
  const isMarkdown = MARKDOWN_EXTS.has(ext);
  const isPython = PY_EXTS.has(ext) || /python/.test(shebang);
  const isJs = JS_EXTS.has(ext) || /\b(?:node|deno|bun|tsx)\b/.test(shebang);

  ctx.fileKind = isScript
    ? 'script'
    : CONFIG_EXTS.has(ext)
      ? 'config'
      : isMarkdown
        ? 'markdown'
        : 'other';
  // Frontmatter is parsed by the host, not read by a person, so a URL there is
  // acted on even though it sits in a Markdown file.
  ctx.frontmatterEnd = 0;
  if (isMarkdown && /^---\s*$/.test(firstLine)) {
    for (let i = 1; i < lines.length; i += 1)
      if (/^(?:---|\.\.\.)\s*$/.test(lines[i] ?? '')) {
        ctx.frontmatterEnd = i + 1;
        break;
      }
  }
  if (isScript) {
    ctx.scripts.push({
      file,
      lines: lines.length,
      language: scriptLanguage(ext, shebang),
      sha256: entry.sha256,
    });
    // Minified code defeats the review step, not the scanner: a person told to
    // read the file cannot. Say so, and name the source it should come with.
    const longest = lines.reduce((a, l) => Math.max(a, l.length), 0);
    if (longest >= LIMITS.minifiedLineLength && text.length >= 4096)
      findings.add({
        rule: 'script-minified',
        severity: REVIEW,
        category: 'unanalysable',
        file,
        line: 1,
        message: `Minified or generated code (${lines.length} lines, longest ${longest} characters): nobody can review this by reading it, so judge it by its source instead`,
        evidence: '',
      });
  }

  // Line pass: rules, URLs, hidden channels, Unicode.
  let blankRun = 0;
  let inFence = false;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/^\s*$/.test(line)) {
      blankRun += 1;
      if (blankRun === LIMITS.maxBlankRun)
        findings.add({
          rule: 'text-padding',
          severity: REVIEW,
          category: 'hidden-channel',
          file,
          line: n,
          message: `More than ${LIMITS.maxBlankRun} blank lines in a row (can push content out of view)`,
        });
      return;
    }
    blankRun = 0;
    if (line.length > LIMITS.maxLineChars) {
      findings.add({
        rule: 'text-long-line',
        severity: REVIEW,
        category: 'hidden-channel',
        file,
        line: n,
        message: `Line longer than ${LIMITS.maxLineChars} characters (minified, padded or embedded data)`,
      });
    }
    if (isMarkdown && /^\s*(?:```|~~~)/.test(line)) inFence = !inFence;

    // A URL on a line that also asks for network or exfiltration behaviour is
    // part of that behaviour, whatever file it sits in.
    let riskyLine = false;

    for (const r of LINE_RULES) {
      const m = r.re.exec(line);
      if (!m) continue;
      // A REVIEW pattern inside a prohibition ("never pass --yolo") is advice, not behaviour. REJECT rules stay strict.
      const negated =
        r.severity === REVIEW &&
        NEGATION_RE.test(line.slice(Math.max(0, m.index - 60), m.index));
      if (!negated && /^net-/.test(r.id)) riskyLine = true;
      findings.add({
        rule: r.id,
        severity: negated ? INFO : r.severity,
        category: r.category,
        file,
        line: n,
        message: negated ? `${r.message} (inside a prohibition)` : r.message,
        evidence: snippet(line, m.index, m[0].length),
      });
    }

    // Remote-content instructions: a prohibition ("never send files to a server")
    // drops to REVIEW, never lower, so wording tricks cannot make it pass.
    for (const r of REMOTE_RULES) {
      const m = r.re.exec(line);
      if (!m) continue;
      const negated = NEGATION_RE.test(
        line.slice(Math.max(0, m.index - 60), m.index),
      );
      if (!negated) riskyLine = true;
      findings.add({
        rule: r.id,
        severity: negated ? REVIEW : r.severity,
        category: r.category,
        file,
        line: n,
        message: negated ? `${r.message} (inside a prohibition)` : r.message,
        evidence: snippet(line, m.index, m[0].length),
      });
    }

    checkUrls(line, file, n, ctx, riskyLine);
    checkUnicode(line, file, n, ctx);
    checkEncoded(line, file, n, ctx);
    collectInstallCommands(line, file, n, ctx);

    if (isMarkdown && !inFence && /(?:^|[\s(])!`[^`\n]+`/.test(line)) {
      findings.add({
        rule: 'md-dynamic-command',
        severity: REVIEW,
        category: 'execution',
        file,
        line: n,
        message:
          'Dynamic context command: the host runs this shell command when the skill loads, before the model sees it',
        evidence: snippet(line),
      });
    }
    if (isMarkdown && /^\s*```!/.test(line)) {
      findings.add({
        rule: 'md-dynamic-command',
        severity: REVIEW,
        category: 'execution',
        file,
        line: n,
        message: 'Dynamic context block: the host runs it when the skill loads',
        evidence: snippet(line),
      });
    }
  });

  checkHtmlComments(text, file, isMarkdown, ctx);
  checkHomoglyphs(lines, file, ctx);
  if (isPython) checkPythonImports(lines, file, ctx);
  if (isJs) checkJsImports(text, file, ctx);
  checkManifest(base, ext, text, file, ctx);
  if (isMarkdown) checkFrontmatter(text, file, base, ctx);
  if (/^version https:\/\/git-lfs\.github\.com\/spec/.test(text)) {
    findings.add({
      rule: 'dep-git-lfs',
      severity: REJECT,
      category: 'dependency',
      file,
      line: 1,
      message: 'Git LFS pointer: the real content lives on a remote server',
    });
  }
}

function scriptLanguage(ext, shebang) {
  if (shebang) {
    const m = /#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?)?(?:\S*\/)?(\S+)/.exec(
      shebang,
    );
    if (m) return m[1];
  }
  return ext.slice(1) || 'unknown';
}

function checkUrls(line, file, n, ctx, riskyLine = false) {
  const { findings } = ctx;
  const seen = new Set();
  const base = file.split('/').pop() ?? file;
  const report = (u, how) => {
    const host =
      u.kind === 'ip-port' ? u.value.replace(/:\d+$/, '') : urlHost(u.value);
    if (!host || seen.has(u.value)) return;
    seen.add(u.value);
    const prefix = line.slice(0, u.index);
    if (
      !how &&
      (IDENTIFIER_PREFIX_RE.test(prefix) || IDENTIFIER_URL_RE.test(u.value))
    ) {
      findings.add({
        rule: 'url-identifier',
        severity: INFO,
        category: 'external-url',
        file,
        line: n,
        message: `Namespace or schema identifier (${host}); agents do not fetch it`,
        evidence: u.value,
      });
      return;
    }
    if (isPlaceholderHost(host)) {
      findings.add({
        rule: 'url-placeholder',
        severity: INFO,
        category: 'external-url',
        file,
        line: n,
        message: `Placeholder host (${host})`,
        evidence: u.value,
      });
      return;
    }
    if (isLocalHost(host)) {
      findings.add({
        rule: 'url-local',
        severity: INFO,
        category: 'external-url',
        file,
        line: n,
        message: `Local or reserved example host (${host})`,
        evidence: u.value,
      });
      return;
    }
    if (/^file:/i.test(u.value)) {
      findings.add({
        rule: 'url-file',
        severity: REVIEW,
        category: 'filesystem',
        file,
        line: n,
        message: 'file:// URL points outside the skill',
        evidence: u.value,
      });
      return;
    }
    if (u.kind === 'ip-port' && isPrivateIp(host)) {
      findings.add({
        rule: 'url-private-ip',
        severity: REVIEW,
        category: 'network',
        file,
        line: n,
        message: `Connection target on a private network (${host})`,
        evidence: u.value,
      });
      return;
    }
    if (how) {
      findings.ref('url', u.value, file, n);
      findings.add({
        rule: 'url-obfuscated',
        severity: REJECT,
        category: 'external-url',
        file,
        line: n,
        message: `External URL hidden with ${how} (${host})`,
        evidence: `${u.value}  <- decoded from: ${snippet(line)}`,
      });
      return;
    }
    // Severity depends on what the rest of the skill does with this host, so
    // the decision waits until the whole tree has been read.
    ctx.urlHits.push({
      kind: u.kind,
      value: u.value,
      host,
      file,
      base,
      line,
      lineNo: n,
      fileKind: ctx.fileKind,
      inFrontmatter: ctx.fileKind === 'markdown' && n <= ctx.frontmatterEnd,
      riskyLine,
      context: urlContext(line, u, ctx.fileKind),
      evidence: snippet(line, u.index, u.value.length),
    });
  };
  const urls = findUrls(line);
  for (const u of urls) report(u, null);
  // Bare domains, e-mail addresses and disguised domains outside full URLs.
  for (const d of findDomains(line, ctx.fileKind === 'script')) {
    if (
      urls.some(
        (u) =>
          d.index < u.index + u.value.length &&
          u.index < d.index + d.value.length,
      )
    )
      continue;
    const host = urlHost(d.value);
    if (d.how) {
      if (isLocalHost(host)) continue;
      findings.ref('domain', d.value, file, n);
      findings.add({
        rule: 'url-obfuscated',
        severity: REJECT,
        category: 'external-url',
        file,
        line: n,
        message: `External domain written with ${d.how} (${host})`,
        evidence: snippet(line, d.index, d.raw.length),
      });
      continue;
    }
    report(d, null);
  }
  const joined = joinSplitStrings(line);
  if (joined !== line) {
    const direct = new Set(findUrls(line).map((u) => u.value));
    for (const u of findUrls(joined))
      if (![...direct].some((d) => d.includes(u.value) || u.value.includes(d)))
        report({ ...u, index: 0 }, 'split string pieces');
  }
  if (REVERSED_URL_RE.test(line)) {
    findings.add({
      rule: 'url-obfuscated',
      severity: REJECT,
      category: 'external-url',
      file,
      line: n,
      message: 'Reversed URL string',
      evidence: snippet(line),
    });
  }
}

function urlContext(line, u, kind) {
  const before = line.slice(0, u.index);
  if (kind === 'script') return 'used in code';
  // `read`, `open`, `load`, `import` and `from` are ordinary English words, so
  // they only count when the address follows them directly. The unambiguous
  // verbs keep the wider window, because their flags sit in between.
  if (
    /(?:\b(?:curl|wget|fetch|WebFetch|iwr|Invoke-WebRequest|git\s+clone|download)\b[^\n]{0,40}|\b(?:read|open|load|import|from)\s+(?:the\s+)?|\b(?:src|<link\b[^>]*\bhref)\s*=\s*["']?)$/i.test(
      before,
    ) ||
    // "Read the rules at X", "Download the helper from X": the connecting
    // preposition is what turns the verb into an instruction about an address.
    /\b(?:read|open|load|fetch|download|get|retrieve|pull|consult|check|find)\b[^\n]{0,40}\b(?:at|from|on)\s+$/i.test(
      before,
    )
  )
    return 'fetched or loaded';
  // An address the skill names as a destination is exfiltration wording,
  // whichever file it sits in.
  if (
    /\b(?:send|sends|mail|e-?mail|post|posts|upload|uploads|submit|submits|report|reports|transmit|deliver|forward|push|sync|exfiltrate)\b[^\n]{0,40}\b(?:to|at|into)\s+$/i.test(
      before,
    )
  )
    return 'used as a destination';
  // `<a@b.com>` is the ordinary way to write an address, not a link.
  if (
    /\]\($|\bhref\s*=\s*["']?$/i.test(before) ||
    (u.kind !== 'email' && /<$/.test(before))
  )
    return 'documentation link';
  return 'mentioned in text';
}

function checkEncoded(line, file, n, ctx) {
  const { findings } = ctx;
  if (/[A-Za-z0-9+/]{1000,}/.test(line)) {
    findings.add({
      rule: 'text-encoded-blob',
      severity: REVIEW,
      category: 'obfuscation',
      file,
      line: n,
      message: 'Large encoded blob (1000+ characters) embedded in text',
    });
  }
  for (const hidden of decodeHiddenRuns(line)) {
    for (const u of [
      ...findUrls(hidden.text),
      ...findDomains(hidden.text, false),
    ]) {
      const host = urlHost(u.value);
      if (!host || isLocalHost(host)) continue;
      findings.ref('url', u.value, file, n);
      findings.add({
        rule: 'url-obfuscated',
        severity: REJECT,
        category: 'external-url',
        file,
        line: n,
        message: `External URL hidden with ${hidden.how} (${host})`,
        evidence: `${u.value}  <- decoded from: ${snippet(line)}`,
      });
    }
    scanHiddenText(hidden.text, hidden.how, file, n, ctx);
  }
}

// Text that was deliberately hidden gets no benefit of the doubt.
function scanHiddenText(text, channel, file, n, ctx) {
  for (const r of HIDDEN_CHANNEL_RULES) {
    const m = r.re.exec(text);
    if (m) {
      ctx.findings.add({
        rule: `hidden-${r.id}`,
        severity: REJECT,
        category: 'hidden-channel',
        file,
        line: n,
        message: `${r.message} (hidden in ${channel})`,
        evidence: snippet(text, m.index, m[0].length),
      });
    }
  }
}

function checkUnicode(line, file, n, ctx) {
  const { findings } = ctx;
  let tagText = '';
  let vsRun = 0;
  const cps = [...line].map((ch) => ch.codePointAt(0));
  cps.forEach((cp, j) => {
    const cls = invisibleClass(cp);
    if (cls === 'variation-selector') {
      vsRun += 1;
      if (vsRun === 2)
        findings.add({
          rule: 'unicode-vs-run',
          severity: REJECT,
          category: 'hidden-channel',
          file,
          line: n,
          message:
            'Run of variation selectors (known data-smuggling technique)',
        });
      return;
    }
    vsRun = 0;
    if (!cls) return;
    const prevAscii = isAsciiAlnum(cps[j - 1] ?? 0);
    const nextAscii = isAsciiAlnum(cps[j + 1] ?? 0);
    switch (cls) {
      case 'tag':
        if (cp >= 0xe0020 && cp <= 0xe007e)
          tagText += String.fromCharCode(cp - 0xe0000);
        break;
      case 'variation-selector-supplement':
        findings.add({
          rule: 'unicode-vs-supplement',
          severity: REJECT,
          category: 'hidden-channel',
          file,
          line: n,
          message:
            'Supplementary variation selectors (known data-smuggling technique)',
        });
        break;
      case 'bidi':
        findings.add({
          rule: 'unicode-bidi',
          severity: REJECT,
          category: 'hidden-channel',
          file,
          line: n,
          message:
            'Bidirectional override: displayed text differs from what the agent reads',
          evidence: line,
        });
        break;
      case 'bidi-mark':
        findings.add({
          rule: 'unicode-bidi-mark',
          severity: REVIEW,
          category: 'hidden-channel',
          file,
          line: n,
          message: 'Invisible direction mark',
        });
        break;
      case 'zero-width':
        if (cp === 0xfeff && n === 1 && j === 0) break;
        findings.add({
          rule: 'unicode-zero-width',
          severity: prevAscii && nextAscii ? REJECT : REVIEW,
          category: 'hidden-channel',
          file,
          line: n,
          message:
            prevAscii && nextAscii
              ? 'Zero-width character inside a word (hides or splits keywords)'
              : 'Zero-width character',
          evidence: line,
        });
        break;
      case 'zero-width-joiner':
        if (prevAscii && nextAscii)
          findings.add({
            rule: 'unicode-zero-width',
            severity: REJECT,
            category: 'hidden-channel',
            file,
            line: n,
            message:
              'Zero-width joiner inside a word (hides or splits keywords)',
            evidence: line,
          });
        break;
      case 'blank-filler':
        findings.add({
          rule: 'unicode-blank-filler',
          severity: REVIEW,
          category: 'hidden-channel',
          file,
          line: n,
          message: 'Invisible filler character',
        });
        break;
      case 'soft-hyphen':
        if (prevAscii && nextAscii)
          findings.add({
            rule: 'unicode-soft-hyphen',
            severity: REVIEW,
            category: 'hidden-channel',
            file,
            line: n,
            message: 'Soft hyphen inside a word (splits keywords invisibly)',
            evidence: line,
          });
        break;
      case 'terminal-escape':
        findings.add({
          rule: 'unicode-terminal-escape',
          severity: REJECT,
          category: 'hidden-channel',
          file,
          line: n,
          message:
            'Terminal escape sequence (can rewrite what you see in a terminal)',
          evidence: line,
        });
        break;
      default:
        findings.add({
          rule: 'unicode-control',
          severity: REVIEW,
          category: 'hidden-channel',
          file,
          line: n,
          message: 'Control character in text',
          evidence: line,
        });
    }
  });
  if (tagText) {
    findings.add({
      rule: 'unicode-tags',
      severity: REJECT,
      category: 'hidden-channel',
      file,
      line: n,
      message: 'Invisible Unicode tag characters carry hidden text',
      evidence: `hidden text: ${tagText}`,
    });
    scanHiddenText(tagText, 'invisible Unicode tags', file, n, ctx);
    for (const u of findUrls(tagText)) findings.ref('url', u.value, file, n);
  }
}

function checkHomoglyphs(lines, file, ctx) {
  lines.forEach((line, i) => {
    if (!/[^\p{ASCII}]/u.test(line)) return;
    for (const m of line.matchAll(/[\p{L}\p{M}]{2,}/gu)) {
      const w = m[0];
      if (
        /\p{Script=Latin}/u.test(w) &&
        /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u.test(
          w,
        )
      ) {
        ctx.findings.add({
          rule: 'unicode-homoglyph',
          severity: REVIEW,
          category: 'hidden-channel',
          file,
          line: i + 1,
          message:
            'Word mixes Latin with look-alike letters from another script',
          evidence: w,
        });
      }
    }
  });
}

function checkHtmlComments(text, file, isMarkdown, ctx) {
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    const body = m[1].trim();
    const line = text.slice(0, m.index).split(/\r\n|\n|\r/).length;
    const words = body.split(/\s+/).filter(Boolean).length;
    if (isMarkdown && words >= 8) {
      ctx.findings.add({
        rule: 'md-html-comment',
        severity: REVIEW,
        category: 'hidden-channel',
        file,
        line,
        message:
          'HTML comment with text: hidden when rendered, but the agent reads it',
        evidence: body,
      });
    }
    scanHiddenText(body, 'an HTML comment', file, line, ctx);
  }
}

function localModuleNames(ctx) {
  if (!ctx.localModules) {
    ctx.localModules = new Set();
    for (const e of ctx.entries) {
      const parts = e.rel.split('/');
      parts.slice(0, -1).forEach((p) => ctx.localModules.add(p));
      const last = parts[parts.length - 1];
      ctx.localModules.add(
        e.type === 'file' ? last.replace(/\.[^.]+$/, '') : last,
      );
    }
  }
  return ctx.localModules;
}

function checkPythonImports(lines, file, ctx) {
  const local = localModuleNames(ctx);
  lines.forEach((line, i) => {
    const names = [];
    const from = /^\s*from\s+([\w.]+)\s+import\b/.exec(line);
    const imp =
      /^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)\s*(?:#.*)?$/.exec(
        line,
      );
    if (from && !from[1].startsWith('.')) names.push(from[1]);
    if (imp)
      names.push(...imp[1].split(',').map((s) => s.trim().split(/\s+/)[0]));
    for (const full of names) {
      const top = full.split('.')[0];
      if (!top || PY_STDLIB.has(top) || local.has(top)) continue;
      // The import name is not the distribution name: `import PIL` is pillow.
      addObservation(
        ctx,
        {
          ecosystem: 'pypi',
          rawName: importToDistribution('pypi', top),
          version: '',
          pinKind: 'none',
          source: 'default-registry',
          via: 'import',
        },
        file,
        i + 1,
        line,
      );
      ctx.findings.ref('package', `python:${top}`, file, i + 1);
    }
  });
}

const NODE_BUILTINS = new Set(
  builtinModules.map((m) => m.replace(/^node:/, '')),
);

function checkJsImports(text, file, ctx) {
  const specs = [];
  const collect = (re) => {
    for (const m of text.matchAll(re))
      specs.push({ spec: m[1], index: m.index });
  };
  // `from` only counts inside an import or export statement. On its own it is
  // an ordinary English word, and minified code puts whole sentences on one
  // line: `"severity lowered from "+x+" to "` otherwise reads as an import.
  collect(/\b(?:import|export)\b[^;'"\n]{0,200}?\bfrom\s*['"]([^'"\n]+)['"]/g);
  collect(/\bimport\s+['"]([^'"\n]+)['"]/g);
  collect(/\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g);
  const local = localModuleNames(ctx);
  for (const { spec, index } of specs) {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#'))
      continue;
    const bare = spec.replace(/^node:/, '');
    if (
      spec.startsWith('node:') ||
      NODE_BUILTINS.has(bare) ||
      NODE_BUILTINS.has(bare.split('/')[0])
    )
      continue;
    if (/^(?:bun|deno)(?::|$)/.test(spec)) continue;
    const line = text.slice(0, index).split(/\r\n|\n|\r/).length;
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) continue; // npm:, jsr: and URLs are reported by other rules
    const pkg = spec.startsWith('@')
      ? spec.split('/').slice(0, 2).join('/')
      : spec.split('/')[0];
    const vendored =
      local.has('node_modules') &&
      ctx.entries.some((e) => e.rel.includes(`node_modules/${pkg}/`));
    addObservation(
      ctx,
      {
        ecosystem: 'npm',
        rawName: pkg,
        version: '',
        pinKind: 'none',
        // Vendored code is already in the tree, so nothing is fetched for it.
        source: vendored ? 'bundled' : 'default-registry',
        via: 'import',
      },
      file,
      line,
      spec,
    );
    ctx.findings.ref('package', `npm:${pkg}`, file, line);
    // Vendored code is somebody else's source sitting in the tree. The
    // dependency pass treats it as bundled, so the review flag lives here.
    if (vendored)
      ctx.findings.add({
        rule: 'dep-js-vendored',
        severity: REVIEW,
        category: 'dependency',
        file,
        line,
        message: `Uses vendored third-party package '${pkg}' (bundled code from someone else)`,
        evidence: spec,
      });
  }
}

// ---------------------------------------------------------------------------
// Dependency observations
// ---------------------------------------------------------------------------
// Phase one of dependency handling: every place that could pull a package
// records a fact and judges nothing. A package named in a doc line, pinned in a
// manifest and imported by a script is one decision, and file order is
// arbitrary, so the decision waits for `resolveDependencies` once the whole
// tree has been read.

// Cheap gate so the tokenizer only runs on lines that could be an install.
const INSTALL_HINT_RE =
  /\b(?:npm|npx|pnpm|pnpx|yarn|bunx?|pip3?|python3?|py|uvx?|pipx|poetry|gem|bundle|go|cargo|composer|dotnet|docker|podman|nerdctl|brew|apt|apt-get|yum|dnf|zypper|apk|pacman|choco|winget|scoop|snap|flatpak)\b|--(?:extra-)?index-url|--find-links|\b(?:PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|UV_INDEX_URL|UV_DEFAULT_INDEX|NPM_CONFIG_REGISTRY|YARN_REGISTRY|GOPROXY|GEM_HOST|GEM_SOURCE)\b/;

function addObservation(ctx, o, file, line, evidence) {
  const { key, ok, reason } = normalizeName(o.ecosystem, o.rawName);
  ctx.deps.push({
    integrity: null,
    target: null,
    runsCode: false,
    scriptsDisabled: false,
    ...o,
    key,
    nameOk: ok,
    nameReason: reason,
    file,
    line,
    evidence: sanitize(evidence ?? o.rawName, 160),
  });
}

// An index override redirects installs for everything in the environment, so
// it is recorded once for the whole skill rather than against one package.
function noteOverride(ctx, what, file, line) {
  ctx.registryContext.indexOverrides.push({ what, file, line });
}

function collectInstallCommands(line, file, n, ctx) {
  if (!INSTALL_HINT_RE.test(line)) return;
  const { deps, overrides, manifestRefs } = parseInstallCommand(line);
  for (const d of deps) addObservation(ctx, d, file, n, line);
  for (const w of overrides) noteOverride(ctx, w, file, n);
  for (const r of manifestRefs)
    ctx.manifestRefs.push({
      ...r,
      file,
      line: n,
      evidence: sanitize(line, 160),
    });
}

function collectManifestDeps(base, ext, text, file, ctx) {
  const { deps, overrides, manifestRefs, requireHashes } = parseManifest(
    base,
    ext,
    text,
  );
  for (const d of deps) addObservation(ctx, d, file, 0, d.rawName);
  for (const w of overrides) noteOverride(ctx, w, file, 0);
  for (const r of manifestRefs) ctx.manifestRefs.push({ ...r, file, line: 0 });
  if (requireHashes) ctx.requireHashesFiles.push(file);
}

function checkManifest(base, ext, text, file, ctx) {
  const { findings } = ctx;
  const lower = base.toLowerCase();
  collectManifestDeps(base, ext, text, file, ctx);
  const add = (severity, message, rule = 'dep-manifest') =>
    findings.add({ rule, severity, category: 'dependency', file, message });

  if (lower === 'package.json') {
    try {
      const pkg = JSON.parse(text);
      const deps = [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
        'bundleDependencies',
        'bundledDependencies',
      ].flatMap((k) => Object.keys(pkg?.[k] ?? {}));
      // The packages themselves are judged by the dependency pass; this only
      // keeps the inventory.
      deps.forEach((d) => findings.ref('package', `npm:${d}`, file));
      const hooks = Object.keys(pkg?.scripts ?? {}).filter((k) =>
        /^(?:pre|post)?install$|^prepare$|^prepublish$/.test(k),
      );
      if (hooks.length)
        add(
          REJECT,
          `package.json has install lifecycle scripts: ${hooks.join(', ')}`,
          'dep-install-hook',
        );
    } catch {
      findings.add({
        rule: 'manifest-invalid',
        severity: REVIEW,
        category: 'unanalysable',
        file,
        message: 'package.json is not valid JSON',
      });
    }
  }
  // Manifests, lockfiles, inline metadata and index overrides are parsed by
  // the dependency pass, which decides once per package. What stays here is
  // the manifests it cannot read as a package list.
  if (
    (lower === 'setup.py' || lower === 'setup.cfg') &&
    /install_requires/.test(text)
  )
    add(
      REVIEW,
      `${base} declares install_requires, which is read by running Python code`,
    );
  if (
    [
      'pipfile',
      'podfile',
      'build.gradle',
      'pom.xml',
      'import_map.json',
    ].includes(lower)
  ) {
    add(REVIEW, `${base} pulls dependencies this scanner does not parse`);
  }
  if (lower === 'gemfile' && /^\s*gem\s+['"]/m.test(text))
    add(REVIEW, 'Gemfile declares gems this scanner does not parse');
  if (['bun.lockb', 'bun.lock', 'gemfile.lock'].includes(lower))
    add(
      REVIEW,
      `Lockfile ${base} carries no artifact hashes, so it cannot pin content`,
    );
  // The tree pins every submodule to a commit, so its content cannot move
  // under the review. It was not scanned either, so a person decides.
  if (lower === '.gitmodules')
    add(
      REVIEW,
      'Git submodules pull code from other repositories (pinned to a commit, not scanned)',
      'dep-git-submodule',
    );
  if (
    lower === 'dockerfile' ||
    /^docker-compose.*\.ya?ml$|^compose\.ya?ml$/.test(lower)
  )
    add(
      REVIEW,
      `${base} builds or runs containers; only the images it names were checked`,
      'dep-container-file',
    );

  // MCP servers and plugin surfaces.
  if (
    ext === '.json' ||
    ext === '.jsonc' ||
    ext === '.toml' ||
    ext === '.yaml' ||
    ext === '.yml'
  ) {
    const mcp =
      /["']?(?:mcpServers|mcp_servers|mcp-servers)["']?\s*[:=]|^\[mcp_servers\./m.test(
        text,
      ) || lower === '.mcp.json';
    if (mcp) {
      const names = [...text.matchAll(/^\s*"([\w.-]+)"\s*:\s*\{\s*$/gm)]
        .map((m) => m[1])
        .filter((k) => !/^(?:mcpServers|env|headers)$/.test(k));
      findings.add({
        rule: 'mcp-server',
        severity: REJECT,
        category: 'external-server',
        file,
        message: `Declares MCP server(s)${names.length ? `: ${names.slice(0, 8).join(', ')}` : ''}; the agent would connect to or launch them`,
      });
    }
  }
  if (
    file.endsWith('.claude-plugin/plugin.json') ||
    file.endsWith('.codex-plugin/plugin.json') ||
    file.endsWith('.claude-plugin/marketplace.json')
  ) {
    findings.add({
      rule: 'plugin-manifest',
      severity: REVIEW,
      category: 'plugin',
      file,
      message:
        'Plugin manifest: installs hooks, commands, agents, MCP servers or binaries, not just a skill',
    });
  }
  if (
    /(?:^|\/)hooks\/hooks\.json$/.test(file) ||
    (/(?:^|\/)settings(?:\.local)?\.json$/.test(file) &&
      /"hooks"\s*:/.test(text))
  ) {
    findings.add({
      rule: 'plugin-hooks',
      severity: REVIEW,
      category: 'plugin',
      file,
      message: 'Hook definitions: commands run automatically on agent events',
    });
  }
  if (/(?:^|\/)\.lsp\.json$/.test(file))
    findings.add({
      rule: 'plugin-lsp',
      severity: REVIEW,
      category: 'plugin',
      file,
      message: 'Language server definition: launches a program',
    });
  if (
    /(?:^|\/)(?:settings(?:\.local)?\.json|config\.toml)$/.test(file) &&
    /(?:^|\/)\.(?:claude|codex)\//.test(file)
  ) {
    findings.add({
      rule: 'bundled-agent-settings',
      severity: REVIEW,
      category: 'agent-config',
      file,
      message:
        'Bundles agent settings (permissions, env, hooks) that apply outside the skill',
    });
  }
  if (/(?:^|\/)(?:CLAUDE|AGENTS|GEMINI)\.md$/.test(file)) {
    findings.add({
      rule: 'bundled-ambient-instructions',
      severity: REVIEW,
      category: 'agent-config',
      file,
      message:
        'Bundles an ambient instruction file that agents load outside the skill',
    });
  }
}

function checkFrontmatter(text, file, base, ctx) {
  const fm = parseFrontmatter(text);
  if (!fm) return;
  const { findings } = ctx;
  if (base === 'SKILL.md') {
    const field = (k) =>
      (fm.fields.get(k) ?? '').trim().replace(/^["']|["']$/g, '');
    ctx.skillName = ctx.skillName ?? field('name');
    // The author's own words. It is untrusted text, so it is sanitized and
    // labelled as a claim in the report, never treated as a finding.
    ctx.skillDescription = ctx.skillDescription || field('description') || null;
  }
  const toolsRaw = fm.fields.get('allowed-tools') ?? fm.fields.get('tools');
  if (toolsRaw) {
    const tools = toolsRaw
      .replace(/^\s*\[|\]\s*$/g, '')
      .split(/[\n,]|\s+-\s+/)
      .map((t) => t.replace(/^[\s"'-]+|[\s"']+$/g, ''))
      .filter(Boolean);
    for (const tool of tools) {
      const scoped = /^Bash\((.+)\)$/i.exec(tool);
      if (/^(?:WebFetch|web_fetch)\b/i.test(tool)) {
        findings.add({
          rule: 'fm-webfetch',
          severity: REVIEW,
          category: 'network',
          file,
          line: 1,
          message:
            'allowed-tools pre-approves WebFetch: the skill can pull remote instructions without a prompt',
          evidence: tool,
        });
      } else if (/^(?:WebSearch|web_search)\b/i.test(tool)) {
        findings.add({
          rule: 'fm-websearch',
          severity: REVIEW,
          category: 'network',
          file,
          line: 1,
          message: 'allowed-tools pre-approves WebSearch',
          evidence: tool,
        });
      } else if (
        /^Bash$/i.test(tool) ||
        (scoped && /^\*(?::\*)?$/.test(scoped[1].trim()))
      ) {
        findings.add({
          rule: 'fm-bash-unrestricted',
          severity: REVIEW,
          category: 'execution',
          file,
          line: 1,
          message: 'allowed-tools pre-approves any shell command',
          evidence: tool,
        });
      } else if (scoped) {
        const cmd = scoped[1].split(/[\s:]/)[0];
        const network =
          /^(?:curl|wget|nc|ncat|ssh|scp|npx|bunx|uvx|pipx|pip|pip3|npm|pnpm|yarn|docker|git|iwr|irm|Invoke-WebRequest)$/i.test(
            cmd,
          );
        findings.add({
          rule: network ? 'fm-bash-network' : 'fm-bash-scoped',
          // `Bash(git *)` without a prompt is a real widening of what the skill
          // may do, but it is also how most build and release skills work.
          severity: network ? REVIEW : INFO,
          category: network ? 'network' : 'execution',
          file,
          line: 1,
          message: network
            ? `allowed-tools pre-approves '${cmd}', which reaches the network or a registry`
            : `allowed-tools pre-approves shell command '${cmd}'`,
          evidence: tool,
        });
      } else if (/^mcp__/i.test(tool)) {
        findings.add({
          rule: 'fm-mcp-tool',
          severity: REVIEW,
          category: 'external-server',
          file,
          line: 1,
          message: 'allowed-tools pre-approves an MCP tool',
          evidence: tool,
        });
      }
    }
  }
  if (fm.fields.has('hooks'))
    findings.add({
      rule: 'fm-hooks',
      severity: REVIEW,
      category: 'plugin',
      file,
      line: 1,
      message:
        'Frontmatter defines hooks: commands run automatically on agent events',
    });
  if (
    fm.fields.has('mcpservers') ||
    fm.fields.has('mcp-servers') ||
    fm.fields.has('mcp_servers')
  ) {
    findings.add({
      rule: 'fm-mcp',
      severity: REJECT,
      category: 'external-server',
      file,
      line: 1,
      message: 'Frontmatter declares MCP servers',
    });
  }
  if (
    /bypassPermissions|acceptEdits|dontAsk/.test(
      fm.fields.get('permissionmode') ?? '',
    )
  ) {
    findings.add({
      rule: 'fm-permission-mode',
      severity: REVIEW,
      category: 'defense-evasion',
      file,
      line: 1,
      message: 'Agent runs with a relaxed permission mode',
      evidence: fm.fields.get('permissionmode'),
    });
  }
}

// ---------------------------------------------------------------------------
// Tree-level checks
// ---------------------------------------------------------------------------

function checkSymlinks(entries, root, findings) {
  for (const e of entries.filter((x) => x.type === 'symlink')) {
    const resolved = path.resolve(path.dirname(e.abs), e.target);
    const inside =
      !path.isAbsolute(e.target) &&
      (resolved === root || resolved.startsWith(root + path.sep));
    findings.add({
      rule: inside ? 'fs-symlink' : 'fs-symlink-escape',
      severity: inside ? REVIEW : REJECT,
      category: 'filesystem',
      file: e.rel,
      message: inside
        ? `Symlink to ${e.target}`
        : `Symlink points outside the skill (${e.target || 'unreadable target'})`,
    });
  }
}

function checkGitTree(root, findings) {
  const gitDir = path.join(root, '.git');
  let st;
  try {
    st = fs.lstatSync(gitDir);
  } catch {
    return;
  }
  if (!st.isDirectory()) {
    findings.add({
      rule: 'git-pointer',
      severity: REVIEW,
      category: 'filesystem',
      file: '.git',
      message: '.git is a file pointing to another repository',
    });
    return;
  }
  const r = spawnSync(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=',
      '-C',
      root,
      'ls-tree',
      '-r',
      '--full-tree',
      'HEAD',
    ],
    {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (r.status !== 0) {
    findings.add({
      rule: 'git-tree-unreadable',
      severity: INFO,
      category: 'filesystem',
      file: '.git',
      message:
        'Git tree could not be listed; symlink and submodule check used the working tree only',
    });
    return;
  }
  for (const line of r.stdout.split('\n')) {
    const m = /^(\d{6}) \w+ ([0-9a-f]+)\t(.*)$/.exec(line);
    if (!m) continue;
    if (
      /^100[67][45]{2}$/.test(m[1]) &&
      !fs.existsSync(path.join(root, m[3]))
    ) {
      findings.add({
        rule: 'git-file-missing',
        severity: REJECT,
        category: 'antivirus',
        file: m[3],
        message:
          'File is in the Git tree but missing on disk (an antivirus may have quarantined it, or the checkout is incomplete)',
      });
    }
    if (m[1] === '160000')
      findings.add({
        rule: 'dep-git-submodule',
        severity: REVIEW,
        category: 'dependency',
        file: m[3],
        message:
          'Git submodule: code comes from another repository (pinned to a commit, not scanned)',
      });
    if (m[1] === '120000') {
      const t = spawnSync(
        'git',
        ['-c', 'core.fsmonitor=false', '-C', root, 'cat-file', 'blob', m[2]],
        { encoding: 'utf8', timeout: 10000, windowsHide: true },
      );
      const target = (t.stdout ?? '').trim();
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(m[3]), target),
      );
      const escapes =
        path.posix.isAbsolute(target) ||
        /^[a-z]:/i.test(target) ||
        resolved.startsWith('..');
      findings.add({
        rule: escapes ? 'fs-symlink-escape' : 'fs-symlink',
        severity: escapes ? REJECT : REVIEW,
        category: 'filesystem',
        file: m[3],
        message: escapes
          ? `Symlink in Git tree points outside the skill (${sanitize(target)})`
          : `Symlink in Git tree to ${sanitize(target)}`,
      });
    }
  }
}

function checkTreeShape(entries, ctx) {
  const { findings } = ctx;
  const files = entries.filter((e) => e.type === 'file');
  if (
    !files.some((e) => e.rel === 'SKILL.md') &&
    !files.some((e) =>
      /(?:^|\/)\.(?:claude|codex)-plugin\/plugin\.json$/.test(e.rel),
    )
  ) {
    findings.add({
      rule: 'no-skill-md',
      severity: REVIEW,
      category: 'structure',
      file: '.',
      message:
        'No SKILL.md at the top level: this is not a standard skill folder',
    });
  }
  const sensitive = files.filter(
    (e) =>
      /(?:^|\/)(?:\.env(?:\.[\w-]+)?|id_(?:rsa|ed25519|ecdsa|dsa)|\.git-credentials|credentials\.json|[\w.-]+\.(?:pem|key|p12|pfx|keystore|jks))$/i.test(
        e.rel,
      ) && !/\.env\.(?:example|sample|template)$/i.test(e.rel),
  );
  for (const e of sensitive)
    findings.add({
      rule: 'secret-file',
      severity: REVIEW,
      category: 'secret',
      file: e.rel,
      message: 'Bundles a credential or key file',
    });
  const binDir = files.filter((e) => /^bin\//.test(e.rel));
  if (binDir.length)
    findings.add({
      rule: 'plugin-bin',
      severity: REVIEW,
      category: 'plugin',
      file: 'bin/',
      message: `bin/ folder with ${binDir.length} file(s): plugins put these on the agent's PATH`,
    });
  if (entries.some((e) => e.rel.split('/').includes('node_modules'))) {
    findings.add({
      rule: 'dep-vendored-tree',
      severity: REVIEW,
      category: 'dependency',
      file: 'node_modules/',
      message:
        'Bundles a node_modules tree (third-party code nobody reviewed for this skill)',
    });
  }
  if (files.length > LIMITS.maxFiles)
    findings.add({
      rule: 'fs-too-many-files',
      severity: REVIEW,
      category: 'unanalysable',
      file: '.',
      message: `More than ${LIMITS.maxFiles} files; only the first ${LIMITS.maxFiles} were analysed`,
    });
  if (ctx.totalBytes > LIMITS.maxTotalBytes)
    findings.add({
      rule: 'fs-too-large',
      severity: REVIEW,
      category: 'unanalysable',
      file: '.',
      message: `Skill is larger than ${LIMITS.maxTotalBytes / 1024 / 1024} MB`,
    });
  const gitDirEntry = entries.find((e) => e.type === 'gitdir');
  if (gitDirEntry)
    findings.add({
      rule: 'git-dir',
      severity: INFO,
      category: 'filesystem',
      file: '.git',
      message: '.git folder skipped (repository metadata, not skill content)',
    });
}

// ---------------------------------------------------------------------------
// Antivirus
// ---------------------------------------------------------------------------

function findDefender() {
  if (process.platform !== 'win32') return null;
  const platformDir = path.join(
    process.env.ProgramData ?? 'C:\\ProgramData',
    'Microsoft',
    'Windows Defender',
    'Platform',
  );
  try {
    const versions = fs
      .readdirSync(platformDir)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) {
      const exe = path.join(platformDir, v, 'MpCmdRun.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch {
    /* fall through */
  }
  const legacy = path.join(
    process.env.ProgramFiles ?? 'C:\\Program Files',
    'Windows Defender',
    'MpCmdRun.exe',
  );
  return fs.existsSync(legacy) ? legacy : null;
}

const EICAR = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
].join('');

function runDefender(root) {
  const exe = findDefender();
  if (!exe) return null;
  const r = spawnSync(
    exe,
    ['-Scan', '-ScanType', '3', '-File', root, '-DisableRemediation'],
    { encoding: 'utf8', timeout: 600000, windowsHide: true },
  );
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const threats = [...out.matchAll(/Threat\s*:\s*(.+)/g)].map((m) =>
    m[1].trim(),
  );
  const files = [...out.matchAll(/^\s*file\s*:\s*(.+)$/gim)].map((m) =>
    path.relative(root, m[1].trim()).split(path.sep).join('/'),
  );
  const engine = 'Microsoft Defender';
  if (r.status === 0) return { engine, status: 'clean' };
  // Turned off because another antivirus product is registered: not a fault.
  // MpCmdRun only says so in its log, so read the entry of the run that just
  // ended. Stripping NULs reads both the ANSI and the UTF-16 log format.
  let log = '';
  try {
    const all = fs
      .readFileSync(path.join(os.tmpdir(), 'MpCmdRun.log'))
      .toString('latin1')
      .replace(/\0/g, '');
    log = all.slice(all.lastIndexOf('MpCmdRun: Command Line:'));
  } catch {
    /* no log: judge by the output alone */
  }
  if (/Product\/Feature disabled|0x800106ba/i.test(`${out}\n${log}`))
    return { engine, status: 'off', detail: 'turned off on this machine' };
  // Exit code 2 means "threats found" but is also used for failures, so require a parsed threat.
  if (threats.length) return { engine, status: 'threat', threats, files };
  return {
    engine,
    status: 'unavailable',
    detail: sanitize(
      out.trim().split('\n').pop() || `exit ${r.status ?? r.error?.code}`,
      200,
    ),
  };
}

// AMSI hands the bytes to whichever antivirus is registered on Windows (AVG, Avast, ESET, Defender, ...).
function runAmsi(root, entries) {
  if (process.platform !== 'win32') return null;
  const script = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'amsi-scan.ps1',
  );
  // Some products read a script that loads amsi.dll as an AMSI bypass and
  // quarantine it. Say so instead of reporting a bare PowerShell error.
  if (!fs.existsSync(script))
    return {
      engine: 'AMSI (registered antivirus)',
      status: 'unavailable',
      detail:
        'scripts/amsi-scan.ps1 is missing; an antivirus may have quarantined it. Restore it and add an exception for this skill folder',
    };
  const files = entries
    .filter((e) => e.type === 'file' && (e.size ?? 0) < 64 * 1024 * 1024)
    .map((e) => e.abs);
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Canary',
      '-Stdin',
    ],
    {
      input: files.join('\n'),
      encoding: 'utf8',
      timeout: 600000,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  let engine = 'AMSI (registered antivirus)';
  if (r.error || r.status !== 0)
    return {
      engine,
      status: 'unavailable',
      detail: sanitize(
        (r.stderr ?? '').trim().split('\n')[0] ||
          `exit ${r.status ?? r.error?.code}`,
        200,
      ),
    };
  const rows = (r.stdout ?? '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
  const canary = rows.find((x) => x.canary);
  if (canary?.products?.length)
    engine = `AMSI (${canary.products.map((p) => sanitize(p, 60)).join(', ')})`;
  const hits = rows.filter((x) => !x.canary && x.detected);
  const errors = rows.filter((x) => !x.canary && x.error);
  if (hits.length)
    return {
      engine,
      status: 'threat',
      threats: ['AMSI detection'],
      files: hits.map((x) =>
        path.relative(root, x.file).split(path.sep).join('/'),
      ),
    };
  if (!canary?.detected)
    return {
      engine,
      status: 'unverified',
      detail:
        'the engine did not flag the harmless test samples, so a clean result proves nothing',
    };
  if (errors.length)
    return {
      engine,
      status: 'unavailable',
      detail: `${errors.length} file(s) could not be scanned`,
    };
  return { engine, status: 'clean' };
}

function runClam(root) {
  for (const bin of ['clamdscan', 'clamscan']) {
    const canary = spawnSync(bin, ['--no-summary', '-'], {
      input: EICAR,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
    if (canary.error?.code === 'ENOENT') continue;
    const engine = `ClamAV (${bin})`;
    if (canary.status !== 1)
      return {
        engine,
        status: 'unverified',
        detail: 'the engine did not flag the EICAR test sample',
      };
    const args =
      bin === 'clamdscan'
        ? ['--fdpass', '--no-summary', '--infected', root]
        : ['-r', '--no-summary', '--infected', root];
    const r = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: 600000,
      windowsHide: true,
    });
    const threats = [
      ...(r.stdout ?? '').matchAll(/^(.*):\s+(.+)\s+FOUND$/gm),
    ].map(
      (m) =>
        `${m[2]} in ${path.relative(root, m[1]).split(path.sep).join('/')}`,
    );
    if (r.status === 0) return { engine, status: 'clean' };
    if (r.status === 1) return { engine, status: 'threat', threats };
    return {
      engine,
      status: 'unavailable',
      detail: sanitize((r.stderr ?? '').trim() || `exit ${r.status}`, 200),
    };
  }
  return null;
}

// The engine bundled with this skill (tiny-av.mjs). It runs everywhere, under
// the same read-only sandbox as the static analysis.
function runBundled(root, entries, useSandbox) {
  const engine = 'tiny-av (bundled)';
  const sandbox = useSandbox ? sandboxFlags(root) : null;
  const r = spawnSync(
    process.execPath,
    [...(sandbox?.args ?? []), path.join(SCRIPT_DIR, 'tiny-av.mjs'), '--stdin'],
    {
      input: entries
        .filter((e) => e.type === 'file')
        .map((e) => e.abs)
        .join('\n'),
      encoding: 'utf8',
      timeout: STATIC_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    return {
      engine,
      bundled: true,
      status: 'unavailable',
      detail: sanitize(
        r.error?.code === 'ETIMEDOUT'
          ? 'did not finish in time'
          : (r.stderr ?? '').trim().split('\n').pop() || `exit ${r.status}`,
        200,
      ),
    };
  }
  const label = `tiny-av ${out.version} (bundled, ${out.signatures} signatures)`;
  if (!out.selfTest.ok)
    return {
      engine: label,
      bundled: true,
      status: 'unverified',
      detail: `self-test failed: ${out.selfTest.failed.join(', ')}`,
    };
  const rel = (f) => path.relative(root, f).split(path.sep).join('/');
  if (out.threats.length)
    return {
      engine: label,
      bundled: true,
      status: 'threat',
      threats: [
        ...new Set(
          out.threats.map(
            (t) =>
              `${t.name} in ${rel(t.file)}${t.where.length ? ` (${t.where.map((w) => sanitize(w, 60)).join(' > ')})` : ''}`,
          ),
        ),
      ],
      files: [...new Set(out.threats.map((t) => rel(t.file)))],
    };
  if (out.errors.length)
    return {
      engine: label,
      bundled: true,
      status: 'unavailable',
      detail: `${out.errors.length} file(s) could not be scanned`,
    };
  return { engine: label, bundled: true, status: 'clean' };
}

function runAntivirus(root, entries, useSandbox) {
  const engines = [runBundled(root, entries, useSandbox)];
  const defender = runDefender(root);
  if (defender) engines.push(defender);
  if (!defender || !['clean', 'threat'].includes(defender.status)) {
    const amsi = runAmsi(root, entries);
    if (amsi) engines.push(amsi);
  }
  const clam = runClam(root);
  if (clam) engines.push(clam);
  return engines;
}

function applyAntivirus(av, findings, needsAv) {
  if (av === 'skipped') {
    findings.add({
      rule: 'av-skipped',
      severity: INFO,
      category: 'antivirus',
      file: '.',
      message: 'Antivirus scan skipped (--no-av)',
    });
    return;
  }
  const working = av.filter(
    (e) => e.status === 'clean' || e.status === 'threat',
  );
  const systemWorking = working.filter((e) => !e.bundled);
  for (const e of av) {
    if (e.status === 'threat') {
      findings.add({
        rule: 'av-threat',
        severity: REJECT,
        category: 'antivirus',
        file: '.',
        message: `${e.engine} detected: ${(e.threats ?? []).join('; ') || 'threat'}`,
        evidence: (e.files ?? []).join(', '),
      });
    } else if (e.status === 'off' && working.length) {
      // A product that is switched off while another one scanned is no news.
      continue;
    } else if (e.status !== 'clean') {
      findings.add({
        rule: `av-${e.status}`,
        severity: INFO,
        category: 'antivirus',
        file: '.',
        message: `${e.engine} ${e.status}: ${e.detail}`,
      });
    }
  }
  if (working.length && !systemWorking.length) {
    findings.add({
      rule: 'av-bundled-only',
      severity: INFO,
      category: 'antivirus',
      file: '.',
      message:
        'Only the bundled engine scanned the files. It knows a small set of attack-tool signatures, not current malware; install ClamAV or enable an AMSI-capable antivirus for a full scan',
    });
  }
  if (!working.length) {
    findings.add({
      rule: 'av-none-working',
      severity: needsAv ? REVIEW : INFO,
      category: 'antivirus',
      file: '.',
      message: needsAv
        ? 'No working antivirus engine: scripts and binaries were not malware-scanned (install ClamAV or enable an AMSI-capable antivirus)'
        : 'No working antivirus engine (no scripts or binaries to scan)',
    });
  }
}

// ---------------------------------------------------------------------------
// Scan orchestration
// ---------------------------------------------------------------------------

function computeDigest(entries) {
  const lines = entries
    .filter((e) => (e.type === 'file' && e.sha256) || e.type === 'symlink')
    .map((e) =>
      e.type === 'symlink'
        ? `symlink:${createHash('sha256').update(e.target).digest('hex')}  ${e.rel}`
        : `${e.sha256}  ${e.rel}`,
    )
    .sort((a, b) => {
      const pa = a.slice(a.indexOf('  ') + 2);
      const pb = b.slice(b.indexOf('  ') + 2);
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    });
  return createHash('sha256')
    .update(`${lines.join('\n')}\n`)
    .digest('hex');
}

// Static analysis: reads the skill folder and nothing else. Starts no processes.
// Phase two: one decision per package, once the whole tree has been read.
function analyseDependencies(ctx, policy) {
  const trust = policy.trust;
  const cache = new Map();
  const trustedFor = (ecosystem) => {
    if (!cache.has(ecosystem))
      cache.set(ecosystem, trustedKeys(trust, ecosystem, normalizeName));
    return cache.get(ecosystem);
  };

  const files = new Set(ctx.entries.map((e) => e.rel));
  const hasFile = (target) => {
    const name = String(target).replace(/^\.\//, '');
    return (
      files.has(name) ||
      [...files].some((f) => f === name || f.endsWith(`/${name}`))
    );
  };

  // `npm ci --ignore-scripts` and `pip install -r req.txt --only-binary=:all:`
  // disable lifecycle scripts for the packages of that manifest, so the flag
  // belongs to those packages. It only counts when every install of that
  // manifest sets it; one plain install is enough to run the scripts.
  const refsByTarget = new Map();
  for (const ref of ctx.manifestRefs) {
    const key = String(ref.target ?? '').replace(/^\.\//, '');
    const seen = refsByTarget.get(key);
    refsByTarget.set(
      key,
      seen === undefined
        ? Boolean(ref.scriptsDisabled)
        : seen && Boolean(ref.scriptsDisabled),
    );
  }
  for (const obs of ctx.deps) {
    if (obs.via !== 'manifest' && obs.via !== 'lockfile') continue;
    const base = obs.file.split('/').pop() ?? obs.file;
    for (const [target, disabled] of refsByTarget)
      if (disabled && (target === base || target === obs.file))
        obs.scriptsDisabled = true;
  }

  // A local path dependency is only safe while it stays inside the reviewed
  // folder; anything outside it was never scanned.
  for (const obs of ctx.deps)
    if (obs.source === 'path')
      obs.insideTree =
        !/^(?:\.\.|[\\/]|~|[A-Za-z]:)/.test(String(obs.target ?? '')) &&
        hasFile(String(obs.target ?? '').replace(/^\.\//, ''));

  const { packages, poisoned, missingRefs, ambientRefs } = resolveDependencies(
    ctx.deps,
    ctx.registryContext,
    ctx.manifestRefs,
    trust,
    {
      strict: policy.strict,
      trustedFor,
      hasFile,
      similarity: (obs) =>
        nameSimilarity(obs.ecosystem, obs.key, trustedFor(obs.ecosystem)),
    },
  );

  for (const override of ctx.registryContext.indexOverrides)
    ctx.findings.add({
      rule: 'dep-registry-override',
      severity: REJECT,
      category: 'dependency',
      file: override.file,
      line: override.line,
      message: `Redirects the package index (${override.what}); every install in this skill can be pointed somewhere else`,
    });

  for (const ref of missingRefs)
    ctx.findings.add({
      rule: 'dep-manifest-missing',
      // The manifest usually belongs to the project the skill runs in, not to
      // an attacker. A path that escapes the tree is caught as poison instead.
      severity: REVIEW,
      category: 'dependency',
      file: ref.file,
      line: ref.line,
      message: `Installs from '${sanitize(ref.target, 80)}', which is not in this skill, so the package list was never reviewed`,
      evidence: ref.evidence ?? '',
    });

  for (const ref of ambientRefs)
    ctx.findings.add({
      rule: 'dep-ambient-install',
      severity: REVIEW,
      category: 'dependency',
      file: ref.file,
      line: ref.line,
      message: `Installs the dependencies of whatever project it runs in (${sanitize(ref.target, 80)}); that list is not part of this skill`,
      evidence: ref.evidence ?? '',
    });

  for (const pkg of packages) {
    if (pkg.class === 'poisoned' && poisoned) continue; // the override says it
    const where = pkg.locations
      .map((l) => (l.line ? `${l.file}:${l.line}` : l.file))
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 4)
      .join(', ');
    ctx.findings.add({
      rule: `dep-${pkg.class}`,
      severity: pkg.severity,
      category: 'dependency',
      file: pkg.locations[0]?.file ?? '',
      line: pkg.locations[0]?.line ?? 0,
      message: `${pkg.ecosystem} package '${displaySpec(pkg.ecosystem, pkg.name, pkg.version)}': ${pkg.why}`,
      evidence: where,
    });
  }

  return packages;
}

function hostMatches(host, list) {
  const h = String(host).toLowerCase();
  return (list ?? []).some((entry) => h === entry || h.endsWith(`.${entry}`));
}

// A full URL is attribution only when the file, the line and the context all say
// so. Either one alone is something an attacker can arrange: a payload file
// named NOTICE-setup.md, or the word "copyright" on an instruction line.
//
// A bare domain or an e-mail address is not a fetch target, so the file name
// does not have to vouch for it as well: `Copyright (c) 2010 Jane (janedoe.com)`
// in a SKILL.md is ordinary. If the line also asks to send or fetch something,
// `riskyLine` has already taken the decision away from here.
function isAttribution(hit, trust) {
  if (hit.context !== 'mentioned in text') return false;
  if (hostMatches(hit.host, trust.docHosts)) return true;
  if (!CONTACT_LINE_RE.test(hit.line)) return false;
  return hit.kind !== 'url' || CONTACT_FILE_RE.test(hit.base);
}

// Phase two for URLs: severity depends on what the skill tells the agent to do
// with the address, and on whether the same host is fetched anywhere else.
// Both need the whole tree, so the line pass only records hits.
function analyseUrls(ctx, policy) {
  const trust = policy.trust ?? BUNDLED_TRUST;
  const { findings } = ctx;

  // An e-mail address is a send target, not a fetch target. Sitting in a config
  // file or in frontmatter does not make the host act on it; a line that asks to
  // send something does, and `riskyLine` carries that.
  //
  // An address with a port is a connection target, and `git@host:owner/repo.git`
  // reads like an e-mail but is a clone URL. Neither is ever documentation.
  const isRemoteTarget = (h) =>
    h.kind === 'ip-port' || /^git@/i.test(h.value) || /\.git$/i.test(h.value);
  // A URL with an unresolved <placeholder> segment is a template, not a
  // reachable address: `https://host/<owner>/<repo>/<branch>/x.png` shows a
  // person how to build a link, and nothing can fetch it as written. The URL
  // extractor stops at the first `<`, so the placeholder shows up in the line
  // as the URL immediately followed by a `<name>` token. A real URL never
  // contains a bare `<`, so this cannot hide a live fetch.
  const isTemplate = (h) => {
    if (h.kind === 'email') return false;
    if (/[<>]/.test(h.value)) return true;
    const l = h.line || '';
    const i = l.indexOf(h.value);
    return i >= 0 && /^<[A-Za-z][\w.-]*>/.test(l.slice(i + h.value.length));
  };
  // A header-only request reads the status line and never the body, so a
  // mutable host cannot hand it code: `curl -I`, `curl -sI`, `--head`,
  // `wget --spider`. It is still a fetch of a volatile host, so it lands on
  // REVIEW rather than passing silently.
  const isHeaderOnly = (h) => {
    const l = h.line || '';
    return (
      /\bcurl\b[^\n|]*\s-[a-zA-Z]*I\b/.test(l) ||
      /\b(?:curl|wget)\b[^\n|]*\s--head\b/i.test(l) ||
      /\bwget\b[^\n|]*\s--spider\b/i.test(l)
    );
  };
  // A raw address pinned to a full commit SHA always serves the same bytes, so
  // nothing can be swapped after the review. Nobody scanned those bytes either,
  // so it lands on REVIEW rather than passing. A tag or branch name can move,
  // which is why only a 40-hex commit counts.
  const isCommitPinned = (h) =>
    /^https?:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//i.test(
      h.value,
    ) ||
    /^https?:\/\/gist\.githubusercontent\.com\/[^/]+\/[0-9a-f]+\/raw\/[0-9a-f]{40}\//i.test(
      h.value,
    );
  // What the skill does with the address itself. Attribution cannot argue with
  // any of these, so they are checked first.
  const isActedOn = (h) =>
    h.riskyLine ||
    h.context === 'fetched or loaded' ||
    h.context === 'used as a destination' ||
    (h.kind !== 'email' &&
      (h.fileKind === 'script' || h.fileKind === 'config' || h.inFrontmatter));

  // One fetch of a host taints every mention of it. Otherwise a skill could
  // fetch a domain in a script and "merely mention" it in the documentation to
  // make the mention look harmless. A template address is excluded: it cannot
  // be fetched, so it must not taint the real mentions of the same host.
  const acted = new Set(
    ctx.urlHits
      .filter((h) => isActedOn(h) && !isTemplate(h))
      .map((h) => h.host),
  );

  for (const hit of ctx.urlHits) {
    const label =
      hit.kind === 'email'
        ? 'External e-mail address'
        : hit.kind === 'bare-domain'
          ? 'External domain'
          : 'External URL';
    const tail =
      hit.kind === 'email'
        ? 'the agent can be told to send data there'
        : 'content behind it can change after review';
    const actedOn = isActedOn(hit);

    let severity;
    let rule;
    let note = '';

    if (policy.strict) {
      // Strict mode is the original policy: every external address is out.
      severity = REJECT;
      rule = 'url-external';
    } else if (hit.context === 'used as a destination') {
      // "Upload the game to itch.io" and "send the generated files to
      // evil.example" have the same shape. What separates them is whether the
      // destination is the skill's declared job, which only a person knows.
      // The prose rules keep the REJECT for the unambiguous case: a named sink
      // such as a webhook or pastebin, or secrets as the payload.
      severity = REVIEW;
      rule = 'url-destination';
      note = '; the skill names it as a place to send data';
    } else if (hostMatches(hit.host, trust.contentHosts) && !isTemplate(hit)) {
      // A raw-content host, a paste site or a link shortener exists to hand
      // bytes to a machine. Naming one in prose is an invitation to fetch it,
      // and what comes back can be swapped after the review, so the context
      // makes no difference here.
      if (isHeaderOnly(hit)) {
        severity = REVIEW;
        rule = 'url-fetched';
        note = '; a header-only request, so the changing content is not read';
      } else if (isCommitPinned(hit)) {
        severity = REVIEW;
        rule = 'url-fetched';
        note =
          '; pinned to a commit, so the content cannot change, but it was not scanned';
      } else {
        severity = REJECT;
        rule = 'url-mutable-host';
        note = '; this host serves content that can be replaced at any time';
      }
    } else if (isAttribution(hit, trust)) {
      // Attribution is checked before the taint, because the taint is only as
      // precise as a host name. A skill that fetches one github.com URL would
      // otherwise flag the copyright line of every font licence it ships.
      severity = INFO;
      rule = 'url-contact';
    } else if (actedOn || isRemoteTarget(hit) || acted.has(hit.host)) {
      // The skill reaches this address, or reaches the same host elsewhere. It
      // is a real capability, and the owner of the host decides what it serves
      // tomorrow, so a person weighs it against what the skill is for.
      const movingRef =
        (trust.mutablePaths ?? []).some((p) => hit.value.includes(p)) &&
        !isTemplate(hit) &&
        !isHeaderOnly(hit);
      if (movingRef && (actedOn || isRemoteTarget(hit))) {
        // A moving branch ref on an ordinary host. `/blob/main/` renders a page
        // for a person to read, so it only counts once the skill fetches it.
        severity = REJECT;
        rule = 'url-mutable-host';
        note = '; this address follows a branch, so its content can change';
      } else if (movingRef) {
        // Only the host is fetched elsewhere; this address itself is a link a
        // person follows. The taint still makes it a decision, not a block,
        // or every doc link in a skill that runs one `git clone` would reject.
        severity = REVIEW;
        rule = 'url-fetched';
        note =
          '; the same host is fetched elsewhere in this skill, and this address follows a branch';
      } else {
        severity = REVIEW;
        rule = 'url-fetched';
        note = isRemoteTarget(hit)
          ? '; this is a connection target, not a reference'
          : actedOn
            ? ''
            : '; the same host is fetched elsewhere in this skill';
      }
    } else {
      // A link a person may follow in the documentation. It is in the address
      // table either way, and that inventory is the mitigation.
      severity = INFO;
      rule = 'url-doc-link';
    }

    ctx.urlDecisions.push({
      host: hit.host,
      kind: hit.kind,
      value: hit.value,
      context: hit.context,
      rule,
      severity,
      file: hit.file,
      line: hit.lineNo,
    });
    findings.ref(
      hit.kind === 'bare-domain' || hit.kind === 'email' ? 'domain' : 'url',
      hit.value,
      hit.file,
      hit.lineNo,
    );
    findings.add({
      rule,
      severity,
      category: 'external-url',
      file: hit.file,
      line: hit.lineNo,
      message:
        rule === 'url-contact'
          ? `Contact or attribution (${hit.host})`
          : rule === 'url-doc-link'
            ? `${label} (${hit.host}), ${hit.context}; not reached by this skill`
            : `${label} (${hit.host}), ${hit.context}${note}: ${tail}`,
      evidence: hit.evidence,
    });
  }
}

// Skill descriptions are written for a matcher, not a reader: the first
// sentences say what the skill is and the rest lists trigger words. Two
// sentences are what a person needs, and cutting on a sentence boundary keeps
// it readable.
function summariseDescription(raw) {
  if (!raw) return null;
  const text = String(raw)
    // `description: >-` folds the text onto the following lines. The indicator
    // is YAML syntax, not part of what the author wrote.
    .replace(/^[|>][-+]?\d*\s/, '')
    .replace(/\s+/g, ' ')
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!text) return null;
  let out = text;
  if (out.length > 260) {
    const cut = out.slice(0, 260);
    const stop = cut.lastIndexOf('. ');
    out = `${stop > 60 ? cut.slice(0, stop) : cut.trimEnd()}…`;
  }
  return sanitize(out, 280);
}

// Plain-language names for what a finding category means the skill can do.
// The report is read by someone deciding whether to install, not by someone
// debugging the scanner, so the row says the capability, not the rule.
const CAPABILITY_LABELS = new Map([
  ['remote-control', 'Remote control or reverse shell'],
  ['destructive', 'Deletes data in bulk'],
  ['defense-evasion', 'Turns off protections or approval prompts'],
  ['obfuscation', 'Hides what it runs'],
  ['hidden-channel', 'Carries hidden text aimed at the agent'],
  ['credentials', 'Reads credentials or key files'],
  ['secret', 'Bundles a key or token'],
  ['remote-content', 'Takes content or instructions from the web'],
  ['network', 'Reaches the network'],
  ['external-server', 'Connects to a named server'],
  ['prompt-injection', 'Contains wording aimed at the agent'],
  ['execution', 'Runs or builds code at run time'],
  ['privilege', 'Raises privileges or weakens permissions'],
  ['persistence', 'Arranges to run again later'],
  ['agent-config', 'Reads or changes agent configuration'],
  ['dependency', 'Installs or imports third-party packages'],
  ['filesystem', 'Reaches outside its own folder'],
  ['plugin', 'Registers hooks, commands or MCP servers'],
  ['binary', 'Ships binaries or archives'],
  ['structure', 'Unusual folder shape'],
  ['unanalysable', 'Contains files the scanner could not read'],
]);

const WEIGHT_TEXT = { [REJECT]: 'blocks', [REVIEW]: 'decide', [INFO]: 'note' };

// Antivirus and policy are report mechanics rather than things the skill does.
const CAPABILITY_SKIP = new Set(['antivirus', 'policy']);

// Addresses have their own section. An address the skill reaches still belongs
// in the capability list, because reaching it is the capability; an address it
// only names does not.
const PASSIVE_URL_RULES = new Set([
  'url-doc-link',
  'url-contact',
  'url-identifier',
  'url-placeholder',
  'url-local',
  'url-file',
  'url-private-ip',
]);

const worstSeverity = (a, b) => (RANK[a] >= RANK[b] ? a : b);

function summariseCapabilities(findings) {
  const rows = new Map();
  for (const f of findings) {
    if (CAPABILITY_SKIP.has(f.category)) continue;
    let category = f.category;
    if (category === 'external-url') {
      if (PASSIVE_URL_RULES.has(f.rule)) continue;
      category = 'network';
    }
    const label = CAPABILITY_LABELS.get(category);
    if (!label) continue;
    const row = rows.get(category) ?? {
      category,
      label,
      severity: INFO,
      places: 0,
      where: [],
    };
    row.severity = worstSeverity(row.severity, f.severity);
    row.places += 1;
    if (row.where.length < 3 && f.file)
      row.where.push(f.line ? `${f.file}:${f.line}` : f.file);
    rows.set(category, row);
  }
  return [...rows.values()].sort(
    (a, b) =>
      RANK[b.severity] - RANK[a.severity] ||
      b.places - a.places ||
      a.label.localeCompare(b.label),
  );
}

// One row per host, not per URL. A skill can carry eighty links to four hosts,
// and the question a reader has is which parties the skill involves.
function summariseHosts(decisions) {
  const rows = new Map();
  for (const d of decisions) {
    const row = rows.get(d.host) ?? {
      host: d.host,
      kind: d.kind,
      severity: INFO,
      context: d.context,
      count: 0,
      where: [],
    };
    // The strongest thing the skill does with this host decides the row.
    if (RANK[d.severity] > RANK[row.severity]) {
      row.severity = d.severity;
      row.context = d.context;
    }
    row.count += 1;
    const at = `${d.file}:${d.line}`;
    if (row.where.length < 3 && !row.where.includes(at)) row.where.push(at);
    rows.set(d.host, row);
  }
  return [...rows.values()].sort(
    (a, b) =>
      RANK[b.severity] - RANK[a.severity] ||
      b.count - a.count ||
      a.host.localeCompare(b.host),
  );
}

function staticScan(root, policy = { trust: BUNDLED_TRUST, strict: false }) {
  const findings = new Findings();
  const ctx = {
    findings,
    scripts: [],
    binaries: [],
    totalBytes: 0,
    entries: [],
    skillName: null,
    localModules: null,
    deps: [],
    urlHits: [],
    urlDecisions: [],
    skillDescription: null,
    frontmatterEnd: 0,
    manifestRefs: [],
    requireHashesFiles: [],
    registryContext: { indexOverrides: [], escapingPaths: [] },
  };
  const entries = walk(root, findings);
  ctx.entries = entries;
  let analysed = 0;
  for (const e of entries) {
    if (e.type !== 'file') continue;
    if (analysed >= LIMITS.maxFiles) break;
    analysed += 1;
    analyzeFile(e, ctx);
  }
  const dependencies = analyseDependencies(ctx, policy);
  analyseUrls(ctx, policy);
  checkSymlinks(entries, root, findings);
  checkTreeShape(entries, ctx);
  const files = entries.filter((e) => e.type === 'file');
  return {
    name: sanitize(ctx.skillName || path.basename(root), 80),
    digest: `sha256:${computeDigest(entries)}`,
    stats: {
      files: files.length,
      bytes: ctx.totalBytes,
      scripts: ctx.scripts.length,
      binaries: ctx.binaries.length,
      symlinks: entries.filter((e) => e.type === 'symlink').length,
    },
    findings: findings.list(),
    externalReferences: [...findings.refs.values()],
    dependencies,
    scripts: ctx.scripts,
    description: summariseDescription(ctx.skillDescription),
    hosts: summariseHosts(ctx.urlDecisions),
    fileList: files.map((e) => ({ rel: e.rel, size: e.size })),
  };
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATIC_TIMEOUT_MS =
  Number(process.env.SKILL_SECURITY_STATIC_TIMEOUT_MS) || 120000;

// Node's permission model: read access to the scanner and the skill only, no
// writes, no child processes, no workers, and no network where Node supports it.
function sandboxFlags(root) {
  const allowed = process.allowedNodeEnvironmentFlags;
  const flag = allowed.has('--permission')
    ? '--permission'
    : allowed.has('--experimental-permission')
      ? '--experimental-permission'
      : null;
  if (!flag) return null;
  const reads = [SCRIPT_DIR, path.resolve(root)];
  try {
    reads.push(fs.realpathSync(root));
  } catch {
    /* the walk reports unreadable folders */
  }
  // Keep only top-level entries: Node can drop a folder grant when one of its
  // subfolders is granted too (seen on Node 26 / Windows).
  const inside = (child, parent) => {
    const rel = path.relative(parent, child);
    return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const top = reads.filter(
    (p, i) =>
      !reads.some(
        (q, j) => j !== i && inside(p, q) && !(inside(q, p) && j > i),
      ),
  );
  return {
    args: [flag, ...top.map((r) => `--allow-fs-read=${r}`)],
    network: allowed.has('--allow-net'),
  };
}

function failedStatic(root, message) {
  return {
    name: sanitize(path.basename(root), 80),
    digest: 'sha256:unknown',
    stats: { files: 0, bytes: 0, scripts: 0, binaries: 0, symlinks: 0 },
    findings: [
      {
        rule: 'scan-incomplete',
        severity: REJECT,
        category: 'unanalysable',
        file: '.',
        lines: [],
        count: 1,
        message,
        evidence: '',
      },
    ],
    externalReferences: [],
    scripts: [],
    description: null,
    hosts: [],
    fileList: [],
  };
}

function runStatic(root, useSandbox, policy) {
  const sandbox = useSandbox ? sandboxFlags(root) : null;
  if (!sandbox)
    return {
      ...staticScan(root, policy),
      sandbox: useSandbox
        ? 'unavailable (Node without a permission model)'
        : 'off (--no-sandbox)',
    };
  const r = spawnSync(
    process.execPath,
    [
      ...sandbox.args,
      fileURLToPath(import.meta.url),
      '--internal-static',
      root,
    ],
    {
      // The policy travels on stdin, not in the environment: the Windows
      // environment block is too small for it, and the scanner's own rules
      // treat the environment as sensitive. The permission model restricts
      // paths, not descriptors, so fd 0 stays readable in the child.
      input: JSON.stringify(policy),
      encoding: 'utf8',
      timeout: STATIC_TIMEOUT_MS,
      maxBuffer: 512 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const label = `Node permission model (read-only, no child processes${sandbox.network ? ', no network' : ''})`;
  if (r.error?.code === 'ETIMEDOUT' || r.signal) {
    return {
      ...failedStatic(
        root,
        `Static analysis did not finish within ${STATIC_TIMEOUT_MS / 1000} s (crafted input can cause this)`,
      ),
      sandbox: label,
    };
  }
  if (r.status !== 0) {
    const reason = sanitize(
      (r.stderr ?? '').trim().split('\n').filter(Boolean).pop() ||
        `exit ${r.status}`,
      200,
    );
    return {
      ...failedStatic(root, `Static analysis failed: ${reason}`),
      sandbox: label,
    };
  }
  const result = JSON.parse(r.stdout);
  // A read the sandbox blocked means part of the skill went unchecked: fail closed.
  if (result.findings.some((f) => f.message.includes('ERR_ACCESS_DENIED'))) {
    return {
      ...failedStatic(
        root,
        'The sandbox blocked a read inside the skill, so the scan is incomplete',
      ),
      sandbox: label,
    };
  }
  return { ...result, sandbox: label };
}

function sortFindings(list) {
  return list.sort(
    (a, b) =>
      RANK[b.severity] - RANK[a.severity] ||
      a.category.localeCompare(b.category) ||
      a.file.localeCompare(b.file) ||
      (a.lines[0] ?? 0) - (b.lines[0] ?? 0),
  );
}

function scanSkill(root, options) {
  const policy = options.policy ?? defaultPolicy();
  const partial = runStatic(root, options.sandbox, policy);
  const extra = new Findings();
  checkGitTree(root, extra);
  // A malformed override is a finding, never a silent fallback: the author
  // believed it was in force.
  for (const note of policy.notes)
    extra.add({
      rule: 'policy-override',
      severity: REVIEW,
      category: 'policy',
      file: '(policy)',
      line: 0,
      message: note,
    });
  for (const name of policy.trustAdded)
    extra.add({
      rule: 'policy-trust-added',
      severity: INFO,
      category: 'policy',
      file: '(policy)',
      line: 0,
      message: `Trusted only through the local override: ${name}`,
    });
  const entries = partial.fileList.map((f) => ({
    type: 'file',
    rel: f.rel,
    abs: path.join(root, f.rel),
    size: f.size,
  }));
  const av = options.av
    ? runAntivirus(root, entries, options.sandbox)
    : 'skipped';
  applyAntivirus(
    av,
    extra,
    partial.stats.scripts > 0 || partial.stats.binaries > 0,
  );
  const list = sortFindings([...partial.findings, ...extra.list()]);
  const worst = list.reduce((acc, f) => Math.max(acc, RANK[f.severity]), 0);
  return {
    name: partial.name,
    root,
    verdict: VERDICT[worst],
    digest: partial.digest,
    sandbox: partial.sandbox,
    stats: {
      ...partial.stats,
      reject: list.filter((f) => f.severity === REJECT).length,
      review: list.filter((f) => f.severity === REVIEW).length,
      info: list.filter((f) => f.severity === INFO).length,
    },
    antivirus: av === 'skipped' ? [] : av,
    policy: {
      mode: policy.strict ? 'strict' : 'standard',
      source: policy.trustSource,
      sha256: policy.hash,
    },
    findings: list,
    externalReferences: partial.externalReferences,
    dependencies: partial.dependencies ?? [],
    scripts: partial.scripts,
    description: partial.description ?? null,
    // Built here, not in the child, so antivirus results and a failed static
    // pass appear in the summary alongside everything else.
    capabilities: summariseCapabilities(list),
    hosts: partial.hosts ?? [],
  };
}

function isDirSafe(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// A folder without SKILL.md that holds several skills is scanned one skill at a time.
function discoverSkillRoots(target) {
  const isPluginRoot = ['.claude-plugin', '.codex-plugin'].some((d) =>
    fs.existsSync(path.join(target, d)),
  );
  if (fs.existsSync(path.join(target, 'SKILL.md')) || isPluginRoot)
    return [target];
  const roots = [];
  const stack = [{ dir: target, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of names) {
      if (d.name === '.git' || d.name === 'node_modules') continue;
      const child = path.join(dir, d.name);
      // Follow linked skill folders here (AgentPM installs are links); the scan itself never follows links.
      if (!d.isDirectory() && !(d.isSymbolicLink() && isDirSafe(child)))
        continue;
      if (fs.existsSync(path.join(child, 'SKILL.md'))) roots.push(child);
      else if (depth < 6) stack.push({ dir: child, depth: depth + 1 });
    }
  }
  return roots.length ? roots.sort() : [target];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const VERDICT_TEXT = {
  PASS: 'PASS: no known risk patterns found. This is not a safety certificate.',
  REVIEW:
    'REVIEW: do not install until a person has checked every REVIEW item and approved this exact digest.',
  REJECT: 'REJECT: do not install. At least one blocking finding.',
};

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function renderFindingRows(list) {
  const rows = [
    '| Rule | Location | Finding | Evidence |',
    '|---|---|---|---|',
  ];
  for (const f of list) {
    const loc = f.lines.length
      ? `${f.file}:${f.lines.join(',')}${f.count > f.lines.length ? ` (+${f.count - f.lines.length})` : ''}`
      : f.file;
    rows.push(
      `| ${f.rule} | ${cell(loc)} | ${cell(f.message)} | ${f.evidence ? `\`${cell(f.evidence)}\`` : ''} |`,
    );
  }
  return rows.join('\n');
}

const HOST_TABLE_LIMIT = 20;

const VERDICT_ADVICE = {
  REJECT: 'Do not install. The blocking findings are listed under Reject.',
  REVIEW: 'Read the rows marked "decide", then say yes or no.',
  PASS: 'No pattern in the catalogue matched. That is not a safety certificate.',
};

// The summary a person reads to decide, above the rule-level detail. It answers
// three questions in order: what is this for, what can it do here, and who else
// is involved.
function renderDecisionSummary(r) {
  const out = ['## Decision summary', ''];
  if (r.description)
    out.push(
      `**Purpose**, in the author's own words: "${r.description}"`,
      '',
      "_The description is the author's claim. The rows below are what the files actually contain._",
      '',
    );
  out.push(
    `**Size:** ${r.stats.files} files, ${r.stats.scripts} scripts, ${r.stats.binaries} binaries or archives, ${(r.stats.bytes / 1024).toFixed(1)} KB.`,
    '',
  );

  out.push('**What it can do on this machine**', '');
  if (r.capabilities?.length) {
    out.push(
      '| Weight | Capability | Places | For example |',
      '|---|---|---|---|',
    );
    for (const c of r.capabilities)
      out.push(
        `| ${WEIGHT_TEXT[c.severity]} | ${cell(c.label)} | ${c.places} | ${cell(c.where.join(', ') || '-')} |`,
      );
    out.push('');
  } else {
    out.push(
      'Nothing the catalogue recognises: no network, no packages, no code outside its own folder.',
      '',
    );
  }

  if (r.hosts?.length) {
    out.push(
      `**External addresses it names (${r.hosts.length} ${r.hosts.length === 1 ? 'host' : 'hosts'})**`,
      '',
      'Whoever owns a host decides what it serves tomorrow. Check that each one belongs to the job above.',
      '',
      '| Weight | Host | What the skill does with it | Mentions | Where |',
      '|---|---|---|---|---|',
    );
    // Worst first, so a long tail of documentation links cannot push the one
    // host that matters below the fold. The full list is in External references.
    const shown = r.hosts.slice(0, HOST_TABLE_LIMIT);
    for (const h of shown)
      out.push(
        `| ${WEIGHT_TEXT[h.severity]} | \`${cell(h.host)}\` | ${cell(h.context)} | ${h.count} | ${cell(h.where.join(', '))} |`,
      );
    if (r.hosts.length > shown.length)
      out.push(
        `| note | _${r.hosts.length - shown.length} more_ | see External references | | |`,
      );
    out.push('');
  } else {
    out.push('**External addresses it names:** none.', '');
  }

  const decide = r.findings.filter((f) => f.severity !== INFO);
  if (decide.length) {
    const seen = new Set();
    const top = [];
    for (const f of decide) {
      if (seen.has(f.rule)) continue;
      seen.add(f.rule);
      top.push(f);
      if (top.length === 6) break;
    }
    out.push(
      `**${decide.length} ${decide.length === 1 ? 'finding needs' : 'findings need'} a decision**${decide.length > top.length ? `, top ${top.length}` : ''}`,
      '',
    );
    for (const f of top)
      out.push(
        `- ${WEIGHT_TEXT[f.severity]} — ${sanitize(f.message, 160)} (\`${cell(f.file)}${f.line ? `:${f.line}` : ''}\`)`,
      );
    out.push('');
  }
  out.push(`**Next step:** ${VERDICT_ADVICE[r.verdict]}`);
  return out;
}

function renderReport(r) {
  const out = [];
  out.push(`# Skill security report: ${r.name}`, '');
  out.push(`**Verdict: ${VERDICT_TEXT[r.verdict]}**`, '');
  out.push(`- Path: \`${r.root}\``);
  out.push(
    `- Content digest: \`${r.digest}\` (approvals apply to this digest only)`,
  );
  out.push(
    `- Files: ${r.stats.files} (${r.stats.scripts} scripts, ${r.stats.binaries} binaries or archives, ${r.stats.symlinks} symlinks), ${(r.stats.bytes / 1024).toFixed(1)} KB`,
  );
  const av = r.antivirus.length
    ? r.antivirus
        .map(
          (e) =>
            `${e.engine}: ${e.status}${e.threats?.length ? ` (${e.threats.join('; ')})` : ''}`,
        )
        .join(', ')
    : 'not run or no engine found';
  out.push(`- Antivirus: ${av}`);
  out.push(`- Sandbox for static analysis: ${r.sandbox}`);
  out.push(
    `- Findings: ${r.stats.reject} reject, ${r.stats.review} review, ${r.stats.info} info`,
    '',
  );

  const by = (sev) => r.findings.filter((f) => f.severity === sev);
  const categories = (list) =>
    [...new Set(list.map((f) => f.category))].join(', ');

  out.push(...renderDecisionSummary(r), '');
  if (by(REJECT).length)
    out.push(
      '## Reject',
      '',
      `Categories: ${categories(by(REJECT))}`,
      '',
      renderFindingRows(by(REJECT)),
      '',
    );
  if (by(REVIEW).length)
    out.push(
      '## Review',
      '',
      `Categories: ${categories(by(REVIEW))}`,
      '',
      renderFindingRows(by(REVIEW)),
      '',
    );
  if (r.dependencies.length) {
    out.push(
      '## Dependencies',
      '',
      '| Ecosystem | Package | Version | Pinned | Class | Where |',
      '|---|---|---|---|---|---|',
    );
    for (const d of r.dependencies) {
      const where = d.locations
        .map((l) => (l.line ? `${l.file}:${l.line}` : l.file))
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 3)
        .join(', ');
      const pin = d.integrity ? 'hash' : d.pinned ? 'exact' : 'no';
      out.push(
        `| ${cell(d.ecosystem)} | \`${cell(d.name)}\` | ${cell(d.version || '-')} | ${pin} | ${cell(d.class)} | ${cell(where)} |`,
      );
    }
    out.push('');
  }
  if (r.externalReferences.length) {
    out.push(
      '## External references',
      '',
      '| Kind | Reference | Where |',
      '|---|---|---|',
    );
    for (const ref of r.externalReferences)
      out.push(
        `| ${ref.kind} | \`${cell(ref.value)}\` | ${cell(ref.locations.join(', '))} |`,
      );
    out.push('');
  }
  if (r.scripts.length) {
    out.push(
      '## Scripts',
      '',
      '| File | Language | Lines | SHA-256 |',
      '|---|---|---|---|',
    );
    for (const s of r.scripts)
      out.push(
        `| ${cell(s.file)} | ${cell(s.language)} | ${s.lines} | \`${s.sha256.slice(0, 16)}\` |`,
      );
    out.push('');
  }
  if (by(INFO).length) out.push('## Info', '', renderFindingRows(by(INFO)), '');
  out.push(
    `_skill-security-check scanner ${SCANNER_VERSION}, ruleset sha256:${selfHash().slice(0, 16)}, policy ${r.policy.mode} sha256:${r.policy.sha256.slice(0, 16)}. Static analysis only: it cannot see content that remote servers deliver later, and PASS is not a safety certificate._`,
  );
  return out.join('\n');
}

function renderSummary(results) {
  const out = [
    '| Verdict | Skill | Reject | Review | Top reasons |',
    '|---|---|---|---|---|',
  ];
  for (const r of results) {
    const top = [
      ...new Set(
        r.findings.filter((f) => f.severity !== INFO).map((f) => f.rule),
      ),
    ]
      .slice(0, 4)
      .join(', ');
    out.push(
      `| ${r.verdict} | ${cell(r.name)} | ${r.stats.reject} | ${r.stats.review} | ${cell(top)} |`,
    );
  }
  const count = (v) => results.filter((r) => r.verdict === v).length;
  out.push(
    '',
    `Total ${results.length}: ${count('PASS')} PASS, ${count('REVIEW')} REVIEW, ${count('REJECT')} REJECT`,
  );
  return out.join('\n');
}

// The rules live in several files, so hashing scan.mjs alone would let the
// policy, the parsers or the antivirus signatures change without the
// approval hash noticing.
const RULESET_FILES = [
  'scan.mjs',
  'remote-content.mjs',
  'package-policy.mjs',
  'trust-data.mjs',
  'tiny-av.mjs',
  'av-signatures.mjs',
];

let cachedSelfHash;
function selfHash() {
  if (!cachedSelfHash) {
    const h = createHash('sha256');
    for (const name of RULESET_FILES)
      h.update(name)
        .update('\u0000')
        .update(fs.readFileSync(path.join(SCRIPT_DIR, name)));
    cachedSelfHash = h.digest('hex');
  }
  return cachedSelfHash;
}

// ---------------------------------------------------------------------------
// Trust policy
// ---------------------------------------------------------------------------

const POLICY_FILE = 'skill-trust.json';
const POLICY_MAX_BYTES = 256 * 1024;

function defaultTrustPath(env) {
  const home = env.AGENTPM_HOME;
  if (home) return path.join(home, POLICY_FILE);
  try {
    return path.join(os.homedir(), '.agentpm', POLICY_FILE);
  } catch {
    return null;
  }
}

function nameList(value) {
  if (!Array.isArray(value)) return null;
  if (value.some((n) => typeof n !== 'string' || n.length > 214)) return null;
  return value.map(String);
}

// Strict schema: anything unrecognised makes the whole file a REVIEW finding
// rather than being skipped quietly, because a silent skip hides a typo that
// the author believed was protecting them.
function parseOverride(raw, file, notes) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    notes.push(`Trust override ${file} is not valid JSON and was ignored`);
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    notes.push(`Trust override ${file} is not an object and was ignored`);
    return null;
  }
  const bad = Object.keys(data).filter(
    (k) => !['schema', 'add', 'remove'].includes(k),
  );
  if (bad.length) {
    notes.push(
      `Trust override ${file} has unknown keys (${bad.join(', ')}) and was ignored`,
    );
    return null;
  }
  if (data.schema !== TRUST_SCHEMA_VERSION) {
    notes.push(
      `Trust override ${file} has schema ${JSON.stringify(data.schema)}, expected ${TRUST_SCHEMA_VERSION}; ignored`,
    );
    return null;
  }
  const out = { add: {}, remove: {} };
  for (const side of ['add', 'remove']) {
    const section = data[side];
    if (section === undefined) continue;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      notes.push(`Trust override ${file} has a malformed '${side}'; ignored`);
      return null;
    }
    for (const [ecosystem, names] of Object.entries(section)) {
      const list = nameList(names);
      if (!list) {
        notes.push(
          `Trust override ${file} has a malformed '${side}.${ecosystem}'; ignored`,
        );
        return null;
      }
      out[side][ecosystem] = list;
    }
  }
  return out;
}

function readOverride(file, notes) {
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null; // No override file is the normal case.
  }
  if (st.isSymbolicLink()) {
    notes.push(`Trust override ${file} is a symlink and was ignored`);
    return null;
  }
  if (!st.isFile()) {
    notes.push(`Trust override ${file} is not a regular file and was ignored`);
    return null;
  }
  if (st.size > POLICY_MAX_BYTES) {
    notes.push(
      `Trust override ${file} is larger than ${POLICY_MAX_BYTES / 1024} KB and was ignored`,
    );
    return null;
  }
  try {
    return parseOverride(fs.readFileSync(file, 'utf8'), file, notes);
  } catch {
    notes.push(`Trust override ${file} could not be read and was ignored`);
    return null;
  }
}

function applyOverride(trust, override, strict, notes) {
  const packages = { ...trust.packages };
  // Removing trust can only make the scan stricter, so it always applies.
  for (const [ecosystem, names] of Object.entries(override.remove)) {
    const drop = new Set(names);
    packages[ecosystem] = (packages[ecosystem] ?? []).filter(
      (n) => !drop.has(n),
    );
  }
  const added = [];
  const wants = Object.entries(override.add);
  if (strict && wants.length) {
    notes.push('Trust override additions were ignored because --strict is set');
  } else {
    // An agent can write this file, and a skill's own prose can tell it to, so
    // every name trusted only through the override is named in the report.
    for (const [ecosystem, names] of wants) {
      packages[ecosystem] = [...(packages[ecosystem] ?? []), ...names];
      for (const n of names) added.push(`${ecosystem}:${n}`);
    }
  }
  return { trust: { ...trust, packages }, added };
}

function policyHash(policy) {
  const t = policy.trust;
  const packages = {};
  for (const key of Object.keys(t.packages ?? {}).sort())
    packages[key] = [...t.packages[key]].sort();
  return createHash('sha256')
    .update(
      JSON.stringify({
        schema: policy.schema,
        strict: policy.strict,
        packages,
        registries: t.registries,
        docHosts: t.docHosts,
        contentHosts: t.contentHosts,
        mutablePaths: t.mutablePaths,
      }),
    )
    .digest('hex');
}

function loadPolicy(env, opts) {
  const strict = Boolean(opts.strict);
  const notes = [];
  let trust = BUNDLED_TRUST;
  let added = [];
  let source = 'bundled';
  if (!opts.noTrust) {
    const file = opts.trustPath
      ? path.resolve(opts.trustPath)
      : defaultTrustPath(env);
    const override = file ? readOverride(file, notes) : null;
    if (override) {
      ({ trust, added } = applyOverride(trust, override, strict, notes));
      source = file;
    } else if (opts.trustPath && !notes.length) {
      notes.push(`Trust override ${file} was not found`);
    }
  }
  const policy = {
    schema: TRUST_SCHEMA_VERSION,
    strict,
    trust,
    trustSource: source,
    trustAdded: added,
    notes,
  };
  policy.hash = policyHash(policy);
  return policy;
}

function defaultPolicy() {
  const policy = {
    schema: TRUST_SCHEMA_VERSION,
    strict: false,
    trust: BUNDLED_TRUST,
    trustSource: 'bundled',
    trustAdded: [],
    notes: [],
  };
  policy.hash = policyHash(policy);
  return policy;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const flags = new Set();
  const targets = [];
  let trustPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--trust') {
      flags.add('--trust');
      i += 1;
      trustPath = argv[i] ?? '';
      continue;
    }
    if (a.startsWith('--trust=')) {
      flags.add('--trust');
      trustPath = a.slice('--trust='.length);
      continue;
    }
    if (a.startsWith('--')) flags.add(a);
    else targets.push(a);
  }
  if (flags.has('--internal-static') && targets.length === 1) {
    // The parent hands the effective policy down on stdin.
    const raw = fs.readFileSync(0, 'utf8');
    process.stdout.write(
      JSON.stringify(staticScan(targets[0], JSON.parse(raw))),
    );
    return 0;
  }
  const known = new Set([
    '--json',
    '--summary',
    '--single',
    '--no-av',
    '--no-sandbox',
    '--strict',
    '--trust',
    '--no-trust',
    '--help',
  ]);
  const unknown = [...flags].filter((f) => !known.has(f));
  if (
    flags.has('--help') ||
    targets.length !== 1 ||
    unknown.length ||
    (flags.has('--trust') && !trustPath)
  ) {
    const msg =
      'Usage: node scan.mjs <skill-or-repo-path> [--json] [--summary] [--single] [--no-av] [--no-sandbox] [--strict] [--trust <file>] [--no-trust]';
    (flags.has('--help') ? console.log : console.error)(
      unknown.length ? `Unknown option: ${unknown.join(' ')}\n${msg}` : msg,
    );
    return flags.has('--help') ? 0 : 3;
  }
  const target = path.resolve(targets[0]);
  let st;
  try {
    st = fs.statSync(target);
  } catch {
    console.error(`Not found: ${target}`);
    return 3;
  }
  if (!st.isDirectory()) {
    console.error(
      'Target must be a folder. Extract archives into a quarantine folder first.',
    );
    return 3;
  }
  const policy = loadPolicy(process.env, {
    strict: flags.has('--strict'),
    noTrust: flags.has('--no-trust'),
    trustPath,
  });
  const roots = flags.has('--single') ? [target] : discoverSkillRoots(target);
  const results = roots.map((root) =>
    scanSkill(root, {
      av: !flags.has('--no-av'),
      sandbox: !flags.has('--no-sandbox'),
      policy,
    }),
  );
  const worst = results.reduce(
    (acc, r) => Math.max(acc, { PASS: 0, REVIEW: 1, REJECT: 2 }[r.verdict]),
    0,
  );

  if (flags.has('--json')) {
    console.log(
      JSON.stringify(
        {
          scanner: 'skill-security-check',
          version: SCANNER_VERSION,
          rulesetSha256: selfHash(),
          policy: {
            mode: policy.strict ? 'strict' : 'standard',
            source: policy.trustSource,
            sha256: policy.hash,
          },
          target,
          verdict: VERDICT[worst],
          results,
        },
        null,
        2,
      ),
    );
  } else if (flags.has('--summary') || results.length > 1) {
    console.log(renderSummary(results));
    if (!flags.has('--summary'))
      for (const r of results) console.log(`\n---\n\n${renderReport(r)}`);
  } else {
    console.log(renderReport(results[0]));
  }
  return worst;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`skill-security-check failed: ${error?.stack ?? error}`);
  process.exitCode = 3;
}
