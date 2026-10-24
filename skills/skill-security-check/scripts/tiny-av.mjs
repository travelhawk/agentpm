
// tiny-av: the antivirus engine bundled with skill-security-check.
//
// It is small on purpose: a few signatures for attack tooling that has no
// honest use in a skill, plus the unpacking a real engine does before it
// matches. It looks through base64, hex, \x escapes, 0x byte lists, UTF-16,
// gzip, zlib and zip, up to MAX_DEPTH layers deep, so a payload hidden
// behind two encodings is still found. An executable hidden inside a text
// encoding is a detection of its own.
//
// It reads bytes and never runs, imports or renders them. It is not a
// replacement for a system antivirus with current malware signatures.
//
// Usage: node tiny-av.mjs [--stdin] [<file-or-folder> ...]
//        node tiny-av.mjs --list-signatures
//        node tiny-av.mjs --encode   (stdin -> encoded data for av-signatures.mjs)
//   --stdin  reads one file path per line from standard input.
// Output: one JSON object. Exit codes: 0 clean, 1 threat, 2 self-test failed or error.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { SIGNATURE_KEY, SIGNATURES } from './av-signatures.mjs';

export const ENGINE_VERSION = '0.1.0';

const LIMITS = {
  maxFileBytes: 64 * 1024 * 1024,
  maxDepth: 4,
  // Total bytes produced by decoding one file, across all layers.
  maxDecodedBytes: 64 * 1024 * 1024,
  maxInflateBytes: 16 * 1024 * 1024,
  maxZipEntries: 2000,
  maxCandidates: 5000,
  // Shorter runs are hashes, ids and ordinary words, not payloads.
  minBase64: 64,
  minHex: 64,
  minEscapes: 16,
};

const DOC_EXT = new Set([
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc',
  '.html',
  '.htm',
]);

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

function decodeData(b64) {
  const raw = Buffer.from(b64, 'base64');
  for (let i = 0; i < raw.length; i += 1) raw[i] ^= SIGNATURE_KEY;
  return raw;
}

function compile(sig) {
  const text = (b64) => {
    const s = decodeData(b64).toString('latin1');
    return sig.nocase ? s.toLowerCase() : s;
  };
  const c = {
    id: sig.id,
    name: sig.name,
    scope: sig.scope,
    what: sig.what,
    nocase: Boolean(sig.nocase),
  };
  if (sig.bytes) {
    const bytes = decodeData(sig.bytes.data);
    const mask = sig.bytes.mask ?? '1'.repeat(bytes.length);
    // The longest run without wildcards is the anchor for indexOf.
    let best = { start: 0, len: 0 };
    let start = -1;
    for (let i = 0; i <= mask.length; i += 1) {
      if (i < mask.length && mask[i] === '1') {
        if (start < 0) start = i;
      } else if (start >= 0) {
        if (i - start > best.len) best = { start, len: i - start };
        start = -1;
      }
    }
    c.bytes = bytes;
    c.mask = mask;
    c.anchor = bytes.subarray(best.start, best.start + best.len);
    c.anchorAt = best.start;
  } else if (sig.anyText) {
    c.all = [sig.anyText.map(text)];
  } else if (sig.allText) {
    c.all = sig.allText.map((group) => group.map(text));
  } else if (sig.regex) {
    c.regex = new RegExp(text(sig.regex), sig.flags ?? '');
  }
  return c;
}

const COMPILED = SIGNATURES.map(compile);

export const SIGNATURE_SHA256 = createHash('sha256')
  .update(JSON.stringify(SIGNATURES))
  .digest('hex');

function matchBytes(buf, c) {
  let from = 0;
  for (;;) {
    const at = buf.indexOf(c.anchor, from);
    if (at < 0) return false;
    const base = at - c.anchorAt;
    if (base >= 0 && base + c.bytes.length <= buf.length) {
      let ok = true;
      for (let i = 0; i < c.bytes.length && ok; i += 1)
        if (c.mask[i] === '1' && buf[base + i] !== c.bytes[i]) ok = false;
      if (ok) return true;
    }
    from = at + 1;
  }
}

