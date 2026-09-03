import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput, HookTool } from '../adapters/types';
import { CONFIG_DEFAULTS } from '../lib/config';
import { claim, getMark } from './gates';
import { runFire, selectArm } from './fire';
import { openLoopDb, type LoopDb } from './store';
import type { Actor, Answer, Arm, Deps, KernelConfig, Leg, LegResult } from './types';

// End-to-end over a real loop.db: every gate, the ledger write and the bail
// timer are the real thing, only the clock, the arms and the legs are fake
// (02-redesign.md §5, 07-pr-b-daemon-kernel.md).

const dirs: string[] = [];
const open: LoopDb[] = [];

async function freshDb(): Promise<LoopDb> {
  const dir = await mkdtemp(join(tmpdir(), 'tenjin-b-fire-'));
  dirs.push(dir);
  const db = openLoopDb(dir);
  open.push(db);
  return db;
}

afterEach(async () => {
  vi.useRealTimers();
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
const LEAD: Actor = { session: 's1', agent: '' };

const CONFIG: KernelConfig = {
  hooks: CONFIG_DEFAULTS.hooks,
  loop: CONFIG_DEFAULTS.loop,
  team: CONFIG_DEFAULTS.team,
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

function toolOf(kind: HookTool['kind']): HookTool {
  return { name: 'x', kind, input: {} };
}

function deps(db: LoopDb, arms: Arm[], clock: () => number = () => NOW): Deps {
  return { db, config: () => CONFIG, clock, log: () => undefined, arms, adapters: {} };
}

interface FireRow {
  id: string;
  arm: string;
  reason: string;
  wait: string;
  deadline_ms: number;
  delivered: string | null;
  question: string | null;
}

interface LegDbRow {
  shelf: string;
  status: string;
  outcome: string;
}

function fireRows(db: LoopDb): FireRow[] {
  return db.prepare('SELECT * FROM fires').all() as unknown as FireRow[];
}

function legRows(db: LoopDb, fireId: string): LegDbRow[] {
  return db
    .prepare('SELECT shelf, status, outcome FROM legs WHERE fire_id = ?')
    .all(fireId) as unknown as LegDbRow[];
}

function strongLeg(resourceId: string): Leg {
  return {
    shelf: 'team',
    request: async (): Promise<LegResult> => ({ status: 'ok' }),
    verdict: (): Answer => ({ shelf: 'team', strength: 'strong', resourceId }),
  };
}

function rejectingLeg(): Leg {
  return {
    shelf: 'team',
    request: async () => {
      throw new Error('leg exploded');
    },
    verdict: () => null,
  };
}

function rateLimitedLeg(): Leg {
  return {
    shelf: 'public',
    request: async (): Promise<LegResult> => ({ status: 'http_429' }),
    verdict: () => null,
  };
}

/** Resolves only when its combined signal aborts, like a fetch that outlives the deadline. */
function hangingLeg(): Leg {
  return {
    shelf: 'team',
    request: (_q, _budgetMs, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      }),
    verdict: () => null,
  };
}

describe('selectArm', () => {
  it('matches on event and kind; kind undefined matches any tool; first match wins', () => {
    const web: Arm = { id: 'web', wait: 'tool', on: [{ event: 'tool.before', kind: 'web' }] };
    const anyTool: Arm = { id: 'any', wait: 'tool', on: [{ event: 'tool.before' }] };

    expect(selectArm(input({ event: 'tool.before', tool: toolOf('web') }), [web, anyTool])).toBe(
      web,
    );
    // kind undefined on the arm's `on` entry matches any tool kind.
    expect(selectArm(input({ event: 'tool.before', tool: toolOf('shell') }), [web, anyTool])).toBe(
      anyTool,
    );
    // First matching arm wins even when a later one would also match.
    expect(selectArm(input({ event: 'tool.before', tool: toolOf('web') }), [anyTool, web])).toBe(
      anyTool,
    );
    expect(selectArm(input({ event: 'tool.after' }), [web, anyTool])).toBeNull();
  });
});

describe('runFire: no question', () => {
  it('no arm: one fires row, arm "none", reason no-question, wait tool, deadline tool_wait_ms', async () => {
    const db = await freshDb();
    const { commit } = await runFire(input(), deps(db, []));
    commit();
    const rows = fireRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      arm: 'none',
      reason: 'no-question',
      wait: 'tool',
      deadline_ms: CONFIG_DEFAULTS.loop.tool_wait_ms,
    });
  });

  it("arm.plan null: no-question, before() ran, deadline is the arm's wait", async () => {
    const db = await freshDb();
    const before = vi.fn();
    const arm: Arm = {
      id: 'noq',
      wait: 'human',
      on: [{ event: 'prompt' }],
      before,
      plan: () => null,
    };
    const { commit } = await runFire(input(), deps(db, [arm]));
    commit();
    expect(before).toHaveBeenCalledOnce();
    const rows = fireRows(db);
    expect(rows[0]).toMatchObject({
      arm: 'noq',
      reason: 'no-question',
      wait: 'human',
      deadline_ms: CONFIG_DEFAULTS.loop.human_wait_ms,
    });
  });
});

