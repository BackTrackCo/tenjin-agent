import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { verifyAgainstRegistries } from '../lib/bazaar';
import { CliError } from '../lib/errors';
import { fetchFailureToCliError, httpRequest } from '../lib/http';
import type { HttpResponse } from '../lib/http';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { sanitizeForTerminal } from '../lib/output';
import { promptYesNo } from '../lib/prompt';
import { resolveContextSettings } from '../lib/settings';
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
 * `PAYMENT-SIGNATURE`. Deliberately NOT `buy`: no SIWX ever (these endpoints
 * are anonymous x402, and the absence is what keeps the foreign lane safe), no
 * library idempotence (every paid call pays; the session budget and
 * `--max-price` are the brakes), no search attribution.
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
}

export interface PayDeps {
  fetchImpl?: typeof fetch;
  provider?: WalletProvider;
  authorizer?: SpendAuthorizer;
  confirm?: (prompt: string) => Promise<boolean>;
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
  const method = resolveMethod(args);
  const jsonBody = parseBody(args.data);

  const fetchOpts = {
    timeoutMs: ctx.flags.timeout,
    // Both legs: the probe's 402 is money-path input, and the paid retry
    // carries a signed header (which pins redirects on its own; this pins the
    // probe too, so the challenge always comes from the URL that was gated).
    blockRedirects: true as const,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(jsonBody !== undefined ? { jsonBody } : {}),
    method,
  };

