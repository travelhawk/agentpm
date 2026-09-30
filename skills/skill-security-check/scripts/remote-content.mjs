// Detection of remote content that the agent may reach at run time without a
// full URL: bare domains, e-mail addresses, defanged domains, and instructions
// that send data out or pull instructions from the web. The owner of a domain
// can change what it serves after review, so all of these count as external.

const REJECT = 'reject';
const REVIEW = 'review';

// Top-level domains that are rarely a file extension or property name.
// A bare `name.tld` with one of these is treated as a domain anywhere.
const STRONG_TLDS = [
  'com',
  'net',
  'org',
  'io',
  'ai',
  'co',
  'dev',
  'xyz',
  'ru',
  'cn',
  'tk',
  'gov',
  'edu',
  'biz',
  'ly',
  'gg',
  'su',
  'onion',
];

// Real top-level domains that can also be ordinary words or identifiers. They
// count only after a direction word such as "to", "from", "visit" or "fetch".
// Left out on purpose because they are common file extensions or identifiers:
// md py sh rs pl cc so ps am in id app run name page link.
const CONTEXT_TLDS = [
  'info',
  'me',
  'us',
  'uk',
  'de',
  'fr',
  'nl',
  'eu',
  'ca',
  'au',
  'jp',
  'kr',
  'br',
  'es',
  'it',
  'ch',
  'at',
  'be',
  'se',
  'no',
  'dk',
  'fi',
  'cz',
  'ua',
  'ir',
  'kp',
  'tw',
  'hk',
  'sg',
  'vn',
  'th',
  'ph',
  'nz',
  'za',
  'mx',
  'ar',
  'cl',
  've',
  'pe',
  'tv',
  'fm',
  'to',
  'ws',
  'la',
  'st',
  'gd',
  'ml',
  'ga',
  'cf',
  'gq',
  'pw',
  'top',
  'club',
  'site',
  'online',
  'tech',
  'cloud',
  'click',
  'live',
  'shop',
  'space',
  'website',
  'fun',
  'icu',
  'buzz',
  'work',
  'pro',
  'mobi',
  'asia',
  'today',
  'news',
  'blog',
  'wiki',
  'zone',
  'world',
  'email',
  'host',
  'services',
  'digital',
  'network',
  'systems',
  'solutions',
  'agency',
  'tools',
  'software',
  'download',
  'zip',
  'mov',
  'lol',
  'sbs',
  'cyou',
  'rest',
  'bond',
];
const ALL_TLDS = [...STRONG_TLDS, ...CONTEXT_TLDS];

// Product names that look like domains.
const NOT_DOMAINS = /^(?:asp|ado|vb|system|microsoft|dot)\.net$/i;

const LABELS = String.raw`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*`;
const END = String.raw`(?![\w-]|\.[a-z0-9]|\s*\()`;
const hostRe = (tlds) => String.raw`${LABELS}\.(?:${tlds.join('|')})${END}`;

const STRONG_RE = new RegExp(
  String.raw`(?<![\w@.\/:%$-])${hostRe(STRONG_TLDS)}`,
  'gi',
);
const DIRECTION = String.raw`\b(?:to|from|at|on|via|visit|visiting|open|browse|fetch|download|upload|curl|wget|ping|reach|contact|hosted\s+(?:at|on)|go\s+to|navigate\s+to)\s+(?:the\s+)?(?:(?:web)?site|domain|server|host|page|address)?\s*`;
const CONTEXT_RE = new RegExp(
  String.raw`${DIRECTION}(${hostRe(CONTEXT_TLDS)})`,
  'gi',
);
const EMAIL_RE = new RegExp(
  String.raw`(?<![\w.%+-])[\w.%+-]{1,64}@(${hostRe(ALL_TLDS)})`,
  'gi',
);

// Defanged or disguised dots: vendor[.]com, vendor(dot)com, vendor dot com, vendor。com
const DOT_WORDS = String.raw`(?:\s*[\[({]\s*(?:\.|dot)\s*[\])}]\s*|\s+dot\s+|[。．｡․])`;
const DEFANGED_RE = new RegExp(
  String.raw`(?<![\w-])([a-z0-9][a-z0-9-]{0,62}(?:${DOT_WORDS}[a-z0-9][a-z0-9-]{0,62})*)${DOT_WORDS}(${ALL_TLDS.join('|')})${END}`,
  'gi',
);

// Quoted strings and trailing comments of a code line. Bare domains in code only
// count there, so property access such as `user.org` is not read as a domain.
function codeSegments(line) {
  const out = [];
  for (const m of line.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g))
    out.push({ text: m[2], offset: m.index + 1 });
  const c = /(?:^|\s)(?:#|\/\/)(?!!)/.exec(line);
  if (c) out.push({ text: line.slice(c.index), offset: c.index });
  return out;
}

// Returns {value, index, kind, how?}: kind is 'bare-domain' or 'email'; `how`
// is set when the dots were disguised.
export function findDomains(line, isCode) {
  const out = [];
  const segments = isCode ? codeSegments(line) : [{ text: line, offset: 0 }];
  for (const { text, offset } of segments) {
    for (const m of text.matchAll(STRONG_RE)) {
      if (!NOT_DOMAINS.test(m[0]))
        out.push({ value: m[0], index: offset + m.index, kind: 'bare-domain' });
    }
    for (const m of text.matchAll(CONTEXT_RE)) {
      out.push({
        value: m[1],
        index: offset + m.index + m[0].length - m[1].length,
        kind: 'bare-domain',
      });
    }
    for (const m of text.matchAll(EMAIL_RE)) {
      out.push({ value: m[0], index: offset + m.index, kind: 'email' });
    }
  }
  for (const m of line.matchAll(DEFANGED_RE)) {
    const normal = `${m[1]}.${m[2]}`
      .replace(new RegExp(DOT_WORDS, 'gi'), '.')
      .toLowerCase();
    out.push({
      value: normal,
      index: m.index,
      kind: 'bare-domain',
      how: 'disguised dots',
      raw: m[0],
    });
  }
  return out;
}

