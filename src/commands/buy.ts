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
  headingOutline,
  saveDelivery,
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
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin buy <resource-url-or-id>` — the paid read. The ordering is the whole
 * point and is enforced here, never in the wallet:
 *   1. local library (already delivered → re-deliver from disk, no network, no pay)
 *   2. first GET → a FREE resource delivers immediately (no wallet)
 *   3. a PAID resource: SIWX-authenticated re-read FIRST — an entitled wallet
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
  const maxPriceAtomic =
    args.maxPrice !== undefined ? BigInt(parseUsdToAtomic(args.maxPrice)) : undefined;
  const ref = await resolveResourceRef(args.ref, ctx.dataDir);

  // 1. Library idempotence: a known-id resource already on disk re-delivers with
  //    zero network and zero spend.
  if (ref.resourceId !== undefined) {
    const delivered = await findDelivered(ctx.dataDir, ref.resourceId);
    if (delivered !== null) {
      return deliverExisting(delivered, args.printBody === true);
    }
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
    return await deliverFresh(ctx, ref.url, first.body, 'free', undefined, args.printBody === true);
  }
  if (first.kind === 'already_purchased') {
    // A plain GET does not carry a payment header, so the read route cannot answer
    // the owned-re-pay 409 here; the contract makes this unreachable. Fail loudly
    // rather than guess a chain for a SIWX recovery.
    throw new CliError('API_UNREACHABLE', 'Unexpected 409 on an unauthenticated read.', {
      fix: 'Retry; if it persists, update tenjin-cli.',
    });
  }

  // A paid resource. From here a wallet is required.
  const paymentRequired = first.paymentRequired;
  const requirement = paymentRequired.accepts[0];
  if (requirement === undefined) {
    throw new CliError('PAYMENT_FAILED', 'The 402 advertised no payment requirements.', {
      fix: 'Try another candidate; this resource looks misconfigured.',
    });
  }
  const network = requirement.network;
  const amountAtomic = BigInt(requirement.amount);
  const creator = creatorFrom(first.preview);

  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  // describeWallet surfaces WALLET_MISSING with its own fix if no wallet exists.
  await describeWallet(provider);
  const signer = await provider.getSigner();

  // 3. Entitlement re-check FIRST (SIWX): an entitled wallet re-reads free.
  const siwxHeader = await buildSiwxHeader(signer, { baseUrl: settings.baseUrl, chainId: network });
  const recheck = await fetchRead(ref.url, { ...fetchOpts, siwxHeader });
  if (recheck.kind === 'entitled') {
    return await deliverFresh(
      ctx,
      ref.url,
      recheck.body,
      'entitled',
      undefined,
      args.printBody === true,
    );
  }

  // 4. Genuinely unentitled: spend policy, provider-side, BEFORE any payment.
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
  if (authorization.decision === 'confirm') {
    const approved = await confirmSpend(ctx, deps, args.yes === true, amountAtomic, creator);
    if (!approved) {
      throw new CliError('POLICY_REFUSED', 'Purchase not confirmed.', {
        fix: 'Re-run with --yes, or set a policy that auto-approves this spend.',
        details: { reason: authorization.reason, amountAtomic: amountAtomic.toString() },
      });
    }
  }

  // 5. Pay: build the exact-scheme authorization and re-request with it.
  const payment = await buildExactPayment(paymentRequired, signer);
  const paid = await fetchRead(ref.url, { ...fetchOpts, paymentHeaders: payment.headers });

  if (paid.kind === 'entitled') {
    await authorizer.commit(payment.amountAtomic);
    return await deliverFresh(
      ctx,
      ref.url,
      paid.body,
      'purchased',
      { paidAtomic: payment.amountAtomic, settlementTxHash: paid.settlementTxHash },
      args.printBody === true,
    );
  }
  if (paid.kind === 'already_purchased') {
    // The owned-re-pay gate fired: nothing charged. Recover the body free via SIWX.
    return await siwxRedeliver(
      ctx,
      ref.url,
      settings.baseUrl,
      signer,
      fetchOpts,
      args.printBody === true,
      network,
    );
  }
  // Still 402 after paying: the payment was not accepted.
  throw new CliError('PAYMENT_FAILED', 'Payment was not accepted by the read route.', {
    fix: 'Check the wallet balance and network, then retry.',
    details: paid.paymentRequired.error,
  });
}

interface PurchaseInfo {
  paidAtomic: bigint;
  settlementTxHash?: string;
}

async function deliverFresh(
  ctx: CommandContext,
  url: string,
  body: ReadBody,
  entitlement: Entitlement,
  purchase: PurchaseInfo | undefined,
  printBody: boolean,
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
  return present(saved, body.bodyMd, purchase, printBody);
}

async function siwxRedeliver(
  ctx: CommandContext,
  url: string,
  baseUrl: string,
  signer: TenjinSigner,
  fetchOpts: { timeoutMs: number; fetchImpl?: typeof fetch; lookupId?: string },
  printBody: boolean,
  network: string,
): Promise<CommandResult> {
  const siwxHeader = await buildSiwxHeader(signer, { baseUrl, chainId: network });
  const res = await fetchRead(url, { ...fetchOpts, siwxHeader });
  if (res.kind !== 'entitled') {
    throw new CliError('PAYMENT_FAILED', 'The resource is owned but could not be re-read.', {
      fix: 'Retry; if it persists the entitlement may not have propagated yet.',
    });
  }
  return await deliverFresh(ctx, url, res.body, 'entitled', undefined, printBody);
}

/** Re-deliver from an existing on-disk receipt (no network, no spend). */
function deliverExisting(
  delivered: { receipt: import('../lib/library').Receipt; bodyMd: string; bodyPath: string },
  printBody: boolean,
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
      ...(printBody ? { body: delivered.bodyMd } : {}),
    },
    humanLines: [`Already in your library: ${r.title} (${delivered.bodyPath}). No payment made.`],
  };
}

function present(
  saved: SavedDelivery,
  bodyMd: string,
  purchase: PurchaseInfo | undefined,
  printBody: boolean,
): CommandResult {
  const r = saved.receipt;
  const human =
    r.entitlement === 'purchased'
      ? `Bought ${r.title} for ${toMoney(r.priceAtomic).usd} USD → ${saved.bodyPath}`
      : r.entitlement === 'entitled'
        ? `Re-read ${r.title} free (already owned) → ${saved.bodyPath}`
        : `Read ${r.title} free → ${saved.bodyPath}`;
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
      ...(printBody ? { body: bodyMd } : {}),
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
  const prompt = `Pay ${toMoney(amountAtomic.toString()).usd} USD to ${creator || 'this creator'}? [y/N] `;
  if (deps.confirm !== undefined) return deps.confirm(prompt);
  if (!ctx.io.isTTY) return false; // non-interactive without --yes: refuse (exit 3)
  return promptYesNo(prompt);
}

function promptYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}
