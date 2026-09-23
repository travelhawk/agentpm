// Dependency identity: naming, pin grammar and source classification.
//
// Pure functions, no I/O. This module is imported by the sandboxed static
// analysis child, which may only read its own directory and the skill, so it
// must never touch the filesystem or the network.
//
// The rules here answer one question per dependency: can the content that
// would be installed still change after this review? Version pins and artifact
// hashes answer it; a package's name and popularity do not.

export const TRUST_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

// Legal character sets. A name outside these cannot be the package it claims
// to be, which makes it a zero-false-positive reject.
const NAME_RE = {
  npm: /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/,
  pypi: /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
  cargo: /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]*)$/,
  rubygems: /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*)$/,
  go: /^[a-zA-Z0-9](?:[a-zA-Z0-9._~/-]*)$/,
  nuget: /^[A-Za-z0-9](?:[A-Za-z0-9._-]*)$/,
  composer: /^[a-z0-9](?:[a-z0-9._-]*)\/[a-z0-9](?:[a-z0-9._-]*)$/,
  docker: /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/,
};

// Scripts that must not be mixed inside one package name. Latin plus digits is
// the only expected case; anything else is a homoglyph attempt.
const NON_LATIN_RE = /[^\p{Script=Latin}\p{Nd}\p{P}\p{S}\s]/u;

/**
 * Canonical key for a package name, plus a verdict on whether the raw name can
 * legally be that package.
 *
 * PyPI collapses `[-_.]+` to `-` (PEP 503), so `my_pkg` and `my-pkg` are the
 * same project and a separator difference there is never a typosquat. npm
 * treats them as different packages, so there it is.
 */
export function normalizeName(ecosystem, raw) {
  const name = String(raw ?? '').trim();
  if (!name) return { key: '', ok: false, reason: 'empty name' };

  if (name.normalize('NFKC') !== name)
    return { key: name.toLowerCase(), ok: false, reason: 'not NFKC-stable' };
  if (NON_LATIN_RE.test(name))
    return {
      key: name.toLowerCase(),
      ok: false,
      reason: 'mixes non-Latin script into the name',
    };

  let key = name.toLowerCase();
  if (ecosystem === 'pypi') key = key.replace(/[-_.]+/g, '-');
  else if (ecosystem === 'cargo') key = key.replace(/_/g, '-');
  else if (ecosystem === 'docker' && !key.includes('/')) key = `library/${key}`;

  // Case is normalized by every registry here, so validity is tested against
  // the lowercased name. Only characters that cannot appear at all are a
  // reason to reject.
  const re = NAME_RE[ecosystem];
  if (re && !re.test(name.toLowerCase()))
    return { key, ok: false, reason: `not a legal ${ecosystem} package name` };
  return { key, ok: true, reason: '' };
}

// Import names are not distribution names. Without this table "the import
// matches the pinned dependency" is wrong in both directions.
const IMPORT_ALIASES = {
  pypi: {
    PIL: 'pillow',
    yaml: 'pyyaml',
    bs4: 'beautifulsoup4',
    cv2: 'opencv-python',
    sklearn: 'scikit-learn',
    skimage: 'scikit-image',
    dateutil: 'python-dateutil',
    docx: 'python-docx',
    pptx: 'python-pptx',
    fitz: 'pymupdf',
    Crypto: 'pycryptodome',
    OpenSSL: 'pyopenssl',
    jwt: 'pyjwt',
    git: 'gitpython',
    attr: 'attrs',
    magic: 'python-magic',
    serial: 'pyserial',
    usb: 'pyusb',
    lxml: 'lxml',
    zoneinfo: 'backports-zoneinfo',
    dotenv: 'python-dotenv',
    pkg_resources: 'setuptools',
    setuptools: 'setuptools',
    google: 'protobuf',
    ruamel: 'ruamel-yaml',
    win32com: 'pywin32',
    win32api: 'pywin32',
    pythoncom: 'pywin32',
    Xlib: 'python-xlib',
    markdown_it: 'markdown-it-py',
    mpl_toolkits: 'matplotlib',
    pylab: 'matplotlib',
    IPython: 'ipython',
    nacl: 'pynacl',
    slugify: 'python-slugify',
    tzlocal: 'tzlocal',
    ua_parser: 'ua-parser',
    yattag: 'yattag',
    Levenshtein: 'python-levenshtein',
    snappy: 'python-snappy',
    speech_recognition: 'speechrecognition',
    telebot: 'pytelegrambotapi',
  },
};

export function importToDistribution(ecosystem, importName) {
  const table = IMPORT_ALIASES[ecosystem];
  if (table && Object.prototype.hasOwnProperty.call(table, importName))
    return table[importName];
  return importName;
}

// ---------------------------------------------------------------------------
// Version pins
// ---------------------------------------------------------------------------

const SEMVER_CORE = String.raw`\d+\.\d+\.\d+(?:[-+][\w.]+)?`;

/**
 * How tightly a version spec fixes the package.
 *
 * 'exact' means one published version. 'range' means a resolver picks at
 * install time. 'tag' means a moving pointer. 'none' means nothing was said.
 *
 * Cargo is the trap: `serde = "1.0.200"` is `^1.0.200`, a range, while the
 * identical string in package.json is exact. A shared "looks like a version"
 * test gets Cargo wrong in the unsafe direction.
 */
