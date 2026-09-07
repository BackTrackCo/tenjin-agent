import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookInput } from '../../adapters/types';
import { PRODUCTION_ORIGIN } from '../../lib/production-origin';
import { runFire } from '../fire';
import { getMark, setMark } from '../gates';
import { LOCAL_OPENER, TEAM_OPENER } from '../prose';
import type { LoopDb } from '../store';
import type { Actor, Deps, KernelConfig, Plan } from '../types';
import { failureArm } from './failure';
import {
  CHILD,
  LEAD,
  NOW,
  cleanup,
  fireContext,
  freshDb,
  hookInput,
  kernelConfig,
  toolInput,
} from './test-support';

/**
 * The failure arm on the kernel. Under test: the plan's shape by config (a keys
 * leg only against a team origin), the one stage where a teammate's piece
 * outranks this machine's record, the record rendered by the one formatter, and
 * the pass that closes it.
 */

const TEAM = kernelConfig();
const PUBLIC_ONLY: KernelConfig = { ...TEAM, baseUrl: PRODUCTION_ORIGIN };
const SEARCH_ID = '11111111-1111-4111-8111-111111111111';
const POST_ID = '22222222-2222-4222-8222-222222222222';

const ENOENT =
  "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'\n    at run (src/migrate.ts:12:3)\n";
const VITEST_FAIL =
  ' FAIL  src/date.test.ts > formatDate > handles null\nAssertionError: expected undefined to be null\n';

let db: LoopDb;
let repo: string;

