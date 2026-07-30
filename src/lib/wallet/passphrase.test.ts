import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passphraseBlobPath, passphraseBlobPathFor } from '../paths';
import {
  resolvePassphrase,
  resolvePassphraseForCreate,
  storePassphraseForWallet,
  walletStoreAccount,
  type ExecFn,
  type PromptFn,
} from './passphrase';

/** One recorded exec invocation: the resolved file, its argv, and any stdin payload. */
interface ExecCall {
  file: string;
  args: string[];
  stdin?: string;
}

/**
 * An exec seam that records every call and dispatches to a handler. Returning an
 * Error from the handler makes that exec reject (a nonzero exit / spawn failure);
 * returning stdout/stderr resolves it.
 */
function recordingExec(handler: (call: ExecCall) => { stdout?: string; stderr?: string } | Error): {
  exec: ExecFn;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (file, args, stdin) => {
    const call: ExecCall = { file, args, stdin };
    calls.push(call);
    const out = handler(call);
    if (out instanceof Error) throw out;
    return { stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  };
  return { exec, calls };
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const enoent = (): Error => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });

/** A fixed wallet address for the resolve calls; ACCOUNT is its store account form. */
const ADDRESS = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B';
const ACCOUNT = ADDRESS.toLowerCase();
/** A second wallet standing in for a previously created one. */
const OTHER_ADDRESS = '0x00000000219ab540356cBB839Cbe05303d7705Fa';
const OTHER_ACCOUNT = OTHER_ADDRESS.toLowerCase();
const LEGACY_ACCOUNT = 'wallet';

/** The first recorded call, asserted present (satisfies noUncheckedIndexedAccess). */
function first(calls: ExecCall[]): ExecCall {
  expect(calls.length).toBeGreaterThan(0);
  return calls[0] as ExecCall;
}

/**
 * An in-memory macOS keychain: a map of account -> passphrase behind a real
 * `security` argv/stdin contract. Duplicate adds FAIL (matching a `-U`-less
 * add-generic-password), reads miss with an error, deletes remove the entry.
 * Every write must arrive over stdin via `security -i`; any unexpected payload
 * throws so a behavior drift cannot pass silently.
 */
