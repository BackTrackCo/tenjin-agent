import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Address } from 'viem';
import { CliError } from '../lib/errors';
import { walletPath } from '../lib/paths';
import type { SpendPolicy } from '../lib/policy';
import type { WalletProvider, WalletVerification } from '../lib/wallet/provider';
import { ENV_PASSPHRASE_WRONG, type SigningSource } from '../lib/wallet-unlock';
import { checkEligibility, type EligibilityInput } from './eligibility-check';
import { CHANNEL_DEPOSIT_ATOMIC } from './fee';
import { WALLET_REASONS } from './wallet-reasons';

const ADDRESS = ('0x' + 'ab'.repeat(20)) as Address;
const KEY = '0x' + '1f'.repeat(32);
const POLICY: SpendPolicy = {
  maxAutoSpendAtomic: 10n ** 9n,
  sessionBudgetAtomic: null,
  allowlistCreators: [],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-ec-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeWallet(): Promise<void> {
  await writeFile(walletPath(dir), JSON.stringify({ schemaVersion: 2, address: ADDRESS }));
}

function fakeProvider(over: Partial<WalletProvider> = {}): WalletProvider {
  return {
    id: 'fake',
    describe: async () => ({
      address: ADDRESS,
      provider: 'fake',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
    }),
    getSigner: async () => {
      throw new Error('never signs in a check');
    },
    diagnostics: async () => ({ warnings: [] }),
    ...over,
  };
}

function verified(source: SigningSource | undefined, warning?: string): WalletVerification {
  return {
    status: 'verified',
    detail: 'd',
    ...(source !== undefined ? { source } : {}),
    ...(warning !== undefined ? { warning } : {}),
  };
}

function input(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    dataDir: dir,
    env: {},
    policy: POLICY,
    rpcUrl: 'https://rpc.test',
    host: 'router.test',
    timeoutMs: 1000,
    provider: fakeProvider(),
    readBalance: async () => CHANNEL_DEPOSIT_ATOMIC,
    readCredit: async () => 0n,
    readSpent: async () => 0n,
    ...over,
  };
}

