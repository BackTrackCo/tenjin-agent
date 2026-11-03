import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { CliError } from '../errors';
import {
  archivedWalletPath,
  passphraseBlobPath,
  passphraseBlobPathFor,
  passphraseFilePathFor,
  passphraseRecordPath,
  walletPath,
} from '../paths';
import { readPassphraseRecord, writePassphraseRecord } from '../passphrase-record';
import {
  ENV_PASSPHRASE_WRONG,
  FILE_STORE_FAILED_FIX,
  KEYCHAIN_LOCKED_FIX,
  REPAIR_CLAUSE,
  classifyUnlockError,
} from '../wallet-unlock';
import { readWalletRecord, writeWalletRecord } from './store';
import {
  createLocalProvider,
  createLocalWallet,
  localWalletDiagnostics,
  openKeystore,
  parkOutgoingWallet,
  repairLocalWalletPassphrase,
  verifyAndPreserveOutgoingWallet,
  verifyLocalWallet,
  type WalletWarning,
} from './local';
import { StoreExecError, type ExecFn } from './passphrase';
import { KNOWN_PASSPHRASE, encryptedRecord, fakeRecord } from './test-support';

/** `security find-generic-password`'s "no such item" (exit 44). */
const notFound = (): StoreExecError => new StoreExecError('security', { code: 44 });
/** `secret-tool lookup`'s "no such item" (exit 1, empty stderr). */
const secretMiss = (): StoreExecError => new StoreExecError('secret-tool', { code: 1 });
/** A Secret Service with nothing stored: every lookup misses, nothing else is expected. */
const emptySecretService: ExecFn = async () => {
  throw secretMiss();
};

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
    // A wrong env passphrase falls through to the saved one: an empty keyring
    // here, never the developer's real one.
    passphrase: { platform: 'linux' as NodeJS.Platform, isTTY: false, exec: emptySecretService },
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

  it('WALLET_MISSING names archived wallets instead of hiding recoverable funds', async () => {
    const archived = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, `wallet.${archived}.json.bak`), '{}');
    const provider = createLocalProvider({ dir: dataDir, env: {} });
    const err = (await provider.describe().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_MISSING');
    expect(err.fix).toContain(archived);
    expect(err.fix).toContain('restore');
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

  it('resolves the passphrase from the wallet OWN per-address keychain entry when env is unset', async () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await writeWalletRecord(dataDir, await encryptedRecord(key));
    const accountsQueried: string[] = [];
    const exec: ExecFn = async (file, args) => {
      expect(file).toBe('security');
      expect(args).toContain('find-generic-password');
      accountsQueried.push(args[args.indexOf('-a') + 1] as string);
      return { stdout: `${KNOWN_PASSPHRASE}\n`, stderr: '' };
    };
    const provider = createLocalProvider({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'darwin', isTTY: false, exec },
    });
    expect((await provider.getSigner()).address).toBe(address);
    // The send/buy signing path looks up the entry keyed by this wallet's
    // address — never the legacy shared constant.
    expect(accountsQueried).toEqual([address.toLowerCase()]);
  });

  it('migrates a legacy shared keychain entry to the wallet address after a PROVEN decrypt', async () => {
    // Legacy slot passphrases were always machine-generated base64url (that is
    // what the old create stored); use the same shape here.
    const legacyPass = 'legacy-base64url-passphrase_0123456789';
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    const account = address.toLowerCase();
    await writeWalletRecord(dataDir, await encryptedRecord(key, legacyPass));
    // A single-slot install: only the legacy entry exists, holding the right passphrase.
    const entries = new Map<string, string>([['wallet', legacyPass]]);
    const exec: ExecFn = async (file, args, stdin) => {
      expect(file).toBe('security');
      if (args[0] === '-i') {
        const m = stdin?.match(/^add-generic-password -s tenjin-cli -a (\S+) -w '([^']*)'\n$/);
        if (!m) throw new Error(`unexpected payload: ${String(stdin)}`);
        if (entries.has(m[1] as string)) throw new StoreExecError('security', { code: 45 });
        entries.set(m[1] as string, m[2] as string);
        return { stdout: '', stderr: '' };
      }
      const acct = args[args.indexOf('-a') + 1] as string;
      if (args[0] === 'find-generic-password') {
        const v = entries.get(acct);
        if (v === undefined) throw notFound();
        return { stdout: `${v}\n`, stderr: '' };
      }
      if (args[0] === 'delete-generic-password') {
        if (!entries.delete(acct)) throw notFound();
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected security call: ${args.join(' ')}`);
    };
    const provider = createLocalProvider({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'darwin', isTTY: false, exec },
    });
    expect((await provider.getSigner()).address).toBe(address);
    // Re-keyed: per-address entry holds the passphrase, the legacy slot is gone.
    expect(entries.get(account)).toBe(legacyPass);
    expect(entries.has('wallet')).toBe(false);
  });

  it('surfaces ambiguity when the legacy entry does NOT decrypt this wallet, leaving it untouched', async () => {
    const key = generatePrivateKey();
    await writeWalletRecord(dataDir, await encryptedRecord(key)); // KNOWN_PASSPHRASE
    // The legacy slot holds SOME OTHER wallet's passphrase (the post-overwrite reality).
    const entries = new Map<string, string>([['wallet', 'someone-elses-passphrase']]);
    const deletes: string[] = [];
    const exec: ExecFn = async (file, args) => {
      expect(file).toBe('security');
      if (args[0] === 'delete-generic-password') {
        deletes.push(args.join(' '));
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'find-generic-password') {
        const v = entries.get(args[args.indexOf('-a') + 1] as string);
        if (v === undefined) throw notFound();
        return { stdout: `${v}\n`, stderr: '' };
      }
      throw new Error(`unexpected write during an ambiguous legacy read: ${args.join(' ')}`);
    };
    const provider = createLocalProvider({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'darwin', isTTY: false, exec },
    });
    const err = (await provider.getSigner().catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.message).toContain('legacy shared passphrase entry');
    expect(err.fix).toContain('left untouched');
    // The ambiguous legacy entry was neither migrated nor deleted.
    expect(deletes).toEqual([]);
    expect(entries.get('wallet')).toBe('someone-elses-passphrase');
  });

  it('migrates a legacy Secret Service entry (linux) end to end through the provider', async () => {
    const legacyPass = 'legacy-secret-service-pass';
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await writeWalletRecord(dataDir, await encryptedRecord(key, legacyPass));
    const entries = new Map<string, string>([['wallet', legacyPass]]);
    const exec: ExecFn = async (file, args, stdin) => {
      expect(file).toBe('secret-tool');
      const account = args[args.indexOf('account') + 1] as string;
      if (args[0] === 'lookup') {
        const v = entries.get(account);
        if (v === undefined) throw secretMiss();
        return { stdout: v, stderr: '' };
      }
      if (args[0] === 'store') {
        entries.set(account, stdin ?? '');
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'clear') {
        if (!entries.delete(account)) throw secretMiss();
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected secret-tool call: ${args.join(' ')}`);
    };
    const provider = createLocalProvider({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'linux', isTTY: false, exec },
    });
    expect((await provider.getSigner()).address).toBe(address);
    expect(entries.get(address.toLowerCase())).toBe(legacyPass);
    expect(entries.has('wallet')).toBe(false);
  });

  it('migrates a legacy DPAPI blob (win32) end to end through the provider', async () => {
    const legacyPass = 'legacy-dpapi-provider-pass';
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    await writeWalletRecord(dataDir, await encryptedRecord(key, legacyPass));
    // The pre-per-wallet layout: only the shared blob exists (fake DPAPI = base64).
    await writeFile(
      passphraseBlobPath(dataDir),
      Buffer.from(legacyPass, 'utf8').toString('base64'),
    );
    const fakeDpapi: ExecFn = async (file, args, stdin) => {
      expect(file).toBe('powershell.exe');
      const script = args[args.length - 1] ?? '';
      if (script.includes('Unprotect')) {
        return { stdout: Buffer.from((stdin ?? '').trim(), 'base64').toString('utf8'), stderr: '' };
      }
      return { stdout: Buffer.from(stdin ?? '', 'utf8').toString('base64'), stderr: '' };
    };
    const provider = createLocalProvider({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'win32', isTTY: false, exec: fakeDpapi },
    });
    expect((await provider.getSigner()).address).toBe(address);
    // Re-keyed: the per-wallet blob decodes to the passphrase, the legacy blob is gone.
    const migrated = await readFile(passphraseBlobPathFor(address.toLowerCase(), dataDir), 'utf8');
    expect(Buffer.from(migrated.trim(), 'base64').toString('utf8')).toBe(legacyPass);
    await expect(stat(passphraseBlobPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves KDF cancellation without migrating a legacy credential', async () => {
    const key = generatePrivateKey();
    const record = await encryptedRecord(key);
    await writeWalletRecord(dataDir, record);
    const exec = vi.fn<ExecFn>(async (_file, args) => {
      if (args[0] !== 'find-generic-password') throw new Error('unexpected store mutation');
      if (args[args.indexOf('-a') + 1] !== 'wallet') throw notFound();
      return { stdout: KNOWN_PASSPHRASE, stderr: '' };
    });
    const provider = createLocalProvider({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'darwin', isTTY: false, exec },
      derivation: { signal: AbortSignal.abort() },
    });
    await expect(provider.getSigner()).rejects.toMatchObject({ name: 'AbortError' });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.every((call) => call[1][0] === 'find-generic-password')).toBe(true);
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

// #70: doctor reported `wallet: ok` for a keystore whose passphrase was gone, and
// the loss only surfaced at the first signing. `verify` is the read-only, never-
// prompting answer to "can this wallet actually sign?".
describe('verifyLocalWallet', () => {
  it('reports cancelled derivation as unverified instead of a broken password', async () => {
    await writeWalletRecord(dataDir, await encryptedRecord(generatePrivateKey()));
    await expect(
      verifyLocalWallet({
        ...envPass(KNOWN_PASSPHRASE),
        derivation: { signal: AbortSignal.abort() },
      }),
    ).resolves.toEqual({
      status: 'unverified',
      reason: 'unlock_timeout',
      detail: 'keystore verification was cancelled or timed out',
    });
  });

  it('verifies a keystore the resolved passphrase opens', async () => {
    const key = generatePrivateKey();
    await writeWalletRecord(dataDir, await encryptedRecord(key));
    const v = await verifyLocalWallet(envPass(KNOWN_PASSPHRASE));
    expect(v.status).toBe('verified');
    expect(v.detail).toContain('TENJIN_WALLET_PASSPHRASE');
  });

  it('reports broken, with a fix, when the passphrase does not open it', async () => {
    const key = generatePrivateKey();
    await writeWalletRecord(dataDir, await encryptedRecord(key));
    const v = await verifyLocalWallet(envPass('not the passphrase'));
    expect(v.status).toBe('broken');
    expect(v.detail).toContain('cannot be decrypted');
    expect(v).toHaveProperty('fix');
  });

  // Neither proven good nor proven bad. Reporting either would be a guess, and
  // guessing "ok" here is the whole of #70.
  it('reports unverified when no passphrase is reachable without prompting', async () => {
    const key = generatePrivateKey();
    await writeWalletRecord(dataDir, await encryptedRecord(key));
    const v = await verifyLocalWallet({
      dir: dataDir,
      env: {},
      // A platform with no built-in store: nothing to read, nothing to prompt.
      passphrase: { platform: 'openbsd' },
    });
    expect(v.status).toBe('unverified');
    expect(v.detail).toContain('without prompting');
  });

  // doctor is an allowlisted verb an unattended agent runs on its own, so this
  // must hold even when a TTY is available and a prompt would succeed.
  it('never prompts, even at a TTY with a working prompt', async () => {
    const key = generatePrivateKey();
    await writeWalletRecord(dataDir, await encryptedRecord(key));
    const prompt = vi.fn(async () => KNOWN_PASSPHRASE);
    const v = await verifyLocalWallet({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'openbsd', isTTY: true, prompt },
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(v.status).toBe('unverified');
  });

  it('reports broken when the decrypted key does not derive the stored address', async () => {
    const key = generatePrivateKey();
    const otherAddress = privateKeyToAccount(generatePrivateKey()).address;
    await writeWalletRecord(dataDir, await encryptedRecord(key, KNOWN_PASSPHRASE, otherAddress));
    const v = await verifyLocalWallet(envPass(KNOWN_PASSPHRASE));
    expect(v.status).toBe('broken');
    expect(v.detail).toContain(otherAddress);
  });

  // The exact state #70 was reported from: a pre-per-address wallet whose shared
  // keychain slot was clobbered by a later create. The wallet is unopenable and
  // the address it publishes under can no longer sign.
  it('names the legacy shared slot when that is the only passphrase and it fails', async () => {
    const key = generatePrivateKey();
    await writeWalletRecord(dataDir, await encryptedRecord(key)); // KNOWN_PASSPHRASE
    const entries = new Map<string, string>([['wallet', 'someone-elses-passphrase']]);
    const calls: string[] = [];
    const exec: ExecFn = async (file, args) => {
      calls.push(args.join(' '));
      expect(file).toBe('security');
      if (args[0] !== 'find-generic-password') throw new Error(`unexpected: ${args.join(' ')}`);
      const v = entries.get(args[args.indexOf('-a') + 1] as string);
      if (v === undefined) throw notFound();
      return { stdout: `${v}\n`, stderr: '' };
    };
    const v = await verifyLocalWallet({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'darwin', isTTY: false, exec },
    });
    expect(v.status).toBe('broken');
    expect(v.detail).toContain('legacy shared entry');
    // A diagnostic that re-keys the credential store is not a diagnostic: the
    // migration stays with the first real signing, which is where the decrypt
    // that PROVES ownership happens.
    expect(calls.filter((c) => !c.startsWith('find-generic-password'))).toEqual([]);
  });

  // Windows keeps a DPAPI-encrypted file per wallet, not a service/account entry,
  // so the remediation must not send that operator hunting for a keychain item
  // their machine has never had.
  it('names the DPAPI file, not a service/account entry, on the win32 legacy path', async () => {
    const key = generatePrivateKey();
    await writeWalletRecord(dataDir, await encryptedRecord(key)); // KNOWN_PASSPHRASE
    // Only the LEGACY shared blob exists, and it holds another wallet's passphrase.
    await mkdir(dataDir, { recursive: true });
    await writeFile(passphraseBlobPath(dataDir), 'ciphertext');
    const exec: ExecFn = async () => ({ stdout: 'someone-elses-passphrase\n', stderr: '' });

    const v = await verifyLocalWallet({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'win32', isTTY: false, exec },
    });
    expect(v.status).toBe('broken');
    expect(v.detail).toContain('legacy shared DPAPI passphrase file');
    expect(v.detail).not.toContain('service tenjin-cli');
    expect(v).toHaveProperty('fix');
    expect((v as { fix: string }).fix).toContain('DPAPI-protected passphrase file');
  });

  // The read deadline belongs to this read-only path and nowhere else (B3):
  // signing never kills a store read, so an OS unlock dialog stays up.
  it('is the only place in this module that sets a store read deadline', async () => {
    const src = await readFile(fileURLToPath(new URL('./local.ts', import.meta.url)), 'utf8');
    expect(src.match(/readDeadlineMs:/g)).toHaveLength(1);
    const verify = src.slice(
      src.indexOf('export async function verifyLocalWallet'),
      src.indexOf('function envWrongVerification'),
    );
    expect(verify).toContain('readDeadlineMs:');
  });

  it('verifies an env key by deriving it, with no keystore involved', async () => {
    const key = generatePrivateKey();
    const v = await verifyLocalWallet({
      dir: dataDir,
      env: { TENJIN_WALLET_KEY: key },
      passphrase: { platform: 'openbsd' },
    });
    expect(v.status).toBe('verified');
    expect(v.detail).toContain('TENJIN_WALLET_KEY');
  });
});

