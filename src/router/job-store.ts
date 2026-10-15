import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../lib/atomic-json';
import { withFileLock } from '../lib/lock';
import { jobsDir } from '../lib/paths';
import { JobSchema } from './decision';

/**
 * A PAID CALL WHOSE SELLER WAS STILL WORKING, kept on this machine so any later
 * process can finish it. One file per take, `~/.tenjin/jobs/<sha256(offerId)>.<take>.json`:
 * where to poll and how, until when, what it cost, and how it ended. Everything
 * a resume needs rides in the record, because the offer's spec is kept for
 * fifteen minutes and a job for up to two days.
 *
 * THE PAYMENT HEADER IS A BEARER INSTRUMENT, so the record holding it is
 * written 0600 through an atomic rename (which replaces a planted symlink
 * rather than writing through it), read with O_NOFOLLOW, and loses `auth` the
 * moment the take stops running. A record past its `expiresAt` is pruned.
 */

/** At most this many takes per call, so at most this many files per job. */
export const MAX_TAKES = 5;
/** A record is the server's and the seller's words plus a result cut short. */
const MAX_RECORD_BYTES = 256 * 1024;
/** What a finished take keeps of the result it handed the agent. */
export const KEPT_RESULT_CHARS = 8_000;
/** A record whose `expiresAt` cannot be read is pruned once it is this old. */
const UNREADABLE_TTL_MS = 49 * 60 * 60_000;

const Iso = z.string().max(40);
const Digits = z.string().regex(/^\d+$/);
const Authorization = z.strictObject({
  from: z.string().max(64),
  nonce: z.string().max(80),
  validBefore: Digits,
});

const TakeSchema = z.strictObject({
  version: z.literal(1),
  offerId: z.string().min(1).max(200),
  take: z.number().int().min(1).max(MAX_TAKES),
  /** The submit's origin: the only place `auth` is ever sent. */
  origin: z.string().min(1).max(2_048),
  poll: z.strictObject({
    url: z.string().min(1).max(2_048),
    method: z.enum(['GET', 'POST']),
    body: z
      .string()
      .max(64 * 1024)
      .optional(),
  }),
  /** The payment headers every poll carries, for a poll the seller binds to
   *  the paying wallet. Only while the take runs. */
  auth: z.record(z.string(), z.string().max(16 * 1024)).optional(),
  /** This take already signed its one fresh authorization for a poll. */
  resigned: z.boolean().optional(),
  job: JobSchema,
  /** What finishing the call needs once its spec is gone. */
  call: z.strictObject({
    capabilityId: z.string().min(1).max(200),
    provider: z.string().min(1).max(120),
    url: z.string().min(1).max(16_384),
    media: z.boolean(),
    sent: z.string().max(8_192),
    terms: z.strictObject({
      source: z.string().max(200).optional(),
      maxAmountAtomic: Digits,
      payTo: z.string().max(200).optional(),
      network: z.string().max(64).optional(),
      asset: z.string().max(200).optional(),
    }),
    resultSchema: z.record(z.string(), z.unknown()).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  }),
  submittedAt: Iso,
  expiresAt: Iso,
  amountAtomic: Digits,
  /** The submit's authorization, which its ledger row is found by. */
  authorization: Authorization.optional(),
  /** The fresh one a refused poll was signed with, which its own row is found by. */
  resignedAuthorization: Authorization.optional(),
  /** The submit's settlement, when the seller named it: paid for certain. */
  txHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
  /** The submit's HTTP status. */
  httpStatus: z.number().int().optional(),
  state: z.enum(['running', 'done', 'failed', 'expired']),
  savedFiles: z.array(z.string().max(4_096)).max(16),
  /** What the agent was handed when the take finished, cut short. */
  result: z
    .string()
    .max(KEPT_RESULT_CHARS + 16)
    .optional(),
  /** That result missed its success rule, or the rule could not be run. */
  resultUnverified: z.boolean().optional(),
  /** Why, as the agent was told. */
  resultCaveat: z.string().max(1_000).optional(),
  /** Why a take failed, or why it stopped. */
  reason: z.string().max(1_000).optional(),
  /** The seller's own words for it, bounded and redacted. Untrusted text. */
  said: z.string().max(1_000).optional(),
  /** An unsigned status URL the agent may open itself. Seller text. */
  statusUrl: z.string().max(2_048).optional(),
});
export type JobTake = z.infer<typeof TakeSchema>;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export function takePath(dataDir: string, offerId: string, take: number): string {
  return join(jobsDir(dataDir), `${digest(offerId)}.${take}.json`);
}

