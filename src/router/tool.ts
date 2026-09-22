import { randomUUID } from 'node:crypto';
import { runPay, type AdvertisedTerms, type PayDeps } from '../commands/pay';
import { CliError } from '../lib/errors';
import { toMoney } from '../lib/money';
import { assertResultSchema, canonicalHash, validateAgainstSchema } from '../lib/request-schema';
import { resolveContextSettings } from '../lib/settings';
import type { SpendAuthorizer } from '../lib/wallet';
import type { TenjinSigner } from '../lib/wallet/provider';
import type { CommandContext } from '../context';
import { requestDecision, type DecisionContract, type RequirementsCache } from './decision';
import { readLatestPacket } from './session-file';
import type { Packet } from './context';

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
  authorizer: SpendAuthorizer;
  cache: RequirementsCache;
  fetchImpl?: typeof fetch;
  /** Set once the process has answered from one session's packet. */
  sessionKey?: string;
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

const EMPTY_PACKET: Packet = {
  current: { role: 'user', text: '' },
  history: [],
  literalUrls: [],
  historyStatus: 'unavailable',
};

export async function runRequestTool(
  args: RequestToolArgs,
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  const query = args.query.trim();
  if (query.length === 0) {
    return fail(
      'needs_input',
      'A request needs a query naming the task, its inputs and any constraints.',
    );
  }
  const settings = await resolveContextSettings(deps.ctx);
  const latest = await readLatestPacket(deps.ctx.dataDir, {
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.sessionKey !== undefined ? { onlyKey: deps.sessionKey } : {}),
  });
  const sessionKey = latest?.key ?? deps.sessionKey;

  const outcome = await requestDecision(
    { requestId: randomUUID(), query, packet: latest?.packet ?? EMPTY_PACKET },
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
    return withKey(fail('needs_approval', outcome.reason), sessionKey);
  }
  if (outcome.status === 'failed') return withKey(fail('failed', outcome.reason), sessionKey);

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
  const body = contract.method === 'GET' ? undefined : JSON.stringify(contract.arguments);
  const url = contract.method === 'GET' ? withQuery(contract) : contract.url;

  try {
    const paid = await runPay(
      {
        url,
        method: contract.method,
        ...(body !== undefined ? { data: body } : {}),
        terms,
        requestKey: `${decision.capabilityId ?? 'capability'}:${canonicalHash(contract.arguments)}`,
        ...(contract.resultSchema !== undefined ? { resultSchema: contract.resultSchema } : {}),
        printBody: true,
      },
      deps.ctx,
      {
        ...(deps.payDeps ?? {}),
        confirm: async () => false,
      },
    );
    const data = paid.data as { bodyText?: string; amountPaid?: { atomic: string } };
    const providerAtomic = BigInt(data.amountPaid?.atomic ?? '0');
    return withKey(
      {
        isError: false,
        summary: `Fulfilled by ${supplierOf(contract.url)} · ${costLines(routerFeeAtomic, providerAtomic).join(' · ')}`,
        envelope: {
          status: 'fulfilled',
          supplier: supplierOf(contract.url),
          parameters: contract.arguments,
          cost: costLines(routerFeeAtomic, providerAtomic),
          result: data.bodyText ?? '',
          providerContentUntrusted: true,
        },
      },
      sessionKey,
    );
  } catch (err) {
    const cli = err instanceof CliError ? err : undefined;
    const status = cli?.code === 'POLICY_REFUSED' ? 'needs_approval' : 'failed';
    const reason = cli !== undefined ? `${cli.message} ${cli.fix ?? ''}`.trim() : String(err);
    return withKey(fail(status, reason, routerFeeAtomic), sessionKey);
  }
}

type FailStatus = 'failed' | 'needs_approval' | 'needs_input' | 'native';

function checkContract(
  contract: DecisionContract,
  maxAutoSpendAtomic: bigint,
): { status: FailStatus; reason: string } | null {
  if (contract.method !== 'GET' && contract.method !== 'POST') {
    return {
      status: 'failed',
      reason: `This build executes GET and POST only, not ${contract.method}.`,
    };
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
  if (BigInt(contract.advertised.maxAmountAtomic) > maxAutoSpendAtomic) {
    return {
      status: 'needs_approval',
      reason: `The capability advertises ${toMoney(contract.advertised.maxAmountAtomic).usd} USD, above maxAutoSpend. Raise it with \`tenjin config set maxAutoSpend <usd>\` if that price is acceptable.`,
    };
  }
  return null;
}

/** Arguments become query parameters on a GET, a JSON body otherwise. A value
 *  that is not a scalar has no query form and is refused by the URL build. */
function withQuery(contract: DecisionContract): string {
  const url = new URL(contract.url);
  for (const [key, value] of Object.entries(contract.arguments)) {
    if (value === null || typeof value === 'object') {
      throw new CliError(
        'CONTRACT_MISMATCH',
        `The decision binds ${key} to a value a GET cannot carry.`,
      );
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
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

function fail(status: FailStatus, reason: string, routerFeeAtomic = 0n): RequestToolResult {
  return {
    isError: true,
    summary: `x402 request ${status}: ${reason}`,
    envelope: {
      status,
      reason,
      cost: costLines(routerFeeAtomic, 0n),
      providerContentUntrusted: true,
    },
  };
}

function withKey(result: RequestToolResult, sessionKey: string | undefined): RequestToolResult {
  return sessionKey === undefined ? result : { ...result, sessionKey };
}
