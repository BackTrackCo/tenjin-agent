import type { WalletOutcome } from '../commands/install-wallet';
import type { FundOptions, runFund } from '../commands/fund';
import type { CommandContext, CommandResult } from '../context';
import { selectOne } from '../lib/clack';
import { emitSuccess } from '../lib/output';
import { SUGGESTED_FUND_USD, usd } from './fee';
import type { QuestionStep } from './install';

export interface FundStep extends QuestionStep {
  id: 'fund';
}

type Funding = { step?: FundStep; warning?: string } | undefined;
type FundingCheck = (
  wallet: WalletOutcome,
  rpcUrl: string,
  deps: FundingDeps,
  command: string,
) => Promise<Funding>;

export interface FundingDeps {
  walletBalance?: (address: string, rpcUrl: string) => Promise<bigint>;
  funding?: FundingCheck;
}

/** Installation prepares funding instructions; the separate command creates the link. */
export async function fundStep(
  wallet: WalletOutcome,
  rpcUrl: string,
  deps: FundingDeps,
  command: string,
): Promise<Funding> {
  const address = wallet.address;
  if (
    address === undefined ||
    (wallet.status !== 'created' && wallet.status !== 'existing') ||
    wallet.signing?.status === 'blocked' ||
    wallet.signing?.status === 'unknown' ||
    wallet.shellOnly !== undefined
  )
    return undefined;
  const funded =
    wallet.status === 'created'
      ? false
      : await (deps.walletBalance ?? defaultBalance)(address, rpcUrl).then(
          (atomic) => atomic > 0n,
          () => null,
        );
  if (funded === true) return undefined;
  if (funded === null)
    return {
      warning:
        'Could not check your Tenjin funds. This does not mean you need to add money again. Ask your agent to check your balance later.',
    };
  return {
    step: {
      id: 'fund',
      question: FUND_QUESTION,
      options: [
        {
          id: 'fund',
          label: `Add $${SUGGESTED_FUND_USD}`,
          recommended: true,
          command: `${command} --source install`,
        },
        { id: 'later', label: 'Not now', recommended: false, command: null },
      ],
      next: `${process.platform === 'win32' ? 'Use PowerShell. ' : ''}Ask this once, after the limits question, with both options: Add $${SUGGESTED_FUND_USD} opens checkout in their browser; with Not now, you ask when a task first needs a paid tool. On Add $${SUGGESTED_FUND_USD}, run its command yourself: opening checkout moves no money, and the person confirms the payment in their browser. Then follow that command's nextStep: run \`tenjin balance --wait\` in the background and carry on when it exits. Never ask the person to type "done". On Not now, continue activation and their task with the tools available, and do not offer funding again unless they ask.`,
    },
  };
}

/** The money question, in a terminal and for an agent alike. */
export const FUND_QUESTION = `Add $${SUGGESTED_FUND_USD} to your balance now?`;

async function defaultBalance(address: string, rpcUrl: string): Promise<bigint> {
  const { getUsdcBalance } = await import('../lib/usdc');
  return getUsdcBalance(address as `0x${string}`, rpcUrl);
}

/** Both host installers share one wallet and one funding offer per command. */
export function fundingOncePerRun(check: FundingCheck = fundStep): FundingCheck {
  const checked = new Set<string>();
  return async (wallet, rpcUrl, deps, command) => {
    if (wallet.address === undefined || checked.has(wallet.address)) return undefined;
    checked.add(wallet.address);
    return check(wallet, rpcUrl, deps, command);
  };
}

function pendingFund(data: unknown): FundStep | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.hosts)) {
    for (const host of record.hosts) {
      if (typeof host !== 'string') continue;
      const step = pendingFund(record[host]);
      if (step !== undefined) return step;
    }
    return undefined;
  }
  return Array.isArray(record.nextSteps)
    ? (record.nextSteps as QuestionStep[]).find((step): step is FundStep => step.id === 'fund')
    : undefined;
}

/**
 * THE MONEY QUESTION IN A TERMINAL, after the receipt and before its tail:
 * the receipt is visible before checkout and stays true if checkout fails.
 * "Add $5" opens checkout and watches the payment land, with the live
 * status `tenjin fund` draws; the balance, the limits, the next step and the
 * disclosure close the output either way.
 */
export async function finishTerminalFunding(
  result: CommandResult,
  ctx: CommandContext,
  opts: {
    yes?: boolean;
    isInteractive?: boolean;
    ask?: () => Promise<'fund' | 'later' | null>;
    fund?: (ctx: CommandContext, opts: FundOptions) => ReturnType<typeof runFund>;
  } = {},
): Promise<CommandResult> {
  if (opts.yes || ctx.flags.json || !ctx.io.isTTY || !(opts.isInteractive ?? process.stdin.isTTY))
    return result;
  const step = pendingFund(result.data);
  if (step === undefined) return result;
  emitSuccess(ctx.io, 'install', result.data, result.humanLines);
  const answer = await (
    opts.ask ??
    (() =>
      selectOne({
        message: step.question,
        choices: [
          {
            value: 'fund',
            label: `Add $${SUGGESTED_FUND_USD}`,
            hint: 'opens checkout in your browser',
          },
          {
            value: 'later',
            label: 'Not now',
            hint: 'your agent asks when it first needs a paid tool',
          },
        ],
        initialValue: 'fund',
      }))
  )();
  if (answer !== 'fund') return { ...result, humanLines: [] };
  try {
    const run = opts.fund ?? (await import('../commands/fund')).runFund;
    const funded = await run(ctx, {
      amountUsd: String(SUGGESTED_FUND_USD),
      source: 'install',
      header: false,
    });
    const data = funded.data as {
      funded?: boolean;
      pollStatus?: string;
      balance?: { atomic: string };
    };
    return {
      ...result,
      humanLines:
        data.funded === true && data.balance !== undefined
          ? ['', `Balance   $${usd(BigInt(data.balance.atomic))}`]
          : data.pollStatus === 'skipped'
            ? []
            : [
                '',
                "The payment hasn't reached your balance yet. It still can, and your agent can check it.",
              ],
    };
  } catch (error) {
    return {
      ...result,
      humanLines: [
        `Checkout could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        'Tenjin remains installed. Ask your agent to add funds later.',
      ],
    };
  }
}
