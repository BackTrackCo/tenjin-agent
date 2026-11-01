import {
  runPay,
  settlementTx,
  type AdvertisedTerms,
  type PaidLeg,
  type PayDeps,
} from '../commands/pay';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { downloadsDir } from '../lib/paths';
import { mask } from '../lib/redact';
import {
  assertResultSchema,
  canonicalHash,
  projectBody,
  validateResultBody,
} from '../lib/request-schema';
import { resolveContextSettings } from '../lib/settings';
import { admitPlan, admitQuote, type PlanSlot } from '../lib/spend-plan';
import { quoteClosed, readQuote } from '../lib/spend-quotes';
import type { SpendAuthorizer, WalletProvider } from '../lib/wallet';
import type { TenjinSigner } from '../lib/wallet/provider';
import type { CommandContext } from '../context';
import {
  buildSpecRequest,
  specInputProblems,
  specText,
  mergedInput,
  type SpecRequest,
} from './spec-call';
import {
  claimSpecPayment,
  readSpec,
  settleSpecPayment,
  storeChoices,
  storeFullResult,
  storeSpecs,
  type EarlierPayment,
  type KeptChoices,
} from './specs';
import {
  DEADLINE_AFTER_PAYMENT_SENT,
  reportSpecOutcome,
  requestBrowse,
  requestDecision,
  requestToolSpec,
  type BrowseRow,
  type DecisionOutcome,
  type SpecOutcome,
  type UnpaidReason,
  type DecisionContract,
  type DecisionDeps,
  type DecisionDiagnostics,
  type DecisionRoute,
  type Job,
  type OfferSpec,
} from './decision';
import { pickChoice, runChoiceSet, runCount, showChoices, takesResult } from './choices';
import {
  approveCall,
  oneCall,
  paymentProvider,
  planStop,
  quotedCall,
  quoteView,
  walletBalance,
  type PlanStop,
  type QuotedCall,
} from './plan';
import { depositSentence, FEE_REQUIRED, isFeeRequired, unpaidSentence, type RouteFor } from './fee';
import { clearRouterMemo } from './router-memo';
import { agentFixOf } from './wallet-reasons';
import { openLookupFooter, SILENT_FOOTER, type LookupFooter } from './progress';
import { saveInlineMedia } from './inline-media';
import {
  appendPaidRecord,
  MAX_MEDIA_FILES,
  mediaUrlsIn,
  reconcilePayments,
  recordedSent,
  saveMedia,
  createUniqueFile,
  maskDeep,
  updatePaidRecord,
  writeAll,
  type MediaTransport,
  type PaidRecord,
  type SignedAuthorization,
} from './paid';
import { routerSettings } from './settings';
import type { Harness } from './names';
import {
  answerState,
  completeJob,
  MAX_CALL_WAIT_MS,
  pollTarget,
  pollUntil,
  sellerSaid,
  type PollAnswer,
  type PollDeps,
  type PollTransport,
} from './jobs';
import {
  endTake,
  KEPT_RESULT_CHARS,
  MAX_TAKES,
  readTake,
  readTakes,
  writeTake,
  type JobTake,
} from './job-store';

/**
 * The `request` tool: one free decision per lookup, then ONE payment, to the
 * provider.
 *
 * AN OFFER WITH A SPEC RUNS HERE, IN ONE CALL. The hook keeps each offered
 * service's spec by its id, and its line is the skeleton of the call:
 * `{id, input}` is checked against the spec, built into the spec's request and
 * paid straight to the provider, with no second decision. An input that misses
 * gets every problem and the whole spec back, locally, with nothing paid; `{id}`
 * alone shows the spec too. The server is told only how the call ended. A
 * query with no id comes back as the picked service's spec under a fresh id,
 * with nothing paid; the next call fills it.
 *
 * AN ID WITH NO KEPT SPEC builds nothing. An input for it (the spec expired
 * or was pruned) is answered here, with no server call and nothing paid: the
 * agent starts over with `request({query})`. A query with it goes to the
 * server, which binds the free docs lookup, the one offer with no spec, from
 * the query in code, and points any other id back to a fresh query.
 *
 * A CHOICE SET, when a line offers one, is the user's to pick from:
 * `request({id, choice})` runs the picked option as its own offer, under its
 * own id, and `choice: "all"` runs every option side by side, one payment
 * each (`choices.ts`).
 *
 * WHAT IS CHECKED LOCALLY, BEFORE ANYTHING IS SIGNED: the input against the
 * spec's schema, the decision's arguments against the schema it carries, its
 * success rule against the compiler, its destination against the shared
 * preflight inside `runPay`, and the call's SPEND PLAN: every payment it will
 * make, at its quoted amount, whose total meets `maxAutoSpend` (the limit for
 * the whole call), the day's `sessionBudget` and the balance at once
 * (`lib/spend-plan.ts`). `runPay` signs a router payment only against a slot
 * of an admitted plan, and `gateSpend` still meets each one. That is the
 * whole money story: a hostile backend can name any origin and spend at most
 * one `maxAutoSpend` per call inside the daily budget without the user's yes.
 *
 * `needs_approval` is a LOCAL outcome only. The server never sends it: it is
 * what a plan over the limits looks like from here. Nothing is paid. Where the
 * host offers `approve`, the plan is kept as a quote, and the user's yes to
 * the host's own prompt on `approve({quote})` runs it exactly
 * ({@link runApproveTool}).
 */

export interface RequestToolArgs {
  /** Optional only beside `input`. */
  query?: string;
  /** The turn id from the hook's line. It names the service that line offered;
   *  it grants nothing locally, every cap still applies. */
  id?: string;
  /** The host's own input for the offered service, per its spec. This client
   *  builds the request from the spec kept for the id; with none kept, nothing
   *  is built. Every cap still applies. */
  input?: Record<string, unknown>;
  /** One option's key from the choice set the line offered with `id`, run as
   *  that option's own offer under its own id, or `all` for every option side
   *  by side, one payment each. Every cap still applies. */
  choice?: string;
  /** A free browse of the tool list: the need in a few words, or `""` for
   *  every tool by kind. Sent alone; nothing is paid. */
  browse?: string;
  /** A browse row's id: that tool's spec, kept under a fresh offer id for
   *  `{id, input}` to run. Sent alone; nothing is paid. */
  tool?: string;
  /** Several takes of one media call, 2 to 5, each its own payment, where the
   *  spec allows them. The whole set meets the spend policy before any is
   *  signed. */
  count?: number;
  /** A job an earlier call left running, by the id its result named: polled
   *  again, with nothing paid. */
  job?: string;
}

/** The server's own cap on `input`, serialized. */
export const MAX_INPUT_BYTES = 16 * 1024;

export interface RequestToolDeps {
  ctx: CommandContext;
  /** The SAME provider the MCP server pre-warmed. `runPay` opens its own
   *  otherwise, and the local one re-runs scrypt per process, which is the
   *  2.3 s the background unlock exists to hide. */
  provider?: WalletProvider;
  signer?: TenjinSigner;
  authorizer: SpendAuthorizer;
  fetchImpl?: typeof fetch;
  /** Test seam forwarded to the provider leg. */
  payDeps?: PayDeps;
  /** The directory `router.*` resolves from; defaults to `process.cwd()`, which
   *  Claude Code sets to the project directory for an MCP server. */
  cwd?: string;
  /** Clock seam for a saved file's name. */
  now?: () => number;
  /** The paid path, passed by `tenjin mcp`. Absent, the routing call takes
   *  the free path. */
  route?: RouteFor;
  /** Test seam for the media download; production pins each connection to
   *  the address it validated. */
  mediaTransport?: MediaTransport;
  /** Test seam for a job's polls, pinned the same way in production. */
  pollTransport?: PollTransport;
  /** Clock seam for the wait between polls. */
  sleep?: (ms: number) => Promise<void>;
  /** When this tool call started: every job it runs waits from here. Set by
   *  {@link runRequestTool}. */
  startedAt?: number;
  /** What this tool call may still write to the downloads directory, shared by
   *  every take. Set by {@link runRequestTool}. */
  downloads?: { leftBytes: number };
  /** Told before each poll of a job this call waits on: the MCP server sends
   *  it as a progress notification, which keeps a waiting host's timeout from
   *  running out. */
  onPoll?: () => Promise<void> | void;
  /** The host puts every `approve` call to a person first (Claude Code's
   *  `requiresUserInteraction`, `mcp.ts`), so a call over the limits is kept
   *  as a quote for it. Without it, such a call is refused with nothing kept. */
  approves?: boolean;
  /** The host lets one call wait as long as a job's own `maxWaitS` (Claude
   *  Code moves a long call into the background and delivers it when it
   *  ends), so the call is not handed back `running` at
   *  {@link MAX_CALL_WAIT_MS}. */
  waitsForJobs?: boolean;
  /** The host that launched this server; absent is Claude Code. */
  harness?: Harness;
}

/** What one tool call may save to disk, across every take and file. */
export const MAX_CALL_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
/** Why a file this call had no room left for was not saved. */
const CAP_REACHED = `not saved: this call already saved ${Math.round(MAX_CALL_DOWNLOAD_BYTES / 1_048_576)} MB, its cap`;
const DOWNLOAD_FAILED = 'a file it links to failed to download';

export interface RequestToolResult {
  isError: boolean;
  summary: string;
  envelope: Record<string, unknown>;
}

export async function runRequestTool(
  args: RequestToolArgs,
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  // A ROUTING DEPOSIT IS SAID WHERE THE AGENT READS IT: once, in the result of
  // the call that took it, beside whatever that call answered. A hook leg says
  // it in its `systemMessage` instead.
  const routes: DecisionRoute[] = [];
  const { route } = deps;
  const call: RequestToolDeps = {
    ...deps,
    startedAt: deps.startedAt ?? (deps.now ?? Date.now)(),
    downloads: deps.downloads ?? { leftBytes: MAX_CALL_DOWNLOAD_BYTES },
  };
  const result = await requestTool(
    args,
    route === undefined
      ? call
      : {
          ...call,
          route: async (baseUrl) => {
            const picked = await route(baseUrl);
            if (picked !== null) routes.push(picked);
            return picked;
          },
        },
  );
  const deposited = routes.reduce((sum, r) => sum + (r.deposited?.() ?? 0n), 0n);
  return deposited > 0n
    ? { ...result, summary: `${result.summary}\n${depositSentence(deposited)}` }
    : result;
}

export interface ApproveToolArgs {
  /** The quote a `needs_approval` result named. */
  quote: string;
  /** The quote's total and what it buys, which the host's prompt shows the
   *  user; each must match the quote. */
  total?: string;
  what?: string;
}

/**
 * `approve({quote, total, what})`: A QUOTE THE USER SAID YES TO, RUN EXACTLY.
 * The quote is the plan a call over the automatic limits kept, with nothing
 * paid: the call, its input, each payment and the total. Nothing about it
 * changes here; the agent sends only its id and the numbers it was shown.
 *
 * THE YES IS THE HOST'S OWN PROMPT. The tool is offered only to a host that
 * puts every call of it to a person before it reaches this process (Claude
 * Code's `requiresUserInteraction`, `mcp.ts`), so a call here is that
 * person's yes; nothing on disk counts as one. The prompt shows the call's
 * arguments, so the total and what it buys must be there and must be the
 * quote's. A yes runs the quote once, past `maxAutoSpend` and the day's
 * budget, which a person just agreed to, never past the balance, and answers
 * as `request` would have.
 */
