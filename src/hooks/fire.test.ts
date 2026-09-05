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
  baseUrl: CONFIG_DEFAULTS.baseUrl,
  publicShelfUrl: CONFIG_DEFAULTS.publicShelfUrl,
  shelfBypassSecret: CONFIG_DEFAULTS.shelfBypassSecret,
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
  error: string | null;
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
    verdict: (): Answer => ({ shelf: 'team', resourceId }),
  };
}

/** A leg the shelf answered, with candidates and nothing marked `strong`: the
 *  row carries what was offered and the verdict is still a miss. */
function unvouchedLeg(): Leg {
  return {
    shelf: 'team',
    request: async (): Promise<LegResult> => ({
      status: 'ok',
      searchId: 'sid-weak',
      title: 'Something adjacent',
      url: 'https://shelf.acme.internal/p/adjacent',
      form: 'finding',
      calibration: 'lexical-v1',
    }),
    verdict: () => null,
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

describe('runFire: a skip', () => {
  it("records the skip's reason and stamps the row with the text it refused", async () => {
    const db = await freshDb();
    const arm: Arm = {
      id: 'prompt',
      wait: 'human',
      on: [{ event: 'prompt' }],
      plan: () => ({ reason: 'short', text: 'yes' }),
    };
    const { emit, commit } = await runFire(input(), deps(db, [arm]));
    expect(emit).toBeNull();
    commit();

    const rows = fireRows(db);
    expect(rows).toHaveLength(1);
    // The text is what the importance score reads off a "/clear" or a "yes";
    // a null plan would have lost it (reason `no-question`, question null).
    expect(rows[0]).toMatchObject({ arm: 'prompt', reason: 'short', question: 'yes' });
    // A skip is not a lookup: no gate ran, no leg ran.
    expect(legRows(db, rows[0]!.id)).toEqual([]);
    expect(getMark(db, LEAD, 'q:yes')).toBeNull();
  });

  it.each(['short', 'long', 'slash', 'words'] as const)('%s lands as its own reason', async (r) => {
    const db = await freshDb();
    const arm: Arm = {
      id: 'prompt',
      wait: 'human',
      on: [{ event: 'prompt' }],
      plan: () => ({ reason: r, text: `text for ${r}` }),
    };
    const { commit } = await runFire(input(), deps(db, [arm]));
    commit();
    expect(fireRows(db)[0]).toMatchObject({ reason: r, question: `text for ${r}` });
  });
});

describe('runFire: no client-side rate limit', () => {
  it("runs its legs on the fires B's bucket (3/min, burst 6) would have refused", async () => {
    // A research subagent fires 15 to 18 web lookups a minute at peak, so the
    // tenth fire of a burst is exactly the one that must still reach a shelf
    // (09-pr-c-lookup-arms.md, review round 2).
    const db = await freshDb();
    let calls = 0;
    const arm: Arm = {
      id: 'research',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => {
        calls += 1;
        return {
          question: { text: `q${calls}`, questionKey: `qk-burst-${calls}` },
          stages: [[strongLeg(`res-${calls}`)]],
        };
      },
      deliver: (answer) => ({ mode: 'inject', text: 'x', resourceId: answer.resourceId }),
    };
    const d = deps(db, [arm]);
    for (let i = 0; i < 12; i += 1) (await runFire(input(), d)).commit();

    const rows = fireRows(db);
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.reason)).toEqual(Array<string>(12).fill('hit'));
    expect(rows.every((r) => legRows(db, r.id).length === 1)).toBe(true);
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
        question: { text: 'why is vitest slow', questionKey: 'qk-hit' },
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
    expect(JSON.parse(getMark(db, LEAD, 'q:qk-hit') ?? 'null')).toMatchObject({ status: 'done' });
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
        question: { text: 'q', questionKey: 'qk-throw' },
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
    expect(JSON.parse(getMark(db, LEAD, 'q:qk-throw') ?? 'null')).toMatchObject({ status: 'done' });

    const second = await runFire(input(), deps(db, [arm]));
    second.commit();
    // No second lookup: the verdict came from the cache. And the piece is still
    // deliverable, because a delivery that threw showed the agent nothing and so
    // never burned the once-per-piece mark.
    expect(legCalls).toBe(1);
    expect(fireRows(db)[1]).toMatchObject({ reason: 'cached', delivered: 'inject:res-x' });
  });
});

