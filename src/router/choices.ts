import { quoteRouterCall } from '../commands/pay';
import { CliError } from '../lib/errors';
import { toMoney } from '../lib/money';
import type { SpendPolicy } from '../lib/policy';
import { admitPlan, type PlanSlot } from '../lib/spend-plan';
import { ALL_CHOICES, type Choices, type OfferSpec, type SpecOutcome } from './decision';
import { choicesOf, planStop, takesOf, type PlanWords, type QuotedCall } from './plan';
import { SILENT_FOOTER, type LookupFooter } from './progress';
import {
  claimSpecPayment,
  readChoices,
  readSpec,
  settleSpecPayment,
  type EarlierPayment,
  type KeptChoices,
} from './specs';
import {
  alreadyPaid,
  costLines,
  fail,
  failureOutcome,
  type FailExtras,
  paySpec,
  prepareSpec,
  reportOutcome,
  runningJob,
  specTerms,
  type FailStatus,
  type PreparedSpec,
  type ReportDeps,
  type RequestToolDeps,
  type RequestToolResult,
  type TakeOf,
} from './tool';
import { agentFixOf } from './wallet-reasons';

/**
 * A CHOICE SET: the services a line offers the user to pick between, or to run
 * all of. The set is the server's data, kept by the line's id (`specs.ts`);
 * this file only executes it, and every option is an ordinary offer with its
 * own id, spec and one payment.
 *
 * `request({id, choice: key})` is that option's offer, run by `tool.ts` as
 * `request({id: option.id})` would be. `request({id, choice: "all"})` runs
 * every option here, side by side, through the same three steps as one offer:
 * the checks, the claim and the payment. Nothing is signed until every option
 * passed its checks and was quoted, and the whole set's plan was admitted at
 * once, so a set the policy would stop halfway is stopped before its first
 * payment. Each payment still meets `gateSpend` when it is signed.
 *
 * Imported by `tool.ts` alone, so it stays in the request tool's chunk.
 */

/** What the host does with a set's results: they are files to look at. */
const COMPARE_NEXT_STEP =
  'Open each saved image, say which fits the request best and why, and let the user pick.';

/** The option a choice names, the whole set for `all`, or why neither. */
export async function pickChoice(
  dataDir: string,
  id: string | undefined,
  choice: string,
): Promise<{ id: string } | { all: KeptChoices } | { refused: RequestToolResult }> {
  if (id === undefined) {
    return {
      refused: fail(
        'needs_input',
        'A choice goes with the id from the line that offered it; send both.',
      ),
    };
  }
  const kept = await readChoices(dataDir, id);
  if (kept === null) {
    return {
      refused: fail(
        'needs_input',
        'No choices are kept on this machine for that id (they expired, or its line offered none), so nothing was sent or paid.',
        {
          nextStep:
            'Call request({query}) with the task for a fresh offer, then fill its line. If its line listed no choices, call request({id, input}) without `choice`.',
        },
      ),
    };
  }
  if (choice === ALL_CHOICES) return { all: kept };
  const option = kept.choices.options.find((each) => each.key === choice);
  if (option === undefined) {
    return {
      refused: fail(
        'needs_input',
        `${JSON.stringify(choice)} is not one of this offer's choices: ${keysOf(kept.choices)}.`,
        {
          nextStep: `Call request({id: ${JSON.stringify(id)}, choice, input: {...}}) with one of those.`,
        },
      ),
    };
  }
  return { id: option.id };
}

/** The keys a choice may name, `all` last. */
function keysOf(choices: Choices): string {
  return [...choices.options.map((option) => option.key), ALL_CHOICES]
    .map((key) => JSON.stringify(key))
    .join(', ');
}

/**
 * `request({id, choice: "all"})` with no input: the line the set came with,
 * which names every option, its price and the call, and nothing paid. The
 * server wrote it; this client composes no second wording of the same set.
 */
