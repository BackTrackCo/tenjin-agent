import { randomUUID } from 'node:crypto';
import { runPay, type AdvertisedTerms, type PayDeps } from '../commands/pay';
import { CliError } from '../lib/errors';
import { toMoney } from '../lib/money';
import { assertResultSchema, canonicalHash, validateAgainstSchema } from '../lib/request-schema';
import { resolveContextSettings } from '../lib/settings';
import type { SpendAuthorizer, WalletProvider } from '../lib/wallet';
import type { TenjinSigner } from '../lib/wallet/provider';
import type { CommandContext } from '../context';
import {
  requestDecision,
  type DecisionContract,
  type DecisionDiagnostics,
  type RequirementsCache,
} from './decision';
import {
  consumeGateHint,
  lookupKeyOf,
  readLatestPacket,
  recordNativeContinuation,
} from './session-file';
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

  // THE GATE'S CATEGORY FOR THIS TURN, AS EVIDENCE FOR THIS LOOKUP. Consumed,
  // so the second lookup of a turn and any parallel one send none: evidence
  // about one question is not evidence about the next. It never authorizes
  // money, which stays with the local spend policy, and the backend is free to
  // refine or reject it.
  const category =
    latest !== null && sessionKey !== undefined
      ? await consumeGateHint(deps.ctx.dataDir, sessionKey, latest.writtenAtMs, deps.now)
      : null;

  const outcome = await requestDecision(
    // No packet is the subagent, restarted-session and expired-packet path the
    // plan calls "route on query alone": the query becomes the current message,
    // because the server refuses an empty one and the fee is already spent.
    {
      requestId: randomUUID(),
      query,
      packet: latest?.packet ?? packetForText(query.slice(0, MAX_MESSAGE_CHARS)),
      ...(category !== null && latest !== null
        ? {
            gateHint: {
              category,
              turnId: String(latest.writtenAtMs),
              lookupId: lookupKeyOf(query),
            },
          }
        : {}),
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
    return withKey(
      fail('failed', outcome.reason, outcome.committedAtomic, 0n, {
        // The backend's own stable code, so a host reads a typed refusal rather
        // than guessing at prose.
        ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
      }),
      sessionKey,
    );
  }

  // TWO NUMBERS, AND THE FEE IS THE SETTLED ONE. The router waives the fee for
  // every outcome it cannot execute, so reporting the signed amount as a charge
  // would tell the model a `native` answer cost money it was not charged. The
  // authorization still left, so the exposure rides along whenever it differs.
  const routerFeeAtomic = outcome.settledAtomic;
  const routerExposureAtomic = outcome.amountAtomic;
  const exposure =
    routerExposureAtomic === routerFeeAtomic ? {} : { exposureAtomic: routerExposureAtomic };
  const { decision } = outcome.response;
  if (decision.action !== 'execute' || decision.contract === undefined) {
    // An explicit `native` was BOUGHT for this exact lookup in this turn, so
    // the PreToolUse hook must not ask the gate about it again and be told to
    // redirect the call the same decision just permitted. Recorded only for
    // `native`, only against this session's current packet stamp, and only for
    // this query; `needs_input` gets nothing, because unresolved scope is a
    // question for the user, never standing permission.
    if (decision.action === 'native' && sessionKey !== undefined && latest !== null) {
      await recordNativeContinuation(
        deps.ctx.dataDir,
        sessionKey,
        latest.writtenAtMs,
        query,
        deps.now,
      ).catch(() => undefined);
    }
    return withKey(
      fail(
        decision.action === 'native' ? 'native' : 'needs_input',
        decision.reason ?? 'The router did not select a paid capability.',
        routerFeeAtomic,
        0n,
        {
          ...exposure,
          ...(outcome.response.diagnostics !== undefined
            ? { diagnostics: outcome.response.diagnostics }
            : {}),
        },
      ),
      sessionKey,
    );
  }

  const contract = decision.contract;
  const refusal = checkContract(contract, BigInt(settings.policy.maxAutoSpendAtomic));
  if (refusal !== null)
    return withKey(fail(refusal.status, refusal.reason, routerFeeAtomic, 0n, exposure), sessionKey);

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
      resultUnverified?: boolean;
      resultCaveat?: string;
    };
    const providerAtomic = BigInt(data.amountPaid?.atomic ?? '0');
    const costs = costLines(routerFeeAtomic, providerAtomic);
    // UNVERIFIED IS NOT FULFILLED. A body the success rule could not be run
    // against may be exactly the contract failure the rule exists to catch, and
    // a caveat inside a `fulfilled` envelope does not reach code that branches
    // on the status: a provider could pad a broken answer past the validation
    // limit and have it read as a checked, paid result. So the status says what
    // is true, and `isError` carries it to consumers that read nothing else.
    // The body still rides along, whole: the money moved, and truncating or
    // withholding the product would be a second loss on top of the first.
    if (data.resultUnverified === true) {
      return withKey(
        {
          isError: true,
          summary: `Unverified result from ${supplierOf(built.url)} \u00b7 ${costs.join(' \u00b7 ')}`,
          envelope: {
            status: 'unverified',
            supplier: supplierOf(built.url),
            parameters: contract.arguments,
            cost: costs,
            ...(routerExposureAtomic !== routerFeeAtomic
              ? { authorizationExposure: toMoney(routerExposureAtomic.toString()).usd }
              : {}),
            result: data.bodyText ?? '',
            ...(data.resultCaveat !== undefined ? { resultCaveat: data.resultCaveat } : {}),
            providerContentUntrusted: true,
          },
        },
        sessionKey,
      );
    }
    return withKey(
      {
        isError: false,
        summary: `Fulfilled by ${supplierOf(built.url)} \u00b7 ${costs.join(' \u00b7 ')}`,
        envelope: {
          status: 'fulfilled',
          supplier: supplierOf(built.url),
          parameters: contract.arguments,
          cost: costs,
          ...(routerExposureAtomic !== routerFeeAtomic
            ? { authorizationExposure: toMoney(routerExposureAtomic.toString()).usd }
            : {}),
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
      fail(status, reason, routerFeeAtomic, providerAtomic, {
        ...exposure,
        ...(detail.settlement !== undefined ? { settlement: detail.settlement } : {}),
        ...(detail.diagnosis !== undefined ? { diagnosis: detail.diagnosis } : {}),
      }),
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

/**
 * ROUTINE CONTROL OUTCOMES, not failures of this tool. A routing decision was
 * delivered, and it says the turn continues somewhere else: with the host's own
 * tools, with a question for the user, or with an approval only the user gives.
 * The MCP error flag is for what went WRONG, and raising it on these three put
 * a red box in front of the user on the most ordinary answer the router has.
 *
 * Genuine request, provider and schema failures stay errors, and so does a paid
 * body that could not be verified: delivering a routing outcome is not a claim
 * that a provider fulfilled anything.
 */
const ROUTINE: ReadonlySet<FailStatus> = new Set(['native', 'needs_input', 'needs_approval']);

/**
 * The four outcomes the target step now splits into (contract amendment
 * 2026-09-23), each with the step that actually follows from it. The backend's
 * own `nextAction` wins whenever it sent one; this is what a host is told when
 * the code arrives without it, and it is the difference between "could not
 * resolve the scope" and knowing whether to re-ask, re-query or move on.
 */
const NEXT_STEP_BY_REASON: Record<string, string> = {
  page_target: 'That URL is the lookup itself; call `request` again with the URL as the query.',
  contextual_url:
    'The URL was background, not the target; call `request` again with the question as the query.',
  unresolved_intent:
    'Ask the user for the scope choice or field named above, then call `request` again with it.',
  classifier_failure:
    'The router could not classify this one and charged nothing. Continue with your own tools, or call `request` once more.',
};

/** One short line saying what the host does next, per routine outcome. */
const NEXT_STEP: Record<string, string> = {
  native: 'Continue with your own tools. Nothing was bought.',
  needs_input:
    'Ask the user for the missing detail, then call `request` again with it. Nothing was bought.',
  needs_approval:
    'Report the command above to the user; this build will not raise a spend limit on its own.',
};

/** The headline: calm for a routine outcome, explicit for a real failure. */
function summaryFor(status: FailStatus, reason: string): string {
  if (status === 'native') return `No paid lookup needed: ${reason}`;
  if (status === 'needs_input') return `More input needed: ${reason}`;
  if (status === 'needs_approval') return `Approval needed: ${reason}`;
  return `x402 request ${status}: ${reason}`;
}

interface FailExtras {
  /** What was AUTHORIZED when that is more than what settled: a waived fee
   *  leaves a signed authorization behind, and the host is told so. */
  exposureAtomic?: bigint;
  settlement?: string;
  /** Which rule failed, whether the body was JSON, its size and a bounded
   *  redacted preview: what tells a parse miss from an HTML error page. */
  diagnosis?: Record<string, unknown>;
  /** The backend's own stable error code, from a typed non-2xx body. */
  errorCode?: string;
  /** What stopped a non-execute decision, in the backend's own terms. */
  diagnostics?: DecisionDiagnostics;
}

/** The backend's own instruction, then the one its reasonCode implies, then the
 *  generic one for the outcome. Never empty while any of the three exists. */
function nextStepFor(status: FailStatus, diagnostics: DecisionDiagnostics | undefined): string {
  const fromServer = diagnostics?.nextAction.trim() ?? '';
  if (fromServer.length > 0) return fromServer;
  const byReason =
    diagnostics !== undefined ? NEXT_STEP_BY_REASON[diagnostics.reasonCode] : undefined;
  return byReason ?? NEXT_STEP[status] ?? '';
}

function fail(
  status: FailStatus,
  reason: string,
  routerFeeAtomic = 0n,
  providerAtomic = 0n,
  extras: FailExtras = {},
): RequestToolResult {
  const routine = ROUTINE.has(status);
  const { diagnostics } = extras;
  return {
    isError: !routine,
    summary: summaryFor(status, reason),
    envelope: {
      status,
      reason,
      ...(extras.errorCode !== undefined ? { errorCode: extras.errorCode } : {}),
      // The status is the fact; the next step is what to do about it. A routine
      // outcome carries both, because an answer with no instruction is what
      // makes a model treat an ordinary `native` as a dead end. The BACKEND'S
      // own next action wins when it sent one: it knows which field is missing.
      ...(routine || diagnostics !== undefined
        ? { nextStep: nextStepFor(status, diagnostics) }
        : {}),
      ...(diagnostics !== undefined
        ? {
            reasonCode: diagnostics.reasonCode,
            stage: diagnostics.stage,
            ...(diagnostics.missing.length > 0 ? { missing: diagnostics.missing } : {}),
          }
        : {}),
      // WHAT WAS CHARGED, not what was authorized: the router waives the fee on
      // every outcome it cannot execute, and reporting the signed amount there
      // told the model an answer cost money it was never charged.
      cost: costLines(routerFeeAtomic, providerAtomic),
      // And what LEFT, whenever the two differ. A signed authorization is a
      // bearer instrument; a body saying "no charge" does not revoke it.
      ...(extras.exposureAtomic !== undefined
        ? { authorizationExposure: toMoney(extras.exposureAtomic.toString()).usd }
        : {}),
      ...(extras.settlement !== undefined ? { settlement: extras.settlement } : {}),
      ...(extras.diagnosis !== undefined ? { diagnosis: extras.diagnosis } : {}),
      providerContentUntrusted: true,
    },
  };
}

function withKey(result: RequestToolResult, sessionKey: string | undefined): RequestToolResult {
  return sessionKey === undefined ? result : { ...result, sessionKey };
}
