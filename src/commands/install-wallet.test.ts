import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';
import type { CommandContext } from '../context';
import { StoreExecError, type ExecFn } from '../lib/wallet/passphrase';
import { writeWalletRecord } from '../lib/wallet/store';
import { encryptedRecord, KNOWN_PASSPHRASE } from '../lib/wallet/test-support';
import { defaultWalletSigning } from './install-wallet';

// Real ox scrypt, as in the wallet suites.
vi.setConfig({ testTimeout: 120000 });

/** A Secret Service with nothing stored, so no test reads the developer's own keyring. */
const emptySecretService: ExecFn = async () => {
  throw new StoreExecError('secret-tool', { code: 1 });
};

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tenjin-install-wallet-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('defaultWalletSigning', () => {
  const ctx = (): CommandContext => ({ dataDir }) as CommandContext;
  const walletPassphrase = { platform: 'linux' as NodeJS.Platform, exec: emptySecretService };

  it('reports a wrong variable with nothing saved as the definite block doctor reports', async () => {
    await writeWalletRecord(dataDir, await encryptedRecord(generatePrivateKey(), KNOWN_PASSPHRASE));
    const { signing } = await defaultWalletSigning(ctx(), {
      env: { TENJIN_WALLET_PASSPHRASE: 'not-the-passphrase' },
      walletPassphrase,
    });
    expect(signing).toMatchObject({ status: 'blocked', reason: 'env_passphrase_wrong' });
  });
});