export function classifyPin(ecosystem, rawSpec) {
  const spec = String(rawSpec ?? '').trim();
  if (!spec) return 'none';

  switch (ecosystem) {
    case 'npm': {
      if (/^(?:=|v)?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(spec)) return 'exact';
      if (/[\^~><*|\sx]/.test(spec) || /\.x\b/.test(spec)) return 'range';
      if (/^\d+(?:\.\d+)?$/.test(spec)) return 'range';
      return 'tag';
    }
    case 'pypi': {
      // `==1.2.*` is a range even though it starts with `==`.
      if (/^===?\s*[^*\s,]+$/.test(spec) && !/\*/.test(spec)) return 'exact';
      if (/[><~!]|\*|,/.test(spec)) return 'range';
      return 'none';
    }
    case 'cargo': {
      if (/^=\s*\d+\.\d+\.\d+/.test(spec)) return 'exact';
      return 'range';
    }
    case 'go': {
      if (new RegExp(String.raw`^v${SEMVER_CORE}$`).test(spec)) return 'exact';
      if (/^[0-9a-f]{12,40}$/i.test(spec)) return 'exact';
      return 'tag';
    }
    case 'docker': {
      if (/^sha256:[0-9a-f]{64}$/i.test(spec)) return 'exact';
      return 'tag';
    }
    case 'rubygems':
    case 'nuget':
    case 'composer': {
      if (/^=?\s*\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?$/.test(spec)) return 'exact';
      if (/[\^~><*|]/.test(spec)) return 'range';
      return 'tag';
    }
    default:
      return /^\d+\.\d+\.\d+$/.test(spec) ? 'exact' : 'range';
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const GIT_PREFIX_RE = /^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:)/i;
const PATH_PREFIX_RE = /^(?:file:|link:|portal:|path:|workspace:)/i;

/**
 * Where the artifact would actually come from.
 *
 * The manifest key is not evidence: `"lodash": "npm:evil-pkg@1.0.0"` has a
 * trusted key and an untrusted target. Always classify the resolved target.
 */
export function classifySource(rawSpec) {
  const spec = String(rawSpec ?? '').trim();
  if (!spec) return { source: 'default-registry', target: null, version: '' };

  // PEP 508 direct reference: `requests @ https://host/x.whl`
  const direct = /^(.*?)\s+@\s+(.+)$/.exec(spec);
  if (direct) {
    const inner = classifySource(direct[2]);
    return { ...inner, target: inner.target ?? direct[2].trim() };
  }

  if (/^https?:\/\//i.test(spec))
    return { source: 'url', target: spec, version: '' };
  if (
    GIT_PREFIX_RE.test(spec) ||
    /^[\w.-]+\/[\w.-]+#[0-9a-f]{7,40}$/i.test(spec)
  )
    return { source: 'git', target: spec, version: '' };
  if (PATH_PREFIX_RE.test(spec))
    return {
      source: 'path',
      target: spec.replace(PATH_PREFIX_RE, ''),
      version: '',
    };
  if (/^npm:/i.test(spec)) {
    const rest = spec.slice(4);
    const at = rest.lastIndexOf('@');
    const target = at > 0 ? rest.slice(0, at) : rest;
    const version = at > 0 ? rest.slice(at + 1) : '';
    return { source: 'alias', target, version };
  }
  if (/^(?:\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/])/.test(spec))
    return { source: 'path', target: spec, version: '' };
  // `user/repo` with no scheme is a GitHub shorthand in package.json.
  if (/^[\w.-]+\/[\w.-]+$/.test(spec) && !/^@/.test(spec))
    return { source: 'git', target: spec, version: '' };

  return { source: 'default-registry', target: null, version: spec };
}

/**
 * Splits `name@version`, `name==version`, `image:tag` into parts. Scoped npm
 * names keep their leading `@`.
 */
export function splitSpec(ecosystem, token) {
  const raw = String(token ?? '').trim();
  if (!raw) return { name: '', version: '' };

  if (ecosystem === 'docker') {
    const digest = raw.indexOf('@');
    if (digest > 0)
      return { name: raw.slice(0, digest), version: raw.slice(digest + 1) };
    const slash = raw.lastIndexOf('/');
    const colon = raw.lastIndexOf(':');
    if (colon > slash && colon > 0)
      return { name: raw.slice(0, colon), version: raw.slice(colon + 1) };
    return { name: raw, version: '' };
  }

  if (ecosystem === 'pypi') {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/.exec(raw);
    if (!m) return { name: raw, version: '' };
    return { name: m[1], version: (m[3] ?? '').trim() };
  }

  if (ecosystem === 'go') {
    const at = raw.lastIndexOf('@');
    return at > 0
      ? { name: raw.slice(0, at), version: raw.slice(at + 1) }
      : { name: raw, version: '' };
  }

  // npm and the rest: `@scope/name@version`. Split at the FIRST separating
  // `@`, not the last: `lodash@npm:evil-pkg@1.0.0` names `lodash` and aliases
  // it to something else, and lastIndexOf would hide that.
  const at = raw.indexOf('@', raw.startsWith('@') ? 1 : 0);
  if (at > 0) return { name: raw.slice(0, at), version: raw.slice(at + 1) };
  return { name: raw, version: '' };
}

// ---------------------------------------------------------------------------
// Registry and index overrides
// ---------------------------------------------------------------------------

// An index override redirects installs for the whole environment, so a pinned
// trusted name means nothing next to one. `--extra-index-url` is worse than
// `--index-url`: it keeps the default index and pip takes the highest version
// across both, which is dependency confusion against a pinned name.
export const INDEX_OVERRIDE_PATTERNS = [
  {
    re: /--(?:extra-)?index-url[\s=]|--find-links[\s=]|--trusted-host[\s=]/,
    what: 'pip index option',
  },
  {
    re: /\bnpm\s+config\s+set\s+(?:@[\w-]+:)?registry\b|\byarn\s+config\s+set\s+(?:npm)?registry\b/i,
    what: 'npm registry override',
  },
  {
    re: /\bpip\s+config\s+set\s+(?:global|install)\.(?:extra-)?index-url\b/i,
    what: 'pip config override',
  },
  {
    re: /\bpoetry\s+source\s+add\b|\bdotnet\s+nuget\s+add\s+source\b|\bgem\s+sources\s+--add\b|\bcargo\s+config\b/i,
    what: 'registry source added',
  },
  {
    re: /\b(?:PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|UV_INDEX_URL|UV_DEFAULT_INDEX|NPM_CONFIG_REGISTRY|YARN_REGISTRY|GOPROXY|GEM_HOST|GEM_SOURCE|CARGO_REGISTRY\w*)\s*=/,
    what: 'registry environment variable',
  },
];

// Config files whose whole purpose is to point installs somewhere else.
export const INDEX_OVERRIDE_FILES = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'bunfig.toml',
  'pip.conf',
  'pip.ini',
  'uv.toml',
  '.pypirc',
  'nuget.config',
]);

/** Contents of a config file that actually redirect a registry. */
export function fileRedirectsRegistry(lower, text) {
  if (!INDEX_OVERRIDE_FILES.has(lower)) {
    // `.cargo/config.toml` only matters when it replaces the crates.io source.
    if (
      lower === 'config.toml' &&
      /\[source\.crates-io\][\s\S]*?replace-with/.test(text)
    )
      return 'cargo source replacement';
    return null;
  }
  if (
    /(?:^|\n)\s*(?:registry|index-url|extra-index-url|npmRegistryServer|index|url)\s*[:=]/i.test(
      text,
    )
  )
    return `${lower} sets a registry or index`;
  if (/<add\s+key=/i.test(text)) return `${lower} adds a package source`;
  return `${lower} can redirect installs`;
}

// ---------------------------------------------------------------------------
// Install commands
// ---------------------------------------------------------------------------

