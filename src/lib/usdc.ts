import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import type { TenjinSigner } from './wallet/provider';

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

export interface SendUsdcArgs {
  signer: TenjinSigner;
  to: Address;
  amountAtomic: bigint;
  rpcUrl: string;
}

/**
 * The chain boundary for `tenjin send`: build an ERC-20 `transfer` on Base, sign
 * it through the TenjinSigner seam (the same seam every other signature uses —
 * never a raw key), and broadcast it. Returns the transaction hash on a
 * successful broadcast; it does NOT wait for a receipt. Command tests mock this
 * whole module, so no test can ever reach a real chain.
 */
export async function sendUsdc({ signer, to, amountAtomic, rpcUrl }: SendUsdcArgs): Promise<Hex> {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amountAtomic],
  });
  const [nonce, gas, fees] = await Promise.all([
    client.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
    client.estimateGas({ account: signer.address, to: USDC_ADDRESS, data }),
    client.estimateFeesPerGas(),
  ]);
  const serializedTransaction = await signer.signTransaction({
    type: 'eip1559',
    chainId: base.id,
    to: USDC_ADDRESS,
    data,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  return client.sendRawTransaction({ serializedTransaction });
}
