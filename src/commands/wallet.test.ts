import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import * as Keystore from 'ox/Keystore';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';
import type { WalletProvider } from '../lib/wallet';
import type { ExecFn } from '../lib/wallet/passphrase';

// This suite runs real ox scrypt (N=262144) several times per test; the 5s
// default flakes under parallel vitest load (tenjin-agent#47).
vi.setConfig({ testTimeout: 120000 });

// Balance is the only path that hits the chain; mock the RPC read so the whole
// suite stays offline and deterministic. viem's key derivation stays real.
vi.mock('../lib/usdc', () => ({
  USDC_ADDRESS: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  USDC_DECIMALS: 6,
  getUsdcBalance: vi.fn(),
}));

import { getUsdcBalance } from '../lib/usdc';
import { runWalletCreate, runWalletShow, runWalletBalance } from './wallet';

const mockedBalance = vi.mocked(getUsdcBalance);
const isWindows = process.platform === 'win32';
const PASSPHRASE = 'test-passphrase-123';

let tmp: string;
let dataDir: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-wallet-'));
  // A nested, not-yet-created dir so the atomic writer creates it 0700 itself.
  dataDir = join(tmp, '.tenjin');
  mockedBalance.mockReset();
  // Encrypt via the env passphrase by default: deterministic, no keychain/TTY.
  vi.stubEnv('TENJIN_WALLET_PASSPHRASE', PASSPHRASE);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 10000 },
    dataDir,
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
}

async function catchCliError(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (err) {
    return err as CliError;
  }
  throw new Error('expected a CliError to be thrown');
}

const walletFile = () => join(dataDir, 'wallet.json');

/**
 * An in-memory macOS keychain behind the real `security` argv/stdin contract:
 * account -> passphrase entries, duplicate adds FAIL (matching the -U-less
 * add-generic-password), reads miss with an error. `writes` records every
 * `security -i` call for argv-hygiene assertions.
 */
