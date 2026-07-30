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
 *   3. a PAID resource → REFUSED (exit 3) straight off the 402, naming the price
 *      and pointing at `tenjin buy`. Nothing is charged, and the refusal lands
 *      before any payment could be constructed, because none can be.
 *
 * The hard invariant, test-pinned rather than merely intended: this module — and
 * its entire transitive import graph — never reaches `lib/x402-pay`, `lib/wallet`,
 * or `lib/session-key`. `read` cannot open a keystore or produce a signature of
 * any kind; its inability to pay is structural, not disciplinary.
 *
 * Operator decision (#43, superseding the earlier hold): the SIWX entitlement
 * re-check that used to sit between steps 2 and 3 was cut. An owned-but-uncached
 * paid piece today falls through to `tenjin buy`, whose own re-check delivers it
 * free; a dedicated follow-up restores unattended owned-library recovery on a
 * read-scoped session key that cannot spend by construction.
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
   * BuyDeps: this command has no signing or spend path to inject one into.
   */
  fetchImpl?: typeof fetch;
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

  // 3. Paid and not on disk: refuse (exit 3) straight off the 402, on the price
  //    buy would price a purchase against. No entitlement check is performed —
  //    this module has no wallet to check with — and no payment is constructed,
  //    because none can be.
  throw refusal(ref, firstRequirement);
}

/** The exit-3 refusal: the price, in human money, plus the verb that can pay it. */
function refusal(
  ref: { url: string; resourceId?: string },
  requirement: { amount: string; network: string },
): CliError {
  const price = toMoney(requirement.amount);
  // formatUsdDisplay (not the machine `usd`) because this string is human copy:
  // a price a person reads renders as 0.10, never 0.1.
  const priceText = `${formatUsdDisplay(price.atomic)} USD (${price.atomic} atomic)`;
  return new CliError('REFUSED', `This piece costs ${priceText}; \`tenjin read\` never pays.`, {
    fix: `Run \`tenjin buy ${sanitizeForTerminal(ref.url)}\` to pay and read it, or \`tenjin inspect\` for the card first.`,
    details: {
      reason: 'payment_required',
      entitlementCheck: 'not_performed',
      url: ref.url,
      ...(ref.resourceId !== undefined ? { resourceId: ref.resourceId } : {}),
      price,
      network: requirement.network,
      buyCommand: `tenjin buy ${ref.url}`,
    },
  });
}