beforeEach(() => {
  db = freshDb();
  repo = mkdtempSync(join(tmpdir(), 'tenjin-d-failure-repo-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(repo, { recursive: true, force: true });
  cleanup();
});

interface Shell {
  command: string;
  ok: boolean;
  stdout?: string;
  stderr?: string;
  actor?: Actor;
  cwd?: string;
}

function shell(s: Shell): HookInput {
  const actor = s.actor ?? LEAD;
  return hookInput({
    event: 'tool.after',
    native: { event: 'PostToolUse' },
    session: actor.session,
    cwd: s.cwd ?? repo,
    ...(actor.agent !== '' ? { agent: actor.agent } : {}),
    tool: {
      ...toolInput('shell', { command: s.command }),
      ok: s.ok,
      result: { stdout: s.stdout ?? '', stderr: s.stderr ?? '' },
    },
  });
}

function deps(config: KernelConfig = TEAM, clock: () => number = () => NOW): Deps {
  return {
    db,
    config: () => config,
    clock,
    log: () => undefined,
    arms: [failureArm],
    adapters: {},
  };
}

function candidate(): Record<string, unknown> {
  return {
    resourceId: POST_ID,
    url: `${TEAM.baseUrl}/p/enoent`,
    slug: 'enoent',
    title: 'drizzle.config.ts is read from the cwd',
    artifactType: 'finding',
    price: '0',
    asOf: null,
    validUntil: null,
    matchReasons: ['key'],
    estimatedTokens: 120,
    creator: { handle: 'ali' },
    body: { text: 'Run the migration from the package root, not the repo root.' },
  };
}

/** A stubbed shelf that records every keys body and answers `hits` items on
 *  each call in turn (the last entry repeats). */
function shelf(hits: Array<Array<Record<string, unknown>>>): {
  bodies: Array<{ keys: Array<{ key: string }> }>;
} {
  const bodies: Array<{ keys: Array<{ key: string }> }> = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    bodies.push(
      (await new Request(String(input), init).json()) as { keys: Array<{ key: string }> },
    );
    const items = hits[Math.min(bodies.length, hits.length) - 1] ?? [];
    return new Response(
      JSON.stringify({
        schemaVersion: 3,
        searchId: SEARCH_ID,
        calibration: 'key-v1',
        items,
        matched: items.length,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { bodies };
}

async function fire(input: HookInput, d: Deps = deps()) {
  const result = await runFire(input, d);
  result.commit();
  const row = db
    .prepare('SELECT reason, question_key FROM fires ORDER BY rowid DESC LIMIT 1')
    .get() as {
    reason: string;
    question_key: string | null;
  };
  const legs = db
    .prepare(
      'SELECT stage, shelf, outcome FROM legs WHERE fire_id = (SELECT id FROM fires ORDER BY rowid DESC LIMIT 1) ORDER BY stage, shelf',
    )
    .all() as Array<{ stage: number; shelf: string; outcome: string }>;
  return { emit: result.emit, row, legs };
}

function pairings(): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM pairings ORDER BY id').all() as Array<Record<string, unknown>>;
}

function keysOf(body: { keys: Array<{ key: string }> }): string[] {
  return body.keys.map((k) => k.key.split(':')[0] ?? '');
}

async function planOf(input: HookInput, config: KernelConfig = TEAM): Promise<Plan | null> {
  const ctx = fireContext({ db, arm: failureArm, input, config });
  const planned = await failureArm.plan?.(ctx);
  return planned !== null && planned !== undefined && 'stages' in planned ? planned : null;
}

describe('the failure arm registration', () => {
  it('is one tool-wait arm on the shell result', () => {
    expect(failureArm.id).toBe('failure');
    expect(failureArm.wait).toBe('tool');
    expect(failureArm.on).toEqual([{ event: 'tool.after', kind: 'shell' }]);
  });
});

describe('the plan', () => {
  it('asks nothing when push is off, behind a head that is not a toolchain, or on a pass', async () => {
    const off = kernelConfig({ failure: false });
    expect(
      await planOf(shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT }), off),
    ).toBeNull();
    expect(
      await planOf(shell({ command: 'git show x | grep ENOENT', ok: false, stderr: ENOENT })),
    ).toBeNull();
    expect(await planOf(shell({ command: 'pnpm db:migrate', ok: true, stdout: 'ok' }))).toBeNull();
  });

  it('asks nothing below the specificity floor', async () => {
    const totals = ' Test Files  1 failed (1)\n      Tests  2 failed (2)\n';
    expect(await planOf(shell({ command: 'pnpm build', ok: false, stdout: totals }))).toBeNull();
  });

  it('has only the local leg without a team origin: keys go to a team shelf alone', async () => {
    const plan = await planOf(
      shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT }),
      PUBLIC_ONLY,
    );
    expect(plan?.stages.map((s) => s.map((l) => l.shelf))).toEqual([['local']]);
    expect(plan?.question).toEqual({
      text: '',
      questionKey: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it('asks two exact keys in one round, and nothing follows the miss', async () => {
    const { bodies } = shelf([[]]);
    const { row, legs } = await fire(
      shell({ command: 'pnpm test', ok: false, stderr: ENOENT, stdout: VITEST_FAIL }),
    );
    expect(row.reason).toBe('no-hit');
    expect(bodies.map(keysOf)).toEqual([['sig_v1', 'sig_v1_test']]);
    expect(legs.map((l) => [l.stage, l.shelf, l.outcome])).toEqual([
      [0, 'keys', 'miss'],
      [0, 'local', 'miss'],
    ]);
  });
});

describe('what a failure leaves behind', () => {
  it('opens a sig_v1 pairing when the error named a file, and a test pairing beside it', async () => {
    shelf([[]]);
    await fire(shell({ command: 'pnpm test', ok: false, stderr: ENOENT, stdout: VITEST_FAIL }));
    expect(pairings()).toMatchObject([
      {
        kind: 'sig_v1',
        status: 'open',
        cmd_head: 'pnpm',
        cmd: 'pnpm test',
        error_files: '["migrate.ts"]',
      },
      { kind: 'sig_v1_test', status: 'open', cmd_head: 'pnpm', error_files: '["date.test.ts"]' },
    ]);
    expect(pairings()[0]).toMatchObject({
      error_line: "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'",
    });
  });

  it("reads a test report only behind this call's own `bashstart` stamp", async () => {
    shelf([[]]);
    // A report from an earlier run sits in the checkout, naming another file.
    writeFileSync(
      join(repo, '.vitest-report.json'),
      JSON.stringify({
        startTime: NOW - 1000,
        endTime: NOW - 100,
        failed: [{ file: join(repo, 'src/a.test.ts'), suite: 's', test: 't' }],
      }),
    );
    await fire(shell({ command: 'pnpm test', ok: false, stdout: VITEST_FAIL }));
    // No stamp (the PreToolUse fire never reached the daemon): the console
    // header is the identity, not the stale report.
    expect(pairings()).toMatchObject([{ kind: 'sig_v1_test', error_files: '["date.test.ts"]' }]);

    setMark(db, LEAD, 'bashstart', String(NOW - 2000), NOW - 2000);
    await fire(shell({ command: 'pnpm test', ok: false, stdout: VITEST_FAIL }));
    expect(pairings().at(-1)).toMatchObject({ kind: 'sig_v1_test', error_files: '["a.test.ts"]' });
  });

  it('opens nothing when the error named no file and no shelf answered', async () => {
    shelf([[]]);
    const noFile = 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"\n';
    const { row } = await fire(shell({ command: 'pnpm install', ok: false, stderr: noFile }));
    expect(row.reason).toBe('no-hit');
    expect(pairings()).toEqual([]);
  });

  it('opens a pairing even with no file on a keys hit', async () => {
    shelf([[candidate()]]);
    const noFile = 'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"\n';
    const { row, emit } = await fire(shell({ command: 'pnpm install', ok: false, stderr: noFile }));
    expect(row.reason).toBe('hit');
    expect(emit?.context).toContain(TEAM_OPENER);
    const [opened] = pairings();
    expect(opened).toMatchObject({ kind: 'sig_v1', status: 'open', error_files: '[]' });
    expect(getMark(db, LEAD, 'replayed:pnpm')).toBe(`[${opened!.id}]`);
  });

  it('is one problem however many times the same actor re-runs it', async () => {
    shelf([[]]);
    const input = shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT });
    await fire(input);
    const { row } = await fire(input);
    expect(row.reason).toBe('cached');
    expect(pairings()).toHaveLength(1);
  });
});

describe('the record, once closed', () => {
  /** Fail, fix the file the error named, pass: one unverified record. */
  async function record(actor: Actor = LEAD): Promise<number> {
    shelf([[]]);
    await fire(shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT, actor }));
    const [opened] = pairings();
    setMark(db, actor, 'edited:x', join(repo, 'src/migrate.ts'), NOW + 10);
    await fire(
      shell({ command: 'pnpm db:migrate', ok: true, stdout: 'ok', actor }),
      deps(TEAM, () => NOW + 20),
    );
    expect(pairings()[0]).toMatchObject({ status: 'unverified' });
    return Number(opened!.id);
  }

  it('is delivered by the one formatter under the local opener, to a NEW actor, and remembered', async () => {
    const id = await record();
    const { row, emit, legs } = await fire(
      shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT, actor: CHILD }),
    );
    expect(row.reason).toBe('hit');
    expect(legs).toEqual([
      { stage: 0, shelf: 'keys', outcome: 'miss' },
      { stage: 0, shelf: 'local', outcome: 'hit' },
    ]);
    const text = emit?.context ?? '';
    const [opener, header, fence, ...rest] = text.split('\n');
    expect(opener).toBe(LOCAL_OPENER);
    expect(header).toContain("Error: ENOENT: no such file or directory, open 'drizzle.config.ts'");
    expect(fence).toMatch(/^--- tenjin-body \w+ ---$/);
    expect(rest).toEqual([
      'Someone once fixed this by touching: src/migrate.ts.',
      'It passed afterwards on: pnpm db:migrate',
      fence,
      expect.stringContaining('If this settles it'),
    ]);
    expect(getMark(db, CHILD, 'replayed:pnpm')).toBe(`[${id}]`);
    expect(getMark(db, CHILD, `seen:pairing:${id}`)).not.toBeNull();
    // Being shown a record opens no second row for the same failure.
    expect(pairings()).toHaveLength(1);
  });

  it("loses to a teammate's piece in the same stage, which ranks first", async () => {
    await record();
    shelf([[candidate()]]);
    const { row, emit, legs } = await fire(
      shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT, actor: CHILD }),
    );
    expect(row.reason).toBe('hit');
    expect(legs).toEqual([
      { stage: 0, shelf: 'keys', outcome: 'hit' },
      { stage: 0, shelf: 'local', outcome: 'shadowed' },
    ]);
    expect(emit?.context).toContain(TEAM_OPENER);
    expect(emit?.context).not.toContain(LOCAL_OPENER);
  });

  it("closes only on this actor's own edit, and the shown record becomes the second close", async () => {
    const id = await record();
    const other: Actor = { session: 's2', agent: 'c2c2c2c2' };
    shelf([[]]);
    await fire(shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT, actor: other }));
    expect(getMark(db, other, 'replayed:pnpm')).toBe(`[${id}]`);
    // Its session's lead edits the named file; the child passes: not its edit.
    setMark(db, { session: 's2', agent: '' }, 'edited:y', join(repo, 'src/migrate.ts'), NOW + 30);
    await fire(
      shell({ command: 'pnpm db:migrate', ok: true, actor: other }),
      deps(TEAM, () => NOW + 40),
    );
    expect(pairings()[0]).toMatchObject({ status: 'unverified', closes: 1 });
    // Its own edit of the same file: the second, independent close.
    setMark(db, other, 'edited:y', join(repo, 'src/migrate.ts'), NOW + 50);
    await fire(
      shell({ command: 'pnpm db:migrate', ok: true, actor: other }),
      deps(TEAM, () => NOW + 60),
    );
    expect(pairings()[0]).toMatchObject({ status: 'verified', closes: 2 });
    expect(
      db
        .prepare('SELECT session, agent_id FROM pairing_closes WHERE pairing_id = ? ORDER BY at')
        .all(id),
    ).toEqual([
      { session: 's1', agent_id: null },
      { session: 's2', agent_id: 'c2c2c2c2' },
    ]);
  });
});
