import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../context';
import { CliError } from '../lib/errors';
import {
  agentHost,
  checkEach,
  detectHosts,
  forgetInstalledHost,
  HOSTS_FILE,
  installHosts,
  readInstalledHosts,
  recordedHosts,
  recordInstalledHost,
  runEach,
  uninstallEach,
} from './hosts';
import type { Harness } from './names';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-hosts-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = (json = false): CommandContext => ({
  dataDir: dir,
  flags: { json, timeout: 1000 },
  io: { stdout: process.stdout, stderr: process.stderr, isTTY: !json },
});

const both = async (): Promise<Harness[]> => ['claude', 'codex'];

describe('the installed-hosts record', () => {
  it('records each host once, in a fixed order, and forgets it again', async () => {
    expect(await readInstalledHosts(dir)).toBeNull();
    await recordInstalledHost(dir, 'codex');
    await recordInstalledHost(dir, 'claude');
    await recordInstalledHost(dir, 'codex');
    expect(await readInstalledHosts(dir)).toEqual(['claude', 'codex']);
    await forgetInstalledHost(dir, 'claude');
    expect(await readInstalledHosts(dir)).toEqual(['codex']);
    await forgetInstalledHost(dir, 'codex');
    await expect(readFile(join(dir, HOSTS_FILE), 'utf8')).rejects.toThrow();
  });

  it('reads an unreadable record as none, and falls back to Claude Code', async () => {
    await writeFile(join(dir, HOSTS_FILE), 'not json');
    expect(await readInstalledHosts(dir)).toBeNull();
    expect(await recordedHosts({}, dir)).toEqual(['claude']);
  });

  it('checks or removes the recorded hosts, unless overridden or project-scoped', async () => {
    await recordInstalledHost(dir, 'codex');
    expect(await recordedHosts({}, dir)).toEqual(['codex']);
    expect(await recordedHosts({ harness: 'claude' }, dir)).toEqual(['claude']);
    expect(await recordedHosts({ project: true }, dir)).toEqual(['claude']);
  });
});

describe('uninstallEach', () => {
  it('keeps a host recorded when its removal left the plugin in place', async () => {
    await recordInstalledHost(dir, 'claude');
    await recordInstalledHost(dir, 'codex');
    const run = async (host: Harness) => ({
      data:
        host === 'claude'
          ? { plugin: { plugin: 'kept', marketplace: 'kept', reason: 'claude failed' } }
          : { removed: 'tenjin@tenjin', marketplace: 'tenjin' },
    });
    await uninstallEach(['claude', 'codex'], dir, false, run);
    expect(await readInstalledHosts(dir)).toEqual(['claude']);
    expect(await recordedHosts({}, dir)).toEqual(['claude']);
  });

  it('forgets a removed host, and nothing on a project uninstall', async () => {
    await recordInstalledHost(dir, 'claude');
    const removed = async () => ({ data: { plugin: { plugin: 'removed' } } });
    await uninstallEach(['claude'], dir, true, removed);
    expect(await readInstalledHosts(dir)).toEqual(['claude']);
    await uninstallEach(['claude'], dir, false, removed);
    expect(await readInstalledHosts(dir)).toBeNull();
  });
});

describe('agentHost', () => {
  it('tells Claude Code from Codex by environment, Claude Code first', () => {
    expect(agentHost({ CLAUDECODE: '1' })).toBe('claude');
    expect(agentHost({ CODEX_SESSION_ID: 'abc' })).toBe('codex');
    expect(agentHost({ CODEX_SESSION_ID: 'abc', CLAUDE_CODE_SESSION_ID: 'x' })).toBe('claude');
    expect(agentHost({ CODEX_SESSION_ID: '  ' })).toBeUndefined();
    expect(agentHost({})).toBeUndefined();
  });
});