export function showChoices(id: string, kept: KeptChoices): RequestToolResult {
  return {
    isError: false,
    summary: kept.hint,
    envelope: {
      status: 'spec',
      id,
      choice: ALL_CHOICES,
      nextStep: `Call request({id: ${JSON.stringify(id)}, choice: "${ALL_CHOICES}", input: {...}}) with ${kept.choices.input.join(', ')}.`,
      cost: costLines(0n),
    },
  };
}

/**
 * ONE OF SEVERAL PAYMENTS RUN SIDE BY SIDE: a choice of a set, under its own
 * offer, or a take of a count, under its offer's id and its number.
 */
export interface TakeStep {
  /** Who it is in the set's result: a choice's key, label and id, or a take's number. */
  named: Record<string, unknown>;
  /** The claim its one payment holds. */
  claim: string;
  prepared: PreparedSpec;
  /** A take of a count: its number, and that the count reports for it. */
  take?: TakeOf;
}

/** One step's ending: paid in this call, or claimed by an earlier one. */
type StepRan =
  | { step: TakeStep; paid: Awaited<ReturnType<typeof paySpec>> }
  | { step: TakeStep; earlier: EarlierPayment }
  /** Its seller refused it at its quote: nothing was paid, and it may run again. */
  | { step: TakeStep; refused: RequestToolResult };

/** A claimed step and what its payment is planned at. */
interface PlannedStep {
  step: TakeStep;
  amountAtomic: bigint;
}

/** A claimed step's live price, or why its seller would not quote it. */
type Priced = bigint | { refused: RequestToolResult };

/** One option's entry in a set's result: who it was, then the fields its
 *  own single-offer result carries. */
type StepResult = { status: unknown } & Record<string, unknown>;

/**
 * Steps 3 to 5 of running several payments at once, a choice set's or a
 * count's:
 *
 * 3. Each step's one payment is claimed. One already claimed runs no second
 *    time; when none is left, the caller says so in its own words.
 * 4. The claimed steps are priced live (`price`), and are the call's plan,
 *    each at its price; one its seller would not quote drops its claim and
 *    is its own entry, or stops them all. The plan is admitted as a whole:
 *    its total under `maxAutoSpend` and the day's budget. If not, every claim
 *    is dropped and nothing is signed: over the limits, the plan is kept as a quote for the user's yes. A quote the
 *    user approved brings its own slots instead, one per claimed step, or
 *    nothing runs.
 * 5. Every planned step pays at once, each against its own slot, through the
 *    single-offer pay step.
 */
