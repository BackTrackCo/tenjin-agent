import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { withHeldLock } from '../lib/held-lock';
import { sleepFor } from './model-worker-control';
import { readJsonFile, writePrivate } from './store-files';

/**
 * THE ROUTER'S CALL RATE FOR ONE WALLET, and this machine's count against it. The router
 * allows a wallet a number of model calls per window, over all its jobs and processes, and
 * counts a call at the unpaid quote, where a refusal costs nothing. Every process counts
 * the quotes it sends in one file under the data folder, and a call waits there for room
 * before it asks for its quote. The offer always names the rate.
 */
export type ModelCallLimit = { max: number; windowMs: number };

/** The offer's own schema field. */
export const callLimitSchema = z.object({
  max: z.number().int().min(1).max(100_000),
  windowSeconds: z.number().min(1).max(600),
});

/** The rate a job's offer names. An offer that names none is invalid. */
export function advertisedCallLimit(decision: Record<string, unknown>): ModelCallLimit {
  const said = callLimitSchema.parse(decision.callLimit);
  return { max: said.max, windowMs: Math.round(said.windowSeconds * 1000) };
}

const CELLS = 60;
/** Room kept free: this send, and one a difference between clocks could move across a window. */
const SPARE = 2;
const STEP_MS = 250;

/**
 * Whether one more send at `at` stays inside the router's limit, whatever instant its
 * windows start at. The router counts a sliding window as the current fixed window's
 * sends plus the previous window's, weighted by how much of the previous window the
 * sliding one still covers. That estimate can pass the limit after a burst although no
 * 60 s span holds more than the limit, so a plain count of the last window is not enough.
 * Its window boundaries follow its own clock: this takes the worst over every boundary,
 * in 60 steps, each step's bound at least the estimate of every boundary inside it.
 */
function fits(times: readonly number[], at: number, limit: ModelCallLimit): boolean {
  for (let cell = 0; cell < CELLS; cell++) {
    const start = at - (limit.windowMs * (cell + 1)) / CELLS;
    let current = 0;
    let previous = 0;
    for (const time of times) {
      if (time > start) current++;
      else if (time > start - limit.windowMs) previous++;
    }
    if (current + (1 - cell / CELLS) * previous > limit.max - SPARE) return false;
  }
  return true;
}

/** How long from `now` until one more send fits: 0 when it fits now. */
export function paceDelayMs(times: readonly number[], now: number, limit: ModelCallLimit): number {
  for (let wait = 0; wait < 2 * limit.windowMs; wait += STEP_MS)
    if (fits(times, now + wait, limit)) return wait;
  return 2 * limit.windowMs;
}

const logSchema = z.object({
  v: z.literal(1),
  sent: z.array(z.number()).max(20_000),
});
/** The longest window a router may advertise, twice: what one estimate can look back on. */
const KEPT_MS = 2 * 600_000;

export type PaceClock = {
  now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
};

export class ModelPace {
  private readonly path: string;
  constructor(
    private readonly dataDir: string,
    origin: string,
    private readonly clock: PaceClock = { now: Date.now, wait: sleepFor },
  ) {
    const id = createHash('sha256')
      .update(JSON.stringify(['tenjin-model-pace', 1, new URL(origin).origin]))
      .digest('hex');
    this.path = join(dataDir, 'model-jobs', `${id}.pace.json`);
  }

  /** Reads the count, lets `act` decide and add to it, and keeps what is still in reach. */
  private async update<T>(
    signal: AbortSignal | undefined,
    act: (sent: number[], now: number) => T,
  ): Promise<T> {
    await mkdir(join(this.dataDir, 'model-jobs'), { recursive: true, mode: 0o700 });
    // THE PACE LOCK protects one read-check-append of the wallet's call log (milliseconds), so
    // the check and the count are one step across processes. It waits up to 5 s; after that
    // `take` lets the call go unpaced.
    return withHeldLock(
      `${this.path}.lock`,
      async () => {
        const kept = logSchema.safeParse(await readJsonFile(this.path, 2_000_000));
        const now = this.clock.now();
        const sent = (kept.success ? kept.data.sent : []).filter((time) => time > now - KEPT_MS);
        const before = sent.length;
        const result = act(sent, now);
        if (sent.length !== before)
          await writePrivate(this.path, JSON.stringify({ v: 1, sent: sent.slice(-20_000) }));
        return result;
      },
      signal ? { signal } : {},
    );
  }

  /**
   * Waits until one more unpaid quote fits `limit`, counts it, and says how long it waited.
   * The check and the count are one step across processes. A count that cannot be read or
   * written holds nothing up: the call goes on unpaced, as it did before there was a count.
   * A cancel during the wait throws.
   */
  async take(limit: ModelCallLimit, signal: AbortSignal): Promise<number> {
    let waited = 0;
    for (;;) {
      signal.throwIfAborted();
      let delay: number;
      try {
        delay = await this.update(signal, (sent, now) => {
          const wait = paceDelayMs(sent, now, limit);
          if (wait === 0) sent.push(now);
          return wait;
        });
      } catch (error) {
        if (signal.aborted) throw error;
        return waited;
      }
      if (delay === 0) return waited;
      await this.clock.wait(delay, signal);
      waited += delay;
    }
  }
}
