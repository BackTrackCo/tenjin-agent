import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { CliError } from '../errors';
import {
  archivedWalletPath,
  passphraseBlobPath,
  passphraseBlobPathFor,
  walletPath,
} from '../paths';
import { readWalletRecord, writeWalletRecord } from './store';
import { createLocalProvider, createLocalWallet, parkOutgoingWallet } from './local';
import type { ExecFn } from './passphrase';
import { KNOWN_PASSPHRASE, encryptedRecord, fakeRecord } from './test-support';

// This suite runs real ox scrypt (N=262144) via encryptedRecord; the 5s default
// flakes under parallel vitest load (tenjin-agent#47).
vi.setConfig({ testTimeout: 120000 });

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
        if (entries.has(m[1] as string)) throw new Error('errSecDuplicateItem');
        entries.set(m[1] as string, m[2] as string);
        return { stdout: '', stderr: '' };
      }
      const acct = args[args.indexOf('-a') + 1] as string;
      if (args[0] === 'find-generic-password') {
        const v = entries.get(acct);
        if (v === undefined) throw new Error('not found');
        return { stdout: `${v}\n`, stderr: '' };
      }
      if (args[0] === 'delete-generic-password') {
        if (!entries.delete(acct)) throw new Error('not found');
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
        if (v === undefined) throw new Error('not found');
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
        if (v === undefined) throw new Error('not found');
        return { stdout: v, stderr: '' };
      }
      if (args[0] === 'store') {
        entries.set(account, stdin ?? '');
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'clear') {
        if (!entries.delete(account)) throw new Error('not found');
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