/** Splits a shell line into separate commands on `&&`, `||`, `;` and pipes. */
export function splitCommands(line) {
  return String(line ?? '')
    .split(/\s*(?:&&|\|\||[;|])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Shell-ish tokenizer that keeps quoted strings in one piece. */
export function tokenize(command) {
  const out = [];
  // Shell word splitting: quoted and unquoted runs that touch each other are
  // one word. Without that, `-v "$vol":/volume` splits into two arguments and
  // `:/volume` is read as the image name.
  const re = /(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s"'])+/g;
  let expectTarget = false;
  let m;
  while ((m = re.exec(command)) !== null) {
    const raw = m[0];
    // Redirections are not arguments. `command -v npx >/dev/null` otherwise
    // hands `/dev/null` to npx as the package to run.
    const redirect = /^(?:\d*|&)(?:>>?|<)(.*)$/.exec(raw);
    if (redirect) {
      expectTarget = !redirect[1];
      continue;
    }
    if (expectTarget) {
      expectTarget = false;
      continue;
    }
    out.push(
      raw.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_s, dq, sq) =>
        (dq ?? sq ?? '').replace(/\\(.)/g, '$1'),
      ),
    );
  }
  return out;
}

const OS_MANAGERS =
  /^(?:brew|apt|apt-get|yum|dnf|zypper|apk|pacman|choco|winget|scoop|snap|flatpak)$/;

// Every command head the parser understands.
const MANAGER_RE =
  /^(?:npx|bunx|pnpx|npm|pnpm|yarn|bun|pip3?|python3?|py|uv|uvx|pipx|poetry|gem|bundle|go|cargo|composer|dotnet|docker|podman|nerdctl|brew|apt|apt-get|yum|dnf|zypper|apk|pacman|choco|winget|scoop|snap|flatpak)$/;

// Markdown and shell decoration around a token: code-span backticks, a `$` or
// `>` prompt, and trailing sentence punctuation.
function cleanToken(tok) {
  const stripped = tok.replace(/^[`$>\s]+/, '').replace(/[`\s]+$/, '');
  // A lone `.` is the local package in `pip install .`, so only trim sentence
  // punctuation from tokens that have something else in them.
  return stripped.length > 1 ? stripped.replace(/[.,;:!?]+$/, '') : stripped;
}

function isOption(t) {
  return t.startsWith('-');
}

// Options that swallow the next token. Without these, `pip install
// --index-url https://evil/ foo` reads the URL as a package name and
// `npm --prefix app install` reads `app` as the subcommand.
const VALUE_OPTS = new Set([
  '-r',
  '--requirement',
  '-c',
  '--constraint',
  '-e',
  '--editable',
  '-i',
  '--index-url',
  '--extra-index-url',
  '-f',
  '--find-links',
  '--trusted-host',
  '-t',
  '--target',
  '--proxy',
  '--cert',
  '--client-cert',
  '--platform',
  '--python-version',
  '--implementation',
  '--abi',
  '--prefix',
  '--root',
  '--src',
  '--no-binary',
  '--only-binary',
  '--progress-bar',
  '--log',
  '--timeout',
  '--retries',
  '--exists-action',
  '--upgrade-strategy',
  '--config-settings',
  '--report',
  '--hash',
  '--python',
  '--index',
  '--default-index',
  '--registry',
  '--workspace',
  '-w',
  '--tag',
  '--scope',
  '--access',
  '--otp',
  '--userconfig',
  '--globalconfig',
  '--cache',
  '--version',
  '--vers',
  '-v',
  '-p',
  '--package',
  '--from',
  '--spec',
  '--pip-args',
  '--with',
  '--group',
  '--optional',
  '--extra',
  '--features',
  '--git',
  '--branch',
  '--rev',
  '--path',
  '--framework',
  '-o',
  '--output',
]);

/**
 * Positional arguments only: options and the values they consume are dropped.
 * `--opt=value` keeps its value attached, so it never eats the next token.
 */
function positional(tokens) {
  const out = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const tok = tokens[k];
    if (!isOption(tok)) {
      out.push(tok);
      continue;
    }
    if (!tok.includes('=') && VALUE_OPTS.has(tok)) k += 1;
  }
  return out;
}

// Package managers whose `install` with no arguments installs a manifest.
const MANIFEST_INSTALLS = {
  npm: new Set(['install', 'i', 'ci']),
  pypi: new Set(['install', 'sync']),
  rubygems: new Set(['install']),
  cargo: new Set(['build', 'fetch']),
  composer: new Set(['install']),
};

/**
 * Reads one shell line and returns what it would fetch.
 *
 * Returns `{deps, overrides, manifestRefs}`. `deps` are partial observations:
 * the caller adds file, line and evidence.
 */