describe('checkEligibility', () => {
  it.each<[string, bigint, bigint, string]>([
    ['$0.21 wallet, room for its $0.03', 210_000n, 30_000n, 'ready'],
    ['$0.21 wallet, room one unit short', 210_000n, 29_999n, 'blocked'],
    // A big wallet signs the hint too, not the $0.25 ceiling.
    ['$0.50 wallet, room for its $0.03', 500_000n, 30_000n, 'ready'],
    ['$0.50 wallet, room one unit short', 500_000n, 29_999n, 'blocked'],
  ])(
    'evaluates the deposit the wallet signs against the daily room: %s',
    async (_label, balance, room, status) => {
      await writeWallet();
      const e = await checkEligibility(
        input({
          provider: fakeProvider({ verify: async () => verified('keychain') }),
          readBalance: async () => balance,
          policy: { ...POLICY, sessionBudgetAtomic: 500_000n },
          readSpent: async () => 500_000n - room,
        }),
      );
      expect(e.canPayRouting.status).toBe(status);
      if (status === 'blocked') expect(e.canPayRouting).toMatchObject({ reason: 'budget_reached' });
    },
  );

  it('a verify that throws gives unknown and never rejects', async () => {
    await writeWallet();
    const e = await checkEligibility(
      input({
        provider: fakeProvider({
          verify: async () => {
            throw new Error('boom');
          },
        }),
      }),
    );
    expect(e.canSign).toMatchObject({ status: 'unknown', reason: 'check_failed' });
    expect(e.canPayRouting.status).toBe('unknown');
  });

  it('an absent verify gives unknown not_checked', async () => {
    await writeWallet();
    const e = await checkEligibility(input());
    expect(e.canSign).toMatchObject({ status: 'unknown', reason: 'not_checked' });
  });

  it('a locked wallet still reads the balance', async () => {
    await writeWallet();
    const readBalance = vi.fn(async () => 5n);
    const e = await checkEligibility(
      input({
        provider: fakeProvider({
          verify: async () => ({
            status: 'broken',
            detail: 'd',
            fix: 'f',
            reason: 'passphrase_wrong',
          }),
        }),
        readBalance,
      }),
    );
    expect(e.canSign).toMatchObject({
      status: 'blocked',
      reason: 'passphrase_wrong',
      fix: WALLET_REASONS.passphrase_wrong.fix,
    });
    expect(readBalance).toHaveBeenCalledWith(ADDRESS, 'https://rpc.test', { timeoutMs: 1000 });
    expect(e.balanceAtomic).toBe(5n);
    expect(e.canPayRouting).toMatchObject({ status: 'blocked', reason: 'passphrase_wrong' });
  });

  it('provider null gives no_wallet', async () => {
    const e = await checkEligibility(input({ provider: null }));
    expect(e.canSign).toMatchObject({ status: 'blocked', reason: 'no_wallet' });
    expect(e.canPayRouting).toMatchObject({ status: 'blocked', reason: 'no_wallet' });
    expect(e.address).toBeNull();
    expect(e.describeError).toBeNull();
  });

  it('an env-key-only provider gives source key-env', async () => {
    const e = await checkEligibility(
      input({
        env: { TENJIN_WALLET_KEY: KEY },
        provider: fakeProvider({ verify: async () => verified(undefined) }),
      }),
    );
    expect(e.canSign).toEqual({ status: 'ready', source: 'key-env' });
    expect(e.source).toBe('key-env');
    expect(e.canPayRouting.status).toBe('ready');
  });

  it('a malformed env key is blocked env_key_invalid', async () => {
    const e = await checkEligibility(input({ env: { TENJIN_WALLET_KEY: '0x12' } }));
    expect(e.canSign).toMatchObject({ status: 'blocked', reason: 'env_key_invalid' });
  });

  it('a describe rejection is kept as describeError and never rejects (S11)', async () => {
    await writeFile(walletPath(dir), '{corrupt');
    const err = new CliError('WALLET_INVALID_KEY', 'corrupt wallet');
    const e = await checkEligibility(
      input({
        provider: fakeProvider({
          describe: async () => {
            throw err;
          },
        }),
      }),
    );
    expect(e.describeError).toBe(err);
    expect(e.canSign).toMatchObject({ status: 'unknown', reason: 'check_failed' });
    expect(e.address).toBeNull();
  });

  it('a describe rejection falls back to the cleartext address for the balance', async () => {
    await writeWallet();
    const e = await checkEligibility(
      input({
        provider: fakeProvider({
          describe: async () => {
            throw new CliError('PROVIDER_ERROR', 'x');
          },
        }),
      }),
    );
    expect(e.address).toBe(ADDRESS);
    expect(e.balanceAtomic).toBe(CHANNEL_DEPOSIT_ATOMIC);
  });

  it('failing balance, credit and ledger reads give nulls, not a rejection', async () => {
    await writeWallet();
    const e = await checkEligibility(
      input({
        provider: fakeProvider({ verify: async () => verified('keychain') }),
        readBalance: async () => {
          throw new Error('rpc');
        },
        readCredit: async () => {
          throw new Error('fs');
        },
        readSpent: async () => {
          throw new Error('ledger');
        },
      }),
    );
    expect(e.balanceAtomic).toBeNull();
    expect(e.creditAtomic).toBeNull();
    expect(e.canPayRouting).toMatchObject({ status: 'unknown', reason: 'balance_unreadable' });
  });

  it('a deposit the policy refuses is blocked with the payer reason', async () => {
    await writeWallet();
    const e = await checkEligibility(
      input({
        policy: { ...POLICY, maxAutoSpendAtomic: CHANNEL_DEPOSIT_ATOMIC - 1n },
        provider: fakeProvider({ verify: async () => verified('keychain') }),
      }),
    );
    expect(e.canPayRouting).toMatchObject({ status: 'blocked', reason: 'limit_below_deposit' });
  });

  describe('saved passphrase first (S7)', () => {
    const env = { TENJIN_WALLET_PASSPHRASE: 'pw' };

    it('env correct, saved ready from the keychain: source keychain', async () => {
      await writeWallet();
      const e = await checkEligibility(
        input({
          env,
          verifySaved: async () => verified('keychain'),
          provider: fakeProvider({ verify: async () => verified('passphrase-env') }),
        }),
      );
      expect(e.canSign).toEqual({ status: 'ready', source: 'keychain' });
      expect(e.source).toBe('keychain');
      expect(e.savedSign).toEqual({ status: 'ready', source: 'keychain' });
    });

    it('env correct, saved blocked passphrase_missing: source passphrase-env, savedSign blocked', async () => {
      await writeWallet();
      const e = await checkEligibility(
        input({
          env,
          verifySaved: async () => ({
            status: 'unverified',
            detail: 'd',
            reason: 'passphrase_missing',
          }),
          provider: fakeProvider({ verify: async () => verified('passphrase-env') }),
        }),
      );
      expect(e.canSign).toEqual({ status: 'ready', source: 'passphrase-env' });
      expect(e.savedSign).toMatchObject({ status: 'blocked', reason: 'passphrase_missing' });
    });

    it('env correct, saved unknown keychain_locked: source passphrase-env, savedSign unknown', async () => {
      await writeWallet();
      const e = await checkEligibility(
        input({
          env,
          verifySaved: async () => ({
            status: 'unverified',
            detail: 'd',
            reason: 'keychain_locked',
          }),
          provider: fakeProvider({ verify: async () => verified('passphrase-env') }),
        }),
      );
      expect(e.canSign).toEqual({ status: 'ready', source: 'passphrase-env' });
      expect(e.savedSign).toMatchObject({ status: 'unknown', reason: 'keychain_locked' });
    });

    it('env wrong with the saved passphrase working: ready with the warning', async () => {
      await writeWallet();
      const verify = vi.fn(async () => verified('file', ENV_PASSPHRASE_WRONG));
      const e = await checkEligibility(
        input({
          env,
          verifySaved: async () => verified('file'),
          provider: fakeProvider({ verify }),
        }),
      );
      expect(verify).toHaveBeenCalledOnce();
      expect(e.canSign).toEqual({ status: 'ready', source: 'file', warning: ENV_PASSPHRASE_WRONG });
      expect(e.warning).toBe(ENV_PASSPHRASE_WRONG);
    });

    it('a verifySaved that throws gives savedSign unknown check_failed', async () => {
      await writeWallet();
      const e = await checkEligibility(
        input({
          env,
          verifySaved: async () => {
            throw new Error('x');
          },
          provider: fakeProvider({ verify: async () => verified('passphrase-env') }),
        }),
      );
      expect(e.savedSign).toMatchObject({ status: 'unknown', reason: 'check_failed' });
      expect(e.canSign).toEqual({ status: 'ready', source: 'passphrase-env' });
    });

    it('S13: the full verify blocked passphrase_missing with the variable set is unknown', async () => {
      await writeWallet();
      const e = await checkEligibility(
        input({
          env,
          provider: fakeProvider({
            verify: async () => ({
              status: 'unverified',
              detail: 'd',
              reason: 'passphrase_missing',
            }),
          }),
        }),
      );
      expect(e.canSign).toMatchObject({ status: 'unknown', reason: 'not_checked' });
    });

    it('with the variable unset, verifySaved is not called and savedSign is null', async () => {
      await writeWallet();
      const verifySaved = vi.fn(async () => verified('keychain'));
      const e = await checkEligibility(
        input({
          verifySaved,
          provider: fakeProvider({ verify: async () => verified('keychain') }),
        }),
      );
      expect(verifySaved).not.toHaveBeenCalled();
      expect(e.savedSign).toBeNull();
    });

    it('with verifySaved absent, savedSign is null', async () => {
      await writeWallet();
      const e = await checkEligibility(
        input({ env, provider: fakeProvider({ verify: async () => verified('passphrase-env') }) }),
      );
      expect(e.savedSign).toBeNull();
      expect(e.canSign).toEqual({ status: 'ready', source: 'passphrase-env' });
    });

    it('with a valid env key, verifySaved is not called', async () => {
      const verifySaved = vi.fn(async () => verified('keychain'));
      await checkEligibility(
        input({
          env: { ...env, TENJIN_WALLET_KEY: KEY },
          verifySaved,
          provider: fakeProvider({ verify: async () => verified(undefined) }),
        }),
      );
      expect(verifySaved).not.toHaveBeenCalled();
    });
  });
});
