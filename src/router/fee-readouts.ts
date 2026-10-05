import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { currentPayerDir, feesInWindowFor } from './fee-state';

/**
 * THE ROUTING FEE AS `tenjin status` AND `tenjin payments fees` SHOW IT, for
 * the wallet that paid last. Each channel is read through the SDK's own file
 * storage, which holds what it was deposited and what it has been charged; the
 * window comes from the fee lines. Nothing is sent.
 */
export interface FeeSummary {
  channels: { channelId: string; depositedAtomic: string; chargedAtomic: string }[];
  /** Everything the server has charged across the channels, all time. */
  chargedAtomic: string;
  /** What the channels still hold for future fees. */
  creditAtomic: string;
  /** Fees charged in the rolling 24 h window. */
  windowAtomic: string;
}

const CHANNEL_FILE_RE = /^(0x[0-9a-f]{64})\.json$/;

export async function feeSummary(dataDir: string, now: number): Promise<FeeSummary> {
  const dir = await currentPayerDir(dataDir);
  const channels: FeeSummary['channels'] = [];
  if (dir === null) return { channels, chargedAtomic: '0', creditAtomic: '0', windowAtomic: '0' };
  const storage = new FileClientChannelStorage({ directory: dir });
  const ids = (await readdir(join(dir, 'client')).catch(() => [] as string[]))
    .map((name) => CHANNEL_FILE_RE.exec(name)?.[1])
    .filter((id): id is string => id !== undefined)
    .sort();
  let charged = 0n;
  let credit = 0n;
  for (const channelId of ids) {
    const ctx = await storage.get(channelId).catch(() => undefined);
    if (ctx === undefined) continue;
    const balance = BigInt(ctx.balance ?? '0');
    const spent = BigInt(ctx.chargedCumulativeAmount ?? '0');
    charged += spent;
    if (balance > spent) credit += balance - spent;
    channels.push({
      channelId,
      depositedAtomic: balance.toString(),
      chargedAtomic: spent.toString(),
    });
  }
  return {
    channels,
    chargedAtomic: charged.toString(),
    creditAtomic: credit.toString(),
    windowAtomic: (await feesInWindowFor(dir, now)).toString(),
  };
}