function fakeKeychain(initial: Record<string, string> = {}): {
  exec: ExecFn;
  entries: Map<string, string>;
  writes: { args: string[]; stdin?: string }[];
} {
  const entries = new Map(Object.entries(initial));
  const writes: { args: string[]; stdin?: string }[] = [];
  const exec: ExecFn = async (file, args, stdin) => {
    expect(file).toBe('security');
    if (args[0] === '-i') {
      writes.push({ args, stdin });
      const m = stdin?.match(/^add-generic-password -s tenjin-cli -a (\S+) -w '([^']*)'\n$/);
      if (!m) throw new Error(`unexpected security -i payload: ${String(stdin)}`);
      if (entries.has(m[1] as string)) throw new Error('errSecDuplicateItem');
      entries.set(m[1] as string, m[2] as string);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'find-generic-password') {
      const value = entries.get(args[args.indexOf('-a') + 1] as string);
      if (value === undefined) throw new Error('could not be found');
      return { stdout: `${value}\n`, stderr: '' };
    }
    if (args[0] === 'delete-generic-password') {
      if (!entries.delete(args[args.indexOf('-a') + 1] as string)) {
        throw new Error('could not be found');
      }
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected security call: ${args.join(' ')}`);
  };
  return { exec, entries, writes };
}
const readStored = async () =>
  JSON.parse(await readFile(walletFile(), 'utf8')) as {
    schemaVersion: number;
    address: string;
    keystore: { version: number };
  };

/** Decrypt the on-disk wallet keystore with `passphrase` and return the address it derives. */
async function addressFromWalletFile(passphrase: string): Promise<string> {
  const rec = JSON.parse(await readFile(walletFile(), 'utf8')) as { keystore: Keystore.Keystore };
  const derived = await Keystore.toKeyAsync(rec.keystore, { password: passphrase });
  const key = Keystore.decrypt(rec.keystore, derived);
  return privateKeyToAccount(key).address;
}

/** A remote-style provider: describe() works, getSigner() must never be called by show/balance. */
function fakeRemoteProvider(
  address: Address,
  opts: { describeRejects?: boolean } = {},
): { provider: WalletProvider; getSigner: ReturnType<typeof vi.fn> } {
  const getSigner = vi.fn(async () => {
    throw new Error('getSigner must not be called by show/balance');
  });
  const provider: WalletProvider = {
    id: 'fake-remote',
    describe: async () => {
      if (opts.describeRejects) throw new Error('remote describe failed');
      return {
        address,
        provider: 'fake-remote',
        credentialSource: 'remote',
        policyEnforcement: 'provider',
      };
    },
    getSigner,
    // A remote provider has no local file: no path, no perms/shadow warnings.
    diagnostics: async () => ({ warnings: [] }),
  };
  return { provider, getSigner };
}

describe('runWalletCreate', () => {
  it.skipIf(isWindows)('writes a 0600 wallet file inside a 0700 dir', async () => {
    await runWalletCreate(makeCtx());
    expect((await stat(walletFile())).mode & 0o777).toBe(0o600);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
  });

  it('stores an encrypted keystore v2 record and never the raw key', async () => {
    const res = await runWalletCreate(makeCtx());
    const address = (res.data as { address: string }).address;
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const stored = await readStored();
    expect(stored.schemaVersion).toBe(2);
    expect(stored.keystore.version).toBe(3);
    expect(stored.address).toBe(address);
    expect(res.data).toMatchObject({
      provider: 'local',
      policyEnforcement: 'client-only',
      keyStorage: 'encrypted (keystore v3, scrypt)',
      passphraseSource: 'env',
    });
    // The plaintext private key must never be written to disk.
    const raw = await readFile(walletFile(), 'utf8');
    expect(raw).not.toMatch(/0x[0-9a-f]{64}/i);
    expect(raw).not.toContain('privateKey');
  });

  it('emits the exact funding line', async () => {
    const res = await runWalletCreate(makeCtx());
    expect(res.humanLines).toContain('Send USDC on Base. $5 covers ~50 typical resources.');
  });

  it('reports that the key is stored encrypted', async () => {
    const res = await runWalletCreate(makeCtx());
    expect(res.humanLines?.some((l) => l.includes('keystore v3'))).toBe(true);
  });

  it('refuses to overwrite an existing wallet (WALLET_EXISTS, exit 3)', async () => {
    await runWalletCreate(makeCtx());
    const err = await catchCliError(runWalletCreate(makeCtx()));
    expect(err.code).toBe('WALLET_EXISTS');
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain(walletFile());
    // The explicit escape hatch is --replace, and the unrecoverable part is the
    // PASSPHRASE in the OS credential store — the error must name both rather
    // than pointing only at the keystore file.
    expect(err.fix).toContain('--replace');
    expect(err.fix).toContain('passphrase');
    expect(err.fix).toContain('credential store');
    expect(err.fix).toContain('stranded');
  });

  it('warns about env shadowing in both data and human lines', async () => {
    vi.stubEnv('TENJIN_WALLET_KEY', generatePrivateKey());
    const res = await runWalletCreate(makeCtx());
    const warnings = (res.data as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes('TENJIN_WALLET_KEY'))).toBe(true);
    expect(res.humanLines?.some((l) => l.includes('TENJIN_WALLET_KEY'))).toBe(true);
  });

  it('auto-generates and stores a per-address keychain passphrase on macOS when env is unset', async () => {
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', ''); // clear the env passphrase
    const { exec, entries, writes } = fakeKeychain();
    const res = await runWalletCreate(makeCtx(), {
      passphrase: { platform: 'darwin', isTTY: false, exec },
    });
    const data = res.data as { address: string; passphraseSource: string };
    const account = data.address.toLowerCase();
    expect(data.passphraseSource).toBe('keychain');
    expect(res.humanLines?.some((l) => l.includes('keychain') && l.includes(account))).toBe(true);
    // Exactly one write, keyed by the NEW wallet's own address — no shared slot,
    // no -U update-in-place; the secret transits stdin, never argv.
    expect(writes).toHaveLength(1);
    const write = writes[0] as { args: string[]; stdin?: string };
    expect(write.args).toEqual(['-i']);
    expect(write.stdin).toContain(`-a ${account} `);
    // Check the command's own flags, not the whole stdin: the payload embeds a
    // real random base64url passphrase (the alphabet includes both `-` and `U`),
    // and a `.not.toContain('-U')` against the full string spuriously fails
    // whenever those two characters land adjacent inside the secret rather than
    // in a flag — ~1% of runs. Same defect #39 fixed in passphrase.test.ts
    // (0577b95); fakeKeychain's strict payload regex above already pins the full
    // command shape, so slicing off the quoted `-w` value loses no coverage.
    const flagsOnly = write.stdin?.split(` -w '`)[0] ?? '';
    expect(flagsOnly).not.toContain('-U');
    const stored = entries.get(account);
    expect(stored).toBeDefined();
    expect((stored as string).length).toBeGreaterThanOrEqual(32);
    expect(stored as string).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(write.args.some((a) => a.includes(stored as string))).toBe(false);
    expect(entries.size).toBe(1); // nothing else was written
  });

  // The operator's loss scenario from issue #32, now behind the explicit flag:
  // replacing archives the outgoing wallet instead of overwriting its passphrase.
  it('--replace archives the outgoing wallet: entry preserved, keystore parked, still decryptable', async () => {
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', '');
    const { exec, entries } = fakeKeychain({ wallet: 'legacy-untouched-pass' });
    const opts = { passphrase: { platform: 'darwin' as NodeJS.Platform, isTTY: false, exec } };

    const firstRes = await runWalletCreate(makeCtx(), opts);
    const firstAddress = (firstRes.data as { address: string }).address;
    const firstAccount = firstAddress.toLowerCase();
    const firstPass = entries.get(firstAccount) as string;

    const secondRes = await runWalletCreate(makeCtx(), { ...opts, replace: true });
    const second = secondRes.data as {
      address: string;
      replaced?: { address: string; archivedWalletPath: string; passphrasePreserved: string };
    };
    expect(second.address.toLowerCase()).not.toBe(firstAccount);
    // The old entry survives byte-identical, the new wallet has its own entry,
    // and an unrelated legacy slot belonging to some other wallet is untouched.
    expect(entries.get(firstAccount)).toBe(firstPass);
    expect(entries.get(second.address.toLowerCase())).toBeDefined();
    expect(entries.get('wallet')).toBe('legacy-untouched-pass');
    // Exactly one wallet is active — the new one.
    expect((await readStored()).address).toBe(second.address);
    // The replaced wallet is reported: where its keystore went and that the
    // passphrase is preserved.
    expect(second.replaced).toMatchObject({ address: firstAddress, passphrasePreserved: 'store' });
    const archivedPath = join(dataDir, `wallet.${firstAccount}.json.bak`);
    expect(second.replaced?.archivedWalletPath).toBe(archivedPath);
    expect(
      secondRes.humanLines?.some((l) => l.includes(firstAddress) && l.includes('archived')),
    ).toBe(true);
    // The pinned recovery property: the ARCHIVED keystore still decrypts with the
    // PRESERVED entry, deriving the old address.
    const rec = JSON.parse(await readFile(archivedPath, 'utf8')) as {
      keystore: Keystore.Keystore;
    };
    const derived = await Keystore.toKeyAsync(rec.keystore, { password: firstPass });
    const key = Keystore.decrypt(rec.keystore, derived);
    expect(privateKeyToAccount(key).address).toBe(firstAddress);
  });

  it('--replace refuses (REFUSED) when the outgoing passphrase cannot be verified, changing nothing', async () => {
    // Wallet encrypted with the env passphrase, which is then lost; the keychain
    // holds a WRONG value under the wallet's account.
    const created = await runWalletCreate(makeCtx());
    const address = (created.data as { address: string }).address;
    const account = address.toLowerCase();
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', '');
    const { exec, entries } = fakeKeychain({ [account]: 'not-the-passphrase' });
    const before = await readFile(walletFile(), 'utf8');

    const err = await catchCliError(
      runWalletCreate(makeCtx(), {
        replace: true,
        passphrase: { platform: 'darwin', isTTY: false, exec },
      }),
    );
    expect(err.code).toBe('REFUSED');
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain(address);
    // The switch never happened: same active wallet, no archive, store untouched.
    expect(await readFile(walletFile(), 'utf8')).toBe(before);
    await expect(stat(join(dataDir, `wallet.${account}.json.bak`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(entries.size).toBe(1);
    expect(entries.get(account)).toBe('not-the-passphrase');
  });

  it('--replace re-keys a legacy shared slot under the outgoing address before switching', async () => {
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', '');
    // Build a wallet, then relocate its generated passphrase into the legacy
    // shared slot — the exact layout of a pre-per-wallet install.
    const seed = fakeKeychain();
    const firstRes = await runWalletCreate(makeCtx(), {
      passphrase: { platform: 'darwin', isTTY: false, exec: seed.exec },
    });
    const firstAccount = (firstRes.data as { address: string }).address.toLowerCase();
    const pass = seed.entries.get(firstAccount) as string;
    const { exec, entries } = fakeKeychain({ wallet: pass }); // legacy slot only

    const secondRes = await runWalletCreate(makeCtx(), {
      replace: true,
      passphrase: { platform: 'darwin', isTTY: false, exec },
    });
    const secondAccount = (secondRes.data as { address: string }).address.toLowerCase();
    // The legacy slot became the OLD wallet's own entry (the archive of record),
    // the new wallet wrote its own, and the shared slot is retired.
    expect(entries.get(firstAccount)).toBe(pass);
    expect(entries.has('wallet')).toBe(false);
    expect(entries.get(secondAccount)).toBeDefined();
    expect(entries.size).toBe(2);
  });

  it('--replace with the env passphrase archives the keystore and reports env as the durable copy', async () => {
    const firstRes = await runWalletCreate(makeCtx());
    const firstAddress = (firstRes.data as { address: string }).address;
    const secondRes = await runWalletCreate(makeCtx(), { replace: true });
    const data = secondRes.data as {
      address: string;
      replaced?: { address: string; passphrasePreserved: string };
    };
    expect(data.replaced).toMatchObject({ address: firstAddress, passphrasePreserved: 'env' });
    expect((await readStored()).address).toBe(data.address);
    expect(secondRes.humanLines?.some((l) => l.includes('TENJIN_WALLET_PASSPHRASE'))).toBe(true);
    // The archived keystore still decrypts with the env passphrase.
    const rec = JSON.parse(
      await readFile(join(dataDir, `wallet.${firstAddress.toLowerCase()}.json.bak`), 'utf8'),
    ) as { keystore: Keystore.Keystore };
    const derived = await Keystore.toKeyAsync(rec.keystore, { password: PASSPHRASE });
    const key = Keystore.decrypt(rec.keystore, derived);
    expect(privateKeyToAccount(key).address).toBe(firstAddress);
  });

  // The post-rename window from the review: every fallible step of the
  // replacement (passphrase store included) must run BEFORE the old keystore
  // moves, so a failure leaves the OLD wallet active, visible, and untouched.
  it('a failure while preparing the replacement leaves the old wallet active (no park, no loss)', async () => {
    const created = await runWalletCreate(makeCtx()); // env passphrase
    const address = (created.data as { address: string }).address;
    const account = address.toLowerCase();
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', '');
    // A store that can READ (the old wallet's entry is there) but cannot WRITE:
    // the archive half succeeds, then preparing the new wallet's passphrase fails.
    const entries = new Map<string, string>([[account, PASSPHRASE]]);
    const exec: ExecFn = async (file, args) => {
      expect(file).toBe('security');
      if (args[0] === 'find-generic-password') {
        const value = entries.get(args[args.indexOf('-a') + 1] as string);
        if (value === undefined) throw new Error('not found');
        return { stdout: `${value}\n`, stderr: '' };
      }
      throw new Error('keychain is read-only'); // any write/delete fails
    };
    const before = await readFile(walletFile(), 'utf8');

    const err = await catchCliError(
      runWalletCreate(makeCtx(), {
        replace: true,
        passphrase: { platform: 'darwin', isTTY: false, exec },
      }),
    );
    expect(err.code).toBe('USAGE'); // the new wallet's passphrase had nowhere durable to go
    // The old wallet never moved: still the active wallet, no .bak, show still works.
    expect(await readFile(walletFile(), 'utf8')).toBe(before);
    await expect(stat(join(dataDir, `wallet.${account}.json.bak`))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await runWalletShow(makeCtx())).data).toMatchObject({ address });
  });

  it('--replace archives a prompt-entered passphrase to the store when its characters allow', async () => {
    const created = await runWalletCreate(makeCtx()); // PASSPHRASE is base64url-safe
    const address = (created.data as { address: string }).address;
    const account = address.toLowerCase();
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', '');
    const { exec, entries } = fakeKeychain(); // both entries missing: resolution prompts
    const prompt = vi.fn(async () => PASSPHRASE);

    const res = await runWalletCreate(makeCtx(), {
      replace: true,
      passphrase: { platform: 'darwin', isTTY: true, exec, prompt },
    });
    const data = res.data as {
      replaced?: { address: string; passphrasePreserved: string; unarchivedReason?: string };
    };
    expect(prompt).toHaveBeenCalled();
    expect(data.replaced).toMatchObject({ address, passphrasePreserved: 'store' });
    expect(data.replaced?.unarchivedReason).toBeUndefined();
    // The typed passphrase was archived under the OLD wallet's own account.
    expect(entries.get(account)).toBe(PASSPHRASE);
  });

  it('--replace names the keychain character gate when a typed passphrase cannot be archived', async () => {
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', 'has spaces in it');
    const created = await runWalletCreate(makeCtx());
    const address = (created.data as { address: string }).address;
    const account = address.toLowerCase();
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', '');
    const { exec, entries } = fakeKeychain();
    const prompt = vi.fn(async () => 'has spaces in it');

    const res = await runWalletCreate(makeCtx(), {
      replace: true,
      passphrase: { platform: 'darwin', isTTY: true, exec, prompt },
    });
    const data = res.data as {
      replaced?: { passphrasePreserved: string; unarchivedReason?: string };
    };
    expect(data.replaced).toMatchObject({
      passphrasePreserved: 'unarchived',
      unarchivedReason: 'rejected-characters',
    });
    // The message blames the keychain's character gate, not a missing store.
    const line = res.humanLines?.find((l) => l.includes('NOT archived'));
    expect(line).toContain('base64url');
    expect(line).not.toContain('no OS credential store');
    // Nothing was written under the old account; the keystore was still parked.
    expect(entries.has(account)).toBe(false);
    await expect(
      readFile(join(dataDir, `wallet.${account}.json.bak`), 'utf8'),
    ).resolves.toBeTruthy();
  });

  it('errors USAGE when no passphrase source is available (headless, non-mac)', async () => {
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', '');
    const err = await catchCliError(
      runWalletCreate(makeCtx(), { passphrase: { platform: 'linux', isTTY: false } }),
    );
    expect(err.code).toBe('USAGE');
    expect(err.fix).toContain('TENJIN_WALLET_PASSPHRASE');
  });

  // Serialized by the create lock: the loser blocks until the winner commits, then
  // trips the exclusive pre-check and surfaces WALLET_EXISTS — never a clobber. The
  // exclusive write stays the final authority for the single-process crash window.
  it('two concurrent creates: one wins, the other is WALLET_EXISTS, no clobber', async () => {
    const ctx = makeCtx();
    const results = await Promise.allSettled([runWalletCreate(ctx), runWalletCreate(ctx)]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(((losers[0] as PromiseRejectedResult).reason as CliError).code).toBe('WALLET_EXISTS');
    const winner = (winners[0] as PromiseFulfilledResult<{ data: { address: string } }>).value.data;
    expect((await readStored()).address).toBe(winner.address);
  });

  // The store-write race the lock actually closes: with NO env passphrase each racer
  // auto-generates a distinct passphrase and persists it to the (shared, last-writer-
  // wins) OS store BEFORE the no-clobber file write. Unserialized, the store could end
  // up holding the LOSER's passphrase while the winner's wallet is on disk — orphaning
  // the wallet from any passphrase that decrypts it. The lock forces one full create at
  // a time, so the store's final passphrase must decrypt the written wallet.
  it('two concurrent creates without env: the stored passphrase decrypts the winner wallet', async () => {
    vi.stubEnv('TENJIN_WALLET_PASSPHRASE', ''); // clear env; force the OS-store path

    // One shared fake "OS store" (a macOS keychain), last-writer-wins across both
    // racers; each racer gets its OWN recording exec so we can see who actually stored.
    const keychain: { value: string | null } = { value: null };
    const storedByCall: string[] = [];
    const makeExec = (): ExecFn => async (file, args, stdin) => {
      expect(file).toBe('security');
      if (args[0] === '-i') {
        // Write: the generated passphrase arrives on stdin, never argv.
        const pass = stdin?.match(/-w '([^']+)'/)?.[1];
        expect(pass).toBeDefined();
        storedByCall.push(pass as string);
        keychain.value = pass as string; // last store-writer wins the shared store
        return { stdout: '', stderr: '' };
      }
      // Read (find-generic-password -w): serve the shared store's current value.
      return { stdout: keychain.value !== null ? `${keychain.value}\n` : '', stderr: '' };
    };
    const run = () =>
      runWalletCreate(makeCtx(), {
        passphrase: { platform: 'darwin', isTTY: false, exec: makeExec() },
      });

    const results = await Promise.allSettled([run(), run()]);
    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(((losers[0] as PromiseRejectedResult).reason as CliError).code).toBe('WALLET_EXISTS');

    // The lock means only the winner ever reached passphrase generation + store; the
    // loser blocked, then exited WALLET_EXISTS without generating or storing anything.
    expect(storedByCall).toHaveLength(1);

    const winner = (
      winners[0] as PromiseFulfilledResult<{
        data: { address: string; passphraseSource: string };
      }>
    ).value.data;
    expect(winner.passphraseSource).toBe('keychain');
    expect((await readStored()).address).toBe(winner.address);

    // The heart of the regression: the passphrase now sitting in the shared store must
    // decrypt the wallet that actually landed on disk (deriving its stored address).
    expect(keychain.value).not.toBeNull();
    const derived = await addressFromWalletFile(keychain.value as string);
    expect(derived.toLowerCase()).toBe(winner.address.toLowerCase());
  });
});

