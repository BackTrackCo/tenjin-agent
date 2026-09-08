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

interface ShelfCall {
  path: string;
  body: { keys?: Array<{ key: string }>; query?: string };
}

/** A stubbed shelf that records every request's path and body and answers
 *  `hits` items on each call in turn (the last entry repeats). BOTH ROUNDS
 *  come through here: `/api/keys/resolve` in stage 0 and `/api/search` in
 *  stage 1, so a test can say which round asked what. */
function shelf(hits: Array<Array<Record<string, unknown>>>): { calls: ShelfCall[] } {
  const calls: ShelfCall[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    calls.push({
      path: new URL(String(input)).pathname,
      body: (await new Request(String(input), init).json()) as ShelfCall['body'],
    });
    const items = hits[Math.min(calls.length, hits.length) - 1] ?? [];
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
  return { calls };
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

function keysOf(call: ShelfCall): string[] {
  return (call.body.keys ?? []).map((k) => k.key.split(':')[0] ?? '');
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

  it('has neither shelf leg without a team origin: both rounds go to a team shelf alone', async () => {
    const plan = await planOf(
      shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT }),
      PUBLIC_ONLY,
    );
    expect(plan?.stages.map((s) => s.map((l) => l.shelf))).toEqual([['local']]);
  });

  it('asks the error line in words, keyed on its own text', async () => {
    const plan = await planOf(shell({ command: 'pnpm db:migrate', ok: false, stderr: ENOENT }));
    expect(plan?.stages.map((s) => s.map((l) => l.shelf))).toEqual([['local', 'keys'], ['team']]);
    expect(plan?.question.text).toBe(
      "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'",
    );
    expect(plan?.question.questionKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('asks in words with no fingerprint at all, under a key of its own', async () => {
    const generic = 'error: linting failed for the workspace\n';
    const plan = await planOf(shell({ command: 'pnpm lint', ok: false, stderr: generic }));
    // No errno and no frame, so `sigV1` refuses it and there is no test
    // identity either: the keys leg has nothing to resolve and is not planned.
    expect(plan?.stages.map((s) => s.map((l) => l.shelf))).toEqual([['local'], ['team']]);
    expect(plan?.question.text).toBe('error: linting failed for the workspace');
    expect(plan?.question.questionKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives two different failures two different question keys', async () => {
    const one = await planOf(shell({ command: 'pnpm lint', ok: false, stderr: 'error: rule a\n' }));
    const two = await planOf(shell({ command: 'pnpm lint', ok: false, stderr: 'error: rule b\n' }));
    expect(one?.question.questionKey).not.toBe(two?.question.questionKey);
    expect(one?.question.questionKey.length).toBeGreaterThan(0);
  });

  it('asks two exact keys in one round, then the words in the next', async () => {
    const { calls } = shelf([[]]);
    const { row, legs } = await fire(
      shell({ command: 'pnpm test', ok: false, stderr: ENOENT, stdout: VITEST_FAIL }),
    );
    expect(row.reason).toBe('no-hit');
    expect(calls.map((c) => c.path)).toEqual(['/api/keys/resolve', '/api/search']);
    expect(keysOf(calls[0]!)).toEqual(['sig_v1', 'sig_v1_test']);
    expect(calls[1]!.body.query).toBe(
      "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'",
    );
    expect(legs.map((l) => [l.stage, l.shelf, l.outcome])).toEqual([
      [0, 'keys', 'miss'],
      [0, 'local', 'miss'],
      [1, 'team', 'miss'],
    ]);
  });

  it('never reaches the words when a fingerprint answered', async () => {
    const { calls } = shelf([[candidate()]]);
    const { row } = await fire(
      shell({ command: 'pnpm test', ok: false, stderr: ENOENT, stdout: VITEST_FAIL }),
    );
    expect(row.reason).toBe('hit');
    expect(calls.map((c) => c.path)).toEqual(['/api/keys/resolve']);
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

    // A DIFFERENT ACTOR runs the second one, because the stamp is per actor and
    // so is the once-per-question claim: the same console text asked twice by
    // one agent is one question, and the second fire would be answered from the
    // claim instead of reading the report at all.
    setMark(db, CHILD, 'bashstart', String(NOW - 2000), NOW - 2000);
    await fire(shell({ command: 'pnpm test', ok: false, stdout: VITEST_FAIL, actor: CHILD }));
    expect(pairings().at(-1)).toMatchObject({ kind: 'sig_v1_test', error_files: '["a.test.ts"]' });
  });

  it('opens no row for a failure it could only ask about in words', async () => {
    shelf([[]]);
    const generic = 'error: linting failed for the workspace\n';
    const { row } = await fire(shell({ command: 'pnpm lint', ok: false, stderr: generic }));
    // It asked — under a key of its own text — and there is no fingerprint to
    // file a pairing under, so the fire's own ledger row is all it leaves.
    expect(row.reason).toBe('no-hit');
    expect(row.question_key).toMatch(/^[0-9a-f]{32}$/);
    expect(pairings()).toEqual([]);
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

  it('answers on the test key before the console-text key', async () => {
    shelf([[]]);
    // One failure carrying both fingerprints, and both rows closed by the edit
    // each one's error named, so the local leg has two records to choose from.
    await fire(shell({ command: 'pnpm test', ok: false, stderr: ENOENT, stdout: VITEST_FAIL }));
    setMark(db, LEAD, 'edited:a', join(repo, 'src/migrate.ts'), NOW + 10);
    setMark(db, LEAD, 'edited:b', join(repo, 'src/date.test.ts'), NOW + 11);
    await fire(
      shell({ command: 'pnpm test', ok: true, stdout: 'ok' }),
      deps(TEAM, () => NOW + 20),
    );
    expect(pairings().map((p) => [p.kind, p.fix_files])).toEqual([
      ['sig_v1', '["src/migrate.ts"]'],
      ['sig_v1_test', '["src/date.test.ts"]'],
    ]);
    // `sig_v1` is a hash of console text and collapses failures onto one
    // value; `sig_v1_test` names the test the runner declared. The one the
    // runner named is what a new actor is handed.
    const { emit } = await fire(
      shell({ command: 'pnpm test', ok: false, stderr: ENOENT, stdout: VITEST_FAIL, actor: CHILD }),
    );
    expect(emit?.context).toContain('src/date.test.ts');
    expect(emit?.context).not.toContain('src/migrate.ts');
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
