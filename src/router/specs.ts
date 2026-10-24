import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic, writeFileAtomicExclusive } from '../lib/atomic-json';
import {
  AccountOfferSpecSchema,
  ChoicesSchema,
  OfferSpecSchema,
  type AccountOfferSpec,
  type Choices,
  type OfferSpec,
} from './decision';

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

/** The field of a kept spec that names the one input a row may show. */
export const SHOWN_KEY = 'shown';

/** Past this many characters an input is a prompt, not the key of a lookup. */
export const SHOWN_INPUT_MAX_CHARS = 80;

/**
 * WHICH INPUT A ROW MAY SHOW FOR A SERVICE, decided here so the mod reads a
 * field name and nothing else (`shown`, kept in the spec's own file). Only
 * a lookup's identifying input: the field the catalog says takes a search's
 * query or a fetch's URL (`holds`), else the service's first required string
 * field (a company or person name, an expression). Never for a service the
 * catalog marks as producing media (`output: "media"`: image, video, audio,
 * music, speech), whose input is a prompt.
 */
export function shownInputField(
  spec: Pick<OfferSpec, 'output' | 'holds' | 'input'>,
): string | null {
  if (spec.output === 'media') return null;
  const held = spec.holds?.WebSearch ?? spec.holds?.WebFetch;
  if (held !== undefined) return held;
  const properties = spec.input.properties;
  if (properties === null || typeof properties !== 'object') return null;
  const isString = (name: string) =>
    (properties as Record<string, { type?: unknown }>)[name]?.type === 'string';
  const required = Array.isArray(spec.input.required)
    ? spec.input.required.filter((name): name is string => typeof name === 'string')
    : [];
  return required.find(isString) ?? Object.keys(properties).find(isString) ?? null;
}

/**
 * The input a row shows for this call, or undefined: the field
 * {@link shownInputField} names, when its value is a short single key. The
 * mod applies the same cap to the value it reads.
 */
