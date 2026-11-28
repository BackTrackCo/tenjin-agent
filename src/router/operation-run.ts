import { randomUUID } from 'node:crypto';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { mask } from '../lib/redact';
import { inputProblems } from '../lib/request-schema';
import { resolveContextSettings, type ResolvedSettings } from '../lib/settings';
import { admitPlan, type PlanSlot } from '../lib/spend-plan';
import { createQuote } from '../lib/spend-quotes';
import {
  DEADLINE_AFTER_PAYMENT_SENT,
  MAX_INPUT_BYTES,
  unmetRequires,
  type DecisionDeps,
  type OperationRow,
  type ToolSpec,
} from './decision';
import { unpaidSentence } from './fee';
import type { TaskOffer } from './decision';
import { maskDeep } from './paid';
import { approveStep, planStop, quoteView, type PlanWords } from './plan';
import type { LookupFooter } from './progress';
import { inputLines } from './spec-call';
import { claimSpecPayment, readKeptSpec, type KeptSpec } from './specs';
import type { WireSettings } from './settings-wire';
import { requestRunOnce, requestOperationRead } from './operation-request';
import {
  closeRun,
  readRun,
  readOperationKept,
  readOffer,
  storeRun,
  storeOperationRead,
} from './operation-store';
import type { RunDecision, Operation } from './operation-wire';
import {
  costLines,
  fail,
  paySpec,
  prepareSpec,
  type FailStatus,
  type ReportDeps,
  type RequestToolArgs,
  type RequestToolDeps,
  type RequestToolResult,
} from './tool';

/**
 * A ROUTED OPERATION CALL, FROM THE READ TO THE RECEIPT. `request({operation})` reads an
 * operation for free. `request({operation, input})` (and `request({id, input})` on an
 * offer) runs it:
 *
 * 1. THE INPUT IS CHECKED against the read's input schema before any run is
 *    asked for. A wrong one sends nothing, and pays nothing.
 * 2. ONE QUOTE, BEFORE EITHER PAYMENT. The plan holds the Tenjin fee and the
 *    service's allowed maximum, which meet `maxAutoSpend` and the daily budget
 *    together once. Over them, nothing is sent: the plan is kept as a quote
 *    for the person's yes (`approve`). The person is shown one estimated total
 *    and one maximum.
 * 3. A NEW RUN, EVERY CALL. The run id is picked here and stays inside the call.
 *    The paid route is asked for the run with the amounts the person approved;
 *    the payer pays the fee its 402 quotes, never more than the approved fee.
 *    The answer is the only place the service's request, URL and payee reach
 *    this machine. An equal call a moment later is a new run and pays its own
 *    fee; a run is kept only so this same call can finish (one re-send after a
 *    lost answer, one attempt on a person's yes after a lost service reply),
 *    and a run whose result was delivered is closed.
 * 4. THE SERVICE, ONCE. The input is checked against the run answer's own spec
 *    before anything is claimed: if it does not fit, nothing is sent to the
 *    service and nothing is signed for it, and the caller gets the service's
 *    current input fields. The call is paid like any spec's (`paySpec`) against
 *    the plan's service slot and returns the service's own result, cut to its
 *    `outputSchema` as a manual call does. There is no second service: a
 *    service that refuses before payment, or whose live price is over the
 *    approved cap, stops the run with nothing paid to a service. After a
 *    payment is signed, none is ever tried on this machine's own word: a reply
 *    lost after the signature leaves the claim possibly paid, and only a
 *    person's yes on `approve` starts one new attempt under the same run, with
 *    a new claim and no new fee ({@link retryOperation}).
 * 5. THE RECEIPT shows the Tenjin fee and the service's payment on separate
 *    lines. No result, summary or error names the service's URL or host.
 *
 * Imported by `tool.ts` alone, so it stays in the request tool's chunk.
 */

/** What an operation call needs of the request tool's own state. */
export interface OperationEnv {
  /** The user's rules as the wire carries them, or none. */
  sent: WireSettings | undefined;
  /** `router.improve`. */
  improve: boolean;
}

const usd = (atomic: bigint): string => `$${toMoney(atomic.toString()).usd}`;

/** The one operation a call names: a compare key picks among a operation's services. */
interface TaskCall {
  operation: string;
  input: Record<string, unknown>;
  offer?: string;
  choice?: string;
  /** The offer is an open-Bazaar row's: no operation schema to check the input against. */
  listing?: OperationRow;
}

/**
 * A ROUTER THAT PREDATES ROUTED TASKS does not know the operation read: it answers
 * the unknown form with `validation_failed`. The call is then the old
 * `{tool}` read of the same id, which that router answers with a spec, and
 * the agent goes on with `{id, input}` as it always did.
 */
export const LEGACY_ROUTER = 'legacy_router';

/** The arguments of a call that is not a operation call, so {@link runOperationForm}
 *  hands it back to the ordinary tool. */
const OTHER_FORMS = ['query', 'tool', 'browse', 'job', 'source'] as const;

/**
 * THE OPERATION FORMS OF `request`, or undefined when the call is none of them: a
 * `operation`, or an `id` that names an offer of operations this machine kept (and no
 * spec of its own). `{operation}` reads, and `{operation, input}` runs.
 */