// Files and lines where a bare domain or e-mail address is attribution
// (license, copyright, author field), not something the agent acts on.
export const CONTACT_FILE_RE =
  /(?:^|[-_.])(?:license|licence|copying|notice|authors|contributors|codeowners|maintainers|ofl)(?:[-_.][\w.-]*)?$/i;
export const CONTACT_LINE_RE =
  /^\s*[-*]?\s*(?:author|authors|maintainer|maintainers|contact|owner)\b\s*[:=]|\bcopyright\b|\(c\)|©/i;

// Verbs count only as plain words: not inside names such as `store-submit.yml` or `'POST'`.
const WORD_START = String.raw`(?<![\w'"\x60./-])`;
const WORD_END = String.raw`(?![\w'"\x60./-])`;
const SEND_VERB = String.raw`${WORD_START}(?:send|sends|sending|upload|uploads|uploading|post|posts|posting|transmit|forward|e-?mail|mail|submit|share|sync|push|exfiltrate|leak|beacon|report|pipe|stream|copy|paste)${WORD_END}`;
// Verbs that move data off the machine. Local verbs such as copy or push are left out.
const OUT_VERB = String.raw`${WORD_START}(?:send|sends|sending|upload|uploads|uploading|post|posts|posting|transmit|forward|e-?mail|mail|submit|share|exfiltrate|leak|beacon|paste)${WORD_END}`;
const REMOTE_SINK = String.raw`(?:(?:a|an|the|our|this|that|my|your|their|some|any|remote|external|third[-\s]party|configured|given|following|below|above)\s+){0,3}(?:servers?|endpoints?|webhooks?|urls?|domains?|(?:web)?sites?|hosts?|apis?|addresses|inbox(?:es)?|e-?mail\s+address(?:es)?|pastebin|paste\s+sites?|gists?|buckets?|discord|telegram|ngrok|requestbin|collectors?|listeners?|c2|cloud\s+storage|ftp)`;
const SECRETS = String.raw`(?:\.env\b|~\/\.ssh|\.ssh\/|\bid_(?:rsa|ed25519|ecdsa)\b|\bcredentials?\b|\bsecrets?\b|\bapi[\s_-]?keys?\b|\b(?:access|auth|bearer|github|npm|session)\s+tokens?\b|\bpasswords?\b|\bprivate\s+keys?\b|\bcookies\b|\.aws\b|\.netrc\b|\bkeychain\b|\bwallets?\b|\bseed\s+phrases?\b)`;
const INSTR_NOUN = String.raw`(?:instructions?|rules?|guidance|guidelines?|prompts?|checklists?|polic(?:y|ies)|steps|directives?|tasks?|commands?|playbooks?|runbooks?|config(?:uration)?|skills?|SKILL\.md|scripts?|procedures?|workflows?|templates?)`;
const REMOTE_PLACE = String.raw`(?:(?:the\s+)?(?:web|internet|server|url|link|domain|(?:web)?site|endpoint|api|remote|cloud|gist|pastebin|cdn|github|gitlab|repo(?:sitory)?\s+online)\b|online\b|remotely\b|on\s+the\s+(?:web|internet)\b)`;

export const REMOTE_RULES = [
  {
    id: 'remote-exfil',
    severity: REJECT,
    category: 'remote-content',
    re: new RegExp(
      String.raw`${SEND_VERB}[^\n]{0,80}?\b(?:to|into|onto|via)\s+${REMOTE_SINK}\b`,
      'i',
    ),
    message: 'Tells the agent to send data to a remote server, URL or domain',
  },
  {
    id: 'remote-exfil-secrets',
    severity: REJECT,
    category: 'remote-content',
    re: new RegExp(
      String.raw`${OUT_VERB}[^\n]{0,80}?${SECRETS}[^\n]{0,60}?\b(?:to|with|via|into|onto)\b|${SECRETS}[^\n]{0,60}?\b(?:to|into)\s+(?:the\s+)?(?:support|team|admin|maintainers?|author|developer|us)\b`,
      'i',
    ),
    message: 'Tells the agent to send secrets or credential files somewhere',
  },
  {
    id: 'remote-instructions',
    severity: REJECT,
    category: 'remote-content',
    re: new RegExp(
      String.raw`\b(?:fetch|download|load|get|retrieve|pull|read|check|consult|look\s+up|grab|obtain|follow|use|import|refresh|sync)\b[^\n]{0,40}?\b${INSTR_NOUN}\b[^\n]{0,40}?(?:\b(?:from|at|on|via|in)\s+${REMOTE_PLACE}|\b(?:online|remotely)\b|\bhosted\b)|\b(?:latest|current|newest|updated|up-to-date|live)\s+${INSTR_NOUN}\b[^\n]{0,40}?\b(?:from|at|online)\b`,
      'i',
    ),
    message:
      'Tells the agent to load instructions or rules from a remote place (dynamic prompt injection)',
  },
  {
    id: 'remote-web-lookup',
    severity: REVIEW,
    category: 'remote-content',
    re: /\b(?:search|browse|look\s+up|check|query|consult)\s+(?:on\s+)?(?:the\s+)?(?:web|internet|online)\b[^\n]{0,80}?\b(?:follow|apply|obey|use|do\s+what|execute|run)\b|\b(?:look\s+up|check|find|get)\b[^\n]{0,40}?\b(?:online|on\s+the\s+(?:web|internet))\b/i,
    message: 'Tells the agent to take guidance from live web content',
  },
];
