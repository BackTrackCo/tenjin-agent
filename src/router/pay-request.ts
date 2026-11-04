import { setTimeout as delay } from 'node:timers/promises';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { SIGN_IN_WITH_X } from '@x402/extensions/sign-in-with-x';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { verifyAgainstRegistries, type RegistryVerification } from '../lib/bazaar';
import { readUsdcBalanceWithFallback, type readUsdcBalance } from '../lib/usdc-balance';
import { assertPublicDestination, type DestinationOptions } from '../lib/destination';
import { CliError } from '../lib/errors';
import { validateResultBody, type ResultCheck } from '../lib/request-schema';
import { fetchFailureToCliError, httpRequest, requestHeaderProblem } from '../lib/http';
import type { FetchJsonFailure, HttpResponse } from '../lib/http';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import { mask } from '../lib/redact';
import { isSameDeployment } from '../lib/production-origin';
import { resolveContextSettings } from '../lib/settings';
import { SIWX_HEADER, buildSiwxHeader } from '../lib/siwx';
import { gateSpend } from '../lib/spend-gate';
import { spendSlot, type PlanSlot } from '../lib/spend-plan';
import type { ResolvedSettings } from '../lib/settings';
import {
  describeWallet,
  resolveSpendAuthorizer,
  resolveWalletProvider,
  type SpendAuthorizer,
  type WalletProvider,
} from '../lib/wallet';
import {
  buildExactPayment,
  createPayerClient,
  noPayableRequirement,
  selectPayableRequirement,
} from '../lib/x402-pay';
import type { x402Client } from '@x402/core/client';
import type { TenjinSigner } from '../lib/wallet/provider';
import type { CommandContext, CommandResult } from '../context';

/**
 * The payment engine: the x402 client every router call pays through, and the
 * one `tenjin pay <url>` (`commands/pay.ts`) runs for any paid endpoint. One
 * probe; a 2xx delivers free; a 402 runs the payment gate (automatic limits for
 * the router, consent for manual pay, hard price and creator checks for both)
 * and retries once with the `PAYMENT-SIGNATURE`. SIWX rides only when the 402
 * advertises sign-in-with-x, and the signature binds to the target origin, so
 * an entitled wallet re-reads free while nothing origin-bound leaks elsewhere.
 *
 * Direct third-party payments need registry warnings acknowledged. Router
 * calls keep their advertised-term checks and are signed only against their
 * call's spend plan (`admit`). Every positive payment checks the signer's
 * balance before signing.
 */

const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';
/** x402 v1's name for the same header. */
const PAYMENT_RESPONSE_HEADER_V1 = 'X-PAYMENT-RESPONSE';

/** Terminal preview cap; `--print-body` lifts it. The machine body is never cut. */
const BODY_PREVIEW_CHARS = 1200;

/** A body as the terminal shows it: sanitized, and cut at
 *  {@link BODY_PREVIEW_CHARS} unless `printBody` lifts the cap. */
export function bodyPreview(text: string, printBody: boolean): string {
  const body = sanitizeForTerminal(text);
  return printBody || body.length <= BODY_PREVIEW_CHARS
    ? body
    : `${body.slice(0, BODY_PREVIEW_CHARS)}\n… truncated; run with --print-body or --json for the full body`;
}

/**
 * What a caller was told this endpoint costs, before the live 402 is seen. It
 * stands in for the registry lookup when the router's decision carries it, and
 * it is a ceiling, never a licence: the live requirement must match network
 * and asset exactly and may not exceed the amount.
 */
export interface AdvertisedTerms {
  /** Pins the deal's chain and token when the caller was told them. */
  network?: string;
  asset?: string;
  /**
   * A ceiling the caller was quoted, when there was one: a live 402 above it is
   * refused. It only ever refuses; the amount actually signed still meets
   * `maxAutoSpend` and `sessionBudget` in `gateSpend`, the payment authority.
   */
  maxAmountAtomic?: string;
  /** The advertised recipient, when the caller was given one. Checked exactly. */
  payTo?: string;
  /** Free-text provenance for the payee label, e.g. a registry name. */
  source?: string;
}

/** One request the engine pays, and the gates it is held to. `tenjin pay`'s
 *  own flags (`-H`, `--data`, `--data-raw`, `--quote`) are `commands/pay.ts`'s. */
export interface PayRequestArgs {
  url: string;
  /** GET, POST, PUT, PATCH or DELETE. GET by default, POST when a body is given. */
  method?: string;
  /** Decimal USD; the hard price cap, never bypassed by --yes. */
  maxPrice?: string;
  /** Bypass the interactive confirm only (never the price cap or a hard deny). */
  yes?: boolean;
  /** Acknowledge direct-payment registry warnings for this invocation only. */
  ignoreWarnings?: boolean;
  /** Internal router entrypoint; missing terms must never become direct pay. */
  execution?: 'router';
  /** Print the full body to the terminal instead of the capped preview. */
  printBody?: boolean;
  /** Advertised terms that replace the registry lookup on this call. */
  terms?: AdvertisedTerms;
  /**
   * Request headers a caller was handed rather than composed: the router's
   * provider leg sends the decision's own `accept` and `content-type`. Only
   * those two names are accepted, so nothing can smuggle a credential or a
   * payment header in beside the one this command signs.
   */
  headers?: Record<string, string>;
  /**
   * A catalog spec's fixed request headers, on the router's provider leg: the
   * same bar as `-H`, checked again here, and set under `headers`, so a spec
   * never replaces the leg's own `accept` or `content-type`.
   */
  specHeaders?: Record<string, string>;
  /** The router's body, already encoded; sent byte for byte. Needs POST, PUT or PATCH. */
  rawBody?: string;
  /** The provider's own deadline for each leg, from its spec, in place of
   *  `--timeout`: the probe's, and the least the paid leg waits. */
  timeoutMs?: number;
  /** The largest binary body kept, from the provider's spec; absent, the
   *  transport's own cap. */
  maxBytes?: number;
  /** The same-turn duplicate guard's identity for this request. */
  requestKey?: string;
  /**
   * The caller's application success rule for the delivered body. On a free or
   * entitled 2xx, a body that fails it is refused: nothing was paid. On the
   * paid leg the money already moved, so a body that fails the rule, or is too
   * large to check, still comes back, with `resultUnverified` and a
   * `resultCaveat` saying which.
   */
  resultSchema?: unknown;
  /**
   * The router's job seam: called once with the answer that delivered (free,
   * entitled or paid), or with a paid leg that timed out after its headers
   * came. A long job's status URL can be a header. Never part of `data`,
   * which `tenjin pay --json` prints.
   */
  onPaidLeg?: (leg: PaidLeg) => void;
  /**
   * The call's spend plan, which every router payment is signed against.
   * Handed the live price before the wallet is opened, it returns the plan's
   * slot for this payment (`lib/spend-plan.ts`) or throws the refusal.
   * Required in router mode: an unadmitted router payment sends nothing.
   */
  admit?: (amountAtomic: bigint) => Promise<PlanSlot>;
}

