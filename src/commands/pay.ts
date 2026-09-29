import { setTimeout as delay } from 'node:timers/promises';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { SIGN_IN_WITH_X } from '@x402/extensions/sign-in-with-x';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { verifyAgainstRegistries, type RegistryVerification } from '../lib/bazaar';
import { readUsdcBalance } from '../lib/usdc-balance';
import { assertPublicDestination, type DestinationOptions } from '../lib/destination';
import { CliError } from '../lib/errors';
import { validateResultBody, type ResultCheck } from '../lib/request-schema';
import { fetchFailureToCliError, httpRequest } from '../lib/http';
import type { HttpResponse } from '../lib/http';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import { isSameDeployment } from '../lib/production-origin';
import { resolveContextSettings } from '../lib/settings';
import { SIWX_HEADER, buildSiwxHeader } from '../lib/siwx';
import { gateSpend } from '../lib/spend-gate';
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
 * `tenjin pay <url>`: the standard x402 client verb, for ANY paid endpoint
 * rather than marketplace pieces. One probe; a 2xx delivers free; a 402 runs
 * shared payment gate (automatic limits for the router, mandatory consent for
 * manual pay, hard price/creator checks for both) and retries once with the
 * `PAYMENT-SIGNATURE`. Deliberately NOT `buy`: no library idempotence (every
 * paid call pays; manual consent and optional `--max-price` are the brakes) and no
 * search attribution. SIWX rides ONLY when the 402 advertises the standard
 * sign-in-with-x extension, and the signature is bound to the TARGET origin
 * (never the configured deployment's), so an entitled wallet re-reads free at
 * any seller that supports it while nothing origin-bound can leak elsewhere.
 *
 * Direct third-party payments require acknowledgement of registry warnings.
 * Router calls retain their advertised-price and supplied-term hard checks.
 * Every positive payment checks the actual signer's balance before signing.
 */

const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

/** Terminal preview cap; `--print-body` lifts it. The machine body is never cut. */
const BODY_PREVIEW_CHARS = 1200;

/**
 * What a caller was told this endpoint costs, BEFORE the live 402 is seen. It
 * stands in for the registry lookup on a lane that has one from elsewhere (the
 * router's paid decision carries it), and it is a ceiling, never a licence: the
 * live requirement has to match the network and asset exactly and may not
 * exceed the amount. Direct calls without offered terms use registry warning acknowledgement.
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

export interface PayArgs {
  url: string;
  /** GET (default) or POST; POST is implied when --data is given. */
  method?: string;
  /** A JSON request body; content-type is always application/json. */
  data?: string;
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
  /** A body the caller already encoded; sent byte for byte. Needs `-X POST`. */
  rawBody?: string;
  /** The same-turn duplicate guard's identity for this request. */
  requestKey?: string;
  /**
   * The caller's APPLICATION success rule for the delivered body. On a free or
   * entitled 2xx, a body that fails it is refused: nothing was paid. On the
   * PAID leg the money already moved, so the body is always delivered: one
   * that fails the rule, or that is past this client's own validation limit so
   * the rule never ran, comes back with `resultUnverified` and a
   * `resultCaveat` saying which.
   */
  resultSchema?: unknown;
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

type Lane = 'tenjin' | 'bazaar';

type RegistryWarning = Exclude<RegistryVerification, { outcome: 'verified' | 'unlisted' }> & {
  acknowledged: boolean;
  quote: PaymentRequirements & { url: string };
};

export async function runPay(
  args: PayArgs,
  ctx: CommandContext,
  deps: PayDeps = {},
): Promise<CommandResult> {
  const warnings: RegistryWarning[] = [];
  try {
    return await executePay(args, ctx, deps, warnings);
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
  args: PayArgs,
  ctx: CommandContext,
  deps: PayDeps,
  warnings: RegistryWarning[],
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
  }
  const settings = await resolveContextSettings(ctx);
  const maxPriceAtomic =
    args.maxPrice !== undefined ? BigInt(parseUsdToAtomic(args.maxPrice)) : undefined;
  // Filled once the wallet is opened; the payer client closes over it so
  // selection can run first without one.
  const openedSigner: { current?: TenjinSigner } = {};
  const url = args.url.trim();
  const lane = resolveLane(url, settings);
  // BEFORE the probe, and only on the third-party lane: the configured base URL
  // is the operator's own deployment and is legitimately a local origin in
  // development, while any other host is a destination something else chose, so
  // that is the one that has to prove it is not on this network.
  if (lane === 'bazaar') await assertPublicDestination(url, deps.destination ?? {});
  const method = resolveMethod(args);
  const jsonBody = parseBody(args.data);
  const headers = callerHeaders(args.headers);

  const fetchOpts = {
    timeoutMs: ctx.flags.timeout,
    // Both legs: the probe's 402 is money-path input, and the paid retry
    // carries a signed header (which pins redirects on its own; this pins the
    // probe too, so the challenge always comes from the URL that was gated).
    blockRedirects: true as const,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(jsonBody !== undefined ? { jsonBody } : {}),
    ...(jsonBody === undefined && args.rawBody !== undefined ? { rawBody: args.rawBody } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
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
    return deliver(url, lane, probe, {
      paid: false,
      ...(caveat !== undefined ? { caveat } : {}),
      printBody: args.printBody === true,
    });
  }
  if (probe.status !== 402) {
    // THE PROVIDER'S OWN WORDS, when it sent `{error: {message}}`: a free docs
    // lookup's 404 says no library matched and to use your own tools, which a
    // bare status line turned into "retry". A 404 is the endpoint's answer, not
    // a transient failure, so it is never told to retry either.
    const said = providerMessage(probe.json);
    throw new CliError(
      'API_UNREACHABLE',
      `${url} answered ${probe.status}${said === null ? '.' : `: ${said}`}`,
      {
        fix:
          probe.status === 404
            ? 'Nothing was paid. The same request will answer 404 again.'
            : 'Check the URL and the endpoint status, then retry.',
        details: { status: probe.status, body: probe.json },
      },
    );
  }

  const paymentRequired = decodeChallenge(probe, url);
  // The client is built BEFORE the wallet is opened on purpose: selection needs
  // only the registered networks and the policies, never a key, so an
  // unpayable or unverifiable deal is refused before a signer exists.
  const payer = createPayerClient(() => signerOrThrow(openedSigner));
  const requirement = selectRequirement(payer.core, paymentRequired, args.terms);
  if (requirement === undefined) {
    throw noMatchingEntry(paymentRequired, args.terms);
  }
  // The FIRST-SEEN amount: a later challenge may never cost more than this.
  const firstSeenAmount = BigInt(requirement.amount);
  const host = new URL(url).host;

  // Both checks run BEFORE the wallet is even opened: an unverifiable deal must
  // not reach a signer. Terms a caller was given bind on EVERY lane, since a
  // routing decision can name a contract on the configured origin too; the
  // registry check is the Bazaar lane's own.
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

  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  await describeWallet(provider); // WALLET_MISSING with its own fix if none exists
  const signer = await provider.getSigner();
  openedSigner.current = signer;

  // The standard sign-in-with-x extension, same sequence as `buy`: when the 402
  // advertises it, an entitled wallet re-reads FREE before any payment exists,
  // and the re-check doubles as the fresh-challenge refetch the payment is
  // built against. The signature binds to the TARGET origin (host-with-port),
  // so a foreign seller gets a credential worth nothing anywhere else.
  let effectiveChallenge = paymentRequired;
  let effectiveRequirement = requirement;
  if (paymentRequired.extensions?.[SIGN_IN_WITH_X] !== undefined) {
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
          details: { status: recheck.status, body: recheck.json },
        },
      );
    }
    effectiveChallenge = decodeChallenge(recheck, url);
    const fresh = selectRequirement(payer.core, effectiveChallenge, args.terms);
    if (fresh === undefined) {
      throw noMatchingEntry(effectiveChallenge, args.terms);
    }
    // Refuse a price bump between the first look and signing, exactly as `buy`.
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
    // The challenge it will actually SIGN is checked again: the store answers
    // the registry question without a network round trip in the common case.
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

  const authorizer = resolveSpendAuthorizer(
    ctx,
    settings.policy,
    deps.authorizer !== undefined ? { authorizer: deps.authorizer } : {},
  );
  // The host is the creator identity here (`allowlistCreators` users pin
  // hosts); the gate itself is shared with `buy` so the two verbs cannot drift.
  const verifiedVia = registry ?? termsLabel;
  const via = verifiedVia !== undefined ? ` (${sanitizeForTerminal(verifiedVia)})` : '';
  const mode = router ? 'automatic' : 'manual';
  const reservationId = await gateSpend({
    mode,
    ctx,
    authorizer,
    amountAtomic,
    creator: host,
    ...(maxPriceAtomic !== undefined ? { maxPriceAtomic } : {}),
    ...(args.requestKey !== undefined ? { requestKey: args.requestKey } : {}),
    yes: args.yes === true,
    ...(deps.confirm !== undefined ? { confirm: deps.confirm } : {}),
    payeeLabel: `${sanitizeForTerminal(url)}${via}; recipient ${sanitizeForTerminal(effectiveRequirement.payTo)}, ${sanitizeForTerminal(effectiveRequirement.network)} / ${sanitizeForTerminal(effectiveRequirement.asset)}`,
    allowlistSubject: 'this host',
    notConfirmedMessage: 'Payment not confirmed.',
  });

  // A failure BEFORE transmission (the build) releases: no signature exists,
  // nothing can move. That is the last point where releasing is honest.
  let payment: Awaited<ReturnType<typeof buildExactPayment>>;
  try {
    // The SIGNED entry is the CHECKED entry, by construction: the challenge is
    // narrowed to the one selection everything above ran against, so a seller
    // advertising several chains cannot have one entry priced and another
    // signed. Without this the builder re-picked `accepts[0]`.
    if (amountAtomic > 0n) {
      // One retry across a rate-limit interval, within the original read deadline.
      const deadline = Date.now() + ctx.flags.timeout;
      const readBalance = deps.readBalance ?? readUsdcBalance;
      let balance = await readBalance(signer.address, settings.rpcUrl, {
        timeoutMs: Math.max(1, Math.floor(ctx.flags.timeout / 2)),
      });
      if (balance === null && Date.now() < deadline) {
        await delay(Math.min(1100, Math.floor((deadline - Date.now()) / 2)));
        const remaining = deadline - Date.now();
        if (remaining > 0)
          balance = await readBalance(signer.address, settings.rpcUrl, { timeoutMs: remaining });
      }
      if (balance === null) {
        throw new CliError(
          'REFUSED',
          'The wallet balance could not be read; no payment was signed.',
          {
            fix: 'Check the configured Base rpcUrl and retry when it is available.',
            details: { reason: 'balance_unavailable', address: signer.address },
          },
        );
      }
      if (balance < amountAtomic) {
        throw new CliError('REFUSED', 'The wallet has insufficient USDC; no payment was signed.', {
          fix: 'Fund this wallet on Base with `tenjin wallet fund` before paying.',
          details: {
            reason: 'insufficient_funds',
            address: signer.address,
            balanceAtomic: balance.toString(),
            requiredAtomic: amountAtomic.toString(),
          },
        });
      }
    }
    payment = await buildExactPayment(effectiveChallenge, signer, effectiveRequirement);
  } catch (err) {
    await authorizer.release(reservationId);
    throw err;
  }

  // From here the signed EIP-3009 authorization leaves the process, and it is a
  // bearer instrument: the counterparty can settle it whatever it answers, or
  // if it answers nothing. So EVERY post-transmission outcome commits the
  // reservation; money that may move is money accounted. Releasing here let a
  // hostile registry-listed seller answer 402 after each signature while
  // sessionBudget counted zero of the authorizations it was stacking up.
  // (httpRequest never throws on transport failure; it returns ok:false.)
  const paid = await httpRequest(url, {
    ...fetchOpts,
    timeoutMs: paidLegTimeoutMs(effectiveRequirement, ctx.flags.timeout),
    headers: { ...headers, ...payment.headers },
  });
  await authorizer.commit(reservationId, payment.amountAtomic, { mode });
  // A TRANSPORT failure on this leg is a post-transmission outcome like any
  // other: the authorization has left, the reservation is committed above, and
  // a receipt that said nothing was paid would report a provider cost of zero
  // for money the ledger has already counted. The transport's own reason and
  // code survive; only the fix and the amounts are this leg's to state.
  if (!paid.ok) {
    throw fetchFailureToCliError(paid, {
      fix:
        'The authorization was transmitted and settlement is unknown; it is recorded as transmitted exposure. ' +
        `Do not simply retry: each attempt signs a fresh authorization. ${legFix(paid)}`,
      details: { amountAtomic: payment.amountAtomic.toString(), settlement: 'unknown' },
    });
  }
  if (paid.status >= 200 && paid.status < 300) {
    let caveat: string | undefined;
    if (args.resultSchema !== undefined) {
      const check = validateResultBody(args.resultSchema, paid.text);
      // A PAID BODY IS ALWAYS DELIVERED. The authorization has already left and
      // the money moved, so the success rule is a check on the body, never a
      // reason to withhold it: withholding charged the caller and threw the
      // product away. A body past this client's validation limit (never
      // checked) and one that fails the rule (checked, and missed) both come
      // back whole, flagged unverified, with a caveat that says which.
      if (check.unvalidated === true) caveat = unvalidatedCaveat(check);
      else if (!check.valid) caveat = failedRuleCaveat(check);
    }
    return deliver(url, lane, paid, {
      paid: true,
      warnings,
      amountAtomic: payment.amountAtomic,
      requirement: effectiveRequirement,
      ...(registry !== undefined ? { registry } : {}),
      ...(caveat !== undefined ? { caveat } : {}),
      printBody: args.printBody === true,
    });
  }
  // Still 402 (payment rejected) or anything else: nothing was delivered, but
  // the seller holds a live authorization, so the amount stays counted and the
  // fix must NOT coach a retry loop, since each retry signs a fresh authorization.
  throw new CliError(
    'PAYMENT_FAILED',
    paid.status === 402
      ? 'Payment was not accepted by the endpoint.'
      : `The endpoint answered ${paid.status} on the paid request; whether it settled is unknown.`,
    {
      fix: 'The signed payment already left and is recorded as transmitted exposure; the endpoint may still settle it. Do not simply retry: each attempt signs a fresh authorization. Verify the endpoint (and this listing, if Bazaar) before paying again.',
      // The amount rides on the failure so a caller can report what is at risk
      // rather than a zero. Settlement is unknown by construction here.
      details: {
        status: paid.status,
        body: paid.json,
        amountAtomic: payment.amountAtomic.toString(),
        settlement: 'unknown',
      },
    },
  );
}