describe('installHosts', () => {
  const never = async (): Promise<Harness[]> => {
    throw new Error('no detection expected');
  };

  it('installs into the agent host without detecting or asking', async () => {
    const env = { CODEX_SESSION_ID: 'abc' };
    expect(await installHosts({}, ctx(), { env, detect: never })).toEqual(['codex']);
  });

  it('takes the override, and keeps refresh and project installs on Claude Code', async () => {
    const env = { CODEX_SESSION_ID: 'abc' };
    expect(await installHosts({ harness: 'claude' }, ctx(), { env })).toEqual(['claude']);
    expect(await installHosts({ refresh: true }, ctx(), { env })).toEqual(['claude']);
    expect(await installHosts({ project: true }, ctx(), { env })).toEqual(['claude']);
  });

  it('installs into the one host a terminal machine has, or Claude Code with neither', async () => {
    const env = {};
    const codex = async (): Promise<Harness[]> => ['codex'];
    const none = async (): Promise<Harness[]> => [];
    expect(await installHosts({}, ctx(), { env, detect: codex, isInteractive: true })).toEqual([
      'codex',
    ]);
    expect(await installHosts({}, ctx(), { env, detect: none })).toEqual(['claude']);
  });

  it('asks which when both are found, with both selected', async () => {
    const asked: (readonly Harness[])[] = [];
    const ask = async (found: readonly Harness[]): Promise<Harness[]> => {
      asked.push(found);
      return ['codex'];
    };
    const out = await installHosts({}, ctx(), { env: {}, detect: both, ask, isInteractive: true });
    expect(asked).toEqual([['claude', 'codex']]);
    expect(out).toEqual(['codex']);
  });

  it('takes both without asking under --yes, --json or no terminal', async () => {
    const ask = async (): Promise<Harness[]> => {
      throw new Error('no question expected');
    };
    const deps = { env: {}, detect: both, ask };
    expect(await installHosts({ yes: true }, ctx(), { ...deps, isInteractive: true })).toEqual([
      'claude',
      'codex',
    ]);
    expect(await installHosts({}, ctx(true), deps)).toEqual(['claude', 'codex']);
    expect(await installHosts({}, ctx(), { ...deps, isInteractive: false })).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('refuses when the question is cancelled', async () => {
    const ask = async (): Promise<null> => null;
    await expect(
      installHosts({}, ctx(), { env: {}, detect: both, ask, isInteractive: true }),
    ).rejects.toThrow('Install cancelled');
  });
});

describe.skipIf(process.platform === 'win32')('detectHosts', () => {
  let path: string | undefined;
  beforeEach(() => {
    path = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = path;
  });

  async function shim(name: string, body: string): Promise<void> {
    const file = join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`);
    await chmod(file, 0o755);
  }

  it('counts a host only when its --version runs, not when a shim sits on PATH', async () => {
    await shim('codex', 'exit 1');
    await shim('claude', 'exit 1');
    process.env.PATH = dir;
    expect(await detectHosts({ PATH: dir })).toEqual([]);
    await shim('codex', 'echo "codex-cli 0.163.0"');
    process.env.PATH = [dir, path].join(delimiter);
    expect(await detectHosts({ PATH: dir })).toEqual(['codex']);
  });
});

describe('runEach and checkEach', () => {
  const ok = (host: Harness) => async () => ({ data: { host }, humanLines: [`${host} ok`] });

  it('keeps one host’s own result, and nests two under their names', async () => {
    expect(await runEach(['codex'], (h) => ok(h)())).toEqual({
      data: { host: 'codex' },
      humanLines: ['codex ok'],
    });
    const two = await runEach(['claude', 'codex'], (h) => ok(h)());
    expect(two.data).toEqual({
      hosts: ['claude', 'codex'],
      claude: { host: 'claude' },
      codex: { host: 'codex' },
    });
    expect(two.humanLines).toEqual(['Claude Code:', '  claude ok', 'Codex:', '  codex ok']);
  });

  it('checks every host before failing, and names the one that failed', async () => {
    const seen: Harness[] = [];
    const run = async (h: Harness) => {
      seen.push(h);
      if (h === 'claude') throw new CliError('REFUSED', 'Plugin missing.', { fix: 'Run x.' });
      return ok(h)();
    };
    const err = await checkEach(['claude', 'codex'], run).catch((e: unknown) => e);
    expect(seen).toEqual(['claude', 'codex']);
    expect(err).toMatchObject({
      code: 'REFUSED',
      message: 'Claude Code: Plugin missing.',
      fix: 'Claude Code:\nRun x.',
      details: { hosts: ['claude', 'codex'], codex: { host: 'codex' } },
    });
  });
});
