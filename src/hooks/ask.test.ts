import { describe, expect, it, vi } from 'vitest';
import type { HookInput } from '../adapters/types';
import { CONFIG_DEFAULTS, type PublicFallback } from '../lib/config';
import { RESERVE_MS } from './constants';
import { ask } from './ask';
import type { LoopDb } from './store';
import type {
  Answer,
  FireClock,
  FireContext,
  KernelConfig,
  Leg,
  LegResult,
  Plan,
  Question,
  Shelf,
  Strength,
} from './types';

/**
 * `ask` runs a plan of fake legs against a hand-built `FireContext`: no store,
 * no server, no daemon. What is under test is the orchestration in ask.ts
 * (stage order, the short-circuit, shelf ranking, the fire clock), never a
 * real leg's HTTP behavior.
 */

const QUESTION: Question = { text: 'why is vitest slow', questionKey: 'qk1' };

function input(): HookInput {
  return {
    harness: 'claude',
    event: 'prompt',
    native: { event: 'UserPromptSubmit' },
    session: 's1',
    cwd: '/tmp/proj',
    raw: {},
  };
}

function config(publicFallback: PublicFallback): KernelConfig {
  return {
    hooks: CONFIG_DEFAULTS.hooks,
    loop: CONFIG_DEFAULTS.loop,
    team: { publicFallback },
  };
}

function plan(stages: Leg[][]): Plan {
  return { question: QUESTION, stages };
}

function mkAnswer(shelf: Shelf, strength: Strength, over: Partial<Answer> = {}): Answer {
  return { shelf, strength, resourceId: `${shelf}-${strength}`, ...over };
}

/** Builds a FireContext by hand. `remaining` defaults to a fixed 10s budget;
 *  pass one to shrink or vary what the fire clock reports. */
function context(
  opts: {
    remainingMs?: number;
    remaining?: () => number;
    signal?: AbortSignal;
    publicFallback?: PublicFallback;
  } = {},
): FireContext {
  const remaining = opts.remaining ?? (() => opts.remainingMs ?? 10_000);
  const fire: FireClock = {
    id: 'f1',
    startedAt: 0,
    deadlineMs: 10_000,
    remaining,
    signal: opts.signal ?? new AbortController().signal,
    legs: [],
  };
  return {
    actor: { session: 's1', agent: '' },
    input: input(),
    arm: { id: 'prompt', wait: 'human', on: [{ event: 'prompt' }] },
    fire,
    deps: {
      db: {} as LoopDb, // ask never touches the db
      config: () => config(opts.publicFallback ?? 'on'),
      clock: () => 0,
      log: () => undefined,
      arms: [],
      adapters: {},
    },
  };
}

interface FakeLeg extends Leg {
  requestSpy: ReturnType<typeof vi.fn>;
  verdictSpy: ReturnType<typeof vi.fn>;
}

function makeLeg(
  shelf: Shelf,
  requestImpl: (budgetMs: number, signal: AbortSignal) => Promise<LegResult>,
  verdictImpl: (r: LegResult) => Answer | null = () => null,
): FakeLeg {
  const requestSpy = vi.fn((_q: Question, budgetMs: number, signal: AbortSignal) =>
    requestImpl(budgetMs, signal),
  );
  const verdictSpy = vi.fn(verdictImpl);
  return { shelf, request: requestSpy, verdict: verdictSpy, requestSpy, verdictSpy };
}

/** A leg that resolves 'ok' immediately with the given extra fields and verdict. */
function okLeg(
  shelf: Shelf,
  extra: Partial<Omit<LegResult, 'status'>>,
  ans: Answer | null,
): FakeLeg {
  return makeLeg(
    shelf,
    async () => ({ status: 'ok', ...extra }),
    () => ans,
  );
}

function rejectingLeg(shelf: Shelf, err: unknown): FakeLeg {
  return makeLeg(shelf, async () => {
    throw err;
  });
}

/** A leg that never resolves on its own — it only settles when its signal
 *  aborts, rejecting with the signal's reason the way `fetch` would. */