export async function runOperationForm(
  args: RequestToolArgs,
  deps: RequestToolDeps,
  env: OperationEnv,
): Promise<RequestToolResult | undefined | typeof LEGACY_ROUTER> {
  const { dataDir } = deps.ctx;
  const offered = args.id !== undefined && args.id.length > 0 ? args.id : undefined;
  const keptOffer = offered !== undefined ? await readOffer(dataDir, offered) : null;
  const options = keptOffer?.choices?.options;
  let operation = args.operation?.trim();
  const offer = keptOffer !== null ? offered : undefined;
  if (operation === undefined) {
    // AN ID THAT NAMES AN OFFER OF TASKS runs its lead operation, the option a
    // choice names, or every option for `all`.
    if (offered === undefined || args.query !== undefined || keptOffer === null) return undefined;
    if ((await readKeptSpec(dataDir, offered)) !== null) return undefined;
    if (args.choice === 'all') {
      if (options === undefined) return undefined;
      operation = options[0]!.operation;
    } else if (args.choice !== undefined) {
      const picked = options?.find(({ key }) => key === args.choice);
      if (picked === undefined) return undefined;
      operation = picked.operation;
    } else {
      operation = keptOffer.operations[0]!.operation;
    }
  }
  if (operation.length === 0 || operation.length > 200) {
    return fail(
      'needs_input',
      '`operation` takes a operation id from request({browse}) or an offer.',
    );
  }
  const others = OTHER_FORMS.filter((key) => args[key] !== undefined);
  if (others.length > 0) {
    return fail(
      'needs_input',
      `\`operation\` goes with \`input\` alone (and the id of its offer); ${others.join(', ')} was sent, so nothing was sent or paid.`,
      { nextStep: 'Call request({operation, input}) with the operation and its inputs.' },
    );
  }
  const { count } = args;
  if (count !== undefined && (!Number.isInteger(count) || count < 2 || count > 5)) {
    return fail('needs_input', 'count is a whole number of takes from 2 to 5; nothing was sent.');
  }
  if (count !== undefined && args.choice !== undefined) {
    return fail(
      'needs_input',
      'count runs several takes of one operation, so it does not go with a choice; nothing was sent.',
    );
  }
  if (args.choice === 'all' && (options === undefined || offer === undefined)) {
    return fail(
      'needs_input',
      '`choice: "all"` runs every choice an offer lists, so it goes with that offer\'s id; nothing was sent.',
      { nextStep: 'Ask with request({query}) for an offer that lists choices.' },
    );
  }
  if (mask(operation) !== operation) {
    return fail(
      'native',
      'the operation id carries a credential-shaped value, so nothing was sent',
    );
  }
  // AN OPEN-BAZAAR LISTING has no operation of its own: its row names the offer row
  // that holds it, and the run sends that back. Its price is the row's.
  const row = keptOffer?.operations.find((r) => r.operation === operation && r.offer !== undefined);
  const bazaar =
    row !== undefined && row.offer !== undefined
      ? { offer: row.offer, operation: bazaarOperation(row) }
      : undefined;
  const settings = await resolveContextSettings(deps.ctx);
  let read: { operation: Operation } | { legacy: true } | { refused: RequestToolResult };
  if (bazaar !== undefined && bazaar.operation !== null) read = { operation: bazaar.operation };
  else read = await readOperation(operation, deps, env, settings);
  if ('legacy' in read) return LEGACY_ROUTER;
  if ('refused' in read) return read.refused;
  if (args.input === undefined) return showOperation(read.operation);
  const serialized = JSON.stringify(args.input);
  if (Buffer.byteLength(serialized) > MAX_INPUT_BYTES) {
    return fail('needs_input', `The input is over ${MAX_INPUT_BYTES} bytes; send a smaller one.`);
  }
  if (JSON.stringify(maskDeep(args.input)) !== serialized) {
    return fail('native', 'the input carries a credential-shaped value, so nothing was sent');
  }
  const { openLookupFooter } = await import('./progress');
  const footer = await openLookupFooter(dataDir, offer !== undefined ? { id: offer } : {});
  await footer.routing();
  if (args.choice === 'all' || count !== undefined) {
    return runOperationSet(
      {
        operation,
        label: read.operation.label,
        input: args.input,
        ...(offer !== undefined ? { offer } : {}),
        ...(count !== undefined ? { count } : {}),
        ...(args.choice === 'all' && options !== undefined
          ? { options: options.map(({ key, operation: t }) => ({ key, operation: t })) }
          : {}),
      },
      deps,
      env,
      footer,
    );
  }
  return runOperation(
    {
      operation,
      input: args.input,
      ...(bazaar !== undefined && bazaar.operation !== null
        ? { offer: bazaar.offer, listing: row! }
        : offer !== undefined
          ? { offer }
          : {}),
      ...(args.choice !== undefined ? { choice: args.choice } : {}),
    },
    deps,
    env,
    footer,
    undefined,
    read.operation,
  );
}

/**
 * THE OPERATION AN OPEN-BAZAAR ROW STANDS FOR. A listing has no operation read and no
 * input schema of its own: the router's row gives its price, and the listing's
 * own spec arrives with the run and checks the input before anything is paid.
 * The caps are the row's price with the router's usual 10% headroom, and the
 * routing fee is 15% of the price. Null when the price cannot be read.
 */
function bazaarOperation(row: OperationRow): Operation | null {
  let price: bigint;
  try {
    price = BigInt(parseUsdToAtomic(row.price.replace(/^\$/, '')));
  } catch {
    return null;
  }
  const max = price + (price + 9n) / 10n;
  const fee = (price * 15n + 99n) / 100n;
  return {
    id: row.operation,
    label: row.label,
    does: row.does,
    input: { type: 'object' },
    price: {
      expectedAtomic: price.toString(),
      maxAtomic: max.toString(),
      feeAtomic: fee.toString(),
    },
    free: false,
    kind: 'listing',
  };
}

