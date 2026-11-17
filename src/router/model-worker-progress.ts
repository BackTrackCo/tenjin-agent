import { createHash } from 'node:crypto';
import { lstat, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { activityAnswer, type ModelWorkerActivity } from './model-worker-activity';
import { writePrivate } from './store-files';

/**
 * THE LIVE WORKER ROW'S EVIDENCE: a running DeepSeek worker's display
 * activity, written by this MCP server process for the plugin to read with
 * `$.fs` while the accept call is still in flight. The plugin then needs no
 * second MCP call on the connection that call holds open.
 *
 * DISPLAY ONLY. It holds the same bounded, redacted projection
 * `subagent_activity` answers, never execution, payment or continuation
 * authority, and every failure is swallowed: a lost file is a row with no
 * counts, never a changed worker result. It sits beside the per-session
 * `progress/<hash>` directories, outside their 4 KB and ten-minute prune,
 * because a worker outlives both. The file is removed when the job ends.
 */
const DIRECTORY = join('progress', 'model-workers');
/** The rows the viewer draws; the rest are counted as dropped. */
const ROWS = 128;
const TICK_MS = 1000;
/** A file a crashed run left behind goes once it is this old. */
const STALE_MS = 24 * 60 * 60_000;
const MAX_SCAN = 256;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Where the plugin finds one offer's worker activity in one parent session. */
export function workerProgressPath(
  dataDir: string,
  parentSessionId: string,
  offerId: string,
): string {
  return join(dataDir, DIRECTORY, `${digest(parentSessionId)}-${digest(offerId)}.json`);
}

/**
 * Writes the activity whenever it has changed, once a tick, after reading what
 * has settled so far from `spend` (the job's own accounting, read only).
 * `stop` ends the ticks, waits for one in flight and removes the file.
 */
export function startWorkerProgress(options: {
  dataDir: string;
  parentSessionId: string;
  offerId: string;
  activity: Pick<ModelWorkerActivity, 'snapshot' | 'spending'>;
  spend: () => Promise<unknown>;
  tickMs?: number;
  now?: () => number;
}): { stop: () => Promise<void> } {
  const path = workerProgressPath(options.dataDir, options.parentSessionId, options.offerId);
  let written: number | undefined;
  let stopped = false;
  let ticking: Promise<void> | undefined;
  const tick = async () => {
    try {
      const spend = await options.spend().catch(() => undefined);
      if (stopped) return;
      options.activity.spending(spend);
      const snapshot = options.activity.snapshot();
      if (snapshot.sequence === written) return;
      await writePrivate(
        path,
        JSON.stringify(activityAnswer(snapshot, { rows: true, maxRows: ROWS })),
      );
      written = snapshot.sequence;
    } catch {
      // The row loses its counts; the worker and its result do not change.
    }
  };
  const run = () => {
    if (stopped || ticking) return;
    ticking = tick().finally(() => {
      ticking = undefined;
    });
  };
  void pruneWorkerProgress(join(options.dataDir, DIRECTORY), (options.now ?? Date.now)());
  run();
  const timer = setInterval(run, options.tickMs ?? TICK_MS);
  timer.unref();
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await ticking?.catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
    },
  };
}

/** Removes files older than a day that a crashed run left. Housekeeping only. */
export async function pruneWorkerProgress(directory: string, now: number): Promise<void> {
  try {
    const entries = await opendir(directory);
    let seen = 0;
    for await (const entry of entries) {
      if (++seen > MAX_SCAN) return;
      if (!entry.isFile() || !/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const stat = await lstat(path).catch(() => null);
      if (stat && now - stat.mtimeMs > STALE_MS) await rm(path, { force: true }).catch(() => {});
    }
  } catch {
    // No directory yet, or not readable: nothing to tidy.
  }
}
