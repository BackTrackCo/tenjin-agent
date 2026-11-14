import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { payerDir } from './fee';
import { modelChannelDir } from './model-channel';

/**
 * The wallet's routing channels, from the SDK's own files: what each one was
 * deposited (`balance`) and what the router has charged against it
 * (`chargedCumulativeAmount`). Local estimates, with no chain read.
 *
 * Not hook-safe (it loads the x402 SDK's storage), so `fee.ts` does not carry it.
 */
async function channels(
  dataDir: string,
  address: string,
  lane: 'tool' | 'model' | 'model-routing' = 'tool',
  origin?: string,
): Promise<{ depositedAtomic: bigint; leftAtomic: bigint }[]> {
  const base = payerDir(dataDir, address);
  if (lane !== 'tool' && !origin) throw new Error('Model credit requires its server origin');
  const dir =
    lane === 'tool'
      ? base
      : modelChannelDir(
          dataDir,
          address,
          lane === 'model' ? 'model-inference' : 'model-routing',
          origin!,
        );
  const storage = new FileClientChannelStorage({ directory: dir });
  const out: { depositedAtomic: bigint; leftAtomic: bigint }[] = [];
  for (const name of await readdir(join(dir, 'client')).catch(() => [] as string[])) {
    const id = /^(0x[0-9a-f]{64})\.json$/.exec(name)?.[1];
    const channel = id === undefined ? undefined : await storage.get(id).catch(() => undefined);
    if (channel === undefined) continue;
    const depositedAtomic = BigInt(channel.balance ?? '0');
    const left = depositedAtomic - BigInt(channel.chargedCumulativeAmount ?? '0');
    out.push({ depositedAtomic, leftAtomic: left > 0n ? left : 0n });
  }
  return out;
}

/**
 * What the wallet's routing channel still holds for fees: what was deposited
 * less what the router has charged against it. It is the estimate of funds set
 * aside for routing that status and wallet balance show, and what
 * `tenjin doctor` reads to know whether the next call needs a deposit.
 */
export async function channelCredit(
  dataDir: string,
  address: string,
  lane: 'tool' | 'model' | 'model-routing' = 'tool',
  origin?: string,
): Promise<bigint> {
  let best = 0n;
  for (const { leftAtomic } of await channels(dataDir, address, lane, origin)) {
    if (leftAtomic > best) best = leftAtomic;
  }
  return best;
}

/**
 * WHAT ROUTING HAS COST, the routing total status and wallet balance show:
 * the deposits sent less the credit they still hold, over every channel file
 * this wallet has here. Offers show no fee, so this is where a person finds it.
 */
export async function routingSpent(dataDir: string, address: string): Promise<bigint> {
  let total = 0n;
  for (const { depositedAtomic, leftAtomic } of await channels(dataDir, address)) {
    total += depositedAtomic - leftAtomic;
  }
  return total;
}
