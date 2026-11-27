import { computeChannelId } from '@x402/evm/batch-settlement/client';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { getAddress } from 'viem';
import { expect, it, vi } from 'vitest';
import { channelConfigOf } from './neon-withdraw';
import type { NeonTerms } from './neon-terms';

const TERMS: NeonTerms = {
  rowId: 'row-1',
  label: 'Test Writer',
  url: 'https://seller.example/chat',
  payTo: '0x00000000000000000000000000000000000000aa',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  model: 'test/model',
  wire: 'chat',
  scheme: 'batch-settlement',
  usage: 'nanogpt',
  inputAtomicPerMillion: '3150000',
  outputAtomicPerMillion: '15750000',
  cacheReadAtomicPerMillion: '157500',
};
const PAYER = '0x00000000000000000000000000000000000000c1';
const saved = {
  payer: PAYER,
  receiverAuthorizer: '0x3721824a31197dcDD2984cF43b92B6cc8A87c0Fb',
  withdrawDelay: 900,
};
const signer = { address: PAYER } as never;

// Failure caught by review: the withdrawal needed the seller to answer, and rebuilt the channel
// from whatever receiver authorizer and delay it named now.
it('builds the channel from the config saved when it was funded, never asking the seller', async () => {
  const fetchImpl = vi.fn(async () => {
    throw new Error('seller offline');
  });
  const { config, id } = await channelConfigOf(TERMS, saved, { signer, rpcUrl: 'x', fetchImpl });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(config).toMatchObject({
    payer: getAddress(PAYER),
    receiver: getAddress(TERMS.payTo),
    receiverAuthorizer: getAddress(saved.receiverAuthorizer),
    withdrawDelay: 900,
  });
  expect(id).toBe(computeChannelId(config, TERMS.network));
});

it('refuses a saved config for another wallet, and falls back to the live 402 only where none was saved', async () => {
  await expect(
    channelConfigOf(
      TERMS,
      { ...saved, payer: '0x00000000000000000000000000000000000000c2' },
      {
        signer,
        rpcUrl: 'x',
      },
    ),
  ).rejects.toThrow(/another wallet/);
  // An older record with nothing saved reads the seller's 402, and only then.
  const fetchImpl = vi.fn(
    async () =>
      new Response('{}', {
        status: 402,
        headers: {
          'payment-required': encodePaymentRequiredHeader({
            x402Version: 2,
            error: 'payment required',
            resource: { url: TERMS.url, description: '', mimeType: 'application/json' },
            accepts: [
              {
                scheme: 'batch-settlement',
                network: TERMS.network as `${string}:${string}`,
                amount: '1',
                asset: TERMS.asset,
                payTo: TERMS.payTo,
                maxTimeoutSeconds: 60,
                extra: { receiverAuthorizer: saved.receiverAuthorizer, withdrawDelay: 1200 },
              },
            ],
          }),
        },
      }),
  );
  const live = await channelConfigOf(TERMS, undefined, {
    signer,
    rpcUrl: 'x',
    fetchImpl: fetchImpl as never,
  });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  // The probe of an older record is bounded: a seller that never answers cannot hold it.
  expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBeDefined();
  expect(live.config.withdrawDelay).toBe(1200);
});
