import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, SettleResponse } from '@x402/mcp';
import type { CommandContext, CommandResult } from '../context';
import { deliverExisting, deliverFresh, parseSectionsBudget } from '../lib/delivery';
import { CliError } from '../lib/errors';
import { findDelivered, findDeliveredByUrl } from '../lib/library';
import { parseUsdToAtomic } from '../lib/money';
import { fetchRead } from '../lib/read-client';
import { resolveResourceRef } from '../lib/resource-ref';
import { findSearchForResource } from '../lib/search-store';
import { resolveContextSettings } from '../lib/settings';

/**
 * The provider-neutral MCP lane is a transport adapter over Tenjin's canonical
 * HTTP x402 resource. Verification, extension validation, settlement, creator
 * credit, and entitlement recording stay on that resource server; this process
 * only converts the standard MCP metadata payload to the standard HTTP codec.
 *
 * Normative contract: x402-foundation/x402
 * specs/transports-v2/mcp.md at 112c1e3f8e21b0a4c3d4f4ca366f607799fdc2a5.
 */

export interface ExternalBuyArgs {
  ref: string;
  maxPrice?: string;
  sections?: string;
}

export interface ExternalBuyDeps {
  fetchImpl?: typeof fetch;
}

export type ExternalBuyOutcome =
  | { kind: 'result'; result: CommandResult; settlementResponse?: SettleResponse }
  | { kind: 'payment_required'; paymentRequired: PaymentRequired };

export async function runExternalBuy(
  args: ExternalBuyArgs,
  ctx: CommandContext,
  payment: PaymentPayload | null,
  deps: ExternalBuyDeps = {},
): Promise<ExternalBuyOutcome> {
  const settings = await resolveContextSettings(ctx);
  const sectionsBudget = parseSectionsBudget(args.sections);
  const presentOpts = { printBody: true, sectionsBudget };
  const maxPriceAtomic =
    args.maxPrice !== undefined ? BigInt(parseUsdToAtomic(args.maxPrice)) : undefined;
  const ref = await resolveResourceRef(args.ref, ctx.dataDir, settings.baseUrl);

  // Preserve the CLI's strongest idempotence guarantee before any network or
  // payment handling. A stale payment payload is never forwarded for an item
  // already present in the local library.
  const existing =
    ref.resourceId !== undefined
      ? await findDelivered(ctx.dataDir, ref.resourceId)
      : await findDeliveredByUrl(ctx.dataDir, ref.url);
  if (existing !== null) {
    return { kind: 'result', result: deliverExisting(existing, presentOpts) };
  }

  const searchId =
    (await findSearchForResource(ctx.dataDir, {
      ...(ref.resourceId !== undefined ? { resourceId: ref.resourceId } : {}),
      url: ref.url,
    })) ?? undefined;
  const fetchOpts = {
    timeoutMs: ctx.flags.timeout,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };

  // Always resolve a fresh canonical challenge on the retry. The canonical
  // resource server, not this adapter, owns requirement and extension matching.
  const fresh = await fetchRead(ref.url, fetchOpts);
  if (fresh.kind === 'entitled') {
    return {
      kind: 'result',
      result: await deliverFresh(ctx.dataDir, ref.url, fresh.body, 'free', undefined, presentOpts),
    };
  }
  if (fresh.kind === 'already_purchased') {
    throw new CliError('API_UNREACHABLE', 'Unexpected 409 on an unauthenticated read.', {
      fix: 'Retry; if it persists, update tenjin-cli.',
    });
  }

  const requirement = fresh.paymentRequired.accepts[0];
  if (requirement === undefined) {
    throw new CliError('PAYMENT_FAILED', 'The 402 advertised no payment requirements.', {
      fix: 'Try another candidate; this resource looks misconfigured.',
    });
  }
  if (maxPriceAtomic !== undefined && BigInt(requirement.amount) > maxPriceAtomic) {
    throw new CliError('POLICY_REFUSED', 'The current price exceeds maxPrice.', {
      fix: 'Raise maxPrice only after reviewing the fresh price.',
      details: { currentAtomic: requirement.amount, maxAtomic: maxPriceAtomic.toString() },
    });
  }

  if (payment === null) {
    return { kind: 'payment_required', paymentRequired: fresh.paymentRequired };
  }

  // Use the official HTTP codec. The canonical Tenjin route performs all
  // schema, version, resource, requirement, extension, payer, and settlement
  // validation and returns either a fresh 402 or a settlement receipt.
  const paid = await fetchRead(ref.url, {
    ...fetchOpts,
    paymentHeaders: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payment) },
    ...(searchId !== undefined ? { searchId } : {}),
  });
  if (paid.kind === 'payment_required') {
    return { kind: 'payment_required', paymentRequired: paid.paymentRequired };
  }
  if (paid.kind === 'already_purchased') {
    throw new CliError(
      'PAYMENT_FAILED',
      'This wallet already bought the piece; use an authenticated re-read instead of paying again.',
      { fix: 'Use the integrated wallet mode, or re-read with a fresh SIGN-IN-WITH-X proof.' },
    );
  }

  const settlement = paid.settlementResponse;
  if (settlement?.success !== true) {
    // Never expose the paid body without the standard settlement metadata. The
    // first fresh challenge remains the safe, direct PaymentRequired response.
    return {
      kind: 'payment_required',
      paymentRequired: {
        ...fresh.paymentRequired,
        error: settlement?.errorReason ?? 'Settlement did not return a successful receipt',
      },
    };
  }

  const paidAtomic = BigInt(settlement.amount ?? requirement.amount);
  const result = await deliverFresh(
    ctx.dataDir,
    ref.url,
    paid.body,
    'purchased',
    { paidAtomic, settlementTxHash: settlement.transaction },
    presentOpts,
  );
  return { kind: 'result', result, settlementResponse: settlement };
}
