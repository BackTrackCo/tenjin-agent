import { toMoney } from '../lib/money';
import { policyCoversSet, type SpendPolicy } from '../lib/policy';
import { policyFix } from '../lib/spend-gate';
import { readSpendSummary, spentOf } from '../lib/spend-ledger';
import { readUsdcBalanceWithFallback } from '../lib/usdc-balance';
import { resolveWalletProvider } from '../lib/wallet';
import { ALL_CHOICES, type Choices } from './decision';
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
  type FailStatus,
  type PreparedSpec,
  type ReportDeps,
  type RequestToolDeps,
  type RequestToolResult,
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

interface Step {
  option: Choices['options'][number];
  prepared: PreparedSpec;
}

/** One option's entry in a set's result: who it was, then the fields its
 *  own single-offer result carries. */
type StepResult = { key: string; label: string; id: string; status: unknown } & Record<
  string,
  unknown
>;

/**
 * `request({id, choice: "all", input})`: every option, each its own offer.
 *
 * 1. The input carries only the fields the options share.
 * 2. Every option's spec is kept and its call checks; one that does not
 *    stops the set, naming it.
 * 3. Each option's one payment is claimed. One already claimed is
 *    `already_paid` and runs no second time.
 * 4. The claimed options, together, fit the spend policy: each under the
 *    per-call cap, the total inside the budget. If not, every claim is
 *    dropped and the answer is `needs_approval`, with nothing signed. The
 *    wallet's balance covers the total too, or the set is refused the same
 *    way, as a single payment is.
 * 5. Every claimed option pays at once, through the single-offer pay step.
 * 6. One result, one entry per option, in the set's order.
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
    return refuse(
      'needs_input',
      `Running all the choices takes only ${choices.input.join(', ')}, not ${extra.join(', ')}.`,
      `Call ${again} with only those, or pick one choice to set more; nothing was sent or paid.`,
    );
  }

  const steps: Step[] = [];
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
    const checked = await prepareSpec(option.id, spec, input, SILENT_FOOTER);
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
    steps.push({ option, prepared: checked.prepared });
  }

  const claimed: Step[] = [];
  const earlier = new Map<string, EarlierPayment>();
  for (const step of steps) {
    const claim = await claimSpecPayment(dataDir, step.option.id);
    if (claim === null) claimed.push(step);
    else earlier.set(step.option.id, claim);
  }
  if (claimed.length === 0) {
    // "Already ran" only when each one did; a claim this machine could not
    // write, or a call still running, says so in its own words.
    const allRan = [...earlier.values()].every(
      (claim) => claim.state === 'paid' || claim.state === 'possibly_paid',
    );
    return refuse(
      'needs_input',
      allRan
        ? 'Every choice in this set already ran under its own id, so nothing was paid this time. Their results are in the earlier request result.'
        : steps
            .map(
              ({ option, prepared }) =>
                `${option.label}: ${String(alreadyPaid(option.id, prepared.spec, earlier.get(option.id)!).envelope.reason)}`,
            )
            .join(' '),
      'For another run, send request({query}) for a new offer; each choice pays once.',
    );
  }
  // Every claim is dropped by a refusal below: nothing was signed.
  const release = async (): Promise<void> => {
    for (const step of claimed) {
      await settleSpecPayment(dataDir, step.option.id, { amountAtomic: 0n, signed: false });
    }
  };
  const ceiling = claimed.reduce(
    (sum, { prepared }) => sum + BigInt(prepared.spec.maxAmountAtomic),
    0n,
  );

  // ONE SPEND CHECK FOR THE WHOLE SET, against the same ledger and policy an
  // authorization reads, at each option's ceiling, before anything is signed.
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
    return refuse(
      'needs_approval',
      `Running ${claimed.length} choices costs up to $${toMoney(ceiling.toString()).usd}: ${evaluation.message} ${policyFix(evaluation.reason, 'this host')}`,
      'Report the command above to the user, or pick one choice; nothing was paid.',
    );
  }

  // AND ONE BALANCE READ FOR IT. Each payment reads the balance against its
  // own amount only, so side by side a wallet short of the total would sign
  // every one and the last would fail on chain, counted as exposure and
  // claimed as paid. A read that fails leaves each payment to its own read.
  const balance = await walletBalance(deps, settings.rpcUrl);
  if (balance !== null && balance < ceiling) {
    await release();
    return refuse(
      'failed',
      `Running ${claimed.length} choices costs up to $${toMoney(ceiling.toString()).usd}, and the wallet holds $${toMoney(balance.toString()).usd}. The wallet has insufficient USDC; no payment was signed. Fund this wallet on Base with \`tenjin wallet fund\` before paying.`,
      'Tell the user, or pick one choice the wallet covers; nothing was paid.',
    );
  }

  const ran = new Map(
    await Promise.all(
      claimed.map(
        async (step) =>
          [step.option.id, await paySpec(step.prepared, deps, SILENT_FOOTER, reportDeps)] as const,
      ),
    ),
  );

  let total = 0n;
  const results = steps.map(({ option, prepared }): StepResult => {
    const named = { key: option.key, label: option.label, id: option.id };
    const paid = ran.get(option.id);
    if (paid === undefined) {
      const claim = earlier.get(option.id)!;
      return {
        ...named,
        status: claim.state === 'unrecorded' ? 'failed' : 'already_paid',
        reason: alreadyPaid(option.id, prepared.spec, claim).envelope.reason,
        cost: costLines(0n),
      };
    }
    total += paid.left.amountAtomic;
    // The set's own envelope says once that provider content is untrusted.
    const envelope = { ...paid.result.envelope };
    delete envelope.providerContentUntrusted;
    return { ...named, status: envelope.status, ...envelope };
  });
  const statuses = results.filter((step) => step.status !== 'already_paid').map((s) => s.status);
  const status = statuses.every((each) => each === 'fulfilled')
    ? 'fulfilled'
    : statuses.some((each) => each === 'fulfilled' || each === 'unverified')
      ? 'partial'
      : 'failed';
  await footer.done(status, { price: `$${toMoney(total.toString()).usd}` });
  const cost = costLines(total);
  const lines = results.map((step) => {
    const files = Array.isArray(step.savedFiles) ? step.savedFiles : [];
    return `- ${step.label} (${step.key}): ${String(step.status)}${files.length ? `, saved to ${files.join(', ')}` : ''}`;
  });
  return {
    isError: status === 'failed',
    summary: [
      `Ran ${claimed.length} of ${steps.length} choices, ${status} · ${cost.join(' · ')}`,
      ...lines,
    ].join('\n'),
    envelope: {
      status,
      choice: ALL_CHOICES,
      results,
      cost,
      nextStep: COMPARE_NEXT_STEP,
      providerContentUntrusted: true,
    },
  };
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
