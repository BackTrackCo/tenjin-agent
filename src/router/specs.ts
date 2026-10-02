import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic, writeFileAtomicExclusive } from '../lib/atomic-json';
import { OfferSpecSchema, type OfferSpec } from './decision';

/**
 * THE REQUEST SPECS AN OFFER CARRIED, kept on this machine by the offer's id. The
 * hook that shows a line stores the spec of every service the line names; the
 * `request` tool, which runs in the MCP server's own process and never sees
 * the hook, reads one back by the id the agent passes. One file per id, named
 * by the id's SHA-256, so a read is one open and needs no session.
 *
 * Best effort on the write, like every record the hooks keep: with no spec
 * stored, `request({id})` says none is kept and asks for the query its line
 * named. A spec is the server's own answer, re-parsed on the way back in, and
 * it lives as long as the server keeps the offer's id.
 */

const SPECS_DIR = join('progress', 'specs');
const RESULTS_DIR = 'results';
/** A spec holds a service's whole input schema; far larger than any record. */
const MAX_SPEC_BYTES = 128 * 1024;
/** The server's decision expiry: past it, the id's outcome report and an
 *  `{id, query}` fallback find no row. */
export const SPEC_TTL_MS = 15 * 60_000;
/** A saved result outlives its offer: the agent opens it later in the session,
 *  or in the next step of a chain. A day covers a working session. */
export const RESULT_TTL_MS = 24 * 60 * 60_000;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function specPath(dataDir: string, id: string): string {
  return join(dataDir, SPECS_DIR, `${digest(id)}.json`);
}

/**
 * Store each spec under its id, and drop expired ones. Never throws. Ages are
 * file mtimes, so they are read against the real clock, never a caller's.
 */
export async function storeSpecs(
  dataDir: string,
  specs: readonly OfferSpec[] | undefined,
): Promise<void> {
  if (specs === undefined || specs.length === 0) return;
  for (const spec of specs) {
    try {
      await writeFileAtomic(specPath(dataDir, spec.id), JSON.stringify(spec), {
        mode: 0o600,
        dirMode: 0o700,
      });
    } catch {
      // The tool falls back to the server for this id.
    }
  }
  await prune(join(dataDir, SPECS_DIR), SPEC_TTL_MS, Date.now());
}

/** The spec stored for this id, or null: none, expired, damaged or not ours. */
export async function readSpec(dataDir: string, id: string): Promise<OfferSpec | null> {
  const path = specPath(dataDir, id);
  // O_NOFOLLOW: the directory is the user's, and a planted symlink must not
  // turn this read into a read of something else.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (file === undefined) return null;
  try {
    const stat = await file.stat();
    if (Date.now() - stat.mtimeMs > SPEC_TTL_MS || stat.size > MAX_SPEC_BYTES) return null;
    const parsed = OfferSpecSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/**
 * What an earlier call with a spec's id left. `paid`: money left for it.
 * `possibly_paid`: a payment was signed and may have left, but the call ended
 * without saying how much (a spend ledger that could not be written, say).
 * `running`: a call claimed it and has not ended, or its process died, so it
 * may have paid. `unrecorded`: this call could not record its claim.
 */
export type EarlierPayment =
  | { state: 'paid'; at: string; amountAtomic: string; txHash?: string }
  | { state: 'possibly_paid'; at: string }
  | { state: 'running'; at?: string }
  | { state: 'unrecorded' };

const PaymentSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('paid'),
    at: z.string().max(40),
    amountAtomic: z.string().regex(/^\d+$/),
    txHash: z.string().max(100).optional(),
  }),
  z.strictObject({ state: z.literal('possibly_paid'), at: z.string().max(40) }),
  z.strictObject({ state: z.literal('running'), at: z.string().max(40) }),
]);

function paymentPath(dataDir: string, id: string): string {
  return join(dataDir, SPECS_DIR, `${digest(id)}.paid.json`);
}

/**
 * CLAIM THE ONE PAYMENT A SPEC ALLOWS, before anything is signed: an exclusive
 * create beside the spec, so a retry or a second call with the same id cannot
 * pay again. Null when the claim is this call's; otherwise what an earlier call
 * left, and this one pays nothing. A claim that cannot be written refuses too:
 * the record is the only proof a payment has not already left.
 */
export async function claimSpecPayment(
  dataDir: string,
  id: string,
  now: number = Date.now(),
): Promise<EarlierPayment | null> {
  const path = paymentPath(dataDir, id);
  try {
    await writeFileAtomicExclusive(
      path,
      JSON.stringify({ state: 'running', at: new Date(now).toISOString() }),
      { mode: 0o600, dirMode: 0o700 },
    );
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return { state: 'unrecorded' };
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (file === undefined) return { state: 'running' };
  try {
    const parsed = PaymentSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    return parsed.success ? parsed.data : { state: 'running' };
  } catch {
    return { state: 'running' };
  } finally {
    await file.close().catch(() => undefined);
  }
}

/**
 * How the claimed call ended. Money that left is recorded against the id. The
 * claim is dropped ONLY when nothing was signed, so a fixed input can still
 * run: a signed payment whose amount the call never learned (it failed after
 * the authorization left) stays claimed as possibly paid, and the id never
 * signs again. A record that cannot be written leaves the claim standing,
 * which refuses too.
 */
export async function settleSpecPayment(
  dataDir: string,
  id: string,
  left: { amountAtomic: bigint; txHash?: string; signed: boolean },
  now: number = Date.now(),
): Promise<void> {
  const path = paymentPath(dataDir, id);
  if (!left.signed && left.amountAtomic === 0n) {
    await rm(path, { force: true }).catch(() => undefined);
    return;
  }
  const at = new Date(now).toISOString();
  const record =
    left.amountAtomic > 0n
      ? {
          state: 'paid',
          at,
          amountAtomic: left.amountAtomic.toString(),
          ...(left.txHash !== undefined ? { txHash: left.txHash } : {}),
        }
      : { state: 'possibly_paid', at };
  await writeFileAtomic(path, JSON.stringify(record), { mode: 0o600, dirMode: 0o700 }).catch(
    () => undefined,
  );
}

/**
 * THE WHOLE BODY A SPEC'S CALL RETURNED, kept by the offer's id while the
 * agent is handed only the fields the spec promises, so nothing it paid for is
 * out of reach. The caller passes only a body it could project, which is
 * bounded by the result cap. The path, or null when it could not be written,
 * and the caller then hands back the whole body instead. Never throws.
 */
export async function storeFullResult(
  dataDir: string,
  id: string,
  body: string,
): Promise<string | null> {
  const path = join(dataDir, RESULTS_DIR, `${digest(id)}.json`);
  try {
    await writeFileAtomic(path, body, { mode: 0o600, dirMode: 0o700 });
  } catch {
    return null;
  }
  await prune(join(dataDir, RESULTS_DIR), RESULT_TTL_MS, Date.now());
  return path;
}

async function prune(dir: string, ttlMs: number, now: number): Promise<void> {
  try {
    // Every entry: a directory with many files is the one that most needs its
    // expired files gone.
    const directory = await opendir(dir);
    for await (const entry of directory) {
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      const stat = await lstat(path).catch(() => undefined);
      if (stat === undefined || now - stat.mtimeMs > ttlMs) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
  } catch {
    // Housekeeping only.
  }
}
