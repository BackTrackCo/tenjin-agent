import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { advertisedCallLimit, ModelPace, paceDelayMs, type ModelCallLimit } from './model-pace';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function folder() {
  const dir = await mkdtemp(join(tmpdir(), 'model-pace-'));
  made.push(dir);
  return dir;
}
const ORIGIN = 'https://tenjin.example';

/**
 * The router's own check, as its rate limiter makes it: the current fixed window's count
 * plus the previous window's, weighted by the share of it the sliding window still
 * covers. `offset` is where its windows start against this machine's clock.
 */
function routerAllows(sent: readonly number[], at: number, limit: ModelCallLimit, offset: number) {
  const window = Math.floor((at + offset) / limit.windowMs);
  let current = 0;
  let previous = 0;
  for (const time of sent) {
    const its = Math.floor((time + offset) / limit.windowMs);
    if (its === window) current++;
    else if (its === window - 1) previous++;
  }
  const share = ((at + offset) % limit.windowMs) / limit.windowMs;
  return Math.floor((1 - share) * previous) + current < limit.max;
}

function clock(start = 1_000_000) {
  const state = { now: start, waits: [] as number[] };
  return {
    state,
    now: () => state.now,
    wait: async (ms: number) => {
      state.waits.push(ms);
      state.now += ms;
    },
  };
}

// A quote over the advertised rate is refused before anything is signed. A plain count of
// the last 60 s is refused by the router's weighted estimate after a burst. The rule is
// driven here with no clock and no file: each send happens at the instant the rule gives.
it.each([
  { max: 30, windowMs: 60_000 },
  { max: 120, windowMs: 60_000 },
])(
  'never sends what the router would refuse at $max per window, in bursts or steadily, wherever its windows start',
  (limit) => {
    let now = 1_000_000;
    const sent: number[] = [];
    let held = 0;
    let refused = 0;
    const send = () => {
      // What the count keeps in reach of one estimate.
      const recent = sent.filter((time) => time > now - 2 * limit.windowMs);
      const wait = paceDelayMs(recent, now, limit);
      if (wait > 0) held++;
      now += wait;
      for (let offset = 0; offset < limit.windowMs; offset += 5_000)
        if (!routerAllows(recent, now, limit, offset)) refused++;
      sent.push(now);
    };
    // A sender that always has a call ready: it is held back, and not far below the rate.
    for (let n = 0; n < limit.max * 2; n++) send();
    expect(held).toBeGreaterThan(0);
    const minutes = (sent.at(-1)! - sent[0]!) / limit.windowMs;
    expect(sent.length / minutes).toBeGreaterThan(limit.max * 0.8);
    // Calls a few seconds apart, then a burst again.
    for (let n = 0; n < limit.max * 2; n++) {
      now += n < limit.max ? 3_700 : 0;
      send();
    }
    expect(refused).toBe(0);
  },
);

it('counts every process of the wallet together', async () => {
  const dir = await folder();
  const time = clock();
  const signal = new AbortController().signal;
  const [one, two] = [new ModelPace(dir, ORIGIN, time), new ModelPace(dir, ORIGIN, time)];
  const limit = { max: 6, windowMs: 60_000 };
  // Two processes' quotes fill the room one window has, less the spare two.
  for (const pace of [one, two, one, two, one]) expect(await pace.take(limit, signal)).toBe(0);
  expect(time.state.waits).toEqual([]);
  expect(await two.take(limit, signal)).toBeGreaterThan(0);
  // Another router's wallet count is its own.
  expect(await new ModelPace(dir, 'https://other.example', time).take(limit, signal)).toBe(0);
});

it('stops waiting at a cancel, and holds nothing up when its count cannot be read', async () => {
  const dir = await folder();
  const stop = new AbortController();
  const reason = new Error('cancelled');
  const pace = new ModelPace(dir, ORIGIN, {
    now: () => 5_000,
    wait: async () => {
      stop.abort(reason);
      throw reason;
    },
  });
  const limit = { max: 3, windowMs: 60_000 };
  expect(await pace.take(limit, stop.signal)).toBe(0);
  expect(await pace.take(limit, stop.signal)).toBe(0);
  await expect(pace.take(limit, stop.signal)).rejects.toBe(reason);
  // A damaged count reads as empty, and a count that cannot be written is no refusal.
  const broken = await folder();
  await mkdir(join(broken, 'model-jobs'));
  const free = new ModelPace(broken, ORIGIN, clock());
  expect(await free.take(limit, new AbortController().signal)).toBe(0);
  const [file] = readdirSync(join(broken, 'model-jobs')).filter((name) => name.endsWith('.json'));
  await writeFile(join(broken, 'model-jobs', file!), '{"v":1,"sent":"PRIVATE"');
  expect(await free.take(limit, new AbortController().signal)).toBe(0);
});

it('reads the rate an offer names, and refuses an offer that names none', () => {
  expect(advertisedCallLimit({ callLimit: { max: 120, windowSeconds: 60 } })).toEqual({
    max: 120,
    windowMs: 60_000,
  });
  for (const callLimit of [undefined, null, 120, { max: 0, windowSeconds: 60 }, { max: 120 }])
    expect(() => advertisedCallLimit({ callLimit })).toThrow();
  expect(paceDelayMs([], 0, { max: 30, windowMs: 60_000 })).toBe(0);
});