/** What {@link PayRequestArgs.onPaidLeg} is handed. */
export interface PaidLeg {
  status?: number;
  header?: (name: string) => string | undefined;
}

export interface PayDeps {
  fetchImpl?: typeof fetch;
  readBalance?: typeof readUsdcBalance;
  provider?: WalletProvider;
  authorizer?: SpendAuthorizer;
  confirm?: (prompt: string) => Promise<boolean>;
  /** Resolver seam for the destination preflight; production leaves it unset. */
  destination?: DestinationOptions;
}

export type Lane = 'tenjin' | 'bazaar';

/**
 * What `tenjin pay` composes itself, handed to {@link payRequest} and run at
 * its place in the flow, so its refusals keep their order among the others.
 * The router never passes one.
 */
export interface ManualRequest {
  /** `--data` or `--data-raw` was given: POST by default, and never GET or DELETE. */
  hasBody: boolean;
  /** The operator's `-H` headers and the request body, once the method is known. */
  resolve(): { headers: Record<string, string>; body: { jsonBody?: unknown; rawBody?: string } };
  /** `--quote`: the 402 reported as it came, in place of paying it. */
  quote?: (
    url: string,
    lane: Lane,
    res: HttpResponse,
    challenge: PaymentRequired,
    chosen: PaymentRequirements | undefined,
  ) => CommandResult;
}

type RegistryWarning = Exclude<RegistryVerification, { outcome: 'verified' | 'unlisted' }> & {
  acknowledged: boolean;
  quote: PaymentRequirements & { url: string };
};

export async function payRequest(
  args: PayRequestArgs,
  ctx: CommandContext,
  deps: PayDeps = {},
  manual?: ManualRequest,
): Promise<CommandResult> {
  const warnings: RegistryWarning[] = [];
  try {
    return await executePay(args, ctx, deps, warnings, manual);
  } catch (err) {
    if (err instanceof CliError && warnings.length > 0) {
      throw new CliError(err.code, err.message, {
        exitCode: err.exitCode,
        ...(err.fix !== undefined ? { fix: err.fix } : {}),
        details: {
          ...(typeof err.details === 'object' && err.details !== null ? err.details : {}),
          warnings,
        },
        cause: err,
      });
    }
    throw err;
  }
}