describe('runFire: seen', () => {
  it('the same resource on a later fire with a different question key is "seen" with no emit', async () => {
    const db = await freshDb();
    let calls = 0;
    const arm: Arm = {
      id: 'seen-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => {
        calls += 1;
        return {
          question: { text: 'q', questionKey: `qk-seen-${calls}` },
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

describe('runFire: once-per-piece is about what was SHOWN', () => {
  it('a log-only arm does not burn the mark, so an inject arm still delivers the piece', async () => {
    // The context arm looks things up to earn a precision number and says
    // nothing. Burning `seen:` there would let a silent lookup silence the
    // injection a prompt asks for a second later (00-principles.md, 4).
    const db = await freshDb();
    const logged: Arm = {
      id: 'context',
      wait: 'tool',
      on: [{ event: 'tool.before', kind: 'edit' }],
      plan: () => ({
        question: { text: 'q', questionKey: 'qk-log' },
        stages: [[strongLeg('res-shared')]],
      }),
      deliver: (answer) => ({ mode: 'log', resourceId: answer.resourceId }),
    };
    const injects: Arm = {
      id: 'prompt',
      wait: 'human',
      on: [{ event: 'prompt' }],
      plan: () => ({
        question: { text: 'q2', questionKey: 'qk-inject' },
        stages: [[strongLeg('res-shared')]],
      }),
      deliver: (answer) => ({ mode: 'inject', text: 'the finding', resourceId: answer.resourceId }),
    };
    const d = deps(db, [logged, injects]);
    const first = await runFire(
      input({ event: 'tool.before', tool: { name: 'Edit', kind: 'edit', input: {} } }),
      d,
    );
    first.commit();
    expect(fireRows(db)[0]).toMatchObject({
      arm: 'context',
      reason: 'hit',
      delivered: 'log:res-shared',
    });
    expect(getMark(db, LEAD, 'seen:res-shared')).toBeNull();

    const second = await runFire(input(), d);
    expect(second.emit).toEqual({ context: 'the finding' });
    second.commit();
    expect(fireRows(db)[1]).toMatchObject({ arm: 'prompt', reason: 'hit' });
    // And the injection DID burn it: a second prompt gets `seen`.
    expect(getMark(db, LEAD, 'seen:res-shared')).not.toBeNull();
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
        question: { text: 'q', questionKey: 'qk-deadline' },
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
    expect(getMark(db, LEAD, 'q:qk-deadline')).toBeNull();
    expect(claim(db, LEAD, 'qk-deadline', clockRef.now + 1, 2500)).toEqual({ kind: 'fresh' });
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
        question: { text: 'q', questionKey: 'qk-reject' },
        stages: [[rejectingLeg()]],
      }),
    };
    const { emit, commit } = await runFire(input(), deps(db, [arm]));
    expect(emit).toBeNull();
    commit();
    expect(fireRows(db)[0]).toMatchObject({ reason: 'no-answer' });
    expect(getMark(db, LEAD, 'q:qk-reject')).toBeNull();
  });

  it('candidates the shelf vouched for none of are no-hit, and nothing is emitted', async () => {
    // The client has no quality rule of its own, so a shelf that marked nothing
    // `strong` has said nothing: the leg is a definite miss, not an outage, and
    // the row keeps what the shelf offered.
    const db = await freshDb();
    let delivered = 0;
    const arm: Arm = {
      id: 'no-vouch-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => ({
        question: { text: 'q', questionKey: 'qk-no-vouch' },
        stages: [[unvouchedLeg()]],
      }),
      deliver: () => {
        delivered += 1;
        return { mode: 'inject', text: 'never', resourceId: 'nope' };
      },
    };
    const { emit, commit } = await runFire(input(), deps(db, [arm]));
    expect(emit).toBeNull();
    commit();
    const rows = fireRows(db);
    expect(rows[0]).toMatchObject({ reason: 'no-hit', delivered: null });
    expect(delivered).toBe(0);
    expect(legRows(db, rows[0]!.id)).toEqual([{ shelf: 'team', status: 'ok', outcome: 'miss' }]);
    // A definite miss is a verdict worth caching: the same question does not
    // pay for the same nothing twice.
    expect(JSON.parse(getMark(db, LEAD, 'q:qk-no-vouch') ?? 'null')).toMatchObject({
      status: 'done',
    });
  });

  it('a http_429 leg is rate-server', async () => {
    const db = await freshDb();
    const arm: Arm = {
      id: 'r429-arm',
      wait: 'tool',
      on: [{ event: 'prompt' }],
      plan: () => ({
        question: { text: 'q', questionKey: 'qk-429' },
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
      plan: () => ({ question: { text: 'q', questionKey: 'qk-throw' }, stages: [] }),
    };
    const { emit, commit } = await runFire(input(), deps(db, [arm]));
    expect(emit).toBeNull();
    commit();
    const row = fireRows(db)[0]!;
    expect(row.reason).toBe('error');
    // The class and message land in `error`, whether or not the fire had got as
    // far as a question.
    expect(row.error).toBe('Error: boom');
    expect(row.question).toBeNull();
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
        question: { text: 'q', questionKey: 'qk-append' },
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