/** The deps a call to the router is made with. */
async function decisionDepsOf(
  deps: RequestToolDeps,
  env: OperationEnv,
  settings: ResolvedSettings,
): Promise<DecisionDeps> {
  return {
    ctx: deps.ctx,
    baseUrl: settings.baseUrl,
    acceptsBazaar: settings.experimentalBazaar,
    harness: deps.harness ?? 'claude',
    improve: env.improve,
    ...(env.sent !== undefined ? { settings: env.sent } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  };
}

/** The operation as the router describes it, kept for 15 minutes, or the result to
 *  hand back. */
async function readOperation(
  operation: string,
  deps: RequestToolDeps,
  env: OperationEnv,
  settings: ResolvedSettings,
): Promise<{ operation: Operation } | { legacy: true } | { refused: RequestToolResult }> {
  const kept = await readOperationKept(deps.ctx.dataDir, operation);
  if (kept !== null) return { operation: kept.operation };
  const read = await requestOperationRead(operation, await decisionDepsOf(deps, env, settings));
  if (read.status === 'failed' && read.errorCode === 'validation_failed') {
    return { legacy: true };
  }
  if (read.status === 'failed') {
    return {
      refused: fail('failed', read.reason, {
        ...(read.errorCode !== undefined ? { errorCode: read.errorCode } : {}),
      }),
    };
  }
  if (read.status !== 'decided') {
    return { refused: fail('failed', 'The router could not be read for this operation.') };
  }
  const answer = read.decision;
  if ('operation' in answer) {
    await storeOperationRead(deps.ctx.dataDir, answer.operation, answer.settingsHash);
    return { operation: answer.operation };
  }
  const decision = answer.decision;
  if (decision.action === 'native' || decision.action === 'needs_input') {
    return {
      refused: fail(decision.action, decision.reason ?? 'The router has no operation by that id.', {
        diagnostics: decision.diagnostics,
        nextStep: 'See the operations with request({browse: ""}).',
      }),
    };
  }
  return { refused: fail('failed', 'The router did not answer with a operation.') };
}

/** `request({operation})`: what the operation takes, returns and costs. Free. */
function showOperation(operation: Operation): RequestToolResult {
  const expected = BigInt(operation.price.expectedAtomic);
  const fee = BigInt(operation.price.feeAtomic);
  const max = BigInt(operation.price.maxAtomic);
  const inputs = inputLines(operation.input);
  const lines = [
    `${operation.label}: ${operation.does}`,
    operation.free
      ? 'Price: free.'
      : `Price: about ${usd(expected + fee)} a run (${usd(expected)} for the service and ${usd(fee)} for Tenjin's routing fee), at most ${usd(max + fee)}. Reading an operation is free; nothing has been paid.`,
    inputs.length > 0 ? `Inputs:\n${inputs.join('\n')}` : 'Inputs: none.',
  ];
  const call = `request({operation: ${JSON.stringify(operation.id)}, input: {...}})`;
  lines.push(`To run it, call ${call} with the inputs above. Nothing has been paid.`);
  return {
    isError: false,
    summary: lines.join('\n'),
    envelope: {
      status: 'operation',
      operation: operation.id,
      label: operation.label,
      does: operation.does,
      input: operation.input,
      price: {
        expected: usd(expected),
        routingFee: usd(fee),
        most: usd(max + fee),
      },
      nextStep: `Call ${call} with the inputs above.`,
      cost: costLines(0n),
      providerContentUntrusted: true,
    },
  };
}

/** A row's input fields as one short line: each field with its description. */
export function rowFields(input: Record<string, unknown>): string {
  const fields = Object.entries(input).map(([name, said]) => {
    const text = typeof said === 'string' ? said : JSON.stringify(said);
    return `${name}${text.length > 0 ? ` (${text.length > 90 ? `${text.slice(0, 89)}…` : text})` : ''}`;
  });
  return `  Input fields: ${fields.join('; ')}`;
}

/** A free offer of operations, shown: the router's line, and each operation in a few words. */
export function showOffer(offer: TaskOffer, note: string | undefined): RequestToolResult {
  const rows = offer.operations.map((row) => ({
    operation: row.operation,
    label: row.label,
    does: row.does,
    price: row.price,
    ...(row.input !== undefined ? { input: row.input } : {}),
  }));
  const picks = offer.choices;
  const lines = [
    ...rows.flatMap((row) => [
      `${row.label} (operation ${row.operation}, ${row.price}): ${row.does.length > 140 ? `${row.does.slice(0, 139)}…` : row.does}`,
      ...(row.input !== undefined ? [rowFields(row.input)] : []),
    ]),
    ...(rows.length > 1
      ? [
          `To run an operation other than the first, call request({operation: "<operation id>", id: ${JSON.stringify(offer.id)}, input}); its input is checked against that operation's own inputs, which request({operation: "<operation id>"}) shows.`,
        ]
      : []),
    ...(picks !== undefined
      ? [
          `Choices (${picks.group}): ${picks.options.map((o) => `${o.key} = ${o.label}, ${o.strength}`).join('; ')}. Run one with request({id: ${JSON.stringify(offer.id)}, choice: "<key>", input}), or all of them for ${usd(BigInt(picks.all.totalAtomic))} with choice: "all".`,
        ]
      : []),
    `Next: ${offer.hint}`,
  ];
  return {
    isError: false,
    summary: lines.join('\n'),
    envelope: {
      status: 'offer',
      id: offer.id,
      task: offer.task,
      operations: rows,
      ...(picks !== undefined ? { choices: picks } : {}),
      nextStep: offer.hint,
      cost: costLines(0n),
      ...(note !== undefined ? { note } : {}),
      providerContentUntrusted: true,
    },
  };
}

/** What a plan of one run buys, in the words the person is asked about. */
function operationWords(label: string, fee: bigint, expected: bigint, max: bigint): PlanWords {
  return {
    what: `one run of ${label}`,
    sentence: `One run of ${label} costs about ${usd(fee + expected)} (${usd(expected)} for the service and ${usd(fee)} for Tenjin's routing fee), and at most ${usd(fee + max)}.`,
  };
}

/** The bare host of a URL the input holds, for page routing; none otherwise. */
function hostOfInput(operation: Operation, input: Record<string, unknown>): string | undefined {
  const properties = operation.input.properties;
  if (properties === null || typeof properties !== 'object') return undefined;
  for (const [name, schema] of Object.entries(properties as Record<string, { format?: unknown }>)) {
    if (schema?.format !== 'uri' && schema?.format !== 'url') continue;
    const value = input[name];
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.hostname;
    } catch {
      // Not a URL: nothing to route by.
    }
  }
  return undefined;
}

/**
 * ONE RUN OF A OPERATION. `approved` are the slots of a quote a person said yes to:
 * the fee's, then the provider's. Without them the plan is admitted here.
 */