/**
 * THE PAID LEG WAITS AS LONG AS THE SELLER SAID IT WOULD TAKE, within reason.
 * A signed authorization is already out when this leg starts, so a client
 * timeout here abandons money the seller can still settle: a 10 s default cut
 * off a provider advertising 360 s of work and threw its answer away. The
 * requirement's `maxTimeoutSeconds` is that promise; it is clamped to
 * {@link MAX_PAID_LEG_TIMEOUT_MS} so a hostile seller cannot hang the caller,
 * and it never shortens what the user asked for with `--timeout`. The probe
 * leg keeps the CLI timeout: nothing is at stake there.
 */
export const MAX_PAID_LEG_TIMEOUT_MS = 120_000;

export function paidLegTimeoutMs(requirement: PaymentRequirements, cliTimeoutMs: number): number {
  const advertised = requirement.maxTimeoutSeconds;
  if (typeof advertised !== 'number' || !Number.isFinite(advertised) || advertised <= 0) {
    return cliTimeoutMs;
  }
  return Math.max(cliTimeoutMs, Math.min(advertised * 1000, MAX_PAID_LEG_TIMEOUT_MS));
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
  // Same deployment, not merely the same spelling: without this a URL on the
  // deployment's other origin falls through to the Bazaar lane, which then
  // refuses it as a third-party endpoint or pays it under registry rules meant
  // for one. The SIWX signature below binds to the TARGET origin either way.
  if (isSameDeployment(target.origin, new URL(settings.baseUrl).origin)) return 'tenjin';
  if (target.protocol !== 'https:') {
    throw new CliError('USAGE', 'The Bazaar lane pays https endpoints only.', {
      fix: 'Use a public HTTPS endpoint.',
    });
  }
  return 'bazaar';
}

