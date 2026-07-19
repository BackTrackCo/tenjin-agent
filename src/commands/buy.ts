import { createInterface } from 'node:readline';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { resolveResourceRef } from '../lib/resource-ref';
import { findLookupForResource } from '../lib/lookup-store';
import { fetchRead, type Preview, type ReadBody } from '../lib/read-client';
import { buildSiwxHeader } from '../lib/siwx';
import { buildExactPayment } from '../lib/x402-pay';
import {
  findDelivered,
  findDeliveredByUrl,
  headingOutline,
  saveDelivery,
  selectSections,
  splitSections,
  type Entitlement,
  type SavedDelivery,
} from '../lib/library';
import {
  describeWallet,
  resolveSpendAuthorizer,
  resolveWalletProvider,
  type SpendAuthorizer,
  type TenjinSigner,
  type WalletProvider,
} from '../lib/wallet';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin buy <resource-url-or-id>`, the paid read. The ordering is the whole
 * point and is enforced here, never in the wallet:
 *   1. local library (already delivered → re-deliver from disk, no network, no pay)
 *   2. first GET → a FREE resource delivers immediately (no wallet)
 *   3. a PAID resource: SIWX-authenticated re-read FIRST, an entitled wallet
 *      re-reads free and NEVER pays twice
 *   4. only a genuinely-unentitled paid read reaches spend policy (provider-side)
 *   5. x402 exact payment, then save + commit the session ledger
 * The 409 owned-re-pay gate is respected: a rejected re-pay falls back to the free
 * SIWX re-read, never a charge.
 */

export interface BuyArgs {
  ref: string;
  /** Decimal USD at the edge (O1); the hard price cap, never bypassed by --yes. */
  maxPrice?: string;
  /** Bypass the interactive confirm only (never the price cap or a hard deny). */
  yes?: boolean;
  /** Include the full body in the machine output (default: outline only). */
  printBody?: boolean;
  /** Include leading sections within this token budget (deterministic split). */
  sections?: string;
}

export interface BuyDeps {
  fetchImpl?: typeof fetch;
  provider?: WalletProvider;
  authorizer?: SpendAuthorizer;
  /** Interactive-confirm seam; defaults to a TTY y/n prompt. */
  confirm?: (prompt: string) => Promise<boolean>;
}

export async function runBuy(
  args: BuyArgs,
  ctx: CommandContext,
  deps: BuyDeps = {},
): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const sectionsBudget = parseSectionsBudget(args.sections);
  const maxPriceAtomic =
    args.maxPrice !== undefined ? BigInt(parseUsdToAtomic(args.maxPrice)) : undefined;
  const ref = await resolveResourceRef(args.ref, ctx.dataDir);

  // 1. Library idempotence, BEFORE any network or pay: a resource already on disk
  //    re-delivers from disk. Works for both an id ref and a url ref (the url is
  //    matched to a saved receipt by its handle/slug), so a repeat buy of an owned
  //    resource never re-pays regardless of how it is addressed.
  const existing =
    ref.resourceId !== undefined
      ? await findDelivered(ctx.dataDir, ref.resourceId)
      : await findDeliveredByUrl(ctx.dataDir, ref.url);
  const presentOpts: PresentOpts = { printBody: args.printBody === true, sectionsBudget };
  if (existing !== null) {
    return deliverExisting(existing, presentOpts);
  }

  const lookupId =
    (await findLookupForResource(ctx.dataDir, {
      ...(ref.resourceId !== undefined ? { resourceId: ref.resourceId } : {}),
      url: ref.url,
    })) ?? undefined;

  const fetchOpts = {
    timeoutMs: ctx.flags.timeout,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(lookupId !== undefined ? { lookupId } : {}),
  };

  // 2. First GET, unauthenticated.
  const first = await fetchRead(ref.url, fetchOpts);
  if (first.kind === 'entitled') {
    // A free resource (no payment challenge was issued).
    return await deliverFresh(ctx, ref.url, first.body, 'free', undefined, presentOpts);
  }
  if (first.kind === 'already_purchased') {
    // A plain GET does not carry a payment header, so the read route cannot answer
    // the owned-re-pay 409 here; the contract makes this unreachable. Fail loudly
    // rather than guess a chain for a SIWX recovery.
    throw new CliError('API_UNREACHABLE', 'Unexpected 409 on an unauthenticated read.', {
      fix: 'Retry; if it persists, update tenjin-cli.',
    });
  }

  // A paid resource. From here a wallet is required. Capture the FIRST-SEEN amount
  // (and the chain to sign SIWX over) so a later price bump is detectable.
  const firstRequirement = first.paymentRequired.accepts[0];
  if (firstRequirement === undefined) {
    throw new CliError('PAYMENT_FAILED', 'The 402 advertised no payment requirements.', {
      fix: 'Try another candidate; this resource looks misconfigured.',
    });
  }
  const firstSeenAmount = BigInt(firstRequirement.amount);

  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  // describeWallet surfaces WALLET_MISSING with its own fix if no wallet exists.
  await describeWallet(provider);
  const signer = await provider.getSigner();

  // 3. Entitlement re-check FIRST (SIWX): an entitled wallet re-reads free. This
  //    request is ALSO the fresh 402 refetch, so the challenge signed below is the
  //    latest one, never the stale first look.
  const siwxHeader = await buildSiwxHeader(signer, {
    baseUrl: settings.baseUrl,
    chainId: firstRequirement.network,
  });
  const recheck = await fetchRead(ref.url, { ...fetchOpts, siwxHeader });
  if (recheck.kind === 'entitled') {
    return await deliverFresh(ctx, ref.url, recheck.body, 'entitled', undefined, presentOpts);
  }
  if (recheck.kind !== 'payment_required') {
    throw new CliError(
      'API_UNREACHABLE',
      'Unexpected read response during the entitlement re-check.',
      {
        fix: 'Retry; if it persists, update tenjin-cli.',
      },
    );
  }

  // The FRESH challenge the payment is built and priced against.
  const paymentRequired = recheck.paymentRequired;
  const requirement = paymentRequired.accepts[0];
  if (requirement === undefined) {
    throw new CliError('PAYMENT_FAILED', 'The fresh 402 advertised no payment requirements.', {
      fix: 'Try another candidate; this resource looks misconfigured.',
    });
  }
  const amountAtomic = BigInt(requirement.amount);
  // Refuse a price bump between the first look and signing: never sign a challenge
  // that costs more than what was first advertised.
  if (amountAtomic > firstSeenAmount) {
    throw new CliError('PAYMENT_FAILED', 'The price increased before signing; refusing to pay.', {
      fix: 'Re-run `tenjin buy` to review the new price, and set --max-price to cap it.',
      details: {
        firstSeenAtomic: firstSeenAmount.toString(),
        currentAtomic: amountAtomic.toString(),
      },
    });
  }
  const network = requirement.network;
  const creator = creatorFrom(recheck.preview);

  // 4. Genuinely unentitled: spend policy, provider-side, on the FRESH amount,
  //    BEFORE any payment. A proceeding decision reserves budget atomically.
  const authorizer = resolveSpendAuthorizer(
    ctx,
    settings.policy,
    deps.authorizer !== undefined ? { authorizer: deps.authorizer } : {},
  );
  const authorization = await authorizer.authorize({
    amountAtomic,
    creator,
    ...(maxPriceAtomic !== undefined ? { maxPriceAtomic } : {}),
  });
  if (authorization.decision === 'deny') {
    throw new CliError('POLICY_REFUSED', authorization.message, {
      fix: policyFix(authorization.reason),
      details: { reason: authorization.reason, amountAtomic: amountAtomic.toString() },
    });
  }
  const reservationId = authorization.reservationId;
  if (authorization.decision === 'confirm') {
    const approved = await confirmSpend(ctx, deps, args.yes === true, amountAtomic, creator);
    if (!approved) {
      await authorizer.release(reservationId);
      throw new CliError('POLICY_REFUSED', 'Purchase not confirmed.', {
        fix: 'Re-run with --yes, or set a policy that auto-approves this spend.',
        details: { reason: authorization.reason, amountAtomic: amountAtomic.toString() },
      });
    }
  }

  // 5. Pay: build the exact-scheme authorization (bound to the FRESH requirement)
  //    and re-request with it. Any non-settlement outcome releases the reservation.
  try {
    const payment = await buildExactPayment(paymentRequired, signer);
    const paid = await fetchRead(ref.url, { ...fetchOpts, paymentHeaders: payment.headers });

    if (paid.kind === 'entitled') {
      await authorizer.commit(reservationId);
      return await deliverFresh(
        ctx,
        ref.url,
        paid.body,
        'purchased',
        { paidAtomic: payment.amountAtomic, settlementTxHash: paid.settlementTxHash },
        presentOpts,
      );
    }
    if (paid.kind === 'already_purchased') {
      // The owned-re-pay gate fired: nothing charged. Release the reservation and
      // recover the body free via SIWX.
      await authorizer.release(reservationId);
      return await siwxRedeliver(
        ctx,
        ref.url,
        settings.baseUrl,
        signer,
        fetchOpts,
        presentOpts,
        network,
      );
    }
    // Still 402 after paying: the payment was not accepted (the catch releases).
    throw new CliError('PAYMENT_FAILED', 'Payment was not accepted by the read route.', {
      fix: 'Check the wallet balance and network, then retry.',
      details: paid.paymentRequired.error,
    });
  } catch (err) {
    // A build/settlement failure must not leave budget reserved.
    await authorizer.release(reservationId);
    throw err;
  }
}

interface PurchaseInfo {
  paidAtomic: bigint;
  settlementTxHash?: string;
}

interface PresentOpts {
  printBody: boolean;
  /** Token budget for the deterministic section selection; null = no sections. */
  sectionsBudget: number | null;
}

function parseSectionsBudget(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const budget = Number(raw);
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new CliError('USAGE', `Invalid --sections value: ${JSON.stringify(raw)}`, {
      fix: 'Pass a positive integer token budget, e.g. --sections 800.',
    });
  }
  return budget;
}

async function deliverFresh(
  ctx: CommandContext,
  url: string,
  body: ReadBody,
  entitlement: Entitlement,
  purchase: PurchaseInfo | undefined,
  presentOpts: PresentOpts,
): Promise<CommandResult> {
  const handle = body.creator.handle ?? body.creator.walletAddress ?? 'unknown';
  const saved = await saveDelivery(ctx.dataDir, {
    resourceId: body.id,
    slug: body.slug,
    title: body.title,
    handle,
    url,
    priceAtomic: body.price,
    entitlement,
    bodyMd: body.bodyMd,
    ...(purchase?.settlementTxHash !== undefined
      ? { settlementTxHash: purchase.settlementTxHash }
      : {}),
  });
  return present(saved, body.bodyMd, purchase, presentOpts);
}

async function siwxRedeliver(
  ctx: CommandContext,
  url: string,
  baseUrl: string,
  signer: TenjinSigner,
  fetchOpts: { timeoutMs: number; fetchImpl?: typeof fetch; lookupId?: string },
  presentOpts: PresentOpts,
  network: string,
): Promise<CommandResult> {
  const siwxHeader = await buildSiwxHeader(signer, { baseUrl, chainId: network });
  const res = await fetchRead(url, { ...fetchOpts, siwxHeader });
  if (res.kind !== 'entitled') {
    throw new CliError('PAYMENT_FAILED', 'The resource is owned but could not be re-read.', {
      fix: 'Retry; if it persists the entitlement may not have propagated yet.',
    });
  }
  return await deliverFresh(ctx, url, res.body, 'entitled', undefined, presentOpts);
}

/** Re-deliver from an existing on-disk receipt (no network, no spend). */
function deliverExisting(
  delivered: { receipt: import('../lib/library').Receipt; bodyMd: string; bodyPath: string },
  presentOpts: PresentOpts,
): CommandResult {
  const r = delivered.receipt;
  return {
    data: {
      resourceId: r.resourceId,
      slug: r.slug,
      title: r.title,
      url: r.url,
      entitlement: r.entitlement,
      alreadyDelivered: true,
      price: toMoney(r.priceAtomic),
      contentHash: r.contentHash,
      bodyPath: delivered.bodyPath,
      headings: headingOutline(delivered.bodyMd),
      ...(presentOpts.printBody ? { body: delivered.bodyMd } : {}),
      ...sectionsField(delivered.bodyMd, presentOpts),
    },
    humanLines: [
      `Already in your library: ${sanitizeForTerminal(r.title)} (${delivered.bodyPath}). No payment made.`,
    ],
  };
}

function sectionsField(
  bodyMd: string,
  presentOpts: PresentOpts,
): { sections?: ReturnType<typeof selectSections> } {
  if (presentOpts.sectionsBudget === null) return {};
  return { sections: selectSections(splitSections(bodyMd), presentOpts.sectionsBudget) };
}

function present(
  saved: SavedDelivery,
  bodyMd: string,
  purchase: PurchaseInfo | undefined,
  presentOpts: PresentOpts,
): CommandResult {
  const r = saved.receipt;
  const title = sanitizeForTerminal(r.title);
  const human =
    r.entitlement === 'purchased'
      ? `Bought ${title} for ${toMoney(r.priceAtomic).usd} USD → ${saved.bodyPath}`
      : r.entitlement === 'entitled'
        ? `Re-read ${title} free (already owned) → ${saved.bodyPath}`
        : `Read ${title} free → ${saved.bodyPath}`;
  return {
    data: {
      resourceId: r.resourceId,
      slug: r.slug,
      title: r.title,
      url: r.url,
      entitlement: r.entitlement,
      price: toMoney(r.priceAtomic),
      ...(purchase !== undefined ? { paid: toMoney(purchase.paidAtomic.toString()) } : {}),
      ...(r.settlementTxHash !== undefined ? { settlementTxHash: r.settlementTxHash } : {}),
      contentHash: r.contentHash,
      bodyPath: saved.bodyPath,
      headings: headingOutline(bodyMd),
      ...(presentOpts.printBody ? { body: bodyMd } : {}),
      ...sectionsField(bodyMd, presentOpts),
    },
    humanLines: [human],
  };
}

function creatorFrom(preview: Preview): string {
  const creator = preview.creator;
  if (creator !== undefined) {
    const handle = creator.handle;
    const wallet = creator.walletAddress;
    if (typeof handle === 'string' && handle.length > 0) return handle;
    if (typeof wallet === 'string' && wallet.length > 0) return wallet;
  }
  return '';
}

function policyFix(reason: string): string {
  switch (reason) {
    case 'price_cap_exceeded':
      return 'Raise --max-price if this price is acceptable.';
    case 'not_allowlisted':
      return 'Add the creator to allowlistCreators, or clear the allowlist.';
    case 'session_budget_exceeded':
      return 'Raise sessionBudget with `tenjin config set sessionBudget <usd>`, or wait for the window to roll over.';
    default:
      return 'Adjust your spend policy with `tenjin config set`.';
  }
}

async function confirmSpend(
  ctx: CommandContext,
  deps: BuyDeps,
  yes: boolean,
  amountAtomic: bigint,
  creator: string,
): Promise<boolean> {
  if (yes) return true;
  // The creator label is server-controlled: sanitize so escape sequences cannot
  // repaint the price the human is approving. The price renders last.
  const prompt = `Pay ${toMoney(amountAtomic.toString()).usd} USD to ${sanitizeForTerminal(creator) || 'this creator'}? [y/N] `;
  if (deps.confirm !== undefined) return deps.confirm(prompt);
  if (!ctx.io.isTTY) return false; // non-interactive without --yes: refuse (exit 3)
  // The real prompt reads stdin, so stdin must be interactive too: at EOF the
  // question could never be answered and the process would exit with no answer.
  if (!process.stdin.isTTY) return false;
  return promptYesNo(prompt);
}

/** stdin closing mid-prompt (ctrl-D) resolves as decline, never a hang. */
function promptYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.once('close', () => settle(false));
    rl.question(prompt, (answer) => settle(/^y(es)?$/i.test(answer.trim())));
  });
}