async function runTakes(
  steps: TakeStep[],
  plan: {
    price: (claimed: TakeStep[]) => Promise<Priced[] | { stop: RequestToolResult }>;
    words: (planned: PlannedStep[]) => PlanWords;
    /** What a quote of the planned steps runs. */
    call: (planned: PlannedStep[]) => QuotedCall;
    /** The slots of a quote the user approved, in the steps' order. */
    approved?: PlanSlot[];
  },
  deps: RequestToolDeps,
  reportDeps: ReportDeps,
  settings: { policy: SpendPolicy; rpcUrl: string },
  words: {
    stopped: (planned: TakeStep[], outcome: Omit<SpecOutcome, 'id' | 'ms'>) => void;
    refuse: (status: FailStatus, reason: string, extras: FailExtras) => Promise<RequestToolResult>;
    pickOne: string;
  },
): Promise<{ refused: RequestToolResult } | { ran: StepRan[]; claimed: number }> {
  const { dataDir } = deps.ctx;
  const claimed: TakeStep[] = [];
  const earlier = new Map<TakeStep, EarlierPayment>();
  for (const step of steps) {
    const claim = await claimSpecPayment(dataDir, step.claim);
    if (claim === null) claimed.push(step);
    else earlier.set(step, claim);
  }
  // Every claim a refusal drops: nothing was signed for it.
  const release = async (dropped: TakeStep[]): Promise<void> => {
    for (const step of dropped) {
      await settleSpecPayment(dataDir, step.claim, { amountAtomic: 0n, signed: false });
    }
  };
  const unquoted = new Map<TakeStep, RequestToolResult>();
  const slots = new Map<TakeStep, PlanSlot>();
  let planned: PlannedStep[] = [];
  if (claimed.length > 0 && plan.approved !== undefined) {
    if (plan.approved.length !== claimed.length) {
      await release(claimed);
      return {
        refused: await words.refuse(
          'needs_input',
          'What is left to run is no longer what the quote approved, so nothing was paid.',
          { nextStep: 'Call request again for a fresh quote.' },
        ),
      };
    }
    claimed.forEach((step, index) => slots.set(step, plan.approved![index]!));
    planned = claimed.map((step) => ({ step, amountAtomic: slots.get(step)!.amountAtomic }));
  } else if (claimed.length > 0) {
    const priced = await plan.price(claimed);
    if ('stop' in priced) {
      await release(claimed);
      return { refused: priced.stop };
    }
    claimed.forEach((step, index) => {
      const price = priced[index]!;
      if (typeof price === 'bigint') planned.push({ step, amountAtomic: price });
      else unquoted.set(step, price.refused);
    });
    await release([...unquoted.keys()]);
    if (planned.length > 0) {
      const payments = planned.map(({ step, amountAtomic }) => ({
        amountAtomic,
        creator: new URL(step.prepared.built.url).host,
      }));
      const admission = await admitPlan(payments, {
        dataDir,
        policy: settings.policy,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
      if (!('admitted' in admission)) {
        await release(planned.map(({ step }) => step));
        const stop = await planStop(
          admission,
          { ...plan.words(planned), payments, call: plan.call(planned) },
          deps,
          words.pickOne,
        );
        words.stopped(
          planned.map(({ step }) => step),
          stop.outcome,
        );
        return { refused: await words.refuse(stop.status, stop.reason, stop.extras) };
      }
      planned.forEach(({ step }, index) => slots.set(step, admission.admitted[index]!));
    }
  }

  const paid = new Map(
    await Promise.all(
      planned.map(
        async ({ step }) =>
          [
            step,
            await paySpec(
              step.prepared,
              { slot: slots.get(step)! },
              deps,
              SILENT_FOOTER,
              reportDeps,
              step.take,
            ),
          ] as const,
      ),
    ),
  );
  return {
    claimed: planned.length,
    ran: steps.map((step): StepRan => {
      const done = paid.get(step);
      if (done !== undefined) return { step, paid: done };
      const refused = unquoted.get(step);
      return refused !== undefined ? { step, refused } : { step, earlier: earlier.get(step)! };
    }),
  };
}

/** One entry of a set's result: a step that ran in this call, with its own
 *  single result, or one an earlier call already ran. */
export type SetEntry =
  | { named: Record<string, unknown>; result: RequestToolResult; amountAtomic: bigint }
  | { named: Record<string, unknown>; earlier: StepResult };

/**
 * Step 6: ONE RESULT, one entry per step in its order, each the fields its
 * own single result carries. Of the steps that ran here, the set is
 * `fulfilled` when every one is; `running` while any is, with the job that
 * resumes it; `partial` when some delivered; `failed` when none did. The
 * cost is what ran here, summed.
 */
export function takesResult(
  entries: SetEntry[],
  opts: { head: string; nextStep: string; envelope?: Record<string, unknown> },
): RequestToolResult {
  let total = 0n;
  const ran: unknown[] = [];
  const results: StepResult[] = entries.map((entry) => {
    if ('earlier' in entry) return { ...entry.named, ...entry.earlier };
    total += entry.amountAtomic;
    // The set's own envelope says once that provider content is untrusted.
    const envelope = { ...entry.result.envelope };
    delete envelope.providerContentUntrusted;
    ran.push(envelope.status);
    return { ...entry.named, status: envelope.status, ...envelope };
  });
  const status = ran.every((each) => each === 'fulfilled')
    ? 'fulfilled'
    : ran.some((each) => each === 'running')
      ? 'running'
      : ran.some((each) => each === 'fulfilled' || each === 'unverified')
        ? 'partial'
        : 'failed';
  const cost = costLines(total);
  const lines = results.map((step) => {
    const files = Array.isArray(step.savedFiles) ? step.savedFiles : [];
    const who =
      step.label !== undefined
        ? `${String(step.label)} (${String(step.key)})`
        : `take ${String(step.take)}`;
    return `- ${who}: ${String(step.status)}${files.length ? `, saved to ${files.join(', ')}` : ''}`;
  });
  // Each entry still running names its job: one for a count's takes, one per
  // option for a choice set's.
  const jobs = [
    ...new Set(
      results.flatMap((step) =>
        step.status === 'running' && typeof step.job === 'string' ? [step.job] : [],
      ),
    ),
  ];
  const resume =
    jobs.length > 0
      ? `Call ${jobs.map((job) => `request({job: ${JSON.stringify(job)}})`).join(' and ')} in a minute or two for what is still running; nothing more is paid.`
      : undefined;
  return {
    isError: status === 'failed',
    summary: [
      `${opts.head}, ${status} · ${cost.join(' · ')}`,
      ...lines,
      ...(resume !== undefined ? [resume] : []),
    ].join('\n'),
    envelope: {
      status,
      ...(opts.envelope ?? {}),
      ...(jobs.length === 1 ? { job: jobs[0] } : {}),
      results,
      cost,
      nextStep: resume ?? opts.nextStep,
      providerContentUntrusted: true,
    },
  };
}

/** A step an earlier call already claimed, as its entry says it. */
function earlierEntry(step: TakeStep, claim: EarlierPayment): SetEntry {
  return {
    named: step.named,
    earlier: {
      status: claim.state === 'unrecorded' ? 'failed' : 'already_paid',
      reason: alreadyPaid(step.claim, step.prepared.spec, claim).envelope.reason,
      cost: costLines(0n),
    },
  };
}

/** Every step's entry, in the set's order. */
function entriesOf(ran: StepRan[]): SetEntry[] {
  return ran.map((each) =>
    'paid' in each
      ? {
          named: each.step.named,
          result: each.paid.result,
          amountAtomic: each.paid.left.amountAtomic,
        }
      : 'refused' in each
        ? { named: each.step.named, result: each.refused, amountAtomic: 0n }
        : earlierEntry(each.step, each.earlier),
  );
}

/** What the steps that ran in this call paid, together. */
function paidHere(ran: StepRan[]): bigint {
  return ran.reduce((sum, each) => sum + ('paid' in each ? each.paid.left.amountAtomic : 0n), 0n);
}

/**
 * `request({id, choice: "all", input})`: every option, each its own offer.
 *
 * 1. The input carries only the fields the options share.
 * 2. Every option's spec is kept and its call checks; one that does not
 *    stops the set, naming it. Each is then quoted at its live price by one
 *    unpaid probe, side by side. An option its seller refuses there (the
 *    prompt, the price) is that option's own entry, with nothing paid, and
 *    the rest run without it.
 * 3 to 5. Claimed, planned and admitted as one, and paid side by side
 *    ({@link runTakes}).
 * 6. One result, one entry per option, in the set's order ({@link takesResult}).
 *
 * `approved`: a quote the user said yes to, with the specs it was quoted on,
 * the options it covers and its slots; nothing is probed or planned again.
 */
export async function runChoiceSet(
  id: string,
  kept: KeptChoices,
  input: Record<string, unknown>,
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: ReportDeps,
  settings: { policy: SpendPolicy; rpcUrl: string },
  approved?: { specs: OfferSpec[]; keys: string[]; slots: PlanSlot[] },
): Promise<RequestToolResult> {
  const { dataDir } = deps.ctx;
  const { choices } = kept;
  const startedAt = Date.now();
  // A set stopped before payment is reported once per choice, as each
  // choice's own offer would be.
  const stopped = (
    options: readonly { id: string }[],
    outcome: Omit<SpecOutcome, 'id' | 'ms'>,
  ): void => {
    for (const option of options) reportOutcome(reportDeps, option.id, outcome, startedAt);
  };
  const again = `request({id: ${JSON.stringify(id)}, choice: "${ALL_CHOICES}", input: {...}})`;
  const refuse = async (
    status: FailStatus,
    reason: string,
    extras: FailExtras,
  ): Promise<RequestToolResult> => {
    await footer.done(status);
    return fail(status, reason, extras);
  };

  const extra = Object.keys(input).filter((name) => !choices.input.includes(name));
  if (extra.length) {
    stopped(choices.options, { status: 'unpaid', reason: 'input' });
    return refuse(
      'needs_input',
      `Running all the choices takes only ${choices.input.join(', ')}, not ${extra.join(', ')}.`,
      {
        nextStep: `Call ${again} with only those, or pick one choice to set more; nothing was sent or paid.`,
      },
    );
  }

  const specs: OfferSpec[] = [];
  const prepared: { option: (typeof choices.options)[number]; checked: PreparedSpec }[] = [];
  for (const [index, option] of choices.options.entries()) {
    const named = `${option.label} (choice ${JSON.stringify(option.key)})`;
    const spec =
      approved !== undefined ? approved.specs[index] : await readSpec(dataDir, option.id);
    if (spec === null || spec === undefined) {
      return refuse(
        'needs_input',
        `The spec for ${named} is no longer kept on this machine (it expired or was pruned), so nothing was sent or paid.`,
        { nextStep: 'Call request({query}) with the task for a fresh offer, then fill its line.' },
      );
    }
    specs.push(spec);
    const checked = await prepareSpec(option.id, spec, input, SILENT_FOOTER, reportDeps);
    if ('refused' in checked) {
      const { status, reason } = checked.refused.envelope as { status: FailStatus; reason: string };
      return refuse(status, `${named}: ${reason}`, {
        nextStep:
          status === 'needs_input'
            ? `Fix the input and call ${again} again, or pick one of the other choices; nothing was sent or paid.`
            : 'Pick one of the other choices; nothing was sent or paid.',
      });
    }
    prepared.push({ option, checked: checked.prepared });
  }

  // A quote the user approved runs only the options it covered.
  const steps: TakeStep[] = prepared
    .filter(({ option }) => approved === undefined || approved.keys.includes(option.key))
    .map(({ option, checked }) => ({
      named: { key: option.key, label: option.label, id: option.id },
      claim: option.id,
      prepared: checked,
    }));
  const run = await runTakes(
    steps,
    {
      // EACH OPTION AT ITS LIVE PRICE: the plan is what the set will cost,
      // not what its ceilings allow. One its seller refuses there (the
      // prompt, the price) is its own entry, with nothing paid.
      price: async (claimed) =>
        Promise.all(
          claimed.map(async (step): Promise<Priced> => {
            const quote = await quoteTake(step.prepared, deps);
            if (!('refused' in quote)) return quote.atomic;
            const { outcome, result } = quote.refused;
            if (outcome !== null) reportOutcome(reportDeps, step.claim, outcome, startedAt);
            return { refused: result };
          }),
        ),
      words: (planned) =>
        choicesOf(
          planned.map(({ step }) => String(step.named.label)),
          planned.map(({ amountAtomic }) => amountAtomic),
        ),
      call: (planned) => ({
        kind: 'choices',
        id,
        kept,
        specs,
        keys: planned.map(({ step }) => String(step.named.key)),
        input,
      }),
      ...(approved !== undefined ? { approved: approved.slots } : {}),
    },
    deps,
    reportDeps,
    settings,
    {
      stopped: (planned, outcome) =>
        stopped(
          planned.map((step) => ({ id: step.claim })),
          outcome,
        ),
      refuse,
      pickOne: 'pick one choice',
    },
  );
  if ('refused' in run) return run.refused;
  const ranAny = run.ran.some((each) => !('earlier' in each));
  if (!ranAny) {
    // "Already ran" only when each one did; a claim this machine could not
    // write, or a call still running, says so in its own words.
    const earlier = run.ran.flatMap((each) => ('earlier' in each ? [each] : []));
    const allRan = earlier.every(
      ({ earlier: claim }) => claim.state === 'paid' || claim.state === 'possibly_paid',
    );
    return refuse(
      'needs_input',
      allRan
        ? 'Every choice in this set already ran under its own id, so nothing was paid this time. Their results are in the earlier request result.'
        : earlier
            .map(
              ({ step, earlier: claim }) =>
                `${String(step.named.label)}: ${String(alreadyPaid(step.claim, step.prepared.spec, claim).envelope.reason)}`,
            )
            .join(' '),
      {
        nextStep: 'For another run, send request({query}) for a new offer; each choice pays once.',
      },
    );
  }
  const set = takesResult(entriesOf(run.ran), {
    head: `Ran ${run.claimed} of ${steps.length} choices`,
    nextStep: COMPARE_NEXT_STEP,
    envelope: { choice: ALL_CHOICES },
  });
  await footer.done(String(set.envelope.status), {
    price: `$${toMoney(paidHere(run.ran).toString()).usd}`,
  });
  return set;
}

/** What the host does with a count's results: several takes to compare. */
const TAKES_NEXT_STEP =
  'Open each saved file, say which take fits the request best and why, and let the user pick.';

/**
 * `request({id, input, count})`: SEVERAL TAKES OF ONE CALL, each its own
 * payment. Take 1 is the offer's own claim, as a plain call's is; take n
 * claims `${id}#n`, so a repeat pays only for the takes not yet run. Each
 * take's request key ends in `#n`, or the same-turn duplicate guard would
 * deny takes 2 to N as one request repeated. One unpaid probe quotes a take
 * at this input's live price, and the count's plan is N takes at it: their
 * total meets the automatic limits before any take is
 * signed, and a take quoted higher when it is signed is refused there. A take
 * the seller answers before it is ready is a job under the offer's id,
 * resumed with `request({job})`. The offer is reported once, for the count as
 * a whole. `approved`: the slots of a quote the user said yes to; nothing is
 * probed or planned again.
 */
export async function runCount(
  id: string,
  spec: OfferSpec,
  input: Record<string, unknown>,
  count: number,
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: ReportDeps,
  settings: { policy: SpendPolicy; rpcUrl: string },
  approved?: PlanSlot[],
): Promise<RequestToolResult> {
  const startedAt = Date.now();
  const refuse = async (
    status: FailStatus,
    reason: string,
    extras: FailExtras,
  ): Promise<RequestToolResult> => {
    await footer.done(status);
    return fail(status, reason, extras);
  };
  const checked = await prepareSpec(id, spec, input, footer, reportDeps);
  if ('refused' in checked) return checked.refused;
  const steps: TakeStep[] = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const claim = n === 1 ? id : `${id}#${n}`;
    return {
      named: { take: n },
      claim,
      prepared: checked.prepared,
      take: { n, claim, report: false },
    };
  });
  const run = await runTakes(
    steps,
    {
      // THE LIVE PRICE, ONCE, for the takes still to run: the number a single
      // call of this input is planned at, so a price that varies by input is
      // planned at what this input costs, not at the spec's ceiling.
      price: async (claimed) => {
        const quoted = await quoteTake(checked.prepared, deps);
        if (!('refused' in quoted)) return claimed.map(() => quoted.atomic);
        const { outcome, result } = quoted.refused;
        if (outcome !== null) reportOutcome(reportDeps, id, outcome, startedAt);
        await footer.done(String(result.envelope.status));
        return { stop: result };
      },
      words: (planned) =>
        takesOf(
          spec.provider,
          planned.map(({ amountAtomic }) => amountAtomic),
        ),
      call: () => ({ kind: 'count', id, spec, input, count }),
      ...(approved !== undefined ? { approved } : {}),
    },
    deps,
    reportDeps,
    settings,
    {
      stopped: (_claimed, outcome) => reportOutcome(reportDeps, id, outcome, startedAt),
      refuse,
      pickOne: 'run fewer takes',
    },
  );
  if ('refused' in run) return run.refused;
  if (run.claimed === 0) {
    const running = await runningJob(deps.ctx.dataDir, id);
    return refuse(
      'needs_input',
      `Every one of these ${count} takes already ran under this id, so nothing was paid this time. Their results are in the earlier request result.`,
      {
        nextStep:
          running !== undefined
            ? `Call request({job: ${JSON.stringify(running)}}) for the takes still running; nothing more is paid.`
            : `For more takes, send request({query}) for a new offer; this id (${id}) pays once per take.`,
      },
    );
  }
  const ranHere = run.ran.flatMap((each) => ('paid' in each ? [each] : []));
  const set = takesResult(entriesOf(run.ran), {
    head: `Ran ${run.claimed} of ${count} takes`,
    nextStep: TAKES_NEXT_STEP,
    envelope: { count },
  });
  const status = String(set.envelope.status);
  // ONE REPORT FOR THE OFFER: a take that delivered is the offer taken.
  const outcome: Omit<SpecOutcome, 'id' | 'ms'> | null =
    status === 'fulfilled' || status === 'partial'
      ? { status: 'fulfilled' }
      : status === 'running'
        ? { status: 'running' }
        : ranHere.some(({ paid }) => paid.outcome?.status === 'failed')
          ? { status: 'failed' }
          : (ranHere.find(({ paid }) => paid.outcome !== null)?.paid.outcome ?? null);
  if (outcome !== null) reportOutcome(reportDeps, id, outcome, startedAt);
  await footer.done(status, { price: `$${toMoney(paidHere(run.ran).toString()).usd}` });
  return set;
}