  const probe = await httpRequest(url, fetchOpts);
  if (!probe.ok) throw fetchFailureToCliError(probe);
  if (probe.status >= 200 && probe.status < 300) {
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
  const amountAtomic = BigInt(requirement.amount);
  const host = new URL(url).host;

  // The Bazaar lane's registry check runs BEFORE the wallet is even opened:
  // an unverifiable deal must not reach a signer.
  let registry: string | undefined;
  if (lane === 'bazaar') {
    registry = await assertRegistryVerified(settings, url, requirement, ctx.flags.timeout);
  }

  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  await describeWallet(provider); // WALLET_MISSING with its own fix if none exists
  const signer = await provider.getSigner();

  const authorizer = resolveSpendAuthorizer(
    ctx,
    settings.policy,
    deps.authorizer !== undefined ? { authorizer: deps.authorizer } : {},
  );
  // The host is the creator identity here: `allowlistCreators` users pin hosts.
  const authorization = await authorizer.authorize({
    amountAtomic,
    creator: host,
    ...(maxPriceAtomic !== undefined ? { maxPriceAtomic } : {}),
  });
  if (authorization.decision === 'deny') {
    throw new CliError('POLICY_REFUSED', authorization.message, {
      fix: payPolicyFix(authorization.reason),
      details: { reason: authorization.reason, amountAtomic: amountAtomic.toString() },
    });
  }
  const reservationId = authorization.reservationId;
  if (authorization.decision === 'confirm') {
    const approved = await confirmSpend(ctx, deps, args.yes === true, amountAtomic, host, registry);
    if (!approved) {
      await authorizer.release(reservationId);
      throw new CliError('POLICY_REFUSED', 'Payment not confirmed.', {
        fix: 'Re-run with --yes, or set a policy that auto-approves this spend.',
        details: { reason: authorization.reason, amountAtomic: amountAtomic.toString() },
      });
    }
  }

  try {
    const payment = await buildExactPayment(paymentRequired, signer);
    const paid = await httpRequest(url, { ...fetchOpts, headers: payment.headers });
    if (!paid.ok) throw fetchFailureToCliError(paid);
    if (paid.status >= 200 && paid.status < 300) {
      await authorizer.commit(reservationId, payment.amountAtomic);
      return deliver(url, lane, paid, {
        paid: true,
        amountAtomic: payment.amountAtomic,
        requirement,
        ...(registry !== undefined ? { registry } : {}),
        printBody: args.printBody === true,
      });
    }
    // Still 402 (payment rejected) or anything else: nothing was delivered.
    // The reservation is released in the catch below; settlement state on a
    // non-402 non-2xx is honestly unknown and the message says so.
    throw new CliError(
      'PAYMENT_FAILED',
      paid.status === 402
        ? 'Payment was not accepted by the endpoint.'
        : `The endpoint answered ${paid.status} on the paid request; whether it settled is unknown.`,
      {
        fix: 'Check the wallet balance and network, then retry.',
        details: { status: paid.status, body: paid.json },
      },
    );
  } catch (err) {
    await authorizer.release(reservationId);
    throw err;
  }
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
  if (target.origin === new URL(settings.baseUrl).origin) return 'tenjin';
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
  if (method === 'GET' && args.data !== undefined) {
    throw new CliError('USAGE', 'A request body needs -X POST.', {
      fix: 'Drop --data, or pass -X POST.',
    });
  }
  return method;
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

/** The registry gate: only a `verified` outcome returns; everything else throws. */
async function assertRegistryVerified(
  settings: ResolvedSettings,
  url: string,
  requirement: PaymentRequirements,
  timeoutMs: number,
): Promise<string> {
  const verification = await verifyAgainstRegistries(
    settings.bazaarRegistries,
    url,
    requirement,
    timeoutMs,
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
      throw new CliError('USAGE', 'No configured registry lists this resource.', {
        fix: 'The Bazaar lane pays publicly listed deals only. Find payable endpoints with `tenjin discover`.',
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

function payPolicyFix(reason: string): string {
  switch (reason) {
    case 'price_cap_exceeded':
      return 'Raise --max-price if this price is acceptable.';
    case 'not_allowlisted':
      return 'Add this host to allowlistCreators, or clear the allowlist.';
    case 'session_budget_exceeded':
      return 'Raise sessionBudget with `tenjin config set sessionBudget <usd>`, or wait for the window to roll over.';
    default:
      return 'Adjust your spend policy with `tenjin config set`.';
  }
}

async function confirmSpend(
  ctx: CommandContext,
  deps: PayDeps,
  yes: boolean,
  amountAtomic: bigint,
  host: string,
  registry: string | undefined,
): Promise<boolean> {
  if (yes) return true;
  // Host and registry are external input: sanitized so escape sequences cannot
  // repaint the price the human is approving. The price renders last.
  const via = registry !== undefined ? ` (listed on ${sanitizeForTerminal(registry)})` : '';
  const prompt = `Pay ${toMoney(amountAtomic.toString()).usd} USD to ${sanitizeForTerminal(host)}${via}? [y/N] `;
  if (deps.confirm !== undefined) return deps.confirm(prompt);
  if (!ctx.io.isTTY) return false; // non-interactive without --yes: refuse (exit 3)
  if (!process.stdin.isTTY) return false;
  return promptYesNo(prompt);
}

interface DeliverOpts {
  paid: boolean;
  amountAtomic?: bigint;
  requirement?: PaymentRequirements;
  registry?: string;
  printBody: boolean;
}

function deliver(url: string, lane: Lane, res: HttpResponse, opts: DeliverOpts): CommandResult {
  const settlementTxHash = opts.paid ? settlementTx(res) : undefined;
  const data = {
    url,
    lane,
    status: res.status,
    paid: opts.paid,
    ...(opts.amountAtomic !== undefined
      ? { amountPaid: toMoney(opts.amountAtomic.toString()) }
      : {}),
    ...(opts.requirement !== undefined
      ? { payTo: opts.requirement.payTo, network: opts.requirement.network }
      : {}),
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
    ...(settlementTxHash !== undefined ? { settlementTxHash } : {}),
    // The body is the product: JSON when the endpoint spoke it, raw text always.
    ...(res.json !== undefined ? { body: res.json } : {}),
    bodyText: res.text,
  };
  const headline = opts.paid
    ? `paid ${toMoney(opts.amountAtomic!.toString()).usd} USD to ${sanitizeForTerminal(new URL(url).host)}` +
      (settlementTxHash !== undefined ? ` (tx ${settlementTxHash})` : '')
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