export async function runApproveTool(
  args: ApproveToolArgs,
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  const off = await routerOff(deps);
  if (off !== null) return fail('needs_input', off, { nextStep: ROUTER_OFF_NEXT_STEP });
  const { dataDir } = deps.ctx;
  const now = deps.now ?? Date.now;
  const fresh = 'Call request again with the same call for a fresh quote.';
  const quote = await readQuote(dataDir, args.quote.trim());
  const call = quote !== null ? quotedCall(quote) : null;
  if (quote === null || call === null) {
    return fail(
      'needs_input',
      'No quote is kept on this machine under that id, so nothing was paid.',
      { nextStep: fresh },
    );
  }
  const closed = quoteClosed(quote, now());
  if (closed !== null) {
    return fail(
      'needs_input',
      closed === 'used'
        ? 'That quote already ran, and a quote pays once, so nothing more was paid.'
        : 'That quote expired (a quote waits ten minutes for a yes), so nothing was paid.',
      {
        nextStep: closed === 'used' ? 'Its result is in the approve call that ran it.' : fresh,
      },
    );
  }
  // THE NUMBERS A PERSON IS SHOWN ARE THE QUOTE'S: an echo that differs is
  // refused with the true ones, never run.
  const total = BigInt(quote.totalAtomic);
  const echoedTotal = args.total !== undefined ? usdAtomic(args.total) : undefined;
  if (
    (args.total !== undefined && echoedTotal !== total) ||
    (args.what !== undefined && args.what.trim() !== quote.what)
  ) {
    return fail(
      'needs_input',
      `That quote is for ${quote.what}, $${toMoney(quote.totalAtomic).usd} in total, not what this call said, so nothing was paid.`,
      { quote: quoteView(quote), nextStep: `Call ${approveCall(quote)}.` },
    );
  }
  // The prompt showed this call's arguments: without the total and what they
  // buy, nobody saw what they said yes to.
  if (args.total === undefined || args.what === undefined) {
    return fail(
      'needs_input',
      "Send the quote's total and what it buys with it, so the user sees them when asked; nothing was paid.",
      { quote: quoteView(quote), nextStep: `Call ${approveCall(quote)}.` },
    );
  }
  // THE WALLET OPENS BEFORE THE QUOTE IS USED UP. `admitQuote` spends the
  // quote's one run, so a wallet that will not sign (a passphrase gone or
  // wrong) must stop here, with the quote still open for a yes after the
  // person repairs it. `runPay` reuses this provider and its opened signer.
  const provider = paymentProvider(deps);
  try {
    await provider.getSigner();
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    return fail(
      'failed',
      `${quote.sentence} ${err.message} No payment was signed. ${agentFixOf(err)}`.trim(),
      { nextStep: 'Tell the user. The quote waits for its ten minutes; nothing was paid.' },
    );
  }
  const call_: RequestToolDeps = {
    ...deps,
    provider,
    startedAt: deps.startedAt ?? now(),
    downloads: deps.downloads ?? { leftBytes: MAX_CALL_DOWNLOAD_BYTES },
  };
  const settings = await resolveContextSettings(deps.ctx);
  const admitted = await admitQuote(dataDir, quote.id, {
    balance: () => walletBalance(call_, settings.rpcUrl),
    now,
  });
  if ('refused' in admitted) {
    return fail(
      'needs_input',
      admitted.refused === 'used'
        ? 'That quote already ran, and a quote pays once, so nothing more was paid.'
        : 'That quote can no longer run, so nothing was paid.',
      { nextStep: fresh },
    );
  }
  if ('short' in admitted) {
    const { balanceAtomic, totalAtomic } = admitted.short;
    return fail(
      'failed',
      `${quote.sentence} The wallet holds $${toMoney(balanceAtomic.toString()).usd}, $${toMoney((totalAtomic - balanceAtomic).toString()).usd} short. The wallet has insufficient USDC; no payment was signed. Fund this wallet on Base with \`tenjin wallet fund\` before paying.`,
      { nextStep: 'Tell the user. The quote waits for its ten minutes; nothing was paid.' },
    );
  }
  const slots = admitted.admitted;
  const reportDeps: ReportDeps = {
    ctx: deps.ctx,
    baseUrl: settings.baseUrl,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  const footer = await openLookupFooter(dataDir, call.kind !== 'call' ? { id: call.id } : {});
  await footer.routing();
  switch (call.kind) {
    case 'spec':
      return runSpec(call.id, call.spec, call.input, call_, footer, reportDeps, slots);
    case 'count':
      return runCount(
        call.id,
        call.spec,
        call.input,
        call.count,
        call_,
        footer,
        reportDeps,
        settings,
        slots,
      );
    case 'choices':
      return runChoiceSet(call.id, call.kept, call.input, call_, footer, reportDeps, settings, {
        specs: call.specs,
        keys: call.keys,
        slots,
      });
    case 'call':
      return (await payAndDeliver(call.call, { slot: slots[0]! }, call_, footer)).result;
  }
}

/** An echoed total in USD, `$0.775` or `0.775`, as atomic units; undefined
 *  when it is not one. */
function usdAtomic(text: string): bigint | undefined {
  try {
    return BigInt(
      parseUsdToAtomic(
        text
          .trim()
          .replace(/^\$/, '')
          .replace(/\s*USD$/i, ''),
      ),
    );
  } catch {
    return undefined;
  }
}

async function requestTool(
  args: RequestToolArgs,
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  // THE SAME SWITCH THE HOOKS OBEY, read first. The tool is pre-allowed, so
  // without this it would be a second path off the machine in a repository the
  // user marked private: nothing is sent and nothing is paid.
  const off = await routerOff(deps);
  if (off !== null) return fail('needs_input', off, { nextStep: ROUTER_OFF_NEXT_STEP });
  if (args.browse !== undefined || args.tool !== undefined) return readToolList(args, deps);
  // A JOB AN EARLIER CALL LEFT RUNNING, by the id its result named: polled from
  // its record, with nothing built and nothing paid.
  if (args.job !== undefined && args.job.length > 0) {
    if (args.input !== undefined || args.choice !== undefined || args.count !== undefined) {
      return fail('needs_input', 'A job resumes on its own: send only its id, as `job`.', {
        nextStep: `Call request({job: ${JSON.stringify(args.job)}}); nothing was sent or paid.`,
      });
    }
    return resumeJob(args.job, deps);
  }
  const offered = args.id !== undefined && args.id.length > 0 ? args.id : undefined;
  let id = offered;
  const { input } = args;
  const choice = args.choice !== undefined && args.choice.length > 0 ? args.choice : undefined;
  // SEVERAL TAKES OF ONE CALL, refused here, before anything is read or sent,
  // unless they can run: a whole number of takes, on an offer's filled input,
  // never beside a choice.
  const count = args.count !== undefined && args.count !== 1 ? args.count : undefined;
  if (count !== undefined) {
    const refusal =
      !Number.isInteger(count) || count < 2 || count > MAX_TAKES
        ? `count is a whole number of takes from 2 to ${MAX_TAKES}`
        : choice !== undefined
          ? 'count runs several takes of one service, so it does not go with a choice'
          : input === undefined || offered === undefined
            ? "count goes with the offer's id and its filled input"
            : undefined;
    if (refusal !== undefined) {
      return fail('needs_input', `${refusal}; nothing was sent or paid.`);
    }
  }
  // A CHOICE NAMES AN OPTION OF THE SET KEPT FOR THE LINE'S ID, and from here
  // the call is that option's own offer, under its own id: its spec, its one
  // payment. `all` is every option, run below once the input is checked.
  let set: KeptChoices | undefined;
  if (choice !== undefined) {
    const picked = await pickChoice(deps.ctx.dataDir, offered, choice);
    if ('refused' in picked) return picked.refused;
    if ('all' in picked) set = picked.all;
    else id = picked.id;
  }
  if (set !== undefined && input === undefined) return showChoices(id!, set);
  // THE OFFER'S SPEC, when the hook kept one for this id: its id alone shows
  // the spec, with no network call and nothing paid, so the agent sees the
  // real inputs before it builds any.
  const spec = id !== undefined && set === undefined ? await readSpec(deps.ctx.dataDir, id) : null;
  if (spec !== null && input === undefined) return showSpec(id!, spec);
  // Takes only where the spec says its service runs them, and no more of
  // them than it allows: a count is several payments, and one service's
  // files are what several takes are for.
  if (
    count !== undefined &&
    spec !== null &&
    (spec.takes === undefined || count > spec.takes.max)
  ) {
    return fail(
      'needs_input',
      spec.takes === undefined
        ? `${spec.provider} does not run several takes of one call, so count was not used; nothing was sent or paid.`
        : `${spec.provider} runs at most ${spec.takes.max} takes of one call; nothing was sent or paid.`,
      {
        nextStep: `Call request({id: ${JSON.stringify(id)}, input: {...}})${spec.takes === undefined ? ' without count' : ` with count up to ${spec.takes.max}`}.`,
      },
    );
  }
  const query = (args.query ?? '').trim().slice(0, 8_000);
  if (query.length === 0 && input === undefined) {
    return fail(
      'needs_input',
      id !== undefined
        ? 'No spec is kept for that id (it expired, or its line asked for a query), so send the query its line named with the id, or a query alone.'
        : "A request needs an offer's id, or a query naming the task, its inputs and any constraints.",
    );
  }
  // THE HOOKS NEVER SEE THIS CALL, so the native hook's rule applies here too: a
  // query the mask would change is not sent, masked or otherwise. The server
  // stores it against the id and the provider logs it, and an injected page can
  // write it.
  if (mask(query) !== query) {
    return fail('native', 'the query carries a credential-shaped value, so nothing was sent');
  }
  // The same rule for an input, which goes to the seller as the request body
  // or its query string.
  if (input !== undefined) {
    // An input fills the spec of the service that id named, so with no id it
    // has nothing to go to.
    if (id === undefined) {
      return fail(
        'needs_input',
        'An input goes with the id from the line that named the service; send both.',
      );
    }
    const serialized = JSON.stringify(input);
    if (Buffer.byteLength(serialized) > MAX_INPUT_BYTES) {
      return fail('needs_input', `The input is over ${MAX_INPUT_BYTES} bytes; send a smaller one.`);
    }
    // EVERY KEY AND STRING LEAF, masked on its own: in the serialized JSON a
    // key after an escaped `\n` reads as one word (`nsk-ant-…`), so the
    // boundaries the mask anchors on are not there.
    if (JSON.stringify(maskDeep(input)) !== serialized) {
      return fail('native', 'the input carries a credential-shaped value, so nothing was sent');
    }
    // NO SPEC KEPT FOR THE ID: it expired or was pruned, and nobody else builds
    // the call. Answered here, with no server call: one more call costs less
    // than a guess. A set reads each option's spec itself.
    if (spec === null && set === undefined) {
      return fail(
        'needs_input',
        'The spec for that offer is no longer kept on this machine (it expired or was pruned), so nothing was sent or paid.',
        { nextStep: 'Call request({query}) with the task for a fresh offer, then fill its line.' },
      );
    }
  }
  // THE FOOTER, OPENED FIRST AND TRUSTED WITH NOTHING: it shows this lookup in
  // the terminal while it runs, resolved to a session through the hook's own
  // binding for the line's id (never a chosen option's), and every call on it
  // swallows its own failure.
  const footer = await openLookupFooter(deps.ctx.dataDir, {
    ...(offered !== undefined ? { id: offered } : {}),
  });
  await footer.routing();
  const settings = await resolveContextSettings(deps.ctx);
  // SETTLEMENTS EARLIER CALLS LEFT UNKNOWN, resolved a few at a time from the
  // chain, BESIDE the lookup and never in front of it: a slow or rate-limited
  // RPC costs this call nothing, and a record it could not answer for waits
  // `RECHECK_MS` before it is asked about again. Its own errors are its own.
  void reconcilePayments(deps.ctx.dataDir, {
    rpcUrl: settings.rpcUrl,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  }).catch(() => undefined);
  const decisionDeps = {
    ctx: deps.ctx,
    baseUrl: settings.baseUrl,
    acceptsBazaar: settings.experimentalBazaar,
    harness: deps.harness ?? 'claude',
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };

  // EVERY OPTION OF A SET, each its own offer, checked, claimed and paid
  // through the same steps as one, after one spend check for them all.
  if (set !== undefined && input !== undefined) {
    return runChoiceSet(id!, set, input, deps, footer, decisionDeps, settings);
  }

  // A SPEC AND AN INPUT: the agent filled the spec's request itself, so it is
  // checked and sent here and paid straight to the provider, with no second
  // decision. The server hears only how it ended.
  if (spec !== null && input !== undefined) {
    // SEVERAL TAKES: each its own claim and payment, after one spend check
    // for them all (`choices.ts`).
    if (count !== undefined) {
      return runCount(id!, spec, input, count, deps, footer, decisionDeps, settings);
    }
    return runSpec(id!, spec, input, deps, footer, decisionDeps);
  }

  // ONE CALL, ONE DECISION. The query the model wrote goes to the backend with
  // the turn id when it has one: the free docs offer's id binds the query, and
  // with no id the gate picks a service and answers with its spec. An id the
  // backend does not know is its own plain note, and the pick still runs from
  // the query.
  // ON THE PAID PATH the payer pays the routing fee with the stock x402
  // client, and a call it cannot pay takes the free path.
  const ask = async () => {
    const route = (await deps.route?.(settings.baseUrl)) ?? null;
    const outcome = await requestDecision(
      'tool',
      { query, ...(id !== undefined ? { id } : {}) },
      { ...decisionDeps, ...(route !== null ? { route } : {}) },
    );
    return { route, outcome };
  };
  const first = await ask();
  let fresh = first.outcome;
  // The machine's "no paid path" memo sent this call to the free path, which
  // now asks for the fee: the memo is stale, so ask once more on the paid path.
  if (
    deps.route !== undefined &&
    first.route === null &&
    fresh.status === 'decided' &&
    isFeeRequired(fresh.decision)
  ) {
    await clearRouterMemo(deps.ctx.dataDir, 'paid-path-absent', settings.baseUrl);
    fresh = (await ask()).outcome;
  }
  if (fresh.status === 'skipped') {
    await footer.done('native');
    return fail(
      'native',
      fresh.why === DEADLINE_AFTER_PAYMENT_SENT
        ? 'A routing payment (possibly the channel deposit) went out, and this call ran out of time before its answer. `tenjin mcp` lets it finish so it is recorded; nothing else was paid.'
        : `${unpaidSentence(fresh.why, 'agent') ?? ''} This call ran out of time before the free path answered, so nothing was routed or paid.`.trim(),
      { nextStep: 'Use your own tools for this one.' },
    );
  }
  if (fresh.status === 'failed') {
    await footer.done('failed');
    return fail('failed', fresh.reason, {
      ...(fresh.errorCode !== undefined ? { errorCode: fresh.errorCode } : {}),
    });
  }
  const { decision, note } = fresh.decision;

  // THE FREE PATH NO LONGER ROUTES. The server's line says to update the CLI,
  // which is wrong for this one: what stops routing here is a routing fee this
  // call could not pay, for the reason the payer gave.
  if (isFeeRequired(fresh.decision)) {
    // The fee is on: the next call asks for the paid path again.
    await clearRouterMemo(deps.ctx.dataDir, 'paid-path-absent', settings.baseUrl);
    await footer.done('native');
    return fail(
      'native',
      unpaidSentence(fresh.freePath ?? FEE_REQUIRED, 'agent') ?? unpaidSentence(FEE_REQUIRED)!,
      { nextStep: 'Tell the user this once, and use your own tools for now.' },
    );
  }

  // THE PICKED SERVICE'S SPEC, for a query with no id, kept like a hook's and
  // shown with the skeleton of the next call, `request({id, input})`. Nothing
  // is paid on this answer: only a filled spec pays.
  if (decision.action === 'spec') {
    const picked: OfferSpec = { ...decision.spec, id: decision.id };
    await storeSpecs(deps.ctx.dataDir, [picked]);
    await footer.done('service found');
    return showSpec(picked.id, picked, [], decision.hint);
  }

  // A SERVICE NOBODY CURATED, named for the host to judge. Nothing is paid on
  // this answer. With specs they are kept like the hook's, and the pick's own
  // spec is shown, as for a curated pick. Without, the server's line says how
  // to call it, with the id it minted and the input the host builds, and that
  // second call pays through the execute path below like any other.
  if (decision.action === 'discovered') {
    await storeSpecs(deps.ctx.dataDir, decision.specs);
    // A CHOICE SET is kept like the hook's, and its line, which names every
    // option and the call, is the next step in place of an "also offered"
    // line per option.
    const { choices } = decision;
    if (choices !== undefined) {
      await storeChoices(deps.ctx.dataDir, decision.id, { choices, hint: decision.hint });
    }
    await footer.done('service found');
    const picked = decision.specs?.find((spec) => spec.id === decision.id);
    if (picked !== undefined) {
      const options = new Set(choices?.options.map((option) => option.id));
      return showSpec(
        picked.id,
        picked,
        decision.specs!.filter((spec) => spec !== picked && !options.has(spec.id)),
        choices !== undefined ? decision.hint : undefined,
      );
    }
    const { candidate } = decision;
    return {
      isError: false,
      summary: decision.hint,
      envelope: {
        status: 'discovered',
        id: decision.id,
        service: {
          provider: candidate.provider,
          url: candidate.url,
          method: candidate.method,
          description: candidate.description,
          price: `$${toMoney(candidate.providerPriceAtomic).usd}`,
          input: candidate.input,
        },
        cost: costLines(0n),
        ...(note !== undefined ? { note } : {}),
        providerContentUntrusted: true,
      },
    };
  }

  if (decision.action !== 'execute') {
    await footer.done(decision.action === 'native' ? 'native' : 'needs_input');
    // Both non-execute arms carry diagnostics by construction now: an answer
    // without them does not parse, so there is nothing to fall back to here.
    return fail(
      decision.action === 'native' ? 'native' : 'needs_input',
      decision.reason ?? 'The router did not select a paid capability.',
      { diagnostics: decision.diagnostics, ...(note !== undefined ? { note } : {}) },
    );
  }

  const contract = decision.contract;
  const refusal = checkContract(contract);
  if (refusal !== null) {
    await footer.done(refusal.status);
    return fail(refusal.status, refusal.reason);
  }

  // The decision's advertised price caps the live 402, refused before signing.
  // It bounds a provider or stale catalog charging over that price, and an
  // injected `request` call; it does not bound a hostile server, which can
  // still quote up to `maxAutoSpend`. `gateSpend` stays the money authority.
  // The request is the server's, sent verbatim: the only thing built here is
  // the decision about whether to send it.
  const call: ProviderCall = {
    capabilityId: decision.capabilityId,
    provider: decision.provider,
    ...(decision.label !== undefined ? { label: decision.label } : {}),
    // The free docs lookup, the one answer with no spec: text, never files.
    media: false,
    request: contract.request,
    terms: { source: decision.provider, maxAmountAtomic: decision.providerPriceAtomic },
    requestKey: `${decision.capabilityId}:${canonicalHash(contract.arguments ?? {})}`,
    ...(contract.resultSchema !== undefined ? { resultSchema: contract.resultSchema } : {}),
    ...(contract.arguments !== undefined ? { parameters: contract.arguments } : {}),
    // What the ledger records as sent: the host's input, or its query.
    sent: input !== undefined ? JSON.stringify(maskDeep(input)) : query,
    ...(note !== undefined ? { note } : {}),
  };
  return (await payAndDeliver(call, { alone: { kind: 'call', call } }, deps, footer)).result;
}

/**
 * THE TOOL LIST, READ FOR FREE. `{browse}` returns the rows the server's tool
 * list has for a need, or every row by kind; `{tool}` fetches one row's spec
 * and keeps it under the fresh offer id the server minted, so `{id, input}`
 * runs it exactly as it runs a hook's offer. Neither is a lookup: no gate call,
 * no routing fee, nothing paid, and the hooks' per-lookup routing is unchanged.
 * Each form is sent alone, and the credential rule every other call follows
 * applies to its words.
 */
async function readToolList(
  args: RequestToolArgs,
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  const others = (['query', 'id', 'input', 'choice', 'count', 'job'] as const).filter(
    (key) => args[key] !== undefined,
  );
  if ((args.browse !== undefined && args.tool !== undefined) || others.length > 0) {
    return fail(
      'needs_input',
      "`browse` and `tool` are each sent alone: browse the list, then call request({tool}) with one row's id.",
    );
  }
  const words = (args.browse ?? args.tool ?? '').trim().slice(0, 8_000);
  if (mask(words) !== words) {
    return fail('native', 'the words carry a credential-shaped value, so nothing was sent');
  }
  const settings = await resolveContextSettings(deps.ctx);
  const decisionDeps = {
    ctx: deps.ctx,
    baseUrl: settings.baseUrl,
    acceptsBazaar: settings.experimentalBazaar,
    harness: deps.harness ?? 'claude',
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
  if (args.browse !== undefined) {
    const listed = await requestBrowse(words, decisionDeps);
    if (listed.status !== 'decided') return listFailure(listed);
    return showRows(listed.decision.rows);
  }
  if (words.length === 0) {
    return fail('needs_input', '`tool` takes a row id from request({browse}).');
  }
  const fetched = await requestToolSpec(words, decisionDeps);
  if (fetched.status !== 'decided') return listFailure(fetched);
  const { decision } = fetched.decision;
  if (decision.action === 'spec') {
    const picked: OfferSpec = { ...decision.spec, id: decision.id };
    await storeSpecs(deps.ctx.dataDir, [picked]);
    return showSpec(picked.id, picked, [], decision.hint);
  }
  if (decision.action === 'native' || decision.action === 'needs_input') {
    return fail(decision.action, decision.reason ?? 'That tool has no spec to show.', {
      diagnostics: decision.diagnostics,
    });
  }
  return fail(
    'needs_input',
    'The router answered that tool id with no spec, so nothing was kept or paid.',
    { nextStep: 'Call request({query}) with the task instead.' },
  );
}

/** A read of the list that got no answer. Nothing was paid on either form. */
function listFailure(
  outcome: Exclude<DecisionOutcome<unknown>, { status: 'decided' }>,
): RequestToolResult {
  if (outcome.status === 'skipped') return fail('failed', outcome.why);
  return fail('failed', outcome.reason, {
    ...(outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
  });
}

/** One plain line of the server's text, for a row shown to the model. */
const flat = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').trim();

/** The rows as the model reads them: each tool's name, what it does, its
 *  price and the call that fetches its spec. */
function showRows(rows: readonly BrowseRow[]): RequestToolResult {
  const nextStep =
    'Call request({tool: "<id>"}) for a tool\'s spec and the call that runs it, free. ' +
    'A free row with no spec runs from request({query}).';
  if (rows.length === 0) {
    return {
      isError: false,
      summary:
        'No tool in the list fits those words. Browse with other words, or with "" for every tool by kind.',
      envelope: { status: 'browse', rows: [], nextStep, cost: costLines(0n) },
    };
  }
  const shown = rows.map((row) => ({
    id: row.id,
    label: flat(row.label),
    does: flat(row.does),
    price: row.free ? 'free' : flat(row.price),
    kind: flat(row.kind),
  }));
  return {
    isError: false,
    summary: [
      ...shown.map((row) => `${row.label} (id ${row.id}, ${row.price}, ${row.kind}): ${row.does}`),
      nextStep,
    ].join('\n'),
    envelope: {
      status: 'browse',
      rows: shown,
      nextStep,
      cost: costLines(0n),
      providerContentUntrusted: true,
    },
  };
}

/** The answer to `request({id})` when the hook kept that offer's spec, or to
 *  a query the server answered with one: the spec as text, any other service
 *  offered beside it one `request({id})` away, and nothing sent or paid. The
 *  server's `hint`, when it sent one, is the skeleton of the call to make. */
function showSpec(
  id: string,
  spec: OfferSpec,
  others: readonly OfferSpec[] = [],
  hint?: string,
): RequestToolResult {
  const also = others.map(
    (other) =>
      `${other.provider} (${other.description}): request({id: ${JSON.stringify(other.id)}}) shows its spec`,
  );
  const lines = [specText(id, spec)];
  if (also.length) lines.push(`Also offered: ${also.join('; ')}.`);
  if (hint !== undefined) lines.push(`Next: ${hint}`);
  return {
    isError: false,
    summary: lines.join('\n'),
    envelope: {
      status: 'spec',
      id,
      nextStep:
        hint ?? `Call request({id: ${JSON.stringify(id)}, input: {...}}) with the inputs above.`,
      cost: costLines(0n),
    },
  };
}

/** A spec's id that an earlier call already claimed: nothing sent or paid,
 *  and the agent pointed at that call's result or at a new offer. */
export function alreadyPaid(
  id: string,
  spec: OfferSpec,
  earlier: EarlierPayment,
  /** A job that call left is still running, under this id. */
  running?: string,
): RequestToolResult {
  if (running !== undefined && earlier.state !== 'unrecorded') {
    return fail(
      'needs_input',
      `This offer from ${spec.provider} was already paid for, and ${spec.provider} is still working on it, so nothing was paid this time.`,
      {
        nextStep: `Call request({job: ${JSON.stringify(running)}}) for its result; nothing more is paid.`,
      },
    );
  }
  const reason =
    earlier.state === 'paid'
      ? `This offer from ${spec.provider} was already paid for at ${earlier.at} ($${toMoney(earlier.amountAtomic).usd}${earlier.txHash !== undefined ? `, tx ${earlier.txHash}` : ''}), so nothing was paid this time. Its result is in the earlier request result for this id, and the payment is in \`tenjin payments\`.`
      : earlier.state === 'possibly_paid'
        ? `A call for this offer from ${spec.provider} signed a payment at ${earlier.at} that may have left, and it ended without recording how much, so nothing was paid this time. Check \`tenjin payments\` before paying for this again.`
        : earlier.state === 'running'
          ? `A call for this offer from ${spec.provider} already started and may have paid, so nothing was paid this time. Use that call's result.`
          : `This machine could not record this offer's payment, so nothing was sent or paid.`;
  return fail('needs_input', reason, {
    nextStep: `For another call, send request({query}) for a new offer; this id (${id}) pays once.`,
  });
}

/**
 * `request({id, input})` FROM A SPEC. The pinned fields go over the agent's
 * input, the result is checked against the spec's schema (every problem at
 * once, with the allowed values and the example), and the spec's request is
 * filled and paid through `runPay` like any router call: the live 402's price
 * against the spec's ceiling, its payee against the spec's, and the amount
 * signed against the spend policy. Then the server is told how it ended.
 *
 * Three steps, which a choice set runs per option too: the checks, the claim,
 * and the payment. The payment is a plan of one at its live price, or the
 * one slot of a quote the user approved (`approved`).
 */
async function runSpec(
  id: string,
  spec: OfferSpec,
  input: Record<string, unknown>,
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: ReportDeps,
  approved?: PlanSlot[],
): Promise<RequestToolResult> {
  const checked = await prepareSpec(id, spec, input, footer, reportDeps);
  if ('refused' in checked) return checked.refused;
  // ONE PAYMENT PER OFFER, claimed before anything is signed: a retry of this
  // id, or a second call racing it, pays nothing. A repeat is not an outcome,
  // so it is not reported.
  const earlier = await claimSpecPayment(deps.ctx.dataDir, id);
  if (earlier !== null) {
    await footer.done('needs_input');
    return alreadyPaid(id, spec, earlier, await runningJob(deps.ctx.dataDir, id));
  }
  const admission: Admission =
    approved !== undefined ? { slot: approved[0]! } : { alone: { kind: 'spec', id, spec, input } };
  return (await paySpec(checked.prepared, admission, deps, footer, reportDeps)).result;
}

/** The job id to resume when a take of this offer is still running. */
export async function runningJob(dataDir: string, id: string): Promise<string | undefined> {
  const takes = await readTakes(dataDir, id).catch(() => []);
  return takes.some((take) => take.state === 'running') ? id : undefined;
}

/** Where a spec call's outcome report goes. */
export type ReportDeps = Pick<DecisionDeps, 'ctx' | 'baseUrl' | 'fetchImpl' | 'harness'>;

/**
 * EVERY CALL FROM A SPEC IS REPORTED, refused or run, so the server can tell
 * an offer never called from one called and stopped. A refusal before payment
 * is `unpaid` with its reason, which the server never counts as the offer
 * taken. Fire and forget: it never holds or changes the result.
 */
export function reportOutcome(
  reportDeps: ReportDeps,
  id: string,
  outcome: Omit<SpecOutcome, 'id' | 'ms'>,
  startedAt: number,
): void {
  void reportSpecOutcome(
    { id, ...outcome, ms: Date.now() - startedAt },
    {
      ctx: reportDeps.ctx,
      baseUrl: reportDeps.baseUrl,
      ...(reportDeps.fetchImpl !== undefined ? { fetchImpl: reportDeps.fetchImpl } : {}),
      ...(reportDeps.harness !== undefined ? { harness: reportDeps.harness } : {}),
    },
  );
}

/** A spec's call, checked and built: what is claimed and then paid. */
export interface PreparedSpec {
  id: string;
  spec: OfferSpec;
  merged: Record<string, unknown>;
  /** The merged input, masked: what is shown and recorded as sent. */
  sentInput: Record<string, unknown>;
  built: SpecRequest;
}

/**
 * EVERY CHECK A SPEC'S CALL MEETS BEFORE ANYTHING IS CLAIMED: the input
 * against the spec, the request it builds, and the contract a server-built
 * call meets. Local, with nothing sent to the provider or paid; a refusal is
 * the result to hand back, already told to the footer and reported `unpaid`.
 */
export async function prepareSpec(
  id: string,
  spec: OfferSpec,
  input: Record<string, unknown>,
  footer: LookupFooter,
  reportDeps: ReportDeps,
): Promise<{ prepared: PreparedSpec } | { refused: RequestToolResult }> {
  const startedAt = Date.now();
  const unpaid = (reason: UnpaidReason): void =>
    reportOutcome(reportDeps, id, { status: 'unpaid', reason }, startedAt);
  const merged = mergedInput(spec, input);
  const sentInput = maskDeep(merged) as Record<string, unknown>;
  // A WRONG GUESS COSTS ONE MORE CALL, NOT A PAYMENT: every problem, then the
  // whole spec (each input with its description and allowed values, the
  // required fields inside a nested object, the example, what comes back), so
  // the next call can be right. Local, with nothing sent to the provider or
  // paid.
  const refuse = async (problem: string): Promise<{ refused: RequestToolResult }> => {
    unpaid('input');
    await footer.done('needs_input');
    const refused = fail('needs_input', `The input does not fit ${spec.provider}: ${problem}.`, {
      nextStep: `Fix the input from the spec above and call request({id: ${JSON.stringify(id)}, input: {...}}) again; nothing was sent or paid.`,
      parameters: sentInput,
    });
    return { refused: { ...refused, summary: `${refused.summary}\n\n${specText(id, spec)}` } };
  };
  const problems = specInputProblems(spec, merged);
  // A SCHEMA THIS BUILD CANNOT COMPILE CHECKS NOTHING, so the call is not
  // paid: an input nobody checked is a paid guess, and no change to it helps.
  if (problems === undefined) {
    unpaid('terms');
    await footer.done('failed');
    return {
      refused: fail(
        'failed',
        `The spec for ${spec.provider} has an input schema this build cannot check, so the call was not sent and nothing was paid.`,
        {
          nextStep: 'Continue with your own tools. Nothing was sent or paid.',
          parameters: sentInput,
        },
      ),
    };
  }
  if (problems.length) return refuse(problems.join('; '));
  const built = buildSpecRequest(spec, merged);
  if ('problem' in built) return refuse(built.problem);
  // The same checks a server-built call meets: GET or POST, only the headers
  // this build sends, and a success rule that compiles before anything is paid.
  const refusal = checkContract({
    request: built,
    ...(spec.resultSchema !== undefined ? { resultSchema: spec.resultSchema } : {}),
  });
  if (refusal !== null) {
    unpaid('terms');
    await footer.done(refusal.status);
    return { refused: fail(refusal.status, refusal.reason, { parameters: sentInput }) };
  }
  return { prepared: { id, spec, merged, sentInput, built } };
}

/** One take of several of the same call (`count`): its number, the claim it
 *  holds, and whether this take reports the offer's outcome itself. */
export interface TakeOf {
  n: number;
  claim: string;
  report: boolean;
}

/**
 * PAY A CLAIMED SPEC'S CALL, settle its claim, and tell the server how it
 * ended. The caller holds the claim; this is where it is kept or dropped. A
 * take of several pays under its own request key and claim, so the same-turn
 * duplicate guard sees N different requests, not one request N times.
 */
export async function paySpec(
  prepared: PreparedSpec,
  admission: Admission,
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: ReportDeps,
  take?: TakeOf,
): Promise<Awaited<ReturnType<typeof payAndDeliver>>> {
  const { id, spec, merged, sentInput, built } = prepared;
  const startedAt = Date.now();
  const suffix = take !== undefined ? `#${take.n}` : '';
  const paid = await payAndDeliver(
    {
      capabilityId: spec.capabilityId,
      provider: spec.provider,
      ...(spec.label !== undefined ? { label: spec.label } : {}),
      media: savesMedia(spec),
      request: built,
      terms: specTerms(spec),
      requestKey: `${spec.capabilityId}:${canonicalHash(merged)}${suffix}`,
      ...(spec.resultSchema !== undefined ? { resultSchema: spec.resultSchema } : {}),
      ...(spec.outputSchema !== undefined
        ? { project: { id: `${id}${suffix}`, schema: spec.outputSchema } }
        : {}),
      parameters: sentInput,
      sent: JSON.stringify(sentInput),
      agentBuilt: true,
      priceVaries: spec.priceVaries,
      ...(spec.job !== undefined
        ? { job: { spec: spec.job, offerId: id, take: take?.n ?? 1, input: merged } }
        : {}),
      ...(spec.timeoutS !== undefined ? { timeoutMs: spec.timeoutS * 1000 } : {}),
      ...(spec.maxBytes !== undefined ? { maxBytes: spec.maxBytes } : {}),
    },
    admission,
    deps,
    footer,
  );
  const { outcome, left } = paid;
  // The claim survives anything that may have signed: only a call that
  // signed nothing frees the id for a fixed input.
  await settleSpecPayment(deps.ctx.dataDir, take?.claim ?? id, left);
  // A refusal before payment (the spend policy, the spec's terms, the
  // provider's own 4xx) arrives as `unpaid` or `needs_approval`, neither of
  // which the server counts as the offer taken; a call that ran, or may have
  // moved money, keeps its own status. Null is a failure this build cannot
  // place, which says nothing rather than guess.
  if (outcome !== null && (take === undefined || take.report)) {
    reportOutcome(reportDeps, id, outcome, startedAt);
  }
  return paid;
}

/** The deal a spec's call is held to: its price ceiling, payee, chain and token. */
export function specTerms(spec: OfferSpec): AdvertisedTerms {
  return {
    source: spec.provider,
    maxAmountAtomic: spec.maxAmountAtomic,
    payTo: spec.payTo,
    network: spec.network,
    asset: spec.asset,
  };
}

/**
 * WHETHER A PAID RESULT'S FILES ARE SAVED: the spec's `output` says (`media`
 * on every Tenjin list and open-Bazaar spec, so their files are saved as
 * before), and a spec without one is media when its id is a `discovered:` one.
 */
function savesMedia(spec: Pick<OfferSpec, 'capabilityId' | 'output'>): boolean {
  return spec.output !== undefined
    ? spec.output === 'media'
    : spec.capabilityId.startsWith('discovered:');
}

/** One provider call to make and pay for, from a decision or a spec. */
export interface ProviderCall {
  capabilityId: string;
  provider: string;
  /** The service's display name, from its decision or spec: what the footer
   *  and the ledger name in place of the URL called. */
  label?: string;
  /** A media service: a paid result's links and inline files are saved
   *  locally ({@link savesMedia}). */
  media: boolean;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    /** A catalog spec's fixed headers ({@link SpecRequest}). */
    specHeaders?: Record<string, string>;
    body?: string;
  };
  terms: AdvertisedTerms;
  requestKey: string;
  resultSchema?: Record<string, unknown>;
  /** What was bound or built, shown on every outcome. */
  parameters?: unknown;
  /** What the ledger records as sent. */
  sent: string;
  note?: string;
  /** The agent built this input itself, from a spec: a provider that refuses
   *  it before payment is said to have, so the agent fixes it. */
  agentBuilt?: boolean;
  /** The spec prices by input, up to `terms.maxAmountAtomic`. */
  priceVaries?: boolean;
  /** The spec's promised fields: the result is cut to them, and the whole
   *  body is saved under the offer's id. */
  project?: { id: string; schema: Record<string, unknown> };
  /** The spec's job: how this call is finished when the seller answers
   *  before its result is ready, and which take of which offer it is. */
  job?: CallJob;
  /** The spec's own deadline and file cap (its `timeoutS` and `maxBytes`),
   *  in place of the CLI's. */
  timeoutMs?: number;
  maxBytes?: number;
}

interface CallJob {
  spec: Job;
  offerId: string;
  take: number;
  /** The merged input, which a poll body's `$input` names. */
  input: Record<string, unknown>;
}

/**
 * WHERE A PAYMENT'S PLACE IN ITS CALL'S PLAN COMES FROM: a slot the plan
 * already admitted (several payments, planned together, or a quote the user
 * approved), or a plan of one admitted at the live price as it is signed,
 * which over the limits is kept as the quote `alone` replays.
 */
export type Admission = { slot: PlanSlot } | { alone: QuotedCall };

/** What a payment's plan of one is stopped with: `runPay` throws it, and the
 *  caller answers with it. */
const PLAN_STOP = 'planStop';

/**
 * A PLAN OF ONE, admitted at the price `runPay` is about to sign, before the
 * wallet is opened: the same planner several payments meet, so one call is
 * one rule. Over the limits, under the allowlist, or past the balance it is
 * stopped, and the stop rides the throw back to {@link payAndDeliver}.
 */
function admitAlone(
  call: ProviderCall,
  quoted: QuotedCall,
  deps: RequestToolDeps,
): (amountAtomic: bigint) => Promise<PlanSlot> {
  return async (amountAtomic) => {
    const settings = await resolveContextSettings(deps.ctx);
    const payments = [{ amountAtomic, creator: new URL(call.request.url).host }];
    const admission = await admitPlan(payments, {
      dataDir: deps.ctx.dataDir,
      policy: settings.policy,
      balance: () => walletBalance(deps, settings.rpcUrl),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    if ('admitted' in admission) return admission.admitted[0]!;
    const stop = await planStop(
      admission,
      { ...oneCall(call.provider, amountAtomic), payments, call: quoted },
      deps,
    );
    throw new CliError(stop.status === 'failed' ? 'REFUSED' : 'POLICY_REFUSED', stop.reason, {
      details: { [PLAN_STOP]: stop },
    });
  };
}

/**
 * PAY THE PROVIDER AND DELIVER WHAT CAME BACK: `runPay` under the caller's
 * terms, the binary or media result saved, the ledger written, and the
 * envelope the host reads, with what was sent on every outcome. `outcome` is
 * the short form the server's report takes, null for a failure
 * {@link failureOutcome} cannot place.
 */
async function payAndDeliver(
  call: ProviderCall,
  admission: Admission,
  deps: RequestToolDeps,
  footer: LookupFooter,
): Promise<{
  result: RequestToolResult;
  outcome: Omit<SpecOutcome, 'id' | 'ms'> | null;
  /** What left this machine for the call, whatever came back. `signed`: a
   *  payment may have been signed, even where the amount is unknown. */
  left: { amountAtomic: bigint; txHash?: string; signed: boolean };
}> {
  const built = call.request;
  const parameters = call.parameters !== undefined ? { parameters: call.parameters } : {};
  const named = call.label !== undefined ? { label: call.label } : {};
  const signing = watchSigning(deps.payDeps?.authorizer ?? deps.authorizer);
  // The answer that delivered, or a paid leg cut off after its headers came,
  // and the payment it carried: what a job is started from.
  let leg: PaidLeg | undefined;
  const submittedAt = (deps.now ?? Date.now)();
  try {
    // WHAT IS ABOUT TO BE CALLED, named while it is being called. This is the
    // executed destination, not the hint's suggestion, which is the whole point
    // of showing it.
    await footer.calling({ provider: built.url, ...named, ...parameters });
    const paid = await runPay(
      {
        url: built.url,
        method: built.method,
        headers: built.headers,
        ...(built.specHeaders !== undefined ? { specHeaders: built.specHeaders } : {}),
        ...(built.body !== undefined ? { rawBody: built.body } : {}),
        terms: call.terms,
        execution: 'router',
        admit:
          'slot' in admission
            ? async () => admission.slot
            : admitAlone(call, admission.alone, deps),
        requestKey: call.requestKey,
        ...(call.resultSchema !== undefined ? { resultSchema: call.resultSchema } : {}),
        ...(call.timeoutMs !== undefined ? { timeoutMs: call.timeoutMs } : {}),
        ...(call.maxBytes !== undefined ? { maxBytes: call.maxBytes } : {}),
        printBody: true,
        ...(call.job !== undefined
          ? {
              onPaidLeg: (seen: PaidLeg) => {
                leg = seen;
              },
            }
          : {}),
      },
      deps.ctx,
      {
        ...(deps.payDeps ?? {}),
        ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
        authorizer: signing.authorizer,
        confirm: async () => false,
      },
    );
    const data = paid.data as {
      /** The provider's HTTP status on the call that delivered. */
      status?: number;
      /** The body, parsed, when it was JSON. */
      body?: unknown;
      bodyText?: string;
      /** A binary body's bytes and type, kept whole by the provider leg. */
      bodyBytes?: Uint8Array;
      contentType?: string;
      /** From the payment-response header, when the seller sent one. */
      settlementTxHash?: string;
      authorization?: SignedAuthorization;
      amountPaid?: { atomic: string };
      /** Set when the body missed its success rule, or the rule never ran. */
      resultUnverified?: boolean;
      resultCaveat?: string;
    };
    const providerAtomic = BigInt(data.amountPaid?.atomic ?? '0');
    const tx = data.settlementTxHash !== undefined ? { txHash: data.settlementTxHash } : {};
    const left = () => ({ amountAtomic: providerAtomic, ...tx, signed: signing.mayHaveSigned() });
    // A 2xx THAT IS NOT THE RESULT YET: the job's own rules say so, or the
    // seller never answers inline, or it is a 202. A file is a result unless it
    // came with a 202. The submit's success rule is not the result's: a job's
    // first answer is a receipt, and the rule runs on what the last poll says.
    if (call.job !== undefined) {
      const state =
        data.bodyBytes !== undefined && data.status !== 202
          ? 'done'
          : answerState(call.job.spec, data.status ?? 200, data.body, { submit: true });
      if (state !== 'done') {
        const job = await startJob(call, call.job, deps, footer, {
          state,
          submittedAt,
          status: data.status,
          json: data.body,
          text: data.bodyText ?? '',
          ...(leg?.header !== undefined ? { header: leg.header } : {}),
          providerAtomic,
          ...tx,
          ...(data.authorization !== undefined ? { authorization: data.authorization } : {}),
        });
        return { ...job, left: left() };
      }
    }
    const delivered = await deliverResult(
      call,
      deps,
      footer,
      {
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.bodyText !== undefined ? { bodyText: data.bodyText } : {}),
        ...(data.bodyBytes !== undefined ? { bodyBytes: data.bodyBytes } : {}),
        ...(data.contentType !== undefined ? { contentType: data.contentType } : {}),
        ...(data.resultUnverified === true ? { resultUnverified: true } : {}),
        ...(data.resultCaveat !== undefined ? { resultCaveat: data.resultCaveat } : {}),
      },
      {
        providerAtomic,
        ...tx,
        ...(data.authorization !== undefined ? { authorization: data.authorization } : {}),
        ledger: 'append',
      },
    );
    return { result: delivered.result, outcome: delivered.outcome, left: left() };
  } catch (err) {
    const cli = err instanceof CliError ? err : undefined;
    // THE PLAN WAS STOPPED before anything was signed: over the limits, its
    // quote and the approve call; otherwise why, with nothing paid.
    const stop = (cli?.details as Record<string, unknown> | undefined)?.[PLAN_STOP] as
      PlanStop | undefined;
    if (stop !== undefined) {
      await footer.done(stop.status, { provider: built.url, ...named, ...parameters });
      return {
        left: { amountAtomic: 0n, signed: signing.mayHaveSigned() },
        outcome: stop.outcome,
        result: fail(stop.status, stop.reason, {
          ...stop.extras,
          request: { method: built.method, url: built.url },
          ...(call.parameters !== undefined ? { parameters: call.parameters } : {}),
        }),
      };
    }
    const status = cli?.code === 'POLICY_REFUSED' ? 'needs_approval' : 'failed';
    // A provider failure AFTER transmission carries the amount at risk on its
    // details. Reporting zero there told the model the call was free when the
    // ledger had already counted it.
    const detail = (cli?.details ?? {}) as {
      amountAtomic?: string;
      settlement?: string;
      diagnosis?: Record<string, unknown>;
      status?: number;
      providerError?: string;
      /** The seller's reason for not settling, from its payment-response header. */
      settlementError?: string;
      /** Where a long job's result will be, named by the seller before the paid
       *  leg timed out. */
      statusUrl?: string;
      authorization?: SignedAuthorization;
      /** The live 402's terms, on a REGISTRY_MISMATCH. */
      live?: { amount?: string };
    };
    // A SPEND-POLICY REFUSAL SIGNED NOTHING. Its details carry the price it
    // refused, not an amount that left, so it is neither a cost nor a ledger
    // row: the PDL refusal sat in the ledger as $0.28 paid.
    const leftAtomic = status === 'needs_approval' ? 0n : BigInt(detail.amountAtomic ?? '0');
    // THE PAID LEG CUT OFF WHILE THE SELLER WORKS, from a service whose spec
    // says how its job is polled, with the status URL in the headers that did
    // come: that job, still running, not a failure. With no usable status URL
    // it stays the timeout it was.
    const cutJob = call.job;
    const cutHeader = leg?.header;
    if (
      cutJob !== undefined &&
      cutHeader !== undefined &&
      cli?.code === 'NETWORK_ERROR' &&
      leftAtomic > 0n &&
      !(
        'problem' in
        pollTarget(
          cutJob.spec,
          { url: built.url, json: undefined, header: cutHeader },
          cutJob.input,
        )
      )
    ) {
      const job = await startJob(call, cutJob, deps, footer, {
        state: 'running',
        submittedAt,
        json: undefined,
        text: '',
        header: cutHeader,
        providerAtomic: leftAtomic,
        ...(detail.authorization !== undefined ? { authorization: detail.authorization } : {}),
      });
      return { ...job, left: { amountAtomic: leftAtomic, signed: true } };
    }
    // AN INPUT THE AGENT BUILT, REFUSED BEFORE ANY PAYMENT: said as that, so
    // the next step is fixing the input, not checking the URL.
    const rejectedInput =
      call.agentBuilt === true &&
      leftAtomic === 0n &&
      (detail.status === 400 || detail.status === 422);
    // A PRICE THAT VARIES WITH THE INPUT, quoted over the spec's ceiling for
    // this one: a smaller input is the fix, and a fresh decision would only
    // hand back the same spec.
    const live = detail.live?.amount;
    const ceiling = call.terms.maxAmountAtomic;
    const overCeiling =
      call.priceVaries === true &&
      cli?.code === 'REGISTRY_MISMATCH' &&
      live !== undefined &&
      ceiling !== undefined &&
      /^\d+$/.test(live) &&
      BigInt(live) > BigInt(ceiling);
    const reason = overCeiling
      ? `${call.provider} prices this input at $${toMoney(live).usd}, over this spec's $${toMoney(ceiling).usd} ceiling, so nothing was signed. Change the input (a smaller size, a shorter clip, fewer items) and call again with the same id.`
      : rejectedInput
        ? `${call.provider} rejected this input before any payment (HTTP ${String(detail.status)}): see providerError. Fix the input and call again with the same id.`
        : cli !== undefined
          ? `${cli.message} ${agentFixOf(cli)}`.trim()
          : String(err);
    await footer.done(status, {
      provider: built.url,
      ...named,
      ...parameters,
      price: `$${toMoney(leftAtomic.toString()).usd}`,
    });
    // An authorization that left is a paid call whatever came back: recorded
    // with its settlement unknown, for `tenjin payments reconcile` to resolve.
    if (leftAtomic > 0n) {
      await appendPaidRecord(
        deps.ctx.dataDir,
        paidRecord(call, built.url, call.sent, leftAtomic, {
          ...(detail.authorization !== undefined ? { authorization: detail.authorization } : {}),
          savedFiles: [],
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        }),
      );
    }
    const signed = signing.mayHaveSigned();
    const outcome = failureOutcome(err, { mayHaveMoved: leftAtomic > 0n || signed, rejectedInput });
    return {
      left: { amountAtomic: leftAtomic, signed },
      outcome:
        outcome === null
          ? null
          : {
              ...outcome,
              ...(typeof detail.status === 'number' ? { httpStatus: detail.status } : {}),
            },
      result: fail(status, reason, {
        providerAtomic: leftAtomic,
        ...(detail.settlement !== undefined ? { settlement: detail.settlement } : {}),
        ...(detail.diagnosis !== undefined ? { diagnosis: detail.diagnosis } : {}),
        // WHY THE PROVIDER SAID NO: its HTTP status and a bounded, redacted
        // snippet of its body, which `runPay` cut. Without them a 403 read the
        // same as a timeout to the agent and to the logs.
        ...(typeof detail.status === 'number' ? { providerStatus: detail.status } : {}),
        ...(typeof detail.providerError === 'string'
          ? { providerError: detail.providerError }
          : {}),
        // THE SELLER SAID IT DID NOT SETTLE, and why: what an empty `{}` body
        // beside a rejected payment leaves out.
        ...(typeof detail.settlementError === 'string'
          ? { settlementError: detail.settlementError }
          : {}),
        // WHAT WAS SENT, on a failure too: the agent cannot match a 400 to a
        // field it cannot see.
        request: { method: built.method, url: built.url },
        ...(call.parameters !== undefined ? { parameters: call.parameters } : {}),
        // A LONG JOB STILL RUNNING: where its result will be, and that this
        // call was paid, so a second one would pay again.
        ...(typeof detail.statusUrl === 'string' ? { statusUrl: detail.statusUrl } : {}),
        ...(overCeiling
          ? { nextStep: 'Change the input and call again with the same id.' }
          : rejectedInput
            ? { nextStep: 'Fix the input and call again with the same id.' }
            : typeof detail.statusUrl === 'string'
              ? {
                  nextStep:
                    'Check statusUrl for the result. Do not call request again for this: it would pay again.',
                }
              : {}),
      }),
    };
  }
}

/** What came back on the answer that delivered a result. */
interface Delivered {
  status?: number;
  bodyText?: string;
  bodyBytes?: Uint8Array;
  contentType?: string;
  /** The body missed its success rule, or the rule never ran. */
  resultUnverified?: boolean;
  resultCaveat?: string;
}

/** The money behind a delivered result, and where its ledger row goes. */
interface DeliveredMoney {
  providerAtomic: bigint;
  txHash?: string;
  authorization?: SignedAuthorization;
  /** Append the call's row; finish the row a job wrote when it was paid,
   *  found by its nonce; or leave the ledger alone. */
  ledger: 'append' | { update: string } | 'none';
}

/** What delivering needs of a call: a provider call, or a job's record of one. */
type DeliverCall = Pick<
  ProviderCall,
  | 'capabilityId'
  | 'provider'
  | 'label'
  | 'media'
  | 'parameters'
  | 'sent'
  | 'note'
  | 'project'
  | 'maxBytes'
> & { request: { url: string } };

/**
 * DELIVER A PAID OR FREE RESULT: the binary or media saved, the ledger
 * written, and the envelope the host reads. The same for a call that answered
 * inline and a job's last poll.
 */
async function deliverResult(
  call: DeliverCall,
  deps: RequestToolDeps,
  footer: LookupFooter,
  got: Delivered,
  money: DeliveredMoney,
): Promise<{
  result: RequestToolResult;
  outcome: Omit<SpecOutcome, 'id' | 'ms'>;
  savedFiles: string[];
  /** Why a file the result carries was not saved: a job's take stays
   *  resumable over it, since the seller still holds the result. */
  unsaved?: string;
}> {
  const built = call.request;
  const parameters = call.parameters !== undefined ? { parameters: call.parameters } : {};
  const { providerAtomic } = money;
  const httpStatus = typeof got.status === 'number' ? { httpStatus: got.status } : {};
  const budget = deps.downloads;
  const now = deps.now !== undefined ? { now: deps.now } : {};
  // A FILE IS SAVED, NOT INLINED: its bytes are no use as text in a tool
  // result, so the result names where they are.
  const binary =
    got.bodyBytes !== undefined
      ? await saveBinary(deps.ctx.dataDir, call.capabilityId, got.bodyBytes, {
          contentType: got.contentType ?? '',
          ...now,
          ...(budget !== undefined ? { budget } : {}),
        })
      : null;
  let unsaved = binary?.saveError;
  // AND A PAID MEDIA RESULT THAT LINKS TO ITS FILES brings them home: the
  // links can expire, and the user paid for what is behind them. Only a
  // media service (every discovered one, where generated images, audio and
  // video come from) does this: a curated page read or search links whatever
  // the page links, on hosts the page picked. Best effort only.
  const media = providerAtomic > 0n && binary === null && call.media;
  // ONE CARRYING ITS FILES INLINE, as base64 in its JSON, has them saved
  // the same way, each replaced by a note naming its file: megabytes of
  // base64 are no use to the agent as text. The rewritten body is the one
  // cut, saved and handed back below; on any failure it is the body as it
  // came.
  const inline =
    media && got.bodyText !== undefined
      ? await saveInlineMedia(got.bodyText, async (bytes, contentType) => {
          const saved = await saveBinary(deps.ctx.dataDir, call.capabilityId, bytes, {
            contentType,
            ...now,
            ...(budget !== undefined ? { budget } : {}),
          });
          unsaved ??= saved.saveError;
          return saved.savedTo ?? null;
        })
      : null;
  const bodyText = inline?.bodyText ?? got.bodyText;
  const linked = media
    ? await saveLinked(
        deps,
        call.capabilityId,
        mediaUrlsIn(bodyText ?? '', MAX_MEDIA_FILES - (inline?.savedFiles.length ?? 0)),
        call.maxBytes,
      )
    : { saved: [], capped: false, failed: false };
  if (linked.capped) unsaved ??= CAP_REACHED;
  if (linked.failed) unsaved ??= DOWNLOAD_FAILED;
  const savedFiles = [
    ...(binary?.savedTo !== undefined ? [binary.savedTo] : []),
    ...(inline?.savedFiles ?? []),
    ...linked.saved,
  ];
  const cut =
    binary === null && call.project !== undefined && bodyText !== undefined
      ? await projected(deps.ctx.dataDir, call.project, bodyText)
      : null;
  if (providerAtomic > 0n && money.ledger === 'append') {
    await appendPaidRecord(
      deps.ctx.dataDir,
      paidRecord(call, built.url, call.sent, providerAtomic, {
        ...(money.txHash !== undefined ? { txHash: money.txHash } : {}),
        ...(money.authorization !== undefined ? { authorization: money.authorization } : {}),
        savedFiles,
        ...now,
      }),
    );
  } else if (typeof money.ledger === 'object') {
    await updatePaidRecord(deps.ctx.dataDir, money.ledger.update, {
      savedFiles,
      ...(money.txHash !== undefined ? { txHash: money.txHash } : {}),
    });
  }
  const base = {
    supplier: supplierOf(built.url),
    // The service's display name, which the plugin's mod draws its row from.
    ...(call.label !== undefined ? { label: call.label } : {}),
    ...parameters,
    cost: costLines(providerAtomic),
    ...(money.txHash !== undefined ? { settlementTxHash: money.txHash } : {}),
    ...(call.note !== undefined ? { note: call.note } : {}),
    result: binary ?? cut?.result ?? bodyText ?? '',
    ...(cut !== null ? { fullResultPath: cut.fullResultPath } : {}),
    ...(savedFiles.length > 0 ? { savedFiles } : {}),
    providerContentUntrusted: true,
  };
  // UNVERIFIED IS NOT FULFILLED. A body that missed its success rule, or
  // that the rule could not be run against, may be exactly the contract
  // failure the rule exists to catch, and a caveat inside a `fulfilled`
  // envelope does not reach code that branches on the status: a provider
  // could pad a broken answer past the validation limit and have it read as
  // a checked, paid result. The body still rides along (whole, or cut to
  // the spec's fields with the whole saved), because the money moved and
  // withholding the product would be a second loss on top of the first.
  const shown = {
    provider: built.url,
    ...(call.label !== undefined ? { label: call.label } : {}),
    ...parameters,
    price: `$${toMoney(providerAtomic.toString()).usd}`,
  };
  if (got.resultUnverified === true) {
    await footer.done('unverified', shown);
    return {
      outcome: { status: 'unverified', ...httpStatus },
      savedFiles,
      ...(unsaved !== undefined ? { unsaved } : {}),
      result: {
        isError: true,
        summary: `Unverified result from ${base.supplier} · ${base.cost.join(' · ')}`,
        envelope: {
          status: 'unverified',
          ...base,
          ...(got.resultCaveat !== undefined ? { resultCaveat: got.resultCaveat } : {}),
        },
      },
    };
  }
  await footer.done('fulfilled', shown);
  return {
    outcome: { status: 'fulfilled', ...httpStatus },
    savedFiles,
    ...(unsaved !== undefined ? { unsaved } : {}),
    result: {
      isError: false,
      summary: `Fulfilled by ${base.supplier} · ${base.cost.join(' · ')}`,
      envelope: { status: 'fulfilled', ...base },
    },
  };
}

/** The files a paid result links to, saved within what this call may still
 *  write, each under the spec's file cap when it names one. Best effort, like
 *  every save after the money moved. */
async function saveLinked(
  deps: RequestToolDeps,
  stem: string,
  urls: string[],
  maxBytes: number | undefined,
): Promise<{ saved: string[]; capped: boolean; failed: boolean }> {
  return saveMedia(deps.ctx.dataDir, stem, urls, {
    ...(maxBytes !== undefined ? { maxBytes } : {}),
    ...(deps.mediaTransport !== undefined ? { transport: deps.mediaTransport } : {}),
    ...(deps.payDeps?.destination !== undefined ? { destination: deps.payDeps.destination } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.downloads !== undefined ? { budget: deps.downloads } : {}),
  });
}

/** What starting a job is handed: the submit's answer and its payment. */
interface SubmitSeen {
  state: 'running' | 'failed';
  submittedAt: number;
  status?: number;
  json: unknown;
  text: string;
  header?: (name: string) => string | undefined;
  providerAtomic: bigint;
  /** The submit's settlement, when its payment-response header named it. */
  txHash?: string;
  authorization?: SignedAuthorization;
}

/** What a job's take answers, for the caller to hand back and report. */
interface TakeEnding {
  result: RequestToolResult;
  outcome: Omit<SpecOutcome, 'id' | 'ms'>;
}

/**
 * A PAID CALL THE SELLER ANSWERED BEFORE ITS RESULT WAS READY. The submit is
 * on the ledger first, so a crash mid-poll loses no row. A seller that says
 * the job failed is that failure. A status URL that is not the submit's host
 * is never fetched: the money moved, so the call fails naming the URL as
 * untrusted. Otherwise the take is recorded,
 * 0600, before its first poll, and polled until it ends or this call's wait
 * runs out, when it answers `running` with the id that resumes it.
 */
async function startJob(
  call: ProviderCall,
  job: CallJob,
  deps: RequestToolDeps,
  footer: LookupFooter,
  submit: SubmitSeen,
): Promise<TakeEnding> {
  const now = deps.now ?? Date.now;
  const built = call.request;
  const parameters = call.parameters !== undefined ? { parameters: call.parameters } : {};
  const httpStatus = submit.status !== undefined ? { httpStatus: submit.status } : {};
  const { providerAtomic } = submit;
  if (providerAtomic > 0n) {
    await appendPaidRecord(
      deps.ctx.dataDir,
      paidRecord(call, built.url, call.sent, providerAtomic, {
        ...(submit.txHash !== undefined ? { txHash: submit.txHash } : {}),
        ...(submit.authorization !== undefined ? { authorization: submit.authorization } : {}),
        savedFiles: [],
        now,
      }),
    );
  }
  const shown = {
    provider: built.url,
    ...parameters,
    price: `$${toMoney(providerAtomic.toString()).usd}`,
  };
  const paidFailure = async (reason: string, extras: FailExtras = {}): Promise<TakeEnding> => {
    await footer.done('failed', shown);
    return {
      outcome: { status: 'failed', ...httpStatus },
      result: fail('failed', `${reason} ${paidNothing(providerAtomic, submit.txHash)}`, {
        providerAtomic,
        settlement: submit.txHash !== undefined ? 'settled' : 'unknown',
        ...(submit.status !== undefined ? { providerStatus: submit.status } : {}),
        request: { method: built.method, url: built.url },
        ...parameters,
        nextStep: failedNextStep(submit.txHash),
        ...extras,
      }),
    };
  };
  if (submit.state === 'failed') {
    const said = sellerSaid(submit.json, submit.text);
    return paidFailure(
      `${call.provider}: the seller says the job failed.`,
      said.length > 0 ? { providerError: said } : {},
    );
  }
  const target = pollTarget(
    job.spec,
    {
      url: built.url,
      json: submit.json,
      ...(submit.header !== undefined ? { header: submit.header } : {}),
    },
    job.input,
  );
  if ('problem' in target) {
    return paidFailure(
      `${call.provider} took the payment and is still working, but ${target.problem}, so it was not polled.`,
      target.named !== undefined ? { statusUrl: target.named } : {},
    );
  }
  const take: JobTake = {
    version: 1,
    offerId: job.offerId,
    take: job.take,
    poll: target,
    job: job.spec,
    call: {
      capabilityId: call.capabilityId,
      provider: call.provider,
      url: built.url,
      media: call.media,
      sent: recordedSent(call.sent),
      terms: {
        ...(call.terms.source !== undefined ? { source: call.terms.source } : {}),
        maxAmountAtomic: call.terms.maxAmountAtomic ?? '0',
        ...(call.terms.payTo !== undefined ? { payTo: call.terms.payTo } : {}),
        ...(call.terms.network !== undefined ? { network: call.terms.network } : {}),
        ...(call.terms.asset !== undefined ? { asset: call.terms.asset } : {}),
      },
      ...(call.resultSchema !== undefined ? { resultSchema: call.resultSchema } : {}),
      ...(call.project !== undefined ? { outputSchema: call.project.schema } : {}),
    },
    submittedAt: new Date(submit.submittedAt).toISOString(),
    expiresAt: new Date(submit.submittedAt + job.spec.keepH * 3_600_000).toISOString(),
    amountAtomic: providerAtomic.toString(),
    ...(submit.authorization !== undefined ? { authorization: submit.authorization } : {}),
    ...(submit.txHash !== undefined ? { txHash: submit.txHash } : {}),
    ...httpStatus,
    state: 'running',
    savedFiles: [],
    // A status URL the agent may open itself: a plain GET.
    ...(target.method === 'GET' ? { statusUrl: target.url } : {}),
  };
  const kept = await writeTake(deps.ctx.dataDir, take).then(
    () => true,
    () => false,
  );
  const deadline = Math.min(
    deps.waitsForJobs === true
      ? Number.POSITIVE_INFINITY
      : (deps.startedAt ?? submit.submittedAt) + MAX_CALL_WAIT_MS,
    submit.submittedAt + job.spec.maxWaitS * 1000,
  );
  const answer = await pollUntil(
    take,
    { deadline, firstWaitMs: job.spec.everyS * 1000 },
    pollDeps(deps),
  );
  return finishTake(take, answer, deps, footer, { kept, parameters: call.parameters });
}

/**
 * THAT A FAILED JOB WAS PAID AND BROUGHT NOTHING BACK, and what is known of
 * the money: settled when the submit's payment-response named the
 * transaction (AiSpace settles at submit, so a refused prompt is still a paid
 * one), else unknown until the authorization expires.
 */
function paidNothing(amountAtomic: bigint, txHash: string | undefined): string {
  const usd = `$${toMoney(amountAtomic.toString()).usd}`;
  return txHash !== undefined
    ? `It was paid (${usd}, settled in tx ${txHash}) and nothing came back.`
    : `It was paid (${usd}) and nothing came back; whether that payment settles is unknown until its authorization expires.`;
}

/** What the agent does after a job failed: the money is already accounted. */
function failedNextStep(txHash: string | undefined): string {
  return txHash !== undefined
    ? 'Tell the user it was paid and nothing came back; the payment is in `tenjin payments`. A new call pays again.'
    : 'Tell the user. The payment is in `tenjin payments`; one the seller never settles is given back to the daily budget once its authorization expires. A new call pays again.';
}

/** The poll's seams, and who is told of each poll. */
function pollDeps(deps: RequestToolDeps): PollDeps {
  return {
    ...(deps.pollTransport !== undefined ? { transport: deps.pollTransport } : {}),
    ...(deps.payDeps?.destination !== undefined ? { destination: deps.payDeps.destination } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
    ...(deps.onPoll !== undefined ? { onPoll: deps.onPoll } : {}),
  };
}

/** A take's call, rebuilt from its record for the delivery step. */
function callOf(take: JobTake, parameters?: unknown): DeliverCall {
  return {
    capabilityId: take.call.capabilityId,
    provider: take.call.provider,
    media: take.call.media,
    sent: take.call.sent,
    request: { url: take.call.url },
    ...(parameters !== undefined ? { parameters } : {}),
    ...(take.call.outputSchema !== undefined
      ? {
          project: {
            id: take.take > 1 ? `${take.offerId}#${take.take}` : take.offerId,
            schema: take.call.outputSchema,
          },
        }
      : {}),
  };
}

/**
 * HOW A TAKE ENDED THIS CALL, recorded and said. Done: the last answer is the
 * result, checked against the success rule and saved like any paid result,
 * its files written onto the payment's ledger row. Running: the id that
 * resumes it. Failed or gone: the seller's reason, the money already counted.
 * The record keeps every ending until it expires. The first ending recorded
 * stands: a call whose take another call ended first answers with that ending.
 */
async function finishTake(
  take: JobTake,
  answer: PollAnswer,
  deps: RequestToolDeps,
  footer: LookupFooter,
  opts: { kept: boolean; parameters?: unknown },
): Promise<TakeEnding> {
  const { dataDir } = deps.ctx;
  const providerAtomic = BigInt(take.amountAtomic);
  const call = callOf(take, opts.parameters);
  const shown = {
    provider: take.call.url,
    price: `$${toMoney(providerAtomic.toString()).usd}`,
  };
  // Undefined when the ending could not be written: the take stays running.
  const end = (ending: Partial<JobTake>) =>
    endTake(dataDir, take.offerId, take.take, ending).catch(() => undefined);
  // AN ENDING ANOTHER CALL RECORDED FIRST stands, and is this call's answer.
  const lostTo = async (ended: JobTake): Promise<TakeEnding> => {
    const result = endedResult(ended, { raced: true });
    const status = result.envelope.status as 'fulfilled' | 'unverified' | 'failed';
    await footer.done(status, shown);
    return { result, outcome: { status } };
  };
  if (answer.state === 'done') {
    const current = (await readTake(dataDir, take.offerId, take.take)) ?? take;
    if (current.state !== 'running') return lostTo(current);
    // The row the submit's payment is on.
    const nonce = current.authorization?.nonce;
    let caveat: string | undefined;
    let unverified = false;
    if (take.call.resultSchema !== undefined && answer.bytes === undefined) {
      const check = validateResultBody(take.call.resultSchema, answer.text);
      if (!check.valid || check.unvalidated === true) {
        unverified = true;
        caveat = check.reason ?? 'The result does not satisfy its success schema.';
      }
    }
    const tx = settlementTx({ header: answer.header });
    const delivered = await deliverResult(
      call,
      deps,
      footer,
      {
        status: answer.status,
        ...(answer.bytes !== undefined
          ? { bodyBytes: answer.bytes, contentType: answer.contentType }
          : { bodyText: answer.text }),
        ...(unverified ? { resultUnverified: true } : {}),
        ...(caveat !== undefined ? { resultCaveat: caveat } : {}),
      },
      {
        providerAtomic,
        ...(tx !== undefined ? { txHash: tx } : {}),
        ledger: nonce !== undefined ? { update: nonce } : 'none',
      },
    );
    // A RESULT NOT SAVED HERE IS NOT AN ENDING: the seller still holds it, so
    // the take stays running, its copy is never freed, and a resume fetches
    // it again with nothing more paid.
    if (delivered.unsaved !== undefined) {
      await footer.done('running', shown);
      return {
        outcome: { status: 'running', httpStatus: answer.status },
        result: unsavedResult(take, call, opts.kept, delivered.unsaved),
      };
    }
    const ended = await end({
      state: 'done',
      savedFiles: delivered.savedFiles.slice(0, 16),
      result: keptResult(delivered.result.envelope.result),
      ...(unverified ? { resultUnverified: true } : {}),
      ...(caveat !== undefined ? { resultCaveat: caveat.slice(0, 1_000) } : {}),
    });
    if (ended?.won === false) return lostTo(ended.take);
    // THE SELLER'S COPY IS FREED once ours is on disk, by the call that ended
    // the take: never while the record still says running.
    if (delivered.savedFiles.length > 0 && ended !== undefined) {
      await completeJob({ ...current, submitUrl: take.call.url }, pollDeps(deps));
    }
    return {
      result: withJob(delivered.result, take.offerId),
      outcome: delivered.outcome,
    };
  }
  if (answer.state === 'running') {
    await footer.done('running', shown);
    return {
      outcome: {
        status: 'running',
        ...(take.httpStatus !== undefined ? { httpStatus: take.httpStatus } : {}),
      },
      result: runningResult(take, call, opts.kept, answer.reason),
    };
  }
  const reason = `${
    answer.state === 'expired'
      ? `${take.call.provider} no longer has this job (HTTP ${answer.status}).`
      : `${take.call.provider}: ${answer.reason}.`
  } ${paidNothing(providerAtomic, take.txHash)}`;
  const said = answer.state === 'failed' ? answer.said : undefined;
  const ended = await end({
    state: answer.state,
    reason: reason.slice(0, 1_000),
    ...(said !== undefined ? { said } : {}),
  });
  if (ended?.won === false) return lostTo(ended.take);
  await footer.done('failed', shown);
  return {
    outcome: {
      status: 'failed',
      ...(answer.status !== undefined ? { httpStatus: answer.status } : {}),
    },
    result: withJob(failedResult(take, reason, answer.status, said, opts.parameters), take.offerId),
  };
}

/** A take that failed, paid: the reason, the seller's own words beside it as
 *  untrusted text, and what is known of the money. */
function failedResult(
  take: JobTake,
  reason: string,
  status: number | undefined,
  said: string | undefined,
  parameters?: unknown,
): RequestToolResult {
  return fail('failed', reason, {
    providerAtomic: BigInt(take.amountAtomic),
    settlement: take.txHash !== undefined ? 'settled' : 'unknown',
    ...(status !== undefined ? { providerStatus: status } : {}),
    ...(said !== undefined ? { providerError: said } : {}),
    request: { method: take.poll.method, url: take.poll.url },
    ...(parameters !== undefined ? { parameters } : {}),
    nextStep: failedNextStep(take.txHash),
  });
}

/** A take's result names its job, so a set's entries can be told apart. */
function withJob(result: RequestToolResult, offerId: string): RequestToolResult {
  return { ...result, envelope: { ...result.envelope, job: offerId } };
}

/** What a finished take keeps of the result it handed the agent. */
function keptResult(result: unknown): string {
  const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
  return text.length <= KEPT_RESULT_CHARS ? text : `${text.slice(0, KEPT_RESULT_CHARS)}…`;
}

/** The answer for a take still running when this call's wait ran out. */
function runningResult(
  take: JobTake,
  call: DeliverCall,
  kept: boolean,
  note?: string,
): RequestToolResult {
  const cost = costLines(BigInt(take.amountAtomic));
  const supplier = supplierOf(take.call.url);
  const nextStep = kept
    ? `Call request({job: ${JSON.stringify(take.offerId)}}) in a minute or two; nothing more is paid.`
    : `This machine could not keep the job, so it cannot be resumed here${take.statusUrl !== undefined ? '; check statusUrl for the result' : ''}. Do not call again for this: it would pay again.`;
  return {
    isError: false,
    summary: `Still running at ${supplier} · ${cost.join(' · ')}. ${nextStep}`,
    envelope: {
      status: 'running',
      job: take.offerId,
      ...(take.statusUrl !== undefined ? { statusUrl: take.statusUrl } : {}),
      supplier,
      ...(call.parameters !== undefined ? { parameters: call.parameters } : {}),
      cost,
      ...(note !== undefined ? { note } : {}),
      nextStep,
      providerContentUntrusted: true,
    },
  };
}

/** A take the seller finished whose result this machine could not save: still
 *  running, so a resume fetches it again, with nothing more paid. */
function unsavedResult(
  take: JobTake,
  call: DeliverCall,
  kept: boolean,
  why: string,
): RequestToolResult {
  const running = runningResult(
    take,
    call,
    kept,
    `The seller finished it and the payment went through, but it could not be saved here (${why}).`,
  );
  const nextStep = kept
    ? `Tell the user why it was not saved, then call request({job: ${JSON.stringify(take.offerId)}}) to fetch it again; nothing more is paid.`
    : String(running.envelope.nextStep);
  return {
    ...running,
    summary: `Paid; ${supplierOf(take.call.url)} finished it, but it could not be saved here (${why}). ${nextStep}`,
    envelope: { ...running.envelope, nextStep },
  };
}

/** A take that had already ended when its job was resumed, from its record;
 *  `raced`, one another call ended while this one was polling it. */
function endedResult(take: JobTake, opts: { raced?: boolean } = {}): RequestToolResult {
  const cost = costLines(BigInt(take.amountAtomic));
  const supplier = supplierOf(take.call.url);
  const how =
    opts.raced === true
      ? 'another call finished this job first; nothing more was paid'
      : 'already finished; nothing was polled or paid';
  if (take.state === 'done') {
    // Unverified as it was delivered: see `deliverResult`.
    const unverified = take.resultUnverified === true;
    return {
      isError: unverified,
      summary: `${unverified ? 'Unverified result from' : 'Fulfilled by'} ${supplier} · ${cost.join(' · ')} (${how})`,
      envelope: {
        status: unverified ? 'unverified' : 'fulfilled',
        job: take.offerId,
        supplier,
        cost,
        result: take.result ?? '',
        ...(take.savedFiles.length > 0 ? { savedFiles: take.savedFiles } : {}),
        note:
          opts.raced === true
            ? 'Another call finished this job first; this is its result, and nothing more was paid.'
            : 'This job had already finished; nothing was polled or paid.',
        providerContentUntrusted: true,
        ...(unverified && take.resultCaveat !== undefined
          ? { resultCaveat: take.resultCaveat }
          : {}),
      },
    };
  }
  return withJob(
    failedResult(
      take,
      take.reason ??
        `${take.call.provider}: the job ended without a result. ${paidNothing(BigInt(take.amountAtomic), take.txHash)}`,
      undefined,
      take.said,
    ),
    take.offerId,
  );
}

/**
 * `request({job})`: EVERY UNFINISHED TAKE OF A JOB, polled again from its
 * record, side by side, for up to {@link MAX_CALL_WAIT_MS} (or, where the host
 * waits for jobs, until the job's own `maxWaitS` from its submit, if that is
 * later) and never past the take's own keep time. Nothing is built and
 * nothing is paid. A take that already ended answers from its record. One
 * take answers as itself; several as a set.
 */
async function resumeJob(offerId: string, deps: RequestToolDeps): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const takes = await readTakes(dataDir, offerId);
  if (takes.length === 0) {
    return fail(
      'needs_input',
      'No job is kept on this machine under that id (it never started here, or it ended and its keep time passed), so nothing was polled or paid.',
      {
        nextStep:
          'Check `tenjin payments` for what was paid. For a new result, call request({query}); that pays again.',
      },
    );
  }
  const footer = await openLookupFooter(dataDir, { id: offerId });
  await footer.routing();
  const settings = await resolveContextSettings(deps.ctx);
  const startedAt = deps.startedAt ?? (deps.now ?? Date.now)();
  const started = Date.now();
  const ended = await Promise.all(
    takes.map(async (take) => {
      if (take.state !== 'running') {
        return { take, result: endedResult(take), outcome: null };
      }
      const waited = startedAt + MAX_CALL_WAIT_MS;
      const deadline = Math.min(
        deps.waitsForJobs === true
          ? Math.max(waited, Date.parse(take.submittedAt) + take.job.maxWaitS * 1000)
          : waited,
        Date.parse(take.expiresAt),
      );
      const answer = await pollUntil(take, { deadline, firstWaitMs: 0 }, pollDeps(deps));
      const done = await finishTake(take, answer, deps, SILENT_FOOTER, { kept: true });
      return { take, result: done.result, outcome: done.outcome };
    }),
  );
  // The offer's own report, once, for a take that ended in this call: the
  // server keeps the first report it got, and logs this one.
  const changed = ended.find(({ outcome }) => outcome !== null && outcome.status !== 'running');
  if (changed?.outcome) {
    reportOutcome(
      {
        ctx: deps.ctx,
        baseUrl: settings.baseUrl,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      },
      offerId,
      changed.outcome,
      started,
    );
  }
  if (ended.length === 1) {
    const only = ended[0]!.result;
    await footer.done(String(only.envelope.status));
    return only;
  }
  const set = takesResult(
    ended.map(({ take, result }) => ({
      named: { take: take.take },
      result,
      // Paid when the job started: a resume pays nothing more of its own.
      amountAtomic: BigInt(take.amountAtomic),
    })),
    {
      head: `${ended.length} takes of ${takes[0]!.call.provider}`,
      nextStep:
        'Open each saved file, say which take fits the request best and why, and let the user pick.',
    },
  );
  await footer.done(String(set.envelope.status));
  return set;
}

/**
 * THE FIELDS THE SPEC PROMISES, AND THE WHOLE BODY ON DISK. A provider body
 * can be far larger than the answer (an Apollo person hit carries the
 * employer's whole organization record), so the model is handed the
 * projection and the path of the full body. The success rule has already run
 * on the full body. Null when the body cannot be cut or the file cannot be
 * written: the whole body is then handed back as before, and the call never
 * fails over it.
 */
async function projected(
  dataDir: string,
  project: { id: string; schema: Record<string, unknown> },
  body: string,
): Promise<{ result: string; fullResultPath: string } | null> {
  const cut = projectBody(project.schema, body);
  if (cut === undefined) return null;
  const fullResultPath = await storeFullResult(dataDir, project.id, body);
  if (fullResultPath === null) return null;
  return { result: JSON.stringify(cut.value), fullResultPath };
}

/**
 * WHETHER A PAYMENT MAY HAVE BEEN SIGNED, read off the spend gate's own calls
 * rather than off an error. `runPay` reserves before it signs, releases only
 * when nothing was signed, and commits once the authorization has left, so a
 * commit, or a reservation never released, is a payment that may have moved.
 * An error's details cannot say that: a commit that fails to write the spend
 * ledger throws with no amount on it, after the money left.
 */
function watchSigning(inner: SpendAuthorizer): {
  authorizer: SpendAuthorizer;
  mayHaveSigned: () => boolean;
} {
  let reserved = false;
  let released = false;
  let committed = false;
  return {
    authorizer: {
      policyEnforcement: inner.policyEnforcement,
      authorize: async (req) => {
        const authorization = await inner.authorize(req);
        if (authorization.decision !== 'deny') reserved = true;
        return authorization;
      },
      commit: async (reservationId, amountAtomic, opts) => {
        committed = true;
        await inner.commit(reservationId, amountAtomic, opts);
      },
      release: async (reservationId) => {
        released = true;
        await inner.release(reservationId);
      },
    },
    mayHaveSigned: () => committed || (reserved && !released),
  };
}

/**
 * WHAT THE SERVER IS TOLD ABOUT A CALL THAT THREW, from the error alone.
 * Money that may have moved is a call that ran, whatever stopped it: `failed`,
 * never `unpaid`. The spend policy keeps its own `needs_approval`. Anything
 * else stopped before a signature, and the reason says which side stopped it:
 * the agent's input, the deal (the live 402 against the spec, or a request
 * this build will not send), the provider's answer, the network, or the
 * wallet. Null for a failure none of those describe, such as a bug here.
 */
export function failureOutcome(
  err: unknown,
  facts: {
    /** An amount left, or the spend gate saw a payment that may have. */
    mayHaveMoved: boolean;
    /** The provider refused an input the agent built, before any payment. */
    rejectedInput: boolean;
  },
): { status: 'failed' | 'needs_approval' } | { status: 'unpaid'; reason: UnpaidReason } | null {
  if (facts.mayHaveMoved) return { status: 'failed' };
  if (!(err instanceof CliError)) return null;
  if (err.code === 'POLICY_REFUSED') return { status: 'needs_approval' };
  const unpaid = (reason: UnpaidReason) => ({ status: 'unpaid' as const, reason });
  if (facts.rejectedInput) return unpaid('input');
  const detail = (err.details ?? {}) as { reason?: unknown; walletUnavailable?: unknown };
  if (
    detail.walletUnavailable === true ||
    detail.reason === 'insufficient_funds' ||
    detail.reason === 'balance_unavailable'
  ) {
    return unpaid('wallet');
  }
  switch (err.code) {
    // REGISTRY_MISMATCH: the live 402 is not the spec's deal, including a
    // varying price over its ceiling. PAYMENT_FAILED before a signature: no
    // entry this wallet can pay, or a price or deal that changed on the
    // re-check. USAGE and REFUSED: a request this build will not send.
    case 'REGISTRY_MISMATCH':
    case 'PAYMENT_FAILED':
    case 'REFUSED':
    case 'USAGE':
      return unpaid('terms');
    // A transport failure or a timeout: no answer came back.
    case 'NETWORK_ERROR':
      return unpaid('unreachable');
    // AN ANSWER THAT WAS NOT A USABLE 402. API_UNREACHABLE from the provider
    // leg always carries one (another status, or a redirect this build will
    // not follow); a transport failure is NETWORK_ERROR. The others: a
    // challenge this build cannot read, or a free body that missed its rule.
    case 'API_UNREACHABLE':
    case 'CONTRACT_MISMATCH':
    case 'CHALLENGE_TOO_LARGE':
      return unpaid('provider');
    default:
      return null;
  }
}

/** One ledger line for a paid call; the settlement is known only with a tx. */
function paidRecord(
  decision: { capabilityId: string; provider: string; label?: string },
  url: string,
  sent: string,
  amountAtomic: bigint,
  opts: {
    txHash?: string;
    authorization?: SignedAuthorization;
    savedFiles: string[];
    now?: () => number;
  },
): PaidRecord {
  return {
    version: 1,
    ts: new Date((opts.now ?? Date.now)()).toISOString(),
    capabilityId: decision.capabilityId,
    provider: decision.provider,
    ...(decision.label !== undefined ? { label: decision.label } : {}),
    url,
    sent: recordedSent(sent),
    amountAtomic: amountAtomic.toString(),
    ...(opts.txHash !== undefined ? { txHash: opts.txHash } : {}),
    settlement: opts.txHash !== undefined ? 'settled' : 'unknown',
    savedFiles: opts.savedFiles,
    ...(opts.authorization !== undefined ? { authorization: opts.authorization } : {}),
  };
}

/** Extensions for the media types a paid lookup plausibly returns; any other
 *  type, `text/html` from a seller included, is saved as `.bin`. */
const EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/quicktime': 'mov',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/octet-stream': 'bin',
};

export function extensionFor(contentType: string): string {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return EXTENSIONS[type] ?? 'bin';
}

/**
 * Write a binary body under the data dir as `<capability>-<timestamp>.<ext>`
 * and say where: the path, the type and the size are what the host needs to
 * use it. The name is built from characters a path segment can always hold.
 *
 * NEVER THROWS. The money has already moved when this runs, and a throw here
 * would reach the failure arm, which reports nothing paid; a file that could
 * not be written is said so beside the amount instead.
 */
async function saveBinary(
  dataDir: string,
  capabilityId: string,
  bytes: Uint8Array,
  opts: { contentType: string; now?: () => number; budget?: { leftBytes: number } },
): Promise<{ savedTo?: string; saveError?: string; contentType: string; bytes: number }> {
  const described = { contentType: opts.contentType, bytes: bytes.byteLength };
  // ONE CALL WRITES AT MOST ITS SHARE: several takes of a video each bring a
  // file home, and the disk is the user's. Taken before the write, given back
  // when it fails.
  if (opts.budget !== undefined && bytes.byteLength > opts.budget.leftBytes) {
    return { saveError: CAP_REACHED, ...described };
  }
  if (opts.budget !== undefined) opts.budget.leftBytes -= bytes.byteLength;
  try {
    const file = await createUniqueFile(
      downloadsDir(dataDir),
      `${capabilityId.slice(0, 80)}-${(opts.now ?? Date.now)()}`,
      extensionFor(opts.contentType),
    );
    try {
      await writeAll(file.handle, bytes);
    } finally {
      await file.handle.close();
    }
    return { savedTo: file.path, ...described };
  } catch (err) {
    if (opts.budget !== undefined) opts.budget.leftBytes += bytes.byteLength;
    return { saveError: err instanceof Error ? err.message : String(err), ...described };
  }
}

export type FailStatus = 'failed' | 'needs_approval' | 'needs_input' | 'native';

function checkContract(contract: DecisionContract): { status: FailStatus; reason: string } | null {
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
  // The arguments are NOT re-validated here. The server binds them against the
  // capability's own schema and builds `request` from the result; this client
  // never re-encodes them, so a second check against a schema the answer no
  // longer carries would be checking a copy of somebody else's rule.
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

/** ONE COST LINE, because there is one payment: the provider's. */
export function costLines(providerAtomic: bigint): string[] {
  return [`provider price ${toMoney(providerAtomic.toString()).usd} USD`];
}

/**
 * ROUTINE CONTROL OUTCOMES, not failures of this tool. A routing decision was
 * delivered and it says the turn continues somewhere else: with the host's own
 * tools, with a question for the user, or with an approval the user gives.
 * The MCP error flag is for what went WRONG, and raising it on these put a
 * red box in front of the user on the most ordinary answer the router has.
 */
const ROUTINE: ReadonlySet<FailStatus> = new Set(['native', 'needs_input', 'needs_approval']);

const ROUTER_OFF_NEXT_STEP =
  'Continue with your own tools. Nothing was sent to the router and nothing was bought.';

/**
 * Why the router is off for this directory, naming the key and the file that
 * set it, or null when it is on. A layer that cannot be read is off: a switch
 * the user set must not fail open.
 */
async function routerOff(deps: RequestToolDeps): Promise<string | null> {
  try {
    const { enabled } = await routerSettings({
      cwd: deps.cwd ?? process.cwd(),
      dataDir: deps.ctx.dataDir,
    });
    if (enabled.value) return null;
    return `router.enabled is false in ${enabled.path ?? 'the config'}, so the router is off here.`;
  } catch (err) {
    return `router.enabled could not be read (${err instanceof Error ? err.message : String(err)}), so the router is off here.`;
  }
}

/** One short line saying what the host does next, per routine outcome. */
const NEXT_STEP: Record<string, string> = {
  native: 'Continue with your own tools. Nothing was bought.',
  needs_input:
    'Ask the user for the missing detail, then call `request` again with it. Nothing was bought.',
  needs_approval: 'Tell the user what it would cost; nothing was paid.',
};

/**
 * The four outcomes the target step splits into, each with the step that
 * actually follows from it. The backend's own `nextAction` wins whenever it
 * sent one; this is what a host is told when the code arrives without it.
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

export interface FailExtras {
  providerAtomic?: bigint;
  settlement?: string;
  /** Which rule failed, whether the body was JSON, its size and a bounded
   *  redacted preview: what tells a parse miss from an HTML error page. */
  diagnosis?: Record<string, unknown>;
  /** The provider's HTTP status on a non-2xx answer. */
  providerStatus?: number;
  /** The start of that answer's body, bounded and redacted. Provider content. */
  providerError?: string;
  /** Why the seller says it did not settle a signed payment, bounded and
   *  redacted. Provider content. */
  settlementError?: string;
  /** Where a long job's result will be, as the seller named it. Provider content. */
  statusUrl?: string;
  /** The backend's own stable error code, from a typed non-2xx body. */
  errorCode?: string;
  /** What stopped a non-execute decision, in the backend's own terms. */
  diagnostics?: DecisionDiagnostics;
  /** The backend's plain sentence about the call itself, such as a dead id. */
  note?: string;
  /** Replaces the generic next step, for an outcome this build decided alone. */
  nextStep?: string;
  /** What was sent, or would have been: the bound or built input. */
  parameters?: unknown;
  /** The provider request it went out as. */
  request?: { method: string; url: string };
  /** A plan over the limits, kept for the user's yes: its id, what it buys
   *  and its total. */
  quote?: Record<string, unknown>;
}

/** The headline: calm for a routine outcome, explicit for a real failure. */
function summaryFor(status: FailStatus, reason: string): string {
  if (status === 'native') return `Use your usual tools: ${reason}`;
  if (status === 'needs_input') return `More input needed: ${reason}`;
  if (status === 'needs_approval') return `Needs the user's approval: ${reason}`;
  return `x402 request ${status}: ${reason}`;
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

export function fail(
  status: FailStatus,
  reason: string,
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
      ...(extras.quote !== undefined ? { quote: extras.quote } : {}),
      // The status is the fact; the next step is what to do about it. The
      // BACKEND'S own next action wins when it sent one: it knows which field
      // is missing.
      ...(routine || diagnostics !== undefined || extras.nextStep !== undefined
        ? { nextStep: extras.nextStep ?? nextStepFor(status, diagnostics) }
        : {}),
      ...(diagnostics !== undefined
        ? {
            reasonCode: diagnostics.reasonCode,
            stage: diagnostics.stage,
            ...(diagnostics.missing.length > 0 ? { missing: diagnostics.missing } : {}),
          }
        : {}),
      // What LEFT, not what was delivered: an authorization that was
      // transmitted is money at risk whether or not a result came back.
      cost: costLines(extras.providerAtomic ?? 0n),
      ...(extras.note !== undefined ? { note: extras.note } : {}),
      ...(extras.settlement !== undefined ? { settlement: extras.settlement } : {}),
      ...(extras.diagnosis !== undefined ? { diagnosis: extras.diagnosis } : {}),
      ...(extras.providerStatus !== undefined ? { providerStatus: extras.providerStatus } : {}),
      ...(extras.providerError !== undefined ? { providerError: extras.providerError } : {}),
      ...(extras.settlementError !== undefined ? { settlementError: extras.settlementError } : {}),
      ...(extras.statusUrl !== undefined ? { statusUrl: extras.statusUrl } : {}),
      ...(extras.request !== undefined ? { request: extras.request } : {}),
      ...(extras.parameters !== undefined ? { parameters: extras.parameters } : {}),
      providerContentUntrusted: true,
    },
  };
}