describe('runFire: a hit', () => {
  it('delivers, caches the verdict, and rows one leg as hit', async () => {
    const db = await freshDb();
    const arm: Arm = {
      id: 'hit-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => ({
        question: { text: 'why is vitest slow', fingerprint: 'fp-hit' },
        stages: [[strongLeg('res-1')]],
      }),
      deliver: (answer) => ({
        mode: 'inject',
        text: `because ${answer.resourceId}`,
        resourceId: answer.resourceId,
      }),
    };
    const { emit, commit } = await runFire(input(), deps(db, [arm]));
    expect(emit).toEqual({ context: 'because res-1' });
    commit();

    const rows = fireRows(db);
    expect(rows[0]).toMatchObject({ reason: 'hit', delivered: 'inject:res-1' });
    expect(legRows(db, rows[0]!.id)).toEqual([{ shelf: 'team', status: 'ok', outcome: 'hit' }]);
    expect(JSON.parse(getMark(db, LEAD, 'q:fp-hit') ?? 'null')).toMatchObject({ status: 'done' });
  });

  it('a deliver() that throws after the verdict keeps the cached verdict', async () => {
    // The catch releases only a claim this fire still holds as `asking`;
    // once `finish` cached the verdict, an error in delivery must not turn
    // the next identical question back into a paid lookup.
    const db = await freshDb();
    let legCalls = 0;
    const leg = strongLeg('res-x');
    const counted: Leg = {
      ...leg,
      request: (q, b, sig) => {
        legCalls += 1;
        return leg.request(q, b, sig);
      },
    };
    let deliverCalls = 0;
    const arm: Arm = {
      id: 'throwing-deliver',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => ({
        question: { text: 'q', fingerprint: 'fp-throw' },
        stages: [[counted]],
      }),
      deliver: () => {
        deliverCalls += 1;
        if (deliverCalls === 1) throw new Error('deliver exploded');
        return { mode: 'inject', text: 'ok', resourceId: 'res-x' };
      },
    };
    const first = await runFire(input(), deps(db, [arm]));
    first.commit();
    expect(fireRows(db)[0]).toMatchObject({ reason: 'error' });
    expect(JSON.parse(getMark(db, LEAD, 'q:fp-throw') ?? 'null')).toMatchObject({ status: 'done' });

    const second = await runFire(input(), deps(db, [arm]));
    second.commit();
    // No second lookup: the verdict came from the cache, and the piece was
    // already marked seen by the first fire before its delivery threw.
    expect(legCalls).toBe(1);
    expect(fireRows(db)[1]).toMatchObject({ reason: 'seen' });
  });
});

describe('runFire: seen', () => {
  it('the same resource on a later fire with a different fingerprint is "seen" with no emit', async () => {
    const db = await freshDb();
    let calls = 0;
    const arm: Arm = {
      id: 'seen-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => {
        calls += 1;
        return {
          question: { text: 'q', fingerprint: `fp-seen-${calls}` },
          stages: [[strongLeg('shared-resource')]],
        };
      },
      deliver: (answer) => ({ mode: 'inject', text: 'x', resourceId: answer.resourceId }),
    };
    const d = deps(db, [arm]);
    const first = await runFire(input(), d);
    first.commit();
    expect(fireRows(db)[0]).toMatchObject({ reason: 'hit' });

    const second = await runFire(input(), d);
    expect(second.emit).toBeNull();
    second.commit();
    const rows = fireRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ reason: 'seen', delivered: null });
  });
});

describe('runFire: deadline', () => {
  it('a leg that never resolves hits the deadline and releases the claim for a fresh retry', async () => {
    vi.useFakeTimers();
    const db = await freshDb();
    const clockRef = { now: NOW };
    const advance = async (ms: number): Promise<void> => {
      clockRef.now += ms;
      await vi.advanceTimersByTimeAsync(ms);
    };
    const arm: Arm = {
      id: 'deadline-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => ({
        question: { text: 'q', fingerprint: 'fp-deadline' },
        stages: [[hangingLeg()]],
      }),
    };
    const resultPromise = runFire(
      input(),
      deps(db, [arm], () => clockRef.now),
    );
    await advance(CONFIG_DEFAULTS.loop.tool_wait_ms);
    const result = await resultPromise;
    expect(result.emit).toBeNull();
    result.commit();
    expect(fireRows(db)[0]).toMatchObject({ reason: 'deadline' });

    // The abort races the leg's rejection in the background; give it a beat.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(getMark(db, LEAD, 'q:fp-deadline')).toBeNull();
    expect(claim(db, LEAD, 'fp-deadline', clockRef.now + 1, 2500)).toEqual({ kind: 'fresh' });
  });
});

