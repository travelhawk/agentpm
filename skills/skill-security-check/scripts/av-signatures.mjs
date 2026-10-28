// Signature set for the bundled antivirus engine (tiny-av.mjs).
//
// Every pattern is XOR-encoded (key 0x5a) and base64-wrapped. A
// plain pattern in this file would itself be a live signature: the host
// antivirus would quarantine the skill, and the bundled engine would flag
// its own data. `node tiny-av.mjs --list-signatures` prints them decoded;
// `printf "<pattern>" | node tiny-av.mjs --encode` encodes a new one.
//
// Fields: id, name (detection name), scope ('any' = every file, 'code' = not
// documentation such as .md or .txt, unless the content was hidden inside an
// encoding), what (plain description), and one matcher:
//   bytes    {data, mask?}  byte sequence; mask '0' marks a wildcard byte
//   anyText  [data]         any one string matches
//   allText  [[data]]       one string from every group must match
//   regex    data, flags    regular expression over the content as latin1 text
// nocase compares text matchers case-insensitively.
//
// This module is data only. It lives in scripts/ because the sandbox grants
// read access to this folder and the skill under test, nothing else.

export const SIGNATURE_KEY = 0x5a;

export const SIGNATURES = [
  {
    id: 'test-eicar',
    name: 'Test.EICAR',
    scope: 'any',
    what: 'EICAR antivirus test file',
    bytes: {
      data: 'Am8Vewp/GhsKAW4GCgACb25yCgRzbRkZc20nfh8TGRsIdwkOGxQeGwgedxsUDhMMEwgPCXcOHwkOdxwTFh97fhJxEnA=',
    },
  },
  {
    id: 'test-amsi',
    name: 'Test.AMSI',
    scope: 'any',
    what: 'AMSI test sample',
    bytes: {
      data: 'GxcJE3oOPykuegk7Nyo2P2B6bT9taDlpOT93YmxrOHduaWljd2Jtbmp3ajs5a25ibjlraWJs',
    },
  },
  {
    id: 'sc-msf-x86',
    name: 'Shellcode.Metasploit.x86',
    scope: 'any',
    what: 'Metasploit x86 block_api shellcode prologue',
    bytes: { data: 'prJaWlpaOtO/a1o+0Vpq', mask: '110111111101101' },
  },
  {
    id: 'sc-msf-x64',
    name: 'Shellcode.Metasploit.x64',
    scope: 'any',
    what: 'Metasploit x64 block_api shellcode prologue',
    bytes: { data: 'phLZvqqyWlpaWhsLGwoI', mask: '111111011111111' },
  },
  {
    id: 'ht-mimikatz-cmd',
    name: 'HackTool.Mimikatz',
    scope: 'code',
    what: 'Mimikatz credential dumping commands',
    anyText: ['KT8xLyg2KTtgYA==', 'Nik7Pi83KmBg', 'MzQsNTE/dzczNzMxOy4g'],
    nocase: true,
  },
  {
    id: 'ht-powersploit',
    name: 'HackTool.PowerSploit',
    scope: 'code',
    what: 'PowerSploit injection modules',
    anyText: [
      'MzQsNTE/dyg/PDY/OS4zLD8qPzM0MD85LjM1NA==',
      'MzQsNTE/dykyPzY2OTU+Pw==',
      'MzQsNTE/dz42NjM0MD85LjM1NA==',
    ],
    nocase: true,
  },
  {
    id: 'miner-stratum',
    name: 'Miner.Stratum',
    scope: 'code',
    what: 'Crypto-miner pool protocol address',
    anyText: [
      'KS4oOy4vN3EuOSpgdXU=',
      'KS4oOy4vN3EpKTZgdXU=',
      'KS4oOy4vN2hxLjkqYHV1',
    ],
    nocase: true,
  },
  {
    id: 'miner-xmrig',
    name: 'Miner.XMRig',
    scope: 'code',
    what: 'XMRig miner configuration',
    allText: [['IjcoMz0='], ['PjU0Oy4/dzY/LD82']],
    nocase: true,
  },
  {
    id: 'loader-shellcode',
    name: 'Trojan.ShellcodeLoader',
    scope: 'code',
    what: 'Allocates executable memory, copies bytes in and starts a thread on them',
    allText: [
      ['DDMoLi87Nhs2NjU5'],
      ['GSg/Oy4/DjIoPzs+', 'GSg/Oy4/CD83NS4/DjIoPzs+', 'Cy8/Lz8PKT8oGwoZ'],
      [
        'CC42FzUsPxc/NzUoIw==',
        'FzsoKTI7NgdgYBk1KiM=',
        'FzsoKTI7NnQZNSoj',
        'Nz83NzUsPw==',
        'DSgzLj8KKDU5PykpFz83NSgj',
        'CC42GTUqIxc/NzUoIw==',
      ],
    ],
  },
  {
    id: 'inject-process',
    name: 'Trojan.ProcessInjection',
    scope: 'code',
    what: 'Writes code into another process and runs it',
    allText: [
      ['FSo/NAooNTk/KSk='],
      ['DSgzLj8KKDU5PykpFz83NSgj'],
      [
        'GSg/Oy4/CD83NS4/DjIoPzs+',
        'FC4ZKD87Lj8OMig/Oz4fIg==',
        'Cy8/Lz8PKT8oGwoZ',
      ],
    ],
  },
  {
    id: 'stealer-chromium',
    name: 'Stealer.ChromiumPasswords',
    scope: 'code',
    what: 'Reads the Chromium password store and its decryption key',
    allText: [['FjU9MzR6HjsuOw=='], ['PzQ5KCMqLj8+BTE/Iw==']],
  },
  {
    id: 'webshell-php',
    name: 'Backdoor.PHP.WebShell',
    scope: 'code',
    what: 'PHP code that runs request parameters',
    regex:
      'BjhyZWA/LDs2JjspKT8oLiYpIykuPzcmKjspKS4yKC8mKTI/NjYFPyI/OSY/Ij85Jio1Kj80cwYpcAZyBilwcmVgODspP2xuBT4/OTU+PwYpcAZyBilwJj0gMzQ8NjsuPwYpcAZyBilwJikuKAUoNS5raQYpcAZyBilwc3AGfgVyZWAdHw4mChUJDiYIHwsPHwkOJhkVFRETHyYJHwgMHwhzBjg=',
    flags: 'i',
  },
];
