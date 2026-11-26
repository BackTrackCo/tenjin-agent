import { randomUUID } from 'node:crypto';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { mask } from '../lib/redact';
import { canonicalHash, inputProblems, validateResultBody } from '../lib/request-schema';
import { resolveContextSettings, type ResolvedSettings } from '../lib/settings';
import { admitPlan, type PlanSlot } from '../lib/spend-plan';
import { createQuote } from '../lib/spend-quotes';
import {
  DEADLINE_AFTER_PAYMENT_SENT,
  MAX_INPUT_BYTES,
  unmetRequires,
  type DecisionDeps,
  type TaskRow,
  type SpecOutcome,
  type ToolSpec,
} from './decision';
import { unpaidSentence } from './fee';
import type { TaskOffer } from './decision';
import { convertWith, expressionProblem } from './jmespath';
import { maskDeep } from './paid';
import { approveStep, planStop, quoteView, type PlanWords } from './plan';
import type { LookupFooter } from './progress';
import { inputLines } from './spec-call';
import {
  claimSpecPayment,
  peekSpecPayment,
  readKeptSpec,
  storeFullResult,
  type KeptSpec,
} from './specs';
import type { WireSettings } from './settings-wire';
import { requestRunOnce, requestTaskRead } from './task-request';
import {
  readRun,
  readRunKey,
  readTaskKept,
  readTaskOffer,
  storeRun,
  storeRunKey,
  storeTaskRead,
} from './task-store';
import type { Convert, RunDecision, Task } from './task-wire';
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
 * A ROUTED TASK CALL, FROM THE READ TO THE RECEIPT. `request({task})` reads a
 * task for free. `request({task, input})` (and `request({id, input})` on an
 * offer) runs it:
 *
 * 1. THE INPUT IS CHECKED against the task's own schema before any run is
 *    asked for. A wrong one sends nothing, and pays nothing.
 * 2. ONE QUOTE, BEFORE EITHER PAYMENT. The plan holds the Tenjin fee and the
 *    provider's allowed maximum, which meet `maxAutoSpend` and the daily budget
 *    together once. Over them, nothing is sent: the plan is kept as a quote
 *    for the person's yes (`approve`). The person is shown one estimated total
 *    and one maximum.
 * 3. THE RUN. The paid route is asked for the run with the run id this client
 *    picked and the amounts it approved; the payer pays the fee its 402
 *    quotes, never more than the approved fee. The answer is the only place
 *    the provider's request, URL and payee reach this machine, and it is kept
 *    under the run id.
 * 4. THE PROVIDER, ONCE. The task's input is converted to the provider's, the
 *    call is checked and paid like any spec's (`paySpec`) against the plan's
 *    provider slot, and the body is converted to the task's output and
 *    checked against its shape. Before anything is signed a provider that
 *    refuses, or whose live price is over the approved cap, gives way to the
 *    run's fallback, and with none the run stops with nothing paid to a
 *    provider. After one is signed, none is ever tried on this machine's own
 *    word: a reply lost after the signature leaves the claim possibly paid,
 *    and only a person's yes on `approve` starts one new attempt under the
 *    same run, with a new claim and no new fee ({@link retryTask}).
 * 5. THE RECEIPT shows the Tenjin fee and the provider's payment on separate
 *    lines. No result, summary or error names the provider's URL or host.
 *
 * Imported by `tool.ts` alone, so it stays in the request tool's chunk.
 */

/** What a task call needs of the request tool's own state. */
export interface TaskEnv {
  /** The user's rules as the wire carries them, or none. */
  sent: WireSettings | undefined;
  /** `router.improve`. */
  improve: boolean;
}

const usd = (atomic: bigint): string => `$${toMoney(atomic.toString()).usd}`;

/** The one task a call names: a compare key picks among a task's services. */
interface TaskCall {
  task: string;
  input: Record<string, unknown>;
  offer?: string;
  choice?: string;
  /** The offer is an open-Bazaar row's: no task schema to check the input against. */
  listing?: TaskRow;
}

/**
 * A ROUTER THAT PREDATES ROUTED TASKS does not know the task read: it answers
 * the unknown form with `validation_failed`. The call is then the old
 * `{tool}` read of the same id, which that router answers with a spec, and
 * the agent goes on with `{id, input}` as it always did.
 */
export const LEGACY_ROUTER = 'legacy_router';

/** The arguments of a call that is not a task call, so {@link runTaskForm}
 *  hands it back to the ordinary tool. */
const OTHER_FORMS = ['query', 'tool', 'browse', 'job', 'source'] as const;

/**
 * THE TASK FORMS OF `request`, or undefined when the call is none of them: a
 * `task`, or an `id` that names an offer of tasks this machine kept (and no
 * spec of its own). `{task}` reads, and `{task, input}` runs.
 */