function resolveMethod(args: PayArgs): 'GET' | 'POST' {
  const method = args.method?.toUpperCase() ?? (args.data !== undefined ? 'POST' : 'GET');
  if (method !== 'GET' && method !== 'POST') {
    throw new CliError('USAGE', `Unsupported method ${JSON.stringify(args.method)}`, {
      fix: 'Use -X GET or -X POST.',
    });
  }
  if (method === 'GET' && (args.data !== undefined || args.rawBody !== undefined)) {
    throw new CliError('USAGE', 'A request body needs -X POST.', {
      fix: 'Drop --data, or pass -X POST.',
    });
  }
  return method;
}

/**
 * The caller's headers, or a refusal. Two names only: everything else on this
 * request is either this command's to set (the payment signature, the user
 * agent, the shelf bypass) or nobody's.
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

function parseBody(data: string | undefined): unknown {
  if (data === undefined) return undefined;
  try {
    return JSON.parse(data);
  } catch {
    throw new CliError('USAGE', 'The --data value is not valid JSON.', {
      fix: 'Pass a JSON object/array/string, e.g. --data \'{"question":"..."}\'.',
    });
  }
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
 * The caller's success rule, on EVERY delivery this command makes: a body that
 * fails it is not a result, whether it arrived free, by entitlement or paid.
 * Applying it only to the paid branch let a `{success:false}` body come back as
 * `fulfilled` the moment the wallet was already entitled.
 *
 * Returns the caveat for a body the rule could not be RUN against, so the three
 * branches treat an over-limit body the same way; `undefined` when the rule
 * passed or there was none.
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
 * What the caller is told INSTEAD of a refusal when the success rule could not
 * run: the byte count, that the check was skipped, and that the body in hand is
 * unverified. It rides in the result rather than only in a log, because the
 * agent reading the envelope is the one that has to discount it.
 */
