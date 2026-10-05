import { runPay, type AdvertisedTerms, type PayDeps } from '../commands/pay';
import { loadRawConfig } from '../lib/config';
import { CliError } from '../lib/errors';
import { toMoney } from '../lib/money';
import { downloadsDir } from '../lib/paths';
import { mask } from '../lib/redact';
import { assertResultSchema, canonicalHash, projectBody } from '../lib/request-schema';
import { resolveContextSettings } from '../lib/settings';
import type { SpendAuthorizer, WalletProvider } from '../lib/wallet';
import type { TenjinSigner } from '../lib/wallet/provider';
import type { CommandContext } from '../context';
import { buildSpecRequest, specInputProblems, specText, mergedInput } from './spec-call';
import {
  claimSpecPayment,
  readSpec,
  settleSpecPayment,
  storeFullResult,
  storeSpecs,
  type EarlierPayment,
} from './specs';
import {
  reportSpecOutcome,
  requestDecision,
  type SpecOutcome,
  type DecisionContract,
  type DecisionDiagnostics,
  type OfferSpec,
} from './decision';
import {
  isFeeRequired,
  payForDecision,
  routingFeeApproved,
  routingFeeFor,
  type RoutingFee,
} from './fee';
import { pausedReason, pausedSentence } from './lanes';
import { openLookupFooter, type LookupFooter } from './progress';
import {
  appendPaidRecord,
  MAX_MEDIA_FILES,
  mediaUrlsIn,
  reconcilePayments,
  recordedSent,
  saveMedia,
  createUniqueFile,
  maskDeep,
  writeAll,
  type MediaTransport,
  type PaidRecord,
  type SignedAuthorization,
} from './paid';
import { routerSettings } from './settings';

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
 * WHAT IS CHECKED LOCALLY, BEFORE ANYTHING IS SIGNED: the input against the
 * spec's schema, the decision's arguments against the schema it carries, its success rule against the compiler, its
 * destination against the shared preflight inside `runPay`, and the amount
 * actually signed against `maxAutoSpend` and `sessionBudget` in `gateSpend`.
 * That last one is the whole money story: a hostile backend can name any
 * origin and spend at most one `maxAutoSpend` inside the daily budget.
 *
 * `needs_approval` is a LOCAL outcome only. The server never sends it: it is
 * what a price over the cap or an exhausted budget looks like from here, and the fix is a command the user can run.
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
  /** Clock seam for a saved file's name and a lane's claim. */
  now?: () => number;
  /** Which path the routing call takes; the MCP server passes its own lanes
   *  first. Absent resolves it from the config and the lane pool. */
  routingFee?: RoutingFee;
  /** Test seam for the media download; production pins each connection to
   *  the address it validated. */
  mediaTransport?: MediaTransport;
}

export interface RequestToolResult {
  isError: boolean;
  summary: string;
  envelope: Record<string, unknown>;
}