export function parseInstallCommand(line) {
  const deps = [];
  const overrides = [];
  const manifestRefs = [];

  for (const pattern of INDEX_OVERRIDE_PATTERNS)
    if (pattern.re.test(line)) overrides.push(pattern.what);

  // Documentation puts each command in its own code span: "Run `pip install a`
  // then `npx b`" is two commands, not one command with five arguments. Lines
  // from scripts and fenced blocks have no spans and are used whole.
  const spans = [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  const segments = spans.length ? spans : [line];

  for (const command of segments.flatMap(splitCommands)) {
    const t = tokenize(command).map(cleanToken);
    if (!t.length) continue;
    // Documentation writes commands inside prose and code spans ("Run `pip
    // install x`"), and shells prefix them with `sudo`, `$` or an environment
    // assignment. So the command starts at the first token that names a
    // package manager, not at token zero.
    const i = t.findIndex((tok) =>
      MANAGER_RE.test(
        tok
          .replace(/\.exe$/i, '')
          .split('/')
          .pop() ?? '',
      ),
    );
    if (i === -1) continue;
    const head =
      (t[i] ?? '')
        .replace(/\.exe$/i, '')
        .split('/')
        .pop() ?? '';
    const rest = t.slice(i + 1);
    const push = (o) => deps.push(o);

    const scriptsDisabled =
      rest.includes('--ignore-scripts') ||
      rest.some((x) => /^--only-binary(?:[=\s].*)?$/.test(x)) ||
      (rest.includes('--only-binary') && rest.includes(':all:'));

    // --- JavaScript ------------------------------------------------------
    if (/^(?:npx|bunx|pnpx)$/.test(head)) {
      // `npx -p a@1 -c "..."` runs a different package than it names.
      const named = [];
      for (let k = 0; k < rest.length; k += 1) {
        const tok = rest[k];
        if (tok === '-p' || tok === '--package') {
          if (rest[k + 1]) named.push(rest[k + 1]);
          k += 1;
        } else if (tok.startsWith('--package=')) {
          named.push(tok.slice('--package='.length));
        }
      }
      if (!named.length) {
        const first = positional(rest)[0];
        if (first) named.push(first);
      }
      for (const spec of named) {
        const { name, version } = splitSpec('npm', spec);
        const src = classifySource(spec.includes(':') ? spec : '');
        push({
          ecosystem: 'npm',
          rawName: name,
          version,
          pinKind: classifyPin('npm', version),
          source: src.source,
          via: 'launcher',
          runsCode: true,
          scriptsDisabled: false,
        });
      }
      continue;
    }

    if (/^(?:npm|pnpm|yarn|bun)$/.test(head)) {
      const pos = positional(rest);
      const sub = pos[0] ?? '';
      const args = pos.slice(1);
      if (/^(?:dlx|x|exec|create)$/.test(sub)) {
        for (const spec of args.slice(0, 1)) {
          const { name, version } = splitSpec('npm', spec);
          push({
            ecosystem: 'npm',
            rawName: name,
            version,
            pinKind: classifyPin('npm', version),
            source: 'default-registry',
            via: 'launcher',
            runsCode: true,
            scriptsDisabled,
          });
        }
        continue;
      }
      if (MANIFEST_INSTALLS.npm.has(sub) || sub === 'add' || sub === 'update') {
        if (!args.length) {
          manifestRefs.push({
            ecosystem: 'npm',
            target: 'package.json',
            implicit: true,
            scriptsDisabled,
          });
          continue;
        }
        for (const spec of args) {
          const { name, version } = splitSpec('npm', spec);
          const src = classifySource(version || spec);
          const effective = src.source === 'alias' ? src.version : version;
          push({
            ecosystem: 'npm',
            rawName: name,
            target: src.target,
            version: effective,
            pinKind:
              src.source === 'default-registry'
                ? classifyPin('npm', effective)
                : 'none',
            source: src.source,
            via: 'install-command',
            runsCode: false,
            scriptsDisabled,
          });
        }
        continue;
      }
      continue;
    }

    // --- Python ----------------------------------------------------------
    const isPip =
      /^pip3?$/.test(head) ||
      (/^(?:python3?|py)$/.test(head) &&
        rest[0] === '-m' &&
        /^pip3?$/.test(rest[1] ?? ''));
    if (isPip) {
      const args =
        isPip && /^(?:python3?|py)$/.test(head) ? rest.slice(2) : rest;
      if (!args.includes('install')) continue;
      const after = args.slice(args.indexOf('install') + 1);
      for (let k = 0; k < after.length; k += 1) {
        const tok = after[k];
        if (
          tok === '-r' ||
          tok === '--requirement' ||
          tok === '-c' ||
          tok === '--constraint'
        ) {
          if (after[k + 1])
            manifestRefs.push({
              ecosystem: 'pypi',
              target: after[k + 1],
              scriptsDisabled,
            });
          k += 1;
          continue;
        }
        if (isOption(tok)) {
          if (!tok.includes('=') && VALUE_OPTS.has(tok)) k += 1;
          continue;
        }
        if (tok === '.' || tok === './' || tok.startsWith('./')) {
          push({
            ecosystem: 'pypi',
            rawName: tok,
            version: '',
            pinKind: 'none',
            source: 'path',
            via: 'install-command',
            runsCode: true,
            scriptsDisabled,
          });
          continue;
        }
        const src = classifySource(tok);
        const { name, version } = splitSpec('pypi', tok);
        push({
          ecosystem: 'pypi',
          rawName: name,
          target: src.target,
          version,
          pinKind:
            src.source === 'default-registry'
              ? classifyPin('pypi', version)
              : 'none',
          source: src.source,
          via: 'install-command',
          runsCode: false,
          scriptsDisabled,
        });
      }
      continue;
    }

    if (/^(?:uvx|pipx)$/.test(head) || (head === 'uv' && rest[0] === 'tool')) {
      const args = head === 'uv' ? rest.slice(2) : rest;
      if (head === 'pipx' && !/^(?:run|install)$/.test(args[0] ?? '')) continue;
      const first = positional(head === 'pipx' ? args.slice(1) : args)[0];
      if (first) {
        const { name, version } = splitSpec('pypi', first);
        push({
          ecosystem: 'pypi',
          rawName: name,
          version,
          pinKind: classifyPin('pypi', version),
          source: 'default-registry',
          via: 'launcher',
          runsCode: true,
          scriptsDisabled: false,
        });
      }
      continue;
    }

    if (head === 'uv') {
      const sub = rest[0] ?? '';
      if (sub === 'sync') {
        manifestRefs.push({
          ecosystem: 'pypi',
          target: 'pyproject.toml',
          implicit: true,
          scriptsDisabled,
        });
        continue;
      }
      const withArgs = [];
      for (let k = 0; k < rest.length; k += 1)
        if (rest[k] === '--with' && rest[k + 1]) withArgs.push(rest[k + 1]);
      const direct = sub === 'add' ? positional(rest.slice(1)) : [];
      for (const spec of [...withArgs, ...direct]) {
        const { name, version } = splitSpec('pypi', spec);
        push({
          ecosystem: 'pypi',
          rawName: name,
          version,
          pinKind: classifyPin('pypi', version),
          source: classifySource(spec).source,
          via: sub === 'add' ? 'install-command' : 'launcher',
          runsCode: sub !== 'add',
          scriptsDisabled,
        });
      }
      continue;
    }

    if (head === 'poetry') {
      const sub = rest[0] ?? '';
      if (sub === 'install') {
        manifestRefs.push({
          ecosystem: 'pypi',
          target: 'pyproject.toml',
          implicit: true,
          scriptsDisabled,
        });
        continue;
      }
      if (sub === 'add') {
        for (const spec of positional(rest.slice(1))) {
          const { name, version } = splitSpec('pypi', spec);
          push({
            ecosystem: 'pypi',
            rawName: name,
            version,
            pinKind: classifyPin('pypi', version),
            source: classifySource(spec).source,
            via: 'install-command',
            runsCode: false,
            scriptsDisabled,
          });
        }
      }
      continue;
    }

    // --- Other language registries ---------------------------------------
    if (head === 'gem' && rest[0] === 'install') {
      const args = rest.slice(1);
      const names = positional(args);
      const vIdx = args.findIndex((x) => x === '-v' || x === '--version');
      const version = vIdx >= 0 ? (args[vIdx + 1] ?? '') : '';
      for (const name of names) {
        if (name === version) continue;
        push({
          ecosystem: 'rubygems',
          rawName: name,
          version,
          pinKind: classifyPin('rubygems', version),
          source: 'default-registry',
          via: 'install-command',
          runsCode: false,
          scriptsDisabled: false,
        });
      }
      continue;
    }

    if (head === 'bundle' && rest[0] === 'install') {
      manifestRefs.push({
        ecosystem: 'rubygems',
        target: 'Gemfile',
        implicit: true,
        scriptsDisabled,
      });
      continue;
    }

    if (head === 'go' && /^(?:install|get|run)$/.test(rest[0] ?? '')) {
      for (const spec of positional(rest.slice(1))) {
        if (!spec.includes('@') && rest[0] === 'run') continue; // local package
        const { name, version } = splitSpec('go', spec);
        push({
          ecosystem: 'go',
          rawName: name,
          version,
          pinKind: classifyPin('go', version),
          source: 'default-registry',
          via: rest[0] === 'run' ? 'launcher' : 'install-command',
          runsCode: rest[0] !== 'get',
          scriptsDisabled: false,
        });
      }
      continue;
    }

    if (head === 'cargo' && /^(?:install|add|binstall)$/.test(rest[0] ?? '')) {
      const args = rest.slice(1);
      const vIdx = args.findIndex((x) => x === '--version' || x === '--vers');
      const version = vIdx >= 0 ? (args[vIdx + 1] ?? '') : '';
      for (const spec of positional(args)) {
        const [name, inline] = spec.split('@');
        push({
          ecosystem: 'cargo',
          rawName: name,
          version: inline ?? version,
          // A bare `cargo install x --version 1.2.3` is exact; the manifest
          // caret default does not apply on the command line.
          pinKind: /^\d+\.\d+\.\d+/.test(inline ?? version) ? 'exact' : 'range',
          source: 'default-registry',
          via: 'install-command',
          runsCode: rest[0] === 'install',
          scriptsDisabled: false,
        });
      }
      continue;
    }

    if (head === 'composer' && /^(?:require|install)$/.test(rest[0] ?? '')) {
      if (rest[0] === 'install') {
        manifestRefs.push({
          ecosystem: 'composer',
          target: 'composer.json',
          implicit: true,
          scriptsDisabled,
        });
        continue;
      }
      for (const spec of positional(rest.slice(1))) {
        const [name, version = ''] = spec.split(':');
        push({
          ecosystem: 'composer',
          rawName: name,
          version,
          pinKind: classifyPin('composer', version),
          source: 'default-registry',
          via: 'install-command',
          runsCode: false,
          scriptsDisabled,
        });
      }
      continue;
    }

    if (head === 'dotnet' && rest[0] === 'add' && rest[1] === 'package') {
      const args = rest.slice(2);
      const vIdx = args.findIndex((x) => x === '-v' || x === '--version');
      const version = vIdx >= 0 ? (args[vIdx + 1] ?? '') : '';
      const name = positional(args)[0];
      if (name)
        push({
          ecosystem: 'nuget',
          rawName: name,
          version,
          pinKind: classifyPin('nuget', version),
          source: 'default-registry',
          via: 'install-command',
          runsCode: false,
          scriptsDisabled: false,
        });
      continue;
    }

    // --- Containers -------------------------------------------------------
    if (/^(?:docker|podman|nerdctl)$/.test(head)) {
      const pos = positional(rest);
      const sub = pos[0] ?? '';
      if (sub === 'compose') {
        // `docker compose config`, `version`, `ps`, `logs` and `down` read or
        // stop things. Only the verbs that start containers pull images.
        if (!/^(?:up|run|create|build|pull|start)$/.test(pos[1] ?? ''))
          continue;
      }
      if (sub === 'compose' || sub === 'build') {
        manifestRefs.push({
          ecosystem: 'docker',
          target: 'compose file',
          implicit: true,
          scriptsDisabled: false,
        });
        continue;
      }
      if (!/^(?:pull|run|create)$/.test(sub)) continue;
      const image = pos[1];
      if (!image) continue;
      const { name, version } = splitSpec('docker', image);
      push({
        ecosystem: 'docker',
        rawName: name,
        version,
        pinKind: classifyPin('docker', version),
        source: /^[\w.-]+\.[\w.-]+\//.test(name)
          ? 'custom-index'
          : 'default-registry',
        via: 'container',
        runsCode: sub !== 'pull',
        scriptsDisabled: false,
      });
      continue;
    }

    // --- Operating system packages ---------------------------------------
    if (OS_MANAGERS.test(head)) {
      const pos = positional(rest);
      const sub = pos[0] ?? '';
      if (!/^(?:install|add|tap)$/.test(sub) && head !== 'pacman') continue;
      for (const name of pos.slice(1))
        push({
          ecosystem: 'os',
          rawName: name,
          version: '',
          pinKind: 'none',
          source: 'os-repository',
          via: 'install-command',
          runsCode: true,
          scriptsDisabled: false,
        });
      continue;
    }
  }

  return { deps, overrides, manifestRefs };
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

function isTransposition(a, b) {
  if (a.length !== b.length) return false;
  let first = -1;
  for (let k = 0; k < a.length; k += 1) {
    if (a[k] === b[k]) continue;
    if (first === -1) {
      first = k;
      continue;
    }
    return (
      k === first + 1 &&
      a[first] === b[k] &&
      a[k] === b[first] &&
      a.slice(k + 1) === b.slice(k + 1)
    );
  }
  return false;
}

function editDistanceAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// Legitimate variants that are one edit or one affix from a popular name.
// Flagging these is pure noise.
const KNOWN_VARIANT_RE =
  /-(?:headless|binary|bin|simd|dev|cli|core|extra|contrib|stubs|types|compat|legacy|lts)$|^(?:@types\/|python-|node-|js-|py)/;

/**
 * Names that look like a trusted name without being one.
 *
 * Deliberately advisory. Edit-distance against a small list fires on real
 * packages (`requests`/`request`, `pillow`/`pillow-simd`,
 * `psycopg2`/`psycopg2-binary`), while genuine typosquats are mostly
 * combosquats that distance-1 never catches. So this may raise REVIEW and must
 * never be the sole reason for a REJECT.
 */
export function nameSimilarity(ecosystem, key, trustedKeys) {
  if (!key || trustedKeys.has(key)) return null;
  if (key.length < 5) return null;
  if (KNOWN_VARIANT_RE.test(key)) return null;

  for (const trusted of trustedKeys) {
    if (trusted.length < 5) continue;
    if (KNOWN_VARIANT_RE.test(trusted)) continue;
    // On PyPI `[-_.]` differences are the same project, never a squat.
    if (ecosystem !== 'pypi') {
      const flat = (s) => s.replace(/[-_.]/g, '');
      if (key !== trusted && flat(key) === flat(trusted))
        return { kind: 'separator', target: trusted };
    }
    if (editDistanceAtMostOne(key, trusted) || isTransposition(key, trusted))
      return { kind: 'near-miss', target: trusted };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manifests and lockfiles
// ---------------------------------------------------------------------------

// Lockfiles that carry a per-artifact hash. These pin the whole transitive
// tree, which an exact top-level version never does, so they are the strongest
// offline evidence that installed content cannot change after review.
const HASHED_LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'poetry.lock',
  'uv.lock',
  'pipfile.lock',
  'cargo.lock',
  'composer.lock',
  'go.sum',
]);

// Lockfiles without usable hashes: Gemfile.lock records no digests and
// bun.lockb is binary, so neither can be read as an integrity pin.
const UNHASHED_LOCKFILES = new Set(['gemfile.lock', 'bun.lockb', 'bun.lock']);

export function isLockfile(lower) {
  return HASHED_LOCKFILES.has(lower) || UNHASHED_LOCKFILES.has(lower);
}

export function lockfileHasHashes(lower) {
  return HASHED_LOCKFILES.has(lower);
}

function tomlPackageBlocks(text) {
  const blocks = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[\[package\]\]$/.test(line)) {
      if (current) blocks.push(current);
      current = { name: '', version: '', integrity: null };
      continue;
    }
    if (!current) continue;
    const name = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (name) current.name = name[1];
    const version = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (version) current.version = version[1];
    const sum = /^checksum\s*=\s*"([^"]+)"/.exec(line);
    if (sum) current.integrity = `sha256:${sum[1]}`;
    const hash = /hash\s*=\s*"(sha\d+:[0-9a-f]+)"/i.exec(line);
    if (hash && !current.integrity) current.integrity = hash[1];
  }
  if (current) blocks.push(current);
  return blocks.filter((b) => b.name);
}