describe('parkOutgoingWallet', () => {
  it('refuses (REFUSED) when an archive already exists at the address — neither file changes', async () => {
    const account = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dataDir, { recursive: true });
    await writeFile(walletPath(dataDir), 'active-keystore');
    const dst = archivedWalletPath(account, dataDir);
    await writeFile(dst, 'existing-archive');

    const err = (await parkOutgoingWallet(dataDir, account).catch((e) => e)) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toContain(dst);
    // No clobber in either direction: the active wallet stayed active and the
    // existing archive kept its bytes.
    expect(await readFile(walletPath(dataDir), 'utf8')).toBe('active-keystore');
    expect(await readFile(dst, 'utf8')).toBe('existing-archive');
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

  it('invokes a passphrase resolver with the freshly derived address, before encrypting', async () => {
    let resolvedFor: string | undefined;
    const { address } = await createLocalWallet(dataDir, async (forAddress) => {
      resolvedFor = forAddress;
      return KNOWN_PASSPHRASE;
    });
    // The resolver saw the same address the wallet reports — the hook per-wallet
    // passphrase storage keys its OS-store entry by.
    expect(resolvedFor).toBe(address);
    const provider = createLocalProvider(envPass(KNOWN_PASSPHRASE));
    expect((await provider.getSigner()).address).toBe(address);
  });
});

describe('createLocalProvider.getSigner, non-interactive passphrase gate', () => {
  it('never prompts when isTTY:false; surfaces the coded no-passphrase error instead', async () => {
    // The exact passphrase override resolveWalletProvider now sets for a
    // non-interactive context (io.isTTY:false — every `tenjin mcp` context). With
    // no env/keychain passphrase, the resolver must fail with the coded error
    // rather than start a hidden-stdin prompt that would fight the MCP transport.
    await writeWalletRecord(dataDir, fakeRecord());
    const prompt = vi.fn(async () => 'never-called');
    const provider = createLocalProvider({
      dir: dataDir,
      env: {},
      passphrase: {
        isTTY: false,
        platform: 'linux',
        exec: (async () => ({ stdout: '', stderr: '' })) as ExecFn, // secret-service miss
        prompt,
      },
    });
    const err = (await provider.getSigner().catch((e) => e)) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('USAGE');
    expect(err.message).toContain('No wallet passphrase');
    expect(prompt).not.toHaveBeenCalled();
  });
});

/** One recorded `security` call. */
interface Call {
  args: string[];
  stdin?: string;
  opts?: { timeoutMs?: number };
}

/**
 * An in-memory macOS keychain behind the real `security` contract, with real
 * exit codes: a miss is 44, a duplicate add is 45, `-U` replaces, and the probe
 * (`default-keychain`) answers. `readBack` overrides what reads return AFTER
 * the first write (a conflicting writer, or a store that stops answering).
 */
function keychain(
  initial: Record<string, string> = {},
  o: { probe?: Error; readBack?: () => string | Error; read?: () => Error } = {},
): { exec: ExecFn; entries: Map<string, string>; calls: Call[] } {
  const entries = new Map(Object.entries(initial));
  const calls: Call[] = [];
  let wrote = false;
  const exec: ExecFn = async (file, args, stdin, opts) => {
    calls.push({ args, stdin, opts });
    expect(file).toBe('security');
    if (args[0] === 'default-keychain') {
      if (o.probe !== undefined) throw o.probe;
      return { stdout: '', stderr: '' };
    }
    if (args[0] === '-i') {
      const m = stdin?.match(
        /^add-generic-password -s tenjin-cli -a (\S+) (?:-w '([^']*)'|-X ([0-9a-f]+))( -U)?\n$/,
      );
      if (!m) throw new Error(`unexpected payload: ${String(stdin)}`);
      const account = m[1] as string;
      if (entries.has(account) && m[4] === undefined) {
        throw new StoreExecError('security', { code: 45 });
      }
      entries.set(account, m[2] ?? Buffer.from(m[3] as string, 'hex').toString('utf8'));
      wrote = true;
      return { stdout: '', stderr: '' };
    }
    const account = args[args.indexOf('-a') + 1] as string;
    if (args[0] === 'find-generic-password') {
      if (o.read !== undefined) throw o.read();
      if (wrote && o.readBack !== undefined) {
        const v = o.readBack();
        if (v instanceof Error) throw v;
        return { stdout: `${v}\n`, stderr: '' };
      }
      const v = entries.get(account);
      if (v === undefined) throw notFound();
      return { stdout: `${v}\n`, stderr: '' };
    }
    if (args[0] === 'delete-generic-password') {
      if (!entries.delete(account)) throw notFound();
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected security call: ${args.join(' ')}`);
  };
  return { exec, entries, calls };
}

const killed = (): StoreExecError =>
  new StoreExecError('security', { killed: true, signal: 'SIGKILL' });

/** Seed a real encrypted wallet under `passphrase`; returns its address and lowercase account. */
async function seedWallet(
  passphrase = KNOWN_PASSPHRASE,
): Promise<{ address: string; account: string }> {
  const key = generatePrivateKey();
  await writeWalletRecord(dataDir, await encryptedRecord(key, passphrase));
  const address = privateKeyToAccount(key).address;
  return { address, account: address.toLowerCase() };
}

/** Every person-facing string a wallet error or verdict carries, for the B1/S3 sweeps. */
function assertPersonFix(fix: string | undefined): void {
  expect(fix ?? '').not.toContain('set TENJIN_WALLET_PASSPHRASE to');
  expect(fix ?? '').not.toContain('TENJIN_WALLET_PASSPHRASE=');
  expect(fix ?? '').not.toContain('--insecure-storage');
  if ((fix ?? '').includes('tenjin wallet repair')) expect(fix).toContain(REPAIR_CLAUSE);
}

describe('wrong TENJIN_WALLET_PASSPHRASE falls through to the saved passphrase (decision 8)', () => {
  it('signs with the stored passphrase and warns once per provider, cache hits included', async () => {
    const { account } = await seedWallet();
    const store = keychain({ [account]: KNOWN_PASSPHRASE });
    const deps = {
      dir: dataDir,
      env: { TENJIN_WALLET_PASSPHRASE: 'the-wrong-one' },
      passphrase: { platform: 'darwin' as NodeJS.Platform, isTTY: false, exec: store.exec },
    };
    const warnings: WalletWarning[] = [];
    const provider = createLocalProvider({ ...deps, onWarning: (w) => warnings.push(w) });
    expect((await provider.getSigner()).address.toLowerCase()).toBe(account);
    expect(warnings).toEqual([{ code: 'env_passphrase_wrong', message: ENV_PASSPHRASE_WRONG }]);
    await provider.getSigner();
    expect(warnings).toHaveLength(1);
    // The fallback read carries no deadline (B3).
    expect(store.calls.every((c) => c.opts?.timeoutMs === undefined)).toBe(true);

    // A second provider instance hits the cache and still warns, once.
    const second: WalletWarning[] = [];
    const other = createLocalProvider({ ...deps, onWarning: (w) => second.push(w) });
    await other.getSigner();
    await other.getSigner();
    expect(second).toHaveLength(1);
  });

  it('a correct env passphrase opens on the first try and reads no store', async () => {
    await seedWallet();
    const exec = vi.fn<ExecFn>(async () => {
      throw new Error('no store may be read');
    });
    const provider = createLocalProvider({
      dir: dataDir,
      env: { TENJIN_WALLET_PASSPHRASE: KNOWN_PASSPHRASE },
      passphrase: { platform: 'darwin', isTTY: false, exec },
    });
    await provider.getSigner();
    expect(exec).not.toHaveBeenCalled();
  });

  it('env wrong with nothing stored is WALLET_INVALID_KEY, env_passphrase_wrong, definite', async () => {
    await seedWallet();
    const err = (await createLocalProvider(envPass('the-wrong-one'))
      .getSigner()
      .catch((e) => e)) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.message).toBe('Could not decrypt the wallet keystore.');
    expect(classifyUnlockError(err)).toEqual({
      reason: 'env_passphrase_wrong',
      definite: true,
      source: 'env',
    });
    assertPersonFix(err.fix);
    expect(err.fix).toContain('Remove it from the environment');
  });

  it('env wrong with a keychain that does not answer rethrows keychain_locked, prefixed', async () => {
    await seedWallet();
    const store = keychain({}, { read: killed });
    const err = (await createLocalProvider({
      dir: dataDir,
      env: { TENJIN_WALLET_PASSPHRASE: 'the-wrong-one' },
      passphrase: { platform: 'darwin', isTTY: false, exec: store.exec },
    })
      .getSigner()
      .catch((e) => e)) as CliError;
    expect(err.message.startsWith('TENJIN_WALLET_PASSPHRASE does not open the wallet, and ')).toBe(
      true,
    );
    expect(classifyUnlockError(err).reason).toBe('keychain_locked');
    expect(err.fix).toBe(KEYCHAIN_LOCKED_FIX);
  });
});

describe('signing throw sites carry details.unlock', () => {
  it('a store-served passphrase that does not decrypt: passphrase_wrong, the line-568 fix', async () => {
    const { account } = await seedWallet();
    const store = keychain({ [account]: 'not-it' });
    const err = (await createLocalProvider({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'darwin', isTTY: false, exec: store.exec },
    })
      .getSigner()
      .catch((e) => e)) as CliError;
    expect(err.message).toBe('Could not decrypt the wallet keystore.');
    expect(classifyUnlockError(err)).toMatchObject({
      reason: 'passphrase_wrong',
      source: 'keychain',
    });
    expect(err.fix).toBe(
      `The OS credential store entry (service tenjin-cli, account ${account}) does not decrypt it. Run \`tenjin wallet repair\` yourself ${REPAIR_CLAUSE}.`,
    );
  });

  it('the legacy slot that does not decrypt: passphrase_wrong, legacy', async () => {
    await seedWallet();
    const store = keychain({ wallet: 'someone-elses' });
    const err = (await createLocalProvider({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'darwin', isTTY: false, exec: store.exec },
    })
      .getSigner()
      .catch((e) => e)) as CliError;
    expect(classifyUnlockError(err)).toMatchObject({
      reason: 'passphrase_wrong',
      source: 'legacy',
    });
    assertPersonFix(err.fix);
  });

  it('a tampered file and an invalid env key carry wallet_corrupt and env_key_invalid', async () => {
    const key = generatePrivateKey();
    const other = privateKeyToAccount(generatePrivateKey()).address;
    await writeWalletRecord(dataDir, await encryptedRecord(key, KNOWN_PASSPHRASE, other));
    const tampered = await createLocalProvider(envPass(KNOWN_PASSPHRASE))
      .getSigner()
      .catch((e) => e);
    expect(classifyUnlockError(tampered).reason).toBe('wallet_corrupt');

    const badKey = await createLocalProvider({ dir: dataDir, env: { TENJIN_WALLET_KEY: 'nope' } })
      .getSigner()
      .catch((e) => e);
    expect(classifyUnlockError(badKey).reason).toBe('env_key_invalid');
  });
});

