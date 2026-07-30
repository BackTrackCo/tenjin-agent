import { CliError } from '../lib/errors';
import { formatUsdDisplay, toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { resolveResourceRef } from '../lib/resource-ref';
import { fetchRead } from '../lib/read-client';
import type { ReadBody, SessionReadResult } from '../lib/read-client';
import { findDelivered, findDeliveredByUrl } from '../lib/library';
import {
  deliverExisting,
  deliverFresh,
  parseSectionsBudget,
  type PresentOpts,
} from '../lib/delivery';
import { sanitizeForTerminal } from '../lib/output';
import { isSessionPresentable, loadSessionFile, signWithSession } from '../lib/session-present';
import type { SessionFile } from '../lib/session-present';
import { originOf } from '../lib/url';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin read <resource-url-or-id>`, the FREE-ONLY delivery verb (#42).
 *
 * `buy` was the only verb that delivered a body, so a zero-cost re-read of
 * something you already own was indistinguishable — to a prefix-matching harness
 * permission classifier, and to a human reading a transcript — from a purchase.
 * `read` is the half of `buy` that never spends:
 *   1. local library (already delivered → re-deliver from disk, no network)
 *   2. first GET, unauthenticated → a FREE resource delivers immediately
 *   3. a PAID resource, with a read-scoped session key on disk for THIS origin →
 *      present it on ONE bodyless signed GET; a 200 means this wallet owns the
 *      piece and it delivers, free
 *   4. anything else → REFUSED (exit 3), naming the price, and pointing at
 *      `tenjin buy` only when the server actually answered "you do not own this".
 *      Nothing is charged, and the refusal lands before any payment could be
 *      constructed, because none can be.
 *
 * The hard invariant, test-pinned rather than merely intended (read.test.ts): this
 * module and its whole transitive import graph never reach `lib/x402-pay`,
 * `lib/wallet`, or `lib/session-key`. Step 3 uses the present-only half, so read
 * can load a delegation and sign with it but cannot mint one and cannot pay.
 * Those two are the whole of what the pin guarantees; what a minted delegation is
 * worth to a holder is answered in `lib/permissions.ts`.
 *
 * Step 3 therefore presents ONLY to the origin the session was minted against.
 * `--base-url` rides this verb like every other and `read` is always-safe, so
 * without that check one auto-allowed command line would hand a wallet-derived
 * credential to a host an agent picked.
 */

export interface ReadArgs {
  ref: string;
  /** Include the full body in the machine output (default: outline only). */
  printBody?: boolean;
  /** Include leading sections within this token budget (deterministic split). */
  sections?: string;
}

export interface ReadDeps {
  /** No `provider`/`authorizer` seam, unlike BuyDeps: there is no wallet to inject. */
  fetchImpl?: typeof fetch;
  /** Clock seam (ms since epoch) for the session-expiry decision. */
  now?: () => number;
}

export async function runRead(
  args: ReadArgs,
  ctx: CommandContext,
  deps: ReadDeps = {},
): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const sectionsBudget = parseSectionsBudget(args.sections);
  const ref = await resolveResourceRef(args.ref, ctx.dataDir, settings.baseUrl);
  const presentOpts: PresentOpts = { printBody: args.printBody === true, sectionsBudget };

  // 1. Library idempotence, BEFORE any network: an owned resource re-delivers
  //    from disk. This is the case #42 exists for — the re-read that used to need
  //    a `buy` approval. Matched by id or by url, exactly as buy matches it.
  const existing =
    ref.resourceId !== undefined
      ? await findDelivered(ctx.dataDir, ref.resourceId)
      : await findDeliveredByUrl(ctx.dataDir, ref.url);
  if (existing !== null) {
    return deliverExisting(existing, presentOpts);
  }

  const fetchOpts = {
    timeoutMs: ctx.flags.timeout,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };

  // 2. First GET, unauthenticated — the same probe buy opens with, and like buy's
  //    probe it is unattributed (no search id rides a non-purchase).
  const first = await fetchRead(ref.url, fetchOpts);

  if (first.kind === 'entitled') {
    // Free resource (no payment challenge was issued): deliver and save. No wallet
    // was resolved to get here.
    return await deliverFresh(ctx.dataDir, ref.url, first.body, 'free', undefined, presentOpts);
  }

  if (first.kind === 'already_purchased') {
    // A plain GET carries no payment header, so the read route cannot answer the
    // owned-re-pay 409 here; the contract makes this unreachable. Same loud failure
    // buy raises rather than guessing a recovery chain.
    throw new CliError('API_UNREACHABLE', 'Unexpected 409 on an unauthenticated read.', {
      fix: 'Retry; if it persists, update tenjin-cli.',
    });
  }

  // A paid resource. Capture the advertised price: it is what the refusal reports.
  const firstRequirement = first.paymentRequired.accepts[0];
  if (firstRequirement === undefined) {
    throw new CliError('PAYMENT_FAILED', 'The 402 advertised no payment requirements.', {
      fix: 'Try another candidate; this resource looks misconfigured.',
    });
  }

  // 3. Paid and not on disk. A live session key minted for THIS origin means the
  //    wallet may already own the piece. Exactly one attempt: re-establishing
  //    would need the wallet this module cannot reach.
  const cached = await loadSessionFile(ctx.dataDir);
  const now = deps.now ?? Date.now;
  // Against the origin of the URL actually being signed, not the configured base
  // URL. They are equal only because `resolveResourceRef` asserted it in another
  // module; checking the request target makes this guard locally sound instead of
  // dependent on a pin someone could move.
  const origin = originOf(ref.url);
  const outcome = await presentIfUsable(cached, origin, now, ref.url, fetchOpts);
  if (outcome.kind === 'entitled') {
    return await deliverFresh(
      ctx.dataDir,
      ref.url,
      outcome.body,
      'entitled',
      undefined,
      presentOpts,
    );
  }

  // 4. Not entitled, not asked, or not answered: refuse (exit 3) on the advertised
  //    price. No payment is constructed; none can be.
  throw refusal(ref, firstRequirement, outcome.check);
}

/** What the entitlement question got, which is not the same as what was asked. */
type EntitlementCheck =
  | 'not_performed'
  | 'session'
  | 'session_rejected'
  | 'session_inconclusive'
  | 'session_origin_mismatch';

type PresentOutcome =
  { kind: 'entitled'; body: ReadBody } | { kind: 'refuse'; check: EntitlementCheck };

/** Failures that must NOT be folded into a price refusal; see `present`. */
const LOUD_CODES = new Set(['CONTRACT_MISMATCH', 'RATE_LIMITED']);

/**
 * Decide whether the cached session may be presented, and present it if so.
 *
 * The origin mismatch is its own outcome rather than "no session": the two are
 * indistinguishable to an agent, and the remedy for one is the remedy the other
 * must NOT get. `not_performed` tells the agent to run `session start`, which is
 * the single verb that opens the keystore — and an agent that reached a mismatch
 * by carrying `--base-url` would carry it straight into that suggestion, minting
 * a wallet-signed delegation against the wrong host and clobbering the good one.
 */
async function presentIfUsable(
  cached: SessionFile | null,
  origin: string,
  now: () => number,
  url: string,
  fetchOpts: { timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<PresentOutcome> {
  if (cached === null) return { kind: 'refuse', check: 'not_performed' };
  if (cached.origin !== origin) {
    return { kind: 'refuse', check: 'session_origin_mismatch' };
  }
  if (!isSessionPresentable(cached, now(), 'read', origin)) {
    return { kind: 'refuse', check: 'not_performed' };
  }
  return await present(cached, url, fetchOpts, now);
}

/**
 * The one signed GET. Never throws for a transport failure: the first 402 already
 * told us the price, and losing it turns a recoverable refusal into a bare
 * network error that says nothing about the piece. Two exceptions stay loud: a
 * blocked redirect (a signal about where a credential was nearly sent) and a
 * rate limit (a recoverable pause the CLI models explicitly everywhere else —
 * swallowing it costs a looping agent its backoff and points it at a
 * keystore-opening command instead).
 */
async function present(
  session: SessionFile,
  url: string,
  fetchOpts: { timeoutMs: number; fetchImpl?: typeof fetch },
  now: () => number,
): Promise<PresentOutcome> {
  let second: SessionReadResult;
  try {
    const sessionHeaders = await signWithSession(session, { method: 'GET', url }, { now });
    second = await fetchRead(url, { ...fetchOpts, sessionHeaders });
  } catch (err) {
    if (err instanceof CliError && LOUD_CODES.has(err.code)) throw err;
    return { kind: 'refuse', check: 'session_inconclusive' };
  }
  switch (second.kind) {
    case 'entitled':
      return { kind: 'entitled', body: second.body };
    case 'payment_required':
      // The only state where the server actually answered the ownership question.
      return { kind: 'refuse', check: 'session' };
    case 'session_rejected':
      // The delegation was declined (expired, revoked, origin drift, rotated
      // wallet). The entitlement question was never asked, so "you must buy" is
      // not the answer — re-minting is.
      return { kind: 'refuse', check: 'session_rejected' };
    case 'already_purchased':
      // A 409 on a request carrying no payment is contract-anomalous: the server
      // said "already purchased" and delivered nothing. Handled by name rather
      // than swept into a default, because the one thing this must never become
      // is a price refusal telling the agent to buy what it was just told it owns.
      return { kind: 'refuse', check: 'session_inconclusive' };
  }
}

/**
 * The exit-3 refusal: the price, in human money, plus the move that actually gets
 * past it. `entitlementCheck` reports what the server said, and the fix follows
 * from it rather than from a single default:
 *
 *  - `session` — the server answered "you do not own this". Buying is the answer.
 *  - `session_origin_mismatch` — a session exists, for a DIFFERENT origin. The
 *    remedy is to stop redirecting the CLI, never to mint. `sessionCommand` is
 *    deliberately absent: recommending it here would send an agent that still
 *    carries `--base-url` to wallet-sign a delegation against the wrong host and
 *    overwrite the good one.
 *  - everything else — the question is still open, so re-minting may deliver it
 *    free and `sessionCommand` rides.
 */
function refusal(
  ref: { url: string; resourceId?: string },
  requirement: { amount: string; network: string },
  check: EntitlementCheck,
): CliError {
  const price = toMoney(requirement.amount);
  // formatUsdDisplay (not the machine `usd`) because this string is human copy:
  // a price a person reads renders as 0.10, never 0.1.
  const priceText = `${formatUsdDisplay(price.atomic)} USD (${price.atomic} atomic)`;
  const url = sanitizeForTerminal(ref.url);
  const buyFix = `Run \`tenjin buy ${url}\` to pay and read it, or \`tenjin inspect\` for the card first.`;
  const mismatch = check === 'session_origin_mismatch';
  const mintable = check !== 'session' && !mismatch;
  const fix = mismatch
    ? `Your session key was minted for a different Tenjin deployment, so it was not presented. Read from the origin it belongs to — check with \`tenjin config get baseUrl\` and drop any host override — rather than minting a new session against this one. ${buyFix}`
    : mintable
      ? `${buyFix} If you already bought it, \`tenjin session start --scope read\` lets this read recover it free.`
      : buyFix;
  return new CliError('REFUSED', `This piece costs ${priceText}; \`tenjin read\` never pays.`, {
    fix,
    details: {
      reason: 'payment_required',
      entitlementCheck: check,
      url: ref.url,
      ...(ref.resourceId !== undefined ? { resourceId: ref.resourceId } : {}),
      price,
      network: requirement.network,
      buyCommand: `tenjin buy ${ref.url}`,
      ...(mintable ? { sessionCommand: 'tenjin session start --scope read' } : {}),
    },
  });
}
