import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The chain boundary is mocked WHOLE (the wallet.test.ts pattern): no test in
// this file can ever read from or broadcast to a real chain. The token contract
// address is re-declared literally so the contract-recipient refusal is pinned
// against the real value, not whatever the mock happens to say.
vi.mock('../lib/usdc', () => ({
  USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDC_DECIMALS: 6,
  getUsdcBalance: vi.fn(),
  sendUsdc: vi.fn(),
}));

import { runSend } from './send';
import { getUsdcBalance, sendUsdc } from '../lib/usdc';
import { testWalletProvider } from '../lib/read-test-utils';
import { createLocalProvider } from '../lib/wallet/local';
import { writeWalletRecord } from '../lib/wallet/store';
import { fakeRecord } from '../lib/wallet/test-support';
import type { WalletProvider } from '../lib/wallet';
import type { CommandContext, GlobalFlags } from '../context';

const balanceMock = vi.mocked(getUsdcBalance);
const sendMock = vi.mocked(sendUsdc);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-send-'));
  vi.clearAllMocks();
  balanceMock.mockResolvedValue(10_000_000n); // $10 by default
  sendMock.mockResolvedValue('0xabc123');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(flags: Partial<GlobalFlags> = {}, isTTY = false): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000, ...flags },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY },
  };
}

/** A wallet provider whose getSigner is spied, so "no signature" is provable. */
function spiedProvider(): { provider: WalletProvider; getSigner: ReturnType<typeof vi.fn> } {
  const inner = testWalletProvider();
  const getSigner = vi.fn(inner.getSigner);
  return { provider: { ...inner, getSigner }, getSigner };
}

