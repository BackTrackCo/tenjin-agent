import { createHash, randomUUID } from 'node:crypto';
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
import { SettingsHashSchema } from './settings-wire';

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

/**
 * A SPEC AS THIS MACHINE KEEPS IT: the server's spec and the `settingsHash`
 * of the answer that carried it, which names the rules that offer was decided
 * under. Absent when that answer echoed none. The check before every call
 * compares it with the hash of the rules saved now (`settings-check.ts`).
 */
export const KeptSpecSchema = OfferSpecSchema.extend({
  settingsHash: SettingsHashSchema.optional(),
});
export type KeptSpec = z.infer<typeof KeptSpecSchema>;

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
export function shownInput(
  spec: Pick<OfferSpec, 'output' | 'holds' | 'input'>,
  input: Record<string, unknown>,
): string | undefined {
  const field = shownInputField(spec);
  if (field === null) return undefined;
  const value = input[field];
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 && Array.from(text).length <= SHOWN_INPUT_MAX_CHARS ? text : undefined;
}

/** The field of a kept spec that names the account offer it was offered in
 *  place of, after that account refused (`accounts/run.ts`). */
const REPLACES_KEY = 'replaces';

/**
 * Store each spec under its id, and drop expired ones. Never throws. Ages are
 * file mtimes, so they are read against the real clock, never a caller's.
 * `replaces`: the account offer these were offered in place of, which a run of
 * one of them settles, so that offer never runs too.
 */
export async function storeSpecs(
  dataDir: string,
  specs: readonly OfferSpec[] | undefined,
  settingsHash?: string,
  opts: { replaces?: string } = {},
): Promise<void> {
  if (specs === undefined || specs.length === 0) return;
  for (const spec of specs) {
    try {
      await writeKept(
        dataDir,
        spec,
        settingsHash,
        opts.replaces !== undefined ? { [REPLACES_KEY]: opts.replaces } : {},
      );
    } catch {
      // The tool falls back to the server for this id; a row shows no input.
    }
  }
  await prune(join(dataDir, SPECS_DIR), SPEC_TTL_MS, Date.now());
}

/**
 * Write one kept spec under its id. `shown` rides beside it for the mod, with
 * `beside` (what a kind of spec keeps of its own), and both are dropped on
 * read; the answer's settings hash is this offer's own, never a later one.
 * Throws.
 */
async function writeKept(
  dataDir: string,
  spec: OfferSpec | AccountOfferSpec,
  settingsHash: string | undefined,
  beside: Record<string, unknown>,
): Promise<void> {
  const kept: Record<string, unknown> = {
    ...spec,
    [SHOWN_KEY]: shownInputField(spec),
    ...beside,
  };
  delete kept.settingsHash;
  if (settingsHash !== undefined) kept.settingsHash = settingsHash;
  await writeFileAtomic(specPath(dataDir, spec.id), JSON.stringify(kept), {
    mode: 0o600,
    dirMode: 0o700,
  });
}

/** The spec stored for this id, with the settings hash it was decided under,
 *  or null: none, expired, damaged or not ours. */
export async function readSpec(dataDir: string, id: string): Promise<KeptSpec | null> {
  return (await readKept(dataDir, id, (kept) => paidSpecOf(kept, id)))?.spec ?? null;
}

/**
 * The file kept for this id, read once and handed to `read`, or null: none,
 * expired, over its bound or damaged. O_NOFOLLOW: the directory is the
 * user's, and a planted symlink must not turn this read into a read of
 * something else. Never throws.
 */
