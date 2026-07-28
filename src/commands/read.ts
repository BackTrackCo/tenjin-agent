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
 *   3. anything that would cost money → REFUSED (exit 3), naming the price and
 *      pointing at `tenjin buy`. Nothing is signed, nothing is charged.
 *
 * The refusal is structural, not a flag check: this module imports no wallet, no
 * SIWX, no `lib/x402-pay`, and no spend policy, so there is no code path from
 * here to a payment even if the control flow were wrong. `read.test.ts` pins that
 * as an import-graph assertion, and pins that a paid unowned ref exits 3 without
 * ever resolving a wallet.
 *
 * Consequence worth stating: a piece you own on ANOTHER machine (entitled
 * server-side, absent from this library) is not readable here, because proving
 * that entitlement needs a SIWX signature and therefore the wallet. `read` refuses
 * it and points at `buy`, which re-checks entitlement and re-reads it free.
 */

export interface ReadArgs {
  ref: string;
  /** Include the full body in the machine output (default: outline only). */
  printBody?: boolean;
  /** Include leading sections within this token budget (deterministic split). */
  sections?: string;
}

export interface ReadDeps {
  /** The ONLY seam this command has. There is no wallet or authorizer to inject. */
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

  // 1. Library idempotence, BEFORE any network: an owned resource re-delivers from
  //    disk. This is the case #42 exists for — the re-read that used to need a
  //    `buy` approval. Matched by id or by url, exactly as buy matches it.
  const existing =
    ref.resourceId !== undefined
      ? await findDelivered(ctx.dataDir, ref.resourceId)
      : await findDeliveredByUrl(ctx.dataDir, ref.url);
  if (existing !== null) {
    return deliverExisting(existing, presentOpts);
  }

  // 2. First GET, unauthenticated — the same probe buy opens with. No SIWX header:
  //    signing one would need the wallet, which is the line this verb does not cross.
  const first = await fetchRead(ref.url, {
    timeoutMs: ctx.flags.timeout,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  if (first.kind === 'entitled') {
    // Free resource (no payment challenge was issued): deliver and save.
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

  // 3. Payment would be required. Refuse (exit 3) with the advertised price. The
  //    price comes from the 402 the probe already returned, so naming it costs
  //    nothing extra and no second request is made.
  const requirement = first.paymentRequired.accepts[0];
  const price = requirement !== undefined ? toMoney(requirement.amount) : undefined;
  // formatUsdDisplay (not the machine `usd`) because this string is human copy:
  // a price a person reads renders as 0.10, never 0.1.
  const priceText =
    price !== undefined
      ? `${formatUsdDisplay(price.atomic)} USD (${price.atomic} atomic)`
      : 'a fee';
  throw new CliError(
    'REFUSED',
    `${sanitizeForTerminal(titleOf(first.preview) ?? 'This resource')} costs ${priceText}; ` +
      '`tenjin read` never pays.',
    {
      fix: `Run \`tenjin buy ${ref.url}\` to pay and read it, or \`tenjin inspect\` for the card first.`,
      details: {
        reason: 'payment_required',
        url: ref.url,
        ...(ref.resourceId !== undefined ? { resourceId: ref.resourceId } : {}),
        ...(price !== undefined ? { price } : {}),
        ...(requirement !== undefined ? { network: requirement.network } : {}),
        buyCommand: `tenjin buy ${ref.url}`,
      },
    },
  );
}

/** The 402 preview's title, when the server sent one; it is untrusted display text. */
function titleOf(preview: { title?: unknown }): string | undefined {
  return typeof preview.title === 'string' && preview.title.length > 0 ? preview.title : undefined;
}
