import { CliError } from '../lib/errors';
import { formatUsdDisplay, toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { resolveResourceRef } from '../lib/resource-ref';
import { fetchRead } from '../lib/read-client';
import { findDelivered, findDeliveredByUrl } from '../lib/library';
import {
  deliverExisting,
  deliverFresh,
  parseSectionsBudget,
  type PresentOpts,
} from '../lib/delivery';
import { sanitizeForTerminal } from '../lib/output';
import { isSessionPresentable, loadSessionFile, signWithSession } from '../lib/session-present';
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
 *   3. a PAID resource, with a read-scoped session key already on disk → present
 *      it on ONE bodyless signed GET; a 200 means this wallet owns the piece and
 *      it delivers, free
 *   4. anything else → REFUSED (exit 3), naming the price and pointing at
 *      `tenjin buy` (and at `tenjin session start` when no session was presented).
 *      Nothing is charged, and the refusal lands before any payment could be
 *      constructed, because none can be.
 *
 * The hard invariant, test-pinned rather than merely intended: this module — and
 * its entire transitive import graph — never reaches `lib/x402-pay`, `lib/wallet`,
 * or `lib/session-key`. Step 3 imports the PRESENT-ONLY half of the session layer
 * (`lib/session-present`): load a delegation that already exists and sign one
 * request with it. Minting one needs a wallet signature and lives in
 * `lib/session-key`, which stays banned from this graph.
 *
 * So what read can hold is a P-256 key. It cannot produce the secp256k1/EIP-712
 * signature an EIP-3009 transfer authorization needs, so it cannot pay however it
 * is refactored; and the delegation is `read`-scoped, which the SERVER refuses
 * (`insufficient_scope`) on any write method, so the bound does not depend on
 * this code being careful. `read` never mints, never re-establishes, and never
 * retries a refusal.
 */

export interface ReadArgs {
  ref: string;
  /** Include the full body in the machine output (default: outline only). */
  printBody?: boolean;
  /** Include leading sections within this token budget (deterministic split). */
  sections?: string;
}

export interface ReadDeps {
  /**
   * There is deliberately no `provider` or `authorizer` seam here, unlike
   * BuyDeps: this command has no wallet or spend path to inject one into. The
   * session key it may present is loaded from disk, never minted, so there is
   * nothing for a provider seam to provide.
   */
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

  // 3. Paid and not on disk. If a read-scoped session key is already cached, this
  //    wallet may already OWN the piece — present the delegation on one bodyless
  //    signed GET and let the server decide. Scope and expiry are checked here;
  //    the address is not, because there is no wallet in this process to compare
  //    against and the delegation is self-authenticating server-side (a file from
  //    another wallet simply does not entitle, and lands on the same refusal).
  //
  //    Exactly ONE retry, and no recovery: an unusable file, a second 402, or a
  //    rejected delegation all fall through to the refusal below. Re-establishing
  //    would need the wallet this module structurally cannot reach.
  const cached = await loadSessionFile(ctx.dataDir);
  const session =
    cached !== null && isSessionPresentable(cached, (deps.now ?? Date.now)(), 'read')
      ? cached
      : null;
  if (session !== null) {
    const sessionHeaders = await signWithSession(session, { method: 'GET', url: ref.url });
    const second = await fetchRead(ref.url, { ...fetchOpts, sessionHeaders });
    if (second.kind === 'entitled') {
      return await deliverFresh(
        ctx.dataDir,
        ref.url,
        second.body,
        'entitled',
        undefined,
        presentOpts,
      );
    }
  }

  // 4. Not entitled (or nothing to present with): refuse (exit 3) on the price buy
  //    would price a purchase against. No payment is constructed, because none can be.
  throw refusal(ref, firstRequirement, session !== null);
}

/**
 * The exit-3 refusal: the price, in human money, plus the verbs that can get past
 * it. `entitlementCheck` distinguishes the two shapes an agent should act on
 * differently — `'session'` means a live delegation was presented and the server
 * said this wallet does not own the piece (so buying is the only route), while
 * `'not_performed'` means no session key existed to check with (so minting one
 * may deliver it for free, if the piece was bought on another machine).
 */
function refusal(
  ref: { url: string; resourceId?: string },
  requirement: { amount: string; network: string },
  presented: boolean,
): CliError {
  const price = toMoney(requirement.amount);
  // formatUsdDisplay (not the machine `usd`) because this string is human copy:
  // a price a person reads renders as 0.10, never 0.1.
  const priceText = `${formatUsdDisplay(price.atomic)} USD (${price.atomic} atomic)`;
  const url = sanitizeForTerminal(ref.url);
  const buyFix = `Run \`tenjin buy ${url}\` to pay and read it, or \`tenjin inspect\` for the card first.`;
  return new CliError('REFUSED', `This piece costs ${priceText}; \`tenjin read\` never pays.`, {
    fix: presented
      ? buyFix
      : `${buyFix} If you already bought it on another machine, \`tenjin session start --scope read\` lets this read recover it free.`,
    details: {
      reason: 'payment_required',
      entitlementCheck: presented ? 'session' : 'not_performed',
      url: ref.url,
      ...(ref.resourceId !== undefined ? { resourceId: ref.resourceId } : {}),
      price,
      network: requirement.network,
      buyCommand: `tenjin buy ${ref.url}`,
      ...(presented ? {} : { sessionCommand: 'tenjin session start --scope read' }),
    },
  });
}