describe('runWalletShow', () => {
  it('returns the describe() shape plus custody posture from the file provider', async () => {
    const created = await runWalletCreate(makeCtx());
    const res = await runWalletShow(makeCtx());
    expect(res.data).toMatchObject({
      address: (created.data as { address: string }).address,
      provider: 'local',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
      walletPath: walletFile(),
      keyStorage: 'encrypted (keystore v3, scrypt)',
      passphraseSource: 'TENJIN_WALLET_PASSPHRASE',
    });
  });

  it('lists archived (replaced) wallets as a recovery hint, not a wallet switcher', async () => {
    const firstRes = await runWalletCreate(makeCtx());
    const firstAccount = (firstRes.data as { address: string }).address.toLowerCase();
    const secondRes = await runWalletCreate(makeCtx(), { replace: true });
    const res = await runWalletShow(makeCtx());
    const data = res.data as { address: string; archivedWallets?: string[] };
    // ONE active wallet — the new one; the archived address appears only as a
    // recovery listing.
    expect(data.address).toBe((secondRes.data as { address: string }).address);
    expect(data.archivedWallets).toEqual([firstAccount]);
    expect(res.humanLines?.some((l) => l.includes('Archived') && l.includes(firstAccount))).toBe(
      true,
    );
  });

  it('does not decrypt and never leaks a private key', async () => {
    await runWalletCreate(makeCtx());
    const res = await runWalletShow(makeCtx());
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('ciphertext');
    expect(serialized).not.toMatch(/0x[0-9a-f]{64}/i);
  });

  it('rejects a pre-encryption v1 wallet file with the recreate fix', async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      walletFile(),
      JSON.stringify({
        schemaVersion: 1,
        provider: 'local',
        address: privateKeyToAccount(generatePrivateKey()).address,
        privateKey: generatePrivateKey(),
        createdAt: new Date().toISOString(),
      }),
    );
    const err = await catchCliError(runWalletShow(makeCtx()));
    expect(err.code).toBe('WALLET_INVALID_KEY');
    expect(err.message).toContain('predates encrypted storage');
  });

  it.skipIf(isWindows)('warns when file permissions are not 0600', async () => {
    await runWalletCreate(makeCtx());
    await chmod(walletFile(), 0o644);
    const res = await runWalletShow(makeCtx());
    const warnings = (res.data as { warnings: string[] }).warnings;
    expect(warnings.some((w) => w.includes('permissions'))).toBe(true);
  });

  it('reports env credential source and shadow warning when env shadows the file', async () => {
    await runWalletCreate(makeCtx());
    vi.stubEnv('TENJIN_WALLET_KEY', generatePrivateKey());
    const res = await runWalletShow(makeCtx());
    const data = res.data as { credentialSource: string; warnings: string[] };
    expect(data.credentialSource).toBe('env');
    expect(data.warnings.some((w) => w.includes('shadows'))).toBe(true);
  });

  it('does not call getSigner and returns the provider posture (fake remote)', async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const { provider, getSigner } = fakeRemoteProvider(address);
    const res = await runWalletShow(makeCtx(), { provider });
    expect(res.data).toMatchObject({
      address,
      policyEnforcement: 'provider',
      provider: 'fake-remote',
    });
    expect(getSigner).not.toHaveBeenCalled();
  });

  it('normalizes a provider describe() rejection to PROVIDER_ERROR', async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const { provider } = fakeRemoteProvider(address, { describeRejects: true });
    const err = await catchCliError(runWalletShow(makeCtx(), { provider }));
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.exitCode).toBe(1);
  });

  it('remote provider ignores a stale local wallet.json + env key (no contamination, no leak)', async () => {
    await runWalletCreate(makeCtx());
    await chmod(walletFile(), 0o644);
    vi.stubEnv('TENJIN_WALLET_KEY', generatePrivateKey());

    const remoteAddress = privateKeyToAccount(generatePrivateKey()).address;
    const { provider } = fakeRemoteProvider(remoteAddress);
    const res = await runWalletShow(makeCtx(), { provider });

    const data = res.data as {
      address: string;
      walletPath?: string;
      keyStorage?: string;
      warnings: string[];
    };
    expect(data.address).toBe(remoteAddress);
    expect(data.walletPath).toBeUndefined();
    expect(data.keyStorage).toBeUndefined();
    expect(data.warnings).toEqual([]);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toMatch(/0x[0-9a-f]{64}/i);
  });
});

describe('runWalletBalance', () => {
  it('returns dual-form money from the on-chain read', async () => {
    await runWalletCreate(makeCtx());
    mockedBalance.mockResolvedValue(250000n);
    const res = await runWalletBalance(makeCtx());
    expect((res.data as { balance: unknown }).balance).toEqual({ atomic: '250000', usd: '0.25' });
  });

  it('maps an RPC failure to RPC_ERROR with a config fix', async () => {
    await runWalletCreate(makeCtx());
    mockedBalance.mockRejectedValue(new Error('rpc down'));
    const err = await catchCliError(runWalletBalance(makeCtx()));
    expect(err.code).toBe('RPC_ERROR');
    expect(err.exitCode).toBe(1);
    expect(err.fix).toContain('tenjin config set rpcUrl');
  });

  it('reads balance keylessly through a fake remote provider', async () => {
    const address = privateKeyToAccount(generatePrivateKey()).address;
    const { provider, getSigner } = fakeRemoteProvider(address);
    mockedBalance.mockResolvedValue(1000000n);
    const res = await runWalletBalance(makeCtx(), { provider });
    expect((res.data as { balance: { usd: string } }).balance.usd).toBe('1');
    expect(getSigner).not.toHaveBeenCalled();
  });
});
