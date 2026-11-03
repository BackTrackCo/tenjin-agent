import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext, CommandResult } from '../context';
import { CliError } from '../lib/errors';
import {
  agentHost,
  checkEach,
  claudePluginPresent,
  detectHosts,
  forgetInstalledHost,
  HOSTS_FILE,
  installHosts,
  readInstalledHosts,
  recordedHosts,
  recordInstalledHost,
  otherHostNote,
  runEach,
  uninstallEach,
  withNote,
  type SharedParts,
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
    await recordInstalledHost(dir, 'codex', async () => false);
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
    await recordInstalledHost(dir, 'codex', async () => false);
    expect(await recordedHosts({}, dir)).toEqual(['codex']);
    expect(await recordedHosts({ harness: 'claude' }, dir)).toEqual(['claude']);
    expect(await recordedHosts({ project: true }, dir)).toEqual(['claude']);
  });
});

describe('uninstallEach', () => {
  const USER = { kind: 'user' } as const;
  const ALL = { kind: 'all' } as const;
  const PROJECT = { kind: 'project', path: '/p' } as const;
  /** Claude Code's removal, with these installs left anywhere. */
  const claudeLeft = (remaining: string[]) => async (): Promise<CommandResult> => ({
    data: { remaining },
    humanLines: ['removed the tenjin@tenjin plugin'],
  });
  const codexOk = async (): Promise<CommandResult> => ({
    data: { removed: 'tenjin@tenjin' },
    humanLines: ['codex removed'],
  });
  /** The shared parts' seams; Claude Code holds no install unless `claudeHolds` says so. */
  const finisher = (claudeHolds = false) => {
    const calls: number[] = [];
    const finish: SharedParts = {
      remove: async () => {
        calls.push(1);
        return { data: { runtime: { removed: true } }, humanLines: ["removed Tenjin's runtime"] };
      },
      claudeLeft: async () => claudeHolds,
      keptFor: (users) =>
        `Kept Tenjin's runtime and its launcher: still used by ${users.join(', ')}.`,
    };
    return { calls, finish };
  };

  it('runs finish last, only when every host succeeded and nothing remains', async () => {
    await recordInstalledHost(dir, 'claude');
    await recordInstalledHost(dir, 'codex');
    const { calls, finish } = finisher();
    const out = await uninstallEach(
      ['claude', 'codex'],
      dir,
      ALL,
      (h) => (h === 'claude' ? claudeLeft([])() : codexOk()),
      finish,
    );
    expect(calls).toHaveLength(1);
    expect(await readInstalledHosts(dir)).toBeNull();
    expect(out.humanLines?.at(-1)).toBe("removed Tenjin's runtime");
    expect(out.data).toMatchObject({ hosts: ['claude', 'codex'], runtime: { removed: true } });
  });

  it('keeps Claude Code recorded, and never finishes, while an install of it remains', async () => {
    await recordInstalledHost(dir, 'claude');
    const { calls, finish } = finisher();
    const out = await uninstallEach(['claude'], dir, USER, claudeLeft(['/other']), finish);
    expect(calls).toHaveLength(0);
    expect(await readInstalledHosts(dir)).toEqual(['claude']);
    // One host keeps its own result shape.
    expect(out).toEqual({
      data: { remaining: ['/other'] },
      humanLines: ['removed the tenjin@tenjin plugin'],
    });
  });

  it('never finishes a project target while Codex stays recorded, and says so', async () => {
    await recordInstalledHost(dir, 'claude');
    await recordInstalledHost(dir, 'codex');
    const { calls, finish } = finisher();
    const out = await uninstallEach(['claude'], dir, PROJECT, claudeLeft([]), finish);
    expect(calls).toHaveLength(0);
    expect(await readInstalledHosts(dir)).toEqual(['codex']);
    expect(out.humanLines?.at(-1)).toBe(
      "Kept Tenjin's runtime and its launcher: still used by Codex.",
    );
  });

  /**
   * Claude Code removed first, Codex last: the run that removes Codex never
   * runs Claude Code's removal, so the end state decides, not who ran.
   */
  it('finishes when Codex is the last host removed and Claude Code holds nothing', async () => {
    await recordInstalledHost(dir, 'codex', async () => false);
    const { calls, finish } = finisher();
    const out = await uninstallEach(['codex'], dir, USER, codexOk, finish);
    expect(calls).toHaveLength(1);
    expect(await readInstalledHosts(dir)).toBeNull();
    expect(out.humanLines?.at(-1)).toBe("removed Tenjin's runtime");
  });

  it('keeps them when Codex goes but Claude Code, not in this run, still holds an install', async () => {
    await recordInstalledHost(dir, 'codex', async () => false);
    const { calls, finish } = finisher(true);
    const out = await uninstallEach(['codex'], dir, USER, codexOk, finish);
    expect(calls).toHaveLength(0);
    expect(out.humanLines).toEqual(['codex removed']);
  });

  it('keeps a failed host recorded, tries the rest, and refuses once', async () => {
    await recordInstalledHost(dir, 'claude');
    await recordInstalledHost(dir, 'codex');
    const { calls, finish } = finisher();
    const seen: Harness[] = [];
    const err = await uninstallEach(
      ['claude', 'codex'],
      dir,
      ALL,
      async (h) => {
        seen.push(h);
        if (h === 'codex') throw new CliError('REFUSED', 'codex failed', { fix: 'Run y.' });
        return claudeLeft([])();
      },
      finish,
    ).catch((e: unknown) => e);
    expect(seen).toEqual(['claude', 'codex']);
    expect(err).toMatchObject({
      code: 'REFUSED',
      message: 'Codex: codex failed',
      fix: 'Codex:\nRun y.',
      details: { claude: { remaining: [] }, codex: { error: 'codex failed' } },
    });
    expect(calls).toHaveLength(0);
    expect(await readInstalledHosts(dir)).toEqual(['codex']);
  });

  it("rethrows one host's own refusal unchanged", async () => {
    const refusal = new CliError('REFUSED', '1 Tenjin install could not be removed: /other.');
    const err = await uninstallEach(['claude'], dir, ALL, async () => {
      throw refusal;
    }).catch((e: unknown) => e);
    expect(err).toBe(refusal);
  });

  it('names what finish could not remove, and still succeeds', async () => {
    const out = await uninstallEach(['claude'], dir, USER, claudeLeft([]), {
      ...finisher().finish,
      remove: async () => ({
        data: { runtime: { removed: false, left: ['C:\\rt\\node.exe'] } },
        humanLines: ['  delete C:\\rt\\node.exe after this exits'],
      }),
    });
    expect(out.humanLines).toContain('  delete C:\\rt\\node.exe after this exits');
  });
});