async function executePay(
  args: PayRequestArgs,
  ctx: CommandContext,
  deps: PayDeps,
  warnings: RegistryWarning[],
  manual: ManualRequest | undefined,
): Promise<CommandResult> {
  const router = args.execution === 'router' || args.terms !== undefined;
  if (router) {
    const terms = args.terms;
    if (
      args.ignoreWarnings === true ||
      !terms ||
      typeof terms.maxAmountAtomic !== 'string' ||
      !/^\d+$/.test(terms.maxAmountAtomic) ||
      [terms.network, terms.asset, terms.payTo, terms.source].some(
        (v) => v !== undefined && (typeof v !== 'string' || v.trim().length === 0),
      )
    ) {
      throw new CliError(
        'REFUSED',
        'Router payments require valid advertised terms and cannot acknowledge registry warnings.',
        { details: { reason: 'invalid_router_terms' } },
      );
    }
    if (args.admit === undefined) {
      throw new CliError(
        'REFUSED',
        "A router payment is signed only against its call's spend plan, and this one has none; nothing was sent.",
        { details: { reason: 'unplanned' } },
      );
    }
  }
  const settings = await resolveContextSettings(ctx);
  const maxPriceAtomic =
    args.maxPrice !== undefined ? BigInt(parseUsdToAtomic(args.maxPrice)) : undefined;
  // Filled once the wallet is opened; the payer client closes over it so
  // selection can run first without one.
  const openedSigner: { current?: TenjinSigner } = {};
  const url = args.url.trim();
  const lane = resolveLane(url, settings);
  // Before the probe, and only on the third-party lane: the configured base URL
  // may legitimately be local in development, while any other host was chosen
  // by something else and must prove it is not on this network.
  if (lane === 'bazaar') await assertPublicDestination(url, deps.destination ?? {});
  const method = resolveMethod(args, manual);
  const { headers: operator, body } = manual?.resolve() ?? {
    headers: {},
    body: args.rawBody !== undefined ? { rawBody: args.rawBody } : {},
  };
  const headers = {
    ...operator,
    ...specHeaders(args.specHeaders),
    ...callerHeaders(args.headers),
  };

  const legTimeoutMs = args.timeoutMs ?? ctx.flags.timeout;
  const fetchOpts = {
    timeoutMs: legTimeoutMs,
    // Both legs: the probe's 402 is money-path input, and the paid retry
    // carries a signed header (which pins redirects on its own; this pins the
    // probe too, so the challenge always comes from the URL that was gated).
    blockRedirects: true as const,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...body,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    // A router lookup can buy a file (a sound, an image): its bytes are kept
    // whole for the tool to save, never decoded as text.
    ...(router ? { binaryBody: true as const } : {}),
    ...(args.maxBytes !== undefined ? { maxBinaryBytes: args.maxBytes } : {}),
    method,
  };

  const probe = await httpRequest(url, fetchOpts);
  // The unpaid leg says so itself: the transport is shared with the paid retry
  // and asserts nothing about money either way.
  if (!probe.ok) {
    throw fetchFailureToCliError(probe, {
      fix: `Nothing was sent and nothing was paid. ${legFix(probe)}`,
    });
  }
  if (probe.status >= 200 && probe.status < 300) {
    const caveat = assertUsableResult(args.resultSchema, probe.text, probe.status, 'free');
    args.onPaidLeg?.({ status: probe.status, header: probe.header });
    return deliver(url, lane, probe, {
      paid: false,
      ...(caveat !== undefined ? { caveat } : {}),
      printBody: args.printBody === true,
    });
  }
  if (probe.status !== 402) {
    // The provider's own words, when it sent `{error: {message}}`: a free docs
    // lookup's 404 says no library matched. A 404 is the endpoint's answer, not
    // a transient failure, so it is never told to retry.
    const said = providerMessage(probe.json);
    throw new CliError(
      'API_UNREACHABLE',
      `${url} answered ${probe.status}${said === null ? '.' : `: ${said}`}`,
      {
        fix:
          probe.status === 404
            ? 'Nothing was paid. The same request will answer 404 again.'
            : 'Check the URL and the endpoint status, then retry.',
        details: { status: probe.status, body: probe.json, ...providerError(probe.text) },
      },
    );
  }

  const paymentRequired = decodeChallenge(probe, url);
  // The client is built before the wallet is opened: selection needs no key, so
  // an unpayable or unverifiable deal is refused before a signer exists.
  const payer = createPayerClient(() => signerOrThrow(openedSigner));
  const requirement = selectRequirement(payer.core, paymentRequired, args.terms);
  // `--quote` is a read: the 402 as it came, with the entry the paid path would
  // sign marked. No wallet is opened and nothing is signed.
  if (manual?.quote !== undefined) {
    return manual.quote(url, lane, probe, paymentRequired, requirement);
  }
  if (requirement === undefined) {
    throw noMatchingEntry(paymentRequired, args.terms);
  }
  // The first-seen amount: a later challenge may never cost more than this.
  const firstSeenAmount = BigInt(requirement.amount);
  const host = new URL(url).host;

  // Both checks run before the wallet is opened, so an unverifiable deal never
  // reaches a signer. Given terms bind on every lane, since a routing decision
  // can name the configured origin too; the registry check is the Bazaar lane's.
  let registry: string | undefined;
  let termsLabel: string | undefined;
  if (args.terms !== undefined) termsLabel = assertWithinTerms(args.terms, requirement);
  else if (lane === 'bazaar' && paymentRequired.extensions?.[SIGN_IN_WITH_X] === undefined) {
    registry = await checkRegistry(
      settings,
      url,
      requirement,
      ctx,
      args.ignoreWarnings === true,
      warnings,
    );
  }
  // The plan admits only a payment still needed. With no entitlement to check,
  // it is admitted here at the first-seen price, before the wallet is opened.
  // A sign-in-with-x seller is asked first, below, so a wallet that already
  // owns the result re-reads it free.
  const entitlement = paymentRequired.extensions?.[SIGN_IN_WITH_X] !== undefined;
  let slot = router && !entitlement ? await args.admit!(firstSeenAmount) : undefined;

  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  const signer = await openWallet(provider);
  openedSigner.current = signer;

  // Sign-in-with-x: an entitled wallet re-reads free before any payment exists,
  // and the re-check doubles as the fresh challenge the payment is built on.
  // The signature binds to the target origin (host-with-port), so a foreign
  // seller gets a credential worth nothing anywhere else.
  let effectiveChallenge = paymentRequired;
  let effectiveRequirement = requirement;
  if (entitlement) {
    const siwxHeader = await buildSiwxHeader(signer, {
      baseUrl: new URL(url).origin,
      chainId: requirement.network,
    });
    const recheck = await httpRequest(url, {
      ...fetchOpts,
      headers: { ...headers, [SIWX_HEADER]: siwxHeader },
    });
    if (!recheck.ok) throw fetchFailureToCliError(recheck);
    if (recheck.status >= 200 && recheck.status < 300) {
      const caveat = assertUsableResult(
        args.resultSchema,
        recheck.text,
        recheck.status,
        'entitled',
      );
      args.onPaidLeg?.({ status: recheck.status, header: recheck.header });
      return deliver(url, lane, recheck, {
        paid: false,
        entitled: true,
        ...(caveat !== undefined ? { caveat } : {}),
        printBody: args.printBody === true,
      });
    }
    if (recheck.status !== 402) {
      throw new CliError(
        'API_UNREACHABLE',
        `${url} answered ${recheck.status} on the entitlement re-check.`,
        {
          fix: 'Retry; if it persists the endpoint looks misconfigured.',
          details: { status: recheck.status, body: recheck.json, ...providerError(recheck.text) },
        },
      );
    }
    effectiveChallenge = decodeChallenge(recheck, url);
    const fresh = selectRequirement(payer.core, effectiveChallenge, args.terms);
    if (fresh === undefined) {
      throw noMatchingEntry(effectiveChallenge, args.terms);
    }
    // Refuse a price bump between the first look and signing.
    if (BigInt(fresh.amount) > firstSeenAmount) {
      throw new CliError('PAYMENT_FAILED', 'The price increased before signing; refusing to pay.', {
        fix: 'Re-run `tenjin pay` to review the new price, and set --max-price to cap it.',
        details: {
          firstSeenAtomic: firstSeenAmount.toString(),
          currentAtomic: fresh.amount,
        },
      });
    }
    if (
      fresh.scheme !== requirement.scheme ||
      fresh.network !== requirement.network ||
      fresh.asset.toLowerCase() !== requirement.asset.toLowerCase() ||
      fresh.payTo.toLowerCase() !== requirement.payTo.toLowerCase() ||
      JSON.stringify(fresh.extra) !== JSON.stringify(requirement.extra)
    ) {
      throw new CliError(
        'PAYMENT_FAILED',
        'The payment terms changed before signing; refusing to pay.',
        { fix: 'Review a fresh challenge before paying again.' },
      );
    }
    effectiveRequirement = fresh;
    // The challenge it will actually sign is checked again; the store usually
    // answers the registry question without a round trip.
    if (args.terms !== undefined) termsLabel = assertWithinTerms(args.terms, fresh);
    else if (lane === 'bazaar') {
      registry = await checkRegistry(
        settings,
        url,
        fresh,
        ctx,
        args.ignoreWarnings === true,
        warnings,
      );
    }
  }
  const amountAtomic = BigInt(effectiveRequirement.amount);
  if (router && entitlement) slot = await args.admit!(amountAtomic);
  if (router) {
    const refusal = spendSlot(slot, amountAtomic);
    if (refusal === 'above_plan') {
      throw new CliError(
        'PAYMENT_FAILED',
        `The live price ($${toMoney(amountAtomic.toString()).usd}) is above the $${toMoney(slot!.amountAtomic.toString()).usd} this call planned for it, so nothing was signed.`,
        {
          fix: 'Call again for a fresh plan at the new price.',
          details: {
            reason: 'above_plan',
            plannedAtomic: slot!.amountAtomic.toString(),
            live: { amount: amountAtomic.toString() },
          },
        },
      );
    }
    if (refusal !== null) {
      throw new CliError(
        'REFUSED',
        "A router payment is signed only against an unspent slot of its call's spend plan; nothing was signed.",
        { details: { reason: refusal } },
      );
    }
  }
  // A plan a person approved is theirs, like a manual payment: it may pass the
  // automatic limits and does not use up the automatic budget.
  const approved = slot?.approved === true;

  const authorizer = resolveSpendAuthorizer(
    ctx,
    settings.policy,
    deps.authorizer !== undefined ? { authorizer: deps.authorizer } : {},
  );
  // The host is the creator identity here: `allowlistCreators` users pin hosts.
  const verifiedVia = registry ?? termsLabel;
  const via = verifiedVia !== undefined ? ` (${sanitizeForTerminal(verifiedVia)})` : '';
  const mode = router && !approved ? 'automatic' : 'manual';
  const reservationId = await gateSpend({
    mode,
    ctx,
    authorizer,
    amountAtomic,
    creator: host,
    ...(maxPriceAtomic !== undefined ? { maxPriceAtomic } : {}),
    ...(args.requestKey !== undefined ? { requestKey: args.requestKey } : {}),
    yes: args.yes === true || approved,
    ...(deps.confirm !== undefined ? { confirm: deps.confirm } : {}),
    payeeLabel: `${sanitizeForTerminal(url)}${via}; recipient ${sanitizeForTerminal(effectiveRequirement.payTo)}, ${sanitizeForTerminal(effectiveRequirement.network)} / ${sanitizeForTerminal(effectiveRequirement.asset)}`,
  });

  // A failure before transmission releases the reservation: no signature
  // exists yet, so nothing can move. This is the last point where that holds.
  let payment: Awaited<ReturnType<typeof buildExactPayment>>;
  try {
    // The signed entry is the checked entry: the challenge is narrowed to the
    // selection everything above ran against, so a seller advertising several
    // chains cannot have one entry priced and another signed.
    await assertBalanceCovers(signer.address, amountAtomic, settings.rpcUrl, ctx, deps);
    payment = await buildExactPayment(effectiveChallenge, signer, effectiveRequirement);
  } catch (err) {
    await authorizer.release(reservationId);
    throw err;
  }

  // From here the signed EIP-3009 authorization leaves the process, and it is a
  // bearer instrument: the seller can settle it whatever it answers. So every
  // post-transmission outcome commits the reservation; releasing would let a
  // hostile seller answer 402 after each signature while sessionBudget counts
  // none of them. (httpRequest returns ok:false on transport failure.) A spec's
  // deadline may lengthen this leg, never shorten it.
  const paidTimeoutMs = paidLegTimeoutMs(
    effectiveRequirement,
    Math.max(legTimeoutMs, ctx.flags.timeout),
  );
  const paid = await httpRequest(url, {
    ...fetchOpts,
    timeoutMs: paidTimeoutMs,
    headers: { ...headers, ...payment.headers },
  });
  await authorizer.commit(reservationId, payment.amountAtomic, {
    mode,
    ...(payment.authorization !== undefined ? { nonce: payment.authorization.nonce } : {}),
  });
  if (paid.ok || paid.header !== undefined) {
    args.onPaidLeg?.({
      ...(paid.status !== undefined ? { status: paid.status } : {}),
      ...(paid.header !== undefined ? { header: paid.header } : {}),
    });
  }
  // A transport failure here is still post-transmission: the reservation is
  // committed, so the error carries the amount rather than claim nothing was
  // paid. The transport's reason and code survive; the fix is this leg's.
  if (!paid.ok) {
    // A long job that named where its result will be: point the agent there
    // rather than call it a failure. Settlement is unknown, as on any timeout.
    const statusUrl = paid.kind === 'timeout' ? statusUrlOf(paid, url) : null;
    if (statusUrl !== null) {
      throw new CliError(
        'NETWORK_ERROR',
        `The seller is still working on this: no result within ${Math.round(paidTimeoutMs / 1000)} s, and it named a status URL to check: ${statusUrl}`,
        {
          fix:
            'The authorization was transmitted and settlement is unknown until the job ends; it is recorded as transmitted exposure. ' +
            'Do not pay again: check the status URL for the result.',
          details: {
            statusUrl,
            amountAtomic: payment.amountAtomic.toString(),
            settlement: 'unknown',
            ...(payment.authorization !== undefined
              ? { authorization: payment.authorization }
              : {}),
          },
        },
      );
    }
    throw fetchFailureToCliError(paid, {
      fix:
        'The authorization was transmitted and settlement is unknown; it is recorded as transmitted exposure. ' +
        `Do not simply retry: each attempt signs a fresh authorization. ${legFix(paid)}`,
      details: {
        amountAtomic: payment.amountAtomic.toString(),
        settlement: 'unknown',
        ...(payment.authorization !== undefined ? { authorization: payment.authorization } : {}),
      },
    });
  }
  if (paid.status >= 200 && paid.status < 300) {
    let caveat: string | undefined;
    if (args.resultSchema !== undefined) {
      const check = validateResultBody(args.resultSchema, paid.text);
      // A paid body is always delivered: the money moved, so the success rule
      // flags the body, never withholds it. Too large to check, or checked and
      // failed, it comes back whole with a caveat that says which.
      if (check.unvalidated === true) caveat = unvalidatedCaveat(check);
      else if (!check.valid) caveat = failedRuleCaveat(check);
    }
    return deliver(url, lane, paid, {
      paid: true,
      warnings,
      amountAtomic: payment.amountAtomic,
      requirement: effectiveRequirement,
      ...(payment.authorization !== undefined ? { authorization: payment.authorization } : {}),
      ...(registry !== undefined ? { registry } : {}),
      ...(caveat !== undefined ? { caveat } : {}),
      printBody: args.printBody === true,
    });
  }
  // Still 402 or anything else: nothing was delivered, but the seller holds a
  // live authorization, so the amount stays counted and the fix must not coach
  // a retry loop, since each retry signs a fresh authorization. A seller that
  // says it did not settle is quoted from its payment-response header (its body
  // can be `{}`); the authorization stays valid, so settlement is still unknown.
  const refusal = settlementRefusal(paid);
  throw new CliError(
    'PAYMENT_FAILED',
    refusal !== undefined
      ? `The endpoint did not settle the payment${refusal.reason !== undefined ? `: ${refusal.reason.replace(/\.+$/, '')}` : ''}.`
      : paid.status === 402
        ? 'Payment was not accepted by the endpoint.'
        : `The endpoint answered ${paid.status} on the paid request; whether it settled is unknown.`,
    {
      fix:
        refusal !== undefined
          ? 'The seller reported that nothing settled, but the signed authorization stays valid until it expires, so it is recorded as transmitted exposure. Do not simply retry: each attempt signs a fresh authorization. Use a different service for this.'
          : 'The signed payment already left and is recorded as transmitted exposure; the endpoint may still settle it. Do not simply retry: each attempt signs a fresh authorization. Verify the endpoint (and this listing, if Bazaar) before paying again.',
      // The amount rides on the failure so a caller reports what is at risk.
      details: {
        status: paid.status,
        body: paid.json,
        ...providerError(paid.text),
        ...(refusal?.reason !== undefined ? { settlementError: refusal.reason } : {}),
        amountAtomic: payment.amountAtomic.toString(),
        settlement: 'unknown',
        ...(payment.authorization !== undefined ? { authorization: payment.authorization } : {}),
      },
    },
  );
}

