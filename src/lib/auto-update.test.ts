import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { spawn } from 'node:child_process';
import {
  AUTO_UPDATE_FILE,
  AUTO_UPDATE_LOG,
  autoUpdateLine,
  maybeAutoUpdate,
  recordAutoUpdate,
  TLS_OFF,
} from './auto-update';
import { nodeBinPath, versionEntry } from './runtime-layout';

const NOW = Date.parse('2026-10-22T12:00:00.000Z');
const HOUR = 3_600_000;

let home: string;
let dataDir: string;
let root: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-auto-update-'));
  dataDir = join(home, '.tenjin');
  root = join(dataDir, 'runtime');
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A runtime whose current version's Node and entry are on disk. */
function runtime(cli = '0.2.0', node = '24.15.0'): { node: string; entry: string } {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({ current: { cli, node }, previous: null, pending: null }),
  );
  const bin = nodeBinPath(root, node);
  const entry = versionEntry(root, cli);
  for (const f of [bin, entry]) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, '');
  }
  return { node: bin, entry };
}

interface Spawned {
  cmd: string;
  args: readonly string[];
  opts: Record<string, unknown>;
  unref: boolean;
}

/** Records every spawn; the child does nothing. */
function recorder(): { impl: typeof spawn; calls: Spawned[] } {
  const calls: Spawned[] = [];
  const impl = ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    const call: Spawned = { cmd, args, opts, unref: false };
    calls.push(call);
    return {
      on: () => undefined,
      unref: () => {
        call.unref = true;
      },
    };
  }) as unknown as typeof spawn;
  return { impl, calls };
}

const run = (
  r: ReturnType<typeof recorder>,
  o: { env?: NodeJS.ProcessEnv; now?: number; dir?: string } = {},
) =>
  maybeAutoUpdate({
    dataDir: o.dir ?? dataDir,
    env: o.env ?? {},
    home,
    now: () => o.now ?? NOW,
    spawnImpl: r.impl,
  });

const record = () => JSON.parse(readFileSync(join(root, AUTO_UPDATE_FILE), 'utf8')) as object;