/**
 * One line of a pip requirements file.
 *
 * Returns an observation, a manifest reference (`-r`/`-c`), an override
 * (`--index-url` and friends) or null.
 */
function parseRequirementLine(line) {
  const text = line.replace(/\s+#.*$/, '').trim();
  if (!text || text.startsWith('#')) return null;

  for (const pattern of INDEX_OVERRIDE_PATTERNS)
    if (pattern.re.test(text)) return { kind: 'override', what: pattern.what };

  const ref = /^(?:-r|--requirement|-c|--constraint)[\s=]+(\S+)/.exec(text);
  if (ref) return { kind: 'ref', target: ref[1] };

  if (/^(?:-e|--editable)\b/.test(text))
    return {
      kind: 'dep',
      dep: {
        ecosystem: 'pypi',
        rawName: text.replace(/^(?:-e|--editable)\s*/, ''),
        version: '',
        pinKind: 'none',
        source: /^(?:-e|--editable)\s*(?:git|https?)/.test(text)
          ? 'git'
          : 'path',
        via: 'manifest',
        runsCode: true,
        scriptsDisabled: false,
      },
    };
  if (text.startsWith('-')) return null;

  const hashes = [...text.matchAll(/--hash[=\s]+(sha\d+:[0-9a-f]+)/gi)].map(
    (m) => m[1],
  );
  const spec = text.replace(/\s*--hash[=\s]+\S+/gi, '').trim();
  const src = classifySource(spec);
  const { name, version } = splitSpec('pypi', spec);
  if (!name) return null;
  return {
    kind: 'dep',
    dep: {
      ecosystem: 'pypi',
      rawName: name,
      target: src.target,
      version,
      pinKind:
        src.source === 'default-registry'
          ? classifyPin('pypi', version)
          : 'none',
      source: src.source,
      integrity: hashes[0] ?? null,
      via: 'manifest',
      runsCode: false,
      scriptsDisabled: false,
    },
  };
}

function npmLockEntries(lock, push) {
  const entries = Object.entries(lock?.packages ?? {});
  for (const [pathKey, meta] of entries) {
    if (!pathKey || meta?.link) continue;
    const name = meta?.name ?? pathKey.replace(/^.*node_modules\//, '');
    if (!name) continue;
    const resolved = meta?.resolved ?? '';
    push({
      ecosystem: 'npm',
      rawName: name,
      version: meta?.version ?? '',
      pinKind: meta?.version ? 'exact' : 'none',
      source: !resolved
        ? 'default-registry'
        : /^https?:\/\/registry\.npmjs\.org\//.test(resolved)
          ? 'default-registry'
          : 'custom-index',
      integrity: meta?.integrity ?? null,
      via: 'lockfile',
    });
  }
  if (entries.length) return;
  for (const [name, meta] of Object.entries(lock?.dependencies ?? {}))
    push({
      ecosystem: 'npm',
      rawName: name,
      version: meta?.version ?? '',
      pinKind: meta?.version ? 'exact' : 'none',
      source: 'default-registry',
      integrity: meta?.integrity ?? null,
      via: 'lockfile',
    });
}

// `name@range:` header, then an indented `version` and `integrity`.
function yarnLockEntries(text, push) {
  let name = '';
  let version = '';
  let integrity = null;
  const flush = () => {
    if (name)
      push({
        ecosystem: 'npm',
        rawName: name,
        version,
        pinKind: version ? 'exact' : 'none',
        source: 'default-registry',
        integrity,
        via: 'lockfile',
      });
    name = '';
    version = '';
    integrity = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const header = /^"?((?:@[^/\s"]+\/)?[^@\s"]+)@/.exec(raw);
    if (header && !/^\s/.test(raw)) {
      flush();
      name = header[1];
      continue;
    }
    const v = /^\s+"?version"?[\s:]+"?([^"\s]+)"?/.exec(raw);
    if (v) version = v[1];
    const i = /^\s+"?integrity"?[\s:]+"?([^"\s]+)"?/.exec(raw);
    if (i) integrity = i[1];
  }
  flush();
}