describe('verifyLocalWallet reasons', () => {
  const darwin = (exec: ExecFn) => ({ platform: 'darwin' as NodeJS.Platform, exec });

  it('no source: passphrase_missing', async () => {
    await seedWallet();
    const v = await verifyLocalWallet({
      dir: dataDir,
      env: {},
      passphrase: darwin(keychain().exec),
    });
    expect(v).toMatchObject({ status: 'unverified', reason: 'passphrase_missing' });
  });

  it('a keychain that does not answer: unverified keychain_locked, and every read got 5000 ms', async () => {
    await seedWallet();
    const store = keychain({}, { read: killed });
    const v = await verifyLocalWallet({ dir: dataDir, env: {}, passphrase: darwin(store.exec) });
    expect(v).toMatchObject({ status: 'unverified', reason: 'keychain_locked' });
    expect(v.detail).toContain('did not answer');
    expect(v.detail).toContain('so the keystore was not opened');
    expect(store.calls.length).toBeGreaterThan(0);
    expect(store.calls.every((c) => c.opts?.timeoutMs === 5000)).toBe(true);
  });

  it('env wrong with the saved passphrase working: verified, warning ENV_PASSPHRASE_WRONG, source the store', async () => {
    const { account } = await seedWallet();
    const store = keychain({ [account]: KNOWN_PASSPHRASE });
    const v = await verifyLocalWallet({
      dir: dataDir,
      env: { TENJIN_WALLET_PASSPHRASE: 'wrong' },
      passphrase: darwin(store.exec),
    });
    expect(v).toMatchObject({
      status: 'verified',
      source: 'keychain',
      warning: ENV_PASSPHRASE_WRONG,
    });
    expect(store.calls.every((c) => c.opts?.timeoutMs === 5000)).toBe(true);
  });

  it('env wrong with nothing working: broken env_passphrase_wrong', async () => {
    await seedWallet();
    const v = await verifyLocalWallet(envPass('wrong'));
    expect(v).toMatchObject({ status: 'broken', reason: 'env_passphrase_wrong' });
    assertPersonFix((v as { fix: string }).fix);
  });

  it('store wrong: broken passphrase_wrong, a fix ending in REPAIR_IN_TERMINAL', async () => {
    const { account } = await seedWallet();
    const v = await verifyLocalWallet({
      dir: dataDir,
      env: {},
      passphrase: darwin(keychain({ [account]: 'nope' }).exec),
    });
    expect(v).toMatchObject({ status: 'broken', reason: 'passphrase_wrong' });
    expect((v as { fix: string }).fix).toContain(REPAIR_CLAUSE);
    assertPersonFix((v as { fix: string }).fix);
  });

  it('legacy wrong: broken passphrase_wrong', async () => {
    await seedWallet();
    const v = await verifyLocalWallet({
      dir: dataDir,
      env: {},
      passphrase: darwin(keychain({ wallet: 'nope' }).exec),
    });
    expect(v).toMatchObject({ status: 'broken', reason: 'passphrase_wrong' });
    assertPersonFix((v as { fix: string }).fix);
  });

  it('mismatch: broken wallet_corrupt', async () => {
    const key = generatePrivateKey();
    const other = privateKeyToAccount(generatePrivateKey()).address;
    await writeWalletRecord(dataDir, await encryptedRecord(key, KNOWN_PASSPHRASE, other));
    const v = await verifyLocalWallet(envPass(KNOWN_PASSPHRASE));
    expect(v).toMatchObject({ status: 'broken', reason: 'wallet_corrupt' });
  });

  it('verified sources: passphrase-env, the store, legacy, key-env', async () => {
    const { account } = await seedWallet();
    expect(await verifyLocalWallet(envPass(KNOWN_PASSPHRASE))).toMatchObject({
      source: 'passphrase-env',
    });
    expect(
      await verifyLocalWallet({
        dir: dataDir,
        env: {},
        passphrase: darwin(keychain({ [account]: KNOWN_PASSPHRASE }).exec),
      }),
    ).toMatchObject({ status: 'verified', source: 'keychain' });
    expect(
      await verifyLocalWallet({
        dir: dataDir,
        env: {},
        passphrase: darwin(keychain({ wallet: KNOWN_PASSPHRASE }).exec),
      }),
    ).toMatchObject({ status: 'verified', source: 'legacy' });
    expect(
      await verifyLocalWallet({ dir: dataDir, env: { TENJIN_WALLET_KEY: generatePrivateKey() } }),
    ).toMatchObject({ status: 'verified', source: 'key-env' });
  });

  it('S2: a store read whose failure carries the secret never leaks it into the verdict', async () => {
    await seedWallet();
    const exec: ExecFn = async () => {
      throw { stdout: 'SECRET', stderr: 'boom', code: 1 };
    };
    const v = await verifyLocalWallet({ dir: dataDir, env: {}, passphrase: darwin(exec) });
    expect(v).toMatchObject({ status: 'unverified', reason: 'keychain_locked' });
    expect(JSON.stringify(v)).not.toContain('SECRET');
  });
});