async function readKept<T>(
  dataDir: string,
  id: string,
  read: (kept: Record<string, unknown>) => T | null,
): Promise<T | null> {
  const file = await open(specPath(dataDir, id), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    () => undefined,
  );
  if (file === undefined) return null;
  try {
    const stat = await file.stat();
    if (Date.now() - stat.mtimeMs > SPEC_TTL_MS || stat.size > MAX_SPEC_BYTES) return null;
    const kept: unknown = JSON.parse(await file.readFile('utf8'));
    if (kept === null || typeof kept !== 'object' || Array.isArray(kept)) return null;
    return read(kept as Record<string, unknown>);
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** A kept file as a spec the balance pays, with the account offer it
 *  replaces, when it does; null when it is not one. */
function paidSpecOf(
  kept: Record<string, unknown>,
  id: string,
): { spec: KeptSpec; replaces?: string } | null {
  const replaces = kept[REPLACES_KEY];
  const fields = { ...kept };
  delete fields[SHOWN_KEY];
  delete fields[REPLACES_KEY];
  const parsed = KeptSpecSchema.safeParse(fields);
  if (!parsed.success || parsed.data.id !== id) return null;
  return {
    spec: parsed.data,
    ...(typeof replaces === 'string' && replaces.length > 0 ? { replaces } : {}),
  };
}

/** An account spec as this machine keeps it: with the settings hash its
 *  answer echoed, as every kept spec has. */
export type KeptAccountSpec = AccountOfferSpec & { settingsHash?: string };

/**
 * KEEP AN OFFER LED BY THE USER'S OWN ACCOUNT (plan 37): its spec and the
 * settings hash its answer echoed. Never throws.
 */
export async function storeAccountOffer(
  dataDir: string,
  lead: AccountOfferSpec,
  settingsHash: string | undefined,
): Promise<void> {
  try {
    await writeKept(dataDir, lead, settingsHash, {});
  } catch {
    // `request({id})` says no spec is kept, and the agent asks again.
  }
  await prune(join(dataDir, SPECS_DIR), SPEC_TTL_MS, Date.now());
}

/** What is kept for an id: a spec the balance pays, with the account offer
 *  it was offered in place of, or one on the user's own account. */
export type KeptAny =
  | { spec: KeptSpec; account?: undefined; replaces?: string }
  | { spec: KeptAccountSpec; account: true };

/** Either kind of spec kept for this id, or null. Callers that run only a
 *  spec the balance pays read {@link readSpec}, which never returns the other. */
export async function readKeptSpec(dataDir: string, id: string): Promise<KeptAny | null> {
  return readKept(dataDir, id, (kept) => paidSpecOf(kept, id) ?? accountSpecOf(kept, id));
}

/** A kept file as a spec on the user's own account, or null. */
function accountSpecOf(
  kept: Record<string, unknown>,
  id: string,
): Extract<KeptAny, { account: true }> | null {
  const hash = SettingsHashSchema.optional().safeParse(kept.settingsHash);
  const fields = { ...kept };
  for (const key of [SHOWN_KEY, 'settingsHash']) delete fields[key];
  const account = AccountOfferSpecSchema.safeParse(fields);
  if (!account.success || account.data.id !== id || !hash.success) return null;
  return {
    spec: { ...account.data, ...(hash.data !== undefined ? { settingsHash: hash.data } : {}) },
    account: true,
  };
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

function labelPath(dataDir: string, id: string): string {
  return join(dataDir, SPECS_DIR, `${digest(id)}.label.json`);
}

/**
 * KEEP A FREE OFFER'S NAME by its id, beside its specs and for as long: a
 * free lookup carries no spec (the docs lookup has none), so this is the one
 * place the mod finds the name its row draws before the call has run. Written
 * for every free line the CLI shows. Never throws; with none kept, the row
 * draws nothing.
 */
export async function storeLabel(dataDir: string, id: string, label: string): Promise<void> {
  try {
    await writeFileAtomic(labelPath(dataDir, id), JSON.stringify({ id, label }), {
      mode: 0o600,
      dirMode: 0o700,
    });
  } catch {
    // The row draws nothing.
  }
  await prune(join(dataDir, SPECS_DIR), SPEC_TTL_MS, Date.now());
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
  /** It ran on the user's own account (plan 37), or may have. */
  | { state: 'account'; at: string }
  /** The account refused, and the offer Tenjin made in its place ran under
   *  the offer id `to`: this offer's job is that one's. */
  | { state: 'switched'; at: string; to: string }
  | { state: 'unrecorded' };

const PaymentSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('paid'),
    at: z.string().max(40),
    amountAtomic: z.string().regex(/^\d+$/),
    txHash: z.string().max(100).optional(),
    owner: z.string().max(64).optional(),
  }),
  z.strictObject({
    state: z.literal('possibly_paid'),
    at: z.string().max(40),
    owner: z.string().max(64).optional(),
  }),
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
 * claim is dropped when nothing was signed, so a fixed input can still run.
 * Otherwise a signed payment whose amount the call never learned (it failed
 * after the authorization left) stays claimed as possibly paid, and the id
 * never signs again. A record that cannot be written leaves the claim
 * standing, which refuses too. Returns the owner token the record was
 * written under, for {@link releaseSpecClaim}; undefined when no record was
 * written.
 */
export async function settleSpecPayment(
  dataDir: string,
  id: string,
  left: { amountAtomic: bigint; txHash?: string; signed: boolean },
  now: number = Date.now(),
): Promise<string | undefined> {
  const path = paymentPath(dataDir, id);
  if (!left.signed && left.amountAtomic === 0n) {
    await rm(path, { force: true }).catch(() => undefined);
    return undefined;
  }
  const at = new Date(now).toISOString();
  const owner = randomUUID();
  const record =
    left.amountAtomic > 0n
      ? {
          state: 'paid',
          at,
          amountAtomic: left.amountAtomic.toString(),
          ...(left.txHash !== undefined ? { txHash: left.txHash } : {}),
          owner,
        }
      : { state: 'possibly_paid', at, owner };
  return writeFileAtomic(path, JSON.stringify(record), { mode: 0o600, dirMode: 0o700 }).then(
    () => owner,
    () => undefined,
  );
}

/**
 * DROP A CLAIM ONLY WHILE IT IS STILL THE ONE THIS RUN WROTE: a short
 * wallet's reopened quote (`runApproveTool`) frees its offers for the rerun.
 * A claim another session or a later run created carries another owner, or
 * none, and stays. Only the claim's holder ever rewrites its file, and no one
 * can create one while it exists, so a matching owner is this run's record.
 */
export async function releaseSpecClaim(dataDir: string, id: string, owner: string): Promise<void> {
  const path = paymentPath(dataDir, id);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (file === undefined) return;
  let mine: boolean;
  try {
    const parsed = PaymentSchema.safeParse(JSON.parse(await file.readFile('utf8')));
    mine = parsed.success && 'owner' in parsed.data && parsed.data.owner === owner;
  } catch {
    mine = false;
  } finally {
    await file.close().catch(() => undefined);
  }
  if (mine) await rm(path, { force: true }).catch(() => undefined);
}

/**
 * How a claimed call on the user's own account ended. One that ran, or may
 * have (its billing call went out), keeps the claim, so the same id never
 * sends it again; so does one whose job the offer made in its place took over
 * (`to`, that offer's id), which may have run and paid. One refused before
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