function matchSignatures(buf, layer) {
  const hits = [];
  let text = null;
  let lower = null;
  const asText = (nocase) => {
    text ??= buf.toString('latin1');
    if (!nocase) return text;
    lower ??= text.toLowerCase();
    return lower;
  };
  for (const c of COMPILED) {
    // Documentation may name attack tools. Hidden content may not.
    if (c.scope === 'code' && layer.doc && !layer.hidden) continue;
    let hit = false;
    if (c.bytes) hit = matchBytes(buf, c);
    else if (c.all) {
      const s = asText(c.nocase);
      hit = c.all.every((group) => group.some((needle) => s.includes(needle)));
    } else if (c.regex) {
      c.regex.lastIndex = 0;
      hit = c.regex.test(asText(false));
    }
    if (hit) hits.push({ name: c.name, id: c.id });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Unpacking
// ---------------------------------------------------------------------------

function executableKind(buf) {
  if (buf.length >= 0x40 && buf[0] === 0x4d && buf[1] === 0x5a) {
    const pe = buf.readUInt32LE(0x3c);
    if (pe + 4 <= buf.length && buf.readUInt32BE(pe) === 0x50450000)
      return 'Windows PE';
  }
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x7f454c46) return 'ELF';
  if (buf.length >= 4) {
    const m = buf.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(m))
      return 'Mach-O';
  }
  return null;
}

function looksText(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return false;
  return true;
}

function looksUtf16le(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return true;
  const n = Math.min(buf.length, 1024) & ~1;
  if (n < 16) return false;
  let zeros = 0;
  for (let i = 1; i < n; i += 2) if (buf[i] === 0) zeros += 1;
  return zeros >= (n / 2) * 0.9;
}

function inflate(buf, fn) {
  try {
    return fn(buf, { maxOutputLength: LIMITS.maxInflateBytes });
  } catch {
    return null;
  }
}

function* zipEntries(buf) {
  // Walk the central directory: sizes in local headers can be zero when a
  // data descriptor follows, the central directory always has them.
  const min = Math.max(0, buf.length - 0xffff - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i -= 1)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return;
  const count = Math.min(buf.readUInt16LE(eocd + 10), LIMITS.maxZipEntries);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50)
      continue;
    const dataAt =
      local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataAt, Math.min(buf.length, dataAt + csize));
    if (method === 0) yield { name, data };
    else if (method === 8) {
      const out = inflate(data, zlib.inflateRawSync);
      if (out) yield { name, data: out };
    }
  }
}

// Text encodings that can hide bytes. Each yields [label, bytes].
function* decodeText(text) {
  const runs = [
    [
      'base64',
      new RegExp(`[A-Za-z0-9+/]{${LIMITS.minBase64},}={0,2}`, 'g'),
      (s) => Buffer.from(s, 'base64'),
    ],
    [
      'hex',
      new RegExp(`(?:[0-9a-fA-F]{2}){${LIMITS.minHex / 2},}`, 'g'),
      (s) => Buffer.from(s, 'hex'),
    ],
    [
      '\\x escapes',
      new RegExp(`(?:\\\\x[0-9a-fA-F]{2}){${LIMITS.minEscapes},}`, 'g'),
      (s) => Buffer.from(s.replace(/\\x/g, ''), 'hex'),
    ],
    [
      'byte list',
      new RegExp(
        `(?:0x[0-9a-fA-F]{1,2}\\s*,\\s*){${LIMITS.minEscapes - 1},}0x[0-9a-fA-F]{1,2}`,
        'g',
      ),
      (s) =>
        Buffer.from(s.match(/0x[0-9a-fA-F]{1,2}/g).map((h) => parseInt(h, 16))),
    ],
  ];
  for (const [label, re, decode] of runs)
    for (const m of text.matchAll(re)) yield [label, decode(m[0])];
}

function scanLayers(buf, layer, budget, hits) {
  if (budget.candidates <= 0) return;
  budget.candidates -= 1;
  for (const h of matchSignatures(buf, layer))
    hits.push({ ...h, where: layer.where });
  if (layer.hidden) {
    const kind = executableKind(buf);
    if (kind)
      hits.push({
        name: 'Dropper.EncodedExecutable',
        id: 'encoded-executable',
        where: layer.where,
        detail: `${kind} program hidden inside a text encoding`,
      });
  }
  if (layer.depth >= LIMITS.maxDepth) return;
  const child = (label, data, hidden) => {
    if (!data?.length || budget.bytes < data.length) return;
    budget.bytes -= data.length;
    scanLayers(
      data,
      {
        depth: layer.depth + 1,
        doc: layer.doc,
        hidden: layer.hidden || hidden,
        where: [...layer.where, label],
      },
      budget,
      hits,
    );
  };
  if (buf[0] === 0x1f && buf[1] === 0x8b)
    return child('gzip', inflate(buf, zlib.gunzipSync), false);
  if (buf[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(buf[1]))
    child('zlib', inflate(buf, zlib.inflateSync), false);
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    for (const e of zipEntries(buf)) child(`zip:${e.name}`, e.data, false);
    return;
  }
  if (looksUtf16le(buf)) {
    const s = buf.toString('utf16le').replace(/^\uFEFF/, '');
    return child('utf-16', Buffer.from(s, 'latin1'), false);
  }
  if (!looksText(buf)) return;
  for (const [label, data] of decodeText(buf.toString('latin1')))
    child(label, data, true);
}

