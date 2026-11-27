import type { Hex } from 'viem';
import { CliError } from '../lib/errors';
import { toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { resolveWalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';
import { BatchSeller } from '../router/neon-seller';
import { NeonRefunds, type ChannelEntry, type WithdrawChain } from '../router/neon-refund';
import { withdrawChain } from '../router/neon-withdraw';
import { ModelJobStore } from '../router/model-job';
import { chainReader } from '../router/routing-payer';

const dollars = (atomic: string) => `$${toMoney(atomic).usd}`;

/** One channel in a person's words. */
function line(entry: ChannelEntry): string {
  const who = new URL(entry.terms.url).host;
  switch (entry.state) {
    case 'refunded':
      return `● ${who}: refunded${entry.refundedAtomic ? ` ${dollars(entry.refundedAtomic)}` : ''} to your wallet`;
    case 'withdrawn':
      return `● ${who}: withdrawn ${dollars(entry.refundedAtomic ?? '0')} to your wallet`;
    case 'empty':
      return `○ ${who}: nothing left in the channel`;
    case 'withdrawal_started': {
      const w = entry.withdrawal;
      return w
        ? `◐ ${who}: withdrawal of ${dollars(w.amountAtomic)} started; it can be finished ${w.delayS} seconds after it began. Run \`tenjin refund\` again then.`
        : `◐ ${who}: withdrawal started. Run \`tenjin refund\` again after its wait.`;
    }
    default:
      return `✗ ${who}: not refunded yet${entry.note ? ` (${entry.note})` : ''}. Run \`tenjin refund\` again.`;
  }
}

/**
 * `tenjin refund`: asks again for the remainder of every Neon channel a job left, from the seller
 * and payee each job was paid under (saved with the job, never looked up again). A seller that
 * does not answer the cooperative refund gets the channel's timed on-chain withdrawal, which
 * costs a little gas and waits the channel's delay before it can be finished.
 */
export async function runRefund(
  ctx: CommandContext,
  deps: { refunds?: NeonRefunds; chain?: WithdrawChain } = {},
): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(ctx, {});
  const refunds =
    deps.refunds ??
    new NeonRefunds({
      dataDir: ctx.dataDir,
      // A channel a Neon job in another session still pays from is left alone.
      live: (jobId) => new ModelJobStore(ctx.dataDir).runnerLive(jobId),
      payer: (terms, salt) =>
        new BatchSeller({
          dataDir: ctx.dataDir,
          terms,
          ...(salt ? { salt: salt as Hex } : {}),
          provider,
          admit: async () => {
            throw new CliError('POLICY_REFUSED', 'A refund deposits nothing.');
          },
          readContract: chainReader(settings.rpcUrl),
        }),
    });
  const chain =
    deps.chain ?? withdrawChain({ signer: await provider.getSigner(), rpcUrl: settings.rpcUrl });
  const channels = await refunds.retry(chain);
  const open = channels.filter((entry) => entry.state !== 'empty');
  return {
    data: {
      channels: channels.map((entry) => ({
        seller: new URL(entry.terms.url).host,
        state: entry.state,
        ...(entry.refundedAtomic ? { refundedAtomic: entry.refundedAtomic } : {}),
        ...(entry.transaction ? { transaction: entry.transaction } : {}),
        ...(entry.withdrawal ? { withdrawal: entry.withdrawal } : {}),
        ...(entry.note ? { note: entry.note } : {}),
      })),
    },
    humanLines:
      channels.length === 0
        ? ['  No Neon channel is on record.']
        : (open.length > 0 ? open : channels).map(line),
  };
}
