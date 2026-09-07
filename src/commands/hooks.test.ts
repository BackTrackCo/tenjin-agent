import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLoopDb } from '../hooks/store';
import { runHooksList, runHooksToggle, type DaemonState } from './hooks';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';

/**
 * `tenjin hooks`: the table, the two toggles, and the refusal on a name that is
 * not one of the seven.
 *
 * Every case runs against a real `loop.db` and a real `config.json` under a temp
 * data dir — the counts are a SQL group-by over rows the daemon writes, and the
 * toggle's whole claim is that it goes through the config writer, so faking
 * either would test the fake.
 */

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempCtx(): Promise<CommandContext> {
  const dir = await mkdtemp(join(tmpdir(), 'tenjin-hooks-'));
  dirs.push(dir);
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

/** One `fires` row, with only the columns this command reads made interesting. */
function fire(dir: string, arm: string, reason: string, at: number): void {
  const db = openLoopDb(dir);
  try {
    db.prepare(
      `INSERT INTO fires (id, at, session, agent, arm, harness, event, cwd, wait, deadline_ms,
                          elapsed_ms, reason)
       VALUES (?, ?, 's1', '', ?, 'claude', 'e', '', 'tool', 4000, 1, ?)`,
    ).run(`${arm}-${reason}-${at}-${Math.random()}`, at, arm, reason);
  } finally {
    db.close();
  }
}

const noDaemon = (): Promise<DaemonState> => Promise.resolve({ running: false });

/** The table rows out of the envelope, keyed by arm. */
type Row = { arm: string; state: string; event: string; fired: number; hit: number };
function rows(data: unknown): Map<string, Row> {
  const arms = (data as { arms: Row[] }).arms;
  return new Map(arms.map((r) => [r.arm, r]));
}

describe('tenjin hooks list', () => {
  it('is one row per arm, enabled by default, with its harness event', async () => {
    const ctx = await tempCtx();
    const result = await runHooksList(ctx, { now: () => NOW, daemonLine: noDaemon });
    const byArm = rows(result.data);
    expect([...byArm.keys()]).toEqual([
      'prompt',
      'web-search',
      'web-fetch',
      'subagent',
      'failure',
      'publish',
      'primer',
    ]);
    for (const row of byArm.values()) expect(row.state).toBe('enabled');
    expect(byArm.get('prompt')?.event).toBe('UserPromptSubmit');
    expect(byArm.get('web-search')?.event).toBe('WebSearch');
    expect(byArm.get('failure')?.event).toBe('PostToolUse failure');
    expect(byArm.get('publish')?.event).toBe('Stop');
  });

  it('counts fires and hits in the window, and nothing older', async () => {
    const ctx = await tempCtx();
    fire(ctx.dataDir, 'prompt', 'hit', NOW - 1000);
    fire(ctx.dataDir, 'prompt', 'no-hit', NOW - 2000);
    fire(ctx.dataDir, 'prompt', 'seen', NOW - 3000);
    // Eight days back: outside the seven-day window and counted nowhere.
    fire(ctx.dataDir, 'prompt', 'hit', NOW - 8 * DAY);
    const result = await runHooksList(ctx, { now: () => NOW, daemonLine: noDaemon });
    const prompt = rows(result.data).get('prompt');
    expect(prompt?.fired).toBe(3);
    expect(prompt?.hit).toBe(1);
  });

  it("sums both of an arm's fire ids under its one key", async () => {
    const ctx = await tempCtx();
    // `subagent` answers the dispatch and again at the child's start; `publish`
    // asks at the lead's Stop and at each subagent's. One key, two ids each.
    fire(ctx.dataDir, 'dispatch', 'hit', NOW - 1000);
    fire(ctx.dataDir, 'subagent-start', 'hit', NOW - 900);
    fire(ctx.dataDir, 'stop', 'no-question', NOW - 800);
    fire(ctx.dataDir, 'subagent-stop', 'hit', NOW - 700);
    // The context arm has no key, so its fires are counted under nobody.
    fire(ctx.dataDir, 'context', 'hit', NOW - 600);
    const byArm = rows((await runHooksList(ctx, { now: () => NOW, daemonLine: noDaemon })).data);
    expect(byArm.get('subagent')).toMatchObject({ fired: 2, hit: 2 });
    expect(byArm.get('publish')).toMatchObject({ fired: 2, hit: 1 });
    expect([...byArm.values()].reduce((n, r) => n + r.fired, 0)).toBe(4);
  });

  it('reads the state off config, and the daemon line off the running daemon', async () => {
    const ctx = await tempCtx();
    await writeFile(
      join(ctx.dataDir, 'config.json'),
      JSON.stringify({ hooks: { 'web-fetch': false } }),
    );
    const result = await runHooksList(ctx, {
      now: () => NOW,
      daemonLine: () =>
        Promise.resolve({ running: true, pid: 8123, port: 30412, version: '0.9.2' }),
    });
    expect(rows(result.data).get('web-fetch')?.state).toBe('disabled');
    expect(rows(result.data).get('web-search')?.state).toBe('enabled');
    expect(result.humanLines?.at(-1)).toBe('daemon: 127.0.0.1:30412, pid 8123, v0.9.2');
  });

  it('renders a header row and one padded line per arm', async () => {
    const ctx = await tempCtx();
    const result = await runHooksList(ctx, { now: () => NOW, daemonLine: noDaemon });
    const lines = result.humanLines ?? [];
    expect(lines[0]).toMatch(/^ARM\s+STATE\s+EVENT\s+FIRED 7d\s+HIT 7d$/);
    // Seven arms, plus the header and the daemon line.
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toContain('not running');
  });
});

describe('tenjin hooks enable|disable', () => {
  it('round-trips one arm through config.json and leaves the others alone', async () => {
    const ctx = await tempCtx();
    const off = await runHooksToggle('web-search', false, ctx);
    expect(off.data).toEqual({ arm: 'web-search', state: 'disabled' });
    expect(off.humanLines?.[0]).toContain('hooks.web-search disabled');
    expect(
      rows((await runHooksList(ctx, { now: () => NOW, daemonLine: noDaemon })).data).get(
        'web-search',
      )?.state,
    ).toBe('disabled');

    const on = await runHooksToggle('web-search', true, ctx);
    expect(on.data).toEqual({ arm: 'web-search', state: 'enabled' });
    const config = JSON.parse(await readFile(join(ctx.dataDir, 'config.json'), 'utf8')) as {
      hooks: Record<string, boolean>;
    };
    expect(config.hooks).toEqual({ 'web-search': true });
  });

  it('merges rather than replaces, so a sibling key set earlier survives', async () => {
    const ctx = await tempCtx();
    await runHooksToggle('primer', false, ctx);
    await runHooksToggle('failure', false, ctx);
    const config = JSON.parse(await readFile(join(ctx.dataDir, 'config.json'), 'utf8')) as {
      hooks: Record<string, boolean>;
    };
    expect(config.hooks).toEqual({ primer: false, failure: false });
  });

  it('refuses a name that is not one of the seven, naming all of them', async () => {
    const ctx = await tempCtx();
    const err = await runHooksToggle('websearch', false, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe('USAGE');
    expect((err as CliError).message).toContain('websearch');
    expect((err as CliError).fix).toBe(
      'The arms are prompt, web-search, web-fetch, subagent, failure, publish, primer; `tenjin hooks` lists them with their state.',
    );
  });
});
