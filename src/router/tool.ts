import { randomUUID } from 'node:crypto';
import { runPay, type AdvertisedTerms, type PayDeps } from '../commands/pay';
import { CliError } from '../lib/errors';
import { toMoney } from '../lib/money';
import { assertResultSchema, canonicalHash, validateAgainstSchema } from '../lib/request-schema';
import { resolveContextSettings } from '../lib/settings';
import type { SpendAuthorizer, WalletProvider } from '../lib/wallet';
import type { TenjinSigner } from '../lib/wallet/provider';
import type { CommandContext } from '../context';
import { requestDecision, type DecisionContract, type RequirementsCache } from './decision';
import { readLatestPacket } from './session-file';
import { MAX_MESSAGE_CHARS, packetForText } from './context';

/**
 * The `request` tool's handler: one paid decision, then one paid provider call,
 * then the result.
 *
 * WHAT IS CHECKED LOCALLY, BEFORE ANYTHING IS SIGNED FOR THE PROVIDER: the
 * decision's arguments against the schema it carries, its success rule against
 * the compiler, its advertised amount against `maxAutoSpend`, and its
 * destination against the shared preflight inside `runPay`. A live 402 above
 * the advertised terms is refused there too. A hostile backend can therefore
 * name any origin, and spend at most one `maxAutoSpend` inside `sessionBudget`.
 *
 * `needs_approval` is a LOCAL outcome only. The server never sends it: it is
 * what a price over the cap, an exhausted budget or an explicit `confirm:
 * always` looks like from here, and the fix is a command the user can run.
 */

export interface RequestToolArgs {
  query: string;
}

export interface RequestToolDeps {
  ctx: CommandContext;
  signer: TenjinSigner;
  /** The SAME provider the decision leg used. `runPay` opens its own otherwise,
   *  and the local one re-runs scrypt per process, which is the 2.3 s the MCP
   *  server's background unlock exists to hide. */
  provider?: WalletProvider;
  authorizer: SpendAuthorizer;
  cache: RequirementsCache;
  fetchImpl?: typeof fetch;
  /** Set once the process has answered from one session's packet. */
  sessionKey?: string;
  /** When the reading process started; a packet older than it is another
   *  window's. Omitted by a caller that has no such boundary. */
  startedAtMs?: number;
  now?: () => number;
  /** Test seam forwarded to the provider leg. */
  payDeps?: PayDeps;
}

export interface RequestToolResult {
  isError: boolean;
  summary: string;
  envelope: Record<string, unknown>;
  /** The session key this call bound to, for the caller to latch onto. */
  sessionKey?: string;
}

export async function runRequestTool(
  args: RequestToolArgs,
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  const query = args.query.trim().slice(0, 8_000);
  if (query.length === 0) {
    return fail(
      'needs_input',
      'A request needs a query naming the task, its inputs and any constraints.',
    );
  }
  const settings = await resolveContextSettings(deps.ctx);
  const latest = await readLatestPacket(deps.ctx.dataDir, {
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.sessionKey !== undefined
      ? { onlyKey: deps.sessionKey }
      : deps.startedAtMs !== undefined
        ? { sinceMs: deps.startedAtMs }
        : {}),
  });
  const sessionKey = latest?.key ?? deps.sessionKey;

  const outcome = await requestDecision(
    // No packet is the subagent, restarted-session and expired-packet path the
    // plan calls "route on query alone": the query becomes the current message,
    // because the server refuses an empty one and the fee is already spent.
    {
      requestId: randomUUID(),
      query,
      packet: latest?.packet ?? packetForText(query.slice(0, MAX_MESSAGE_CHARS)),
    },
    {
      ctx: deps.ctx,
      baseUrl: settings.baseUrl,
      signer: deps.signer,
      authorizer: deps.authorizer,
      cache: deps.cache,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    },
  );
  if (outcome.status === 'needs_approval') {
    return withKey(fail('needs_approval', outcome.reason, outcome.committedAtomic), sessionKey);
  }
  if (outcome.status === 'failed') {
    return withKey(fail('failed', outcome.reason, outcome.committedAtomic), sessionKey);
  }

  const routerFeeAtomic = outcome.amountAtomic;
  const { decision } = outcome.response;
  if (decision.action !== 'execute' || decision.contract === undefined) {
    return withKey(
      fail(
        decision.action === 'native' ? 'native' : 'needs_input',
        decision.reason ?? 'The router did not select a paid capability.',
        routerFeeAtomic,
      ),
      sessionKey,
    );
  }

  const contract = decision.contract;
  const refusal = checkContract(contract, BigInt(settings.policy.maxAutoSpendAtomic));
  if (refusal !== null)
    return withKey(fail(refusal.status, refusal.reason, routerFeeAtomic), sessionKey);

  const terms: AdvertisedTerms = {
    network: contract.advertised.network,
    asset: contract.advertised.asset,
    maxAmountAtomic: contract.advertised.maxAmountAtomic,
    source: decision.capabilityId ?? 'a routing decision',
  };

  try {
    // The request is the server's, sent verbatim: the only thing built here is
    // the decision about whether to send it, and the fee is already committed
    // by this point, so a refusal has to come back as the envelope that names
    // it rather than as a throw out of the tool.
    const built = contract.request;
    const paid = await runPay(
      {
        url: built.url,
        method: built.method,
        headers: built.headers,
        ...(built.body !== undefined ? { rawBody: built.body } : {}),
        terms,
        requestKey: `${decision.capabilityId ?? 'capability'}:${canonicalHash(contract.arguments)}`,
        ...(contract.resultSchema !== undefined ? { resultSchema: contract.resultSchema } : {}),
        printBody: true,
      },
      deps.ctx,
      {
        ...(deps.payDeps ?? {}),
        ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
        authorizer: deps.payDeps?.authorizer ?? deps.authorizer,
        confirm: async () => false,
      },
    );
    const data = paid.data as {
      bodyText?: string;
      amountPaid?: { atomic: string };
      /** Set when the body was delivered without its success rule having run. */
      resultCaveat?: string;
    };
    const providerAtomic = BigInt(data.amountPaid?.atomic ?? '0');
    return withKey(
      {
        isError: false,
        summary: `Fulfilled by ${supplierOf(built.url)} \u00b7 ${costLines(routerFeeAtomic, providerAtomic).join(' \u00b7 ')}`,
        envelope: {
          status: 'fulfilled',
          supplier: supplierOf(built.url),
          parameters: contract.arguments,
          cost: costLines(routerFeeAtomic, providerAtomic),
          result: data.bodyText ?? '',
          // The model reading this is the one that has to discount an unchecked
          // result, so the caveat travels in the envelope beside the body.
          ...(data.resultCaveat !== undefined ? { resultCaveat: data.resultCaveat } : {}),
          providerContentUntrusted: true,
        },
      },
      sessionKey,
    );
  } catch (err) {
    const cli = err instanceof CliError ? err : undefined;
    const status = cli?.code === 'POLICY_REFUSED' ? 'needs_approval' : 'failed';
    const reason = cli !== undefined ? `${cli.message} ${cli.fix ?? ''}`.trim() : String(err);
    // A provider failure AFTER transmission carries the amount at risk on its
    // details. Reporting zero there told the model the call was free when the
    // ledger had already counted it.
    const detail = (cli?.details ?? {}) as {
      amountAtomic?: string;
      settlement?: string;
      diagnosis?: Record<string, unknown>;
    };
    const providerAtomic = BigInt(detail.amountAtomic ?? '0');
    return withKey(
      fail(status, reason, routerFeeAtomic, providerAtomic, detail.settlement, detail.diagnosis),
      sessionKey,
    );
  }
}

