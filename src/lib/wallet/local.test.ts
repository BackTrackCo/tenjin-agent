import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { CliError } from '../errors';
import { walletPath } from '../paths';
import { readWalletRecord, writeWalletRecord } from './store';
import { createLocalProvider, createLocalWallet } from './local';
import type { ExecFn } from './passphrase';
import { KNOWN_PASSPHRASE, encryptedRecord, fakeRecord } from './test-support';

let tmp: string;
let dataDir: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-local-'));
  dataDir = join(tmp, '.tenjin');
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Seed a fake-keystore wallet whose top-level address is real; returns the address. */
async function seedDescribableWallet(): Promise<string> {
  const record = fakeRecord();
  await writeWalletRecord(dataDir, record);
  return record.address;
}

/** Provider deps whose passphrase resolves from the env passphrase (no keychain, no TTY). */
function envPass(passphrase: string) {
  return {
    dir: dataDir,
    env: { TENJIN_WALLET_PASSPHRASE: passphrase },
    passphrase: { platform: 'linux' as NodeJS.Platform, isTTY: false },
  };
}

describe('createLocalProvider.describe', () => {
  it('describes a file wallet from the stored address, without decrypting', async () => {
    const address = await seedDescribableWallet();
    const provider = createLocalProvider({ dir: dataDir, env: {} });
    expect(await provider.describe()).toEqual({
      address,
      provider: 'local',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
    });
  });

  it('describes an env wallet, deriving the address from the env key', async () => {
    const key = generatePrivateKey();
    const provider = createLocalProvider({ dir: dataDir, env: { TENJIN_WALLET_KEY: key } });
    const desc = await provider.describe();
    expect(desc.credentialSource).toBe('env');
    expect(desc.address).toBe(privateKeyToAccount(key).address);
  });

  it('env key takes precedence over the file wallet', async () => {
    await seedDescribableWallet();
    const envKey = generatePrivateKey();
    const provider = createLocalProvider({ dir: dataDir, env: { TENJIN_WALLET_KEY: envKey } });
    const desc = await provider.describe();
    expect(desc.credentialSource).toBe('env');
    expect(desc.address).toBe(privateKeyToAccount(envKey).address);
  });

  it('throws WALLET_MISSING when neither env nor file exists', async () => {
    const provider = createLocalProvider({ dir: dataDir, env: {} });
    const err = (await provider.describe().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_MISSING');
    expect(err.fix).toContain('tenjin wallet create');
  });

  it('throws WALLET_INVALID_KEY for a malformed env key', async () => {
    const provider = createLocalProvider({ dir: dataDir, env: { TENJIN_WALLET_KEY: 'nope' } });
    const err = (await provider.describe().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
  });

  it('does NOT require a passphrase to describe a file wallet', async () => {
    // No env passphrase, non-mac, non-TTY: describe must still work (keyless).
    const address = await seedDescribableWallet();
    const provider = createLocalProvider({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'linux', isTTY: false },
    });
    expect((await provider.describe()).address).toBe(address);
  });
});

describe('createLocalProvider.getSigner', () => {
  it('decrypts the keystore and returns a working signer (roundtrip)', async () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await writeWalletRecord(dataDir, await encryptedRecord(key));
    const provider = createLocalProvider(envPass(KNOWN_PASSPHRASE));
    const signer = await provider.getSigner();
    expect(signer.address).toBe(address);
    const sig = await signer.signMessage({ message: 'tenjin' });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/i);
  });

  it('throws WALLET_INVALID_KEY on the wrong passphrase', async () => {
    const key = generatePrivateKey();
    await writeWalletRecord(dataDir, await encryptedRecord(key));
    const provider = createLocalProvider(envPass('the-wrong-passphrase'));
    const err = (await provider.getSigner().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.fix).toContain('TENJIN_WALLET_PASSPHRASE');
  });

  it('rejects a tampered record whose stored address differs from the decrypted key', async () => {
    const key = generatePrivateKey();
    const otherAddress = privateKeyToAccount(generatePrivateKey()).address;
    // Encrypt a real key but stamp a different top-level address.
    await writeWalletRecord(dataDir, await encryptedRecord(key, KNOWN_PASSPHRASE, otherAddress));
    const provider = createLocalProvider(envPass(KNOWN_PASSPHRASE));
    const err = (await provider.getSigner().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.message).toContain('stored address');
  });

  it('rejects a keystore whose decrypted key is outside the curve order', async () => {
    // Passes the hex-format regex but exceeds the secp256k1 scalar range.
    const badKey = `0x${'f'.repeat(64)}` as Hex;
    const address = privateKeyToAccount(generatePrivateKey()).address;
    await writeWalletRecord(dataDir, await encryptedRecord(badKey, KNOWN_PASSPHRASE, address));
    const provider = createLocalProvider(envPass(KNOWN_PASSPHRASE));
    const err = (await provider.getSigner().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
  });

  it('resolves the passphrase from the macOS keychain when env is unset', async () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await writeWalletRecord(dataDir, await encryptedRecord(key));
    const exec: ExecFn = async (file, args) => {
      expect(file).toBe('security');
      expect(args).toContain('find-generic-password');
      return { stdout: `${KNOWN_PASSPHRASE}\n`, stderr: '' };
    };
    const provider = createLocalProvider({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'darwin', isTTY: false, exec },
    });
    expect((await provider.getSigner()).address).toBe(address);
  });

  it('throws WALLET_MISSING with no credential', async () => {
    const provider = createLocalProvider({ dir: dataDir, env: {} });
    const err = (await provider.getSigner().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_MISSING');
  });

  it('uses the raw env key without any passphrase', async () => {
    const key = generatePrivateKey();
    const provider = createLocalProvider({
      dir: dataDir,
      env: { TENJIN_WALLET_KEY: key },
      passphrase: { platform: 'linux', isTTY: false },
    });
    const signer = await provider.getSigner();
    expect(signer.address).toBe(privateKeyToAccount(key).address);
  });
});

describe('createLocalWallet', () => {
  it('encrypts a key that decrypts back to the reported address, no plaintext on disk', async () => {
    const { address, walletPath: path } = await createLocalWallet(dataDir, KNOWN_PASSPHRASE);
    expect(path).toBe(walletPath(dataDir));

    const record = await readWalletRecord(dataDir);
    expect(record?.schemaVersion).toBe(2);

    // The signer decrypts back to the same address.
    const provider = createLocalProvider(envPass(KNOWN_PASSPHRASE));
    expect((await provider.getSigner()).address).toBe(address);

    // No 0x-prefixed 64-hex private key ever appears on disk.
    const raw = await readFile(walletPath(dataDir), 'utf8');
    expect(raw).not.toMatch(/0x[0-9a-f]{64}/i);
  });

  it('refuses to clobber an existing wallet (WALLET_EXISTS)', async () => {
    await createLocalWallet(dataDir, KNOWN_PASSPHRASE);
    const err = (await createLocalWallet(dataDir, KNOWN_PASSPHRASE).catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_EXISTS');
    expect(err.exitCode).toBe(3);
  });
});
