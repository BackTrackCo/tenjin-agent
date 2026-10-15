import { toMoney } from '../lib/money';
import { policyCoversSet, type SpendPolicy } from '../lib/policy';
import { policyFix } from '../lib/spend-gate';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
import { readUsdcBalanceWithFallback } from '../lib/usdc-balance';
import { resolveWalletProvider } from '../lib/wallet';
import { ALL_CHOICES, type Choices, type OfferSpec, type SpecOutcome } from './decision';
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
  paySpec,
  prepareSpec,
  reportOutcome,
  runningJob,
  type FailStatus,
  type PreparedSpec,
  type ReportDeps,
  type RequestToolDeps,
  type RequestToolResult,
  type TakeOf,
} from './tool';

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
 * passed its checks and the whole set fits the spend policy at once, so a set
 * the policy would stop halfway is stopped before its first payment. Each
 * payment still meets `gateSpend` when it is signed.
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
  | { step: TakeStep; earlier: EarlierPayment };

/** One option's entry in a set's result: who it was, then the fields its
 *  own single-offer result carries. */
type StepResult = { status: unknown } & Record<string, unknown>;

/**
 * Steps 3 to 5 of running several payments at once, a choice set's or a
 * count's:
 *
 * 3. Each step's one payment is claimed. One already claimed runs no second
 *    time; when none is left, the caller says so in its own words.
 * 4. The claimed steps, together, fit the spend policy: each under the
 *    per-call cap, the total inside the budget. If not, every claim is
 *    dropped and the answer is `needs_approval` with the total, with nothing
 *    signed. The wallet's balance covers the total too, or the set is refused
 *    the same way, as a single payment is.
 * 5. Every claimed step pays at once, through the single-offer pay step.
 */