// pnpm keys look like `/lodash@4.17.21:` or `/@scope/name@1.0.0:`.
function pnpmLockEntries(text, push) {
  let name = '';
  let version = '';
  const flush = (integrity) => {
    if (name)
      push({
        ecosystem: 'npm',
        rawName: name,
        version,
        pinKind: version ? 'exact' : 'none',
        source: 'default-registry',
        integrity: integrity ?? null,
        via: 'lockfile',
      });
    name = '';
    version = '';
  };
  for (const raw of text.split(/\r?\n/)) {
    const key = /^\s{2,}\/?((?:@[^/\s]+\/)?[^@\s/]+)@([\w.+-]+)[^:]*:\s*$/.exec(
      raw,
    );
    if (key) {
      flush(null);
      name = key[1];
      version = key[2];
      continue;
    }
    const integrity = /integrity:\s*(\S+)/.exec(raw);
    if (integrity && name) flush(integrity[1]);
  }
  flush(null);
}

/**
 * Dependency facts declared by a manifest or lockfile.
 *
 * Returns `{deps, overrides, manifestRefs, requireHashes}`. Observations carry
 * no file or line; the caller adds them.
 */
export function parseManifest(base, ext, text) {
  const lower = base.toLowerCase();
  const deps = [];
  const overrides = [];
  const manifestRefs = [];
  let requireHashes = false;
  const done = () => ({ deps, overrides, manifestRefs, requireHashes });

  const redirect = fileRedirectsRegistry(lower, text);
  if (redirect) overrides.push(redirect);

  const push = (o) =>
    deps.push({
      integrity: null,
      runsCode: false,
      scriptsDisabled: false,
      via: 'manifest',
      ...o,
    });

  // --- JavaScript --------------------------------------------------------
  if (lower === 'package.json') {
    try {
      const pkg = JSON.parse(text);
      for (const field of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]) {
        for (const [name, rawSpec] of Object.entries(pkg?.[field] ?? {})) {
          const spec = String(rawSpec ?? '');
          const src = classifySource(spec);
          const version = src.source === 'alias' ? src.version : spec;
          push({
            ecosystem: 'npm',
            rawName: name,
            target: src.target,
            version,
            pinKind:
              src.source === 'default-registry'
                ? classifyPin('npm', version)
                : 'none',
            source: src.source,
          });
        }
      }
    } catch {
      /* invalid JSON is reported by the manifest check */
    }
    return done();
  }

  if (lower === 'package-lock.json' || lower === 'npm-shrinkwrap.json') {
    try {
      npmLockEntries(JSON.parse(text), push);
    } catch {
      /* invalid JSON is reported by the manifest check */
    }
    return done();
  }
  if (lower === 'yarn.lock') {
    yarnLockEntries(text, push);
    return done();
  }
  if (lower === 'pnpm-lock.yaml') {
    pnpmLockEntries(text, push);
    return done();
  }

  // --- Python ------------------------------------------------------------
  if (/^(?:requirements|constraints)[\w.-]*\.(?:txt|in)$/.test(lower)) {
    let joined = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = joined + raw;
      if (/\\$/.test(line)) {
        joined = line.replace(/\\$/, ' ');
        continue;
      }
      joined = '';
      if (/--require-hashes/.test(line)) requireHashes = true;
      const parsed = parseRequirementLine(line);
      if (!parsed) continue;
      if (parsed.kind === 'override') overrides.push(parsed.what);
      else if (parsed.kind === 'ref')
        manifestRefs.push({ ecosystem: 'pypi', target: parsed.target });
      else push(parsed.dep);
    }
    return done();
  }

  if (lower === 'pyproject.toml') {
    // PEP 621 list form.
    const list = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(text);
    for (const m of (list?.[1] ?? '').matchAll(/["']([^"']+)["']/g)) {
      const parsed = parseRequirementLine(m[1]);
      if (parsed?.kind === 'dep') push(parsed.dep);
    }
    // Poetry table form: `requests = "^2.31"`.
    const tables =
      /^\[tool\.poetry(?:\.group\.[\w-]+)?\.(?:dev-)?dependencies\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm;
    for (const block of text.matchAll(tables))
      for (const line of block[1].split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9._-]+)\s*=\s*"([^"]*)"/.exec(line);
        if (!m || m[1].toLowerCase() === 'python') continue;
        // Poetry's bare string is a caret range, like Cargo's.
        push({
          ecosystem: 'pypi',
          rawName: m[1],
          version: m[2],
          pinKind: /^==/.test(m[2]) ? 'exact' : 'range',
          source: 'default-registry',
        });
      }
    return done();
  }

  if (
    lower === 'poetry.lock' ||
    lower === 'uv.lock' ||
    lower === 'cargo.lock'
  ) {
    const ecosystem = lower === 'cargo.lock' ? 'cargo' : 'pypi';
    for (const b of tomlPackageBlocks(text))
      push({
        ecosystem,
        rawName: b.name,
        version: b.version,
        pinKind: b.version ? 'exact' : 'none',
        source: 'default-registry',
        integrity: b.integrity,
        via: 'lockfile',
      });
    return done();
  }

  if (lower === 'pipfile.lock') {
    try {
      const lock = JSON.parse(text);
      for (const section of ['default', 'develop'])
        for (const [name, meta] of Object.entries(lock?.[section] ?? {})) {
          const spec = String(meta?.version ?? '');
          push({
            ecosystem: 'pypi',
            rawName: name,
            version: spec.replace(/^==/, ''),
            pinKind: /^==/.test(spec) ? 'exact' : 'none',
            source: 'default-registry',
            integrity: Array.isArray(meta?.hashes)
              ? (meta.hashes[0] ?? null)
              : null,
            via: 'lockfile',
          });
        }
    } catch {
      /* invalid JSON is reported by the manifest check */
    }
    return done();
  }

  // --- Rust, Go, PHP -----------------------------------------------------
  if (lower === 'cargo.toml') {
    const sections =
      /^\[(?:dev-|build-)?dependencies\]([\s\S]*?)(?=^\[|$(?![\s\S]))/gm;
    for (const block of text.matchAll(sections))
      for (const line of block[1].split(/\r?\n/)) {
        const inline = /^\s*([A-Za-z0-9_-]+)\s*=\s*\{([^}]*)\}/.exec(line);
        if (inline) {
          const spec = /version\s*=\s*"([^"]*)"/.exec(inline[2])?.[1] ?? '';
          const git = /\bgit\s*=\s*"([^"]*)"/.exec(inline[2]);
          const local = /\bpath\s*=\s*"([^"]*)"/.exec(inline[2]);
          push({
            ecosystem: 'cargo',
            rawName: inline[1],
            target: git?.[1] ?? local?.[1],
            version: spec,
            pinKind: git || local ? 'none' : classifyPin('cargo', spec),
            source: git ? 'git' : local ? 'path' : 'default-registry',
          });
          continue;
        }
        const simple = /^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line);
        if (!simple) continue;
        push({
          ecosystem: 'cargo',
          rawName: simple[1],
          version: simple[2],
          // A bare string is a caret range in Cargo, not an exact pin.
          pinKind: classifyPin('cargo', simple[2]),
          source: 'default-registry',
        });
      }
    return done();
  }

  if (lower === 'go.mod') {
    for (const m of text.matchAll(
      /^\s*(?:require\s+)?([\w.-]+(?:\.[\w.-]+)+\/\S+)\s+(v\S+)/gm,
    ))
      push({
        ecosystem: 'go',
        rawName: m[1],
        version: m[2],
        pinKind: classifyPin('go', m[2]),
        source: 'default-registry',
      });
    return done();
  }

  if (lower === 'go.sum') {
    for (const m of text.matchAll(
      /^(\S+)\s+(v\S+?)(?:\/go\.mod)?\s+(h1:\S+)/gm,
    ))
      push({
        ecosystem: 'go',
        rawName: m[1],
        version: m[2],
        pinKind: 'exact',
        source: 'default-registry',
        integrity: m[3],
        via: 'lockfile',
      });
    return done();
  }

  if (lower === 'composer.json' || lower === 'composer.lock') {
    try {
      const doc = JSON.parse(text);
      if (lower === 'composer.lock') {
        for (const p of doc?.packages ?? [])
          push({
            ecosystem: 'composer',
            rawName: p?.name ?? '',
            version: p?.version ?? '',
            pinKind: p?.version ? 'exact' : 'none',
            source: 'default-registry',
            integrity: p?.dist?.shasum ? `sha1:${p.dist.shasum}` : null,
            via: 'lockfile',
          });
      } else {
        for (const field of ['require', 'require-dev'])
          for (const [name, spec] of Object.entries(doc?.[field] ?? {})) {
            if (name === 'php' || name.startsWith('ext-')) continue;
            push({
              ecosystem: 'composer',
              rawName: name,
              version: String(spec ?? ''),
              pinKind: classifyPin('composer', String(spec ?? '')),
              source: 'default-registry',
            });
          }
      }
    } catch {
      /* invalid JSON is reported by the manifest check */
    }
    return done();
  }

  // --- Containers --------------------------------------------------------
  if (
    lower === 'dockerfile' ||
    /^(?:docker-compose.*|compose)\.ya?ml$/.test(lower)
  ) {
    const images =
      lower === 'dockerfile'
        ? [...text.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/gim)].map(
            (m) => m[1],
          )
        : [...text.matchAll(/^\s*image:\s*["']?([^"'\s]+)/gim)].map(
            (m) => m[1],
          );
    for (const image of images) {
      if (/^\$|^\{\{/.test(image)) continue; // a build argument, not an image
      const { name, version } = splitSpec('docker', image);
      push({
        ecosystem: 'docker',
        rawName: name,
        version,
        pinKind: classifyPin('docker', version),
        source: /^[\w.-]+\.[\w.-]+\//.test(name)
          ? 'custom-index'
          : 'default-registry',
        via: 'container',
        runsCode: true,
      });
    }
    return done();
  }

  // --- Inline script metadata (PEP 723) ----------------------------------
  // The block is a comment, so every line starts with `#`. Stripping the
  // comment prefix first is what makes the ordinary multi-line form parse.
  if (ext === '.py') {
    const block = /^# \/\/\/ script\s*$([\s\S]*?)^# \/\/\/\s*$/m.exec(text);
    if (block) {
      const body = block[1].replace(/^#[ \t]?/gm, '');
      const list = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(body);
      for (const m of (list?.[1] ?? '').matchAll(/["']([^"']+)["']/g)) {
        const parsed = parseRequirementLine(m[1]);
        if (parsed?.kind === 'dep')
          push({ ...parsed.dep, via: 'inline-metadata' });
      }
    }
  }

  return done();
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const INFO = 'info';
const REVIEW = 'review';
const REJECT = 'reject';
const SEVERITY_RANK = { [INFO]: 0, [REVIEW]: 1, [REJECT]: 2 };

const worse = (a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a);

// What each class means for the verdict. The ordering is by how well the
// installed content is nailed down, not by how well known the name is.
export const DEP_CLASSES = Object.freeze({
  bundled: {
    severity: INFO,
    why: 'the code is already in the skill, nothing is fetched',
  },
  'integrity-pinned': {
    severity: INFO,
    why: 'an artifact hash travels with it, so the content cannot change',
  },
  'registry-pinned': {
    severity: INFO,
    why: 'exact version from a registry that cannot republish a version, with lifecycle scripts disabled',
  },
  'registry-pinned-scripts': {
    severity: REVIEW,
    why: 'exact version, but install scripts still run for it and its whole dependency tree',
  },
  'trusted-unpinned': {
    severity: REVIEW,
    why: 'known package, but the version is a range or a tag, so it resolves at install time',
  },
  'unknown-name': {
    severity: REVIEW,
    why: 'not a name this scanner knows; confirm it is the package you mean',
    strict: REJECT,
  },
  'executes-fetched': {
    severity: REVIEW,
    why: 'fetches and runs in one step, and a pin covers only the root package',
    strict: REJECT,
  },
  'os-package': {
    severity: REVIEW,
    why: 'system package manager: version and content depend on the machine',
  },
  'image-pinned': {
    severity: REVIEW,
    why: 'container image pinned by digest, but its contents were not analysed',
  },
  'name-near-miss': {
    severity: REVIEW,
    why: 'the name is one edit from a well-known package',
  },
  'name-invalid': {
    severity: REJECT,
    why: 'the name cannot be a real package name',
  },
  'untrusted-source': {
    severity: REJECT,
    why: 'comes from somewhere the content can be changed after review',
  },
  poisoned: {
    severity: REJECT,
    why: 'the skill redirects the package index, so no name or version in it can be trusted',
  },
});

/** How a package reads back in a report: `requests==2.31.0`, `chalk@5.3.0`. */
export function displaySpec(ecosystem, name, version) {
  if (!version) return name;
  if (ecosystem === 'pypi')
    return /^[=<>~!]/.test(version)
      ? `${name}${version}`
      : `${name}==${version}`;
  if (ecosystem === 'docker')
    return version.startsWith('sha256:')
      ? `${name}@${version}`
      : `${name}:${version}`;
  if (ecosystem === 'os') return name;
  return `${name}@${version}`;
}

function severityFor(className, strict) {
  const entry = DEP_CLASSES[className];
  if (!entry) return REVIEW;
  return strict && entry.strict ? entry.strict : entry.severity;
}

/**
 * The trust class of one observation, ignoring everything else in the skill.
 *
 * Aggregation across observations happens in `resolveDependencies`; this
 * function deliberately sees one fact at a time.
 */
export function classifyDependency(obs, trust, options = {}) {
  const strict = Boolean(options.strict);
  const cls = (name) => ({
    class: name,
    severity: severityFor(name, strict),
    why: DEP_CLASSES[name]?.why ?? '',
  });

  if (obs.nameOk === false)
    return { ...cls('name-invalid'), why: obs.nameReason };
  if (obs.source === 'bundled') return cls('bundled');

  // A local path is only safe when it stays inside the reviewed folder. The
  // caller sets this after resolving the target against the file list.
  if (obs.source === 'path')
    return obs.insideTree ? cls('bundled') : cls('untrusted-source');

  if (
    obs.source === 'url' ||
    obs.source === 'git' ||
    obs.source === 'alias' ||
    obs.source === 'custom-index'
  )
    return cls('untrusted-source');

  if (obs.source === 'os-repository') return cls('os-package');

  const registry = trust?.registries?.[obs.ecosystem];
  const trusted = options.trustedFor
    ? options.trustedFor(obs.ecosystem)
    : new Set();

  if (obs.ecosystem === 'docker') {
    // A tag is a moving pointer; only a digest fixes the image.
    if (obs.pinKind !== 'exact') return cls('untrusted-source');
    return trusted.has(obs.key) ? cls('image-pinned') : cls('unknown-name');
  }

  if (obs.integrity) return cls('integrity-pinned');

  if (obs.via === 'launcher' || (obs.runsCode && obs.via !== 'import'))
    return cls('executes-fetched');

  if (obs.pinKind === 'exact' && registry?.immutable)
    return obs.scriptsDisabled
      ? cls('registry-pinned')
      : cls('registry-pinned-scripts');

  if (trusted.has(obs.key)) return cls('trusted-unpinned');

  const similar = options.similarity ? options.similarity(obs) : null;
  if (similar)
    return {
      ...cls('name-near-miss'),
      why: `looks like '${similar.target}'; confirm the name is the one you mean`,
    };

  return cls('unknown-name');
}

/**
 * Turns the observations of a whole skill into one decision per package.
 *
 * Rules, in order:
 *  - group by ecosystem and normalized name;
 *  - the group takes the WORST class of its observations, because signals only
 *    raise: a pin in one file never excuses an unpinned install in another;
 *  - the one exception is satisfaction, not cancellation: an import adds no
 *    severity of its own when the same package is pinned somewhere in the tree,
 *    since the import alone fetches nothing;
 *  - a reference to a manifest (`pip install -r`, `npm ci`) takes the worst
 *    class of that manifest's packages, and is rejected if the file is missing;
 *  - any index override anywhere poisons every group.
 */
export function resolveDependencies(
  deps,
  registryContext,
  manifestRefs,
  trust,
  options = {},
) {
  const groups = new Map();
  const poisoned = (registryContext?.indexOverrides ?? []).length > 0;

  for (const obs of deps) {
    const id = `${obs.ecosystem}\u0000${obs.key}`;
    let group = groups.get(id);
    if (!group) {
      group = {
        ecosystem: obs.ecosystem,
        key: obs.key,
        name: obs.rawName,
        observations: [],
      };
      groups.set(id, group);
    }
    group.observations.push(obs);
  }

  const out = [];
  for (const group of groups.values()) {
    const pinned = group.observations.some(
      (o) =>
        (o.via === 'manifest' ||
          o.via === 'lockfile' ||
          o.via === 'inline-metadata') &&
        (o.pinKind === 'exact' || o.integrity),
    );

    let severity = INFO;
    let className = 'bundled';
    let why = '';
    let bestVersion = '';
    let integrity = null;

    for (const obs of group.observations) {
      // An import cannot fetch anything by itself. When the package is pinned
      // in the tree, the import is already accounted for by that pin.
      if (obs.via === 'import' && pinned) continue;
      const verdict = classifyDependency(obs, trust, options);
      if (SEVERITY_RANK[verdict.severity] >= SEVERITY_RANK[severity]) {
        if (
          SEVERITY_RANK[verdict.severity] > SEVERITY_RANK[severity] ||
          className === 'bundled'
        ) {
          className = verdict.class;
          why = verdict.why;
        }
        severity = worse(severity, verdict.severity);
      }
      if (obs.integrity && !integrity) integrity = obs.integrity;
      if (obs.pinKind === 'exact' && !bestVersion) bestVersion = obs.version;
      if (!bestVersion && obs.version) bestVersion = obs.version;
    }

    if (poisoned) {
      className = 'poisoned';
      severity = REJECT;
      why = DEP_CLASSES.poisoned.why;
    }

    out.push({
      ecosystem: group.ecosystem,
      key: group.key,
      name: group.name,
      version: bestVersion,
      integrity,
      pinned,
      class: className,
      severity,
      why,
      locations: group.observations
        .map((o) => ({ file: o.file, line: o.line, via: o.via }))
        .slice(0, 8),
      count: group.observations.length,
    });
  }

  // A reference to a manifest that is not in the tree installs something nobody
  // reviewed. `npm install` with no arguments names no file: it installs the
  // dependencies of whatever project the agent is standing in, which is the
  // user's own list, not a list the skill smuggled in. That is a REVIEW, so the
  // two are kept apart.
  const absent = (manifestRefs ?? []).filter(
    (r) => r.target && options.hasFile && !options.hasFile(r.target),
  );
  const missingRefs = absent.filter((r) => !r.implicit);
  const ambientRefs = absent.filter((r) => r.implicit);

  out.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      a.ecosystem.localeCompare(b.ecosystem) ||
      a.key.localeCompare(b.key),
  );
  return { packages: out, poisoned, missingRefs, ambientRefs };
}