describe('runFire: leg outcomes short of a hit', () => {
  it('a rejecting leg is no-answer and releases the claim', async () => {
    const db = await freshDb();
    const arm: Arm = {
      id: 'reject-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => ({
        question: { text: 'q', fingerprint: 'fp-reject' },
        stages: [[rejectingLeg()]],
      }),
    };
    const { emit, commit } = await runFire(input(), deps(db, [arm]));
    expect(emit).toBeNull();
    commit();
    expect(fireRows(db)[0]).toMatchObject({ reason: 'no-answer' });
    expect(getMark(db, LEAD, 'q:fp-reject')).toBeNull();
  });

  it('a http_429 leg is rate-server', async () => {
    const db = await freshDb();
    const arm: Arm = {
      id: 'r429-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => ({
        question: { text: 'q', fingerprint: 'fp-429' },
        stages: [[rateLimitedLeg()]],
      }),
    };
    const { commit } = await runFire(input(), deps(db, [arm]));
    commit();
    expect(fireRows(db)[0]).toMatchObject({ reason: 'rate-server' });
  });
});

describe('runFire: before() throws', () => {
  it('reason error, with the detail naming the error', async () => {
    const db = await freshDb();
    const arm: Arm = {
      id: 'throw-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      before: () => {
        throw new Error('boom');
      },
      plan: () => ({ question: { text: 'q', fingerprint: 'fp-throw' }, stages: [] }),
    };
    const { emit, commit } = await runFire(input(), deps(db, [arm]));
    expect(emit).toBeNull();
    commit();
    const row = fireRows(db)[0]!;
    expect(row.reason).toBe('error');
    // before() throws before `question` is set, so the ledger's fallback lands the detail here.
    expect(row.question).toBe('Error: boom');
  });
});

describe('runFire: after()', () => {
  it('a block from after() passes through as emit.block', async () => {
    const db = await freshDb();
    const arm: Arm = {
      id: 'block-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => null,
      after: () => ({ block: { reason: 'stop-looping' } }),
    };
    const { emit } = await runFire(input(), deps(db, [arm]));
    expect(emit).toEqual({ block: { reason: 'stop-looping' } });
  });

  it("after()'s context is appended to the delivery's context", async () => {
    const db = await freshDb();
    const arm: Arm = {
      id: 'append-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => ({
        question: { text: 'q', fingerprint: 'fp-append' },
        stages: [[strongLeg('r2')]],
      }),
      deliver: () => ({ mode: 'inject', text: 'DELIVERY' }),
      after: () => ({ context: 'AFTER' }),
    };
    const { emit } = await runFire(input(), deps(db, [arm]));
    expect(emit).toEqual({ context: 'DELIVERY\n\nAFTER' });
  });
});

describe('runFire: commit', () => {
  it('is idempotent, and nothing is recorded until it is called', async () => {
    const db = await freshDb();
    const { commit } = await runFire(input(), deps(db, []));
    expect(fireRows(db)).toHaveLength(0);
    commit();
    expect(fireRows(db)).toHaveLength(1);
    commit();
    expect(fireRows(db)).toHaveLength(1);
  });
});

describe('runFire: clientSignal', () => {
  it('an already-aborted clientSignal forces emit null and reason deadline', async () => {
    const db = await freshDb();
    const arm: Arm = {
      id: 'client-abort-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => null,
    };
    const controller = new AbortController();
    controller.abort();
    const { emit, commit } = await runFire(input(), deps(db, [arm]), controller.signal);
    expect(emit).toBeNull();
    commit();
    expect(fireRows(db)[0]).toMatchObject({ reason: 'deadline' });
  });
});

describe('runFire: phantom agent.stop', () => {
  it('a stop with no started mark returns emit null and commit writes no row', async () => {
    const db = await freshDb();
    const stop = input({ event: 'agent.stop', native: { event: 'SubagentStop' }, agent: 'child1' });
    const { emit, commit } = await runFire(stop, deps(db, []));
    expect(emit).toBeNull();
    commit();
    expect(fireRows(db)).toHaveLength(0);
  });
});
