import { decodePaymentRequiredHeader } from '@x402/core/http';
import { BATCH_SETTLEMENT_ADDRESS } from '@x402/evm';
import { computeChannelId } from '@x402/evm/batch-settlement/client';
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import type { TenjinSigner } from '../lib/wallet/provider';
import { SEND_MAX_FEE_PER_GAS_CAP, SEND_MAX_PRIORITY_FEE_CAP } from '../lib/usdc';
import type { WithdrawChain } from './neon-refund';
import { pinnedFetch } from './pinned-fetch';
import type { NeonTerms } from './neon-terms';

/**
 * THE CHANNEL'S TIMED WITHDRAWAL, the fallback of `tenjin refund` where the seller does not
 * answer a cooperative refund. The payer starts the withdrawal on chain, waits the channel's own
 * delay (900 s unless the seller set more), and finishes it. Each step is one transaction from
 * the person's wallet, paid in gas. It runs only when the person runs `tenjin refund`.
 *
 * The channel is found from the seller's own 402, whose payee must be the one the job was paid
 * to: a seller that now names another payee is refused, and no transaction is sent.
 */
const channelConfig = [
  { name: 'payer', type: 'address' },
  { name: 'payerAuthorizer', type: 'address' },
  { name: 'receiver', type: 'address' },
  { name: 'receiverAuthorizer', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'withdrawDelay', type: 'uint40' },
  { name: 'salt', type: 'bytes32' },
] as const;
export const withdrawAbi = [
  {
    type: 'function',
    name: 'channels',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [
      { name: 'balance', type: 'uint128' },
      { name: 'totalClaimed', type: 'uint128' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'pendingWithdrawals',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [
      { name: 'amount', type: 'uint128' },
      { name: 'initiatedAt', type: 'uint40' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'initiateWithdraw',
    inputs: [
      { name: 'config', type: 'tuple', components: channelConfig },
      { name: 'amount', type: 'uint128' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'finalizeWithdraw',
    inputs: [{ name: 'config', type: 'tuple', components: channelConfig }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/** The SDK's own channel salt: the scheme this build pays with never sets another. */
const SALT: Hex = `0x${'0'.repeat(64)}`;
/** A withdrawal step is one contract call: far under this, so an odd estimate is refused. */
const WITHDRAW_GAS_CAP = 400_000n;

export type WithdrawDeps = {
  signer: TenjinSigner;
  rpcUrl: string;
  fetchImpl?: typeof fetch;
};

/**
 * THE CHANNEL'S CONFIG. A funded channel's config is kept from the call that funded it, so a
 * withdrawal never needs the seller to answer, and a seller that later names another receiver
 * authorizer or delay cannot point recovery at another channel. Only a record from before the
 * config was kept reads the seller's live 402 for the saved URL, whose payee must be the one the
 * job was paid to.
 */
export async function channelConfigOf(
  terms: NeonTerms,
  saved: { payer: string; receiverAuthorizer: string; withdrawDelay: number } | undefined,
  deps: WithdrawDeps,
) {
  const wallet = getAddress(deps.signer.address);
  let receiverAuthorizer: string;
  let withdrawDelay: number;
  if (saved) {
    if (getAddress(saved.payer) !== wallet)
      throw new Error('This channel was funded by another wallet than the one that is open');
    receiverAuthorizer = saved.receiverAuthorizer;
    withdrawDelay = saved.withdrawDelay;
  } else {
    const probe = await (deps.fetchImpl ?? pinnedFetch())(terms.url, { method: 'GET' });
    const header = probe.headers.get('PAYMENT-REQUIRED');
    if (probe.status !== 402 || !header)
      throw new Error('The seller did not answer with its payment terms');
    const requirements = decodePaymentRequiredHeader(header).accepts.find(
      (accepted) => accepted.scheme === terms.scheme,
    );
    if (!requirements) throw new Error('The seller no longer offers the batch-settlement scheme');
    if (requirements.payTo.toLowerCase() !== terms.payTo.toLowerCase())
      throw new Error('The seller now names another payee than the one this job was paid to');
    const extra = requirements.extra as
      { receiverAuthorizer?: string; withdrawDelay?: number } | undefined;
    if (!extra?.receiverAuthorizer) throw new Error('The seller names no receiver authorizer');
    receiverAuthorizer = extra.receiverAuthorizer;
    withdrawDelay = typeof extra.withdrawDelay === 'number' ? extra.withdrawDelay : 900;
  }
  const config = {
    payer: wallet,
    payerAuthorizer: wallet,
    receiver: getAddress(terms.payTo),
    receiverAuthorizer: getAddress(receiverAuthorizer),
    token: getAddress(terms.asset),
    withdrawDelay,
    salt: SALT,
  };
  return { config, id: computeChannelId(config, terms.network) };
}

/** The chain side of `tenjin refund`: reads, and one signed transaction per step. */
export function withdrawChain(deps: WithdrawDeps): WithdrawChain {
  const client = createPublicClient({ chain: base, transport: http(deps.rpcUrl) });
  const contract = BATCH_SETTLEMENT_ADDRESS as Address;
  const send = async (data: Hex): Promise<string> => {
    const from = getAddress(deps.signer.address);
    const [nonce, gas, fees] = await Promise.all([
      client.getTransactionCount({ address: from, blockTag: 'pending' }),
      client.estimateGas({ account: from, to: contract, data }),
      client.estimateFeesPerGas(),
    ]);
    if (
      gas > WITHDRAW_GAS_CAP ||
      fees.maxFeePerGas > SEND_MAX_FEE_PER_GAS_CAP ||
      fees.maxPriorityFeePerGas > SEND_MAX_PRIORITY_FEE_CAP
    )
      throw new Error('The network asks for more gas or fee than a withdrawal step may spend');
    const serializedTransaction = await deps.signer.signTransaction({
      type: 'eip1559',
      chainId: base.id,
      to: contract,
      value: 0n,
      data,
      nonce,
      gas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const hash = await client.sendRawTransaction({ serializedTransaction });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error(`The transaction ${hash} reverted`);
    return hash;
  };
  return {
    async channel(terms, saved) {
      const { config, id } = await channelConfigOf(terms, saved, deps);
      const [[balance, claimed], [pending, initiatedAt], block] = await Promise.all([
        client.readContract({
          address: contract,
          abi: withdrawAbi,
          functionName: 'channels',
          args: [id],
        }),
        client.readContract({
          address: contract,
          abi: withdrawAbi,
          functionName: 'pendingWithdrawals',
          args: [id],
        }),
        client.getBlock({ blockTag: 'latest' }),
      ]);
      return {
        id,
        balanceAtomic: balance,
        claimedAtomic: claimed,
        pendingAtomic: pending,
        initiatedAt: Number(initiatedAt),
        delayS: config.withdrawDelay,
        nowS: Number(block.timestamp),
      };
    },
    async initiate(terms, amountAtomic, saved) {
      const { config } = await channelConfigOf(terms, saved, deps);
      return send(
        encodeFunctionData({
          abi: withdrawAbi,
          functionName: 'initiateWithdraw',
          args: [config, amountAtomic],
        }),
      );
    },
    async finalize(terms, saved) {
      const { config } = await channelConfigOf(terms, saved, deps);
      return send(
        encodeFunctionData({ abi: withdrawAbi, functionName: 'finalizeWithdraw', args: [config] }),
      );
    },
  };
}