/**
 * The paid leg waits as long as the seller said it would take, within reason:
 * the authorization is already out, so a client timeout abandons money the
 * seller can still settle. The requirement's `maxTimeoutSeconds` is clamped to
 * this cap so a hostile seller cannot hang the caller, and never shortens
 * `--timeout` or a spec's `timeoutS`.
 */
export const MAX_PAID_LEG_TIMEOUT_MS = 120_000;

export function paidLegTimeoutMs(requirement: PaymentRequirements, cliTimeoutMs: number): number {
  const advertised = requirement.maxTimeoutSeconds;
  if (typeof advertised !== 'number' || !Number.isFinite(advertised) || advertised <= 0) {
    return cliTimeoutMs;
  }
  return Math.max(cliTimeoutMs, Math.min(advertised * 1000, MAX_PAID_LEG_TIMEOUT_MS));
}

/**
 * The wallet holds the amount, read live, or a refusal before anything is
 * signed. Never the cached balance: a minute-old read can count funds the
 * wallet has since spent.
 */
async function assertBalanceCovers(
  address: string,
  amountAtomic: bigint,
  rpcUrl: string,
  ctx: CommandContext,
  deps: PayDeps,
): Promise<void> {
  if (amountAtomic <= 0n) return;
  // One retry across a rate-limit interval, within the original read deadline.
  const deadline = Date.now() + ctx.flags.timeout;
  const readBalance = deps.readBalance ?? readUsdcBalanceWithFallback;
  let balance = await readBalance(address, rpcUrl, {
    timeoutMs: Math.max(1, Math.floor(ctx.flags.timeout / 2)),
  });
  if (balance === null && Date.now() < deadline) {
    await delay(Math.min(1100, Math.floor((deadline - Date.now()) / 2)));
    const remaining = deadline - Date.now();
    if (remaining > 0) balance = await readBalance(address, rpcUrl, { timeoutMs: remaining });
  }
  if (balance === null) {
    throw new CliError('REFUSED', 'The wallet balance could not be read; no payment was signed.', {
      fix: 'Check the configured Base rpcUrl and retry when it is available.',
      details: { reason: 'balance_unavailable', address },
    });
  }
  if (balance < amountAtomic) {
    const short = toMoney((amountAtomic - balance).toString()).usd;
    throw new CliError(
      'REFUSED',
      `The wallet has insufficient USDC; no payment was signed. It holds ${toMoney(balance.toString()).usd} USD and this costs ${toMoney(amountAtomic.toString()).usd} USD: ${short} USD short.`,
      {
        fix: `Fund this wallet on Base with \`tenjin wallet fund\` (at least ${short} USD more) before paying.`,
        details: {
          reason: 'insufficient_funds',
          address,
          balanceAtomic: balance.toString(),
          requiredAtomic: amountAtomic.toString(),
        },
      },
    );
  }
}

