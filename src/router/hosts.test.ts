import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../context';
import { CliError } from '../lib/errors';
import {
  agentHost,
  checkEach,
  chooseHosts,
  detectHosts,
  doctorEach,
  forgetInstalledHost,
  HOSTS_FILE,
  installHosts,
  readHostRecord,
  readInstalledHosts,
  recordedHosts,
  recordInstalledHost,
  runEach,
  uninstallEach,
  withSteps,
} from './hosts';
import { parseHostList } from '../cli/router';
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
    expect(await recordedHosts({ harness: ['claude'] }, dir)).toEqual(['claude']);
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

describe('parseHostList', () => {
  it('reads a comma list and the repeated flag, in a fixed order', () => {
    expect(parseHostList('codex,claude')).toEqual(['claude', 'codex']);
    expect(parseHostList('codex', parseHostList('claude'))).toEqual(['claude', 'codex']);
    expect(parseHostList(' codex ')).toEqual(['codex']);
  });

  it('refuses an entry that is not a host, naming the valid ones', () => {
    expect(() => parseHostList('claude,cursor')).toThrow(
      '"cursor" is not a host; use claude, codex, or both as claude,codex.',
    );
    expect(() => parseHostList(',')).toThrow('No host given');
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
  const codexOnly = async (): Promise<Harness[]> => ['codex'];
  const none = async (): Promise<Harness[]> => [];
  const noQuestion = async (): Promise<Harness[]> => {
    throw new Error('no question expected');
  };

  it('installs into the one host found, with no question, agent or terminal', async () => {
    expect(await installHosts({}, ctx(), { env: { CODEX_SESSION_ID: 'a' }, detect: none })).toEqual(
      { hosts: ['codex'] },
    );
    expect(
      await installHosts({}, ctx(), { env: {}, detect: codexOnly, isInteractive: true }),
    ).toEqual({ hosts: ['codex'] });
    expect(await installHosts({}, ctx(), { env: {}, detect: none })).toEqual({ hosts: ['claude'] });
  });

  it('takes the override, and keeps refresh and project installs on Claude Code', async () => {
    const deps = { env: { CODEX_SESSION_ID: 'abc' }, detect: both, ask: noQuestion };
    expect(await installHosts({ harness: ['codex'] }, ctx(), deps)).toEqual({ hosts: ['codex'] });
    expect(await installHosts({ refresh: true }, ctx(), deps)).toEqual({ hosts: ['claude'] });
    expect(await installHosts({ project: true }, ctx(), deps)).toEqual({ hosts: ['claude'] });
  });

  it('asks a person at a terminal which, with both selected', async () => {
    const asked: (readonly Harness[])[] = [];
    const ask = async (found: readonly Harness[]): Promise<Harness[]> => {
      asked.push(found);
      return ['codex'];
    };
    const out = await installHosts({}, ctx(), { env: {}, detect: both, ask, isInteractive: true });
    expect(asked).toEqual([['claude', 'codex']]);
    expect(out).toEqual({ hosts: ['codex'] });
  });

  it('under an agent, sets up nothing and hands the question over, answers re-running install', async () => {
    const env = { CLAUDECODE: '1' };
    const out = await installHosts({ noWallet: true }, ctx(true), {
      env,
      detect: both,
      ask: noQuestion,
    });
    expect(out.hosts).toEqual([]);
    expect(out.ask?.id).toBe('hosts');
    expect(out.ask?.options.map((o) => [o.id, o.recommended, o.command])).toEqual([
      ['both', true, 'tenjin install --harness claude,codex --no-wallet'],
      ['claude', false, 'tenjin install --harness claude --no-wallet'],
      ['codex', false, 'tenjin install --harness codex --no-wallet'],
    ]);
    // The same question for a script with no terminal.
    expect(
      (await installHosts({}, ctx(), { env: {}, detect: both, isInteractive: false })).ask?.id,
    ).toBe('hosts');
  });

  it('takes both under --yes, and a recorded choice over --yes, asking nothing', async () => {
    const deps = { env: { CLAUDECODE: '1' }, detect: both, ask: noQuestion };
    expect(await installHosts({ yes: true }, ctx(), deps)).toEqual({
      hosts: ['claude', 'codex'],
    });
    await recordInstalledHost(dir, 'codex');
    expect(await installHosts({ yes: true }, ctx(), deps)).toEqual({ hosts: ['codex'] });
    expect(await installHosts({}, ctx(true), deps)).toEqual({ hosts: ['codex'] });
  });

  it('refuses when the terminal question is cancelled', async () => {
    const ask = async (): Promise<null> => null;
    await expect(
      installHosts({}, ctx(), { env: {}, detect: both, ask, isInteractive: true }),
    ).rejects.toThrow('Install cancelled');
  });
});

describe('an agent install with both hosts found', () => {
  let ran: Harness[] = [];
  beforeEach(() => {
    ran = [];
  });
  /** The install action's flow: choose, run each host, record it, merge the steps. */
  async function install(args: { harness?: Harness[]; yes?: boolean }, fail?: Harness) {
    const { hosts, ask } = await installHosts(args, ctx(true), {
      env: { CODEX_SESSION_ID: 'a' },
      detect: both,
    });
    await chooseHosts(dir, hosts);
    const out = await runEach(hosts, async (host) => {
      ran.push(host);
      if (host === fail) throw new CliError('REFUSED', '`codex plugin add` failed.');
      await recordInstalledHost(dir, host);
      return {
        data: { host, nextSteps: [{ id: 'spend', question: host, options: [], next: '' }] },
      };
    });
    return withSteps(out, hosts, ask);
  }

  it('writes nothing and records nothing until the answer, and carries only the hosts question', async () => {
    const out = await install({});
    expect(ran).toEqual([]);
    expect(await readInstalledHosts(dir)).toBeNull();
    const steps = (out.data as { nextSteps: { id: string }[] }).nextSteps;
    expect(steps.map((s) => s.id)).toEqual(['hosts']);
    // Idempotent: the same run again still writes nothing.
    await install({});
    expect(ran).toEqual([]);
  });

  it('records both under --harness claude,codex, with the spend question still carried', async () => {
    const out = await install({ harness: parseHostList('claude,codex') });
    expect(ran).toEqual(['claude', 'codex']);
    expect(await readInstalledHosts(dir)).toEqual(['claude', 'codex']);
    expect((out.data as { nextSteps: { id: string }[] }).nextSteps.map((s) => s.id)).toEqual([
      'spend',
    ]);
  });

  it('retries a chosen host whose setup failed, and doctor names it until then', async () => {
    await expect(install({ harness: ['claude', 'codex'] }, 'codex')).rejects.toThrow(
      'codex plugin add',
    );
    expect(await readHostRecord(dir)).toEqual({
      chosen: ['claude', 'codex'],
      installed: ['claude'],
    });
    const ok = async (h: Harness) => ({ data: { host: h }, humanLines: [`${h} ok`] });
    const err = await doctorEach(await recordedHosts({}, dir), dir, ok).catch((e: unknown) => e);
    expect(err).toMatchObject({
      message: 'Codex: Codex was chosen at install, but its setup did not finish.',
      fix: expect.stringContaining('Run `tenjin install` to finish it.'),
    });
    // A bare re-run, even with --yes, retries both chosen hosts.
    ran = [];
    await install({ yes: true });
    expect(ran).toEqual(['claude', 'codex']);
    expect(await readInstalledHosts(dir)).toEqual(['claude', 'codex']);
    await expect(doctorEach(['claude', 'codex'], dir, ok)).resolves.toBeDefined();
  });

  const timedOut = async (): Promise<never> => {
    throw new CliError('REFUSED', '`codex plugin remove` timed out.');
  };

  it('keeps an unfinished host whose removal fails while a read cannot confirm it gone', async () => {
    await expect(install({ harness: ['codex'] }, 'codex')).rejects.toThrow();
    const out = await uninstallEach(await recordedHosts({}, dir), dir, false, timedOut);
    expect(out.humanLines?.join('\n')).toContain('kept on the record');
    expect(await readHostRecord(dir)).toEqual({ chosen: ['codex'], installed: [] });
    const ok = async (h: Harness) => ({ data: { host: h } });
    await expect(doctorEach(await recordedHosts({}, dir), dir, ok)).rejects.toThrow(
      'its setup did not finish',
    );
  });

  it('clears an unfinished host once a read confirms its plugin is gone', async () => {
    await expect(install({ harness: ['codex'] }, 'codex')).rejects.toThrow();
    const asked: Harness[] = [];
    const absent = async (h: Harness) => (asked.push(h), true);
    await uninstallEach(await recordedHosts({}, dir), dir, false, timedOut, absent);
    expect(asked).toEqual(['codex']);
    expect(await readHostRecord(dir)).toBeNull();
  });

  it('records one under --harness codex, and both under --yes', async () => {
    await install({ harness: ['codex'] });
    expect(ran).toEqual(['codex']);
    expect(await readInstalledHosts(dir)).toEqual(['codex']);
    await rm(join(dir, HOSTS_FILE));
    const out = await install({ yes: true });
    expect(await readInstalledHosts(dir)).toEqual(['claude', 'codex']);
    expect((out.data as { nextSteps: { id: string }[] }).nextSteps.map((s) => s.id)).toEqual([
      'spend',
    ]);
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