export async function runOperation(
  call: TaskCall,
  deps: RequestToolDeps,
  env: OperationEnv,
  footer: LookupFooter,
  approved?: PlanSlot[],
  known?: Operation,
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const settings = await resolveContextSettings(deps.ctx);
  let operation = known;
  if (operation === undefined) {
    const read = await readOperation(call.operation, deps, env, settings);
    if ('refused' in read || 'legacy' in read) {
      await footer.done('failed');
      return 'refused' in read
        ? read.refused
        : fail('failed', 'This router does not run operations, so nothing was sent or paid.', {
            nextStep: 'Call request({query}) for an offer, or use your own tools.',
          });
    }
    operation = read.operation;
  }
  if (operation.free) {
    await footer.done('needs_input');
    return fail('needs_input', `${operation.label} is a free tool, which this form does not run.`, {
      nextStep: 'Call request({tool, query}) for a free tool; nothing was sent or paid.',
    });
  }
  // A WRONG INPUT COSTS ONE MORE CALL, NOT A RUN: every problem, then the operation's
  // inputs, with nothing sent to the router's paid route or paid.
  const problems = call.listing !== undefined ? [] : inputProblems(operation.input, call.input);
  if (problems === undefined) {
    await footer.done('failed');
    return fail(
      'failed',
      `The input schema of ${operation.label} cannot be checked by this build, so the operation was not run and nothing was paid.`,
      { nextStep: 'Continue with your own tools. Nothing was sent or paid.' },
    );
  }
  if (problems.length > 0) {
    await footer.done('needs_input');
    const refused = fail(
      'needs_input',
      `The input does not fit ${operation.label}: ${problems.join('; ')}.`,
      {
        nextStep: `Fix the input and call request({operation: ${JSON.stringify(operation.id)}, input: {...}}) again; nothing was sent or paid.`,
        parameters: maskDeep(call.input),
      },
    );
    return {
      ...refused,
      summary: `${refused.summary}\n\nInputs:\n${inputLines(operation.input).join('\n')}`,
    };
  }
  const expected = BigInt(operation.price.expectedAtomic);
  const fee = BigInt(operation.price.feeAtomic);
  const max = BigInt(operation.price.maxAtomic);
  // ONE QUOTE FOR BOTH PAYMENTS, before either is signed. The provider's host
  // is not known until the run is served, so both payments meet the policy as
  // payments to the router's host; the provider's own host meets it again, as
  // every provider's does, when its payment is signed.
  let slots: PlanSlot[];
  if (approved !== undefined) {
    slots = approved;
  } else {
    const creator = new URL(settings.baseUrl).host;
    const payments = [
      { amountAtomic: fee, creator },
      { amountAtomic: max, creator },
    ];
    const admission = await admitPlan(payments, {
      dataDir,
      policy: settings.policy,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    if (!('admitted' in admission)) {
      const stop = await planStop(
        admission,
        {
          ...operationWords(operation.label, fee, expected, max),
          payments,
          call: {
            kind: 'operation',
            operation: operation.id,
            label: operation.label,
            input: call.input,
            ...(call.offer !== undefined ? { offer: call.offer } : {}),
            ...(call.choice !== undefined ? { choice: call.choice } : {}),
            ...(call.listing !== undefined ? { listing: call.listing } : {}),
          },
        },
        deps,
      );
      await footer.done(stop.status);
      return fail(stop.status, stop.reason, stop.extras);
    }
    slots = admission.admitted;
  }
  const serviceSlot = slots[1];
  if (serviceSlot === undefined) {
    await footer.done('failed');
    return fail('failed', 'The quote for this run holds no service payment, so nothing was paid.');
  }
  const decisionDeps = await decisionDepsOf(deps, env, settings);
  const reportDeps: ReportDeps = {
    ctx: deps.ctx,
    baseUrl: settings.baseUrl,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.harness !== undefined ? { harness: deps.harness } : {}),
  };

  // EVERY CALL IS A NEW RUN (the operator's ruling): the run id is picked here
  // and stays inside this call, so an equal call a moment later starts its own
  // run and pays its own fee. A run is kept only so this same call can finish:
  // one re-send after a lost answer, one attempt on a person's yes after a lost
  // service reply, and a paid job's resume.
  const run = randomUUID();
  const host = hostOfInput(operation, call.input);
  const route = deps.route?.(settings.baseUrl, fee);
  const asked = await requestRunOnce(
    {
      operation: call.operation,
      run,
      caps: { fee, service: max },
      ...(call.offer !== undefined ? { offer: call.offer } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(call.choice !== undefined ? { choice: call.choice } : {}),
    },
    { ...decisionDeps, ...(route !== undefined ? { route } : {}) },
  );
  if (asked.status === 'skipped') {
    await footer.done('native');
    // A reason that lasts (money, the wallet, a limit, the fee's price) is the
    // user's to hear once; a busy channel, a slow unlock or a top-up still on
    // its way is not.
    const lasting = unpaidSentence(asked.why, 'agent', asked.quotedAtomic);
    return fail(
      'native',
      asked.why === DEADLINE_AFTER_PAYMENT_SENT
        ? 'A routing payment went out, and this call ran out of time before its answer. `tenjin mcp` lets it finish so it is recorded; no service was paid.'
        : `${lasting ?? 'Tenjin could not pay the routing fee in time for this run (another routing payment was in progress, the wallet was still unlocking, or its balance could not be read); the next call usually works.'} Nothing was routed and no service was paid.`,
      {
        nextStep:
          lasting !== null
            ? 'Tell the user this once, and use your own tools for now.'
            : 'Use your own tools for this one.',
      },
    );
  }
  if (asked.status === 'failed') {
    await footer.done('failed');
    return fail('failed', asked.reason, {
      ...(asked.errorCode !== undefined ? { errorCode: asked.errorCode } : {}),
    });
  }
  const served = asked.decision.decision;
  const settingsHash = asked.decision.settingsHash;
  if (served.action === 'native' || served.action === 'needs_input') {
    await footer.done(served.action);
    return fail(served.action, served.reason ?? 'The router did not run this operation.', {
      diagnostics: served.diagnostics,
      ...(asked.decision.note !== undefined ? { note: asked.decision.note } : {}),
    });
  }
  if (served.action === 'no_run') {
    await footer.done('native');
    return noRun(served.code, served.reason, operation.label);
  }
  if (served.action === 'run_set') {
    await footer.done('failed');
    return fail(
      'failed',
      'The router answered a set of runs for one run, so nothing was paid to a service.',
    );
  }
  if (served.run !== run || served.operation !== call.operation) {
    await footer.done('failed');
    return fail(
      'failed',
      'The router answered a different run than the one asked for, so nothing was paid to a service.',
    );
  }
  const answer = served;
  // A re-sent run is served at $0: its fee was paid on the first request, whose
  // answer was lost.
  const feePaid =
    BigInt(served.routingFeeAtomic) === 0n && asked.resent ? fee : BigInt(served.routingFeeAtomic);
  await storeRun(dataDir, {
    answer: served,
    ...(settingsHash !== undefined ? { settingsHash } : {}),
    feeAtomic: feePaid.toString(),
    attempts: 1,
  });
  const attempt = await attemptService(
    {
      answer,
      operation,
      input: call.input,
      slot: serviceSlot,
      claim: answer.run,
      feePaid,
      ...(settingsHash !== undefined ? { settingsHash } : {}),
    },
    deps,
    footer,
    reportDeps,
  );
  if (attempt.maybePaid) {
    return maybePaidResult(attempt, answer, operation, call.input, deps, max);
  }
  // A DELIVERED RUN IS CLOSED: nothing serves it to a later call.
  if (attempt.delivered) await closeRun(dataDir, answer.run);
  return attempt.result;
}

/** What a stopped run says when the router answered `no_run`. */
function noRun(code: string, reason: string, label: string): RequestToolResult {
  const next: Record<string, { status: FailStatus; step: string }> = {
    over_caps: {
      status: 'needs_input',
      step: 'The price moved above what was approved. Call request again for a fresh quote.',
    },
    unknown_choice: {
      status: 'needs_input',
      step: 'Read the offer again with request({query}) for its choices, and pick one of them.',
    },
    count_over_max: {
      status: 'needs_input',
      step: 'That operation allows fewer takes at once. Call again with a smaller count.',
    },
    offer_expired: {
      status: 'needs_input',
      step: 'The offer is gone. Ask again with request({query}) for a fresh one.',
    },
    unknown_operation: {
      status: 'needs_input',
      step: 'See the operations with request({browse: ""}) and call one of them.',
    },
    no_service: {
      status: 'native',
      step: 'No service can run it under your settings right now. Use your own tools for now.',
    },
    fee_over_ceiling: {
      status: 'native',
      step: 'The routing fee is above what this install agreed to pay. Use your own tools.',
    },
  };
  const found = next[code] ?? {
    status: 'needs_input' as FailStatus,
    step: 'Call request again, or use your own tools.',
  };
  return fail(found.status, `${reason || `${label} was not run.`} Nothing was paid.`, {
    nextStep: found.step,
  });
}

interface AttemptInput {
  answer: RunDecision;
  operation: Operation;
  input: Record<string, unknown>;
  slot: PlanSlot;
  /** The claim key this attempt's one payment is held under: the run id, or
   *  a later attempt's own. */
  claim: string;
  /** What the Tenjin fee of this run was, atomic, for the receipt. */
  feePaid: bigint;
  settingsHash?: string;
  /** A later attempt under the same run: its number, for its request key. */
  attemptNumber?: number;
}

interface Attempt {
  result: RequestToolResult;
  /** A payment may have left and no result came back. */
  maybePaid: boolean;
  /** A result was delivered: the run is closed. */
  delivered: boolean;
  /** The service's payee address, for the receipt. */
  payTo: string;
  /** What left for the service, when known. */
  paidAtomic: bigint;
  txHash?: string;
}

/** The text with the service's URL, host and name taken out. */
type Named = { provider: string; request: { url: string } };

function scrub(text: string, spec: Named): string {
  let out = text;
  const names = new Set<string>();
  try {
    const url = new URL(spec.request.url);
    names.add(spec.request.url);
    names.add(url.href);
    names.add(url.origin);
    names.add(url.host);
    names.add(url.hostname);
  } catch {
    // No URL to name.
  }
  names.add(spec.provider);
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (name.length < 3) continue;
    out = out.split(name).join('the service');
  }
  return out;
}

/** A result with every place the service could be named taken out. */
function scrubbed(result: RequestToolResult, spec: Named): RequestToolResult {
  const envelope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result.envelope)) {
    if (key === 'supplier' || key === 'request') continue;
    envelope[key] = typeof value === 'string' ? scrub(value, spec) : value;
  }
  return { ...result, summary: scrub(result.summary, spec), envelope };
}

