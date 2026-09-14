import { mergeDefaults } from '../merge.ts';

/**
 * The job runner.
 *
 * Jobs are plain functions with an id. The runner retries a failing job up to
 * `retries` extra attempts and reports one result per job, in the order the
 * jobs were given.
 */
export interface Job {
  id: string;
  kind: string;
  accountId: string | null;
  run: () => void | Promise<void>;
}

export interface JobOptions {
  /** Extra attempts after the first one. */
  retries: number;
  /** Stop the whole run at the first job that ends up failing. */
  stopOnError: boolean;
  /** Pause between attempts. */
  backoffMs: number;
}

export interface JobResult {
  id: string;
  kind: string;
  status: 'succeeded' | 'failed' | 'skipped';
  attempts: number;
  error: string | null;
}

export const DEFAULT_JOB_OPTIONS: JobOptions = {
  retries: 1,
  stopOnError: false,
  backoffMs: 0,
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pause(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run every job and return one result each. */
export async function runJobs(
  jobs: readonly Job[],
  options: Partial<JobOptions> = {},
): Promise<JobResult[]> {
  const opts = mergeDefaults(DEFAULT_JOB_OPTIONS, options);
  const results: JobResult[] = [];
  let stopped = false;

  for (const job of jobs) {
    if (stopped) {
      results.push({ id: job.id, kind: job.kind, status: 'skipped', attempts: 0, error: null });
      continue;
    }

    let attempts = 0;
    let lastError: string | null = null;
    let ok = false;

    while (attempts <= opts.retries) {
      attempts += 1;
      try {
        await job.run();
        ok = true;
        break;
      } catch (error) {
        lastError = messageOf(error);
        if (attempts <= opts.retries) {
          await pause(opts.backoffMs);
        }
      }
    }

    results.push({
      id: job.id,
      kind: job.kind,
      status: ok ? 'succeeded' : 'failed',
      attempts,
      error: ok ? null : lastError,
    });

    if (!ok && opts.stopOnError) {
      stopped = true;
    }
  }

  return results;
}

/** How many of the results ended each way. */
export function tallyResults(results: readonly JobResult[]): Record<string, number> {
  const tally: Record<string, number> = { succeeded: 0, failed: 0, skipped: 0 };
  for (const result of results) {
    tally[result.status] = (tally[result.status] ?? 0) + 1;
  }
  return tally;
}