export async function runTaskForm(
  args: RequestToolArgs,
  deps: RequestToolDeps,
  env: TaskEnv,
): Promise<RequestToolResult | undefined | typeof LEGACY_ROUTER> {
  const { dataDir } = deps.ctx;
  const offered = args.id !== undefined && args.id.length > 0 ? args.id : undefined;
  const keptOffer = offered !== undefined ? await readTaskOffer(dataDir, offered) : null;
  const options = keptOffer?.choices?.options;
  let task = args.task?.trim();
  const offer = keptOffer !== null ? offered : undefined;
  if (task === undefined) {
    // AN ID THAT NAMES AN OFFER OF TASKS runs its lead task, the option a
    // choice names, or every option for `all`.
    if (offered === undefined || args.query !== undefined || keptOffer === null) return undefined;
    if ((await readKeptSpec(dataDir, offered)) !== null) return undefined;
    if (args.choice === 'all') {
      if (options === undefined) return undefined;
      task = options[0]!.task;
    } else if (args.choice !== undefined) {
      const picked = options?.find(({ key }) => key === args.choice);
      if (picked === undefined) return undefined;
      task = picked.task;
    } else {
      task = keptOffer.tasks[0]!.task;
    }
  }
  if (task.length === 0 || task.length > 200) {
    return fail('needs_input', '`task` takes a task id from request({browse}) or an offer.');
  }
  const others = OTHER_FORMS.filter((key) => args[key] !== undefined);
  if (others.length > 0) {
    return fail(
      'needs_input',
      `\`task\` goes with \`input\` alone (and the id of its offer); ${others.join(', ')} was sent, so nothing was sent or paid.`,
      { nextStep: 'Call request({task, input}) with the task and its inputs.' },
    );
  }
  const { count } = args;
  if (count !== undefined && (!Number.isInteger(count) || count < 2 || count > 5)) {
    return fail('needs_input', 'count is a whole number of takes from 2 to 5; nothing was sent.');
  }
  if (count !== undefined && args.choice !== undefined) {
    return fail(
      'needs_input',
      'count runs several takes of one task, so it does not go with a choice; nothing was sent.',
    );
  }
  if (args.choice === 'all' && (options === undefined || offer === undefined)) {
    return fail(
      'needs_input',
      '`choice: "all"` runs every choice an offer lists, so it goes with that offer\'s id; nothing was sent.',
      { nextStep: 'Ask with request({query}) for an offer that lists choices.' },
    );
  }
  if (mask(task) !== task) {
    return fail('native', 'the task id carries a credential-shaped value, so nothing was sent');
  }
  // AN OPEN-BAZAAR LISTING has no task of its own: its row names the offer row
  // that holds it, and the run sends that back. Its price is the row's.
  const row = keptOffer?.tasks.find((r) => r.task === task && r.offer !== undefined);
  const bazaar =
    row !== undefined && row.offer !== undefined
      ? { offer: row.offer, task: bazaarTask(row) }
      : undefined;
  const settings = await resolveContextSettings(deps.ctx);
  let read: { task: Task } | { legacy: true } | { refused: RequestToolResult };
  if (bazaar !== undefined && bazaar.task !== null) read = { task: bazaar.task };
  else read = await readTask(task, deps, env, settings);
  if ('legacy' in read) return LEGACY_ROUTER;
  if ('refused' in read) return read.refused;
  if (args.input === undefined) return showTask(read.task);
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
    return runTaskSet(
      {
        task,
        label: read.task.label,
        input: args.input,
        ...(offer !== undefined ? { offer } : {}),
        ...(count !== undefined ? { count } : {}),
        ...(args.choice === 'all' && options !== undefined
          ? { options: options.map(({ key, task: t }) => ({ key, task: t })) }
          : {}),
      },
      deps,
      env,
      footer,
    );
  }
  return runTask(
    {
      task,
      input: args.input,
      ...(bazaar !== undefined && bazaar.task !== null
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
    read.task,
  );
}

/**
 * THE TASK AN OPEN-BAZAAR ROW STANDS FOR. A listing has no task read and no
 * input schema of its own: the router's row gives its price, and the listing's
 * own spec arrives with the run and checks the input before anything is paid.
 * The caps are the row's price with the router's usual 10% headroom, and the
 * routing fee is 15% of the price. Null when the price cannot be read.
 */
function bazaarTask(row: TaskRow): Task | null {
  let price: bigint;
  try {
    price = BigInt(parseUsdToAtomic(row.price.replace(/^\$/, '')));
  } catch {
    return null;
  }
  const max = price + (price + 9n) / 10n;
  const fee = (price * 15n + 99n) / 100n;
  return {
    id: row.task,
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
  env: TaskEnv,
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

/** The task as the router describes it, kept for 15 minutes, or the result to
 *  hand back. */
async function readTask(
  task: string,
  deps: RequestToolDeps,
  env: TaskEnv,
  settings: ResolvedSettings,
): Promise<{ task: Task } | { legacy: true } | { refused: RequestToolResult }> {
  const kept = await readTaskKept(deps.ctx.dataDir, task);
  if (kept !== null) return { task: kept.task };
  const read = await requestTaskRead(task, await decisionDepsOf(deps, env, settings));
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
    return { refused: fail('failed', 'The router could not be read for this task.') };
  }
  const answer = read.decision;
  if ('task' in answer) {
    await storeTaskRead(deps.ctx.dataDir, answer.task, answer.settingsHash);
    return { task: answer.task };
  }
  const decision = answer.decision;
  if (decision.action === 'native' || decision.action === 'needs_input') {
    return {
      refused: fail(decision.action, decision.reason ?? 'The router has no task by that id.', {
        diagnostics: decision.diagnostics,
        nextStep: 'See the tasks with request({browse: ""}).',
      }),
    };
  }
  return { refused: fail('failed', 'The router did not answer with a task.') };
}

/** `request({task})`: what the task takes, returns and costs. Free. */
function showTask(task: Task): RequestToolResult {
  const expected = BigInt(task.price.expectedAtomic);
  const fee = BigInt(task.price.feeAtomic);
  const max = BigInt(task.price.maxAtomic);
  const inputs = inputLines(task.input);
  const lines = [
    `${task.label}: ${task.does}`,
    task.free
      ? 'Price: free.'
      : `Price: about ${usd(expected + fee)} a run (${usd(expected)} for the provider and ${usd(fee)} for Tenjin's routing fee), at most ${usd(max + fee)}. Reading a task is free; nothing has been paid.`,
    inputs.length > 0 ? `Inputs:\n${inputs.join('\n')}` : 'Inputs: none.',
  ];
  if (task.example !== undefined) lines.push(`Example input: ${JSON.stringify(task.example)}`);
  if (task.output !== undefined) {
    const shape = JSON.stringify(task.output);
    lines.push(
      `Returns (JSON Schema): ${shape.length > 1_500 ? `${shape.slice(0, 1_499)}…` : shape}`,
    );
  }
  const call = `request({task: ${JSON.stringify(task.id)}, input: {...}})`;
  lines.push(`To run it, call ${call} with the inputs above. Nothing has been paid.`);
  return {
    isError: false,
    summary: lines.join('\n'),
    envelope: {
      status: 'task',
      task: task.id,
      label: task.label,
      does: task.does,
      input: task.input,
      ...(task.example !== undefined ? { example: task.example } : {}),
      ...(task.output !== undefined ? { output: task.output } : {}),
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

/** A free offer of tasks, shown: the router's line, and each task in a few words. */
export function showTaskOffer(offer: TaskOffer, note: string | undefined): RequestToolResult {
  const rows = offer.tasks.map((row) => ({
    task: row.task,
    label: row.label,
    does: row.does,
    price: row.price,
  }));
  const picks = offer.choices;
  const lines = [
    ...rows.map((row) => `${row.label} (task ${row.task}, ${row.price}): ${row.does}`),
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
      need: offer.need,
      tasks: rows,
      ...(picks !== undefined ? { choices: picks } : {}),
      nextStep: offer.hint,
      cost: costLines(0n),
      ...(note !== undefined ? { note } : {}),
      providerContentUntrusted: true,
    },
  };
}

/** What a plan of one run buys, in the words the person is asked about. */
function taskWords(label: string, fee: bigint, expected: bigint, max: bigint): PlanWords {
  return {
    what: `one run of ${label}`,
    sentence: `One run of ${label} costs about ${usd(fee + expected)} (${usd(expected)} for the provider and ${usd(fee)} for Tenjin's routing fee), and at most ${usd(fee + max)}.`,
  };
}

/** The bare host of a URL the input holds, for page routing; none otherwise. */
function hostOfInput(task: Task, input: Record<string, unknown>): string | undefined {
  const properties = task.input.properties;
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
 * ONE RUN OF A TASK. `approved` are the slots of a quote a person said yes to:
 * the fee's, then the provider's. Without them the plan is admitted here.
 */
export async function runTask(
  call: TaskCall,
  deps: RequestToolDeps,
  env: TaskEnv,
  footer: LookupFooter,
  approved?: PlanSlot[],
  known?: Task,
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const settings = await resolveContextSettings(deps.ctx);
  let task = known;
  if (task === undefined) {
    const read = await readTask(call.task, deps, env, settings);
    if ('refused' in read || 'legacy' in read) {
      await footer.done('failed');
      return 'refused' in read
        ? read.refused
        : fail('failed', 'This router does not run tasks, so nothing was sent or paid.', {
            nextStep: 'Call request({query}) for an offer, or use your own tools.',
          });
    }
    task = read.task;
  }
  if (task.free) {
    await footer.done('needs_input');
    return fail('needs_input', `${task.label} is a free tool, which this form does not run.`, {
      nextStep: 'Call request({tool, query}) for a free tool; nothing was sent or paid.',
    });
  }
  // A WRONG INPUT COSTS ONE MORE CALL, NOT A RUN: every problem, then the task's
  // inputs, with nothing sent to the router's paid route or paid.
  const problems = call.listing !== undefined ? [] : inputProblems(task.input, call.input);
  if (problems === undefined) {
    await footer.done('failed');
    return fail(
      'failed',
      `The input schema of ${task.label} cannot be checked by this build, so the task was not run and nothing was paid.`,
      { nextStep: 'Continue with your own tools. Nothing was sent or paid.' },
    );
  }
  if (problems.length > 0) {
    await footer.done('needs_input');
    const refused = fail(
      'needs_input',
      `The input does not fit ${task.label}: ${problems.join('; ')}.`,
      {
        nextStep: `Fix the input and call request({task: ${JSON.stringify(task.id)}, input: {...}}) again; nothing was sent or paid.`,
        parameters: maskDeep(call.input),
      },
    );
    return {
      ...refused,
      summary: `${refused.summary}\n\nInputs:\n${inputLines(task.input).join('\n')}`,
    };
  }
  const expected = BigInt(task.price.expectedAtomic);
  const fee = BigInt(task.price.feeAtomic);
  const max = BigInt(task.price.maxAtomic);
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
          ...taskWords(task.label, fee, expected, max),
          payments,
          call: {
            kind: 'task',
            task: task.id,
            label: task.label,
            input: call.input,
            ...(call.offer !== undefined ? { offer: call.offer } : {}),
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
  const sellerSlot = slots[1];
  if (sellerSlot === undefined) {
    await footer.done('failed');
    return fail('failed', 'The quote for this run holds no provider payment, so nothing was paid.');
  }
  const decisionDeps = await decisionDepsOf(deps, env, settings);
  const reportDeps: ReportDeps = {
    ctx: deps.ctx,
    baseUrl: settings.baseUrl,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.harness !== undefined ? { harness: deps.harness } : {}),
  };

  // THE RUN, from this machine's own copy when the same call was already
  // served a run within its 15 minutes and nothing was paid to a provider under
  // it: that run pays no second fee. Else asked for, under a run id picked here.
  const runKey = canonicalHash({ task: call.task, input: call.input, choice: call.choice ?? null });
  const now = (deps.now ?? Date.now)();
  let answer: RunDecision | undefined;
  let feePaid: bigint;
  let settingsHash: string | undefined;
  const earlierId = await readRunKey(dataDir, runKey);
  const earlier = earlierId !== null ? await readRun(dataDir, earlierId) : null;
  if (
    earlier !== null &&
    Date.parse(earlier.answer.expiresAt) > now &&
    (await peekSpecPayment(dataDir, earlier.answer.run)) === null
  ) {
    answer = earlier.answer;
    feePaid = BigInt(earlier.feeAtomic);
    settingsHash = earlier.settingsHash;
  } else {
    const run = randomUUID();
    const host = hostOfInput(task, call.input);
    const route = deps.route?.(settings.baseUrl, fee);
    const asked = await requestRunOnce(
      {
        task: call.task,
        run,
        caps: { fee, seller: max },
        ...(call.offer !== undefined ? { offer: call.offer } : {}),
        ...(host !== undefined ? { host } : {}),
        ...(call.choice !== undefined ? { choice: call.choice } : {}),
      },
      { ...decisionDeps, ...(route !== undefined ? { route } : {}) },
    );
    if (asked.status === 'skipped') {
      await footer.done('native');
      // A reason that lasts (money, the wallet, a limit, the fee's price) is
      // the user's to hear once; a busy channel, a slow unlock or a top-up
      // still on its way is not.
      const lasting = unpaidSentence(asked.why, 'agent', asked.quotedAtomic);
      return fail(
        'native',
        asked.why === DEADLINE_AFTER_PAYMENT_SENT
          ? 'A routing payment went out, and this call ran out of time before its answer. `tenjin mcp` lets it finish so it is recorded; no provider was paid.'
          : `${lasting ?? 'Tenjin could not pay the routing fee in time for this run (another routing payment was in progress, the wallet was still unlocking, or its balance could not be read); the next call usually works.'} Nothing was routed and no provider was paid.`,
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
    settingsHash = asked.decision.settingsHash;
    if (served.action === 'native' || served.action === 'needs_input') {
      await footer.done(served.action);
      return fail(served.action, served.reason ?? 'The router did not run this task.', {
        diagnostics: served.diagnostics,
        ...(asked.decision.note !== undefined ? { note: asked.decision.note } : {}),
      });
    }
    if (served.action === 'no_run') {
      await footer.done('native');
      return noRun(served.code, served.reason, task.label);
    }
    if (served.action === 'run_set') {
      await footer.done('failed');
      return fail(
        'failed',
        'The router answered a set of runs for one run, so nothing was paid to a provider.',
      );
    }
    if (served.run !== run || served.task !== call.task) {
      await footer.done('failed');
      return fail(
        'failed',
        'The router answered a different run than the one asked for, so nothing was paid to a provider.',
      );
    }
    answer = served;
    // A re-sent run is served at $0: its fee was paid on the first request,
    // whose answer was lost.
    feePaid =
      BigInt(served.routingFeeAtomic) === 0n && asked.resent
        ? fee
        : BigInt(served.routingFeeAtomic);
    await storeRun(dataDir, {
      answer: served,
      ...(settingsHash !== undefined ? { settingsHash } : {}),
      feeAtomic: feePaid.toString(),
      attempts: 1,
    });
    await storeRunKey(dataDir, runKey, served.run);
  }
  const attempt = await attemptSellers(
    {
      answer,
      task,
      input: call.input,
      slot: sellerSlot,
      claim: answer.run,
      feePaid,
      ...(settingsHash !== undefined ? { settingsHash } : {}),
    },
    deps,
    footer,
    reportDeps,
  );
  if (attempt.maybePaid) {
    return maybePaidResult(attempt, answer, task, call.input, deps, max);
  }
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
      step: 'That task allows fewer takes at once. Call again with a smaller count.',
    },
    offer_expired: {
      status: 'needs_input',
      step: 'The offer is gone. Ask again with request({query}) for a fresh one.',
    },
    unknown_task: {
      status: 'needs_input',
      step: 'See the tasks with request({browse: ""}) and call one of them.',
    },
    no_seller: {
      status: 'native',
      step: 'No provider can run it under your settings right now. Use your own tools for now.',
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

/** The reasons a provider attempt ends before anything is signed, after which
 *  the run's fallback is tried. Not a wallet or a policy stop: those bind the
 *  fallback too. */
const GIVES_WAY: ReadonlySet<string> = new Set(['input', 'terms', 'provider', 'unreachable']);

interface AttemptInput {
  answer: RunDecision;
  task: Task;
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
  /** The provider's payee address, for the receipt. */
  payTo: string;
  /** What left for the provider, when known. */
  paidAtomic: bigint;
  txHash?: string;
}

/** The text with the provider's URL, host and name taken out. */
function scrub(text: string, spec: ToolSpec): string {
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
    out = out.split(name).join('the provider');
  }
  return out;
}

/** A result with every place the provider could be named taken out. */
function scrubbed(result: RequestToolResult, spec: ToolSpec): RequestToolResult {
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
  seller: { state: 'paid' | 'possibly_paid' | 'not_paid'; amountAtomic: bigint; txHash?: string },
): Record<string, unknown> {
  return {
    routingFee: { amount: usd(feePaid), payee: 'Tenjin', paid: feePaid > 0n },
    provider: {
      state: seller.state,
      ...(seller.state === 'paid' ? { amount: usd(seller.amountAtomic) } : {}),
      payee: payTo,
      ...(seller.txHash !== undefined ? { txHash: seller.txHash } : {}),
    },
  };
}

/** Both payments as the cost lines of a result. */
function costOf(feePaid: bigint, sellerAtomic: bigint, possibly: boolean): string[] {
  return [
    `routing fee ${toMoney(feePaid.toString()).usd} USD`,
    possibly
      ? "provider payment possibly sent (up to the run's approved maximum)"
      : `provider price ${toMoney(sellerAtomic.toString()).usd} USD`,
  ];
}

/**
 * THE PROVIDER, ONCE: the lead, and before anything is signed the fallback.
 * Each attempt converts the task's input, checks and claims the call, and pays
 * it against the plan's provider slot. The slot stays unspent until a payment
 * is signed, so a provider that gave way costs the next one nothing.
 */
async function attemptSellers(
  at: AttemptInput,
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: ReportDeps,
): Promise<Attempt> {
  const { answer } = at;
  const sellers: { spec: ToolSpec; convert: Convert | undefined }[] = [
    { spec: answer.spec, convert: answer.convert },
    ...(answer.fallback !== undefined
      ? [{ spec: answer.fallback.spec, convert: answer.fallback.convert }]
      : []),
  ];
  let last: Attempt | undefined;
  for (const seller of sellers) {
    const tried = await attemptOne(at, seller, deps, footer, reportDeps);
    last = tried.attempt;
    if (!tried.gaveWay) return tried.attempt;
  }
  // Every provider gave way before anything was signed: the run stays good for
  // its 15 minutes, with no second fee for a repeat of the same call.
  return last!;
}

async function attemptOne(
  at: AttemptInput,
  seller: { spec: ToolSpec; convert: Convert | undefined },
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: ReportDeps,
): Promise<{ attempt: Attempt; gaveWay: boolean }> {
  const { answer, task } = at;
  const { spec } = seller;
  const label = spec.label ?? task.label;
  const stopped = (reason: string): { attempt: Attempt; gaveWay: true } => ({
    gaveWay: true,
    attempt: {
      maybePaid: false,
      payTo: spec.payTo,
      paidAtomic: 0n,
      result: scrubbed(
        fail('failed', scrub(reason, spec), {
          nextStep:
            'Nothing was paid to a provider. The routing fee for this run is paid, and the same call repeated within 15 minutes pays no second fee; or use your own tools.',
        }),
        spec,
      ),
    },
  });
  const missing = unmetRequires(spec.requires);
  if (missing.length > 0) {
    return stopped(`${label} needs ${missing.join(', ')}, which this build lacks.`);
  }
  // THE CONVERSION IS RUN, AND ITS PROBLEMS FOUND, before anything is claimed.
  let sellerInput: Record<string, unknown> = at.input;
  if (seller.convert !== undefined) {
    const problem = expressionProblem(seller.convert.input);
    if (problem !== undefined) return stopped(`the input conversion ${problem}`);
    try {
      const converted = convertWith(seller.convert.input, at.input);
      if (converted === null || typeof converted !== 'object' || Array.isArray(converted)) {
        return stopped('the input conversion does not give an object');
      }
      sellerInput = converted as Record<string, unknown>;
    } catch (err) {
      return stopped(`the input conversion failed: ${err instanceof Error ? err.message : err}`);
    }
    const outProblem = expressionProblem(seller.convert.output);
    if (outProblem !== undefined) return stopped(`the output conversion ${outProblem}`);
  }
  // A converted run is checked against the whole body, never a cut of it: the
  // spec's field list would drop what the conversion reads.
  const whole: ToolSpec = { ...spec };
  if (seller.convert !== undefined) delete whole.outputSchema;
  const kept: KeptSpec = {
    ...whole,
    id: answer.run,
    ...(at.settingsHash !== undefined ? { settingsHash: at.settingsHash } : {}),
  };
  const prepared = await prepareSpec(answer.run, kept, sellerInput, footer, reportDeps);
  if ('refused' in prepared) {
    const said = prepared.refused.envelope['reason'];
    return stopped(typeof said === 'string' ? said : `${label} would not take this input.`);
  }
  // ONE PAYMENT PER RUN ATTEMPT, claimed before anything is signed.
  const earlier = await claimSpecPayment(deps.ctx.dataDir, at.claim);
  if (earlier !== null) {
    await footer.done('needs_input');
    return {
      gaveWay: false,
      attempt: {
        maybePaid: false,
        payTo: spec.payTo,
        paidAtomic: 0n,
        result: scrubbed(
          fail(
            'needs_input',
            earlier.state === 'paid'
              ? `This run's provider payment was already made at ${earlier.at}, so nothing was paid this time.`
              : 'A provider payment under this run may already have left, so nothing was paid this time. Check `tenjin payments` before running it again.',
            { nextStep: 'For another run, call request({task, input}) again; this run pays once.' },
          ),
          spec,
        ),
      },
    };
  }
  const take =
    at.attemptNumber !== undefined
      ? { n: at.attemptNumber, claim: at.claim, report: true }
      : undefined;
  const paid = await paySpec(prepared.prepared, { slot: at.slot }, deps, footer, reportDeps, take);
  const outcome: Omit<SpecOutcome, 'id' | 'ms'> | null = paid.outcome;
  const nothingSigned = !paid.left.signed && paid.left.amountAtomic === 0n;
  if (
    nothingSigned &&
    outcome !== null &&
    outcome.status === 'unpaid' &&
    outcome.reason !== undefined &&
    GIVES_WAY.has(outcome.reason)
  ) {
    const said = paid.result.envelope['reason'];
    return stopped(typeof said === 'string' ? said : `${label} could not be called.`);
  }
  const money = { amountAtomic: paid.left.amountAtomic, signed: paid.left.signed };
  return {
    gaveWay: false,
    attempt: await finish(at, seller, paid.result, money, paid.left.txHash, deps),
  };
}

/**
 * THE END OF AN ATTEMPT THAT DID NOT GIVE WAY: the paid result converted and
 * checked, or the failure said with what left.
 */
async function finish(
  at: AttemptInput,
  seller: { spec: ToolSpec; convert: Convert | undefined },
  result: RequestToolResult,
  money: { amountAtomic: bigint; signed: boolean },
  txHash: string | undefined,
  deps: RequestToolDeps,
): Promise<Attempt> {
  const { answer, task } = at;
  const { spec } = seller;
  const label = spec.label ?? task.label;
  const base = { payTo: spec.payTo, paidAtomic: money.amountAtomic };
  const tx = txHash !== undefined ? { txHash } : {};
  // A PAYMENT THAT MAY HAVE LEFT AND NO RESULT: the claim stays possibly paid,
  // and this machine pays this run's provider no more on its own word.
  if (result.isError && money.signed && result.envelope['status'] === 'failed') {
    return { ...base, maybePaid: true, ...tx, result };
  }
  const envelopeBase = {
    task: task.id,
    run: answer.run,
    service: label,
  };
  const said = result.envelope['status'];
  // ANYTHING THAT IS NOT A DELIVERY, a routine stop (`needs_approval`) included,
  // which carries no body to convert.
  if (said !== 'fulfilled' && said !== 'unverified') {
    // Nothing came back and nothing was signed (or a stop of another kind).
    const state = money.amountAtomic > 0n ? ('paid' as const) : ('not_paid' as const);
    const shown = scrubbed(result, spec);
    return {
      ...base,
      maybePaid: false,
      ...tx,
      result: {
        ...shown,
        envelope: {
          ...shown.envelope,
          ...envelopeBase,
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
  const bodyText =
    typeof result.envelope['result'] === 'string' ? (result.envelope['result'] as string) : '';
  const cost = costOf(at.feePaid, money.amountAtomic, false);
  const receipt = receiptOf(at.feePaid, spec.payTo, {
    state: 'paid',
    amountAtomic: money.amountAtomic,
    ...tx,
  });
  const summaryLine = `${label} · Tenjin fee ${usd(at.feePaid)} · provider ${usd(money.amountAtomic)}`;
  // A SERVICE WITH NO CONVERSION runs as it always did: its result, cut to the
  // fields its spec promises, with the receipt beside it.
  if (seller.convert === undefined) {
    const shown = scrubbed(result, spec);
    return {
      ...base,
      maybePaid: false,
      ...tx,
      result: {
        ...shown,
        summary: `${result.isError ? 'Unverified result from' : 'Fulfilled by'} ${summaryLine}`,
        envelope: { ...shown.envelope, ...envelopeBase, receipt, cost },
      },
    };
  }
  const key = at.attemptNumber !== undefined ? at.claim : answer.run;
  const fullResultPath =
    bodyText.length > 0 ? await storeFullResult(deps.ctx.dataDir, key, bodyText) : null;
  const pathField = fullResultPath !== null ? { fullResultPath } : {};
  const converted = convertBody(bodyText, seller.convert, answer.output);
  if (result.isError || !converted.ok) {
    const why = !converted.ok
      ? converted.problem
      : String(result.envelope['resultCaveat'] ?? 'the result missed its success rule');
    return {
      ...base,
      maybePaid: false,
      ...tx,
      result: {
        isError: true,
        summary: scrub(`Unverified result from ${summaryLine}`, spec),
        envelope: {
          status: 'unverified',
          ...envelopeBase,
          resultCaveat: scrub(
            `The provider was paid, and ${why}. No output was built from it.`,
            spec,
          ),
          ...pathField,
          receipt,
          cost,
          providerContentUntrusted: true,
        },
      },
    };
  }
  return {
    ...base,
    maybePaid: false,
    ...tx,
    result: {
      isError: false,
      summary: `Fulfilled by ${summaryLine}`,
      envelope: {
        status: 'fulfilled',
        ...envelopeBase,
        output: converted.output,
        ...pathField,
        receipt,
        cost,
        providerContentUntrusted: true,
      },
    },
  };
}

/** The seller's body as the task's output: a body that is not JSON is
 *  `{text}` first, then the output conversion, then the shape check. */
function convertBody(
  bodyText: string,
  convert: Convert,
  shape: Record<string, unknown> | undefined,
): { ok: true; output: unknown } | { ok: false; problem: string } {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { text: bodyText };
  }
  let output: unknown;
  try {
    output = convertWith(convert.output, body);
  } catch (err) {
    return {
      ok: false,
      problem: `the conversion to the task's output failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (shape !== undefined) {
    const check = validateResultBody(shape, JSON.stringify(output ?? null));
    if (!check.valid) {
      return { ok: false, problem: check.reason ?? "the result does not fit the task's output" };
    }
  }
  return { ok: true, output };
}

/**
 * A PROVIDER PAYMENT THAT MAY HAVE LEFT: the receipt with both payments, a
 * stop, and where the host asks the person, one quote for a new attempt under
 * the same run. Nothing is signed on this machine's own word.
 */
async function maybePaidResult(
  attempt: Attempt,
  answer: RunDecision,
  task: Task,
  input: Record<string, unknown>,
  deps: RequestToolDeps,
  max: bigint,
): Promise<RequestToolResult> {
  const kept = await readRun(deps.ctx.dataDir, answer.run);
  const feePaid = kept !== null ? BigInt(kept.feeAtomic) : 0n;
  const label = answer.spec.label ?? task.label;
  const receipt = receiptOf(feePaid, attempt.payTo, {
    state: 'possibly_paid',
    amountAtomic: attempt.paidAtomic,
    ...(attempt.txHash !== undefined ? { txHash: attempt.txHash } : {}),
  });
  const shown = scrubbed(attempt.result, answer.spec);
  const headline = `A provider payment for ${task.label} may have left, and no result came back, so nothing more was paid.`;
  let quote: Record<string, unknown> | undefined;
  let nextStep =
    'Tell the user. Check `tenjin payments` before running this again. A new run pays the Tenjin fee again.';
  if (deps.approves === true) {
    try {
      const made = await createQuote(
        deps.ctx.dataDir,
        {
          what: `a second attempt at ${task.label}`,
          sentence: `A second attempt at ${task.label} under this run costs up to ${usd(max)} more, and pays no second Tenjin fee. The first attempt may already have been paid.`,
          payments: [{ amountAtomic: max, creator: new URL(answer.spec.request.url).host }],
          call: {
            kind: 'task_retry',
            run: answer.run,
            task: task.id,
            label: task.label,
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
    summary: `${headline} Receipt: Tenjin fee ${usd(feePaid)} paid, provider payment possibly sent (${label}).`,
    envelope: {
      ...shown.envelope,
      status: 'failed',
      reason: scrub(`${headline} ${String(shown.envelope['reason'] ?? '')}`.trim(), answer.spec),
      task: task.id,
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
 * THE QUOTE A PERSON SAID YES TO, run: a run of a task whose plan was over the
 * automatic limits. Its slots are the quote's: the fee's, then the provider's.
 */
export async function runTaskQuoted(
  call: {
    task: string;
    label: string;
    input: Record<string, unknown>;
    offer?: string;
    listing?: TaskRow;
  },
  slots: PlanSlot[],
  deps: RequestToolDeps,
  env: TaskEnv,
  footer: LookupFooter,
): Promise<RequestToolResult> {
  return runTask(
    {
      task: call.task,
      input: call.input,
      ...(call.offer !== undefined ? { offer: call.offer } : {}),
      ...(call.listing !== undefined ? { listing: call.listing } : {}),
    },
    deps,
    env,
    footer,
    slots,
    call.listing !== undefined ? (bazaarTask(call.listing) ?? undefined) : undefined,
  );
}

/**
 * ONE NEW ATTEMPT AT THE PROVIDER UNDER A RUN ALREADY PAID FOR, after a lost
 * reply and a person's yes. It runs from the stored run answer, pays no second
 * Tenjin fee, and holds its payment under a claim key of its own. A run past
 * its 15 minutes is not run again: a new run pays the fee again.
 */
export async function retryTask(
  call: { run: string; task: string; label: string; input: Record<string, unknown> },
  slots: PlanSlot[],
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: ReportDeps,
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const kept = await readRun(dataDir, call.run);
  const now = (deps.now ?? Date.now)();
  if (kept === null || Date.parse(kept.answer.expiresAt) <= now) {
    await footer.done('needs_input');
    return fail(
      'needs_input',
      `This run of ${call.label} is no longer kept or has expired, so nothing was paid.`,
      {
        nextStep:
          'Call request({task, input}) again for a new run, which pays the Tenjin fee again.',
      },
    );
  }
  const slot = slots[0];
  if (slot === undefined) {
    await footer.done('failed');
    return fail('failed', 'The quote holds no provider payment, so nothing was paid.');
  }
  const settings = await resolveContextSettings(deps.ctx);
  void settings;
  const read = await readTaskKept(dataDir, call.task);
  const task: Task =
    read?.task ??
    ({
      id: call.task,
      label: call.label,
      does: call.label,
      input: {},
      price: { expectedAtomic: '0', maxAtomic: '0', feeAtomic: '0' },
      free: false,
      kind: 'task',
    } satisfies Task);
  const attemptNumber = kept.attempts + 1;
  await storeRun(dataDir, { ...kept, attempts: attemptNumber });
  const attempt = await attemptSellers(
    {
      answer: kept.answer,
      task,
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
      task,
      call.input,
      { ...deps, approves: false },
      0n,
    );
    return shown;
  }
  return attempt.result;
}

/** The members of a set, with their own quoted numbers. */
interface Member {
  key?: string;
  task: Task;
}

/**
 * A SET OF RUNS: every option of a compare group (`choice: "all"`), or takes of
 * one task (`count`). One quote holds the sum of the Tenjin fees and each
 * provider's allowed maximum, and meets the limits as one plan. The router
 * serves one answer with a call per member and the sum of their fees; each
 * member is held to one provider payment under a claim of its own, with its
 * own slot. A member that fails does not stop the others, and the receipt
 * lists every payment.
 */
export async function runTaskSet(
  call: {
    task: string;
    label: string;
    input: Record<string, unknown>;
    offer?: string;
    count?: number;
    options?: { key: string; task: string }[];
  },
  deps: RequestToolDeps,
  env: TaskEnv,
  footer: LookupFooter,
  approved?: PlanSlot[],
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const settings = await resolveContextSettings(deps.ctx);
  const members: Member[] = [];
  const wanted =
    call.options !== undefined
      ? call.options
      : Array.from({ length: call.count ?? 0 }, () => ({ key: undefined, task: call.task }));
  for (const option of wanted) {
    const read = await readTask(option.task, deps, env, settings);
    if ('legacy' in read || 'refused' in read) {
      await footer.done('failed');
      return 'refused' in read
        ? read.refused
        : fail('failed', 'This router does not run tasks, so nothing was sent or paid.');
    }
    if (read.task.free) {
      await footer.done('needs_input');
      return fail(
        'needs_input',
        `${read.task.label} is a free tool, which this form does not run.`,
      );
    }
    const problems = inputProblems(read.task.input, call.input);
    if (problems === undefined || problems.length > 0) {
      await footer.done('needs_input');
      return fail(
        'needs_input',
        `The input does not fit ${read.task.label}: ${(problems ?? ['its schema cannot be checked']).join('; ')}.`,
        { nextStep: 'Fix the input and call again; nothing was sent or paid.' },
      );
    }
    members.push({ ...(option.key !== undefined ? { key: option.key } : {}), task: read.task });
  }
  const fees = members.map(({ task }) => BigInt(task.price.feeAtomic));
  const maxes = members.map(({ task }) => BigInt(task.price.maxAtomic));
  const expected = members.reduce((sum, { task }) => sum + BigInt(task.price.expectedAtomic), 0n);
  const feeTotal = fees.reduce((sum, fee) => sum + fee, 0n);
  const sellerCap = maxes.reduce((most, max) => (max > most ? max : most), 0n);
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
          sentence: `${label} cost about ${usd(feeTotal + expected)} in all (${usd(expected)} for the providers and ${usd(feeTotal)} for Tenjin's routing fees), and at most ${usd(feeTotal + maxes.reduce((a, b) => a + b, 0n))}.`,
          payments,
          call: {
            kind: 'task_set',
            task: call.task,
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
      task: call.task,
      run,
      caps: { fee: feeTotal, seller: sellerCap },
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
      `${lasting ?? 'Tenjin could not pay the routing fee in time for this set of runs.'} Nothing was routed and no provider was paid.`,
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
    return fail(served.action, served.reason ?? 'The router did not run this task.', {
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
      'The router answered something other than the set asked for, so nothing was paid to a provider.',
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
      task: call.task,
      expiresAt: served.expiresAt,
      routingFeeAtomic: '0',
      spec: member.spec,
      ...(member.convert !== undefined ? { convert: member.convert } : {}),
      ...(member.output !== undefined ? { output: member.output } : {}),
    };
    const attempt = await attemptSellers(
      {
        answer: one,
        task: tried.task,
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
  const done = results.filter(({ result }) => !result.isError).length;
  const maybe = results.some(({ maybePaid }) => maybePaid);
  const payments = results.map(({ result }) => {
    const receipt = result.envelope['receipt'] as { provider?: unknown } | undefined;
    return receipt?.provider ?? null;
  });
  const status = done === results.length ? 'fulfilled' : done > 0 ? 'partial' : 'failed';
  const lines = results.map(
    ({ label: name, result }) => `${name}: ${result.isError ? 'not fulfilled' : 'fulfilled'}`,
  );
  await footer.done(status === 'fulfilled' ? 'fulfilled' : 'failed');
  return {
    isError: status === 'failed',
    summary: `${done} of ${results.length} runs fulfilled, Tenjin fees ${usd(feePaid)} in all.\n${lines.join('\n')}`,
    envelope: {
      status,
      task: call.task,
      run,
      receipt: {
        routingFee: { amount: usd(feePaid), payee: 'Tenjin', paid: feePaid > 0n },
        providers: payments,
      },
      results: results.map(({ key, label: name, result, maybePaid }, index) => ({
        ...(key !== undefined ? { key } : {}),
        service: name,
        status: result.envelope['status'],
        ...(result.envelope['output'] !== undefined ? { output: result.envelope['output'] } : {}),
        ...(result.envelope['fullResultPath'] !== undefined
          ? { fullResultPath: result.envelope['fullResultPath'] }
          : {}),
        ...(result.envelope['reason'] !== undefined ? { reason: result.envelope['reason'] } : {}),
        ...(maybePaid ? { possiblyPaid: true } : {}),
        payment: payments[index],
      })),
      ...(maybe
        ? {
            possiblyPaid: true,
            nextStep:
              'A provider payment may have left and no result came back. Tell the user, and check `tenjin payments` before running this again.',
          }
        : {}),
      cost: [`routing fees ${toMoney(feePaid.toString()).usd} USD`],
      providerContentUntrusted: true,
    },
  };
}

/** The quote a person said yes to for a set, run: its slots are the quote's,
 *  the fees' sum first, then each member's provider. */
export async function runTaskSetQuoted(
  call: {
    task: string;
    label: string;
    input: Record<string, unknown>;
    offer?: string;
    count?: number;
    options?: { key: string; task: string }[];
  },
  slots: PlanSlot[],
  deps: RequestToolDeps,
  env: TaskEnv,
  footer: LookupFooter,
): Promise<RequestToolResult> {
  return runTaskSet(call, deps, env, footer, slots);
}