function fakeKeychain(initial: Record<string, string> = {}): {
  exec: ExecFn;
  entries: Map<string, string>;
  calls: ExecCall[];
} {
  const entries = new Map(Object.entries(initial));
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (file, args, stdin) => {
    calls.push({ file, args, stdin });
    expect(file).toBe('security');
    if (args[0] === '-i') {
      const m = stdin?.match(/^add-generic-password -s tenjin-cli -a (\S+) -w '([^']*)'\n$/);
      if (!m) throw new Error(`unexpected security -i payload: ${String(stdin)}`);
      const account = m[1] as string;
      const pass = m[2] as string;
      if (entries.has(account)) throw new Error('errSecDuplicateItem'); // no -U anywhere
      entries.set(account, pass);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'find-generic-password') {
      const account = args[args.indexOf('-a') + 1] as string;
      const value = entries.get(account);
      if (value === undefined) throw new Error('could not be found');
      return { stdout: `${value}\n`, stderr: '' };
    }
    if (args[0] === 'delete-generic-password') {
      const account = args[args.indexOf('-a') + 1] as string;
      if (!entries.delete(account)) throw new Error('could not be found');
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected security call: ${args.join(' ')}`);
  };
  return { exec, entries, calls };
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-pass-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('walletStoreAccount', () => {
  it('lowercases a checksummed address', () => {
    expect(walletStoreAccount(ADDRESS)).toBe(ACCOUNT);
  });

  it('refuses a non-address (defense for the piped keychain command)', () => {
    expect(() => walletStoreAccount('wallet')).toThrow();
    expect(() => walletStoreAccount("0x'; rm -rf /")).toThrow();
  });
});

describe('resolvePassphrase — env and platform selection', () => {
  it('env beats every OS store and never touches exec', async () => {
    const { exec, calls } = recordingExec(() => new Error('exec must not run'));
    const res = await resolvePassphrase(
      {
        env: { TENJIN_WALLET_PASSPHRASE: 'from-env' },
        platform: 'darwin',
        isTTY: false,
        exec,
      },
      ADDRESS,
    );
    expect(res).toEqual({ passphrase: 'from-env', source: 'env' });
    expect(calls).toHaveLength(0);
  });

  it('an unsupported platform has no store: a store miss falls straight to USAGE', async () => {
    const { exec, calls } = recordingExec(() => new Error('exec must not run'));
    await expect(
      resolvePassphrase({ env: {}, platform: 'freebsd', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });

  it('falls through a store miss (own entry AND legacy) to the interactive prompt', async () => {
    const { exec, calls } = recordingExec(() => new Error('not found')); // keychain misses
    const prompt: PromptFn = async () => 'typed-pass';
    const res = await resolvePassphrase(
      { env: {}, platform: 'darwin', isTTY: true, exec, prompt },
      ADDRESS,
    );
    expect(res).toEqual({ passphrase: 'typed-pass', source: 'prompt' });
    // Both the per-address entry and the legacy slot were tried before prompting.
    expect(calls).toHaveLength(2);
  });
});

describe('macOS keychain backend', () => {
  it('read hit: find-generic-password -w on the wallet OWN account yields the passphrase', async () => {
    const { exec, calls } = fakeKeychain({ [ACCOUNT]: 'stored-pass' });
    const res = await resolvePassphrase(
      { env: {}, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    expect(res).toEqual({ passphrase: 'stored-pass', source: 'keychain' });
    const call = first(calls);
    expect(call.file).toBe('security');
    expect(call.args).toContain('find-generic-password');
    expect(call.args).toContain(ACCOUNT); // per-wallet account, never the shared constant
    expect(call.stdin).toBeUndefined();
  });

  it('read miss: a nonzero `security` exit degrades to USAGE (no TTY)', async () => {
    const { exec } = recordingExec(() => new Error('SecKeychainSearchCopyNext: not found'));
    await expect(
      resolvePassphrase({ env: {}, platform: 'darwin', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('store success: writes via `security -i` under the wallet address, no -U, verified by read-back', async () => {
    const { exec, entries, calls } = fakeKeychain();
    const res = await resolvePassphraseForCreate(
      {
        env: {},
        platform: 'darwin',
        isTTY: false,
        exec,
      },
      ADDRESS,
    );
    expect(res.source).toBe('keychain');
    expect(res.passphrase).toMatch(BASE64URL);
    // Exactly one add (via -i, secret on stdin) and one verifying read-back.
    expect(calls).toHaveLength(2);
    const add = first(calls);
    expect(add.args).toEqual(['-i']); // secret is NOT in argv
    expect(add.stdin).toBe(
      `add-generic-password -s tenjin-cli -a ${ACCOUNT} -w '${res.passphrase}'\n`,
    );
    expect(add.stdin).not.toContain('-U'); // never update-in-place over an existing entry
    expect(add.args.some((a) => a.includes(res.passphrase))).toBe(false);
    expect(entries.get(ACCOUNT)).toBe(res.passphrase);
    expect(entries.has(LEGACY_ACCOUNT)).toBe(false); // create never touches the legacy slot
  });

  it('store failure: a `security` error degrades to USAGE', async () => {
    const { exec } = recordingExec(() => new Error('User interaction is not allowed.'));
    await expect(
      resolvePassphraseForCreate({ env: {}, platform: 'darwin', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('store write that does not read back degrades (never encrypt with an unverified passphrase)', async () => {
    // The add "succeeds" but the read-back finds nothing: create must not trust it.
    const { exec } = recordingExec((call) =>
      call.args[0] === '-i' ? { stdout: '' } : new Error('not found'),
    );
    await expect(
      resolvePassphraseForCreate({ env: {}, platform: 'darwin', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('per-wallet entries and the legacy shared slot', () => {
  it('create with existing wallets present writes ONLY its own entry and overwrites nothing', async () => {
    const { exec, entries, calls } = fakeKeychain({
      [OTHER_ACCOUNT]: 'other-wallet-pass',
      [LEGACY_ACCOUNT]: 'legacy-pass',
    });
    const res = await resolvePassphraseForCreate(
      { env: {}, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    // The new wallet got its own entry; every pre-existing entry is untouched.
    expect(entries.get(ACCOUNT)).toBe(res.passphrase);
    expect(entries.get(OTHER_ACCOUNT)).toBe('other-wallet-pass');
    expect(entries.get(LEGACY_ACCOUNT)).toBe('legacy-pass');
    // And no delete was ever attempted.
    expect(calls.every((c) => c.args[0] !== 'delete-generic-password')).toBe(true);
  });

  it('a second create cannot overwrite an existing per-address entry (duplicate add fails)', async () => {
    const { exec, entries } = fakeKeychain({ [ACCOUNT]: 'the-original-pass' });
    // Same address again (cannot happen with fresh random keys; simulates the
    // worst case): the -U-less add fails, resolution degrades instead of clobbering.
    await expect(
      resolvePassphraseForCreate({ env: {}, platform: 'darwin', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(entries.get(ACCOUNT)).toBe('the-original-pass');
  });

  it('read prefers the per-address entry over the legacy slot and offers no migration', async () => {
    const { exec } = fakeKeychain({
      [ACCOUNT]: 'own-pass',
      [LEGACY_ACCOUNT]: 'legacy-pass',
    });
    const res = await resolvePassphrase(
      { env: {}, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    expect(res.passphrase).toBe('own-pass');
    expect(res.migrateLegacy).toBeUndefined();
  });

  it('legacy fallback: serves the legacy passphrase and migrateLegacy re-keys it (copy, verify, then remove)', async () => {
    const legacyPass = 'legacy-migration-pass';
    const { exec, entries, calls } = fakeKeychain({ [LEGACY_ACCOUNT]: legacyPass });
    const res = await resolvePassphrase(
      { env: {}, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    expect(res.passphrase).toBe(legacyPass);
    expect(res.source).toBe('keychain');
    expect(res.migrateLegacy).toBeDefined();
    // Nothing has been migrated yet — resolution alone never mutates the store.
    expect(entries.get(LEGACY_ACCOUNT)).toBe(legacyPass);
    expect(entries.has(ACCOUNT)).toBe(false);

    await expect(res.migrateLegacy?.()).resolves.toBe(true);
    expect(entries.get(ACCOUNT)).toBe(legacyPass);
    expect(entries.has(LEGACY_ACCOUNT)).toBe(false);

    // Ordering: the copy (add) and its verifying read-back both happened BEFORE the delete.
    const kinds = calls.map((c) => (c.args[0] === '-i' ? 'add' : c.args[0]));
    const addIdx = kinds.indexOf('add');
    const delIdx = kinds.indexOf('delete-generic-password');
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(addIdx);
    expect(kinds.slice(addIdx + 1, delIdx)).toContain('find-generic-password');
  });

  it('migration keeps the legacy entry when the copy cannot be verified', async () => {
    // A keychain where adds are accepted but the per-address read-back stays empty:
    // the copy is unverifiable, so the legacy slot must survive.
    const { exec, calls } = recordingExec((call) => {
      if (call.args[0] === '-i') return { stdout: '' }; // add "succeeds"
      if (call.args[0] === 'find-generic-password') {
        const account = call.args[call.args.indexOf('-a') + 1];
        if (account === LEGACY_ACCOUNT) return { stdout: 'legacy-pass\n' };
        return new Error('could not be found'); // per-address read-back always misses
      }
      return new Error(`unexpected: ${call.args.join(' ')}`);
    });
    const res = await resolvePassphrase(
      { env: {}, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    await expect(res.migrateLegacy?.()).resolves.toBe(false);
    // No delete was ever attempted.
    expect(calls.every((c) => c.args[0] !== 'delete-generic-password')).toBe(true);
  });

  it('migration keeps the legacy entry when the copy write itself fails', async () => {
    const { exec, calls } = recordingExec((call) => {
      if (call.args[0] === '-i') return new Error('errSecDuplicateItem');
      if (call.args[0] === 'find-generic-password') {
        const account = call.args[call.args.indexOf('-a') + 1];
        if (account === LEGACY_ACCOUNT) return { stdout: 'legacy-pass\n' };
        return new Error('could not be found');
      }
      return new Error(`unexpected: ${call.args.join(' ')}`);
    });
    const res = await resolvePassphrase(
      { env: {}, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    await expect(res.migrateLegacy?.()).resolves.toBe(false);
    expect(calls.every((c) => c.args[0] !== 'delete-generic-password')).toBe(true);
  });

  it('a failed legacy REMOVAL does not fail the migration: the verified copy is the archive', async () => {
    // Copy and read-back succeed; only the delete of the legacy slot fails.
    const stored = new Map<string, string>([[LEGACY_ACCOUNT, 'legacy-pass']]);
    const { exec } = recordingExec((call) => {
      if (call.args[0] === '-i') {
        const m = call.stdin?.match(/-a (\S+) -w '([^']*)'/);
        stored.set(m?.[1] as string, m?.[2] as string);
        return { stdout: '' };
      }
      if (call.args[0] === 'find-generic-password') {
        const value = stored.get(call.args[call.args.indexOf('-a') + 1] as string);
        return value !== undefined ? { stdout: `${value}\n` } : new Error('not found');
      }
      return new Error('delete refused'); // delete-generic-password fails
    });
    const res = await resolvePassphrase(
      { env: {}, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    await expect(res.migrateLegacy?.()).resolves.toBe(true);
    // Both copies survive: the per-address archive of record and the redundant legacy entry.
    expect(stored.get(ACCOUNT)).toBe('legacy-pass');
    expect(stored.get(LEGACY_ACCOUNT)).toBe('legacy-pass');
  });
});

describe('storePassphraseForWallet — the --replace archive writer', () => {
  it('stores and verifies under the wallet account (stored)', async () => {
    const { exec, entries } = fakeKeychain();
    await expect(
      storePassphraseForWallet(
        { env: {}, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
        'typed-base64url-pass',
      ),
    ).resolves.toBe('stored');
    expect(entries.get(ACCOUNT)).toBe('typed-base64url-pass');
  });

  it('an existing identical entry counts as stored without a write', async () => {
    const { exec, entries, calls } = fakeKeychain({ [ACCOUNT]: 'already-there' });
    await expect(
      storePassphraseForWallet(
        { env: {}, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
        'already-there',
      ),
    ).resolves.toBe('stored');
    expect(entries.get(ACCOUNT)).toBe('already-there');
    expect(calls.every((c) => c.args[0] !== '-i')).toBe(true);
  });

  it('names the keychain character gate, not a missing store, for a spaced passphrase', async () => {
    const { exec, calls } = fakeKeychain();
    await expect(
      storePassphraseForWallet(
        { env: {}, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
        'has spaces in it',
      ),
    ).resolves.toBe('rejected-characters');
    // The identical-entry read runs first (an existing copy would count as
    // stored); the gate then refuses before any write is attempted.
    expect(calls.every((c) => c.args[0] === 'find-generic-password')).toBe(true);
  });

  it('an existing identical entry beats the character gate: unstorable but already stored', async () => {
    const { exec, calls } = fakeKeychain({ [ACCOUNT]: 'has spaces in it' });
    await expect(
      storePassphraseForWallet(
        { env: {}, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
        'has spaces in it',
      ),
    ).resolves.toBe('stored');
    expect(calls.every((c) => c.args[0] !== '-i')).toBe(true); // no write attempted
  });

  it('reports no-store on a platform without one', async () => {
    const { exec, calls } = recordingExec(() => new Error('exec must not run'));
    await expect(
      storePassphraseForWallet({ env: {}, platform: 'freebsd', isTTY: false, exec }, ADDRESS, 'p'),
    ).resolves.toBe('no-store');
    expect(calls).toHaveLength(0);
  });

  it('reports store-failed when the write does not stick', async () => {
    const { exec } = recordingExec((call) =>
      call.args[0] === '-i' ? { stdout: '' } : new Error('not found'),
    );
    await expect(
      storePassphraseForWallet(
        { env: {}, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
        'typed-base64url-pass',
      ),
    ).resolves.toBe('store-failed');
  });
});

describe('Windows DPAPI backend', () => {
  // A stubbed PowerShell that fakes DPAPI with base64 so the blob-file plumbing is
  // exercised end to end: protect => base64(plaintext), unprotect => decode.
  const fakeDpapi: ExecFn = async (file, args, stdin) => {
    expect(file).toBe('powershell.exe');
    const script = args[args.length - 1] ?? '';
    if (script.includes('Unprotect')) {
      return { stdout: Buffer.from((stdin ?? '').trim(), 'base64').toString('utf8'), stderr: '' };
    }
    return { stdout: Buffer.from(stdin ?? '', 'utf8').toString('base64'), stderr: '' };
  };

  it('roundtrip: store writes a PER-WALLET DPAPI blob file, read unprotects it back', async () => {
    const created = await resolvePassphraseForCreate(
      {
        env: {},
        dir: tmp,
        platform: 'win32',
        isTTY: false,
        exec: fakeDpapi,
      },
      ADDRESS,
    );
    expect(created.source).toBe('dpapi');
    expect(created.passphrase).toMatch(BASE64URL);

    // The on-disk file is the (fake) ciphertext at the PER-WALLET path; the
    // legacy shared blob path is never written.
    const blob = await readFile(passphraseBlobPathFor(ACCOUNT, tmp), 'utf8');
    expect(blob).toBe(Buffer.from(created.passphrase, 'utf8').toString('base64'));
    await expect(stat(passphraseBlobPath(tmp))).rejects.toMatchObject({ code: 'ENOENT' });

    const read = await resolvePassphrase(
      {
        env: {},
        dir: tmp,
        platform: 'win32',
        isTTY: false,
        exec: fakeDpapi,
      },
      ADDRESS,
    );
    expect(read).toEqual({ passphrase: created.passphrase, source: 'dpapi' });
  });

  it('legacy blob fallback: served with a migration that re-keys the file and removes the old blob', async () => {
    // Seed only the LEGACY shared blob (a pre-per-wallet install layout); the
    // fake DPAPI ciphertext is just base64 of the plaintext.
    const legacyPass = 'legacy-dpapi-pass';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(passphraseBlobPath(tmp), Buffer.from(legacyPass, 'utf8').toString('base64'));

    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'win32', isTTY: false, exec: fakeDpapi },
      ADDRESS,
    );
    expect(res.passphrase).toBe(legacyPass);
    expect(res.migrateLegacy).toBeDefined();
    await expect(res.migrateLegacy?.()).resolves.toBe(true);
    // Re-keyed: per-wallet blob decodes to the passphrase, legacy blob is gone.
    const migrated = await readFile(passphraseBlobPathFor(ACCOUNT, tmp), 'utf8');
    expect(Buffer.from(migrated.trim(), 'base64').toString('utf8')).toBe(legacyPass);
    await expect(stat(passphraseBlobPath(tmp))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('read miss: a missing blob file returns null WITHOUT spawning PowerShell', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: '' }));
    await expect(
      resolvePassphrase({ env: {}, dir: tmp, platform: 'win32', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });

  it('store failure: a PowerShell error degrades to USAGE and writes no blob', async () => {
    const { exec } = recordingExec(() => new Error('powershell.exe not found'));
    await expect(
      resolvePassphraseForCreate(
        { env: {}, dir: tmp, platform: 'win32', isTTY: false, exec },
        ADDRESS,
      ),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(stat(passphraseBlobPathFor(ACCOUNT, tmp))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(stat(passphraseBlobPath(tmp))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('desktop-Linux secret-service backend', () => {
  it('read hit: secret-tool lookup on the wallet own account yields the stored passphrase', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: 'secret-pass' }));
    const res = await resolvePassphrase(
      { env: {}, platform: 'linux', isTTY: false, exec },
      ADDRESS,
    );
    expect(res).toEqual({ passphrase: 'secret-pass', source: 'secret-service' });
    const call = first(calls);
    expect(call.file).toBe('secret-tool');
    expect(call.args).toContain('lookup');
    expect(call.args).toContain(ACCOUNT);
  });

  it('read miss: secret-tool not installed (ENOENT) degrades to USAGE', async () => {
    const { exec, calls } = recordingExec(() => enoent());
    await expect(
      resolvePassphrase({ env: {}, platform: 'linux', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(2); // own entry, then legacy — both degraded silently
  });

  it('store success: secret-tool store under the wallet account, secret on stdin, verified by read-back', async () => {
    let stored = '';
    const { exec, calls } = recordingExec((call) => {
      if (call.args[0] === 'store') {
        stored = call.stdin ?? '';
        return { stdout: '' };
      }
      return { stdout: stored }; // the verifying lookup
    });
    const res = await resolvePassphraseForCreate(
      {
        env: {},
        platform: 'linux',
        isTTY: false,
        exec,
      },
      ADDRESS,
    );
    expect(res.source).toBe('secret-service');
    const call = first(calls);
    expect(call.file).toBe('secret-tool');
    expect(call.args).toContain('store');
    expect(call.args).toContain(ACCOUNT);
    expect(call.stdin).toBe(res.passphrase);
    expect(call.args.some((a) => a.includes(res.passphrase))).toBe(false);
    expect(calls).toHaveLength(2); // store + verifying lookup
  });

  it('store failure: secret-tool ENOENT degrades to USAGE', async () => {
    const { exec } = recordingExec(() => enoent());
    await expect(
      resolvePassphraseForCreate({ env: {}, platform: 'linux', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('argv hygiene across every backend', () => {
  it('the passphrase only ever transits stdin, never an argv array', async () => {
    const recorded: { call: ExecCall; secret: string }[] = [];

    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      const dir = await mkdtemp(join(tmpdir(), 'tenjin-pass-x-'));
      let kept = ''; // stands in for the darwin/linux OS store between store and read

      const exec: ExecFn = async (file, args, stdin) => {
        recorded.push({ call: { file, args, stdin }, secret: '' }); // secret backfilled below
        if (file === 'security') {
          if (args[0] === '-i') {
            kept = stdin?.match(/-w '([^']+)'/)?.[1] ?? '';
            return { stdout: '', stderr: '' };
          }
          // find-generic-password -w: only the per-address account is populated.
          const account = args[args.indexOf('-a') + 1];
          if (account === ACCOUNT && kept !== '') return { stdout: `${kept}\n`, stderr: '' };
          throw new Error('not found');
        }
        if (file === 'secret-tool') {
          if (args[0] === 'store') {
            kept = stdin ?? '';
            return { stdout: '', stderr: '' };
          }
          const account = args[args.indexOf('account') + 1];
          return { stdout: account === ACCOUNT ? kept : '', stderr: '' }; // lookup
        }
        // powershell.exe: fake DPAPI as base64 <-> plaintext.
        const script = args[args.length - 1] ?? '';
        if (script.includes('Unprotect')) {
          return {
            stdout: Buffer.from((stdin ?? '').trim(), 'base64').toString('utf8'),
            stderr: '',
          };
        }
        return { stdout: Buffer.from(stdin ?? '', 'utf8').toString('base64'), stderr: '' };
      };

      const before = recorded.length;
      const created = await resolvePassphraseForCreate(
        {
          env: {},
          dir,
          platform,
          isTTY: false,
          exec,
        },
        ADDRESS,
      );
      const read = await resolvePassphrase({ env: {}, dir, platform, isTTY: false, exec }, ADDRESS);
      expect(read.passphrase).toBe(created.passphrase);
      for (let i = before; i < recorded.length; i++) {
        const entry = recorded[i];
        if (entry) entry.secret = created.passphrase;
      }

      await rm(dir, { recursive: true, force: true });
    }

    // The core guarantee: no argv token on any backend contains the passphrase.
    for (const { call, secret } of recorded) {
      expect(call.args.some((a) => a.includes(secret))).toBe(false);
    }
    // And it genuinely traveled: at least one call per backend carried it on stdin.
    const carriedOnStdin = recorded.filter(({ call, secret }) =>
      (call.stdin ?? '').includes(secret),
    );
    expect(carriedOnStdin.length).toBeGreaterThanOrEqual(3);
  });
});