type FailStatus = 'failed' | 'needs_approval' | 'needs_input' | 'native';

function checkContract(
  contract: DecisionContract,
  maxAutoSpendAtomic: bigint,
): { status: FailStatus; reason: string } | null {
  const built = contract.request;
  if (built.method !== 'GET' && built.method !== 'POST') {
    return {
      status: 'failed',
      reason: `This build executes GET and POST only, not ${built.method}.`,
    };
  }
  const header = unsafeHeader(built.headers);
  if (header !== null) {
    return {
      status: 'failed',
      reason: `The decision sets a header this build will not send: ${header}`,
    };
  }
  if (built.method === 'GET' && built.body !== undefined) {
    return { status: 'failed', reason: 'The decision puts a body on a GET.' };
  }
  const check = validateAgainstSchema(contract.argumentSchema, contract.arguments);
  if (!check.valid) {
    return {
      status: 'failed',
      reason: `The decision's arguments fail its own schema: ${check.errors[0]}`,
    };
  }
  if (contract.resultSchema !== undefined) {
    try {
      assertResultSchema(contract.resultSchema);
    } catch (err) {
      return {
        status: 'failed',
        reason: `The decision's success rule is unusable: ${String(err)}`,
      };
    }
  }
  try {
    // Parsed above every signature: a URL the paying leg cannot read is a
    // refusal here, never a throw from inside it.
    new URL(built.url);
  } catch {
    return { status: 'failed', reason: 'The decision names a URL this build cannot parse.' };
  }
  if (BigInt(contract.advertised.maxAmountAtomic) > maxAutoSpendAtomic) {
    return {
      status: 'needs_approval',
      reason: `The capability advertises ${toMoney(contract.advertised.maxAmountAtomic).usd} USD, above maxAutoSpend. Raise it with \`tenjin config set maxAutoSpend <usd>\` if that price is acceptable.`,
    };
  }
  return null;
}

/**
 * The only headers a routing decision may put on the wire. Authentication,
 * transport and payment headers are this client's to set or nobody's, so a
 * decision naming one is refused rather than quietly filtered.
 */
const SENDABLE_HEADERS = new Set(['accept', 'content-type']);

function unsafeHeader(headers: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (!SENDABLE_HEADERS.has(name.toLowerCase())) return name;
    if (value.length > 1_024 || /[\r\n]/.test(value)) return name;
  }
  return null;
}

function supplierOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown service';
  }
}

export function costLines(routerFeeAtomic: bigint, providerAtomic: bigint): string[] {
  return [
    `router fee ${toMoney(routerFeeAtomic.toString()).usd} USD`,
    `provider price ${toMoney(providerAtomic.toString()).usd} USD`,
  ];
}

function fail(
  status: FailStatus,
  reason: string,
  routerFeeAtomic = 0n,
  providerAtomic = 0n,
  settlement?: string,
  /** Which rule failed, whether the body was JSON, its size and a bounded
   *  redacted preview: what tells a parse miss from an HTML error page. */
  diagnosis?: Record<string, unknown>,
): RequestToolResult {
  return {
    isError: true,
    summary: `x402 request ${status}: ${reason}`,
    envelope: {
      status,
      reason,
      // What LEFT, not what was delivered: an authorization that was
      // transmitted is money at risk whether or not a result came back.
      cost: costLines(routerFeeAtomic, providerAtomic),
      ...(settlement !== undefined ? { settlement } : {}),
      ...(diagnosis !== undefined ? { diagnosis } : {}),
      providerContentUntrusted: true,
    },
  };
}

function withKey(result: RequestToolResult, sessionKey: string | undefined): RequestToolResult {
  return sessionKey === undefined ? result : { ...result, sessionKey };
}