/**
 * ONE TAKE'S LIVE PRICE, from an unpaid probe held to the spec's terms, or
 * the refusal a single call would have met there, with nothing signed: an
 * input the seller rejects, a price over the spec's ceiling, a seller that
 * cannot be reached.
 */
async function quoteTake(
  prepared: PreparedSpec,
  deps: RequestToolDeps,
): Promise<
  | { atomic: bigint }
  | {
      refused: {
        result: RequestToolResult;
        outcome: ReturnType<typeof failureOutcome>;
      };
    }
> {
  const { spec, built } = prepared;
  try {
    const atomic = await quoteRouterCall(
      {
        url: built.url,
        method: built.method,
        headers: built.headers,
        ...(built.specHeaders !== undefined ? { specHeaders: built.specHeaders } : {}),
        ...(built.body !== undefined ? { rawBody: built.body } : {}),
        terms: specTerms(spec),
      },
      deps.ctx,
      // The same seams, and the same wallet, the paid leg is given.
      {
        ...(deps.payDeps ?? {}),
        ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
      },
    );
    return { atomic };
  } catch (err) {
    const cli = err instanceof CliError ? err : undefined;
    const detail = (cli?.details ?? {}) as {
      status?: number;
      providerError?: string;
      live?: { amount?: string };
    };
    const rejectedInput = detail.status === 400 || detail.status === 422;
    const live = detail.live?.amount;
    const overCeiling =
      spec.priceVaries &&
      cli?.code === 'REGISTRY_MISMATCH' &&
      live !== undefined &&
      /^\d+$/.test(live);
    const reason = overCeiling
      ? `${spec.provider} prices this input at $${toMoney(live).usd}, over this spec's $${toMoney(spec.maxAmountAtomic).usd} ceiling, so nothing was signed. Change the input and call again with the same id.`
      : rejectedInput
        ? `${spec.provider} rejected this input before any payment (HTTP ${String(detail.status)}): see providerError. Fix the input and call again with the same id.`
        : cli !== undefined
          ? `${cli.message} ${agentFixOf(cli)}`.trim()
          : String(err);
    const status: FailStatus = cli?.code === 'POLICY_REFUSED' ? 'needs_approval' : 'failed';
    return {
      refused: {
        outcome: failureOutcome(err, { mayHaveMoved: false, rejectedInput }),
        result: fail(status, reason, {
          ...(typeof detail.status === 'number' ? { providerStatus: detail.status } : {}),
          ...(typeof detail.providerError === 'string'
            ? { providerError: detail.providerError }
            : {}),
          request: { method: built.method, url: built.url },
          parameters: prepared.sentInput,
          ...(overCeiling || rejectedInput
            ? { nextStep: 'Change the input and call again with the same id.' }
            : {}),
        }),
      },
    };
  }
}