/**
 * Scans one buffer. `name` decides whether it is documentation.
 * Returns a list of { name, id, where[], detail? } with duplicates removed.
 */
export function scanBuffer(buf, name = '') {
  const hits = [];
  scanLayers(
    buf,
    {
      depth: 0,
      doc: DOC_EXT.has(path.extname(name).toLowerCase()),
      hidden: false,
      where: [],
    },
    { bytes: LIMITS.maxDecodedBytes, candidates: LIMITS.maxCandidates },
    hits,
  );
  const seen = new Set();
  return hits.filter((h) => {
    const key = `${h.id}|${h.where.join('>')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

/**
 * Proves the engine works on this machine before its "clean" means anything:
 * each sample must be flagged with the expected name. Built at run time, so
 * no sample exists on disk.
 */
export function selfTest() {
  const eicar = Buffer.from(
    [
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
      'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    ].join(''),
    'latin1',
  );
  const elf = Buffer.alloc(64);
  elf.writeUInt32BE(0x7f454c46, 0);
  const cases = [
    ['plain', eicar, 'sample.bin', 'Test.EICAR'],
    [
      'base64 > gzip',
      Buffer.from(`data = "${zlib.gzipSync(eicar).toString('base64')}"\n`),
      'sample.py',
      'Test.EICAR',
    ],
    [
      'utf-16 > base64',
      Buffer.from(`-enc ${elf.toString('base64')}`, 'utf16le'),
      'sample.ps1',
      'Dropper.EncodedExecutable',
    ],
  ];
  const failed = cases
    .filter(
      ([, buf, name, want]) =>
        !scanBuffer(buf, name).some((h) => h.name === want),
    )
    .map(([label]) => label);
  return { ok: failed.length === 0, failed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function* walk(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    yield p;
    return;
  }
  if (st.isSymbolicLink()) return;
  if (st.isFile()) {
    yield p;
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of fs.readdirSync(p).sort()) {
    if (name === '.git') continue;
    yield* walk(path.join(p, name));
  }
}

function scanFiles(files) {
  const threats = [];
  const errors = [];
  let scanned = 0;
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      if (st.size > LIMITS.maxFileBytes) {
        errors.push({ file, error: 'larger than the scan limit' });
        continue;
      }
      const buf = fs.readFileSync(file);
      scanned += 1;
      for (const h of scanBuffer(buf, file)) threats.push({ file, ...h });
    } catch (e) {
      errors.push({ file, error: e.code ?? e.name });
    }
  }
  return { scanned, threats, errors };
}

function main(argv) {
  if (argv.includes('--encode')) {
    // XOR is its own inverse, so decoding the raw bytes encodes them.
    const raw = decodeData(fs.readFileSync(0).toString('base64'));
    process.stdout.write(`${raw.toString('base64')}\n`);
    return 0;
  }
  if (argv.includes('--list-signatures')) {
    for (const s of SIGNATURES) {
      const show = (b64) => JSON.stringify(decodeData(b64).toString('latin1'));
      const pattern = s.bytes
        ? [...decodeData(s.bytes.data)]
            .map((b, i) =>
              s.bytes.mask?.[i] === '0'
                ? '??'
                : b.toString(16).padStart(2, '0'),
            )
            .join(' ')
        : s.anyText
          ? `any of ${s.anyText.map(show).join(', ')}`
          : s.allText
            ? s.allText.map((g) => `(${g.map(show).join(' | ')})`).join(' and ')
            : `/${decodeData(s.regex).toString('latin1')}/${s.flags ?? ''}`;
      process.stdout.write(`${s.name} [${s.scope}] ${s.what}\n  ${pattern}\n`);
    }
    return 0;
  }
  const files = [];
  for (const a of argv)
    if (!a.startsWith('--')) files.push(...walk(path.resolve(a)));
  if (argv.includes('--stdin'))
    files.push(...fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean));
  const test = selfTest();
  const result = {
    engine: 'tiny-av',
    version: ENGINE_VERSION,
    signatures: SIGNATURES.length,
    signatureSha256: SIGNATURE_SHA256,
    selfTest: test,
    ...scanFiles(files),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!test.ok) return 2;
  return result.threats.length ? 1 : 0;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exitCode = main(process.argv.slice(2));