function unvalidatedCaveat(check: ResultCheck): string {
  return `${check.reason ?? 'The result could not be validated.'} The body is delivered unverified: its shape was never checked against the success rule.`;
}

/** What the caller is told when a PAID body was checked and missed its success
 *  rule: the rule that failed, and that the body is handed back unverified. */
function failedRuleCaveat(check: ResultCheck): string {
  return `${check.reason ?? 'The result does not satisfy its success schema.'} The payment settled, so the body is delivered as received, unverified: treat it as possibly not the answer that was paid for.`;
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
 * WHICH advertised entry this call is about, from the SDK's own selection
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
  /** Set when the body is delivered UNVERIFIED: the success rule could not run. */
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
          ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
        }
      : opts.entitled === true
        ? { entitled: true }
        : {}),
    ...(settlementTxHash !== undefined ? { settlementTxHash } : {}),
    // Beside the body, never instead of it: the caller gets the product AND the
    // fact that its shape was never checked. The flag is what a machine reads:
    // a caller branching on a delivery must not have to match on prose, which
    // is how an unchecked body passed for a checked one one layer up.
    ...(opts.caveat !== undefined ? { resultUnverified: true, resultCaveat: opts.caveat } : {}),
    // The body is the product: JSON when the endpoint spoke it, raw text always.
    ...(res.json !== undefined ? { body: res.json } : {}),
    bodyText: res.text,
  };
  const headline = opts.paid
    ? `paid ${toMoney(opts.amountAtomic.toString()).usd} USD to ${sanitizeForTerminal(new URL(url).host)}` +
      (settlementTxHash !== undefined ? ` (tx ${settlementTxHash})` : '')
    : opts.entitled === true
      ? `free (entitled, no charge)`
      : `free (${res.status}, no charge)`;
  const body = sanitizeForTerminal(res.text);
  const preview =
    opts.printBody || body.length <= BODY_PREVIEW_CHARS
      ? body
      : `${body.slice(0, BODY_PREVIEW_CHARS)}\n… truncated; run with --print-body or --json for the full body`;
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

function settlementTx(res: HttpResponse): string | undefined {
  const header = res.header(PAYMENT_RESPONSE_HEADER);
  if (header === undefined) return undefined;
  try {
    const settle = decodePaymentResponseHeader(header);
    const tx = (settle as { transaction?: unknown }).transaction;
    return typeof tx === 'string' ? tx : undefined;
  } catch {
    return undefined;
  }
}

/** The signer, once the wallet has been opened. Selection never reaches it. */
function signerOrThrow(held: { current?: TenjinSigner }): TenjinSigner {
  if (held.current === undefined) {
    throw new CliError('INTERNAL', 'The payment was built before the wallet was opened.');
  }
  return held.current;
}
