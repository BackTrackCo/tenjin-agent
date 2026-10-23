import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../../lib/atomic-json';
import { AccountSpecSchema } from '../decision';

/**
 * A JOB ON THE USER'S ACCOUNT THAT OUTLASTED ITS CALL, kept by the offer's id
 * so `request({job})` can finish it: the spec, the merged input, and the
 * billing call's own result, which is what its follow-up reads. Resuming sends
 * only the follow-up (its status calls and the fetch of the result); the call
 * that bills is never sent again. No credential is kept here: a resume reads
 * the account's sign-in like any call.
 */

const DIR = join('progress', 'account-jobs');
/** How long a job can be picked up again after its billing call. */
export const ACCOUNT_JOB_KEEP_MS = 12 * 60 * 60_000;
/** The first result is kept whole; past this a job is not kept. */
const MAX_JOB_BYTES = 256 * 1024;

const AccountJobSchema = z.strictObject({
  version: z.literal(1),
  offerId: z.string().min(1).max(64),
  spec: AccountSpecSchema,
  input: z.record(z.string(), z.unknown()),
  first: z.unknown(),
  firstAt: z.number().int().nonnegative(),
  /** Tenjin's own route for the job, offered if this one cannot finish. */
  fallbackId: z.string().min(1).max(64).optional(),
});
export type AccountJob = z.infer<typeof AccountJobSchema>;

const pathOf = (dataDir: string, offerId: string) =>
  join(dataDir, DIR, `${createHash('sha256').update(offerId).digest('hex')}.json`);

/** Keep a job for a resume; false when it could not be kept. Never throws. */
export async function keepAccountJob(dataDir: string, job: AccountJob): Promise<boolean> {
  try {
    const text = JSON.stringify(job);
    if (Buffer.byteLength(text, 'utf8') > MAX_JOB_BYTES) return false;
    await writeFileAtomic(pathOf(dataDir, job.offerId), text, { mode: 0o600, dirMode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/** The job kept under this id, or null: none, expired, damaged or not ours. */
export async function readAccountJob(
  dataDir: string,
  offerId: string,
  now: number = Date.now(),
): Promise<AccountJob | null> {
  const file = await open(
    pathOf(dataDir, offerId),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => undefined);
  if (file === undefined) return null;
  try {
    const stat = await file.stat();
    if (stat.size > MAX_JOB_BYTES) return null;
    const parsed = AccountJobSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    if (!parsed.success || parsed.data.offerId !== offerId) return null;
    return now - parsed.data.firstAt > ACCOUNT_JOB_KEEP_MS ? null : parsed.data;
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** A job that ended: delivered, failed or past its keep time. */
export async function endAccountJob(dataDir: string, offerId: string): Promise<void> {
  await rm(pathOf(dataDir, offerId), { force: true }).catch(() => undefined);
}