function signalAwareLeg(shelf: Shelf): FakeLeg {
  return makeLeg(
    shelf,
    (_budgetMs, signal) =>
      new Promise<LegResult>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
}

describe('ask: stage progression', () => {
  it('a strong verdict in stage 1 stops the plan; stage 2 legs never run', async () => {
    const strongAns = mkAnswer('team', 'strong');
    const stage1 = okLeg('team', {}, strongAns);
    const stage2 = okLeg('public', {}, mkAnswer('public', 'strong'));
    const result = await ask(context(), plan([[stage1], [stage2]]));
    expect(result.answer).toEqual(strongAns);
    expect(stage2.requestSpy).not.toHaveBeenCalled();
  });

  it('a strong verdict in a later stage beats an earlier weak one; the weak row is shadowed', async () => {
    const weakAns = mkAnswer('keys', 'weak');
    const strongAns = mkAnswer('team', 'strong');
    const weak = okLeg('keys', {}, weakAns);
    const strong = okLeg('team', {}, strongAns);
    const result = await ask(context(), plan([[weak], [strong]]));
    expect(result.answer).toEqual(strongAns);
    expect(result.legs[0]).toMatchObject({ shelf: 'keys', outcome: 'shadowed' });
    expect(result.legs[1]).toMatchObject({ shelf: 'team', outcome: 'hit' });
  });

  it('team strong beats public strong within one stage, regardless of leg order', async () => {
    const teamAns = mkAnswer('team', 'strong');
    const publicAns = mkAnswer('public', 'strong');
    const team = okLeg('team', {}, teamAns);
    const pub = okLeg('public', {}, publicAns);
    const result = await ask(context(), plan([[pub, team]]));
    expect(result.answer).toEqual(teamAns);
  });

  it('among weak answers the best shelf rank wins, only after every stage has run', async () => {
    const keysAns = mkAnswer('keys', 'weak');
    const publicAns = mkAnswer('public', 'weak');
    const teamAns = mkAnswer('team', 'weak');
    const s1 = okLeg('keys', {}, keysAns);
    const s2 = okLeg('public', {}, publicAns);
    const s3 = okLeg('team', {}, teamAns);
    const result = await ask(context(), plan([[s1], [s2], [s3]]));
    // No stage was strong, so nothing short-circuits: every stage ran.
    expect(s1.requestSpy).toHaveBeenCalledTimes(1);
    expect(s2.requestSpy).toHaveBeenCalledTimes(1);
    expect(s3.requestSpy).toHaveBeenCalledTimes(1);
    expect(result.answer).toEqual(teamAns);
  });
});

describe('ask: team.publicFallback off', () => {
  it('drops a stage whose legs are all public but keeps a mixed stage', async () => {
    const dropped = makeLeg('public', async () => {
      throw new Error('must not run: stage was all-public');
    });
    const teamAns = mkAnswer('team', 'weak');
    const mixedPublic = okLeg('public', {}, null);
    const mixedTeam = okLeg('team', {}, teamAns);
    const result = await ask(
      context({ publicFallback: 'off' }),
      plan([[dropped], [mixedPublic, mixedTeam]]),
    );
    expect(dropped.requestSpy).not.toHaveBeenCalled();
    expect(mixedPublic.requestSpy).toHaveBeenCalledTimes(1);
    expect(mixedTeam.requestSpy).toHaveBeenCalledTimes(1);
    expect(result.answer).toEqual(teamAns);
    // The dropped stage is filtered out before numbering, so the surviving
    // stage's rows are stage 0, not stage 1.
    expect(result.legs.every((row) => row.stage === 0)).toBe(true);
  });
});

describe('ask: leg failure modes', () => {
  it('a leg that only settles on abort times out when the fire clock runs out', async () => {
    const slow = signalAwareLeg('team');
    const result = await ask(context({ remainingMs: RESERVE_MS + 20 }), plan([[slow]]));
    expect(result.legs[0]).toMatchObject({
      shelf: 'team',
      status: 'timeout',
      outcome: 'no-answer',
      elapsed_ms: 0,
    });
    expect(result.answer).toBeNull();
  });

  it('aborting the fire signal marks the leg aborted, not timeout', async () => {
    const controller = new AbortController();
    const slow = signalAwareLeg('team');
    const resultPromise = ask(
      context({ signal: controller.signal, remainingMs: 10_000 }),
      plan([[slow]]),
    );
    controller.abort();
    const result = await resultPromise;
    expect(result.legs[0]).toMatchObject({ status: 'aborted', outcome: 'no-answer' });
  });

  it('a leg that rejects with a plain Error is recorded as error', async () => {
    const failing = rejectingLeg('team', new Error('boom'));
    const result = await ask(context(), plan([[failing]]));
    expect(result.legs[0]).toMatchObject({ status: 'error', outcome: 'no-answer' });
    expect(result.answer).toBeNull();
  });

  it('a non-ok result never calls verdict and is recorded as no-answer', async () => {
    const refused = makeLeg(
      'team',
      async () => ({ status: 'refused' }),
      () => mkAnswer('team', 'strong'),
    );
    const result = await ask(context(), plan([[refused]]));
    expect(refused.verdictSpy).not.toHaveBeenCalled();
    expect(result.legs[0]).toMatchObject({ status: 'refused', outcome: 'no-answer' });
    expect(result.answer).toBeNull();
  });
});

describe('ask: budget', () => {
  it('passes remaining() - RESERVE_MS as budgetMs, computed once at stage start', async () => {
    const remainingMs = 3000;
    const leg1 = okLeg('team', {}, null);
    await ask(context({ remainingMs }), plan([[leg1]]));
    expect(leg1.requestSpy).toHaveBeenCalledWith(
      expect.anything(),
      remainingMs - RESERVE_MS,
      expect.anything(),
    );
  });

  it('when remaining() <= RESERVE_MS, legs are never called and rows are timeout at 0ms', async () => {
    const a = okLeg('team', {}, null);
    const b = okLeg('public', {}, null);
    const result = await ask(context({ remainingMs: RESERVE_MS }), plan([[a, b]]));
    expect(a.requestSpy).not.toHaveBeenCalled();
    expect(b.requestSpy).not.toHaveBeenCalled();
    expect(result.legs).toEqual([
      { stage: 0, shelf: 'team', status: 'timeout', outcome: 'no-answer', elapsed_ms: 0 },
      { stage: 0, shelf: 'public', status: 'timeout', outcome: 'no-answer', elapsed_ms: 0 },
    ]);
  });
});

describe('ask: rows', () => {
  it('rows land on fire.legs and carry search_id/title/url/form from the LegResult', async () => {
    const ctx = context();
    const withFields = okLeg(
      'team',
      {
        searchId: 'sid1',
        title: 'ryuk serializes testcontainers',
        url: 'https://x/1',
        form: 'search',
      },
      mkAnswer('team', 'weak'),
    );
    const result = await ask(ctx, plan([[withFields]]));
    expect(result.legs[0]).toEqual({
      stage: 0,
      shelf: 'team',
      status: 'ok',
      outcome: 'hit',
      elapsed_ms: 0,
      search_id: 'sid1',
      title: 'ryuk serializes testcontainers',
      url: 'https://x/1',
      form: 'search',
    });
    expect(ctx.fire.legs).toEqual(result.legs);
  });
});
