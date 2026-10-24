import { randomBytes } from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

// @ts-expect-error -- plain ESM script without type declarations
import * as tinyAv from '../skills/skill-security-check/scripts/tiny-av.mjs';

// Unit tests for the antivirus engine bundled with skill-security-check.
// Every sample is assembled in memory from pieces, so no file in the repo is
// itself a signature that the host antivirus would quarantine.

const { scanBuffer, selfTest } = tinyAv as unknown as {
  scanBuffer: (
    buf: Buffer,
    name?: string,
  ) => { name: string; where: string[] }[];
  selfTest: () => { ok: boolean; failed: string[] };
};

const names = (buf: Buffer | string, file: string): string[] =>
  scanBuffer(typeof buf === 'string' ? Buffer.from(buf) : buf, file).map(
    (h) => h.name,
  );

const EICAR = Buffer.from(
  [
    'X5O!P%@AP[4',
    String.fromCharCode(92),
    'PZX54(P^)7CC)7}$',
    'EICAR-STANDARD-ANTIVIRUS-',
    'TEST-FILE!$H+H*',
  ].join(''),
  'latin1',
);
// Metasploit x86 block_api prologue, followed by filler.
const SHELLCODE = Buffer.from([
  0xfc,
  0xe8,
  0x82,
  0,
  0,
  0,
  0x60,
  0x89,
  0xe5,
  0x31,
  0xc0,
  0x64,
  0x8b,
  0x50,
  0x30,
  ...new Array<number>(48).fill(0x90),
]);
const MIMI = ['sekur', 'lsa::logon', 'passwords'].join('');

// A real program does not compress to a few bytes, so neither does this one.
function fakeElf(size = 4096): Buffer {
  const b = randomBytes(size);
  b.writeUInt32BE(0x7f454c46, 0);
  return b;
}

// Minimal zip writer: one deflated entry, central directory, end record.
function zip(name: string, content: Buffer): Buffer {
  const data = deflateRawSync(content);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(n.length, 28);
  central.writeUInt32LE(0, 42);
  const cdAt = local.length + n.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12);
  end.writeUInt32LE(cdAt, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}

describe('tiny-av bundled engine', () => {
  it('passes its own self-test', () => {
    expect(selfTest()).toEqual({ ok: true, failed: [] });
  });

  it('finds a test sample through every supported encoding', () => {
    const cases: [string, Buffer | string, string][] = [
      ['plain', EICAR, 'a.bin'],
      ['base64 > gzip', `x = "${gzipSync(EICAR).toString('base64')}"`, 'a.py'],
      ['hex', `x = "${EICAR.toString('hex')}"`, 'a.py'],
      ['utf-16', Buffer.from(EICAR.toString('latin1'), 'utf16le'), 'a.ps1'],
      ['zip', zip('inner/readme.txt', EICAR), 'a.zip'],
      [
        'base64 > zip',
        `blob: ${zip('x.bin', EICAR).toString('base64')}`,
        'notes.md',
      ],
      ['gzip file', gzipSync(EICAR), 'a.gz'],
    ];
    for (const [label, buf, file] of cases)
      expect(names(buf, file), label).toContain('Test.EICAR');
  });

  it('finds shellcode written as \\x escapes or a 0x byte list', () => {
    const escaped = [...SHELLCODE]
      .map((b) => `\\x${b.toString(16).padStart(2, '0')}`)
      .join('');
    const list = [...SHELLCODE].map((b) => `0x${b.toString(16)}`).join(', ');
    expect(names(`buf = b"${escaped}"\n`, 'run.py')).toContain(
      'Shellcode.Metasploit.x86',
    );
    expect(names(`byte[] buf = { ${list} };\n`, 'Run.cs')).toContain(
      'Shellcode.Metasploit.x86',
    );
  });

  it('lets documentation name attack tools but not hide them', () => {
    expect(names(`Invoke-Command { ${MIMI} }\n`, 'run.ps1')).toContain(
      'HackTool.Mimikatz',
    );
    expect(names(`Detect \`${MIMI}\` in logs.\n`, 'SKILL.md')).toEqual([]);
    const hidden = Buffer.from(`${MIMI} exit`.repeat(4)).toString('base64');
    expect(names(`See ${hidden}\n`, 'SKILL.md')).toContain('HackTool.Mimikatz');
  });

  it('flags an executable hidden in text, not one shipped as a file', () => {
    const encoded = gzipSync(fakeElf()).toString('base64');
    expect(names(`PAYLOAD = "${encoded}"\n`, 'tool.py')).toContain(
      'Dropper.EncodedExecutable',
    );
    expect(names(fakeElf(), 'bin/tool')).not.toContain(
      'Dropper.EncodedExecutable',
    );
  });

  it('flags a PHP web shell', () => {
    const shell = ['<?php @ev', 'al(base64_decode($_PO', "ST['c'])); ?>"].join(
      '',
    );
    expect(names(shell, 'x.php')).toContain('Backdoor.PHP.WebShell');
  });

  it('stays quiet on ordinary encoded content', () => {
    const png = Buffer.alloc(300, 7);
    png.write('\x89PNG\r\n\x1a\n', 0, 'latin1');
    const text = [
      `<img src="data:image/png;base64,${png.toString('base64')}">`,
      `sha256: ${'ab12'.repeat(16)}`,
      `integrity="sha512-${Buffer.alloc(64, 3).toString('base64')}"`,
      'VirtualAlloc is a Windows API; CreateThread starts a thread.',
    ].join('\n');
    expect(names(text, 'index.html')).toEqual([]);
    expect(names(text, 'script.js')).toEqual([]);
  });
});