/** The two payments of a run, as the receipt shows them. */
function receiptOf(
  feePaid: bigint,
  payTo: string,
  service: { state: 'paid' | 'possibly_paid' | 'not_paid'; amountAtomic: bigint; txHash?: string },
): Record<string, unknown> {
  return {
    routingFee: { amount: usd(feePaid), payee: 'Tenjin', paid: feePaid > 0n },
    service: {
      state: service.state,
      ...(service.state === 'paid' ? { amount: usd(service.amountAtomic) } : {}),
      payee: payTo,
      ...(service.txHash !== undefined ? { txHash: service.txHash } : {}),
    },
  };
}

/** Both payments as the cost lines of a result. */
function costOf(feePaid: bigint, serviceAtomic: bigint, possibly: boolean): string[] {
  return [
    `routing fee ${toMoney(feePaid.toString()).usd} USD`,
    possibly
      ? "service payment possibly sent (up to the run's approved maximum)"
      : `service price ${toMoney(serviceAtomic.toString()).usd} USD`,
  ];
}

/**
 * THE INPUT FIELDS OF A SERVICE, as the caller fills them: the open fields of
 * its spec (pinned ones left out), required first, each with its description.
 */
export function serviceFields(spec: Pick<ToolSpec, 'input' | 'pinned'>): string[] {
  const properties = Object.fromEntries(
    Object.entries((spec.input.properties ?? {}) as Record<string, unknown>).filter(
      ([name]) => !Object.hasOwn(spec.pinned, name),
    ),
  );
  const required = Array.isArray(spec.input.required)
    ? spec.input.required.filter((name) => typeof name === 'string' && name in properties)
    : [];
  return inputLines({ ...spec.input, properties, required });
}

/**
 * THE SERVICE, ONCE. The run answer names one service. The input is checked
 * against its own spec before anything is claimed: if it does not fit (the
 * service behind the operation changed since the read), nothing is sent to the
 * service and nothing is signed for it, and the caller gets the service's
 * current input fields. There is no second service: a service that refuses
 * before payment, or whose live price is over the approved cap, stops the run
 * with nothing paid to a service. The plan's service slot stays unspent until
 * a payment is signed.
 */
