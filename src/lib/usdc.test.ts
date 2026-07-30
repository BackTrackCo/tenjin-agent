import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock ONLY the client factory: everything else (encoding, parsing, the signer)
// runs for real, so these tests pin the actual bytes that would hit the chain
// without ever reaching one.
vi.mock('viem', async () => {
  const actual = await vi.importActual<typeof import('viem')>('viem');
  return { ...actual, createPublicClient: vi.fn() };
});

import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseTransaction,
} from 'viem';
import { base } from 'viem/chains';
import { testSigner } from './read-test-utils';
import {
  broadcastUsdcSend,
  FeeCapExceededError,
  prepareUsdcSend,
  SEND_GAS_CAP,
  SEND_MAX_FEE_PER_GAS_CAP,
  SEND_MAX_PRIORITY_FEE_CAP,
  SendPendingError,
  SendRevertedError,
  USDC_ADDRESS,
  type PreparedUsdcSend,
} from './usdc';

const clientFactory = vi.mocked(createPublicClient);

const RPC = 'https://mainnet.base.org';
const TO = getAddress('0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc');
const FROM = testSigner().address;

interface ClientOverrides {
  getTransactionCount?: ReturnType<typeof vi.fn>;
  estimateGas?: ReturnType<typeof vi.fn>;
  estimateFeesPerGas?: ReturnType<typeof vi.fn>;
  getBalance?: ReturnType<typeof vi.fn>;
  sendRawTransaction?: ReturnType<typeof vi.fn>;
  waitForTransactionReceipt?: ReturnType<typeof vi.fn>;
}

function stubClient(over: ClientOverrides = {}): Required<ClientOverrides> {
  const client: Required<ClientOverrides> = {
    getTransactionCount: vi.fn(async () => 7),
    estimateGas: vi.fn(async () => 65_000n),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 100_000_000n, // 0.1 gwei, typical Base
      maxPriorityFeePerGas: 1_000_000n,
    })),
    getBalance: vi.fn(async () => 10n ** 16n),
    sendRawTransaction: vi.fn(async () => '0xhash'),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    ...over,
  };
  clientFactory.mockReturnValue(client as unknown as ReturnType<typeof createPublicClient>);
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('prepareUsdcSend', () => {
  it('encodes transfer(to, amount), fixes nonce/gas/fees, and computes the worst-case fee', async () => {
    const client = stubClient();
    const prepared = await prepareUsdcSend({
      from: FROM,
      to: TO,
      amountAtomic: 250_000n,
      rpcUrl: RPC,
    });

    // The calldata is a real ERC-20 transfer with recipient and amount IN ORDER.
    const decoded = decodeFunctionData({ abi: erc20Abi, data: prepared.data });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toEqual([TO, 250_000n]);

    expect(prepared.nonce).toBe(7);
    expect(prepared.gas).toBe(65_000n);
    expect(prepared.feeWei).toBe(65_000n * 100_000_000n);
    expect(prepared.ethBalanceWei).toBe(10n ** 16n);
    // The gas estimate and nonce are for the SENDER, against the USDC contract.
    expect(client.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ account: FROM, to: USDC_ADDRESS }),
    );
    expect(client.getTransactionCount).toHaveBeenCalledWith(
      expect.objectContaining({ address: FROM, blockTag: 'pending' }),
    );
  });

  it.each([
    ['gas', { estimateGas: vi.fn(async () => SEND_GAS_CAP + 1n) }],
    [
      'maxFeePerGas',
      {
        estimateFeesPerGas: vi.fn(async () => ({
          maxFeePerGas: SEND_MAX_FEE_PER_GAS_CAP + 1n,
          maxPriorityFeePerGas: 1n,
        })),
      },
    ],
    [
      'maxPriorityFeePerGas',
      {
        estimateFeesPerGas: vi.fn(async () => ({
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: SEND_MAX_PRIORITY_FEE_CAP + 1n,
        })),
      },
    ],
  ])('refuses an RPC %s estimate above the ceiling', async (_field, over) => {
    stubClient(over as ClientOverrides);
    await expect(
      prepareUsdcSend({ from: FROM, to: TO, amountAtomic: 1n, rpcUrl: RPC }),
    ).rejects.toBeInstanceOf(FeeCapExceededError);
  });
});

describe('broadcastUsdcSend', () => {
  async function prepared(): Promise<PreparedUsdcSend> {
    stubClient();
    return prepareUsdcSend({ from: FROM, to: TO, amountAtomic: 250_000n, rpcUrl: RPC });
  }

  it('signs exactly the prepared eip1559 transfer on Base and broadcasts it', async () => {
    const p = await prepared();
    const client = stubClient();
    const hash = await broadcastUsdcSend({ signer: testSigner(), prepared: p, rpcUrl: RPC });
    expect(hash).toBe('0xhash');

    // Re-parse the actual signed bytes: the wire transaction, not our intent.
    const raw = client.sendRawTransaction.mock.calls[0]?.[0] as {
      serializedTransaction: `0x${string}`;
    };
    const tx = parseTransaction(raw.serializedTransaction);
    expect(tx.type).toBe('eip1559');
    expect(tx.chainId).toBe(base.id); // pinned: no cross-chain replay
    expect(tx.to?.toLowerCase()).toBe(USDC_ADDRESS.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n); // never moves native ETH
    expect(tx.nonce).toBe(p.nonce);
    expect(tx.gas).toBe(p.gas);
    expect(tx.maxFeePerGas).toBe(p.maxFeePerGas);
    expect(tx.maxPriorityFeePerGas).toBe(p.maxPriorityFeePerGas);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data as `0x${string}` });
    expect(decoded.functionName).toBe('transfer');
    expect(decoded.args).toEqual([TO, 250_000n]);
  });

  it('refuses to sign calldata that no longer matches the previewed recipient/amount', async () => {
    const p = await prepared();
    p.data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [FROM, 250_000n], // tampered: recipient is no longer the previewed TO
    });
    const client = stubClient();
    await expect(
      broadcastUsdcSend({ signer: testSigner(), prepared: p, rpcUrl: RPC }),
    ).rejects.toThrow(/does not decode to the previewed/);
    expect(client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('throws SendRevertedError (with the hash) when the receipt is a revert', async () => {
    const p = await prepared();
    stubClient({ waitForTransactionReceipt: vi.fn(async () => ({ status: 'reverted' })) });
    const err = await broadcastUsdcSend({ signer: testSigner(), prepared: p, rpcUrl: RPC }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SendRevertedError);
    expect((err as SendRevertedError).txHash).toBe('0xhash');
  });

  it('throws SendPendingError (with the hash) when no receipt arrives in time', async () => {
    const p = await prepared();
    stubClient({
      waitForTransactionReceipt: vi.fn(async () => {
        throw new Error('timeout');
      }),
    });
    await expect(
      broadcastUsdcSend({ signer: testSigner(), prepared: p, rpcUrl: RPC }),
    ).rejects.toBeInstanceOf(SendPendingError);
  });
});
