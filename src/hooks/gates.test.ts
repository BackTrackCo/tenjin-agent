import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput } from '../adapters/types';
import { CONFIG_DEFAULTS } from '../lib/config';
import { actorOf, STARTED_MARK } from './actor';
import {
  charge,
  claim,
  deleteMark,
  finish,
  firstSight,
  gates,
  getMark,
  release,
  setMark,
} from './gates';
import { openLoopDb, type LoopDb } from './store';
import type { Actor, Answer, FireContext, KernelConfig, Plan } from './types';

const dirs: string[] = [];
const open: LoopDb[] = [];

async function freshDb(): Promise<LoopDb> {
  const dir = await mkdtemp(join(tmpdir(), 'tenjin-b-gates-'));
  dirs.push(dir);
  const db = openLoopDb(dir);
  open.push(db);
  return db;
}

afterEach(async () => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const NOW = 1_700_000_000_000;
const RATE = 3;
const BURST = 6;
const WAIT_MS = 2500;

const LEAD: Actor = { session: 's1', agent: '' };
const CHILD: Actor = { session: 's1', agent: 'a7c31e9f' };

const ANSWER: Answer = {
  shelf: 'team',
  strength: 'strong',
  resourceId: 'r1',
  title: 'ryuk serializes testcontainers',
};

function tatOf(db: LoopDb, actor: Actor, arm: string): number | undefined {
  const row = db
    .prepare('SELECT tat FROM actors WHERE session = ? AND agent = ? AND arm = ?')
    .get(actor.session, actor.agent, arm) as { tat: number } | undefined;
  return row?.tat;
}

function actorRows(db: LoopDb): number {
  return (db.prepare('SELECT count(*) AS n FROM actors').get() as { n: number }).n;
}

/** Charge `n` times and return how many were allowed. */
function burstOf(db: LoopDb, actor: Actor, arm: string, now: number, n: number): number {
  let allowed = 0;
  for (let i = 0; i < n; i++) if (charge(db, actor, arm, now, RATE, BURST)) allowed++;
  return allowed;
}

function input(over: Partial<HookInput> = {}): HookInput {
  return {
    harness: 'claude',
    event: 'prompt',
    native: { event: 'UserPromptSubmit' },
    session: 's1',
    cwd: '/tmp/proj',
    raw: {},
    ...over,
  };
}

const CONFIG: KernelConfig = {
  hooks: CONFIG_DEFAULTS.hooks,
  loop: { ...CONFIG_DEFAULTS.loop, rate_per_min: RATE, burst: BURST },
  team: CONFIG_DEFAULTS.team,
};

function context(db: LoopDb, actor: Actor, now: number): FireContext {
  return {
    actor,
    input: input({ agent: actor.agent || undefined }),
    arm: { id: 'prompt', wait: 'human', on: [{ event: 'prompt' }] },
    fire: {
      id: 'f1',
      startedAt: now,
      deadlineMs: WAIT_MS,
      remaining: () => WAIT_MS,
      signal: new AbortController().signal,
      legs: [],
    },
    deps: {
      db,
      config: () => CONFIG,
      clock: () => now,
      log: () => undefined,
      arms: [],
      adapters: {},
    },
  };
}

const PLAN: Plan = { question: { text: 'why is vitest slow', fingerprint: 'fp1' }, stages: [] };

describe('marks', () => {
  it('get, set (upsert), delete on one (session, agent, key)', async () => {
    const db = await freshDb();
    expect(getMark(db, LEAD, 'k')).toBeNull();
    setMark(db, LEAD, 'k', 'v1', NOW);
    expect(getMark(db, LEAD, 'k')).toBe('v1');
    setMark(db, LEAD, 'k', 'v2', NOW + 1);
    expect(getMark(db, LEAD, 'k')).toBe('v2');
    expect(db.prepare('SELECT at FROM marks').all()).toEqual([{ at: NOW + 1 }]);
    // The lead and a child of the same session hold separate marks.
    expect(getMark(db, CHILD, 'k')).toBeNull();
    deleteMark(db, LEAD, 'k');
    expect(getMark(db, LEAD, 'k')).toBeNull();
  });
});

describe('charge (GCRA)', () => {
  it('allows the burst at a fixed now and denies the next', async () => {
    const db = await freshDb();
    expect(burstOf(db, LEAD, 'prompt', NOW, BURST)).toBe(BURST);
    expect(charge(db, LEAD, 'prompt', NOW, RATE, BURST)).toBe(false);
    // tat sits one interval past the burst's edge.
    expect(tatOf(db, LEAD, 'prompt')).toBe(NOW + (60_000 / RATE) * BURST);
  });

  it('refills one unit per emission interval', async () => {
    const db = await freshDb();
    burstOf(db, LEAD, 'prompt', NOW, BURST);
    const later = NOW + 20_000;
    expect(charge(db, LEAD, 'prompt', later, RATE, BURST)).toBe(true);
    expect(charge(db, LEAD, 'prompt', later, RATE, BURST)).toBe(false);
  });

  it('has the full burst back after ten minutes', async () => {
    const db = await freshDb();
    burstOf(db, LEAD, 'prompt', NOW, BURST);
    const later = NOW + 60_000 * 10;
    expect(burstOf(db, LEAD, 'prompt', later, BURST)).toBe(BURST);
    expect(charge(db, LEAD, 'prompt', later, RATE, BURST)).toBe(false);
  });

  it('keeps a bucket per (session, agent, arm)', async () => {
    const db = await freshDb();
    burstOf(db, LEAD, 'prompt', NOW, BURST);
    expect(charge(db, LEAD, 'prompt', NOW, RATE, BURST)).toBe(false);
    expect(charge(db, CHILD, 'prompt', NOW, RATE, BURST)).toBe(true);
    expect(charge(db, LEAD, 'stop', NOW, RATE, BURST)).toBe(true);
    expect(charge(db, { session: 's2', agent: '' }, 'prompt', NOW, RATE, BURST)).toBe(true);
    expect(db.prepare('SELECT agent FROM actors ORDER BY agent, arm').all()).toEqual([
      { agent: '' },
      { agent: '' },
      { agent: '' },
      { agent: CHILD.agent },
    ]);
  });

  it('never denies a fresh actor its first charge', async () => {
    const db = await freshDb();
    // Well past any plausible tat, and at zero: tat starts at 0, not at now.
    expect(charge(db, LEAD, 'prompt', NOW * 2, RATE, BURST)).toBe(true);
    expect(charge(db, CHILD, 'prompt', 0, RATE, BURST)).toBe(true);
    expect(charge(db, { session: 's3', agent: '' }, 'prompt', NOW, 1, 1)).toBe(true);
  });
});

describe('claim / finish / release', () => {
  it('first claim is fresh and writes an asking mark', async () => {
    const db = await freshDb();
    expect(claim(db, LEAD, 'fp1', NOW, WAIT_MS)).toEqual({ kind: 'fresh' });
    expect(JSON.parse(getMark(db, LEAD, 'q:fp1') ?? 'null')).toEqual({
      status: 'asking',
      at: NOW,
    });
  });

  it('a second claim inside waitMs is asked; past it the question is retaken', async () => {
    const db = await freshDb();
    claim(db, LEAD, 'fp1', NOW, WAIT_MS);
    expect(claim(db, LEAD, 'fp1', NOW + WAIT_MS - 1, WAIT_MS)).toEqual({ kind: 'asked' });
    expect(JSON.parse(getMark(db, LEAD, 'q:fp1') ?? 'null')).toEqual({
      status: 'asking',
      at: NOW,
    });
    // A stale `asking` is a fire that hit its deadline or crashed: retake it.
    expect(claim(db, LEAD, 'fp1', NOW + WAIT_MS, WAIT_MS)).toEqual({ kind: 'fresh' });
    expect(JSON.parse(getMark(db, LEAD, 'q:fp1') ?? 'null')).toEqual({
      status: 'asking',
      at: NOW + WAIT_MS,
    });
  });

  it('finish caches the verdict, hit or miss', async () => {
    const db = await freshDb();
    claim(db, LEAD, 'fp1', NOW, WAIT_MS);
    finish(db, LEAD, 'fp1', ANSWER, NOW + 100);
    expect(claim(db, LEAD, 'fp1', NOW + 60_000 * 60, WAIT_MS)).toEqual({
      kind: 'cached',
      answer: ANSWER,
    });

    claim(db, LEAD, 'fp2', NOW, WAIT_MS);
    finish(db, LEAD, 'fp2', null, NOW + 100);
    expect(claim(db, LEAD, 'fp2', NOW + 200, WAIT_MS)).toEqual({ kind: 'cached', answer: null });
  });

  it('release frees the question', async () => {
    const db = await freshDb();
    claim(db, LEAD, 'fp1', NOW, WAIT_MS);
    release(db, LEAD, 'fp1');
    expect(getMark(db, LEAD, 'q:fp1')).toBeNull();
    expect(claim(db, LEAD, 'fp1', NOW + 1, WAIT_MS)).toEqual({ kind: 'fresh' });
  });

  it('treats a corrupt mark as absent', async () => {
    const db = await freshDb();
    setMark(db, LEAD, 'q:fp1', '{not json', NOW);
    expect(claim(db, LEAD, 'fp1', NOW + 1, WAIT_MS)).toEqual({ kind: 'fresh' });
    setMark(db, LEAD, 'q:fp2', JSON.stringify({ status: 'weird', at: NOW }), NOW);
    expect(claim(db, LEAD, 'fp2', NOW + 1, WAIT_MS)).toEqual({ kind: 'fresh' });
    expect(JSON.parse(getMark(db, LEAD, 'q:fp1') ?? 'null')).toEqual({
      status: 'asking',
      at: NOW + 1,
    });
  });

  it('claims are per actor', async () => {
    const db = await freshDb();
    claim(db, LEAD, 'fp1', NOW, WAIT_MS);
    expect(claim(db, CHILD, 'fp1', NOW, WAIT_MS)).toEqual({ kind: 'fresh' });
  });
});

describe('firstSight', () => {
  it('is true once per resource per actor', async () => {
    const db = await freshDb();
    expect(firstSight(db, LEAD, 'r1', NOW)).toBe(true);
    expect(firstSight(db, LEAD, 'r1', NOW + 1)).toBe(false);
    expect(firstSight(db, LEAD, 'r2', NOW)).toBe(true);
    expect(firstSight(db, CHILD, 'r1', NOW)).toBe(true);
    expect(firstSight(db, CHILD, 'r1', NOW)).toBe(false);
    expect(getMark(db, LEAD, 'seen:r1')).toBe(String(NOW));
  });
});

describe('gates', () => {
  it('lets a fresh question through, claimed and charged', async () => {
    const db = await freshDb();
    expect(gates(context(db, LEAD, NOW), PLAN)).toBeNull();
    expect(JSON.parse(getMark(db, LEAD, 'q:fp1') ?? 'null')).toEqual({
      status: 'asking',
      at: NOW,
    });
    expect(tatOf(db, LEAD, 'prompt')).toBe(NOW + 60_000 / RATE);
  });

  it('asked: a live claim skips without touching actors', async () => {
    const db = await freshDb();
    claim(db, LEAD, 'fp1', NOW, WAIT_MS);
    expect(gates(context(db, LEAD, NOW + WAIT_MS - 1), PLAN)).toEqual({ reason: 'asked' });
    expect(actorRows(db)).toBe(0);
  });

  it('rate: a denied charge releases the claim', async () => {
    const db = await freshDb();
    burstOf(db, LEAD, 'prompt', NOW, BURST);
    expect(gates(context(db, LEAD, NOW), PLAN)).toEqual({ reason: 'rate' });
    expect(getMark(db, LEAD, 'q:fp1')).toBeNull();
    // Nothing is left for the next fire of the same question to wait on.
    expect(claim(db, LEAD, 'fp1', NOW + 1, WAIT_MS)).toEqual({ kind: 'fresh' });
  });

  it('cached: the stored verdict rides out without a charge', async () => {
    const db = await freshDb();
    charge(db, LEAD, 'prompt', NOW, RATE, BURST);
    const tat = tatOf(db, LEAD, 'prompt');
    finish(db, LEAD, 'fp1', ANSWER, NOW);
    expect(gates(context(db, LEAD, NOW + 1), PLAN)).toEqual({ reason: 'cached', answer: ANSWER });
    expect(tatOf(db, LEAD, 'prompt')).toBe(tat);

    finish(db, LEAD, 'fp1', null, NOW + 2);
    expect(gates(context(db, LEAD, NOW + 3), PLAN)).toEqual({ reason: 'cached' });
    expect(tatOf(db, LEAD, 'prompt')).toBe(tat);
  });

  it('charges the arm named by the context, per actor', async () => {
    const db = await freshDb();
    burstOf(db, LEAD, 'prompt', NOW, BURST);
    expect(gates(context(db, CHILD, NOW), PLAN)).toBeNull();
    expect(tatOf(db, CHILD, 'prompt')).toBe(NOW + 60_000 / RATE);
  });
});

describe('actorOf', () => {
  it('lead is agent "", child is its id', async () => {
    const db = await freshDb();
    expect(actorOf(input(), db)).toEqual(LEAD);
    expect(actorOf(input({ agent: CHILD.agent }), db)).toEqual(CHILD);
    expect(actorOf(input({ event: 'agent.start', agent: CHILD.agent }), db)).toEqual(CHILD);
  });

  it('agent.stop needs a started mark from the same actor', async () => {
    const db = await freshDb();
    const stop = input({
      event: 'agent.stop',
      native: { event: 'SubagentStop' },
      agent: CHILD.agent,
    });
    expect(actorOf(stop, db)).toBeNull();
    // Another child's start does not vouch for this one.
    setMark(db, { session: 's1', agent: 'deadbeef' }, STARTED_MARK, String(NOW), NOW);
    expect(actorOf(stop, db)).toBeNull();
    setMark(db, CHILD, STARTED_MARK, String(NOW), NOW);
    expect(actorOf(stop, db)).toEqual(CHILD);
  });
});