/**
 * What a router call will cost, from one unpaid probe: the live 402's amount on
 * the entry this call would sign, held to the advertised terms, with nothing
 * signed or reserved. Several takes of one call are checked at it rather than
 * at the spec's ceiling, so a price that varies by input is quoted for this
 * input. A 2xx probe, or a sign-in-with-x wallet that already owns the result,
 * quotes 0. Every refusal is the paid leg's own.
 */
export async function quoteRouterCall(
  args: Pick<
    PayRequestArgs,
    'url' | 'method' | 'headers' | 'specHeaders' | 'rawBody' | 'timeoutMs'
  > & {
    terms: AdvertisedTerms;
  },
  ctx: CommandContext,
  deps: PayDeps = {},
): Promise<bigint> {
  const settings = await resolveContextSettings(ctx);
  const url = args.url.trim();
  if (resolveLane(url, settings) === 'bazaar') {
    await assertPublicDestination(url, deps.destination ?? {});
  }
  const headers = { ...specHeaders(args.specHeaders), ...callerHeaders(args.headers) };
  const probe = await httpRequest(url, {
    timeoutMs: args.timeoutMs ?? ctx.flags.timeout,
    blockRedirects: true,
    binaryBody: true,
    method: resolveMethod(args),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(args.rawBody !== undefined ? { rawBody: args.rawBody } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
  if (!probe.ok) {
    throw fetchFailureToCliError(probe, {
      fix: `Nothing was sent and nothing was paid. ${legFix(probe)}`,
    });
  }
  if (probe.status >= 200 && probe.status < 300) return 0n;
  if (probe.status !== 402) {
    const said = providerMessage(probe.json);
    throw new CliError(
      'API_UNREACHABLE',
      `${url} answered ${probe.status}${said === null ? '.' : `: ${said}`}`,
      {
        fix: 'Nothing was paid.',
        details: { status: probe.status, body: probe.json, ...providerError(probe.text) },
      },
    );
  }
  const challenge = decodeChallenge(probe, url);
  const payer = createPayerClient(() => signerOrThrow({}));
  const requirement = selectRequirement(payer.core, challenge, args.terms);
  if (requirement === undefined) throw noMatchingEntry(challenge, args.terms);
  assertWithinTerms(args.terms, requirement);
  if (challenge.extensions?.[SIGN_IN_WITH_X] === undefined) return BigInt(requirement.amount);
  const signer = await openWallet(
    resolveWalletProvider(ctx, deps.provider !== undefined ? { provider: deps.provider } : {}),
  );
  const recheck = await httpRequest(url, {
    timeoutMs: args.timeoutMs ?? ctx.flags.timeout,
    blockRedirects: true,
    binaryBody: true,
    method: resolveMethod(args),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(args.rawBody !== undefined ? { rawBody: args.rawBody } : {}),
    headers: {
      ...headers,
      [SIWX_HEADER]: await buildSiwxHeader(signer, {
        baseUrl: new URL(url).origin,
        chainId: requirement.network,
      }),
    },
  });
  if (!recheck.ok) throw fetchFailureToCliError(recheck);
  if (recheck.status >= 200 && recheck.status < 300) return 0n;
  if (recheck.status !== 402) {
    throw new CliError(
      'API_UNREACHABLE',
      `${url} answered ${recheck.status} on the entitlement re-check.`,
      {
        fix: 'Nothing was paid.',
        details: { status: recheck.status, body: recheck.json, ...providerError(recheck.text) },
      },
    );
  }
  const fresh = decodeChallenge(recheck, url);
  const owed = selectRequirement(payer.core, fresh, args.terms);
  if (owed === undefined) throw noMatchingEntry(fresh, args.terms);
  assertWithinTerms(args.terms, owed);
  return BigInt(owed.amount);
}

/** Which lane may pay this URL, or the exact refusal. */
function resolveLane(url: string, settings: ResolvedSettings): Lane {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new CliError('USAGE', `Invalid URL: ${JSON.stringify(url)}`, {
      fix: 'Pass an absolute http(s) URL.',
    });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new CliError('USAGE', `URL must be http or https: ${JSON.stringify(url)}`, {
      fix: 'Pass an absolute http(s) URL.',
    });
  }
  // Same deployment, not merely the same spelling, so the deployment's other
  // origin never falls through to the Bazaar lane's third-party rules.
  if (isSameDeployment(target.origin, new URL(settings.baseUrl).origin)) return 'tenjin';
  if (target.protocol !== 'https:') {
    throw new CliError('USAGE', 'The Bazaar lane pays https endpoints only.', {
      fix: 'Use a public HTTPS endpoint.',
    });
  }
  return 'bazaar';
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const METHODS: ReadonlySet<string> = new Set<Method>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** The methods that carry a body. GET and DELETE never do here. */
const BODY_METHODS: ReadonlySet<string> = new Set<Method>(['POST', 'PUT', 'PATCH']);

type MethodArgs = Pick<PayRequestArgs, 'method' | 'rawBody'>;

function hasBody(args: MethodArgs, manual: ManualRequest | undefined): boolean {
  return manual?.hasBody === true || args.rawBody !== undefined;
}

function resolveMethod(args: MethodArgs, manual?: ManualRequest): Method {
  const method = args.method?.toUpperCase() ?? (hasBody(args, manual) ? 'POST' : 'GET');
  if (!METHODS.has(method)) {
    throw new CliError('USAGE', `Unsupported method ${JSON.stringify(args.method)}`, {
      fix: 'Use -X GET, POST, PUT, PATCH or DELETE.',
    });
  }
  if (hasBody(args, manual) && !BODY_METHODS.has(method)) {
    throw new CliError('USAGE', 'A request body needs -X POST, PUT or PATCH.', {
      fix: 'Drop the body, or pass -X POST, PUT or PATCH.',
    });
  }
  return method as Method;
}

/**
 * The router's headers, or a refusal. Two names only: a decision composes
 * `accept` and `content-type`, and everything else on this request is either
 * this command's to set (the payment signature, the user agent) or the
 * operator's through `-H`.
 */
function callerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (headers === undefined) return {};
  const allowed = new Set(['accept', 'content-type']);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowered = name.toLowerCase();
    if (!allowed.has(lowered) || value.length > 1_024 || /[\r\n]/.test(value)) {
      throw new CliError(
        'USAGE',
        `This command will not send the header ${JSON.stringify(name)}.`,
        {
          fix: 'Only bounded accept and content-type headers ride on a paid request.',
        },
      );
    }
    out[lowered] = value;
  }
  return out;
}

/**
 * A catalog spec's fixed headers, or a refusal. The spec was checked when its
 * request was built; this is the last stop before the wire, so the same
 * check runs again.
 */
function specHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (headers === undefined) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (requestHeaderProblem(name, value) !== null) {
      throw new CliError(
        'USAGE',
        `This command will not send the header ${JSON.stringify(name)}.`,
        {
          fix: 'A spec header is a bounded, single-line value, and never a payment, sign-in, bypass or transport header.',
        },
      );
    }
    out[name.toLowerCase()] = value;
  }
  return out;
}

