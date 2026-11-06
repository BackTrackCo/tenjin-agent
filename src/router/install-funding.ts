import type { WalletOutcome } from '../commands/install-wallet';
import type { FundOptions, runFund } from '../commands/fund';
import type { CommandContext, CommandResult } from '../context';
import { selectOne } from '../lib/clack';
import { emitSuccess } from '../lib/output';
import { SUGGESTED_FUND_USD } from './fee';
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

/** Checking an empty wallet never mints checkout; only the person's later yes does. */
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
      question: `Add $${SUGGESTED_FUND_USD} to Tenjin now?`,
      options: [
        { id: 'fund', label: `Add $${SUGGESTED_FUND_USD}`, recommended: false, command },
        { id: 'later', label: 'Not now', recommended: false, command: null },
      ],
      next: `${process.platform === 'win32' ? 'Use PowerShell. ' : ''}Ask this question once. On "Add $${SUGGESTED_FUND_USD}", run that option's command alone and follow its nextStep. Run it only after their yes. On "Not now", run nothing and continue activation and the original task. Do not offer funding again unless requested. When the selected option includes a command, run it yourself; never ask the person to run it.`,
    },
  };
}

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

/** The setup receipt is visible before checkout, and remains true if checkout fails. */
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
          { value: 'fund', label: `Add $${SUGGESTED_FUND_USD}` },
          { value: 'later', label: 'Not now' },
        ],
        initialValue: 'later',
      }))
  )();
  if (answer !== 'fund') return { ...result, humanLines: [] };
  try {
    const run = opts.fund ?? (await import('../commands/fund')).runFund;
    const funded = await run(ctx, {
      amountUsd: String(SUGGESTED_FUND_USD),
      wait: false,
      qr: false,
    });
    return { ...result, humanLines: funded.humanLines };
  } catch (error) {
    return {
      ...result,
      humanLines: [
        `Checkout could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        'Tenjin remains installed. Continue the activation step above. Ask your agent to add funds later.',
      ],
    };
  }
}