async function attemptService(
  at: AttemptInput,
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: ReportDeps,
): Promise<Attempt> {
  const { answer, operation } = at;
  const { spec } = answer;
  const label = spec.label ?? operation.label;
  const none = { maybePaid: false, delivered: false, payTo: spec.payTo, paidAtomic: 0n };
  const stopped = (result: RequestToolResult): Attempt => ({
    ...none,
    result: scrubbed(
      {
        ...result,
        envelope: {
          ...result.envelope,
          operation: operation.id,
          run: answer.run,
          service: label,
          receipt: receiptOf(at.feePaid, spec.payTo, { state: 'not_paid', amountAtomic: 0n }),
          cost: costOf(at.feePaid, 0n, false),
        },
      },
      spec,
    ),
  });
  const missing = unmetRequires(spec.requires);
  if (missing.length > 0) {
    await footer.done('failed');
    return stopped(
      fail('failed', `${label} needs ${missing.join(', ')}, which this build lacks.`, {
        nextStep: 'Nothing was paid to a service. Use your own tools, or update tenjin-cli.',
      }),
    );
  }
  const kept: KeptSpec = {
    ...spec,
    id: answer.run,
    ...(at.settingsHash !== undefined ? { settingsHash: at.settingsHash } : {}),
  };
  const prepared = await prepareSpec(answer.run, kept, at.input, footer, reportDeps);
  if ('refused' in prepared) {
    const { refused } = prepared;
    if (refused.envelope['status'] !== 'needs_input') return stopped(refused);
    // THE SERVICE'S CURRENT FIELDS: the fee of this run is paid, nothing is sent
    // to the service, and the next call starts a new run.
    const fields = serviceFields(spec);
    const reason = `The input does not fit the service now behind ${operation.label}: ${String(refused.envelope['reason'] ?? '').replace(/^The input does not fit [^:]*: /, '')}`;
    const result = fail('needs_input', reason, {
      nextStep: `Fill the fields below and call request({operation: ${JSON.stringify(operation.id)}, input: {...}}) again. Nothing was paid to a service, and a new call pays the Tenjin fee again.`,
    });
    return stopped({
      ...result,
      summary: `${result.summary}\n\nInput fields:\n${fields.join('\n')}`,
      envelope: { ...result.envelope, input: fields },
    });
  }
  // ONE PAYMENT PER ATTEMPT, claimed before anything is signed.
  const earlier = await claimSpecPayment(deps.ctx.dataDir, at.claim);
  if (earlier !== null) {
    await footer.done('needs_input');
    return stopped(
      fail(
        'needs_input',
        earlier.state === 'paid'
          ? `This run's service payment was already made at ${earlier.at}, so nothing was paid this time.`
          : 'A service payment under this run may already have left, so nothing was paid this time. Check `tenjin payments` before running it again.',
        {
          nextStep: 'For another run, call request({operation, input}) again; this run pays once.',
        },
      ),
    );
  }
  const take =
    at.attemptNumber !== undefined
      ? { n: at.attemptNumber, claim: at.claim, report: true }
      : undefined;
  const paid = await paySpec(prepared.prepared, { slot: at.slot }, deps, footer, reportDeps, take);
  const money = { amountAtomic: paid.left.amountAtomic, signed: paid.left.signed };
  const tx = paid.left.txHash !== undefined ? { txHash: paid.left.txHash } : {};
  const result = paid.result;
  const said = String(result.envelope['status']);
  // A PAYMENT THAT MAY HAVE LEFT AND NO RESULT: the claim stays possibly paid,
  // and this machine pays this run's service no more on its own word.
  if (result.isError && money.signed && said === 'failed') {
    return { ...none, maybePaid: true, paidAtomic: money.amountAtomic, ...tx, result };
  }
  // A STOP BEFORE ANYTHING WAS SIGNED (a price over the cap, a refusal, a rule):
  // no body to hand back, and nothing paid to a service.
  if (said !== 'fulfilled' && said !== 'unverified' && said !== 'running') {
    const state = money.amountAtomic > 0n ? ('paid' as const) : ('not_paid' as const);
    const shown = scrubbed(result, spec);
    return {
      ...none,
      paidAtomic: money.amountAtomic,
      ...tx,
      result: {
        ...shown,
        envelope: {
          ...shown.envelope,
          operation: operation.id,
          run: answer.run,
          service: label,
          receipt: receiptOf(at.feePaid, spec.payTo, {
            state,
            amountAtomic: money.amountAtomic,
            ...tx,
          }),
          cost: costOf(at.feePaid, money.amountAtomic, false),
        },
      },
    };
  }
  // THE SERVICE'S OWN RESULT, cut to the fields its spec promises as on main,
  // with the receipt of both payments beside it. A running job keeps its id.
  const shown = scrubbed(result, spec);
  const line = `${label} · Tenjin fee ${usd(at.feePaid)} · service ${usd(money.amountAtomic)}`;
  return {
    ...none,
    delivered: said !== 'running',
    paidAtomic: money.amountAtomic,
    ...tx,
    result: {
      ...shown,
      summary:
        said === 'running'
          ? shown.summary
          : `${said === 'unverified' ? 'Unverified result from' : 'Fulfilled by'} ${line}`,
      envelope: {
        ...shown.envelope,
        operation: operation.id,
        run: answer.run,
        service: label,
        receipt: receiptOf(at.feePaid, spec.payTo, {
          state: 'paid',
          amountAtomic: money.amountAtomic,
          ...tx,
        }),
        cost: costOf(at.feePaid, money.amountAtomic, false),
      },
    },
  };
}

/**
 * A PROVIDER PAYMENT THAT MAY HAVE LEFT: the receipt with both payments, a
 * stop, and where the host asks the person, one quote for a new attempt under
 * the same run. Nothing is signed on this machine's own word.
 */
async function maybePaidResult(
  attempt: Attempt,
  answer: RunDecision,
  operation: Operation,
  input: Record<string, unknown>,
  deps: RequestToolDeps,
  max: bigint,
): Promise<RequestToolResult> {
  const kept = await readRun(deps.ctx.dataDir, answer.run);
  const feePaid = kept !== null ? BigInt(kept.feeAtomic) : 0n;
  const label = answer.spec.label ?? operation.label;
  const receipt = receiptOf(feePaid, attempt.payTo, {
    state: 'possibly_paid',
    amountAtomic: attempt.paidAtomic,
    ...(attempt.txHash !== undefined ? { txHash: attempt.txHash } : {}),
  });
  const shown = scrubbed(attempt.result, answer.spec);
  const headline = `A service payment for ${operation.label} may have left, and no result came back, so nothing more was paid.`;
  let quote: Record<string, unknown> | undefined;
  let nextStep =
    'Tell the user. Check `tenjin payments` before running this again. A new run pays the Tenjin fee again.';
  if (deps.approves === true) {
    try {
      const made = await createQuote(
        deps.ctx.dataDir,
        {
          what: `a second attempt at ${operation.label}`,
          sentence: `A second attempt at ${operation.label} under this run costs up to ${usd(max)} more, and pays no second Tenjin fee. The first attempt may already have been paid.`,
          payments: [{ amountAtomic: max, creator: new URL(answer.spec.request.url).host }],
          call: {
            kind: 'operation_retry',
            run: answer.run,
            operation: operation.id,
            label: operation.label,
            input,
          },
        },
        deps.now,
      );
      quote = quoteView(made);
      nextStep = `Tell the user. Only if they want a second attempt: ${approveStep(made)}`;
    } catch {
      // No quote could be kept: the person is told, and nothing is paid.
    }
  }
  return {
    isError: true,
    summary: `${headline} Receipt: Tenjin fee ${usd(feePaid)} paid, service payment possibly sent (${label}).`,
    envelope: {
      ...shown.envelope,
      status: 'failed',
      reason: scrub(`${headline} ${String(shown.envelope['reason'] ?? '')}`.trim(), answer.spec),
      operation: operation.id,
      run: answer.run,
      service: label,
      possiblyPaid: true,
      receipt,
      cost: costOf(feePaid, attempt.paidAtomic, true),
      ...(quote !== undefined ? { quote } : {}),
      nextStep,
    },
  };
}

/**
 * THE QUOTE A PERSON SAID YES TO, run: a run of a operation whose plan was over the
 * automatic limits. Its slots are the quote's: the fee's, then the provider's.
 */
export async function runOperationQuoted(
  call: {
    operation: string;
    label: string;
    input: Record<string, unknown>;
    offer?: string;
    choice?: string;
    listing?: OperationRow;
  },
  slots: PlanSlot[],
  deps: RequestToolDeps,
  env: OperationEnv,
  footer: LookupFooter,
): Promise<RequestToolResult> {
  return runOperation(
    {
      operation: call.operation,
      input: call.input,
      ...(call.offer !== undefined ? { offer: call.offer } : {}),
      ...(call.choice !== undefined ? { choice: call.choice } : {}),
      ...(call.listing !== undefined ? { listing: call.listing } : {}),
    },
    deps,
    env,
    footer,
    slots,
    call.listing !== undefined ? (bazaarOperation(call.listing) ?? undefined) : undefined,
  );
}