describe('--replace with a wrong saved passphrase', () => {
  it('names the passphrase file it read, never an OS credential store entry', async () => {
    const { account } = await seedWallet();
    const path = passphraseFilePathFor(account, dataDir);
    await writeFile(path, 'not-this-wallets', { mode: 0o600 });
    const err = (await verifyAndPreserveOutgoingWallet({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'linux', isTTY: false, exec: emptySecretService },
    }).catch((e) => e)) as CliError;
    expect(err.code).toBe('REFUSED');
    expect(err.message).toContain('--replace refused');
    expect(err.fix).toContain(`fix the passphrase in ${path}`);
    expect(err.fix).not.toContain('OS credential store');
    await expect(stat(walletPath(dataDir))).resolves.toBeTruthy();
  });
});

describe('--replace with a prompt-sourced outgoing passphrase (decision 6)', () => {
  it('stored: the sidecar records {by: replace}', async () => {
    const { account } = await seedWallet();
    const store = keychain();
    const prompt = vi.fn(async (_label: string) => KNOWN_PASSPHRASE);
    const info = await verifyAndPreserveOutgoingWallet({
      dir: dataDir,
      env: {},
      passphrase: { platform: 'darwin', isTTY: true, exec: store.exec, prompt },
    });
    expect(info.passphraseLocation).toBe('store');
    expect(prompt).toHaveBeenCalledOnce();
    expect(String(prompt.mock.calls[0]?.[0]).toLowerCase()).toContain(account);
    expect(store.entries.get(account)).toBe(KNOWN_PASSPHRASE);
    expect(await readPassphraseRecord(dataDir, account)).toMatchObject({
      store: 'keychain',
      by: 'replace',
    });
  });

  it('a conflict (a different value reads back) refuses, writes no sidecar, parks nothing (S1)', async () => {
    await seedWallet();
    const store = keychain({}, { readBack: () => 'another-writer' });
    const err = (await verifyAndPreserveOutgoingWallet({
      dir: dataDir,
      env: {},
      passphrase: {
        platform: 'darwin',
        isTTY: true,
        exec: store.exec,
        prompt: async () => KNOWN_PASSPHRASE,
      },
    }).catch((e) => e)) as CliError;
    expect(err.code).toBe('REFUSED');
    expect(err.message).toContain('--replace refused');
    await expect(stat(passphraseRecordPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(walletPath(dataDir))).resolves.toBeTruthy();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a file-target store-failed carries FILE_STORE_FAILED_FIX',
    async () => {
      const { account } = await seedWallet();
      // freebsd has no OS store, so the target is the file; make it unwritable.
      await mkdir(passphraseFilePathFor(account, dataDir)); // a directory where the file goes
      const err = (await verifyAndPreserveOutgoingWallet({
        dir: dataDir,
        env: {},
        passphrase: { platform: 'freebsd', isTTY: true, prompt: async () => KNOWN_PASSPHRASE },
      }).catch((e) => e)) as CliError;
      const path = passphraseFilePathFor(account, dataDir);
      expect(err.code).toBe('REFUSED');
      expect(err.fix).toBe(FILE_STORE_FAILED_FIX(path));
    },
  );
});

describe('repairLocalWalletPassphrase', () => {
  const deps = (exec?: ExecFn, platform: NodeJS.Platform = 'darwin') => ({
    dir: dataDir,
    env: {},
    passphrase: { platform, isTTY: false, ...(exec !== undefined ? { exec } : {}) },
  });

  it('a wrong passphrase saves nothing', async () => {
    const { address } = await seedWallet();
    const store = keychain();
    const err = (await repairLocalWalletPassphrase(deps(store.exec), 'wrong').catch(
      (e) => e,
    )) as CliError;
    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.message).toBe(`That passphrase does not open wallet ${address}; nothing was saved.`);
    expect(classifyUnlockError(err)).toMatchObject({
      reason: 'passphrase_wrong',
      source: 'prompt',
    });
    expect(store.calls).toHaveLength(0);
    await expect(stat(passphraseRecordPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a platform with no store: the 0600 file plus the sidecar {file, repair}; wallet.json untouched', async () => {
    const { address, account } = await seedWallet();
    const before = await readFile(walletPath(dataDir), 'utf8');
    const out = await repairLocalWalletPassphrase(deps(undefined, 'freebsd'), KNOWN_PASSPHRASE);
    expect(out).toMatchObject({
      address,
      store: 'file',
      fileReason: 'no-keyring',
      alreadySaved: false,
    });
    expect(await readFile(passphraseFilePathFor(account, dataDir), 'utf8')).toBe(KNOWN_PASSPHRASE);
    expect(await readPassphraseRecord(dataDir, account)).toMatchObject({
      store: 'file',
      by: 'repair',
    });
    expect(await readFile(walletPath(dataDir), 'utf8')).toBe(before);
  });

  it('an existing WRONG keychain entry is replaced with -U, only after it is proven wrong', async () => {
    const { account } = await seedWallet();
    const store = keychain({ [account]: 'stale-value' });
    const out = await repairLocalWalletPassphrase(deps(store.exec), KNOWN_PASSPHRASE);
    expect(out).toMatchObject({
      store: 'keychain',
      replacedUnusableEntry: true,
      alreadySaved: false,
    });
    const add = store.calls.find((c) => c.args[0] === '-i');
    expect(add?.stdin?.endsWith(' -U\n')).toBe(true);
    expect(store.entries.get(account)).toBe(KNOWN_PASSPHRASE);
  });

  it('an existing correct entry: alreadySaved, no write', async () => {
    const { account } = await seedWallet();
    const store = keychain({ [account]: KNOWN_PASSPHRASE });
    const out = await repairLocalWalletPassphrase(deps(store.exec), KNOWN_PASSPHRASE);
    expect(out.alreadySaved).toBe(true);
    expect(store.calls.filter((c) => c.args[0] === '-i')).toHaveLength(0);
  });

  it('a conflict after the write refuses, with REPAIR_CLAUSE, and writes no sidecar (S1)', async () => {
    await seedWallet();
    const store = keychain({}, { readBack: () => 'another-writer' });
    const err = (await repairLocalWalletPassphrase(deps(store.exec), KNOWN_PASSPHRASE).catch(
      (e) => e,
    )) as CliError;
    expect(err.code).toBe('REFUSED');
    expect(err.message).toContain('holds a different passphrase');
    expect(err.fix).toContain(REPAIR_CLAUSE);
    await expect(stat(passphraseRecordPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a probe that does not answer refuses with KEYCHAIN_LOCKED_FIX and no sidecar', async () => {
    await seedWallet();
    const store = keychain({}, { probe: killed() });
    const err = (await repairLocalWalletPassphrase(deps(store.exec), KNOWN_PASSPHRASE).catch(
      (e) => e,
    )) as CliError;
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toBe(KEYCHAIN_LOCKED_FIX);
    expect(classifyUnlockError(err).reason).toBe('keychain_locked');
    await expect(stat(passphraseRecordPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a write that never reads back (uncertain) refuses with KEYCHAIN_LOCKED_FIX', async () => {
    await seedWallet();
    const store = keychain({}, { readBack: () => killed() });
    const err = (await repairLocalWalletPassphrase(deps(store.exec), KNOWN_PASSPHRASE).catch(
      (e) => e,
    )) as CliError;
    expect(err.fix).toBe(KEYCHAIN_LOCKED_FIX);
    await expect(stat(passphraseRecordPath(dataDir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a file-target store-failed carries FILE_STORE_FAILED_FIX, never KEYCHAIN_LOCKED_FIX', async () => {
    const { account } = await seedWallet();
    await mkdir(passphraseFilePathFor(account, dataDir)); // a directory where the file goes
    const err = (await repairLocalWalletPassphrase(deps(undefined, 'freebsd'), KNOWN_PASSPHRASE, {
      insecureStorage: true,
    }).catch((e) => e)) as CliError;
    const path = passphraseFilePathFor(account, dataDir);
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toBe(FILE_STORE_FAILED_FIX(path));
    expect(err.details).toEqual({ passphraseStore: { kind: 'file-write-failed', path } });
  });

  it('linux with Secret Service absent: the file store, fileReason no-keyring (S4)', async () => {
    await seedWallet();
    const exec: ExecFn = async () => {
      throw new StoreExecError('secret-tool', { code: 'ENOENT', enoent: true });
    };
    const out = await repairLocalWalletPassphrase(deps(exec, 'linux'), KNOWN_PASSPHRASE);
    expect(out).toMatchObject({ store: 'file', fileReason: 'no-keyring' });
  });

  it('a recorded store that already reads it back is alreadySaved with no write', async () => {
    const { account } = await seedWallet();
    await writePassphraseRecord(dataDir, account, { store: 'keychain', by: 'create' });
    const store = keychain({ [account]: KNOWN_PASSPHRASE });
    const out = await repairLocalWalletPassphrase(deps(store.exec), KNOWN_PASSPHRASE);
    expect(out).toMatchObject({ alreadySaved: true, store: 'keychain' });
    expect(store.calls.map((c) => c.args[0])).toEqual(['find-generic-password']);
  });

  it('openKeystore says ok, wrong or mismatch', async () => {
    const key = generatePrivateKey();
    const record = await encryptedRecord(key);
    const address = privateKeyToAccount(key).address;
    expect(await openKeystore(record.keystore, address, KNOWN_PASSPHRASE)).toBe('ok');
    expect(await openKeystore(record.keystore, address, 'nope')).toBe('wrong');
    const other = privateKeyToAccount(generatePrivateKey()).address;
    expect(await openKeystore(record.keystore, other, KNOWN_PASSPHRASE)).toBe('mismatch');
  });
});

describe('localWalletDiagnostics and the sidecar', () => {
  it.skipIf(process.platform === 'win32')(
    'reports the recorded store, and warns on a loose passphrase file',
    async () => {
      const { account } = await seedWallet();
      await writePassphraseRecord(dataDir, account, { store: 'file', by: 'create' });
      await writeFile(passphraseFilePathFor(account, dataDir), 'x', { mode: 0o644 });
      const { chmod } = await import('node:fs/promises');
      await chmod(passphraseFilePathFor(account, dataDir), 0o644);
      const d = await localWalletDiagnostics({ dir: dataDir, env: {} });
      expect(d.passphraseStore).toBe('file');
      expect(d.warnings.some((w) => w.startsWith('Passphrase file permissions are 644'))).toBe(
        true,
      );
    },
  );
});
