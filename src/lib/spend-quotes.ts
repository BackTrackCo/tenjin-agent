import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-json';
import { withFileLock } from './lock';
import { quotesDir } from './paths';

/**
 * A SPEND THE USER IS ASKED ABOUT BEFORE IT IS MADE. A router call whose plan
 * is over the automatic limits pays nothing: its exact plan is kept here as a
 * quote (what it buys, each payment, the total, and the call to run) until a
 * person says yes, it runs, or it expires. One file per quote,
 * `~/.tenjin/quotes/<id>.json`, written 0600 through an atomic rename and read
 * with O_NOFOLLOW, as a job's record is.
 *
 * A QUOTE RUNS ONCE. `useQuote` marks it used under its lock before anything
 * is signed, so two calls racing on one quote pay once between them. One past
 * its ten minutes is refused, and pruned. What it runs (`call`) is the
 * router's to read; this file keeps the money.
 */

/** How long a quote waits for the user's yes. */
export const QUOTE_TTL_MS = 10 * 60_000;
/** A quote holds every spec it runs: a few of them, and their inputs. */
const MAX_QUOTE_BYTES = 512 * 1024;
const QUOTE_ID = /^q_[A-Za-z0-9_-]{12}$/;

const Iso = z.string().max(40);
const Digits = z.string().regex(/^\d+$/);

const QuoteSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(QUOTE_ID),
  createdAt: Iso,
  expiresAt: Iso,
  /** What the payments buy, as the user is asked about it. */
  what: z.string().min(1).max(400),
  /** The one sentence the agent repeats and the user answers. */
  sentence: z.string().min(1).max(800),
  totalAtomic: Digits,
  payments: z
    .array(z.strictObject({ amountAtomic: Digits, creator: z.string().min(1).max(300) }))
    .min(1)
    .max(8),
  /** The call this quote runs, exactly: the router's own shape. */
  call: z.unknown(),
  /** A person approved it at a terminal (`tenjin approve`). */
  approvedAt: Iso.optional(),
  /** It ran: nothing more is paid on it. */
  usedAt: Iso.optional(),
});
export type Quote = z.infer<typeof QuoteSchema>;

export type QuoteRefusal = 'missing' | 'expired' | 'used' | 'unapproved';

export function isQuoteId(id: string): boolean {
  return QUOTE_ID.test(id);
}

function quotePath(dataDir: string, id: string): string {
  return join(quotesDir(dataDir), `${id}.json`);
}

/** Keep a plan for the user's yes. Throws when it cannot be written: a quote
 *  nobody can run is not one to hand the agent. */
export async function createQuote(
  dataDir: string,
  plan: {
    what: string;
    sentence: string;
    payments: readonly { amountAtomic: bigint; creator: string }[];
    call: unknown;
  },
  now: () => number = Date.now,
): Promise<Quote> {
  const at = now();
  const quote: Quote = {
    version: 1,
    id: `q_${randomBytes(9).toString('base64url')}`,
    createdAt: new Date(at).toISOString(),
    expiresAt: new Date(at + QUOTE_TTL_MS).toISOString(),
    what: plan.what.slice(0, 400),
    sentence: plan.sentence.slice(0, 800),
    totalAtomic: plan.payments.reduce((sum, payment) => sum + payment.amountAtomic, 0n).toString(),
    payments: plan.payments.map((payment) => ({
      amountAtomic: payment.amountAtomic.toString(),
      creator: payment.creator,
    })),
    call: plan.call,
  };
  await writeQuote(dataDir, quote);
  void pruneQuotes(dataDir, at);
  return quote;
}

async function writeQuote(dataDir: string, quote: Quote): Promise<void> {
  await writeFileAtomic(quotePath(dataDir, quote.id), JSON.stringify(quote), {
    mode: 0o600,
    dirMode: 0o700,
  });
}

/** The quote kept under this id, or null: none, damaged, or a symlink. */
export async function readQuote(dataDir: string, id: string): Promise<Quote | null> {
  if (!isQuoteId(id)) return null;
  const file = await open(quotePath(dataDir, id), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    () => undefined,
  );
  if (file === undefined) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_QUOTE_BYTES) return null;
    const parsed = QuoteSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** Why a quote can no longer run, or null while it can. */
export function quoteClosed(
  quote: Quote,
  now: number,
): Exclude<QuoteRefusal, 'missing' | 'unapproved'> | null {
  if (quote.usedAt !== undefined) return 'used';
  return Date.parse(quote.expiresAt) <= now ? 'expired' : null;
}

/**
 * CHANGE ONE QUOTE under its lock: `change` sees it as it is on disk and
 * returns the quote to write, or a refusal that leaves it as it is.
 */
async function changeQuote(
  dataDir: string,
  id: string,
  change: (quote: Quote) => Quote | QuoteRefusal,
): Promise<{ quote: Quote } | { refused: QuoteRefusal }> {
  if (!isQuoteId(id)) return { refused: 'missing' };
  return withFileLock(
    `${quotePath(dataDir, id)}.lock`,
    async () => {
      const current = await readQuote(dataDir, id);
      if (current === null) return { refused: 'missing' as const };
      const next = change(current);
      if (typeof next === 'string') return { refused: next };
      await writeQuote(dataDir, next);
      return { quote: next };
    },
    { timeoutMs: 30_000 },
  );
}

/** A person's yes at a terminal, kept on the quote for the call that runs it. */
export function approveQuote(
  dataDir: string,
  id: string,
  now: () => number = Date.now,
): Promise<{ quote: Quote } | { refused: QuoteRefusal }> {
  return changeQuote(dataDir, id, (quote) => {
    const at = now();
    return quoteClosed(quote, at) ?? { ...quote, approvedAt: new Date(at).toISOString() };
  });
}

/**
 * USE A QUOTE UP: marked used before anything is signed, so it pays once
 * whatever happens next. `terminal`: the yes is the one `tenjin approve` kept,
 * which must be there.
 */
export function useQuote(
  dataDir: string,
  id: string,
  opts: { terminal: boolean; now?: () => number },
): Promise<{ quote: Quote } | { refused: QuoteRefusal }> {
  return changeQuote(dataDir, id, (quote) => {
    const at = (opts.now ?? Date.now)();
    const closed = quoteClosed(quote, at);
    if (closed !== null) return closed;
    if (opts.terminal && quote.approvedAt === undefined) return 'unapproved';
    return { ...quote, usedAt: new Date(at).toISOString() };
  });
}

/** Drop every quote past its expiry, and anything unreadable past a day.
 *  Housekeeping only: never throws. */
export async function pruneQuotes(dataDir: string, now: number): Promise<void> {
  try {
    const dir = quotesDir(dataDir);
    for await (const entry of await opendir(dir)) {
      const id = entry.name.replace(/\.json$/, '');
      if (!entry.isFile() || !entry.name.endsWith('.json') || !isQuoteId(id)) continue;
      const quote = await readQuote(dataDir, id);
      const stale =
        quote !== null
          ? Date.parse(quote.expiresAt) < now
          : await open(join(dir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW)
              .then(async (file) => {
                try {
                  return now - (await file.stat()).mtimeMs > 24 * 60 * 60_000;
                } finally {
                  await file.close().catch(() => undefined);
                }
              })
              .catch(() => false);
      if (stale) await rm(join(dir, entry.name), { force: true }).catch(() => undefined);
    }
  } catch {
    // Housekeeping only.
  }
}
