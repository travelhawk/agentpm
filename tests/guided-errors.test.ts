import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { AgentPmService } from '@agentpm/core';
import type { PromptApi } from '@agentpm/shared';

import {
  confirmOrExplain,
  doctorFixesNeedYesMessage,
  updatesNeedYesMessage,
} from '../apps/cli/src/guided-confirm';
import {
  assertRegistryLoginAnswerable,
  chooseRegistryUrl,
} from '../apps/cli/src/registry-args';
import { copyDir, makeTempDir } from './helpers';

// What the CLI passes without a TTY: every prompt function exists, but
// calling one fails. The service must answer with a guided error instead.
const noTerminal: PromptApi = {
  isInteractive: () => false,
  selectOne: () => Promise.reject(new Error('Interactive selection requires a TTY.')),
  selectMany: () => Promise.reject(new Error('Interactive selection requires a TTY.')),
  confirm: () => Promise.reject(new Error('Interactive confirmation requires a TTY.')),
};

async function setup(prompts: PromptApi = noTerminal) {
  const homeDir = await makeTempDir('agentpm-home-');
  const sourceDir = await makeTempDir('agentpm-source-');
  const projectDir = await makeTempDir('agentpm-project-');
  await copyDir(path.resolve('tests/fixtures/repos/generic'), sourceDir);
  const service = new AgentPmService({
    cwd: projectDir,
    env: { AGENTPM_HOME: homeDir },
    prompts,
  });
  const { source } = await service.addSource(sourceDir);
  return { service, source, projectDir };
}

function pickFirst(offered: string[][]): PromptApi {
  return {
    isInteractive: () => true,
    selectOne: <T>(_message: string, options: { label: string; value: T }[]) => {
      offered.push(options.map((option) => option.label));
      return Promise.resolve(options[0]!.value);
    },
  };
}

describe('guided errors without a terminal', () => {
  test('install without a scope lists the scope flags, project first', async () => {
    const { service } = await setup();
    try {
      await expect(service.install(['skill-b'])).rejects.toThrow(
        /Choose where to install[\s\S]*--project[\s\S]*--global[\s\S]*--workspace/,
      );
    } finally {
      service.close();
    }
  });

  test('install without a name lists the skills that can be installed', async () => {
    const { service } = await setup();
    try {
      await expect(service.install([], { scope: 'project' })).rejects.toThrow(
        /agentpm install <name>[\s\S]*skill-b/,
      );
    } finally {
      service.close();
    }
  });

  test('source skills without a source lists the sources', async () => {
    const { service, source } = await setup();
    try {
      await expect(service.listSourceEntries()).rejects.toThrow(
        new RegExp(`agentpm source skills <source>[\\s\\S]*${source.id}`),
      );
    } finally {
      service.close();
    }
  });

  test('remove without a name lists what is installed', async () => {
    const { service } = await setup();
    try {
      await service.install(['skill-b'], { scope: 'project' });
      await expect(service.removeInstall(undefined)).rejects.toThrow(
        /agentpm remove <name>[\s\S]*Installed: skill-b/,
      );
      expect(service.listInstalls()).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  test('a misspelled install name lists what is installed', async () => {
    const { service } = await setup();
    try {
      await service.install(['skill-b'], { scope: 'project' });
      await expect(service.removeInstall('skil-b')).rejects.toThrow(
        /No install named "skil-b" found\. Installed: skill-b/,
      );
    } finally {
      service.close();
    }
  });

  test('push without any target says how to add one', async () => {
    const { service } = await setup();
    try {
      await expect(service.push()).rejects.toThrow(
        /No push target is set up yet[\s\S]*agentpm target add <git-url> --default[\s\S]*--to <git-url>/,
      );
    } finally {
      service.close();
    }
  });

  test('target default lists the ids when the id is missing or unknown', async () => {
    const { service } = await setup();
    try {
      await service.addTarget('origin', 'https://github.com/example/skills');
      await expect(service.setDefaultTarget()).rejects.toThrow(
        /agentpm target default <id>[\s\S]*origin/,
      );
      await expect(service.setDefaultTarget('nope')).rejects.toThrow(
        /no target named "nope"[\s\S]*origin/,
      );
    } finally {
      service.close();
    }
  });
});

describe('pickers for a missing argument', () => {
  test('remove offers the installs and removes the chosen one', async () => {
    const offered: string[][] = [];
    const { service } = await setup(pickFirst(offered));
    try {
      await service.install(['skill-b'], { scope: 'project' });
      const removed = await service.removeInstall(undefined);
      expect(removed.name).toBe('skill-b');
      expect(offered[0]?.[0]).toMatch(/^skill-b \(project/);
      expect(service.listInstalls()).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  test('source remove offers the sources', async () => {
    const offered: string[][] = [];
    const { service, source } = await setup(pickFirst(offered));
    try {
      const result = await service.removeSource(undefined);
      expect(result.removed).toBe(true);
      expect(offered).toEqual([[source.displayName]]);
      expect(service.listSources()).toHaveLength(0);
    } finally {
      service.close();
    }
  });

  test('target remove offers the configured targets', async () => {
    const offered: string[][] = [];
    const { service } = await setup(pickFirst(offered));
    try {
      await service.addTarget('origin', 'https://github.com/example/skills', true);
      await expect(service.removeTarget()).resolves.toBe('origin');
      expect(offered).toEqual([['origin (default)']]);
    } finally {
      service.close();
    }
  });
});

describe('CLI confirmations and registry choices', () => {
  test('a confirmation without a terminal names --yes and changes nothing', async () => {
    let asked = false;
    await expect(
      confirmOrExplain('Apply?', [], updatesNeedYesMessage(2, 'agentpm update'), {
        isInteractive: false,
        confirm: () => {
          asked = true;
          return Promise.resolve(true);
        },
      }),
    ).rejects.toThrow(/2 updates ready\. Nothing was changed\.[\s\S]*agentpm update --yes/);
    expect(asked).toBe(false);
    expect(doctorFixesNeedYesMessage(1)).toMatch(/agentpm doctor --fix --yes/);
  });

  test('a confirmation in a terminal asks', async () => {
    await expect(
      confirmOrExplain('Apply?', [], 'unused', {
        isInteractive: true,
        confirm: () => Promise.resolve(true),
      }),
    ).resolves.toBe(true);
  });

  test('several registries: picker in a terminal, --registry list without one', async () => {
    const origins = ['https://a.example', 'https://b.example'];
    await expect(
      chooseRegistryUrl(undefined, origins, {
        isInteractive: false,
        selectOne: () => Promise.reject(new Error('no')),
      }),
    ).rejects.toThrow(/--registry <url>[\s\S]*https:\/\/a\.example[\s\S]*https:\/\/b\.example/);
    await expect(
      chooseRegistryUrl(undefined, origins, {
        isInteractive: true,
        selectOne: <T>(_m: string, options: { value: T }[]) =>
          Promise.resolve(options[1]!.value),
      }),
    ).resolves.toBe('https://b.example');
  });

  test('registry login without a terminal lists the token and password flags', () => {
    expect(() =>
      assertRegistryLoginAnswerable('http://x', {}, false),
    ).toThrow(/--token <token>[\s\S]*--username <name> --password <password>/);
    expect(() =>
      assertRegistryLoginAnswerable('http://x', { token: 't' }, false),
    ).not.toThrow();
    expect(() =>
      assertRegistryLoginAnswerable('http://x', { username: 'u' }, true),
    ).not.toThrow();
  });
});