export function shownInput(spec: OfferSpec, input: Record<string, unknown>): string | undefined {
  const field = shownInputField(spec);
  if (field === null) return undefined;
  const value = input[field];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 && Array.from(text).length <= SHOWN_INPUT_MAX_CHARS ? text : undefined;
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
      // `shown` rides beside the spec for the mod, and is dropped on read.
      const kept = { ...spec, [SHOWN_KEY]: shownInputField(spec) };
      await writeFileAtomic(specPath(dataDir, spec.id), JSON.stringify(kept), {
        mode: 0o600,
        dirMode: 0o700,
      });
    } catch {
      // The tool falls back to the server for this id; a row shows no input.
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
    const kept = JSON.parse(await file.readFile('utf8')) as Record<string, unknown>;
    delete kept[SHOWN_KEY];
    const parsed = OfferSpecSchema.safeParse(kept);
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** The field of a kept account spec naming Tenjin's own route for its job. */
const FALLBACK_KEY = 'fallback';

/**
 * KEEP AN OFFER LED BY THE USER'S OWN ACCOUNT (#37): its spec, and Tenjin's
 * own route for the same job under that route's id, with the lead naming it.
 * The line never names the fallback: this client offers it when the account
 * refuses. Never throws.
 */
export async function storeAccountOffer(
  dataDir: string,
  lead: AccountOfferSpec,
  fallback: OfferSpec | undefined,
): Promise<void> {
  try {
    const kept = {
      ...lead,
      [SHOWN_KEY]: shownInputField(lead),
      ...(fallback !== undefined ? { [FALLBACK_KEY]: fallback.id } : {}),
    };
    await writeFileAtomic(specPath(dataDir, lead.id), JSON.stringify(kept), {
      mode: 0o600,
      dirMode: 0o700,
    });
  } catch {
    // `request({id})` says no spec is kept, and the agent asks again.
  }
  await storeSpecs(dataDir, fallback !== undefined ? [fallback] : []);
  await prune(join(dataDir, SPECS_DIR), SPEC_TTL_MS, Date.now());
}

/** What is kept for an id: a spec the balance pays, or one on the user's own
 *  account with the id of Tenjin's route for its job. */
export type KeptSpec =
  | { spec: OfferSpec; account?: undefined }
  | { spec: AccountOfferSpec; account: true; fallbackId?: string };

/** Either kind of spec kept for this id, or null. Callers that run only a
 *  spec the balance pays read {@link readSpec}, which never returns the other. */
export async function readKeptSpec(dataDir: string, id: string): Promise<KeptSpec | null> {
  const file = await open(specPath(dataDir, id), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    () => undefined,
  );
  if (file === undefined) return null;
  try {
    const stat = await file.stat();
    if (Date.now() - stat.mtimeMs > SPEC_TTL_MS || stat.size > MAX_SPEC_BYTES) return null;
    const kept = JSON.parse(await file.readFile('utf8')) as Record<string, unknown>;
    const fallback = kept[FALLBACK_KEY];
    delete kept[SHOWN_KEY];
    delete kept[FALLBACK_KEY];
    const paid = OfferSpecSchema.safeParse(kept);
    if (paid.success) return paid.data.id === id ? { spec: paid.data } : null;
    const account = AccountOfferSpecSchema.safeParse(kept);
    if (!account.success || account.data.id !== id) return null;
    return {
      spec: account.data,
      account: true,
      ...(typeof fallback === 'string' && fallback.length > 0 ? { fallbackId: fallback } : {}),
    };
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** What the hook kept of a choice set: the set, and the line it came with. */
export interface KeptChoices {
  choices: Choices;
  hint: string;
}

export const KeptChoicesSchema = z.strictObject({
  choices: ChoicesSchema,
  hint: z.string().max(2_000),
});

function choicesPath(dataDir: string, id: string): string {
  return join(dataDir, SPECS_DIR, `${digest(id)}.choices.json`);
}

/**
 * KEEP AN OFFER'S CHOICE SET by the offer's id, beside its specs and for as
 * long: `request({id, choice})` reads it back to find the option's own id, or
 * every option's for `all`. Never throws; with none kept, a choice is refused
 * and the agent asks again.
 */
export async function storeChoices(
  dataDir: string,
  id: string,
  kept: KeptChoices | undefined,
): Promise<void> {
  if (kept === undefined) return;
  try {
    await writeFileAtomic(choicesPath(dataDir, id), JSON.stringify(kept), {
      mode: 0o600,
      dirMode: 0o700,
    });
  } catch {
    // The choice is refused, and the agent asks again.
  }
  await prune(join(dataDir, SPECS_DIR), SPEC_TTL_MS, Date.now());
}

/** The choice set kept for this id, or null: none, expired, damaged or not ours. */
export async function readChoices(dataDir: string, id: string): Promise<KeptChoices | null> {
  const file = await open(
    choicesPath(dataDir, id),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => undefined);
  if (file === undefined) return null;
  try {
    const stat = await file.stat();
    if (Date.now() - stat.mtimeMs > SPEC_TTL_MS || stat.size > MAX_SPEC_BYTES) return null;
    const parsed = KeptChoicesSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    return parsed.success ? parsed.data : null;
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
  /** It ran on the user's own account (#37), or may have. */
  | { state: 'account'; at: string }
  /** The account refused, and Tenjin's own route ran in its place, under
   *  the offer id `to` (#37): this offer's job is that one's. */
  | { state: 'switched'; at: string; to: string }
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
  z.strictObject({ state: z.literal('account'), at: z.string().max(40) }),
  z.strictObject({
    state: z.literal('switched'),
    at: z.string().max(40),
    to: z.string().max(200),
  }),
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
 * How a claimed call on the user's own account ended. One that ran, or may
 * have (its billing call went out), keeps the claim, so the same id never
 * sends it again; so does one whose job Tenjin's own route took over (`to`,
 * that route's offer id), which may have run and paid. One refused before
 * anything ran on either frees the id for a retry after a reconnect or a fixed
 * input. Never throws.
 */
export async function settleAccountRun(
  dataDir: string,
  id: string,
  ran: boolean | { to: string },
  now: number = Date.now(),
): Promise<void> {
  const path = paymentPath(dataDir, id);
  if (ran === false) {
    await rm(path, { force: true }).catch(() => undefined);
    return;
  }
  const at = new Date(now).toISOString();
  const record = ran === true ? { state: 'account', at } : { state: 'switched', at, to: ran.to };
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
  // Housekeeping never holds up a paid result: the prune runs after the path
  // is handed back, and it swallows its own errors.
  void prune(join(dataDir, RESULTS_DIR), RESULT_TTL_MS, Date.now());
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