function decodeChallenge(res: HttpResponse, url: string): PaymentRequired {
  const encoded = res.header(PAYMENT_REQUIRED_HEADER);
  if (encoded === undefined) {
    throw new CliError(
      'CONTRACT_MISMATCH',
      `The 402 from ${url} carried no PAYMENT-REQUIRED header.`,
      {
        fix: 'The endpoint does not speak x402 v2; nothing was paid.',
      },
    );
  }
  try {
    return decodePaymentRequiredHeader(encoded);
  } catch (err) {
    throw new CliError('CONTRACT_MISMATCH', 'Could not decode the PAYMENT-REQUIRED header.', {
      cause: err,
    });
  }
}

/**
 * The caller's success rule, on every unpaid delivery: a body that fails it is
 * not a result, whether it arrived free or by entitlement. Returns the caveat
 * for a body the rule could not run against, so every branch treats an
 * over-limit body the same way; `undefined` when the rule passed or there was
 * none.
 */
function assertUsableResult(
  schema: unknown,
  body: string,
  status: number,
  how: 'free' | 'entitled',
): string | undefined {
  if (schema === undefined) return undefined;
  const check = validateResultBody(schema, body);
  if (check.valid) return undefined;
  if (check.unvalidated === true) return unvalidatedCaveat(check);
  throw new CliError('CONTRACT_MISMATCH', 'The response is not a usable result.', {
    fix: `Nothing was paid on this ${how} delivery. The endpoint answered ${status} with a body that fails the success rule it was asked under.`,
    details: {
      status,
      reason: check.reason,
      ...(check.diagnosis !== undefined ? { diagnosis: check.diagnosis } : {}),
      paid: false,
    },
  });
}

/**
 * What the caller is told instead of a refusal when the success rule could not
 * run. It rides in the result, not a log, because the agent reading the
 * envelope is the one that has to discount it.
 */
function unvalidatedCaveat(check: ResultCheck): string {
  return `${check.reason ?? 'The result could not be validated.'} The body is delivered unverified: its shape was never checked against the success rule.`;
}

/** What the caller is told when a paid body was checked and missed its success
 *  rule: the rule that failed, and that the body is handed back unverified. */
function failedRuleCaveat(check: ResultCheck): string {
  return `${check.reason ?? 'The result does not satisfy its success schema.'} The payment settled, so the body is delivered as received, unverified: treat it as possibly not the answer that was paid for.`;
}

/**
 * Headers a seller sends with the first byte of a long job to say where its
 * result can be checked. Treza sends `X-Status-Url`; another seller's name for
 * the same thing goes here.
 */
const STATUS_URL_HEADERS = ['x-status-url'];

/** The https status URL a timed-out paid response named, resolved against the
 *  paid URL, or null. Its bytes are the seller's: bounded, https only, same host. */
