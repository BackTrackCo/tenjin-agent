import { CliError } from '../lib/errors';
import { liveLine, type LiveLine } from '../lib/live-line';
import { toMoney } from '../lib/money';
import { paint } from '../lib/output';
import { resolveContextSettings } from '../lib/settings';
import { readUsdcBalanceWithFallback } from '../lib/usdc-balance';
import {
  describeWallet,
  resolveWalletProvider,
  type ResolveWalletProviderOptions,
} from '../lib/wallet';
import type { SpendPolicy } from '../lib/policy';
import { channelCredit } from '../router/channel-credit';
import { FUND_COMMAND_LINE, ROUTING_FEE_CEILING_ATOMIC } from '../router/fee';
import { limitsLine } from '../router/spend-question';
import { dollars, forgetLink, recallLink, watchFunding } from './fund-watch';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin balance` (and `tenjin wallet balance`): the balance in dollars, the
 * limits that apply to it, and a word only when it needs attention. A chain
 * read: no key is unlocked and nothing is spent.
 *
 * `--wait` reads it, then watches until it rises: what an agent runs in the
 * background after opening checkout, so it wakes when the money lands. A link
 * `tenjin fund` issued recently is followed by its payment status too, and an
 * arrival that already happened before the wait started still counts.
 */

/** How long `--wait` waits by default. */
export const DEFAULT_WAIT_MS = 15 * 60_000;
/** Labels line up at this width: `Balance   `, `Limits    `. */
const LABEL_WIDTH = 10;

export interface BalanceOptions extends ResolveWalletProviderOptions {
  wait?: boolean;
  /** `--timeout` with `--wait`, in ms. */
  waitMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  live?: LiveLine;
}

/** A balance is low below the per-call limit: the next automatic call may not
 *  fit. `tenjin balance` and `tenjin status` both say so by this rule. */
export function lowBalance(
  atomic: bigint,
  policy: Pick<SpendPolicy, 'maxAutoSpendAtomic'>,
): boolean {
  return atomic < policy.maxAutoSpendAtomic;
}

/** How long one balance read may take, across the RPCs it may ask. */
export const BALANCE_READ_MS = 5_000;

/**
 * THE BALANCE, READ THE ONE WAY: this wallet's address and the USDC it holds
 * on Base. `tenjin balance` and `tenjin status` both read it here, so the two
 * never disagree. It reads the configured RPC and, only when that is the
 * default one, retries the public Base RPCs a lookup falls back to
 * (`readUsdcBalanceWithFallback`); an RPC the user set is the only one asked.
 * Throws `RPC_ERROR` on a read none of them answered.
 */
export async function balanceReader(
  ctx: CommandContext,
  opts: ResolveWalletProviderOptions & { rpcFetchImpl?: typeof fetch } = {},
): Promise<{ address: `0x${string}`; read: () => Promise<bigint> }> {
  const provider = resolveWalletProvider(ctx, opts);
  const desc = await describeWallet(provider);
  const { rpcUrl } = await resolveContextSettings(ctx);
  const read = async (): Promise<bigint> => {
    const atomic = await readUsdcBalanceWithFallback(desc.address, rpcUrl, {
      timeoutMs: BALANCE_READ_MS,
      ...(opts.rpcFetchImpl !== undefined ? { fetchImpl: opts.rpcFetchImpl } : {}),
    });
    if (atomic !== null) return atomic;
    throw new CliError('RPC_ERROR', `Could not read the USDC balance from ${rpcUrl}.`, {
      fix: 'Check your network, or set a working RPC with `tenjin config set rpcUrl <url>`.',
    });
  };
  return { address: desc.address, read };
}

export async function runBalance(
  ctx: CommandContext,
  opts: BalanceOptions = {},
): Promise<CommandResult> {
  const { address, read } = await balanceReader(ctx, opts);
  const settings = await resolveContextSettings(ctx);

  if (opts.wait === true) return waitForFunds(ctx, address, read, opts);

  const atomic = await read();

  const balance = toMoney(atomic.toString());
  // The routing balance is a local estimate, separate from on-chain funds.
  const creditAtomic = await channelCredit(ctx.dataDir, address).catch(() => 0n);
  const credit = toMoney(creditAtomic.toString());
  const modelCreditAtomic = await channelCredit(ctx.dataDir, address, 'model').catch(() => 0n);
  const policy = settings.policy;
  const low = lowBalance(atomic, policy);
  const label = (text: string) => `  ${text.padEnd(LABEL_WIDTH)}`;
  return {
    data: {
      address,
      balance,
      routingCredit: credit,
      modelCredit: toMoney(modelCreditAtomic.toString()),
      limits: limitsData(policy),
      low,
    },
    humanLines: [
      `${label('Balance')}${paint(ctx.io, 'bold', dollars(atomic))}${low ? `  ${paint(ctx.io, 'yellow', 'low')}` : ''}`,
      `${label('Limits')}${limitsLine(policy)}`,
      ...(creditAtomic > 0n
        ? [`${label('Set aside')}about ${dollars(creditAtomic)} for routing`]
        : []),
      ...(modelCreditAtomic > 0n
        ? [`${label('Subagents')}about ${dollars(modelCreditAtomic)} set aside for model calls`]
        : []),
      ...(atomic === 0n && creditAtomic < ROUTING_FEE_CEILING_ATOMIC
        ? ['', `  ${FUND_COMMAND_LINE}`]
        : []),
    ],
  };
}

function limitsData(policy: SpendPolicy): { maxAutoSpend: string; sessionBudget: string } {
  return {
    maxAutoSpend: toMoney(policy.maxAutoSpendAtomic.toString()).usd,
    sessionBudget:
      policy.sessionBudgetAtomic === null
        ? 'none'
        : toMoney(policy.sessionBudgetAtomic.toString()).usd,
  };
}

async function waitForFunds(
  ctx: CommandContext,
  address: string,
  read: () => Promise<bigint>,
  opts: BalanceOptions,
): Promise<CommandResult> {
  const now = opts.now ?? Date.now;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = now() + waitMs;
  const human = ctx.io.isTTY && !ctx.flags.json;
  const live = opts.live ?? liveLine(ctx.io.stderr);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const soft = () => read().catch(() => undefined);

  // The baseline must be a real read: a wait measured from a guess could
  // report money that was already there, or miss money that is.
  let start = await soft();
  while (start === undefined) {
    if (now() >= deadline) await read();
    await sleep(opts.intervalMs ?? 2_000);
    start = await soft();
  }

  // The link `tenjin fund` issued, followed by its status when it has one (a
  // hosted link does not). Money that landed after that link was issued and
  // before this wait began is an arrival too.
  const link = await recallLink(ctx.dataDir, address, now());
  const linkStart =
    link?.startBalanceAtomic !== undefined ? BigInt(link.startBalanceAtomic) : undefined;
  const from = linkStart !== undefined && linkStart < start ? linkStart : start;

  const end =
    from < start
      ? { kind: 'arrived' as const, balance: start, added: start - from }
      : await watchFunding({
          startBalance: from,
          readBalance: soft,
          ...(link?.token !== undefined ? { token: link.token } : {}),
          deadline,
          view: 'funds',
          ...(human ? { live } : {}),
          ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
          ...(opts.intervalMs !== undefined ? { intervalMs: opts.intervalMs } : {}),
          now,
        });
  live.stop();

  if (end.kind !== 'arrived') {
    throw new CliError(
      'RESOURCE_NOT_FOUND',
      `No funds arrived in ${duration(waitMs)}. Nothing went wrong: a payment still on its way lands in your balance on its own.`,
      {
        fix: 'Run `tenjin balance` to check again later, or `tenjin fund` to add funds.',
        details: {
          arrived: false,
          balance: toMoney(start.toString()),
          ...('status' in end && end.status !== undefined ? { status: end.status.state } : {}),
        },
      },
    );
  }
  if (link !== null) await forgetLink(ctx.dataDir);
  const creditAtomic = await channelCredit(ctx.dataDir, address).catch(() => 0n);
  const modelCreditAtomic = await channelCredit(ctx.dataDir, address, 'model').catch(() => 0n);
  const line = `+${dollars(end.added)} · balance ${dollars(end.balance)}`;
  return {
    data: {
      address,
      arrived: true,
      added: toMoney(end.added.toString()),
      balance: toMoney(end.balance.toString()),
      routingCredit: toMoney(creditAtomic.toString()),
      modelCredit: toMoney(modelCreditAtomic.toString()),
      summary: line,
    },
    humanLines: [human ? `  ${line}` : line],
  };
}

/** `15 minutes`, `90 seconds`, `1 hour`. */
function duration(ms: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (ms % 3_600_000 === 0) return plural(ms / 3_600_000, 'hour');
  if (ms % 60_000 === 0) return plural(ms / 60_000, 'minute');
  return plural(Math.round(ms / 1000), 'second');
}
