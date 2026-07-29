import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The chain boundary is mocked WHOLE (the wallet.test.ts pattern): no test in
// this file can ever read from or broadcast to a real chain. The token contract
// address is re-declared literally so the contract-recipient refusal is pinned
// against the real value, not whatever the mock happens to say. The error
// classes are the real ones so instanceof checks in send.ts still work.
vi.mock('../lib/usdc', async () => {
  const actual = await vi.importActual<typeof import('../lib/usdc')>('../lib/usdc');
  return {
    USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDC_DECIMALS: 6,
    FeeCapExceededError: actual.FeeCapExceededError,
    SendRevertedError: actual.SendRevertedError,
    SendPendingError: actual.SendPendingError,
    getUsdcBalance: vi.fn(),
    prepareUsdcSend: vi.fn(),
    broadcastUsdcSend: vi.fn(),
  };
});

import { runSend } from './send';
import {
  getUsdcBalance,
  prepareUsdcSend,
  broadcastUsdcSend,
  FeeCapExceededError,
  SendPendingError,
  SendRevertedError,
  type PreparedUsdcSend,
} from '../lib/usdc';
import { testWalletProvider } from '../lib/read-test-utils';
import { createLocalProvider } from '../lib/wallet/local';
import { writeWalletRecord } from '../lib/wallet/store';
import { fakeRecord } from '../lib/wallet/test-support';
import type { WalletProvider } from '../lib/wallet';
import type { CommandContext, GlobalFlags } from '../context';

const balanceMock = vi.mocked(getUsdcBalance);
const prepareMock = vi.mocked(prepareUsdcSend);
const broadcastMock = vi.mocked(broadcastUsdcSend);

// All-lowercase valid recipient and its EIP-55 checksummed form. Deliberately
// NOT the testSigner wallet's own address (that one trips the self-send guard).
const TO_LOWER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const TO_CHECKSUM = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

