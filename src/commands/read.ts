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
import type { SignableRequest } from '../lib/session-present';
import { resolveWriteAuth } from '../lib/consent';
import { resolveWalletProvider, type WalletProvider } from '../lib/wallet';
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
 *   3. a PAID resource → establish or reuse a read-scoped session key for THIS
 *      origin and present it on ONE bodyless signed GET; a 200 means this wallet
 *      owns the piece and it delivers, free
 *   4. anything else → REFUSED (exit 3), naming the price, and pointing at
 *      `tenjin buy` only when the server actually answered "you do not own this".
 *      Nothing is charged, and the refusal lands before any payment could be
 *      constructed, because none can be.
 *
 * The hard invariant, test-pinned rather than merely intended (read.test.ts): this
 * module and its whole transitive import graph never reach `lib/x402-pay`. read
 * CANNOT PAY, and no refactor inside its graph can make it: the delegated key is
 * P-256, the wrong curve for the EIP-712 authorization a payment needs.
 *
 * Step 3's mint is the SAME establish-or-reuse `publish` and `edit` run
 * (`resolveWriteAuth`, at `read` scope): one keystore unlock, a ≤24h delegation
 * cached 0600, and every later owned read free and unattended. There is no
 * second SIWX path here and no separate verb to remember — an owned piece that is
 * not on this machine simply comes back.
 *
 * It presents and mints ONLY against the origin of the URL being read, and never
 * against a second one while a delegation for another origin is cached: a cached
 * credential is not offered to a host an agent picked with `--base-url`, and the
 * good delegation is not clobbered by one minted for it.
 */

export interface ReadArgs {
  ref: string;
  /** Include the full body in the machine output (default: outline only). */
  printBody?: boolean;
  /** Include leading sections within this token budget (deterministic split). */
  sections?: string;
}

export interface ReadDeps {
  fetchImpl?: typeof fetch;
  /** Clock seam (ms since epoch) for the session-expiry decision. */
  now?: () => number;
  /** Wallet seam for step 3's mint; no `authorizer`, unlike BuyDeps, because
   *  there is no payment for one to authorize. */
  provider?: WalletProvider;
  env?: NodeJS.ProcessEnv;
}

export async function runRead(
  args: ReadArgs,
  ctx: CommandContext,
  deps: ReadDeps = {},
): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const sectionsBudget = parseSectionsBudget(args.sections);
  const ref = await resolveResourceRef(
    args.ref,
    ctx.dataDir,
    settings.baseUrl,
    // The second origin only exists in TEAM mode. In public mode `publicShelfUrl`
    // is a shelf nothing falls through to, so widening on it would accept a URL
    // from an origin no search on this machine can even surface.
    settings.teamMode ? settings.publicShelfUrl : undefined,
    {
      timeoutMs: ctx.flags.timeout,
      ...(settings.bypass !== undefined ? { bypass: settings.bypass } : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    },
  );
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
    ...(settings.bypass !== undefined ? { bypass: settings.bypass } : {}),
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

  // 3. Paid and not on disk. A read-scoped session key says whether this wallet
  //    already owns the piece; it is reused if one is live and minted if not.
  const now = deps.now ?? Date.now;
  // Against the origin of the URL actually being signed, not the configured base
  // URL. They are equal only because `resolveResourceRef` asserted it in another
  // module; checking the request target makes this guard locally sound instead of
  // dependent on a pin someone could move.
  const origin = originOf(ref.url);
  const outcome = await presentOrMint(ctx, origin, now, ref.url, fetchOpts, deps);
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
  'session' | 'session_rejected' | 'session_inconclusive' | 'session_origin_mismatch' | 'no_wallet';

/** How the one signed GET gets its headers: from the cached delegation, or from
 *  the write auth that mints one. */
type SignHeaders = (req: SignableRequest) => Promise<Record<string, string>>;

type PresentOutcome =
  { kind: 'entitled'; body: ReadBody } | { kind: 'refuse'; check: EntitlementCheck };

/** Failures that must NOT be folded into a price refusal; see `present`. */
const LOUD_CODES = new Set(['CONTRACT_MISMATCH', 'RATE_LIMITED']);

/**
 * Get a read-scoped session for this origin — reusing the cached one, or minting
 * it — and present it.
 *
 * THE MINT IS NOT A SECOND PATH. It is `resolveWriteAuth` at `read` scope, the
 * same call `publish` and `edit` make, so the delegation this leaves on disk is
 * the one they reuse and vice versa. The cached branch above it exists for one
 * reason: `resolveWriteAuth` takes a signer by value, and resolving one decrypts
 * the keystore, so asking for it first would charge every owned read a
 * passphrase the live delegation was minted to avoid.
 *
 * The origin mismatch is its own outcome rather than "no session": the two are
 * indistinguishable to an agent, and the remedy for one is the remedy the other
 * must NOT get. A cached delegation for another deployment means an override is
 * in play, and minting there would wallet-sign against the host an agent picked
 * and overwrite the good credential with it.
 */
async function presentOrMint(
  ctx: CommandContext,
  origin: string,
  now: () => number,
  url: string,
  fetchOpts: { timeoutMs: number; fetchImpl?: typeof fetch },
  deps: ReadDeps,
): Promise<PresentOutcome> {
  const cached = await loadSessionFile(ctx.dataDir);
  if (cached !== null && cached.origin !== origin) {
    return { kind: 'refuse', check: 'session_origin_mismatch' };
  }
  if (cached !== null && isSessionPresentable(cached, now(), 'read', origin)) {
    return await present((req) => signWithSession(cached, req, { now }), url, fetchOpts);
  }
  let headersFor: SignHeaders;
  try {
    const provider = resolveWalletProvider(
      ctx,
      deps.provider !== undefined ? { provider: deps.provider } : {},
    );
    const signer = await provider.getSigner();
    const auth = resolveWriteAuth({
      signer,
      // The origin being read, not the configured base URL: in team mode a piece
      // may live on the public shelf while `baseUrl` names the team's, and a
      // delegation is only ever valid for the origin it was bound to.
      baseUrl: origin,
      dataDir: ctx.dataDir,
      scope: 'read',
      env: deps.env ?? process.env,
    });
    headersFor = (req) => auth.headersFor(req);
  } catch {
    // No wallet, or one that will not open. Ownership was never asked, and a
    // machine with no key owns nothing here anyway: refuse on the price rather
    // than replace a recoverable exit 3 with a keystore error.
    return { kind: 'refuse', check: 'no_wallet' };
  }
  return await present(headersFor, url, fetchOpts);
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
  headersFor: SignHeaders,
  url: string,
  fetchOpts: { timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<PresentOutcome> {
  let second: SessionReadResult;
  try {
    const sessionHeaders = await headersFor({ method: 'GET', url });
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
 *  - `session_origin_mismatch` — a session exists, for a DIFFERENT origin, so
 *    nothing was presented and nothing was minted. The remedy is to stop
 *    redirecting the CLI.
 *  - `no_wallet` — there is no key on this machine to ask the question with, so
 *    ownership is unknown rather than denied.
 *  - everything else — the question is still open; retrying is free.
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
  const fix =
    check === 'session_origin_mismatch'
      ? `Your session key was minted for a different Tenjin deployment, so it was not presented and no new one was minted against this host. Read from the origin it belongs to. Check the configured origin with \`tenjin config get baseUrl\` and drop any host override. ${buyFix}`
      : check === 'no_wallet'
        ? `This machine has no wallet that opens, so whether you own this piece could never be asked. Create or fix one (\`tenjin wallet create\`, \`tenjin doctor\`), then read it again. ${buyFix}`
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
    },
  });
}