describe('maybeAutoUpdate', () => {
  it('starts `update --background` on the runtime’s own Node, detached and unref’d, and stamps it', () => {
    const { node, entry } = runtime();
    const r = recorder();
    run(r, { env: { PATH: '/usr/bin' } });
    expect(r.calls).toHaveLength(1);
    const [call] = r.calls;
    expect(call?.cmd).toBe(node);
    expect(call?.args).toEqual([entry, 'update', '--background']);
    expect(call?.opts).toMatchObject({
      detached: true,
      cwd: home,
      windowsHide: true,
      env: { PATH: '/usr/bin', TENJIN_NO_UPDATE_CHECK: '1' },
    });
    // stdin ignored, stdout and stderr to the log: nothing tied to the hook's pipes.
    const stdio = call?.opts.stdio as unknown[];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[2]).toBe(stdio[1]);
    expect(call?.unref).toBe(true);
    expect(existsSync(join(root, AUTO_UPDATE_LOG))).toBe(true);
    expect(record()).toEqual({ startedAt: new Date(NOW).toISOString() });
  });

  it('runs at most once a day, keeping the last result for doctor', () => {
    runtime();
    writeFileSync(
      join(root, AUTO_UPDATE_FILE),
      JSON.stringify({
        startedAt: new Date(NOW - 23 * HOUR).toISOString(),
        finishedAt: new Date(NOW - 23 * HOUR).toISOString(),
        outcome: 'current',
        to: '0.2.0',
      }),
    );
    const r = recorder();
    run(r);
    expect(r.calls).toHaveLength(0);
    run(r, { now: NOW + HOUR });
    expect(r.calls).toHaveLength(1);
    expect(record()).toMatchObject({
      startedAt: new Date(NOW + HOUR).toISOString(),
      outcome: 'current',
    });
    // The stamp it just wrote holds the next session off.
    run(r, { now: NOW + 2 * HOUR });
    expect(r.calls).toHaveLength(1);
  });

  it('counts a start in the future (a clock set back) as due', () => {
    runtime();
    writeFileSync(
      join(root, AUTO_UPDATE_FILE),
      JSON.stringify({ startedAt: new Date(NOW + 30 * 24 * HOUR).toISOString() }),
    );
    const r = recorder();
    run(r);
    expect(r.calls).toHaveLength(1);
  });

  it('stays put in CI and under TENJIN_NO_UPDATE_CHECK', () => {
    runtime();
    const r = recorder();
    run(r, { env: { CI: 'true' } });
    run(r, { env: { TENJIN_NO_UPDATE_CHECK: '1' } });
    expect(r.calls).toEqual([]);
    expect(existsSync(join(root, AUTO_UPDATE_FILE))).toBe(false);
  });

  it('starts nothing with TLS checks turned off, and records why once a day for doctor', () => {
    runtime();
    const r = recorder();
    run(r, { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    expect(r.calls).toEqual([]);
    const at = new Date(NOW).toISOString();
    expect(record()).toEqual({
      startedAt: at,
      finishedAt: at,
      outcome: 'skipped',
      reason: TLS_OFF,
    });
    expect(TLS_OFF).toBe(
      'TLS certificate checks are turned off (NODE_TLS_REJECT_UNAUTHORIZED=0); set NODE_EXTRA_CA_CERTS instead',
    );
    expect(autoUpdateLine(root)).toBe(`Auto-update: ${at.slice(0, 10)} skipped: ${TLS_OFF}`);
    // Once a day, like a run: the next session does not rewrite it.
    run(r, { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, now: NOW + HOUR });
    expect(record()).toMatchObject({ startedAt: at });
    // Any other value leaves Node's checks on.
    rmSync(join(root, AUTO_UPDATE_FILE));
    run(r, { env: { NODE_TLS_REJECT_UNAUTHORIZED: '1' } });
    expect(r.calls).toHaveLength(1);
  });

  it('stays put for a data dir that is not the default, which has no runtime', () => {
    runtime();
    const r = recorder();
    run(r, { dir: join(home, 'shelf') });
    expect(r.calls).toEqual([]);
  });

  it('honours a stored update.mode: nudge and off opt out, auto and absent run', () => {
    runtime();
    const cases: [unknown, number][] = [
      [{ update: { mode: 'off' } }, 0],
      [{ update: { mode: 'nudge' } }, 0],
      ['{not json', 0],
      [{ update: { mode: 'auto' } }, 1],
      [{ router: { maxAutoSpend: '0.05' } }, 1],
    ];
    for (const [config, spawns] of cases) {
      rmSync(join(root, AUTO_UPDATE_FILE), { force: true });
      writeFileSync(
        join(dataDir, 'config.json'),
        typeof config === 'string' ? config : JSON.stringify(config),
      );
      const r = recorder();
      run(r);
      expect(r.calls, JSON.stringify(config)).toHaveLength(spawns);
    }
  });

  it('stays put with no runtime, or one whose current files are gone', () => {
    const r = recorder();
    run(r);
    const { entry } = runtime();
    rmSync(entry);
    run(r);
    writeFileSync(join(root, 'state.json'), '{"current":{"cli":"../x","node":"24.15.0"}}');
    run(r);
    expect(r.calls).toEqual([]);
  });

  it('swallows a spawn that throws: the session starts regardless', () => {
    runtime();
    const impl = (() => {
      throw new Error('EAGAIN');
    }) as unknown as typeof spawn;
    expect(() =>
      maybeAutoUpdate({ dataDir, env: {}, home, now: () => NOW, spawnImpl: impl }),
    ).not.toThrow();
  });
});

describe('autoUpdateLine', () => {
  it('says how the last finished run ended, and nothing before one has', () => {
    mkdirSync(root, { recursive: true });
    expect(autoUpdateLine(root)).toBeNull();
    const finishedAt = '2026-10-21T08:00:00.000Z';
    recordAutoUpdate(root, { finishedAt, outcome: 'updated', from: '0.2.0', to: '0.2.1' });
    expect(autoUpdateLine(root)).toBe('Auto-update: 2026-10-21 updated 0.2.0 -> 0.2.1');
    recordAutoUpdate(root, { finishedAt, outcome: 'current', from: '0.2.1', to: '0.2.1' });
    expect(autoUpdateLine(root)).toBe('Auto-update: 2026-10-21 up to date (0.2.1)');
    recordAutoUpdate(root, { finishedAt, outcome: 'failed', reason: 'offline' });
    expect(autoUpdateLine(root)).toBe('Auto-update: 2026-10-21 failed: offline');
  });
});
