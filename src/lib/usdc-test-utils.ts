import { vi } from 'vitest';
import type { Address } from 'viem';
import { getUsdcBalance } from './usdc';
import type * as UsdcBalance from './usdc-balance';

/**
 * `usdc-balance` with its public-RPC fallback read answered by `getUsdcBalance`,
 * for a test that mocks that per-RPC reader: one mock drives every balance
 * read, the fallback's (`balanceReader`) and a direct one, and none reaches a
 * chain. For the test's `vi.mock('../lib/usdc-balance')` factory, beside its
 * mock of `../lib/usdc`. Not bundled into dist: only tests import it.
 */
export function bridgedUsdcBalance(orig: typeof UsdcBalance): typeof UsdcBalance {
  return {
    ...orig,
    readUsdcBalanceWithFallback: vi.fn(async (address: string, rpcUrl: string) =>
      getUsdcBalance(address as Address, rpcUrl).catch(() => null),
    ),
  };
}
