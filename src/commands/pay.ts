import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import { SIGN_IN_WITH_X } from '@x402/extensions/sign-in-with-x';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { verifyAgainstRegistries } from '../lib/bazaar';
import { assertPublicDestination, type DestinationOptions } from '../lib/destination';
import { CliError } from '../lib/errors';
import { validateResultBody } from '../lib/request-schema';
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
import { buildExactPayment } from '../lib/x402-pay';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin pay <url>`: the standard x402 client verb, for ANY paid endpoint
 * rather than marketplace pieces. One probe; a 2xx delivers free; a 402 runs
 * the same money gates as `buy` (spend policy, price cap, session budget,
 * confirm; `--yes` clears only the confirm) and retries once with the
 * `PAYMENT-SIGNATURE`. Deliberately NOT `buy`: no library idempotence (every
 * paid call pays; the session budget and `--max-price` are the brakes) and no
 * search attribution. SIWX rides ONLY when the 402 advertises the standard
 * sign-in-with-x extension, and the signature is bound to the TARGET origin
 * (never the configured deployment's), so an entitled wallet re-reads free at
 * any seller that supports it while nothing origin-bound can leak elsewhere.
 *
 * The origin gate has two lanes. The configured base URL is always payable.
 * Any other https origin is payable only when the operator turned `bazaarPay`
 * on AND a configured registry publicly lists this exact resource with terms
 * the live 402 does not exceed (lib/bazaar); a mismatch is REGISTRY_MISMATCH
 * and nothing is signed. The response body is delivered raw in the machine
 * envelope and sanitized for the terminal: paid or not, it is other people's
 * content, never instructions.
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
 * exceed the amount. A caller with no such terms keeps `assertRegistryVerified`.
 */
export interface AdvertisedTerms {
  network: string;
  asset: string;
  maxAmountAtomic: string;
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
   * The caller's APPLICATION success rule for the delivered body. A 2xx whose
   * body fails it is a paid failure, not a delivery: the money already moved,
   * so the refusal says so instead of handing back a body nobody vouched for.
   */
  resultSchema?: unknown;
}

export interface PayDeps {
  fetchImpl?: typeof fetch;
  provider?: WalletProvider;
  authorizer?: SpendAuthorizer;
  confirm?: (prompt: string) => Promise<boolean>;
  /** Resolver seam for the destination preflight; production leaves it unset. */
  destination?: DestinationOptions;
}

type Lane = 'tenjin' | 'bazaar';

export async function runPay(
  args: PayArgs,
  ctx: CommandContext,
  deps: PayDeps = {},
): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const maxPriceAtomic =
    args.maxPrice !== undefined ? BigInt(parseUsdToAtomic(args.maxPrice)) : undefined;
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
    assertUsableResult(args.resultSchema, probe.text, probe.status, 'free');
    return deliver(url, lane, probe, { paid: false, printBody: args.printBody === true });
  }
  if (probe.status !== 402) {
    throw new CliError('API_UNREACHABLE', `${url} answered ${probe.status}.`, {
      fix: 'Check the URL and the endpoint status, then retry.',
      details: { status: probe.status, body: probe.json },
    });
  }

  const paymentRequired = decodeChallenge(probe, url);
  const requirement = paymentRequired.accepts[0];
  if (requirement === undefined) {
    throw new CliError('PAYMENT_FAILED', 'The 402 advertised no payment requirements.', {
      fix: 'The endpoint looks misconfigured.',
    });
  }
  // The FIRST-SEEN amount: a later challenge may never cost more than this.
  const firstSeenAmount = BigInt(requirement.amount);
  const host = new URL(url).host;

  // The Bazaar lane's registry check runs BEFORE the wallet is even opened:
  // an unverifiable deal must not reach a signer.
  let registry: string | undefined;
  let termsLabel: string | undefined;
  if (lane === 'bazaar') {
    if (args.terms !== undefined) termsLabel = assertWithinTerms(args.terms, requirement);
    else
      registry = await assertRegistryVerified(settings, url, requirement, ctx.flags.timeout, ctx);
  }

  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  await describeWallet(provider); // WALLET_MISSING with its own fix if none exists
  const signer = await provider.getSigner();

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
      assertUsableResult(args.resultSchema, recheck.text, recheck.status, 'entitled');
      return deliver(url, lane, recheck, {
        paid: false,
        entitled: true,
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
    const fresh = effectiveChallenge.accepts[0];
    if (fresh === undefined) {
      throw new CliError('PAYMENT_FAILED', 'The fresh 402 advertised no payment requirements.', {
        fix: 'The endpoint looks misconfigured.',
      });
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
    effectiveRequirement = fresh;
    // The Bazaar lane verifies the challenge it will actually SIGN: the store
    // answers this without a network round trip in the common case.
    if (lane === 'bazaar') {
      if (args.terms !== undefined) termsLabel = assertWithinTerms(args.terms, fresh);
      else registry = await assertRegistryVerified(settings, url, fresh, ctx.flags.timeout, ctx);
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
  const reservationId = await gateSpend({
    ctx,
    authorizer,
    amountAtomic,
    creator: host,
    ...(maxPriceAtomic !== undefined ? { maxPriceAtomic } : {}),
    ...(args.requestKey !== undefined ? { requestKey: args.requestKey } : {}),
    yes: args.yes === true,
    ...(deps.confirm !== undefined ? { confirm: deps.confirm } : {}),
    payeeLabel: `${sanitizeForTerminal(host)}${via}`,
    allowlistSubject: 'this host',
    notConfirmedMessage: 'Payment not confirmed.',
  });

  // A failure BEFORE transmission (the build) releases: no signature exists,
  // nothing can move. That is the last point where releasing is honest.
  let payment: Awaited<ReturnType<typeof buildExactPayment>>;
  try {
    payment = await buildExactPayment(effectiveChallenge, signer);
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
    headers: { ...headers, ...payment.headers },
  });
  await authorizer.commit(reservationId, payment.amountAtomic);
  // A TRANSPORT failure on this leg is a post-transmission outcome like any
  // other: the authorization has left, the reservation is committed above, and
  // a receipt that said nothing was paid would report a provider cost of zero
  // for money the ledger has already counted. The transport's own reason and
  // code survive; only the fix and the amounts are this leg's to state.
  if (!paid.ok) {
    throw fetchFailureToCliError(paid, {
      fix:
        'The authorization was transmitted and settlement is unknown; it is counted against the session budget. ' +
        `Do not simply retry: each attempt signs a fresh authorization. ${legFix(paid)}`,
      details: { amountAtomic: payment.amountAtomic.toString(), settlement: 'unknown' },
    });
  }
  if (paid.status >= 200 && paid.status < 300) {
    if (args.resultSchema !== undefined) {
      const check = validateResultBody(args.resultSchema, paid.text);
      if (!check.valid) {
        throw new CliError('CONTRACT_MISMATCH', `The paid response is not a usable result.`, {
          fix: 'The payment has already settled and is counted against the session budget. Do not retry blind: the endpoint answered 2xx with a body that fails the success rule it was paid under.',
          details: {
            status: paid.status,
            reason: check.reason,
            amountAtomic: payment.amountAtomic.toString(),
            settlement: 'reported',
          },
        });
      }
    }
    return deliver(url, lane, paid, {
      paid: true,
      amountAtomic: payment.amountAtomic,
      requirement: effectiveRequirement,
      ...(registry !== undefined ? { registry } : {}),
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
      fix: 'The signed payment already left and is counted against the session budget; the endpoint may still settle it. Do not simply retry: each attempt signs a fresh authorization. Verify the endpoint (and this listing, if Bazaar) before paying again.',
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
  if (settings.bazaarPay !== true) {
    // The fix names the operator act without coaching around the gate that just
    // fired: this URL may have arrived in a task, a page, or purchased content.
    throw new CliError(
      'USAGE',
      `${target.origin} is not the configured base URL, and the Bazaar pay lane is off.`,
      {
        fix: 'An operator enables paying registry-listed non-Tenjin endpoints with `tenjin config set bazaarPay on`.',
      },
    );
  }
  if (target.protocol !== 'https:') {
    throw new CliError('USAGE', 'The Bazaar lane pays https endpoints only.', {
      fix: 'Use the https URL the registry lists.',
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
 */
function assertUsableResult(
  schema: unknown,
  body: string,
  status: number,
  how: 'free' | 'entitled',
): void {
  if (schema === undefined) return;
  const check = validateResultBody(schema, body);
  if (check.valid) return;
  throw new CliError('CONTRACT_MISMATCH', 'The response is not a usable result.', {
    fix: `Nothing was paid on this ${how} delivery. The endpoint answered ${status} with a body that fails the success rule it was asked under.`,
    details: { status, reason: check.reason, paid: false },
  });
}

/** The transport's own remedy, when it has one, appended after the leg's
 *  payment sentence so the two never contradict each other. */
function legFix(failure: { kind: string }): string {
  return failure.kind === 'oversized-header'
    ? 'Raising `--max-http-header-size` on the node process that runs this CLI would let the header be read; that is an operator decision, not a default this build changes.'
    : '';
}

/**
 * The advertised-terms gate. Same shape of answer as the registry gate and the
 * same failure code, because it answers the same question: is the live 402 the
 * deal this call was authorized against? Exact on scheme, network and asset, at
 * most on the amount. Returns the label the payee line names.
 */
function assertWithinTerms(terms: AdvertisedTerms, requirement: PaymentRequirements): string {
  const mismatch =
    requirement.scheme !== 'exact'
      ? `scheme ${requirement.scheme}`
      : requirement.network !== terms.network
        ? `network ${requirement.network}`
        : requirement.asset.toLowerCase() !== terms.asset.toLowerCase()
          ? `asset ${requirement.asset}`
          : BigInt(requirement.amount) > BigInt(terms.maxAmountAtomic)
            ? `amount ${requirement.amount} over the advertised ${terms.maxAmountAtomic}`
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

/** The registry gate: only a `verified` outcome returns; everything else throws. */
async function assertRegistryVerified(
  settings: ResolvedSettings,
  url: string,
  requirement: PaymentRequirements,
  timeoutMs: number,
  ctx: CommandContext,
): Promise<string> {
  const verification = await verifyAgainstRegistries(
    settings.bazaarRegistries,
    url,
    requirement,
    timeoutMs,
    { dataDir: ctx.dataDir },
  );
  switch (verification.outcome) {
    case 'verified':
      return verification.registry;
    case 'mismatch':
      throw new CliError(
        'REGISTRY_MISMATCH',
        `The live 402 does not match what ${verification.registry} advertises for this resource (${verification.detail}).`,
        {
          fix: 'Nothing was signed. Re-run `tenjin discover` to see the advertised terms; if the seller changed them, the registry will catch up.',
          details: { registry: verification.registry, detail: verification.detail },
        },
      );
    case 'unlisted':
      throw new CliError('USAGE', 'No configured registry is known to list this resource.', {
        fix: 'The Bazaar lane pays publicly listed deals only, and pay-time lookup leans on the local `discover` cache: run `tenjin discover [query]` so a sweep can surface this endpoint, then re-run pay.',
      });
    case 'unavailable':
      throw new CliError(
        'NETWORK_ERROR',
        'No configured registry answered; the Bazaar lane fails closed.',
        {
          fix: 'Retry when the registries are reachable.',
          details: { errors: verification.errors },
        },
      );
  }
}

/** Discriminated on `paid`: a paid delivery always carries what it paid and to
 *  whom, so no branch ever reaches for an amount that might not be there. */
type DeliverOpts =
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
    };

function deliver(url: string, lane: Lane, res: HttpResponse, opts: DeliverOpts): CommandResult {
  const settlementTxHash = opts.paid ? settlementTx(res) : undefined;
  const data = {
    url,
    lane,
    status: res.status,
    paid: opts.paid,
    ...(opts.paid
      ? {
          amountPaid: toMoney(opts.amountAtomic.toString()),
          payTo: opts.requirement.payTo,
          network: opts.requirement.network,
          ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
        }
      : opts.entitled === true
        ? { entitled: true }
        : {}),
    ...(settlementTxHash !== undefined ? { settlementTxHash } : {}),
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
  return { data, humanLines: [headline, ...(preview.length > 0 ? [preview] : [])] };
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