/**
 * ONE NEW ATTEMPT AT THE PROVIDER UNDER A RUN ALREADY PAID FOR, after a lost
 * reply and a person's yes. It runs from the stored run answer, pays no second
 * Tenjin fee, and holds its payment under a claim key of its own. A run past
 * its 15 minutes is not run again: a new run pays the fee again.
 */
export async function retryOperation(
  call: { run: string; operation: string; label: string; input: Record<string, unknown> },
  slots: PlanSlot[],
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: ReportDeps,
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const kept = await readRun(dataDir, call.run);
  const now = (deps.now ?? Date.now)();
  if (kept === null || kept.closedAt !== undefined || Date.parse(kept.answer.expiresAt) <= now) {
    await footer.done('needs_input');
    return fail(
      'needs_input',
      `This run of ${call.label} is no longer kept or has expired, so nothing was paid.`,
      {
        nextStep:
          'Call request({operation, input}) again for a new run, which pays the Tenjin fee again.',
      },
    );
  }
  const slot = slots[0];
  if (slot === undefined) {
    await footer.done('failed');
    return fail('failed', 'The quote holds no service payment, so nothing was paid.');
  }
  const settings = await resolveContextSettings(deps.ctx);
  void settings;
  const read = await readOperationKept(dataDir, call.operation);
  const operation: Operation =
    read?.operation ??
    ({
      id: call.operation,
      label: call.label,
      does: call.label,
      input: {},
      price: { expectedAtomic: '0', maxAtomic: '0', feeAtomic: '0' },
      free: false,
      kind: 'operation',
    } satisfies Operation);
  const attemptNumber = kept.attempts + 1;
  await storeRun(dataDir, { ...kept, attempts: attemptNumber });
  const attempt = await attemptService(
    {
      answer: kept.answer,
      operation,
      input: call.input,
      slot,
      claim: `${call.run}:${attemptNumber}`,
      feePaid: BigInt(kept.feeAtomic),
      ...(kept.settingsHash !== undefined ? { settingsHash: kept.settingsHash } : {}),
      attemptNumber,
    },
    deps,
    footer,
    reportDeps,
  );
  if (attempt.maybePaid) {
    // A second lost reply: shown, with no further quote. A person who wants
    // another starts a new run.
    const shown = await maybePaidResult(
      attempt,
      kept.answer,
      operation,
      call.input,
      { ...deps, approves: false },
      0n,
    );
    return shown;
  }
  if (attempt.delivered) await closeRun(dataDir, call.run);
  return attempt.result;
}

/** The members of a set, with their own quoted numbers. */
interface Member {
  key?: string;
  operation: Operation;
}

/**
 * A SET OF RUNS: every option of a compare group (`choice: "all"`), or takes of
 * one operation (`count`). One quote holds the sum of the Tenjin fees and each
 * provider's allowed maximum, and meets the limits as one plan. The router
 * serves one answer with a call per member and the sum of their fees; each
 * member is held to one provider payment under a claim of its own, with its
 * own slot. A member that fails does not stop the others, and the receipt
 * lists every payment.
 */