function statusUrlOf(failure: FetchJsonFailure, requestUrl: string): string | null {
  for (const name of STATUS_URL_HEADERS) {
    const value = failure.header?.(name)?.trim();
    if (value === undefined || value.length === 0 || value.length > 2_048) continue;
    try {
      const status = new URL(value, requestUrl);
      if (status.protocol === 'https:' && status.host === new URL(requestUrl).host) {
        return status.toString();
      }
    } catch {
      // Not a URL: the next name, or the plain timeout.
    }
  }
  return null;
}

/** The transport's own remedy, when it has one, appended after the leg's
 *  payment sentence so the two never contradict each other. */
function legFix(failure: { kind: string }): string {
  return failure.kind === 'oversized-header'
    ? 'Raising `--max-http-header-size` on the node process that runs this CLI would let the header be read; that is an operator decision, not a default this build changes.'
    : '';
}

/** `{error: {message}}` from the provider, as one bounded plain line, or null.
 *  It reaches a model's context, so control characters do not survive. */
function providerMessage(body: unknown): string | null {
  const error = (body as { error?: unknown } | null | undefined)?.error;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') return null;
  const line = message
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return line.length > 0 ? line : null;
}

/** Cap on {@link providerError}: enough for a provider's reason, never its page. */
const PROVIDER_ERROR_CHARS = 500;

/**
 * Why the provider refused, in its own words: the first
 * {@link PROVIDER_ERROR_CHARS} characters of a non-2xx body, redacted and on
 * one plain line, whatever its type, since an HTML error page has no parsed
 * `body`. Other people's content, never instructions.
 */
function providerError(text: string): { providerError?: string } {
  const line = sellerLine(text);
  return line.length > 0 ? { providerError: line } : {};
}

/** Seller text as one plain, redacted line of at most
 *  {@link PROVIDER_ERROR_CHARS} characters; empty when nothing is left. */
export function sellerLine(text: string): string {
  // Masked in a window well past the cap, so a large page costs nothing and a
  // secret that starts inside the snippet is seen whole.
  const flat = sanitizeForTerminal(
    mask(text.slice(0, PROVIDER_ERROR_CHARS * 8)).replace(/\s+/g, ' '),
  ).trim();
  const chars = Array.from(flat);
  return chars.length <= PROVIDER_ERROR_CHARS
    ? flat
    : `${chars.slice(0, PROVIDER_ERROR_CHARS).join('')}…`;
}

/** Nothing this caller may pay: no entry at all, or none on the advertised
 *  scheme, network and asset. Refused before a signer is even opened. */
function noMatchingEntry(challenge: PaymentRequired, terms: AdvertisedTerms | undefined): CliError {
  // No terms, or terms that pinned no chain and no token: the 402 simply
  // advertises nothing this wallet can pay, which the shared refusal already
  // names in the SDK's own vocabulary.
  if (terms === undefined || (terms.network === undefined && terms.asset === undefined)) {
    return noPayableRequirement(challenge.accepts);
  }
  const advertised = challenge.accepts.map((a) => `${a.scheme}/${a.network}/${a.asset}`);
  return new CliError(
    'REGISTRY_MISMATCH',
    `The 402 advertises nothing on ${terms.network ?? 'any supported chain'} in ${terms.asset ?? 'any supported token'}, which is what this call was authorized against.`,
    {
      fix: 'Nothing was signed. The endpoint changed the deal since those terms were issued; ask for a fresh decision.',
      details: { advertised, terms },
    },
  );
}

/**
 * Which advertised entry this call is about, from the SDK's own selection
 * (`src/lib/x402-pay.ts`): the registered networks, the `exact` scheme and the
 * canonical-USDC policy, narrowed further by advertised terms when the caller
 * has them. Every paying path asks this one question, so a 402 that lists
 * seven entries cannot have one priced and another signed.
 */
function selectRequirement(
  core: x402Client,
  challenge: PaymentRequired,
  terms: AdvertisedTerms | undefined,
): PaymentRequirements | undefined {
  return selectPayableRequirement(
    core,
    challenge,
    terms === undefined ? undefined : { network: terms.network, asset: terms.asset },
  );
}

/**
 * The advertised-terms gate. Same shape of answer as the registry gate and the
 * same failure code, because it answers the same question: is the live 402 the
 * deal this call was authorized against? Exact on scheme, network and asset, at
 * most on the amount. Returns the label the payee line names.
 */
function assertWithinTerms(terms: AdvertisedTerms, requirement: PaymentRequirements): string {
  // Scheme, network and asset already matched: `selectRequirement` chose this
  // entry BY them. What is left is the deal's price and its destination.
  const overQuote =
    terms.maxAmountAtomic !== undefined &&
    BigInt(requirement.amount) > BigInt(terms.maxAmountAtomic);
  const mismatch = overQuote
    ? `amount ${requirement.amount} over the advertised ${terms.maxAmountAtomic ?? '0'}`
    : terms.payTo !== undefined && requirement.payTo.toLowerCase() !== terms.payTo.toLowerCase()
      ? `payTo ${requirement.payTo}`
      : undefined;
  if (mismatch !== undefined) {
    throw new CliError(
      'REGISTRY_MISMATCH',
      `The live 402 exceeds the terms this call was authorized against (${mismatch}).`,
      {
        fix: 'Nothing was signed. The endpoint changed its deal since those terms were issued; ask for a fresh decision.',
        details: { advertised: terms, live: requirement },
      },
    );
  }
  return terms.source ?? 'the advertised terms';
}

/** Registry evidence informs direct payments; only this invocation can acknowledge a warning. */
async function checkRegistry(
  settings: ResolvedSettings,
  url: string,
  requirement: PaymentRequirements,
  ctx: CommandContext,
  acknowledged: boolean,
  warnings: RegistryWarning[],
): Promise<string | undefined> {
  const verification = await verifyAgainstRegistries(
    settings.bazaarRegistries,
    url,
    requirement,
    ctx.flags.timeout,
    { dataDir: ctx.dataDir },
  );
  if (verification.outcome === 'verified') return verification.registry;
  if (verification.outcome === 'unlisted') return undefined;
  const warning: RegistryWarning = {
    ...verification,
    acknowledged,
    quote: { url, ...requirement },
  };
  warnings.push(warning);
  const message = warningMessage(warning);
  if (!ctx.flags.json) {
    ctx.io.stderr.write(
      `Live quote: ${sanitizeForTerminal(url)}; recipient ${sanitizeForTerminal(requirement.payTo)}; ${sanitizeForTerminal(requirement.network)} / ${sanitizeForTerminal(requirement.asset)}; ${toMoney(requirement.amount).usd} USD\n`,
    );
    ctx.io.stderr.write(
      `${sanitizeForTerminal(message)}${acknowledged ? ' (acknowledged for this invocation)' : ''}\n`,
    );
  }
  if (!acknowledged) {
    throw new CliError('REFUSED', message, {
      fix: 'Review the live quote and use --ignore-warnings to acknowledge this registry warning for this invocation. --yes only confirms payment; normal payment checks still apply.',
      details: { reason: 'registry_acknowledgement_required', quote: { url, ...requirement } },
    });
  }
  return undefined;
}