// All-lowercase valid recipient and its EIP-55 checksummed form.
const TO_LOWER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const TO_CHECKSUM = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('runSend, argument validation', () => {
  it('rejects a non-USDC token as USAGE without touching wallet or chain', async () => {
    const { provider, getSigner } = spiedProvider();
    await expect(
      runSend({ amount: '1', token: 'eth', to: TO_LOWER }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    expect(getSigner).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    expect(balanceMock).not.toHaveBeenCalled();
  });

  it('accepts the token case-insensitively', async () => {
    const { provider } = spiedProvider();
    const result = await runSend(
      { amount: '1', token: 'USDC', to: TO_LOWER, yes: true },
      makeCtx(),
      { provider },
    );
    expect((result.data as { token: string }).token).toBe('USDC');
  });

  it('rejects malformed and bad-checksum addresses as USAGE', async () => {
    const { provider } = spiedProvider();
    const bad = [
      'not-an-address',
      '0x1234', // too short
      // Valid hex but the mixed-case checksum is wrong (last char case flipped
      // relative to EIP-55): a likely typo, refused rather than guessed.
      '0x70997970C51812dc3A010C7d01b50e0d17dc79c8',
    ];
    for (const to of bad) {
      await expect(
        runSend({ amount: '1', token: 'usdc', to, yes: true }, makeCtx(), { provider }),
      ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('refuses the USDC token contract as recipient (unrecoverable)', async () => {
    const { provider } = spiedProvider();
    await expect(
      runSend(
        {
          amount: '1',
          token: 'usdc',
          to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // lowercase form of the contract
          yes: true,
        },
        makeCtx(),
        { provider },
      ),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('resolves a lowercase recipient to its checksummed form in the transfer and output', async () => {
    const { provider } = spiedProvider();
    const result = await runSend(
      { amount: '1', token: 'usdc', to: TO_LOWER, yes: true },
      makeCtx(),
      { provider },
    );
    expect((result.data as { to: string }).to).toBe(TO_CHECKSUM);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ to: TO_CHECKSUM }));
  });
});

describe('runSend, amount conversion edges', () => {
  it.each([
    ['0.25', 250_000n],
    ['5', 5_000_000n],
    ['0.000001', 1n], // one micro-dollar, the smallest USDC unit
    ['9.999999', 9_999_999n],
  ])('converts %s USD to %s atomic exactly once', async (usd, atomic) => {
    const { provider } = spiedProvider();
    const result = await runSend(
      { amount: usd, token: 'usdc', to: TO_LOWER, yes: true },
      makeCtx(),
      { provider },
    );
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ amountAtomic: atomic }));
    expect((result.data as { amount: { atomic: string } }).amount.atomic).toBe(atomic.toString());
  });

  it.each(['0', '0.0000001', '-1', 'abc', '1,5', ''])(
    'rejects %j as USAGE before any chain read',
    async (amount) => {
      const { provider } = spiedProvider();
      await expect(
        runSend({ amount, token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
      ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
      expect(balanceMock).not.toHaveBeenCalled();
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  it('refuses an amount above the wallet balance without signing', async () => {
    balanceMock.mockResolvedValue(500_000n); // $0.50
    const { provider, getSigner } = spiedProvider();
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'REFUSED', exitCode: 3 });
    expect(getSigner).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('maps a balance-read failure to RPC_ERROR', async () => {
    balanceMock.mockRejectedValue(new Error('rpc down'));
    const { provider } = spiedProvider();
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'RPC_ERROR', exitCode: 1 });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('runSend, confirm-flow gating', () => {
  it('headless without --yes: REFUSED, and NOTHING is signed (no signer, no send)', async () => {
    const { provider, getSigner } = spiedProvider();
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER }, makeCtx({}, false), { provider }),
    ).rejects.toMatchObject({ code: 'REFUSED', exitCode: 3 });
    expect(getSigner).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('a declined interactive confirm refuses without signing', async () => {
    const { provider, getSigner } = spiedProvider();
    const confirm = vi.fn(async () => false);
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER }, makeCtx({}, true), {
        provider,
        confirm,
      }),
    ).rejects.toMatchObject({ code: 'REFUSED', exitCode: 3 });
    expect(confirm).toHaveBeenCalledOnce();
    expect(getSigner).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('the confirm prompt previews the RESOLVED recipient and the exact amount', async () => {
    const { provider } = spiedProvider();
    const confirm = vi.fn(async (_prompt: string) => true);
    await runSend({ amount: '0.25', token: 'usdc', to: TO_LOWER }, makeCtx({}, true), {
      provider,
      confirm,
    });
    const prompt = confirm.mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain(TO_CHECKSUM);
    expect(prompt).toContain('0.25 USDC');
    expect(prompt).toContain('cannot be undone');
    expect(sendMock).toHaveBeenCalledOnce();
  });

  it('--yes skips the interactive confirm and sends', async () => {
    const { provider } = spiedProvider();
    const confirm = vi.fn(async () => false); // must never be consulted
    const result = await runSend(
      { amount: '1', token: 'usdc', to: TO_LOWER, yes: true },
      makeCtx({}, false),
      { provider, confirm },
    );
    expect(confirm).not.toHaveBeenCalled();
    expect((result.data as { txHash: string }).txHash).toBe('0xabc123');
  });
});

describe('runSend, wallet refusals through the provider seam', () => {
  it('refuses with WALLET_MISSING when no wallet exists', async () => {
    // The REAL local provider against an empty data dir: no env key, no file.
    const provider = createLocalProvider({ dir, env: {}, passphrase: { isTTY: false } });
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'WALLET_MISSING' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('refuses when the active wallet has no passphrase entry, before any signature', async () => {
    // A real encrypted wallet record whose passphrase entry is MISSING: no env
    // passphrase, no OS store for the platform, no TTY to prompt (issue #32's
    // stranded-wallet shape). The refusal comes from the provider seam
    // (getSigner), so send never constructs a signature.
    await writeWalletRecord(dir, fakeRecord());
    const provider = createLocalProvider({
      dir,
      env: {},
      passphrase: { isTTY: false, platform: 'freebsd' },
    });
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'USAGE', message: expect.stringContaining('passphrase') });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('runSend, success and broadcast failure', () => {
  it('prints the tx hash and returns {atomic, usd} money on success', async () => {
    const { provider } = spiedProvider();
    sendMock.mockResolvedValue('0xdeadbeef');
    const result = await runSend(
      { amount: '2.50', token: 'usdc', to: TO_LOWER, yes: true },
      makeCtx(),
      { provider },
    );
    const data = result.data as {
      txHash: string;
      to: string;
      from: string;
      token: string;
      network: string;
      amount: { atomic: string; usd: string };
    };
    expect(data.txHash).toBe('0xdeadbeef');
    expect(data.token).toBe('USDC');
    expect(data.network).toBe('base');
    expect(data.amount).toEqual({ atomic: '2500000', usd: '2.5' });
    expect(result.humanLines?.join('\n')).toContain('0xdeadbeef');
  });

  it('maps a failed broadcast to RPC_ERROR with a gas hint', async () => {
    const { provider } = spiedProvider();
    sendMock.mockRejectedValue(new Error('insufficient funds for gas'));
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({
      code: 'RPC_ERROR',
      fix: expect.stringContaining('ETH on Base for gas'),
    });
  });
});