export async function runRequestTool(
  args: RequestToolArgs,
  deps: RequestToolDeps,
): Promise<RequestToolResult> {
  // THE SAME SWITCH THE HOOKS OBEY, read first. The tool is pre-allowed, so
  // without this it would be a second path off the machine in a repository the
  // user marked private: nothing is sent and nothing is paid.
  const off = await routerOff(deps);
  if (off !== null) return fail('needs_input', off, { nextStep: ROUTER_OFF_NEXT_STEP });
  const id = args.id !== undefined && args.id.length > 0 ? args.id : undefined;
  const { input } = args;
  // THE OFFER'S SPEC, when the hook kept one for this id: its id alone shows
  // the spec, with no network call and nothing paid, so the agent sees the
  // real inputs before it builds any.
  const spec = id !== undefined ? await readSpec(deps.ctx.dataDir, id) : null;
  if (spec !== null && input === undefined) return showSpec(id!, spec);
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
    // than a guess.
    if (spec === null) {
      return fail(
        'needs_input',
        'The spec for that offer is no longer kept on this machine (it expired or was pruned), so nothing was sent or paid.',
        { nextStep: 'Call request({query}) with the task for a fresh offer, then fill its line.' },
      );
    }
  }
  // THE FOOTER, OPENED FIRST AND TRUSTED WITH NOTHING: it shows this lookup in
  // the terminal while it runs, resolved to a session through the hook's own
  // binding for `id`, and every call on it swallows its own failure.
  const footer = await openLookupFooter(deps.ctx.dataDir, {
    ...(id !== undefined ? { id } : {}),
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
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };

  // A SPEC AND AN INPUT: the agent filled the spec's request itself, so it is
  // checked and sent here and paid straight to the provider, with no second
  // decision. The server hears only how it ended.
  if (spec !== null && input !== undefined) {
    return runSpec(id!, spec, input, deps, footer, decisionDeps);
  }

  // ONE CALL, ONE DECISION. The query the model wrote goes to the backend with
  // the turn id when it has one: the free docs offer's id binds the query, and
  // with no id the gate picks a service and answers with its spec. An id the
  // backend does not know is its own plain note, and the pick still runs from
  // the query.
  // ON THE PAID PATH the call spends one rung of a lane this process's owner
  // signed, and with no lane free it is not made: the host's own tools run.
  const config = await loadRawConfig(deps.ctx.dataDir).catch(() => ({}));
  const fee = deps.routingFee ?? (await routingFeeFor(deps.ctx.dataDir, config));
  const fresh = await payForDecision(
    fee,
    (payment) =>
      requestDecision(
        'tool',
        { query, ...(id !== undefined ? { id } : {}) },
        { ...decisionDeps, ...(payment !== undefined ? { payment } : {}) },
      ),
    deps.now?.() ?? Date.now(),
  );
  if (fresh.status === 'skipped') {
    await footer.done('native');
    return fail(
      'native',
      `No routing lane could pay the $0.003 routing fee (${fresh.why}), so nothing was routed or paid.`,
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
  // which is wrong for this one: what stops routing here is the approval, or
  // lanes that are not funded yet.
  if (isFeeRequired(fresh.decision)) {
    await footer.done('native');
    const paused = await pausedReason(deps.ctx.dataDir, routingFeeApproved(config));
    return fail(
      'native',
      paused !== null
        ? pausedSentence(paused)
        : 'Tenjin routing is starting: the routing fee is approved and this machine has no funded routing lane yet, so nothing was routed or paid.',
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
    await footer.done('service found');
    const picked = decision.specs?.find((spec) => spec.id === decision.id);
    if (picked !== undefined) {
      return showSpec(
        picked.id,
        picked,
        decision.specs!.filter((spec) => spec !== picked),
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
  return (
    await payAndDeliver(
      {
        capabilityId: decision.capabilityId,
        provider: decision.provider,
        discovered: decision.category === 'discovered',
        request: contract.request,
        terms: { source: decision.provider, maxAmountAtomic: decision.providerPriceAtomic },
        requestKey: `${decision.capabilityId}:${canonicalHash(contract.arguments ?? {})}`,
        ...(contract.resultSchema !== undefined ? { resultSchema: contract.resultSchema } : {}),
        ...(contract.arguments !== undefined ? { parameters: contract.arguments } : {}),
        // What the ledger records as sent: the host's input, or its query.
        sent: input !== undefined ? JSON.stringify(maskDeep(input)) : query,
        ...(note !== undefined ? { note } : {}),
      },
      deps,
      footer,
    )
  ).result;
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
function alreadyPaid(id: string, spec: OfferSpec, earlier: EarlierPayment): RequestToolResult {
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
 */
async function runSpec(
  id: string,
  spec: OfferSpec,
  input: Record<string, unknown>,
  deps: RequestToolDeps,
  footer: LookupFooter,
  decisionDeps: { ctx: CommandContext; baseUrl: string; fetchImpl?: typeof fetch },
): Promise<RequestToolResult> {
  const merged = mergedInput(spec, input);
  const sentInput = maskDeep(merged) as Record<string, unknown>;
  // A WRONG GUESS COSTS ONE MORE CALL, NOT A PAYMENT: every problem, then the
  // whole spec (each input with its description and allowed values, the
  // required fields inside a nested object, the example, what comes back), so
  // the next call can be right. Local, with no server call and nothing sent
  // or paid.
  const refuse = async (problem: string): Promise<RequestToolResult> => {
    await footer.done('needs_input');
    const refused = fail('needs_input', `The input does not fit ${spec.provider}: ${problem}.`, {
      nextStep: `Fix the input from the spec above and call request({id: ${JSON.stringify(id)}, input: {...}}) again; nothing was sent or paid.`,
      parameters: sentInput,
    });
    return { ...refused, summary: `${refused.summary}\n\n${specText(id, spec)}` };
  };
  const problems = specInputProblems(spec, merged);
  // A SCHEMA THIS BUILD CANNOT COMPILE CHECKS NOTHING, so the call is not
  // paid: an input nobody checked is a paid guess, and no change to it helps.
  if (problems === undefined) {
    await footer.done('failed');
    return fail(
      'failed',
      `The spec for ${spec.provider} has an input schema this build cannot check, so the call was not sent and nothing was paid.`,
      {
        nextStep: 'Continue with your own tools. Nothing was sent or paid.',
        parameters: sentInput,
      },
    );
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
    await footer.done(refusal.status);
    return fail(refusal.status, refusal.reason, { parameters: sentInput });
  }
  // ONE PAYMENT PER OFFER, claimed before anything is signed: a retry of this
  // id, or a second call racing it, pays nothing.
  const earlier = await claimSpecPayment(deps.ctx.dataDir, id);
  if (earlier !== null) {
    await footer.done('needs_input');
    return alreadyPaid(id, spec, earlier);
  }
  const startedAt = Date.now();
  const { result, outcome, left } = await payAndDeliver(
    {
      capabilityId: spec.capabilityId,
      provider: spec.provider,
      discovered: spec.capabilityId.startsWith('discovered:'),
      request: built,
      terms: {
        source: spec.provider,
        maxAmountAtomic: spec.maxAmountAtomic,
        payTo: spec.payTo,
        network: spec.network,
        asset: spec.asset,
      },
      requestKey: `${spec.capabilityId}:${canonicalHash(merged)}`,
      ...(spec.resultSchema !== undefined ? { resultSchema: spec.resultSchema } : {}),
      ...(spec.outputSchema !== undefined ? { project: { id, schema: spec.outputSchema } } : {}),
      parameters: sentInput,
      sent: JSON.stringify(sentInput),
      agentBuilt: true,
      priceVaries: spec.priceVaries,
    },
    deps,
    footer,
  );
  // The claim survives anything that may have signed: only a call that
  // signed nothing frees the id for a fixed input.
  await settleSpecPayment(deps.ctx.dataDir, id, left);
  // REPORTED ONLY WHEN THE CALL RAN OR MONEY LEFT: a refusal before payment
  // (the spend policy, the spec's terms, the provider's own 4xx) took nothing
  // from the offer, and the server would count it as the offer taken.
  const ran =
    outcome.status === 'fulfilled' || outcome.status === 'unverified' || left.amountAtomic > 0n;
  if (ran) {
    void reportSpecOutcome(
      { id, ...outcome, ms: Date.now() - startedAt },
      {
        ctx: decisionDeps.ctx,
        baseUrl: decisionDeps.baseUrl,
        ...(decisionDeps.fetchImpl !== undefined ? { fetchImpl: decisionDeps.fetchImpl } : {}),
      },
    );
  }
  return result;
}

/** One provider call to make and pay for, from a decision or a spec. */
interface ProviderCall {
  capabilityId: string;
  provider: string;
  /** A discovered service: a paid media result's links are saved locally. */
  discovered: boolean;
  request: { url: string; method: string; headers: Record<string, string>; body?: string };
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
}

/**
 * PAY THE PROVIDER AND DELIVER WHAT CAME BACK: `runPay` under the caller's
 * terms, the binary or media result saved, the ledger written, and the
 * envelope the host reads, with what was sent on every outcome. `outcome` is
 * the short form the server's report takes.
 */
async function payAndDeliver(
  call: ProviderCall,
  deps: RequestToolDeps,
  footer: LookupFooter,
): Promise<{
  result: RequestToolResult;
  outcome: Omit<SpecOutcome, 'id' | 'ms'>;
  /** What left this machine for the call, whatever came back. `signed`: a
   *  payment may have been signed, even where the amount is unknown. */
  left: { amountAtomic: bigint; txHash?: string; signed: boolean };
}> {
  const built = call.request;
  const parameters = call.parameters !== undefined ? { parameters: call.parameters } : {};
  const signing = watchSigning(deps.payDeps?.authorizer ?? deps.authorizer);
  try {
    // WHAT IS ABOUT TO BE CALLED, named while it is being called. This is the
    // executed destination, not the hint's suggestion, which is the whole point
    // of showing it.
    await footer.calling({ provider: built.url, ...parameters });
    const paid = await runPay(
      {
        url: built.url,
        method: built.method,
        headers: built.headers,
        ...(built.body !== undefined ? { rawBody: built.body } : {}),
        terms: call.terms,
        execution: 'router',
        requestKey: call.requestKey,
        ...(call.resultSchema !== undefined ? { resultSchema: call.resultSchema } : {}),
        printBody: true,
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
    const httpStatus = typeof data.status === 'number' ? { httpStatus: data.status } : {};
    // A FILE IS SAVED, NOT INLINED: its bytes are no use as text in a tool
    // result, so the result names where they are.
    const binary =
      data.bodyBytes !== undefined
        ? await saveBinary(deps.ctx.dataDir, call.capabilityId, data.bodyBytes, {
            contentType: data.contentType ?? '',
            ...(deps.now !== undefined ? { now: deps.now } : {}),
          })
        : null;
    // AND A PAID MEDIA RESULT THAT LINKS TO ITS FILES brings them home: the
    // links can expire, and the user paid for what is behind them. Only a
    // discovered service (where generated images, audio and video come from)
    // does this: a curated page read or search links whatever the page links,
    // on hosts the page picked. The answer carries no finer media kind, so the
    // category is the line. Best effort only.
    const linked =
      providerAtomic > 0n && binary === null && call.discovered
        ? await saveMedia(
            deps.ctx.dataDir,
            call.capabilityId,
            mediaUrlsIn(data.bodyText ?? '', MAX_MEDIA_FILES),
            {
              ...(deps.mediaTransport !== undefined ? { transport: deps.mediaTransport } : {}),
              ...(deps.payDeps?.destination !== undefined
                ? { destination: deps.payDeps.destination }
                : {}),
              ...(deps.now !== undefined ? { now: deps.now } : {}),
            },
          )
        : [];
    const savedFiles = [...(binary?.savedTo !== undefined ? [binary.savedTo] : []), ...linked];
    const cut =
      binary === null && call.project !== undefined && data.bodyText !== undefined
        ? await projected(deps.ctx.dataDir, call.project, data.bodyText)
        : null;
    if (providerAtomic > 0n) {
      await appendPaidRecord(
        deps.ctx.dataDir,
        paidRecord(call, built.url, call.sent, providerAtomic, {
          ...(data.settlementTxHash !== undefined ? { txHash: data.settlementTxHash } : {}),
          ...(data.authorization !== undefined ? { authorization: data.authorization } : {}),
          savedFiles,
          ...(deps.now !== undefined ? { now: deps.now } : {}),
        }),
      );
    }
    const base = {
      supplier: supplierOf(built.url),
      ...parameters,
      cost: costLines(providerAtomic),
      ...(data.settlementTxHash !== undefined ? { settlementTxHash: data.settlementTxHash } : {}),
      ...(call.note !== undefined ? { note: call.note } : {}),
      result: binary ?? cut?.result ?? data.bodyText ?? '',
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
      ...parameters,
      price: `$${toMoney(providerAtomic.toString()).usd}`,
    };
    if (data.resultUnverified === true) {
      await footer.done('unverified', shown);
      return {
        outcome: { status: 'unverified', ...httpStatus },
        left: { amountAtomic: providerAtomic, ...tx, signed: signing.mayHaveSigned() },
        result: {
          isError: true,
          summary: `Unverified result from ${base.supplier} · ${base.cost.join(' · ')}`,
          envelope: {
            status: 'unverified',
            ...base,
            ...(data.resultCaveat !== undefined ? { resultCaveat: data.resultCaveat } : {}),
          },
        },
      };
    }
    await footer.done('fulfilled', shown);
    return {
      outcome: { status: 'fulfilled', ...httpStatus },
      left: { amountAtomic: providerAtomic, ...tx, signed: signing.mayHaveSigned() },
      result: {
        isError: false,
        summary: `Fulfilled by ${base.supplier} · ${base.cost.join(' · ')}`,
        envelope: { status: 'fulfilled', ...base },
      },
    };
  } catch (err) {
    const cli = err instanceof CliError ? err : undefined;
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
      authorization?: SignedAuthorization;
      /** The live 402's terms, on a REGISTRY_MISMATCH. */
      live?: { amount?: string };
    };
    // A SPEND-POLICY REFUSAL SIGNED NOTHING. Its details carry the price it
    // refused, not an amount that left, so it is neither a cost nor a ledger
    // row: the PDL refusal sat in the ledger as $0.28 paid.
    const leftAtomic = status === 'needs_approval' ? 0n : BigInt(detail.amountAtomic ?? '0');
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
          ? `${cli.message} ${cli.fix ?? ''}`.trim()
          : String(err);
    await footer.done(status, {
      provider: built.url,
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
    return {
      left: { amountAtomic: leftAtomic, signed: signing.mayHaveSigned() },
      outcome: {
        status,
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
        // WHAT WAS SENT, on a failure too: the agent cannot match a 400 to a
        // field it cannot see.
        request: { method: built.method, url: built.url },
        ...(call.parameters !== undefined ? { parameters: call.parameters } : {}),
        ...(overCeiling
          ? { nextStep: 'Change the input and call again with the same id.' }
          : rejectedInput
            ? { nextStep: 'Fix the input and call again with the same id.' }
            : {}),
      }),
    };
  }
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

/** One ledger line for a paid call; the settlement is known only with a tx. */
function paidRecord(
  decision: { capabilityId: string; provider: string },
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
  opts: { contentType: string; now?: () => number },
): Promise<{ savedTo?: string; saveError?: string; contentType: string; bytes: number }> {
  const described = { contentType: opts.contentType, bytes: bytes.byteLength };
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
    return { saveError: err instanceof Error ? err.message : String(err), ...described };
  }
}

type FailStatus = 'failed' | 'needs_approval' | 'needs_input' | 'native';

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
 * tools, with a question for the user, or with an approval the user gives. The
 * MCP error flag is for what went WRONG, and raising it on these three put a
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
  needs_approval:
    'Report the command above to the user; this build will not raise a spend limit on its own.',
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

interface FailExtras {
  providerAtomic?: bigint;
  settlement?: string;
  /** Which rule failed, whether the body was JSON, its size and a bounded
   *  redacted preview: what tells a parse miss from an HTML error page. */
  diagnosis?: Record<string, unknown>;
  /** The provider's HTTP status on a non-2xx answer. */
  providerStatus?: number;
  /** The start of that answer's body, bounded and redacted. Provider content. */
  providerError?: string;
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
}

/** The headline: calm for a routine outcome, explicit for a real failure. */
function summaryFor(status: FailStatus, reason: string): string {
  if (status === 'native') return `No paid lookup needed: ${reason}`;
  if (status === 'needs_input') return `More input needed: ${reason}`;
  if (status === 'needs_approval') return `Blocked by spending policy: ${reason}`;
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

function fail(status: FailStatus, reason: string, extras: FailExtras = {}): RequestToolResult {
  const routine = ROUTINE.has(status);
  const { diagnostics } = extras;
  return {
    isError: !routine,
    summary: summaryFor(status, reason),
    envelope: {
      status,
      reason,
      ...(extras.errorCode !== undefined ? { errorCode: extras.errorCode } : {}),
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
      ...(extras.request !== undefined ? { request: extras.request } : {}),
      ...(extras.parameters !== undefined ? { parameters: extras.parameters } : {}),
      providerContentUntrusted: true,
    },
  };
}