function warningMessage(warning: RegistryWarning): string {
  switch (warning.outcome) {
    case 'unavailable':
      return 'Registry warning: verification is unavailable or incomplete.';
    case 'mismatch':
      return `Registry warning: the live terms differ from ${warning.registry} (${warning.detail}).`;
  }
}

/** Discriminated on `paid`: a paid delivery always carries what it paid and to
 *  whom, so no branch ever reaches for an amount that might not be there. */
type DeliverOpts = {
  /** Set when the body is delivered unverified: the success rule could not run. */
  caveat?: string;
  warnings?: RegistryWarning[];
} & (
  | {
      paid: false;
      /** Free because the wallet was already entitled (SIWX), not free-of-price. */
      entitled?: boolean;
      printBody: boolean;
    }
  | {
      paid: true;
      amountAtomic: bigint;
      requirement: PaymentRequirements;
      authorization?: { from: string; nonce: string; validBefore: string };
      registry?: string;
      printBody: boolean;
    }
);

function deliver(url: string, lane: Lane, res: HttpResponse, opts: DeliverOpts): CommandResult {
  const settlementTxHash = opts.paid ? settlementTx(res) : undefined;
  const data = {
    url,
    lane,
    status: res.status,
    paid: opts.paid,
    ...(opts.warnings !== undefined ? { warnings: opts.warnings } : {}),
    ...(opts.paid
      ? {
          amountPaid: toMoney(opts.amountAtomic.toString()),
          payTo: opts.requirement.payTo,
          network: opts.requirement.network,
          asset: opts.requirement.asset,
          ...(opts.authorization !== undefined ? { authorization: opts.authorization } : {}),
          ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
        }
      : opts.entitled === true
        ? { entitled: true }
        : {}),
    ...(settlementTxHash !== undefined ? { settlementTxHash } : {}),
    // Beside the body, never instead of it. The flag is what a machine reads,
    // so a caller never has to match on prose to tell an unchecked body.
    ...(opts.caveat !== undefined ? { resultUnverified: true, resultCaveat: opts.caveat } : {}),
    // The body is the product: JSON when the endpoint spoke it, raw text always,
    // and the bytes themselves when it was a file.
    ...(res.json !== undefined ? { body: res.json } : {}),
    bodyText: res.text,
    ...(res.bytes !== undefined
      ? { bodyBytes: res.bytes, contentType: res.header('content-type') ?? '' }
      : {}),
  };
  const headline = opts.paid
    ? `paid ${toMoney(opts.amountAtomic.toString()).usd} USD to ${sanitizeForTerminal(new URL(url).host)}` +
      (settlementTxHash !== undefined ? ` (tx ${settlementTxHash})` : '')
    : opts.entitled === true
      ? `free (entitled, no charge)`
      : `free (${res.status}, no charge)`;
  const preview = bodyPreview(res.text, opts.printBody);
  return {
    data,
    humanLines: [
      headline,
      ...(opts.warnings ?? []).map(
        (w) => `${sanitizeForTerminal(warningMessage(w))} (acknowledged)`,
      ),
      ...(opts.caveat !== undefined ? [sanitizeForTerminal(opts.caveat)] : []),
      ...(preview.length > 0 ? [preview] : []),
    ],
  };
}

/**
 * The settlement transaction the payment-response header names (v2's
 * `PAYMENT-RESPONSE`, or v1's `X-PAYMENT-RESPONSE`): base64 JSON carrying
 * `transaction`. Read from the protocol header only, never the seller's body.
 */
export function settlementTx(res: Pick<HttpResponse, 'header'>): string | undefined {
  const tx = paymentResponse(res)?.transaction;
  return typeof tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(tx) ? tx : undefined;
}

/**
 * The seller's own word that it did not settle: its payment-response header
 * with `success: false`, and the `errorReason` (or `errorMessage`) it gave, as
 * one bounded redacted line. Seller text, never instructions. `undefined` when
 * the header is absent, unreadable or says it settled.
 */
function settlementRefusal(res: Pick<HttpResponse, 'header'>): { reason?: string } | undefined {
  const settle = paymentResponse(res);
  if (settle?.success !== false) return undefined;
  const said = [settle.errorReason, settle.errorMessage].find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
  const reason = said !== undefined ? sellerLine(said) : '';
  return reason.length > 0 ? { reason } : {};
}

/** The decoded payment-response header (v2's `PAYMENT-RESPONSE`, or v1's
 *  `X-PAYMENT-RESPONSE`) when it is a JSON object, else `undefined`. */
function paymentResponse(res: Pick<HttpResponse, 'header'>): Record<string, unknown> | undefined {
  const header = res.header(PAYMENT_RESPONSE_HEADER) ?? res.header(PAYMENT_RESPONSE_HEADER_V1);
  if (header === undefined) return undefined;
  try {
    const settle: unknown = decodePaymentResponseHeader(header);
    return typeof settle === 'object' && settle !== null
      ? (settle as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The wallet, opened, with a refusal from it marked as the wallet's
 * (`walletUnavailable`): a missing wallet, no passphrase where nothing can
 * prompt, or a key that will not decrypt. Otherwise the locked wallet's `USAGE`
 * reads like a refused destination's, and a caller reporting why nothing was
 * paid must tell the two apart.
 */
async function openWallet(provider: WalletProvider): Promise<TenjinSigner> {
  try {
    await describeWallet(provider); // WALLET_MISSING with its own fix if none exists
    return await provider.getSigner();
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    throw new CliError(err.code, err.message, {
      exitCode: err.exitCode,
      ...(err.fix !== undefined ? { fix: err.fix } : {}),
      details: {
        ...(typeof err.details === 'object' && err.details !== null ? err.details : {}),
        walletUnavailable: true,
      },
      cause: err,
    });
  }
}

/** The signer, once the wallet has been opened. Selection never reaches it. */
function signerOrThrow(held: { current?: TenjinSigner }): TenjinSigner {
  if (held.current === undefined) {
    throw new CliError('INTERNAL', 'The payment was built before the wallet was opened.');
  }
  return held.current;
}
