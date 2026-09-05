import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput } from '../adapters/types';
import { CONFIG_DEFAULTS } from '../lib/config';
import { actorOf, STARTED_MARK } from './actor';
import { claim, deleteMark, finish, firstSight, gates, getMark, release, setMark } from './gates';
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
const WAIT_MS = 2500;

const LEAD: Actor = { session: 's1', agent: '' };
const CHILD: Actor = { session: 's1', agent: 'a7c31e9f' };

const ANSWER: Answer = {
  shelf: 'team',
  strength: 'strong',
  resourceId: 'r1',
  title: 'ryuk serializes testcontainers',
};

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
  loop: CONFIG_DEFAULTS.loop,
  team: CONFIG_DEFAULTS.team,
  baseUrl: CONFIG_DEFAULTS.baseUrl,
  publicShelfUrl: CONFIG_DEFAULTS.publicShelfUrl,
  shelfBypassSecret: CONFIG_DEFAULTS.shelfBypassSecret,
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

const PLAN: Plan = { question: { text: 'why is vitest slow', questionKey: 'qk1' }, stages: [] };

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

describe('claim / finish / release', () => {
  it('first claim is fresh and writes an asking mark', async () => {
    const db = await freshDb();
    expect(claim(db, LEAD, 'qk1', NOW, WAIT_MS)).toEqual({ kind: 'fresh' });
    expect(JSON.parse(getMark(db, LEAD, 'q:qk1') ?? 'null')).toEqual({
      status: 'asking',
      at: NOW,
    });
  });

  it('a second claim inside waitMs is asked; past it the question is retaken', async () => {
    const db = await freshDb();
    claim(db, LEAD, 'qk1', NOW, WAIT_MS);
    expect(claim(db, LEAD, 'qk1', NOW + WAIT_MS - 1, WAIT_MS)).toEqual({ kind: 'asked' });
    expect(JSON.parse(getMark(db, LEAD, 'q:qk1') ?? 'null')).toEqual({
      status: 'asking',
      at: NOW,
    });
    // A stale `asking` is a fire that hit its deadline or crashed: retake it.
    expect(claim(db, LEAD, 'qk1', NOW + WAIT_MS, WAIT_MS)).toEqual({ kind: 'fresh' });
    expect(JSON.parse(getMark(db, LEAD, 'q:qk1') ?? 'null')).toEqual({
      status: 'asking',
      at: NOW + WAIT_MS,
    });
  });

  it('finish caches the verdict, hit or miss', async () => {
    const db = await freshDb();
    claim(db, LEAD, 'qk1', NOW, WAIT_MS);
    finish(db, LEAD, 'qk1', ANSWER, NOW + 100);
    expect(claim(db, LEAD, 'qk1', NOW + 60_000 * 60, WAIT_MS)).toEqual({
      kind: 'cached',
      answer: ANSWER,
    });

    claim(db, LEAD, 'qk2', NOW, WAIT_MS);
    finish(db, LEAD, 'qk2', null, NOW + 100);
    expect(claim(db, LEAD, 'qk2', NOW + 200, WAIT_MS)).toEqual({ kind: 'cached', answer: null });
  });

  it('release frees the question', async () => {
    const db = await freshDb();
    claim(db, LEAD, 'qk1', NOW, WAIT_MS);
    release(db, LEAD, 'qk1');
    expect(getMark(db, LEAD, 'q:qk1')).toBeNull();
    expect(claim(db, LEAD, 'qk1', NOW + 1, WAIT_MS)).toEqual({ kind: 'fresh' });
  });

  it('treats a corrupt mark as absent', async () => {
    const db = await freshDb();
    setMark(db, LEAD, 'q:qk1', '{not json', NOW);
    expect(claim(db, LEAD, 'qk1', NOW + 1, WAIT_MS)).toEqual({ kind: 'fresh' });
    setMark(db, LEAD, 'q:qk2', JSON.stringify({ status: 'weird', at: NOW }), NOW);
    expect(claim(db, LEAD, 'qk2', NOW + 1, WAIT_MS)).toEqual({ kind: 'fresh' });
    expect(JSON.parse(getMark(db, LEAD, 'q:qk1') ?? 'null')).toEqual({
      status: 'asking',
      at: NOW + 1,
    });
  });

  it('claims are per actor', async () => {
    const db = await freshDb();
    claim(db, LEAD, 'qk1', NOW, WAIT_MS);
    expect(claim(db, CHILD, 'qk1', NOW, WAIT_MS)).toEqual({ kind: 'fresh' });
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
  it('lets a fresh question through, claimed', async () => {
    const db = await freshDb();
    expect(gates(context(db, LEAD, NOW), PLAN)).toBeNull();
    expect(JSON.parse(getMark(db, LEAD, 'q:qk1') ?? 'null')).toMatchObject({
      status: 'asking',
      at: NOW,
    });
  });

  it('asked: a live claim skips', async () => {
    const db = await freshDb();
    claim(db, LEAD, 'qk1', NOW, WAIT_MS);
    expect(gates(context(db, LEAD, NOW + WAIT_MS - 1), PLAN)).toEqual({ reason: 'asked' });
  });

  it('cached: the stored verdict rides out', async () => {
    const db = await freshDb();
    finish(db, LEAD, 'qk1', ANSWER, NOW);
    expect(gates(context(db, LEAD, NOW + 1), PLAN)).toEqual({ reason: 'cached', answer: ANSWER });

    finish(db, LEAD, 'qk1', null, NOW + 2);
    expect(gates(context(db, LEAD, NOW + 3), PLAN)).toEqual({ reason: 'cached' });
  });

  it('never refuses a repeated fire: nothing counts lookups any more', async () => {
    // The client-side rate limit is deleted (09-pr-c-lookup-arms.md, review
    // round 2): a research subagent's 15-to-18-a-minute burst must reach the
    // shelf. A fresh question is fresh however many came before it.
    const db = await freshDb();
    for (let i = 0; i < 50; i++) {
      const plan: Plan = { question: { text: `q${i}`, questionKey: `qk-${i}` }, stages: [] };
      expect(gates(context(db, LEAD, NOW), plan)).toBeNull();
    }
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
