import { createPublicClient, erc20Abi, http, type Address } from 'viem';
import { base } from 'viem/chains';

// Values mirror the app's lib/chain.ts Base mainnet entry (chain 8453).
export const USDC_ADDRESS: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDC_DECIMALS = 6;

export async function getUsdcBalance(address: Address, rpcUrl: string): Promise<bigint> {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  return client.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
}