/**
 * Write a take, `auth` dropped unless it is still running. Throws: a job that
 * cannot be recorded before its first poll is one no later process can finish,
 * and the caller says so.
 */
export async function writeTake(dataDir: string, take: JobTake): Promise<void> {
  const kept: JobTake = take.state === 'running' ? take : withoutAuth(take);
  await writeFileAtomic(takePath(dataDir, take.offerId, take.take), JSON.stringify(kept), {
    mode: 0o600,
    dirMode: 0o700,
  });
  void pruneJobs(dataDir, Date.now());
}

function withoutAuth(take: JobTake): JobTake {
  const rest = { ...take };
  delete rest.auth;
  return rest;
}

/** The take kept for this offer, or null: none, damaged, not ours, or a symlink. */
export async function readTake(
  dataDir: string,
  offerId: string,
  take: number,
): Promise<JobTake | null> {
  const file = await open(
    takePath(dataDir, offerId, take),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => undefined);
  if (file === undefined) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    const parsed = TakeSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    return parsed.success && parsed.data.offerId === offerId && parsed.data.take === take
      ? parsed.data
      : null;
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** Every take kept for this offer, in order. */
export async function readTakes(dataDir: string, offerId: string): Promise<JobTake[]> {
  const takes: JobTake[] = [];
  for (let n = 1; n <= MAX_TAKES; n += 1) {
    const take = await readTake(dataDir, offerId, n);
    if (take !== null) takes.push(take);
  }
  return takes;
}

/**
 * READ, CHANGE AND WRITE ONE TAKE under its own lock, so two processes
 * resuming the same job cannot each sign the fresh authorization or each lose
 * the other's ending. `change` sees the record as it is on disk now and
 * returns the one to write, or null to leave it. The record written, or null.
 */
export async function updateTake(
  dataDir: string,
  offerId: string,
  take: number,
  change: (current: JobTake) => Promise<JobTake | null> | JobTake | null,
): Promise<JobTake | null> {
  const path = takePath(dataDir, offerId, take);
  return withFileLock(
    `${path}.lock`,
    async () => {
      const current = await readTake(dataDir, offerId, take);
      if (current === null) return null;
      const next = await change(current);
      if (next === null) return null;
      await writeTake(dataDir, next);
      return next.state === 'running' ? next : withoutAuth(next);
    },
    { timeoutMs: 30_000 },
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Drop every take past its `expiresAt`, and any unreadable one past two days.
 *  Housekeeping only: never throws. */
export async function pruneJobs(dataDir: string, now: number): Promise<void> {
  try {
    const dir = jobsDir(dataDir);
    for await (const entry of await opendir(dir)) {
      if (!entry.isFile() || !/^[0-9a-f]{64}\.\d\.json$/.test(entry.name)) continue;
      const path = join(dir, entry.name);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        () => undefined,
      );
      if (file === undefined) continue;
      let expired = false;
      try {
        const stat = await file.stat();
        const parsed =
          stat.size <= MAX_RECORD_BYTES
            ? TakeSchema.safeParse(parseJson(await file.readFile('utf8')))
            : undefined;
        expired =
          parsed?.success === true
            ? Date.parse(parsed.data.expiresAt) < now
            : now - stat.mtimeMs > UNREADABLE_TTL_MS;
      } catch {
        // Left for the next pass.
      } finally {
        await file.close().catch(() => undefined);
      }
      if (expired) await rm(path, { force: true }).catch(() => undefined);
    }
  } catch {
    // Housekeeping only.
  }
}