function preparedFixture(over: Partial<PreparedUsdcSend> = {}): PreparedUsdcSend {
  return {
    to: TO_CHECKSUM,
    amountAtomic: 1_000_000n,
    data: '0xdata',
    nonce: 7,
    gas: 65_000n,
    maxFeePerGas: 100_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
    feeWei: 6_500_000_000_000n, // gas * maxFeePerGas
    ethBalanceWei: 10n ** 16n, // 0.01 ETH, plenty
    ...over,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-send-'));
  vi.clearAllMocks();
  balanceMock.mockResolvedValue(10_000_000n); // $10 by default
  prepareMock.mockResolvedValue(preparedFixture());
  broadcastMock.mockResolvedValue('0xabc123');
  // sendMaxAmount has NO default: unset refuses (the require-set-before-first-
  // send posture, pinned in its own describe below). Every other test therefore
  // carries an explicit cap decision — 'none' is the explicit uncapped opt-in.
  await writeFile(join(dir, 'config.json'), JSON.stringify({ sendMaxAmount: 'none' }));
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

describe('runSend, argument validation', () => {
  it('rejects a non-USDC token as USAGE without touching wallet or chain', async () => {
    const { provider, getSigner } = spiedProvider();
    await expect(
      runSend({ amount: '1', token: 'eth', to: TO_LOWER }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    expect(getSigner).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
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
      '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293Bc',
    ];
    for (const to of bad) {
      await expect(
        runSend({ amount: '1', token: 'usdc', to, yes: true }, makeCtx(), { provider }),
      ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    }
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('refuses the known fund-destroying recipients (USDC contract, zero, dEaD)', async () => {
    const { provider } = spiedProvider();
    const destroying = [
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // the token contract, lowercase
      '0x0000000000000000000000000000000000000000',
      '0x000000000000000000000000000000000000dEaD',
    ];
    for (const to of destroying) {
      await expect(
        runSend({ amount: '1', token: 'usdc', to, yes: true }, makeCtx(), { provider }),
      ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    }
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('refuses a self-send to the wallet address itself', async () => {
    const { provider } = spiedProvider();
    const self = (await provider.describe()).address;
    await expect(
      runSend({ amount: '1', token: 'usdc', to: self.toLowerCase(), yes: true }, makeCtx(), {
        provider,
      }),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('resolves a lowercase recipient to its checksummed form in the transfer and output', async () => {
    const { provider } = spiedProvider();
    const result = await runSend(
      { amount: '1', token: 'usdc', to: TO_LOWER, yes: true },
      makeCtx(),
      { provider },
    );
    expect((result.data as { to: string }).to).toBe(TO_CHECKSUM);
    expect(prepareMock).toHaveBeenCalledWith(expect.objectContaining({ to: TO_CHECKSUM }));
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
    expect(prepareMock).toHaveBeenCalledWith(expect.objectContaining({ amountAtomic: atomic }));
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
      expect(broadcastMock).not.toHaveBeenCalled();
    },
  );

  it('sends an amount exactly equal to the balance', async () => {
    balanceMock.mockResolvedValue(1_000_000n); // exactly $1
    const { provider } = spiedProvider();
    const result = await runSend(
      { amount: '1', token: 'usdc', to: TO_LOWER, yes: true },
      makeCtx(),
      { provider },
    );
    expect((result.data as { txHash: string }).txHash).toBe('0xabc123');
  });

  it('refuses one atomic unit above the balance without signing', async () => {
    balanceMock.mockResolvedValue(999_999n); // one micro-dollar short of $1
    const { provider, getSigner } = spiedProvider();
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'REFUSED', exitCode: 3 });
    expect(getSigner).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('maps a balance-read failure to RPC_ERROR', async () => {
    balanceMock.mockRejectedValue(new Error('rpc down'));
    const { provider } = spiedProvider();
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'RPC_ERROR', exitCode: 1 });
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe('runSend, sendMaxAmount policy gate (never satisfied by --yes)', () => {
  async function setCap(atomic: string): Promise<void> {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ sendMaxAmount: atomic }));
  }

  it('refuses an amount one atomic unit over the cap as POLICY_REFUSED even with --yes', async () => {
    await setCap('500000'); // $0.50 cap; the send is cap + 1n, pinning the boundary
    const { provider, getSigner } = spiedProvider();
    await expect(
      runSend({ amount: '0.500001', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), {
        provider,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REFUSED', exitCode: 3 });
    expect(getSigner).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('a cap of 0 disables the verb entirely', async () => {
    await setCap('0');
    const { provider } = spiedProvider();
    await expect(
      runSend({ amount: '0.01', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'POLICY_REFUSED', exitCode: 3 });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('an amount exactly at the cap passes the gate', async () => {
    await setCap('1000000'); // $1 cap
    const { provider } = spiedProvider();
    const result = await runSend(
      { amount: '1', token: 'usdc', to: TO_LOWER, yes: true },
      makeCtx(),
      { provider },
    );
    expect((result.data as { txHash: string }).txHash).toBe('0xabc123');
  });
});

describe('runSend, unset sendMaxAmount refuses (require-set-before-first-send)', () => {
  beforeEach(async () => {
    // The fresh-install shape: no config.json at all, so sendMaxAmount was
    // never set. There is no numeric fallback; the send must refuse.
    await rm(join(dir, 'config.json'), { force: true });
  });

  it('refuses as POLICY_REFUSED even with --yes: no chain read, no signer, no broadcast', async () => {
    const { provider, getSigner } = spiedProvider();
    await expect(
      runSend({ amount: '0.01', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({
      code: 'POLICY_REFUSED',
      exitCode: 3,
      // The refusal must name the exact command that sets the cap.
      fix: expect.stringContaining('tenjin config set sendMaxAmount'),
    });
    expect(getSigner).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
    expect(balanceMock).not.toHaveBeenCalled(); // the gate fires before any chain read
  });

  it('an interactive confirm is never consulted: the gate is policy, not consent', async () => {
    const { provider, getSigner } = spiedProvider();
    const confirm = vi.fn(async () => true); // would approve, must never be asked
    await expect(
      runSend({ amount: '0.01', token: 'usdc', to: TO_LOWER }, makeCtx({}, true), {
        provider,
        confirm,
      }),
    ).rejects.toMatchObject({ code: 'POLICY_REFUSED', exitCode: 3 });
    expect(confirm).not.toHaveBeenCalled();
    expect(getSigner).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('an explicit "none" in the file is honored as the uncapped opt-in', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ sendMaxAmount: 'none' }));
    const { provider } = spiedProvider();
    const result = await runSend(
      { amount: '1', token: 'usdc', to: TO_LOWER, yes: true },
      makeCtx(),
      { provider },
    );
    expect((result.data as { txHash: string }).txHash).toBe('0xabc123');
  });
});

describe('runSend, confirm-flow gating', () => {
  it('headless without --yes: REFUSED, and NOTHING is signed (no signer, no send)', async () => {
    const { provider, getSigner } = spiedProvider();
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER }, makeCtx({}, false), { provider }),
    ).rejects.toMatchObject({ code: 'REFUSED', exitCode: 3 });
    expect(getSigner).not.toHaveBeenCalled();
    expect(broadcastMock).not.toHaveBeenCalled();
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
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('the confirm prompt previews the RESOLVED recipient, the amount, and the fee', async () => {
    const { provider } = spiedProvider();
    const confirm = vi.fn(async (_prompt: string) => true);
    await runSend({ amount: '0.25', token: 'usdc', to: TO_LOWER }, makeCtx({}, true), {
      provider,
      confirm,
    });
    const prompt = confirm.mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain(TO_CHECKSUM);
    expect(prompt).toContain('0.25 USDC');
    expect(prompt).toContain('ETH'); // the worst-case network fee is shown
    expect(prompt).toContain('cannot be undone');
    expect(broadcastMock).toHaveBeenCalledOnce();
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

describe('runSend, gas and fee guards', () => {
  it('refuses pre-confirm when the wallet holds less ETH than the worst-case fee', async () => {
    prepareMock.mockResolvedValue(preparedFixture({ ethBalanceWei: 0n }));
    const { provider, getSigner } = spiedProvider();
    const confirm = vi.fn(async () => true);
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER }, makeCtx({}, true), {
        provider,
        confirm,
      }),
    ).rejects.toMatchObject({ code: 'REFUSED', fix: expect.stringContaining('ETH on Base') });
    expect(confirm).not.toHaveBeenCalled(); // refused before anyone was asked
    expect(getSigner).not.toHaveBeenCalled();
  });

  it('maps an abnormal RPC fee estimate to a refusal naming rpcUrl', async () => {
    prepareMock.mockRejectedValue(new FeeCapExceededError('maxFeePerGas', 10n ** 15n, 10n ** 10n));
    const { provider } = spiedProvider();
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'REFUSED', fix: expect.stringContaining('rpcUrl') });
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe('runSend, wallet refusals through the provider seam', () => {
  it('refuses with WALLET_MISSING when no wallet exists', async () => {
    // The REAL local provider against an empty data dir: no env key, no file.
    const provider = createLocalProvider({ dir, env: {}, passphrase: { isTTY: false } });
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'WALLET_MISSING' });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('refuses when the active wallet has no passphrase entry, before any signature', async () => {
    // A real encrypted wallet record whose passphrase entry is MISSING: no env
    // passphrase, no OS store for the platform, no TTY to prompt (the stranded-
    // wallet shape). The refusal comes from the provider seam (getSigner), so
    // send never constructs a signature.
    await writeWalletRecord(dir, fakeRecord());
    const provider = createLocalProvider({
      dir,
      env: {},
      passphrase: { isTTY: false, platform: 'freebsd' },
    });
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'USAGE', message: expect.stringContaining('passphrase') });
    expect(broadcastMock).not.toHaveBeenCalled();
  });

  it('refuses when the signer address diverges from the previewed wallet', async () => {
    const inner = testWalletProvider();
    const provider: WalletProvider = {
      ...inner,
      // Preview one wallet; the signer (inner) resolves a different address.
      describe: async () => ({ ...(await inner.describe()), address: TO_CHECKSUM }),
    };
    await expect(
      runSend(
        { amount: '1', token: 'usdc', to: '0x71be63f3384f5fb98995898a86b02fb2426c5788', yes: true },
        makeCtx(),
        { provider },
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});

describe('runSend, success and post-broadcast failure', () => {
  it('prints the tx hash and returns {atomic, usd} money on success', async () => {
    const { provider } = spiedProvider();
    broadcastMock.mockResolvedValue('0xdeadbeef');
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
    expect(data.from).toBe((await provider.getSigner()).address);
    expect(data.amount).toEqual({ atomic: '2500000', usd: '2.5' });
    expect(result.humanLines?.join('\n')).toContain('0xdeadbeef');
  });

  it('maps a reverted transfer to SEND_FAILED (exit 4) carrying the tx hash', async () => {
    const { provider } = spiedProvider();
    broadcastMock.mockRejectedValue(new SendRevertedError('0xbad'));
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({
      code: 'SEND_FAILED',
      exitCode: 4,
      details: { txHash: '0xbad' },
    });
  });

  it('maps a missing receipt to SEND_FAILED with a do-not-retry-blind fix', async () => {
    const { provider } = spiedProvider();
    broadcastMock.mockRejectedValue(new SendPendingError('0xstuck'));
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({
      code: 'SEND_FAILED',
      exitCode: 4,
      details: { txHash: '0xstuck', pending: true },
      fix: expect.stringContaining('double-send'),
    });
  });

  it('maps other broadcast failures to RPC_ERROR', async () => {
    const { provider } = spiedProvider();
    broadcastMock.mockRejectedValue(new Error('connection reset'));
    await expect(
      runSend({ amount: '1', token: 'usdc', to: TO_LOWER, yes: true }, makeCtx(), { provider }),
    ).rejects.toMatchObject({ code: 'RPC_ERROR', exitCode: 1 });
  });
});
