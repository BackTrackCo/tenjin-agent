import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AccountSpecSchema } from '../decision';
import { readJsonFile, writePrivate } from '../store-files';

/**
 * A JOB ON THE USER'S ACCOUNT THAT OUTLASTED ITS CALL, kept by the offer's id
 * so `request({job})` can finish it: the spec, the merged input, and the
 * billing call's own result, which is what its follow-up reads. Resuming sends
 * only the follow-up (its status calls and the fetch of the result); the call
 * that bills is never sent again. No credential is kept here: a resume reads
 * the account's sign-in like any call, and only while the account is still
 * connected here; a rule saved since does not stop it, since its billing call
 * already went out (`run.ts`).
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
});
export type AccountJob = z.infer<typeof AccountJobSchema>;

const pathOf = (dataDir: string, offerId: string) =>
  join(dataDir, DIR, `${createHash('sha256').update(offerId).digest('hex')}.json`);

/** Keep a job for a resume; false when it could not be kept. Never throws. */
export async function keepAccountJob(dataDir: string, job: AccountJob): Promise<boolean> {
  try {
    const text = JSON.stringify(job);
    if (Buffer.byteLength(text, 'utf8') > MAX_JOB_BYTES) return false;
    await writePrivate(pathOf(dataDir, job.offerId), text);
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
  const parsed = AccountJobSchema.safeParse(
    await readJsonFile(pathOf(dataDir, offerId), MAX_JOB_BYTES),
  );
  if (!parsed.success || parsed.data.offerId !== offerId) return null;
  return now - parsed.data.firstAt > ACCOUNT_JOB_KEEP_MS ? null : parsed.data;
}

/** A job that ended: delivered, failed or past its keep time. */
export async function endAccountJob(dataDir: string, offerId: string): Promise<void> {
  await rm(pathOf(dataDir, offerId), { force: true }).catch(() => undefined);
}
