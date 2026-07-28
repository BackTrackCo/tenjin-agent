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

// The chain boundary for `tenjin send`, two-phase around the human confirm:
// prepareUsdcSend (read-only: encode, nonce, gas, fees, ETH-for-gas balance)
// runs BEFORE the confirm so the prompt can show the fee, broadcastUsdcSend
// (sign via the TenjinSigner seam, broadcast, wait for the receipt) runs after.
// Command tests mock this whole module, so no test can ever reach a real chain.

/**
 * Ceilings on the RPC-supplied gas and fee fields. The RPC endpoint is
 * config-controlled and its estimates go straight into the signed transaction; a
 * hostile or broken endpoint returning huge values would burn the wallet's ETH
 * as fees. An ERC-20 transfer is ~65k gas and Base fees run well under a gwei,
 * so estimates past these bounds mean something is wrong: refuse, never clamp
 * (a clamped maxFeePerGas below the real base fee would just strand the tx).
 */
export const SEND_GAS_CAP = 150_000n;
export const SEND_MAX_FEE_PER_GAS_CAP = 10_000_000_000n; // 10 gwei
export const SEND_MAX_PRIORITY_FEE_CAP = 2_000_000_000n; // 2 gwei

/** An RPC gas/fee estimate exceeded the send ceilings; nothing was signed. */
export class FeeCapExceededError extends Error {
  constructor(field: string, value: bigint, cap: bigint) {
    super(`${field} estimate ${value} exceeds the send ceiling ${cap}`);
    this.name = 'FeeCapExceededError';
  }
}

/** The transfer was mined but reverted; the fee was spent, the USDC did not move. */
export class SendRevertedError extends Error {
  constructor(readonly txHash: Hex) {
    super(`Transaction ${txHash} reverted`);
    this.name = 'SendRevertedError';
  }
}

/** Broadcast succeeded but no receipt arrived in time; the tx may still mine. */
export class SendPendingError extends Error {
  constructor(readonly txHash: Hex) {
    super(`Transaction ${txHash} was broadcast but not confirmed in time`);
    this.name = 'SendPendingError';
  }
}

export interface PrepareUsdcSendArgs {
  from: Address;
  to: Address;
  amountAtomic: bigint;
  rpcUrl: string;
}

/** Everything signed later, fixed at prepare time, plus the gas-cost preview. */
export interface PreparedUsdcSend {
  to: Address;
  amountAtomic: bigint;
  data: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** Worst-case fee (gas * maxFeePerGas), for the confirm prompt and gas check. */
  feeWei: bigint;
  /** The sender's native ETH balance, for the has-gas pre-check. */
  ethBalanceWei: bigint;
}

export async function prepareUsdcSend({
  from,
  to,
  amountAtomic,
  rpcUrl,
}: PrepareUsdcSendArgs): Promise<PreparedUsdcSend> {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amountAtomic],
  });
  const [nonce, gas, fees, ethBalanceWei] = await Promise.all([
    client.getTransactionCount({ address: from, blockTag: 'pending' }),
    client.estimateGas({ account: from, to: USDC_ADDRESS, data }),
    client.estimateFeesPerGas(),
    client.getBalance({ address: from }),
  ]);
  assertUnderCap('gas', gas, SEND_GAS_CAP);
  assertUnderCap('maxFeePerGas', fees.maxFeePerGas, SEND_MAX_FEE_PER_GAS_CAP);
  assertUnderCap('maxPriorityFeePerGas', fees.maxPriorityFeePerGas, SEND_MAX_PRIORITY_FEE_CAP);
  return {
    to,
    amountAtomic,
    data,
    nonce,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    feeWei: gas * fees.maxFeePerGas,
    ethBalanceWei,
  };
}

export interface BroadcastUsdcSendArgs {
  signer: TenjinSigner;
  prepared: PreparedUsdcSend;
  rpcUrl: string;
  /** Receipt wait bound in ms; Base blocks are ~2s, so the default is generous. */
  receiptTimeoutMs?: number;
}

/**
 * Sign the prepared transfer through the TenjinSigner seam (never a raw key),
 * broadcast it, and wait for the receipt so "sent" means mined. Throws
 * SendRevertedError (mined but failed) or SendPendingError (no receipt in time);
 * both carry the hash so the caller can report it either way.
 */
export async function broadcastUsdcSend({
  signer,
  prepared,
  rpcUrl,
  receiptTimeoutMs = 120_000,
}: BroadcastUsdcSendArgs): Promise<Hex> {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const serializedTransaction = await signer.signTransaction({
    type: 'eip1559',
    chainId: base.id,
    to: USDC_ADDRESS,
    data: prepared.data,
    nonce: prepared.nonce,
    gas: prepared.gas,
    maxFeePerGas: prepared.maxFeePerGas,
    maxPriorityFeePerGas: prepared.maxPriorityFeePerGas,
  });
  const txHash = await client.sendRawTransaction({ serializedTransaction });
  let receipt;
  try {
    receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: receiptTimeoutMs });
  } catch {
    throw new SendPendingError(txHash);
  }
  if (receipt.status !== 'success') throw new SendRevertedError(txHash);
  return txHash;
}

function assertUnderCap(field: string, value: bigint, cap: bigint): void {
  if (value > cap) throw new FeeCapExceededError(field, value, cap);
}