async function runTakes(
  steps: TakeStep[],
  what: (claimed: number) => string,
  deps: RequestToolDeps,
  reportDeps: ReportDeps,
  settings: { policy: SpendPolicy; rpcUrl: string },
  words: {
    stopped: (claimed: TakeStep[], outcome: Omit<SpecOutcome, 'id' | 'ms'>) => void;
    refuse: (status: FailStatus, reason: string, nextStep: string) => Promise<RequestToolResult>;
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
  if (claimed.length > 0) {
    // Every claim is dropped by a refusal below: nothing was signed.
    const release = async (): Promise<void> => {
      for (const step of claimed) {
        await settleSpecPayment(dataDir, step.claim, { amountAtomic: 0n, signed: false });
      }
    };
    const ceiling = claimed.reduce(
      (sum, { prepared }) => sum + BigInt(prepared.spec.maxAmountAtomic),
      0n,
    );

    // ONE SPEND CHECK FOR THE WHOLE SET, against the same ledger and policy an
    // authorization reads, at each step's ceiling, before anything is signed.
    const ledger = await readSpendSummary(dataDir);
    const evaluation = policyCoversSet(
      settings.policy,
      claimed.map(({ prepared }) => ({
        amountAtomic: BigInt(prepared.spec.maxAmountAtomic),
        creator: new URL(prepared.built.url).host,
      })),
      ledger === null ? 0n : spentOf(ledger),
    );
    if (evaluation.decision !== 'allow') {
      await release();
      words.stopped(claimed, { status: 'needs_approval' });
      return {
        refused: await words.refuse(
          'needs_approval',
          `${what(claimed.length)} costs up to $${toMoney(ceiling.toString()).usd}: ${evaluation.message} ${policyFix(evaluation.reason, 'this host')}`,
          `Report the command above to the user, or ${words.pickOne}; nothing was paid.`,
        ),
      };
    }

    // AND ONE BALANCE READ FOR IT. Each payment reads the balance against its
    // own amount only, so side by side a wallet short of the total would sign
    // every one and the last would fail on chain, counted as exposure and
    // claimed as paid. A read that fails leaves each payment to its own read.
    const balance = await walletBalance(deps, settings.rpcUrl);
    if (balance !== null && balance < ceiling) {
      await release();
      words.stopped(claimed, { status: 'unpaid', reason: 'wallet' });
      return {
        refused: await words.refuse(
          'failed',
          `${what(claimed.length)} costs up to $${toMoney(ceiling.toString()).usd}, and the wallet holds $${toMoney(balance.toString()).usd}: $${toMoney((ceiling - balance).toString()).usd} short. The wallet has insufficient USDC; no payment was signed. Fund this wallet on Base with \`tenjin wallet fund\` before paying.`,
          `Tell the user, or ${words.pickOne} the wallet covers; nothing was paid.`,
        ),
      };
    }
  }

  const paid = new Map(
    await Promise.all(
      claimed.map(
        async (step) =>
          [step, await paySpec(step.prepared, deps, SILENT_FOOTER, reportDeps, step.take)] as const,
      ),
    ),
  );
  return {
    claimed: claimed.length,
    ran: steps.map((step) => {
      const done = paid.get(step);
      return done !== undefined ? { step, paid: done } : { step, earlier: earlier.get(step)! };
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
 *    stops the set, naming it.
 * 3 to 5. Claimed, checked against the spend policy and the balance as one,
 *    and paid side by side ({@link runTakes}).
 * 6. One result, one entry per option, in the set's order ({@link takesResult}).
 */
export async function runChoiceSet(
  id: string,
  kept: KeptChoices,
  input: Record<string, unknown>,
  deps: RequestToolDeps,
  footer: LookupFooter,
  reportDeps: ReportDeps,
  settings: { policy: SpendPolicy; rpcUrl: string },
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
    nextStep: string,
  ): Promise<RequestToolResult> => {
    await footer.done(status);
    return fail(status, reason, { nextStep });
  };

  const extra = Object.keys(input).filter((name) => !choices.input.includes(name));
  if (extra.length) {
    stopped(choices.options, { status: 'unpaid', reason: 'input' });
    return refuse(
      'needs_input',
      `Running all the choices takes only ${choices.input.join(', ')}, not ${extra.join(', ')}.`,
      `Call ${again} with only those, or pick one choice to set more; nothing was sent or paid.`,
    );
  }

  const steps: TakeStep[] = [];
  for (const option of choices.options) {
    const named = `${option.label} (choice ${JSON.stringify(option.key)})`;
    const spec = await readSpec(dataDir, option.id);
    if (spec === null) {
      return refuse(
        'needs_input',
        `The spec for ${named} is no longer kept on this machine (it expired or was pruned), so nothing was sent or paid.`,
        'Call request({query}) with the task for a fresh offer, then fill its line.',
      );
    }
    const checked = await prepareSpec(option.id, spec, input, SILENT_FOOTER, reportDeps);
    if ('refused' in checked) {
      const { status, reason } = checked.refused.envelope as { status: FailStatus; reason: string };
      return refuse(
        status,
        `${named}: ${reason}`,
        status === 'needs_input'
          ? `Fix the input and call ${again} again, or pick one of the other choices; nothing was sent or paid.`
          : 'Pick one of the other choices; nothing was sent or paid.',
      );
    }
    steps.push({
      named: { key: option.key, label: option.label, id: option.id },
      claim: option.id,
      prepared: checked.prepared,
    });
  }

  const run = await runTakes(
    steps,
    (claimed) => `Running ${claimed} choices`,
    deps,
    reportDeps,
    settings,
    {
      stopped: (claimed, outcome) =>
        stopped(
          claimed.map((step) => ({ id: step.claim })),
          outcome,
        ),
      refuse,
      pickOne: 'pick one choice',
    },
  );
  if ('refused' in run) return run.refused;
  if (run.claimed === 0) {
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
      'For another run, send request({query}) for a new offer; each choice pays once.',
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
 * deny takes 2 to N as one request repeated. The whole count meets the spend
 * policy and the balance before any take is signed (the per-call cap per
 * take, the total inside the budget), and a take the seller answers before
 * it is ready is a job under the offer's id, resumed with `request({job})`.
 * The offer is reported once, for the count as a whole.
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
): Promise<RequestToolResult> {
  const startedAt = Date.now();
  const refuse = async (
    status: FailStatus,
    reason: string,
    nextStep: string,
  ): Promise<RequestToolResult> => {
    await footer.done(status);
    return fail(status, reason, { nextStep });
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
    (claimed) => `${claimed} takes of ${spec.provider}`,
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
      running !== undefined
        ? `Call request({job: ${JSON.stringify(running)}}) for the takes still running; nothing more is paid.`
        : `For more takes, send request({query}) for a new offer; this id (${id}) pays once per take.`,
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
        : ranHere.some(({ paid }) => paid.outcome !== null && paid.outcome.status !== 'unpaid')
          ? { status: 'failed' }
          : (ranHere.find(({ paid }) => paid.outcome !== null)?.paid.outcome ?? null);
  if (outcome !== null) reportOutcome(reportDeps, id, outcome, startedAt);
  await footer.done(status, { price: `$${toMoney(paidHere(run.ran).toString()).usd}` });
  return set;
}

/** The paying wallet's USDC balance, read the way `runPay` reads it, or null
 *  when there is no wallet or the read failed. */
async function walletBalance(deps: RequestToolDeps, rpcUrl: string): Promise<bigint | null> {
  try {
    const provider = deps.provider ?? deps.payDeps?.provider ?? resolveWalletProvider(deps.ctx);
    const { address } = await provider.describe();
    const read = deps.payDeps?.readBalance ?? readUsdcBalanceWithFallback;
    return await read(address, rpcUrl, {
      timeoutMs: Math.max(1, Math.floor(deps.ctx.flags.timeout / 2)),
    });
  } catch {
    return null;
  }
}