export async function runOperationSet(
  call: {
    operation: string;
    label: string;
    input: Record<string, unknown>;
    offer?: string;
    count?: number;
    options?: { key: string; operation: string }[];
  },
  deps: RequestToolDeps,
  env: OperationEnv,
  footer: LookupFooter,
  approved?: PlanSlot[],
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const settings = await resolveContextSettings(deps.ctx);
  const members: Member[] = [];
  const wanted =
    call.options !== undefined
      ? call.options
      : Array.from({ length: call.count ?? 0 }, () => ({
          key: undefined,
          operation: call.operation,
        }));
  for (const option of wanted) {
    const read = await readOperation(option.operation, deps, env, settings);
    if ('legacy' in read || 'refused' in read) {
      await footer.done('failed');
      return 'refused' in read
        ? read.refused
        : fail('failed', 'This router does not run operations, so nothing was sent or paid.');
    }
    if (read.operation.free) {
      await footer.done('needs_input');
      return fail(
        'needs_input',
        `${read.operation.label} is a free tool, which this form does not run.`,
      );
    }
    const problems = inputProblems(read.operation.input, call.input);
    if (problems === undefined || problems.length > 0) {
      await footer.done('needs_input');
      return fail(
        'needs_input',
        `The input does not fit ${read.operation.label}: ${(problems ?? ['its schema cannot be checked']).join('; ')}.`,
        { nextStep: 'Fix the input and call again; nothing was sent or paid.' },
      );
    }
    members.push({
      ...(option.key !== undefined ? { key: option.key } : {}),
      operation: read.operation,
    });
  }
  const fees = members.map(({ operation }) => BigInt(operation.price.feeAtomic));
  const maxes = members.map(({ operation }) => BigInt(operation.price.maxAtomic));
  const expected = members.reduce(
    (sum, { operation }) => sum + BigInt(operation.price.expectedAtomic),
    0n,
  );
  const feeTotal = fees.reduce((sum, fee) => sum + fee, 0n);
  const serviceCap = maxes.reduce((most, max) => (max > most ? max : most), 0n);
  const label =
    call.options !== undefined
      ? `${members.length} choices of ${call.label}`
      : `${members.length} takes of ${call.label}`;
  let slots: PlanSlot[];
  if (approved !== undefined) {
    slots = approved;
  } else {
    const creator = new URL(settings.baseUrl).host;
    const payments = [
      { amountAtomic: feeTotal, creator },
      ...maxes.map((amountAtomic) => ({ amountAtomic, creator })),
    ];
    const admission = await admitPlan(payments, {
      dataDir,
      policy: settings.policy,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    if (!('admitted' in admission)) {
      const stop = await planStop(
        admission,
        {
          what: label,
          sentence: `${label} cost about ${usd(feeTotal + expected)} in all (${usd(expected)} for the services and ${usd(feeTotal)} for Tenjin's routing fees), and at most ${usd(feeTotal + maxes.reduce((a, b) => a + b, 0n))}.`,
          payments,
          call: {
            kind: 'operation_set',
            operation: call.operation,
            label: call.label,
            input: call.input,
            ...(call.offer !== undefined ? { offer: call.offer } : {}),
            ...(call.count !== undefined ? { count: call.count } : {}),
            ...(call.options !== undefined ? { options: call.options } : {}),
          },
        },
        deps,
      );
      await footer.done(stop.status);
      return fail(stop.status, stop.reason, stop.extras);
    }
    slots = admission.admitted;
  }
  if (slots.length !== members.length + 1) {
    await footer.done('failed');
    return fail('failed', 'The quote holds the wrong number of payments, so nothing was paid.');
  }
  const decisionDeps = await decisionDepsOf(deps, env, settings);
  const reportDeps: ReportDeps = {
    ctx: deps.ctx,
    baseUrl: settings.baseUrl,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.harness !== undefined ? { harness: deps.harness } : {}),
  };
  const run = randomUUID();
  const route = deps.route?.(settings.baseUrl, feeTotal);
  const asked = await requestRunOnce(
    {
      operation: call.operation,
      run,
      caps: { fee: feeTotal, service: serviceCap },
      ...(call.offer !== undefined ? { offer: call.offer } : {}),
      ...(call.options !== undefined ? { choice: 'all' } : { count: call.count! }),
    },
    { ...decisionDeps, ...(route !== undefined ? { route } : {}) },
  );
  if (asked.status === 'skipped') {
    await footer.done('native');
    const lasting = unpaidSentence(asked.why, 'agent', asked.quotedAtomic);
    return fail(
      'native',
      `${lasting ?? 'Tenjin could not pay the routing fee in time for this set of runs.'} Nothing was routed and no service was paid.`,
      {
        nextStep:
          lasting !== null
            ? 'Tell the user this once, and use your own tools for now.'
            : 'Use your own tools for this one.',
      },
    );
  }
  if (asked.status === 'failed') {
    await footer.done('failed');
    return fail('failed', asked.reason, {
      ...(asked.errorCode !== undefined ? { errorCode: asked.errorCode } : {}),
    });
  }
  const served = asked.decision.decision;
  const settingsHash = asked.decision.settingsHash;
  if (served.action === 'native' || served.action === 'needs_input') {
    await footer.done(served.action);
    return fail(served.action, served.reason ?? 'The router did not run this operation.', {
      diagnostics: served.diagnostics,
    });
  }
  if (served.action === 'no_run') {
    await footer.done('native');
    return noRun(served.code, served.reason, call.label);
  }
  if (served.action !== 'run_set' || served.run !== run || served.calls.length > members.length) {
    await footer.done('failed');
    return fail(
      'failed',
      'The router answered something other than the set asked for, so nothing was paid to a service.',
    );
  }
  const feePaid =
    BigInt(served.routingFeeAtomic) === 0n && asked.resent === true
      ? feeTotal
      : BigInt(served.routingFeeAtomic);
  const results: { key?: string; label: string; result: RequestToolResult; maybePaid: boolean }[] =
    [];
  for (const [index, member] of served.calls.entries()) {
    const slot = slots[index + 1]!;
    const tried = members[index]!;
    const one: RunDecision = {
      action: 'run',
      run,
      operation: call.operation,
      expiresAt: served.expiresAt,
      routingFeeAtomic: '0',
      spec: member.spec,
    };
    const attempt = await attemptService(
      {
        answer: one,
        operation: tried.operation,
        input: call.input,
        slot,
        claim: `${run}~${index}`,
        feePaid: 0n,
        attemptNumber: index + 1,
        ...(settingsHash !== undefined ? { settingsHash } : {}),
      },
      deps,
      footer,
      reportDeps,
    );
    results.push({
      ...(member.key !== undefined ? { key: member.key } : {}),
      label: member.label,
      result: attempt.result,
      maybePaid: attempt.maybePaid,
    });
  }
  const said = (result: RequestToolResult) => String(result.envelope['status']);
  const done = results.filter(({ result }) => said(result) === 'fulfilled').length;
  const running = results.filter(({ result }) => said(result) === 'running').length;
  const maybe = results.some(({ maybePaid }) => maybePaid);
  const payments = results.map(({ result }) => {
    const receipt = result.envelope['receipt'] as { service?: unknown } | undefined;
    return receipt?.service ?? null;
  });
  const status =
    done === results.length
      ? 'fulfilled'
      : running > 0
        ? 'running'
        : done > 0
          ? 'partial'
          : 'failed';
  const lines = results.map(({ label: name, result }) => `${name}: ${said(result)}`);
  await footer.done(status === 'fulfilled' ? 'fulfilled' : 'failed');
  // A MEMBER KEEPS EVERYTHING A SINGLE RUN WOULD HAND BACK: its output or
  // result, its saved files, its job and next step, its reason. Only what the
  // set says once (the receipt's fee, the cost) is left to the set.
  const SET_ONLY = new Set(['status', 'operation', 'run', 'service', 'receipt', 'cost']);
  return {
    isError: status === 'failed',
    summary: `${done} of ${results.length} runs fulfilled${running > 0 ? `, ${running} still running` : ''}, Tenjin fees ${usd(feePaid)} in all.\n${lines.join('\n')}`,
    envelope: {
      status,
      operation: call.operation,
      run,
      receipt: {
        routingFee: { amount: usd(feePaid), payee: 'Tenjin', paid: feePaid > 0n },
        services: payments,
      },
      results: results.map(({ key, label: name, result, maybePaid }, index) => ({
        ...(key !== undefined ? { key } : {}),
        service: name,
        status: result.envelope['status'],
        ...Object.fromEntries(
          Object.entries(result.envelope).filter(
            ([field]) => !SET_ONLY.has(field) && field !== 'providerContentUntrusted',
          ),
        ),
        ...(maybePaid ? { possiblyPaid: true } : {}),
        payment: payments[index],
      })),
      ...(maybe
        ? {
            possiblyPaid: true,
            nextStep:
              'A service payment may have left and no result came back. Tell the user, and check `tenjin payments` before running this again.',
          }
        : running > 0
          ? {
              nextStep:
                'A member is still running: call request({job}) with its job id for its result. Nothing more is paid.',
            }
          : {}),
      cost: [`routing fees ${toMoney(feePaid.toString()).usd} USD`],
      providerContentUntrusted: true,
    },
  };
}

/** The quote a person said yes to for a set, run: its slots are the quote's,
 *  the fees' sum first, then each member's provider. */
export async function runOperationSetQuoted(
  call: {
    operation: string;
    label: string;
    input: Record<string, unknown>;
    offer?: string;
    count?: number;
    options?: { key: string; operation: string }[];
  },
  slots: PlanSlot[],
  deps: RequestToolDeps,
  env: OperationEnv,
  footer: LookupFooter,
): Promise<RequestToolResult> {
  return runOperationSet(call, deps, env, footer, slots);
}
