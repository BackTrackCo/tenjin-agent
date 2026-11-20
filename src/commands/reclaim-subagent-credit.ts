import { toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { resolveWalletProvider } from '../lib/wallet';
import { ModelRefundJournal } from '../router/model-refund';
import { chainReader, chainRefundReads } from '../router/routing-payer';
import { dollars } from './fund-watch';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin wallet reclaim-subagent-credit`: a ONE-TIME recovery, run by the person, of the
 * credit that earlier dev builds left parked in the two old shared inference channels
 * (`tenjin balance --json` shows it as `modelCredit`). Each channel that still holds credit
 * is refunded to the wallet through the same cooperative refund a run's channel gets at its
 * end. Safe to run twice: a second run finds nothing. Delete it, `modelCredit` and
 * `legacySharedInferenceChannel` together once no machine holds such a channel.
 */
export async function runReclaimSubagentCredit(
  ctx: CommandContext,
  deps: Partial<ConstructorParameters<typeof ModelRefundJournal>[2]> = {},
): Promise<CommandResult> {
  const settings = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(ctx, {});
  const journal = new ModelRefundJournal(ctx.dataDir, settings.baseUrl, {
    getSigner: () => provider.getSigner(),
    readContract: chainReader(settings.rpcUrl),
    ...chainRefundReads(settings.rpcUrl),
    ...deps,
  });
  const found = await journal.reclaimSharedCredit();
  const returned = found.flatMap(({ slot, channelId, result }) =>
    result.state === 'refunded'
      ? [
          {
            slot,
            channel: channelId,
            amount: toMoney(result.amountAtomic),
            transaction: result.transaction,
          },
        ]
      : [],
  );
  const left = found
    .filter(({ result }) => result.state !== 'refunded')
    .map(({ slot, channelId, result }) => ({ slot, channel: channelId, state: result.state }));
  return {
    data: { returned, notReturned: left },
    humanLines:
      found.length === 0
        ? ['  Nothing is parked in the old shared subagent channels.']
        : [
            ...returned.map(
              (r) =>
                `  Returned ${dollars(BigInt(r.amount.atomic))} to your wallet, transaction ${r.transaction}`,
            ),
            ...left.map(
              (r) => `  Channel ${r.channel.slice(0, 10)} is ${r.state}; run this again later.`,
            ),
          ],
  };
}
