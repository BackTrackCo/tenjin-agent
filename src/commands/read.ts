import { CliError } from '../lib/errors';
import { formatUsdDisplay, toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { resolveResourceRef } from '../lib/resource-ref';
import { fetchRead, type ReadResult } from '../lib/read-client';
import { buildSiwxHeader } from '../lib/siwx';
import { findDelivered, findDeliveredByUrl } from '../lib/library';
import {
  deliverExisting,
  deliverFresh,
  parseSectionsBudget,
  type PresentOpts,
} from '../lib/delivery';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin read <resource-url-or-id>`, the FREE-ONLY delivery verb (#42).
 *
 * `buy` was the only verb that delivered a body, so a zero-cost re-read of
 * something you already own was indistinguishable — to a prefix-matching harness
 * permission classifier, and to a human reading a transcript — from a purchase.
 * `read` is the half of `buy` that never spends:
 *   1. local library (already delivered → re-deliver from disk, no network, and
 *      notably no keystore: the common re-read never unlocks anything)
 *   2. first GET, unauthenticated → a FREE resource delivers immediately
 *   3. a PAID resource → SIWX-authenticated entitlement re-check, exactly the one
 *      buy does: an entitled wallet re-reads free, and the body is stored to the
 *      library through the normal delivery path
 *   4. genuinely unentitled → REFUSED (exit 3), naming the price and pointing at
 *      `tenjin buy`. Nothing is charged, and the refusal lands before any payment
 *      could be constructed, because none can be.
 *
 * The hard invariant, test-pinned rather than merely intended: this module never
 * imports `lib/x402-pay`, never constructs or sends a payment, and never consults
 * the spend policy. Step 3 signs an AUTHENTICATION message only — the same class
 * of signature `publish` makes for SIWX, which moves no money — so the keystore
 * unlock buys proof of identity, never a transfer.
 *
 * Operator decision (#43): resolving the signer for that auth signature is
 * accepted for an allowlisted verb, because a split where you cannot read
 * something you already paid for is not worth having. Signer resolution stays
 * LAZY: it happens only on the paid branch, so a library hit and a free read
 * never touch the keystore.
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
  /**
   * Wallet seam for the SIWX entitlement check. There is deliberately no
   * `authorizer` seam here, unlike BuyDeps: this command has no spend path to
   * inject one into.
   */
  provider?: WalletProvider;
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

  // 1. Library idempotence, BEFORE any network and before any keystore access: an
  //    owned resource re-delivers from disk. This is the case #42 exists for — the
  //    re-read that used to need a `buy` approval. Matched by id or by url, exactly
  //    as buy matches it.
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
  //    probe it is unattributed (no lookup id rides a non-purchase).
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

  // A paid resource. Capture the advertised price now: it is what the refusal
  // reports if the entitlement check comes back negative.
  const firstRequirement = first.paymentRequired.accepts[0];
  if (firstRequirement === undefined) {
    throw new CliError('PAYMENT_FAILED', 'The 402 advertised no payment requirements.', {
      fix: 'Try another candidate; this resource looks misconfigured.',
    });
  }

  // 3. SIWX entitlement re-check. The ONLY place read resolves a signer, and the
  //    signature it makes is an authentication message bound to the base URL and
  //    chain — never a transfer authorization. A wallet that owns this piece
  //    re-reads it free, and the body is saved through the normal delivery path.
  const recheck = await siwxRecheck(ctx, ref.url, settings.baseUrl, {
    fetchOpts,
    network: firstRequirement.network,
    ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
  });

  if (recheck === null) {
    // No wallet on this machine, so an entitlement cannot be proven. Refuse with
    // the first-seen price rather than failing on the missing wallet: unprovable
    // and absent look the same from here, and the refusal is the useful answer.
    throw refusal(ref, firstRequirement, 'no_wallet');
  }
  if (recheck.kind === 'entitled') {
    return await deliverFresh(
      ctx.dataDir,
      ref.url,
      recheck.body,
      'entitled',
      undefined,
      presentOpts,
    );
  }
  if (recheck.kind !== 'payment_required') {
    throw new CliError(
      'API_UNREACHABLE',
      'Unexpected read response during the entitlement re-check.',
      { fix: 'Retry; if it persists, update tenjin-cli.' },
    );
  }

  // 4. Genuinely unentitled: refuse (exit 3) on the FRESH challenge's price, the
  //    same one buy would price a purchase against. No payment is constructed —
  //    this module cannot construct one.
  throw refusal(ref, recheck.paymentRequired.accepts[0] ?? firstRequirement, 'unentitled');
}

interface SiwxRecheckOpts {
  fetchOpts: { timeoutMs: number; fetchImpl?: typeof fetch };
  network: string;
  provider?: WalletProvider;
}

/**
 * Sign a SIWX header and re-request. Returns `null` — not an error — when there is
 * no wallet to sign with, so a machine that never created one still gets read's
 * clean exit-3 refusal instead of a WALLET_MISSING runtime failure. Any other
 * wallet failure (a keystore the user could not unlock, a provider error) still
 * propagates: that one the user asked for and needs to see.
 */
async function siwxRecheck(
  ctx: CommandContext,
  url: string,
  baseUrl: string,
  opts: SiwxRecheckOpts,
): Promise<ReadResult | null> {
  const provider = resolveWalletProvider(
    ctx,
    opts.provider !== undefined ? { provider: opts.provider } : {},
  );
  try {
    await describeWallet(provider);
  } catch (err) {
    if (err instanceof CliError && err.code === 'WALLET_MISSING') return null;
    throw err;
  }
  const signer = await provider.getSigner();
  const siwxHeader = await buildSiwxHeader(signer, { baseUrl, chainId: opts.network });
  return await fetchRead(url, { ...opts.fetchOpts, siwxHeader });
}

/** The exit-3 refusal: the price, in human money, plus the verb that can pay it. */
function refusal(
  ref: { url: string; resourceId?: string },
  requirement: { amount: string; network: string },
  reason: 'unentitled' | 'no_wallet',
): CliError {
  const price = toMoney(requirement.amount);
  // formatUsdDisplay (not the machine `usd`) because this string is human copy:
  // a price a person reads renders as 0.10, never 0.1.
  const priceText = `${formatUsdDisplay(price.atomic)} USD (${price.atomic} atomic)`;
  const because =
    reason === 'no_wallet'
      ? ' No wallet on this machine, so an existing entitlement could not be proven.'
      : '';
  return new CliError(
    'REFUSED',
    `This piece costs ${priceText} and you are not entitled to it; ` +
      `\`tenjin read\` never pays.${because}`,
    {
      fix: `Run \`tenjin buy ${sanitizeForTerminal(ref.url)}\` to pay and read it, or \`tenjin inspect\` for the card first.`,
      details: {
        reason: 'payment_required',
        entitlementCheck: reason === 'no_wallet' ? 'skipped_no_wallet' : 'siwx_unentitled',
        url: ref.url,
        ...(ref.resourceId !== undefined ? { resourceId: ref.resourceId } : {}),
        price,
        network: requirement.network,
        buyCommand: `tenjin buy ${ref.url}`,
      },
    },
  );
}
