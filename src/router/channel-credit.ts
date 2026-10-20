import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { payerDir } from './fee';

/**
 * What the wallet's routing channel still holds for fees, from the SDK's own
 * files: what was deposited less what the router has charged against it. It is
 * the prepaid routing credit `tenjin status` and `tenjin wallet balance` show,
 * and what `tenjin doctor` reads to know whether the next call needs a deposit.
 *
 * Not hook-safe (it loads the x402 SDK's storage), so `fee.ts` does not carry it.
 */
export async function channelCredit(dataDir: string, address: string): Promise<bigint> {
  const dir = payerDir(dataDir, address);
  const storage = new FileClientChannelStorage({ directory: dir });
  let best = 0n;
  for (const name of await readdir(join(dir, 'client')).catch(() => [] as string[])) {
    const id = /^(0x[0-9a-f]{64})\.json$/.exec(name)?.[1];
    const channel = id === undefined ? undefined : await storage.get(id).catch(() => undefined);
    if (channel === undefined) continue;
    const credit = BigInt(channel.balance ?? '0') - BigInt(channel.chargedCumulativeAmount ?? '0');
    if (credit > best) best = credit;
  }
  return best;
}