describe('otherHostNote', () => {
  it('names Codex under a Claude Code agent, and Claude Code under a Codex one', async () => {
    expect(await otherHostNote({}, { env: { CLAUDECODE: '1' }, detect: both })).toBe(
      'Codex is also installed on this machine. Ask the person: "Should I also set up Tenjin for Codex?" On yes, run `tenjin install --harness codex`.',
    );
    expect(await otherHostNote({}, { env: { CODEX_SESSION_ID: 'a' }, detect: both })).toBe(
      'Claude Code is also installed on this machine. Ask the person: "Should I also set up Tenjin for Claude Code?" On yes, run `tenjin install --harness claude`.',
    );
  });

  it('says nothing with one host found, in a terminal, or under an override', async () => {
    const claudeOnly = async (): Promise<Harness[]> => ['claude'];
    expect(await otherHostNote({}, { env: { CLAUDECODE: '1' }, detect: claudeOnly })).toBe(
      undefined,
    );
    expect(await otherHostNote({}, { env: {}, detect: both })).toBeUndefined();
    expect(
      await otherHostNote({ harness: 'claude' }, { env: { CLAUDECODE: '1' }, detect: both }),
    ).toBeUndefined();
  });

  it('rides in notices and as the last line, and leaves a result without it alone', () => {
    const out = { data: { plugin: 'x', nextSteps: [] }, humanLines: ['done'] };
    expect(withNote(out, 'Codex is also installed.')).toEqual({
      data: { plugin: 'x', nextSteps: [], notices: ['Codex is also installed.'] },
      humanLines: ['done', 'Codex is also installed.'],
    });
    expect(withNote(out, undefined)).toBe(out);
  });
});

describe('the first record on a machine with a released Claude Code install', () => {
  it('starts with Claude Code, so bare doctor and uninstall still cover it', async () => {
    const config = join(dir, 'claude');
    await mkdir(join(config, 'plugins'), { recursive: true });
    await writeFile(
      join(config, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'tenjin@tenjin': [] } }),
    );
    const env = { CLAUDE_CONFIG_DIR: config };
    expect(await claudePluginPresent(env, dir)).toBe(true);
    expect(await claudePluginPresent({ CLAUDE_CONFIG_DIR: join(dir, 'none') }, dir)).toBe(false);
    await recordInstalledHost(dir, 'codex', () => claudePluginPresent(env, dir));
    expect(await readInstalledHosts(dir)).toEqual(['claude', 'codex']);
    expect(await recordedHosts({}, dir)).toEqual(['claude', 'codex']);
  });

  it('records the host alone with no Claude Code plugin, and never re-seeds a record', async () => {
    await recordInstalledHost(dir, 'codex', async () => false);
    expect(await readInstalledHosts(dir)).toEqual(['codex']);
    await recordInstalledHost(dir, 'codex', async () => true);
    expect(await readInstalledHosts(dir)).toEqual(['codex']);
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
