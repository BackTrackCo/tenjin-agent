import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic, writeFileAtomicExclusive } from '../lib/atomic-json';
import { OfferCardSchema, type OfferCard } from './decision';

/**
 * THE TOOL CARDS AN OFFER CARRIED, kept on this machine by the offer's id. The
 * hook that shows a line stores the card of every service the line names; the
 * `request` tool, which runs in the MCP server's own process and never sees
 * the hook, reads one back by the id the agent passes. One file per id, named
 * by the id's SHA-256, so a read is one open and needs no session.
 *
 * Best effort on the write, like every record the hooks keep: with no card
 * stored, `request({id})` says none is kept and asks for the query its line
 * named. A card is the server's own answer, re-parsed on the way back in, and
 * it lives as long as the server keeps the offer's id.
 */

const CARDS_DIR = join('progress', 'cards');
/** A card holds a service's whole input schema; far larger than any record. */
const MAX_CARD_BYTES = 128 * 1024;
/** Above this many files the directory is not scanned for pruning. */
const MAX_CARDS = 512;
/** The server's decision expiry: past it, the id's outcome report and an
 *  `{id, query}` fallback find no row. */
export const CARD_TTL_MS = 15 * 60_000;

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function cardPath(dataDir: string, id: string): string {
  return join(dataDir, CARDS_DIR, `${digest(id)}.json`);
}

/**
 * Store each card under its id, and drop expired ones. Never throws. Ages are
 * file mtimes, so they are read against the real clock, never a caller's.
 */
export async function storeCards(
  dataDir: string,
  cards: readonly OfferCard[] | undefined,
): Promise<void> {
  if (cards === undefined || cards.length === 0) return;
  for (const card of cards) {
    try {
      await writeFileAtomic(cardPath(dataDir, card.id), JSON.stringify(card), {
        mode: 0o600,
        dirMode: 0o700,
      });
    } catch {
      // The tool falls back to the server for this id.
    }
  }
  await pruneCards(dataDir, Date.now());
}

/** The card stored for this id, or null: none, expired, damaged or not ours. */
export async function readCard(dataDir: string, id: string): Promise<OfferCard | null> {
  const path = cardPath(dataDir, id);
  // O_NOFOLLOW: the directory is the user's, and a planted symlink must not
  // turn this read into a read of something else.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (file === undefined) return null;
  try {
    const stat = await file.stat();
    if (Date.now() - stat.mtimeMs > CARD_TTL_MS || stat.size > MAX_CARD_BYTES) return null;
    const parsed = OfferCardSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/**
 * What an earlier call with a card's id left. `paid`: money left for it.
 * `running`: a call claimed it and has not ended, or its process died, so it
 * may have paid. `unrecorded`: this call could not record its claim.
 */
export type EarlierPayment =
  | { state: 'paid'; at: string; amountAtomic: string; txHash?: string }
  | { state: 'running'; at?: string }
  | { state: 'unrecorded' };

const PaymentSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('paid'),
    at: z.string().max(40),
    amountAtomic: z.string().regex(/^\d+$/),
    txHash: z.string().max(100).optional(),
  }),
  z.strictObject({ state: z.literal('running'), at: z.string().max(40) }),
]);

function paymentPath(dataDir: string, id: string): string {
  return join(dataDir, CARDS_DIR, `${digest(id)}.paid.json`);
}

/**
 * CLAIM THE ONE PAYMENT A CARD ALLOWS, before anything is signed: an exclusive
 * create beside the card, so a retry or a second call with the same id cannot
 * pay again. Null when the claim is this call's; otherwise what an earlier call
 * left, and this one pays nothing. A claim that cannot be written refuses too:
 * the record is the only proof a payment has not already left.
 */
export async function claimCardPayment(
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
 * How the claimed call ended. Money that left is recorded against the id; a
 * call that left nothing drops its claim, so a fixed input can still run. A
 * record that cannot be written leaves the claim standing, which refuses.
 */
export async function settleCardPayment(
  dataDir: string,
  id: string,
  left: { amountAtomic: bigint; txHash?: string },
  now: number = Date.now(),
): Promise<void> {
  const path = paymentPath(dataDir, id);
  if (left.amountAtomic === 0n) {
    await rm(path, { force: true }).catch(() => undefined);
    return;
  }
  const record = {
    state: 'paid',
    at: new Date(now).toISOString(),
    amountAtomic: left.amountAtomic.toString(),
    ...(left.txHash !== undefined ? { txHash: left.txHash } : {}),
  };
  await writeFileAtomic(path, JSON.stringify(record), { mode: 0o600, dirMode: 0o700 }).catch(
    () => undefined,
  );
}

async function pruneCards(dataDir: string, now: number): Promise<void> {
  try {
    const directory = await opendir(join(dataDir, CARDS_DIR));
    let count = 0;
    for await (const entry of directory) {
      if (++count > MAX_CARDS) return;
      if (!entry.isFile()) continue;
      const path = join(dataDir, CARDS_DIR, entry.name);
      const stat = await lstat(path).catch(() => undefined);
      if (stat === undefined || now - stat.mtimeMs > CARD_TTL_MS) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    }
  } catch {
    // Housekeeping only.
  }
}
