import { EventEmitter } from 'node:events';

import { resolveGitRevision, runGitCommand } from '@agentpm/git';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

function mockSpawnSuccess(stdout = ''): void {
  vi.mocked(spawn).mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout?: EventEmitter;
    };
    child.stdout = new EventEmitter();

    queueMicrotask(() => {
      if (stdout.length > 0) {
        child.stdout?.emit('data', Buffer.from(stdout));
      }
      child.emit('close', 0);
    });

    return child as never;
  });
}

describe('git runner', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('runs interactive git commands with inherited stdio and merged env', async () => {
    mockSpawnSuccess();

    await runGitCommand(['push', 'origin', 'main'], {
      cwd: 'C:\\repo',
      env: { GIT_SSH_COMMAND: 'ssh -v' },
    });

    const call = vi.mocked(spawn).mock.calls[0];
    expect(call?.[0]).toBe('git');
    expect(call?.[1]).toEqual(['push', 'origin', 'main']);
    expect(call?.[2]).toMatchObject({
      cwd: 'C:\\repo',
      stdio: 'inherit',
      windowsHide: false,
    });
    expect(call?.[2]?.env?.GIT_SSH_COMMAND).toBe('ssh -v');
  });

  test('resolves remote revisions through git ls-remote with stdin inherited', async () => {
    mockSpawnSuccess('abc123\tHEAD\n');

    await expect(
      resolveGitRevision('git@github.com:owner/private.git', 'HEAD', {
        GIT_SSH_COMMAND: 'ssh',
      }),
    ).resolves.toBe('abc123');

    const call = vi.mocked(spawn).mock.calls[0];
    expect(call?.[0]).toBe('git');
    expect(call?.[1]).toEqual([
      'ls-remote',
      '--',
      'git@github.com:owner/private.git',
      'HEAD',
    ]);
    expect(call?.[2]).toMatchObject({
      stdio: ['inherit', 'pipe', 'inherit'],
      windowsHide: false,
    });
    expect(call?.[2]?.env?.GIT_SSH_COMMAND).toBe('ssh');
  });

  test('rejects locators and refs that git would parse as options', async () => {
    mockSpawnSuccess('abc123\tHEAD\n');

    await expect(
      resolveGitRevision('--upload-pack=touch /tmp/pwned', 'HEAD'),
    ).rejects.toThrow(/starts with "-"/);
    await expect(
      resolveGitRevision('git@github.com:owner/private.git', '--exec=evil'),
    ).rejects.toThrow(/starts with "-"/);

    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});
