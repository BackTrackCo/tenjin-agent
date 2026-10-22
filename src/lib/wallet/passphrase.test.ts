import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from '../errors';
import {
  passphraseBlobPath,
  passphraseBlobPathFor,
  passphraseFilePathFor,
  passphraseRecordPath,
} from '../paths';
import { readPassphraseRecord, writePassphraseRecord } from '../passphrase-record';
import {
  FILE_STORE_FAILED_FIX,
  KEYCHAIN_LOCKED_FIX,
  KEYCHAIN_WAIT_LINE,
  REPAIR_IN_TERMINAL,
} from '../wallet-unlock';
import {
  STORE_TIMEOUTS,
  StoreExecError,
  classifyStoreFailure,
  defaultExecFor,
  describeStoreLocation,
  probeDurableStore,
  resolvePassphrase,
  resolvePassphraseForCreate,
  storeDurably,
  storePassphraseForWallet,
  toStoreOutcome,
  walletStoreAccount,
  type DurableWrite,
  type ExecFn,
  type PromptFn,
} from './passphrase';

/** One recorded exec invocation: the resolved file, its argv, any stdin payload and its options. */
interface ExecCall {
  file: string;
  args: string[];
  stdin?: string;
  opts?: { timeoutMs?: number };
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
  const exec: ExecFn = async (file, args, stdin, opts) => {
    const call: ExecCall = { file, args, stdin, opts };
    calls.push(call);
    const out = handler(call);
    if (out instanceof Error) throw out;
    return { stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  };
  return { exec, calls };
}

/** A store CLI that exited with `code` (what defaultExecFor rejects with). */
const exited = (file: string, code: number, stderr = ''): StoreExecError =>
  new StoreExecError(file, { code, stderr });
/** A store CLI killed on its deadline. */
const killedErr = (file: string): StoreExecError =>
  new StoreExecError(file, { killed: true, signal: 'SIGKILL' });
/** A store CLI that is not installed. */
const enoent = (file: string): StoreExecError =>
  new StoreExecError(file, { code: 'ENOENT', enoent: true });
/** `security find-generic-password`'s "no such item". */
const notFound = (): StoreExecError => exited('security', 44);

const BASE64URL = /^[A-Za-z0-9_-]+$/;

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

/** The kind of each `security` call, for order assertions. */
const kinds = (calls: ExecCall[]): string[] =>
  calls.map((c) => (c.args[0] === '-i' ? 'add' : (c.args[0] as string)));

/**
 * An in-memory macOS keychain: a map of account -> passphrase behind a real
 * `security` argv/stdin contract. Duplicate adds FAIL unless `-U` is given,
 * reads miss with exit 44, deletes remove the entry, and `default-keychain`
 * answers (the probe). Values arrive as `-w '<base64url>'` or `-X <hex>`; any
 * other payload throws so a behavior drift cannot pass silently.
 */
function fakeKeychain(initial: Record<string, string> = {}): {
  exec: ExecFn;
  entries: Map<string, string>;
  calls: ExecCall[];
} {
  const entries = new Map(Object.entries(initial));
  const calls: ExecCall[] = [];
  const exec: ExecFn = async (file, args, stdin, opts) => {
    calls.push({ file, args, stdin, opts });
    expect(file).toBe('security');
    if (args[0] === 'default-keychain') return { stdout: '"login.keychain-db"\n', stderr: '' };
    if (args[0] === '-i') {
      const m = stdin?.match(
        /^add-generic-password -s tenjin-cli -a (0x[0-9a-f]{40}) (?:-w '([A-Za-z0-9_-]+)'|-X ([0-9a-f]+))( -U)?\n$/,
      );
      if (!m) throw new Error(`unexpected security -i payload: ${String(stdin)}`);
      const account = m[1] as string;
      const pass = m[2] ?? Buffer.from(m[3] as string, 'hex').toString('utf8');
      if (entries.has(account) && m[4] === undefined) throw exited('security', 45); // duplicate
      entries.set(account, pass);
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'find-generic-password') {
      const account = args[args.indexOf('-a') + 1] as string;
      const value = entries.get(account);
      if (value === undefined) throw notFound();
      return { stdout: `${value}\n`, stderr: '' };
    }
    if (args[0] === 'delete-generic-password') {
      const account = args[args.indexOf('-a') + 1] as string;
      if (!entries.delete(account)) throw notFound();
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected security call: ${args.join(' ')}`);
  };
  return { exec, entries, calls };
}

const neverPrompt: PromptFn = async () => {
  throw new Error('the prompt must not be called');
};

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-pass-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await chmod(tmp, 0o700).catch(() => undefined);
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
        dir: tmp,
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
      resolvePassphrase({ env: {}, dir: tmp, platform: 'freebsd', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });

  it('falls through a store miss (own entry AND legacy) to the interactive prompt', async () => {
    const { exec, calls } = recordingExec(() => notFound()); // keychain misses
    const prompt: PromptFn = async () => 'typed-pass';
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: true, exec, prompt },
      ADDRESS,
    );
    expect(res).toEqual({ passphrase: 'typed-pass', source: 'prompt' });
    // Both the per-address entry and the legacy slot were tried before prompting.
    expect(calls).toHaveLength(2);
  });

  it('skipEnv passes over TENJIN_WALLET_PASSPHRASE to the saved passphrase', async () => {
    const { exec } = fakeKeychain({ [ACCOUNT]: 'saved-pass' });
    const res = await resolvePassphrase(
      {
        env: { TENJIN_WALLET_PASSPHRASE: 'from-env' },
        dir: tmp,
        platform: 'darwin',
        isTTY: false,
        exec,
      },
      ADDRESS,
      { skipEnv: true },
    );
    expect(res).toEqual({ passphrase: 'saved-pass', source: 'keychain' });
  });
});

// Checklist item 1: an alpha.30 keychain user upgrades with no sidecar, and must
// read exactly the entry they always read, in exactly the same order.
describe('no sidecar resolves exactly as before', () => {
  it('no sidecar resolves exactly as before', async () => {
    // The per-address hit.
    const own = fakeKeychain({ [ACCOUNT]: 'own-pass', [LEGACY_ACCOUNT]: 'legacy-pass' });
    const hit = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec: own.exec },
      ADDRESS,
    );
    expect(hit).toEqual({ passphrase: 'own-pass', source: 'keychain' });
    expect(own.calls.map((c) => c.args[c.args.indexOf('-a') + 1])).toEqual([ACCOUNT]);

    // The legacy hit, with its migration handle and nothing migrated yet.
    const legacy = fakeKeychain({ [LEGACY_ACCOUNT]: 'legacy-pass' });
    const fromLegacy = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec: legacy.exec },
      ADDRESS,
    );
    expect(fromLegacy.passphrase).toBe('legacy-pass');
    expect(fromLegacy.source).toBe('keychain');
    expect(fromLegacy.migrateLegacy).toBeDefined();
    expect(legacy.calls.map((c) => c.args[c.args.indexOf('-a') + 1])).toEqual([
      ACCOUNT,
      LEGACY_ACCOUNT,
    ]);
    expect(legacy.entries.has(ACCOUNT)).toBe(false);

    // The prompt, after both misses.
    const empty = fakeKeychain();
    const prompted = await resolvePassphrase(
      {
        env: {},
        dir: tmp,
        platform: 'darwin',
        isTTY: true,
        exec: empty.exec,
        prompt: async () => 'typed',
      },
      ADDRESS,
    );
    expect(prompted).toEqual({ passphrase: 'typed', source: 'prompt' });
    expect(empty.calls).toHaveLength(2);
  });

  it('a locked per-address read stops the chain: keychain_locked headless, the prompt at a TTY', async () => {
    const { exec, calls } = recordingExec(() => killedErr('security'));
    const err = (await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    ).catch((e) => e)) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.details).toMatchObject({
      unlock: { reason: 'keychain_locked', source: 'keychain' },
    });
    expect(err.fix).toBe(KEYCHAIN_LOCKED_FIX);
    expect(calls).toHaveLength(1); // the legacy slot was not read

    const prompt = vi.fn(async () => 'typed');
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: true, exec, prompt },
      ADDRESS,
    );
    expect(res).toEqual({ passphrase: 'typed', source: 'prompt' });
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('a locked legacy slot after a per-address miss is keychain_locked, never passphrase_missing', async () => {
    const lockedLegacy = recordingExec((call) =>
      call.args.includes(LEGACY_ACCOUNT)
        ? exited(
            'security',
            36,
            'security: SecKeychainSearchCopyNext: User interaction is not allowed.',
          )
        : notFound(),
    );
    const err = (await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec: lockedLegacy.exec },
      ADDRESS,
    ).catch((e) => e)) as CliError;
    expect(err).toBeInstanceOf(CliError);
    expect(err.details).toMatchObject({
      unlock: { reason: 'keychain_locked', source: 'keychain' },
    });
    expect(err.fix).toBe(KEYCHAIN_LOCKED_FIX);
    expect(lockedLegacy.calls).toHaveLength(2);

    // A killed legacy read (verify's deadline) is the same unknown.
    const killedLegacy = recordingExec((call) =>
      call.args.includes(LEGACY_ACCOUNT) ? killedErr('security') : notFound(),
    );
    const killed = (await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec: killedLegacy.exec },
      ADDRESS,
    ).catch((e) => e)) as CliError;
    expect(killed.details).toMatchObject({ unlock: { reason: 'keychain_locked' } });

    // The 0600 file is still read, and a hit there wins.
    await writeFile(passphraseFilePathFor(ACCOUNT, tmp), 'file-pass\n', { mode: 0o600 });
    const fromFile = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec: lockedLegacy.exec },
      ADDRESS,
    );
    expect(fromFile).toEqual({ passphrase: 'file-pass', source: 'file' });
  });

  it('the file store is consulted after legacy and before the prompt', async () => {
    await writeFile(passphraseFilePathFor(ACCOUNT, tmp), 'file-pass\n', { mode: 0o600 });
    const { exec, calls } = recordingExec(() => notFound());
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: true, exec, prompt: neverPrompt },
      ADDRESS,
    );
    expect(res).toEqual({ passphrase: 'file-pass', source: 'file' });
    expect(calls).toHaveLength(2); // own entry, then legacy, then the file
  });

  it('noPassphraseError keeps its message and sends the person to repair', async () => {
    const { exec } = recordingExec(() => notFound());
    const err = (await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    ).catch((e) => e)) as CliError;
    expect(err.code).toBe('USAGE');
    expect(err.message).toBe('No wallet passphrase is available.');
    expect(err.fix).toBe(REPAIR_IN_TERMINAL);
    expect(err.details).toEqual({ unlock: { reason: 'passphrase_missing' } });
  });
});

describe('resolvePassphrase with a sidecar entry', () => {
  it('a recorded file store is read with zero exec calls', async () => {
    await writePassphraseRecord(tmp, ACCOUNT, { store: 'file', by: 'create' });
    await writeFile(passphraseFilePathFor(ACCOUNT, tmp), 'file-pass', { mode: 0o600 });
    const { exec, calls } = recordingExec(() => new Error('exec must not run'));
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    expect(res).toEqual({ passphrase: 'file-pass', source: 'file', recorded: true });
    expect(calls).toHaveLength(0);
  });

  it('a recorded keychain whose read is killed throws keychain_locked; legacy and file are not read', async () => {
    await writePassphraseRecord(tmp, ACCOUNT, { store: 'keychain', by: 'create' });
    await writeFile(passphraseFilePathFor(ACCOUNT, tmp), 'file-pass', { mode: 0o600 });
    const { exec, calls } = recordingExec(() => killedErr('security'));
    const err = (await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    ).catch((e) => e)) as CliError;
    expect(err.details).toMatchObject({
      unlock: { reason: 'keychain_locked', source: 'keychain' },
    });
    expect(err.fix).toBe(KEYCHAIN_LOCKED_FIX);
    expect(err.message).toContain('did not answer');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain(ACCOUNT);
  });

  it('a recorded keychain that misses is passphrase_missing, naming the store', async () => {
    await writePassphraseRecord(tmp, ACCOUNT, { store: 'keychain', by: 'repair' });
    const { exec, calls } = recordingExec(() => notFound());
    const err = (await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    ).catch((e) => e)) as CliError;
    expect(err.code).toBe('USAGE');
    expect(err.message).toContain('No wallet passphrase is available');
    expect(err.message).toContain('macOS keychain');
    expect(err.details).toEqual({ unlock: { reason: 'passphrase_missing' } });
    expect(err.fix).toBe(REPAIR_IN_TERMINAL);
    expect(calls).toHaveLength(1); // no other-store fallback
  });

  it('a recorded store that does not answer prompts at a TTY', async () => {
    await writePassphraseRecord(tmp, ACCOUNT, { store: 'secret-service', by: 'create' });
    const { exec } = recordingExec(() => killedErr('secret-tool'));
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'linux', isTTY: true, exec, prompt: async () => 'typed' },
      ADDRESS,
    );
    expect(res.source).toBe('prompt');
  });
});

describe('macOS keychain backend', () => {
  it('read hit: find-generic-password -w on the wallet OWN account yields the passphrase', async () => {
    const { exec, calls } = fakeKeychain({ [ACCOUNT]: 'stored-pass' });
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    expect(res).toEqual({ passphrase: 'stored-pass', source: 'keychain' });
    const call = first(calls);
    expect(call.file).toBe('security');
    expect(call.args).toContain('find-generic-password');
    expect(call.args).toContain(ACCOUNT); // per-wallet account, never the shared constant
    expect(call.stdin).toBeUndefined();
  });

  it('read miss: exit 44 degrades to USAGE (no TTY)', async () => {
    const { exec } = recordingExec(() => notFound());
    await expect(
      resolvePassphrase({ env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('create: probe, pre-read, ONE add via `security -i` (no -U), then a verifying read-back', async () => {
    const { exec, entries, calls } = fakeKeychain();
    const res = await resolvePassphraseForCreate(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec, prompt: neverPrompt },
      ADDRESS,
    );
    expect(res).toMatchObject({ source: 'keychain', origin: 'generated', durable: true });
    expect(res.passphrase).toMatch(BASE64URL);
    expect(kinds(calls)).toEqual([
      'default-keychain',
      'find-generic-password',
      'add',
      'find-generic-password',
    ]);
    const add = calls[2] as ExecCall;
    expect(add.args).toEqual(['-i']); // secret is NOT in argv
    // Today's exact line for a generated (base64url) secret.
    expect(add.stdin).toBe(
      `add-generic-password -s tenjin-cli -a ${ACCOUNT} -w '${res.passphrase}'\n`,
    );
    expect(add.args.some((a) => a.includes(res.passphrase))).toBe(false);
    expect(entries.get(ACCOUNT)).toBe(res.passphrase);
    expect(entries.has(LEGACY_ACCOUNT)).toBe(false); // create never touches the legacy slot
  });

  it('an env value outside base64url goes as -X <utf8 hex>, never inside quotes', async () => {
    const { exec, entries, calls } = fakeKeychain();
    const res = await resolvePassphraseForCreate(
      {
        env: { TENJIN_WALLET_PASSPHRASE: 'pass word!' },
        dir: tmp,
        platform: 'darwin',
        isTTY: false,
        exec,
      },
      ADDRESS,
    );
    expect(res).toMatchObject({ source: 'keychain', origin: 'env', durable: true });
    const add = calls.find((c) => c.args[0] === '-i');
    expect(add?.stdin).toBe(
      `add-generic-password -s tenjin-cli -a ${ACCOUNT} -X 7061737320776f726421\n`,
    );
    expect(entries.get(ACCOUNT)).toBe('pass word!');
  });
});

describe('legacy shared-slot migration (S10)', () => {
  it('copies under the own account, reads it back, THEN removes the legacy slot, each under writeMs', async () => {
    const legacyPass = 'legacy-migration-pass';
    const { exec, entries, calls } = fakeKeychain({ [LEGACY_ACCOUNT]: legacyPass });
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    expect(res.passphrase).toBe(legacyPass);
    expect(res.migrateLegacy).toBeDefined();
    // Nothing has been migrated yet — resolution alone never mutates the store.
    expect(entries.get(LEGACY_ACCOUNT)).toBe(legacyPass);
    expect(entries.has(ACCOUNT)).toBe(false);
    // The READS that served signing carry no deadline (B3).
    expect(calls.every((c) => c.opts?.timeoutMs === undefined)).toBe(true);

    const before = calls.length;
    await expect(res.migrateLegacy?.()).resolves.toBe(true);
    expect(entries.get(ACCOUNT)).toBe(legacyPass);
    expect(entries.has(LEGACY_ACCOUNT)).toBe(false);
    const migration = calls.slice(before);
    expect(kinds(migration)).toEqual(['add', 'find-generic-password', 'delete-generic-password']);
    expect(migration.every((c) => c.opts?.timeoutMs === STORE_TIMEOUTS.writeMs)).toBe(true);
    // A migration never writes the sidecar.
    await expect(stat(passphraseRecordPath(tmp))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the legacy entry when the copy cannot be verified', async () => {
    const { exec, calls } = recordingExec((call) => {
      if (call.args[0] === '-i') return { stdout: '' }; // add "succeeds"
      if (call.args[0] === 'find-generic-password') {
        const account = call.args[call.args.indexOf('-a') + 1];
        if (account === LEGACY_ACCOUNT) return { stdout: 'legacy-pass\n' };
        return notFound(); // per-address read-back always misses
      }
      return new Error(`unexpected: ${call.args.join(' ')}`);
    });
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    await expect(res.migrateLegacy?.()).resolves.toBe(false);
    expect(calls.every((c) => c.args[0] !== 'delete-generic-password')).toBe(true);
  });

  it('keeps the legacy entry when the copy write itself fails', async () => {
    const { exec, calls } = recordingExec((call) => {
      if (call.args[0] === '-i') return exited('security', 45);
      if (call.args[0] === 'find-generic-password') {
        const account = call.args[call.args.indexOf('-a') + 1];
        if (account === LEGACY_ACCOUNT) return { stdout: 'legacy-pass\n' };
        return notFound();
      }
      return new Error(`unexpected: ${call.args.join(' ')}`);
    });
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    await expect(res.migrateLegacy?.()).resolves.toBe(false);
    expect(calls.every((c) => c.args[0] !== 'delete-generic-password')).toBe(true);
  });

  it('keeps the legacy entry when the read-back differs, or is killed', async () => {
    for (const readBack of [{ stdout: 'something-else\n' }, killedErr('security')]) {
      let wrote = false;
      const { exec, calls } = recordingExec((call) => {
        if (call.args[0] === '-i') {
          wrote = true;
          return { stdout: '' };
        }
        const account = call.args[call.args.indexOf('-a') + 1];
        if (account === LEGACY_ACCOUNT) return { stdout: 'legacy-pass\n' };
        return wrote ? readBack : notFound();
      });
      const res = await resolvePassphrase(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
      );
      await expect(res.migrateLegacy?.()).resolves.toBe(false);
      expect(calls.every((c) => c.args[0] !== 'delete-generic-password')).toBe(true);
    }
  });

  it('a failed legacy REMOVAL does not fail the migration: the verified copy is the archive', async () => {
    const stored = new Map<string, string>([[LEGACY_ACCOUNT, 'legacy-pass']]);
    const { exec } = recordingExec((call) => {
      if (call.args[0] === '-i') {
        const m = call.stdin?.match(/-a (\S+) -w '([^']*)'/);
        stored.set(m?.[1] as string, m?.[2] as string);
        return { stdout: '' };
      }
      if (call.args[0] === 'find-generic-password') {
        const value = stored.get(call.args[call.args.indexOf('-a') + 1] as string);
        return value !== undefined ? { stdout: `${value}\n` } : notFound();
      }
      return exited('security', 1); // delete-generic-password fails
    });
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    await expect(res.migrateLegacy?.()).resolves.toBe(true);
    expect(stored.get(ACCOUNT)).toBe('legacy-pass');
    expect(stored.get(LEGACY_ACCOUNT)).toBe('legacy-pass');
  });

  it('a test override of writeMs reaches the migration calls', async () => {
    const { exec, calls } = fakeKeychain({ [LEGACY_ACCOUNT]: 'legacy-pass' });
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec, timeouts: { writeMs: 1234 } },
      ADDRESS,
    );
    const before = calls.length;
    await res.migrateLegacy?.();
    expect(calls.slice(before).every((c) => c.opts?.timeoutMs === 1234)).toBe(true);
  });
});

describe('storePassphraseForWallet — the --replace archive writer', () => {
  it('stores and verifies under the wallet account (stored)', async () => {
    const { exec, entries } = fakeKeychain();
    await expect(
      storePassphraseForWallet(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
        'typed-base64url-pass',
      ),
    ).resolves.toBe('stored');
    expect(entries.get(ACCOUNT)).toBe('typed-base64url-pass');
  });

  it('an existing identical entry counts as stored without a write', async () => {
    const { exec, calls } = fakeKeychain({ [ACCOUNT]: 'already-there' });
    await expect(
      storePassphraseForWallet(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
        'already-there',
      ),
    ).resolves.toBe('stored');
    expect(calls.every((c) => c.args[0] !== '-i')).toBe(true);
  });

  it('names the keychain character gate for a value outside printable ASCII', async () => {
    const { exec, calls } = fakeKeychain();
    await expect(
      storePassphraseForWallet(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
        'pässwörd',
      ),
    ).resolves.toBe('rejected-characters');
    expect(calls.every((c) => c.args[0] === 'find-generic-password')).toBe(true);
  });

  it('an existing identical entry beats the character gate: unstorable but already stored', async () => {
    const { exec, calls } = fakeKeychain({ [ACCOUNT]: 'pässwörd' });
    await expect(
      storePassphraseForWallet(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
        'pässwörd',
      ),
    ).resolves.toBe('stored');
    expect(calls.every((c) => c.args[0] !== '-i')).toBe(true);
  });

  it('reports no-store on a platform without one', async () => {
    const { exec, calls } = recordingExec(() => new Error('exec must not run'));
    await expect(
      storePassphraseForWallet(
        { env: {}, dir: tmp, platform: 'freebsd', isTTY: false, exec },
        ADDRESS,
        'p',
      ),
    ).resolves.toBe('no-store');
    expect(calls).toHaveLength(0);
  });

  it('reports store-failed when the write does not stick', async () => {
    const { exec } = recordingExec((call) => (call.args[0] === '-i' ? { stdout: '' } : notFound()));
    await expect(
      storePassphraseForWallet(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
        'typed-base64url-pass',
      ),
    ).resolves.toBe('store-failed');
  });

  it('S1: a different value already there, or after the write, is store-failed, never stored', async () => {
    const pre = fakeKeychain({ [ACCOUNT]: 'someone-elses' });
    await expect(
      storePassphraseForWallet(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec: pre.exec },
        ADDRESS,
        'mine',
      ),
    ).resolves.toBe('store-failed');
    expect(pre.calls.every((c) => c.args[0] !== '-i')).toBe(true);

    let wrote = false;
    const { exec } = recordingExec((call) => {
      if (call.args[0] === '-i') {
        wrote = true;
        return { stdout: '' };
      }
      return wrote ? { stdout: 'another-writer\n' } : notFound();
    });
    await expect(
      storePassphraseForWallet(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
        'mine',
      ),
    ).resolves.toBe('store-failed');
  });
});

describe('storeDurably', () => {
  const deps = (exec: ExecFn) => ({
    env: {},
    dir: tmp,
    platform: 'darwin' as NodeJS.Platform,
    isTTY: false,
    exec,
  });

  /** A keychain whose pre-read misses and whose write and read-back are scripted. */
  function scripted(write: () => Error | undefined, readBack: () => { stdout: string } | Error) {
    let wrote = false;
    return recordingExec((call) => {
      if (call.args[0] === '-i') {
        wrote = true;
        return write() ?? { stdout: '' };
      }
      return wrote ? readBack() : notFound();
    });
  }

  it('a clean write with an equal read-back is stored', async () => {
    const { exec } = scripted(
      () => undefined,
      () => ({ stdout: 'secret\n' }),
    );
    await expect(storeDurably(deps(exec), 'keychain', ADDRESS, 'secret')).resolves.toBe('stored');
  });

  it('a killed write with an equal read-back is stored (it committed)', async () => {
    const { exec } = scripted(
      () => killedErr('security'),
      () => ({ stdout: 'secret\n' }),
    );
    await expect(storeDurably(deps(exec), 'keychain', ADDRESS, 'secret')).resolves.toBe('stored');
  });

  it('a killed write followed by a miss or a locked read is uncertain', async () => {
    for (const readBack of [notFound(), killedErr('security')]) {
      const { exec } = scripted(
        () => killedErr('security'),
        () => readBack,
      );
      await expect(storeDurably(deps(exec), 'keychain', ADDRESS, 'secret')).resolves.toBe(
        'uncertain',
      );
    }
  });

  it('a definite write error with a miss is store-failed', async () => {
    const { exec } = scripted(
      () => exited('security', 45),
      () => notFound(),
    );
    await expect(storeDurably(deps(exec), 'keychain', ADDRESS, 'secret')).resolves.toBe(
      'store-failed',
    );
  });

  it('a pre-existing different value with no replaceIf is conflict, with zero writes', async () => {
    const { exec, calls } = fakeKeychain({ [ACCOUNT]: 'other' });
    await expect(storeDurably(deps(exec), 'keychain', ADDRESS, 'secret')).resolves.toBe('conflict');
    expect(calls.filter((c) => c.args[0] === '-i')).toHaveLength(0);
  });

  it('replaceIf false is kept-existing, with zero writes', async () => {
    const { exec, calls } = fakeKeychain({ [ACCOUNT]: 'other' });
    const replaceIf = vi.fn(async () => false);
    await expect(
      storeDurably(deps(exec), 'keychain', ADDRESS, 'secret', { replaceIf }),
    ).resolves.toBe('kept-existing');
    expect(replaceIf).toHaveBeenCalledWith('other');
    expect(calls.filter((c) => c.args[0] === '-i')).toHaveLength(0);
  });

  it('replaceIf true writes once, with -U', async () => {
    const { exec, calls, entries } = fakeKeychain({ [ACCOUNT]: 'other' });
    await expect(
      storeDurably(deps(exec), 'keychain', ADDRESS, 'secret', { replaceIf: async () => true }),
    ).resolves.toBe('stored');
    const adds = calls.filter((c) => c.args[0] === '-i');
    expect(adds).toHaveLength(1);
    expect(adds[0]?.stdin).toBe(
      `add-generic-password -s tenjin-cli -a ${ACCOUNT} -w 'secret' -U\n`,
    );
    expect(entries.get(ACCOUNT)).toBe('secret');
  });

  it('a clean write whose read-back is a different value is conflict (S1)', async () => {
    const { exec } = scripted(
      () => undefined,
      () => ({ stdout: 'another-writer\n' }),
    );
    await expect(storeDurably(deps(exec), 'keychain', ADDRESS, 'secret')).resolves.toBe('conflict');
  });

  it('a locked pre-read is uncertain, with zero writes', async () => {
    const { exec, calls } = recordingExec(() =>
      exited('security', 51, 'User interaction is not allowed.'),
    );
    await expect(storeDurably(deps(exec), 'keychain', ADDRESS, 'secret')).resolves.toBe(
      'uncertain',
    );
    expect(calls.filter((c) => c.args[0] === '-i')).toHaveLength(0);
  });

  it('never two writes, never a second value', async () => {
    for (const write of [
      () => undefined,
      () => killedErr('security'),
      () => exited('security', 1),
    ]) {
      const { exec, calls } = scripted(write, () => notFound());
      await storeDurably(deps(exec), 'keychain', ADDRESS, 'secret');
      const adds = calls.filter((c) => c.args[0] === '-i');
      expect(adds).toHaveLength(1);
      expect(adds[0]?.stdin).toContain(`'secret'`);
    }
  });

  it('the file store round-trips a value ending in whitespace (one trailing LF only is stripped)', async () => {
    const value = 'ends with space ';
    await expect(
      storeDurably({ env: {}, dir: tmp, isTTY: false }, 'file', ADDRESS, value),
    ).resolves.toBe('stored');
    const path = passphraseFilePathFor(ACCOUNT, tmp);
    expect(await readFile(path, 'utf8')).toBe(value);
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('the file store replaces an empty passphrase file left by a cut-off write', async () => {
    const path = passphraseFilePathFor(ACCOUNT, tmp);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '');
    await expect(
      storeDurably({ env: {}, dir: tmp, isTTY: false }, 'file', ADDRESS, 'secret'),
    ).resolves.toBe('stored');
    expect(await readFile(path, 'utf8')).toBe('secret');
  });

  it('the file store never replaces a non-empty passphrase file without update', async () => {
    const path = passphraseFilePathFor(ACCOUNT, tmp);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'other');
    await expect(
      storeDurably({ env: {}, dir: tmp, isTTY: false }, 'file', ADDRESS, 'secret'),
    ).resolves.toBe('conflict');
    expect(await readFile(path, 'utf8')).toBe('other');
  });
});

describe('toStoreOutcome (S1)', () => {
  it.each<[DurableWrite, string]>([
    ['stored', 'stored'],
    ['already-stored', 'stored'],
    ['kept-existing', 'store-failed'],
    ['conflict', 'store-failed'],
    ['uncertain', 'uncertain'],
    ['store-failed', 'store-failed'],
    ['rejected-characters', 'rejected-characters'],
  ])('%s -> %s', (write, outcome) => {
    expect(toStoreOutcome(write)).toBe(outcome);
  });
});

describe('deadlines (B3, S9)', () => {
  it('signing reads pass no timeoutMs, at a TTY or not, the skipEnv fallback included', async () => {
    for (const isTTY of [false, true]) {
      const { exec, calls } = fakeKeychain({ [LEGACY_ACCOUNT]: 'legacy' });
      await resolvePassphrase({ env: {}, dir: tmp, platform: 'darwin', isTTY, exec }, ADDRESS);
      await resolvePassphrase(
        { env: { TENJIN_WALLET_PASSPHRASE: 'x' }, dir: tmp, platform: 'darwin', isTTY, exec },
        ADDRESS,
        { skipEnv: true },
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((c) => c.opts === undefined || c.opts.timeoutMs === undefined)).toBe(true);
    }
  });

  it('readDeadlineMs reaches every read in the chain', async () => {
    const { exec, calls } = fakeKeychain({ [LEGACY_ACCOUNT]: 'legacy' });
    await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec, readDeadlineMs: 5000 },
      ADDRESS,
    );
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.opts?.timeoutMs === 5000)).toBe(true);
  });

  it('storeDurably headless gives each exec at most 10000 ms, at a TTY at most 60000 ms', async () => {
    for (const [isTTY, bound] of [
      [false, STORE_TIMEOUTS.writeMs],
      [true, STORE_TIMEOUTS.interactiveWriteMs],
    ] as const) {
      const { exec, calls } = fakeKeychain();
      await storeDurably(
        { env: {}, dir: tmp, platform: 'darwin', isTTY, exec },
        'keychain',
        ADDRESS,
        's',
      );
      expect(calls).toHaveLength(3);
      for (const c of calls) {
        expect(c.opts?.timeoutMs).toBeGreaterThan(0);
        expect(c.opts?.timeoutMs).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('with a fake clock: the pre-read gets the full bound, then the time left, strictly decreasing', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const inner = fakeKeychain();
    const exec: ExecFn = async (file, args, stdin, opts) => {
      try {
        return await inner.exec(file, args, stdin, opts);
      } finally {
        vi.advanceTimersByTime(2000);
      }
    };
    await expect(
      storeDurably(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
        'keychain',
        ADDRESS,
        's',
      ),
    ).resolves.toBe('stored');
    expect(inner.calls.map((c) => c.opts?.timeoutMs)).toEqual([10000, 8000, 6000]);
  });

  it('a bound already spent before the write gives uncertain with zero writes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const inner = fakeKeychain();
    const exec: ExecFn = async (file, args, stdin, opts) => {
      try {
        return await inner.exec(file, args, stdin, opts);
      } finally {
        vi.advanceTimersByTime(STORE_TIMEOUTS.writeMs);
      }
    };
    await expect(
      storeDurably(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
        'keychain',
        ADDRESS,
        's',
      ),
    ).resolves.toBe('uncertain');
    expect(inner.calls.filter((c) => c.args[0] === '-i')).toHaveLength(0);
  });

  it('the probe gets 3000 ms on darwin, linux (the sentinel lookup) and win32', async () => {
    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      const { exec, calls } = recordingExec(() => ({ stdout: '' }));
      const probed = await probeDurableStore({ env: {}, dir: tmp, platform, exec });
      expect(probed.probe).toBe('available');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.opts?.timeoutMs).toBe(3000);
    }
  });

  it('at a TTY, a write still unanswered after 1 s prints the waiting line once', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const onWait = vi.fn();
    const inner = fakeKeychain();
    const exec: ExecFn = async (file, args, stdin, opts) => {
      if (args[0] === '-i') await new Promise((r) => setTimeout(r, 3000));
      return inner.exec(file, args, stdin, opts);
    };
    const run = storeDurably(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: true, exec, onWait },
      'keychain',
      ADDRESS,
      's',
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(onWait).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(run).resolves.toBe('stored');
    expect(onWait).toHaveBeenCalledOnce();
    expect(onWait).toHaveBeenCalledWith(KEYCHAIN_WAIT_LINE);
  });

  it('headless, and for the file store, the waiting line never prints', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const onWait = vi.fn();
    const inner = fakeKeychain();
    const exec: ExecFn = async (file, args, stdin, opts) => {
      if (args[0] === '-i') await new Promise((r) => setTimeout(r, 3000));
      return inner.exec(file, args, stdin, opts);
    };
    const run = storeDurably(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec, onWait },
      'keychain',
      ADDRESS,
      's',
    );
    await vi.advanceTimersByTimeAsync(5000);
    await run;
    vi.useRealTimers();
    await storeDurably({ env: {}, dir: tmp, isTTY: true, onWait }, 'file', ADDRESS, 's');
    expect(onWait).not.toHaveBeenCalled();
  });
});

describe('classifyStoreFailure (section 2.5)', () => {
  it.each([
    ['keychain', exited('security', 44), 'miss'],
    ['keychain', enoent('security'), 'absent'],
    [
      'keychain',
      exited(
        'security',
        50,
        'security: SecKeychainCopyDefault: A default keychain could not be found.',
      ),
      'absent',
    ],
    ['keychain', killedErr('security'), 'locked'],
    ['keychain', exited('security', 36, 'User interaction is not allowed.'), 'locked'],
    ['keychain', exited('security', 1, 'something nobody has seen'), 'locked'],
    ['secret-service', exited('secret-tool', 1), 'miss'],
    ['secret-service', enoent('secret-tool'), 'absent'],
    [
      'secret-service',
      exited('secret-tool', 1, 'Cannot autolaunch D-Bus without X11 $DISPLAY'),
      'absent',
    ],
    [
      'secret-service',
      exited(
        'secret-tool',
        1,
        'The name org.freedesktop.secrets was not provided by any .service files',
      ),
      'absent',
    ],
    [
      'secret-service',
      exited('secret-tool', 1, 'Could not connect: No such file or directory'),
      'absent',
    ],
    ['secret-service', killedErr('secret-tool'), 'locked'],
    ['secret-service', exited('secret-tool', 1, 'Prompt dismissed'), 'locked'],
    ['dpapi', enoent('powershell.exe'), 'absent'],
    ['dpapi', killedErr('powershell.exe'), 'locked'],
    ['dpapi', exited('powershell.exe', 1), 'locked'],
    ['file', Object.assign(new Error('nope'), { code: 'ENOENT' }), 'miss'],
    ['file', Object.assign(new Error('nope'), { code: 'EACCES' }), 'locked'],
  ] as const)('%s %#: %s', (store, err, kind) => {
    expect(classifyStoreFailure(store, err).kind).toBe(kind);
  });

  it('anything that is not a StoreExecError is locked, with a fixed detail (Q5)', () => {
    for (const err of [new Error('SECRET'), 'SECRET', null, { stdout: 'SECRET', code: 44 }]) {
      const got = classifyStoreFailure('keychain', err);
      expect(got.kind).toBe('locked');
      expect(JSON.stringify(got)).not.toContain('SECRET');
    }
  });

  it('details name only the kind, the exit code and the signal', () => {
    const got = classifyStoreFailure(
      'keychain',
      new StoreExecError('security', { code: 1, stderr: 'stderr says SECRET' }),
    );
    expect(got).toEqual({ kind: 'locked', detail: 'security exited 1' });
    expect(classifyStoreFailure('keychain', killedErr('security'))).toEqual({
      kind: 'locked',
      detail: 'the macOS keychain did not answer (killed by SIGKILL)',
    });
  });
});

describe('probeDurableStore', () => {
  it('darwin: default-keychain answers is available; "could not be found" or ENOENT is absent; a kill is uncertain', async () => {
    const run = (out: { stdout: string } | Error) =>
      probeDurableStore({
        env: {},
        dir: tmp,
        platform: 'darwin',
        exec: recordingExec(() => out).exec,
      });
    await expect(run({ stdout: 'x' })).resolves.toMatchObject({
      store: 'keychain',
      probe: 'available',
    });
    await expect(
      run(exited('security', 50, 'A default keychain could not be found.')),
    ).resolves.toMatchObject({ probe: 'absent' });
    await expect(run(enoent('security'))).resolves.toMatchObject({ probe: 'absent' });
    await expect(run(killedErr('security'))).resolves.toMatchObject({ probe: 'uncertain' });
  });

  it('linux: the sentinel lookup — hit or miss is available, no D-Bus is absent, a kill is uncertain', async () => {
    const run = (out: { stdout: string } | Error) => {
      const rec = recordingExec(() => out);
      return probeDurableStore({ env: {}, dir: tmp, platform: 'linux', exec: rec.exec }).then(
        (p) => ({ ...p, account: rec.calls[0]?.args.at(-1) }),
      );
    };
    await expect(run(exited('secret-tool', 1))).resolves.toMatchObject({
      store: 'secret-service',
      probe: 'available',
      account: '0x0000000000000000000000000000000000000000',
    });
    await expect(run(exited('secret-tool', 1, 'Cannot autolaunch D-Bus'))).resolves.toMatchObject({
      probe: 'absent',
    });
    await expect(run(killedErr('secret-tool'))).resolves.toMatchObject({ probe: 'uncertain' });
  });

  it('win32: ENOENT is absent and anything else is available (DPAPI has no lock)', async () => {
    const run = (out: { stdout: string } | Error) =>
      probeDurableStore({
        env: {},
        dir: tmp,
        platform: 'win32',
        exec: recordingExec(() => out).exec,
      });
    await expect(run({ stdout: '' })).resolves.toMatchObject({
      store: 'dpapi',
      probe: 'available',
    });
    await expect(run(enoent('powershell.exe'))).resolves.toMatchObject({ probe: 'absent' });
    await expect(run(exited('powershell.exe', 1))).resolves.toMatchObject({ probe: 'available' });
    // A cold powershell.exe killed at the 3 s probe bound is slow, not locked.
    await expect(run(killedErr('powershell.exe'))).resolves.toMatchObject({ probe: 'available' });
  });

  it('a platform without an OS store is absent, with no exec', async () => {
    const { exec, calls } = recordingExec(() => new Error('exec must not run'));
    await expect(
      probeDurableStore({ env: {}, dir: tmp, platform: 'freebsd', exec }),
    ).resolves.toMatchObject({ probe: 'absent' });
    expect(calls).toHaveLength(0);
  });
});

describe('resolvePassphraseForCreate (never prompts, Q1)', () => {
  it.skipIf(process.platform === 'win32')(
    'freebsd writes a 0600 .plain file with the generated secret and never prompts',
    async () => {
      const res = await resolvePassphraseForCreate(
        { env: {}, dir: tmp, platform: 'freebsd', isTTY: true, prompt: neverPrompt },
        ADDRESS,
      );
      expect(res).toMatchObject({
        source: 'file',
        origin: 'generated',
        durable: true,
        fileReason: 'no-keyring',
        location: passphraseFilePathFor(ACCOUNT, tmp),
      });
      const path = passphraseFilePathFor(ACCOUNT, tmp);
      expect(await readFile(path, 'utf8')).toBe(res.passphrase);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    },
  );

  it('a keychain probe that says absent writes the file instead', async () => {
    const { exec, calls } = recordingExec(() =>
      exited('security', 50, 'A default keychain could not be found.'),
    );
    const res = await resolvePassphraseForCreate(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec, prompt: neverPrompt },
      ADDRESS,
    );
    expect(res).toMatchObject({ source: 'file', fileReason: 'no-keyring', durable: true });
    expect(calls).toHaveLength(1); // only the probe
  });

  it('a keychain probe that is uncertain refuses: keychain_locked, KEYCHAIN_LOCKED_FIX, nothing written', async () => {
    const { exec, calls } = recordingExec(() => killedErr('security'));
    const err = (await resolvePassphraseForCreate(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec, prompt: neverPrompt },
      ADDRESS,
    ).catch((e) => e)) as CliError;
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toBe(KEYCHAIN_LOCKED_FIX);
    expect(err.fix).not.toContain('--insecure-storage');
    expect((err.details as { unlock: { reason: string } }).unlock.reason).toBe('keychain_locked');
    expect(calls.map((c) => c.args[0])).toEqual(['default-keychain']);
    await expect(stat(passphraseFilePathFor(ACCOUNT, tmp))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readPassphraseRecord(tmp, ACCOUNT)).toBeNull();
  });

  it('Q2: an env value with a working keychain is saved there', async () => {
    const { exec, entries } = fakeKeychain();
    const res = await resolvePassphraseForCreate(
      {
        env: { TENJIN_WALLET_PASSPHRASE: 'my-own-pass' },
        dir: tmp,
        platform: 'darwin',
        isTTY: false,
        exec,
      },
      ADDRESS,
    );
    expect(res).toEqual({
      passphrase: 'my-own-pass',
      source: 'keychain',
      origin: 'env',
      durable: true,
      location: describeStoreLocation('keychain', ACCOUNT),
    });
    expect(entries.get(ACCOUNT)).toBe('my-own-pass');
  });

  it('S4: linux with secret-tool ENOENT saves to the file with fileReason no-keyring', async () => {
    const { exec } = recordingExec(() => enoent('secret-tool'));
    const res = await resolvePassphraseForCreate(
      { env: {}, dir: tmp, platform: 'linux', isTTY: false, exec, prompt: neverPrompt },
      ADDRESS,
    );
    expect(res).toMatchObject({ source: 'file', fileReason: 'no-keyring', durable: true });
  });

  it('env with the probe uncertain still creates, but not durably', async () => {
    const { exec } = recordingExec(() => killedErr('security'));
    const res = await resolvePassphraseForCreate(
      {
        env: { TENJIN_WALLET_PASSPHRASE: 'my-own-pass' },
        dir: tmp,
        platform: 'darwin',
        isTTY: false,
        exec,
      },
      ADDRESS,
    );
    expect(res).toMatchObject({
      passphrase: 'my-own-pass',
      source: 'env',
      origin: 'env',
      durable: false,
      location: 'TENJIN_WALLET_PASSPHRASE',
      attempted: 'keychain',
    });
  });

  it('insecureStorage skips the probe and writes the file', async () => {
    const { exec, calls } = recordingExec(() => new Error('exec must not run'));
    const res = await resolvePassphraseForCreate(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
      { insecureStorage: true },
    );
    expect(res).toMatchObject({ source: 'file', fileReason: 'insecure-storage', durable: true });
    expect(calls).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'decision 6: a generated secret whose file write fails refuses with FILE_STORE_FAILED_FIX, never a keychain',
    async () => {
      await chmod(tmp, 0o500); // the data dir is not writable
      const err = (await resolvePassphraseForCreate(
        { env: {}, dir: tmp, platform: 'freebsd', isTTY: false },
        ADDRESS,
      ).catch((e) => e)) as CliError;
      const path = passphraseFilePathFor(ACCOUNT, tmp);
      expect(err.code).toBe('REFUSED');
      expect(err.fix).toBe(FILE_STORE_FAILED_FIX(path));
      expect(err.details).toEqual({ passphraseStore: { kind: 'file-write-failed', path } });
      expect(err.message.toLowerCase()).not.toContain('keychain');
      expect(err.fix?.toLowerCase()).not.toContain('keychain');
      expect(err.fix).not.toBe(KEYCHAIN_LOCKED_FIX);

      // The same failure for an env secret still creates, not durably.
      const res = await resolvePassphraseForCreate(
        { env: { TENJIN_WALLET_PASSPHRASE: 'mine' }, dir: tmp, platform: 'freebsd', isTTY: false },
        ADDRESS,
      );
      expect(res).toMatchObject({ durable: false, attempted: 'file', source: 'env' });
    },
  );

  it('never saves an env secret ending in a line break to the file, which would read back as another secret', async () => {
    const res = await resolvePassphraseForCreate(
      {
        env: { TENJIN_WALLET_PASSPHRASE: 'x-secret\n' },
        dir: tmp,
        platform: 'freebsd',
        isTTY: false,
      },
      ADDRESS,
    );
    expect(res).toMatchObject({
      passphrase: 'x-secret\n',
      source: 'env',
      durable: false,
      attempted: 'file',
      notSaved: 'rejected-characters',
    });
    await expect(stat(passphraseFilePathFor(ACCOUNT, tmp))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // Without the variable nothing answers: no stale file is read as the passphrase.
    await expect(
      resolvePassphrase({ env: {}, dir: tmp, platform: 'freebsd', isTTY: false }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it.each([
    ['secret-service', 'linux'],
    ['dpapi', 'win32'],
  ] as const)(
    'the %s gate refuses a trailing line break before any write',
    async (store, platform) => {
      // An empty lookup is a miss; nothing here answers a write.
      const { exec, calls } = recordingExec(() => ({ stdout: '' }));
      await expect(
        storeDurably({ env: {}, dir: tmp, platform, isTTY: false, exec }, store, ADDRESS, 'p\r\n'),
      ).resolves.toBe('rejected-characters');
      expect(calls.filter((c) => c.stdin !== undefined)).toEqual([]);
    },
  );

  it('a generated secret whose OS store write fails refuses with keychain_locked details', async () => {
    const { exec } = recordingExec((call) => {
      if (call.args[0] === 'default-keychain') return { stdout: '' };
      if (call.args[0] === '-i') return exited('security', 1);
      return notFound();
    });
    const err = (await resolvePassphraseForCreate(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    ).catch((e) => e)) as CliError;
    expect(err.code).toBe('REFUSED');
    expect(err.fix).toBe(KEYCHAIN_LOCKED_FIX);
    expect(err.details).toMatchObject({ unlock: { reason: 'keychain_locked' } });
  });

  it('create with existing wallets present writes ONLY its own entry and overwrites nothing', async () => {
    const { exec, entries, calls } = fakeKeychain({
      [OTHER_ACCOUNT]: 'other-wallet-pass',
      [LEGACY_ACCOUNT]: 'legacy-pass',
    });
    const res = await resolvePassphraseForCreate(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
      ADDRESS,
    );
    expect(entries.get(ACCOUNT)).toBe(res.passphrase);
    expect(entries.get(OTHER_ACCOUNT)).toBe('other-wallet-pass');
    expect(entries.get(LEGACY_ACCOUNT)).toBe('legacy-pass');
    expect(calls.every((c) => c.args[0] !== 'delete-generic-password')).toBe(true);
  });

  it('a create can never overwrite an existing per-address entry (conflict refuses)', async () => {
    const { exec, entries } = fakeKeychain({ [ACCOUNT]: 'the-original-pass' });
    await expect(
      resolvePassphraseForCreate(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec },
        ADDRESS,
      ),
    ).rejects.toMatchObject({ code: 'REFUSED' });
    expect(entries.get(ACCOUNT)).toBe('the-original-pass');
  });
});

describe('Windows DPAPI backend', () => {
  // A stubbed PowerShell that fakes DPAPI with base64 so the blob-file plumbing is
  // exercised end to end: protect => base64(plaintext), unprotect => decode.
  const fakeDpapi: ExecFn = async (file, args, stdin) => {
    expect(file).toBe('powershell.exe');
    const script = args[args.length - 1] ?? '';
    if (script === '$null') return { stdout: '', stderr: '' }; // the probe
    if (script.includes('Unprotect')) {
      return { stdout: Buffer.from((stdin ?? '').trim(), 'base64').toString('utf8'), stderr: '' };
    }
    return { stdout: Buffer.from(stdin ?? '', 'utf8').toString('base64'), stderr: '' };
  };

  it('roundtrip: store writes a PER-WALLET DPAPI blob file, read unprotects it back', async () => {
    const created = await resolvePassphraseForCreate(
      { env: {}, dir: tmp, platform: 'win32', isTTY: false, exec: fakeDpapi },
      ADDRESS,
    );
    expect(created.source).toBe('dpapi');
    expect(created.passphrase).toMatch(BASE64URL);

    const blob = await readFile(passphraseBlobPathFor(ACCOUNT, tmp), 'utf8');
    expect(blob).toBe(Buffer.from(created.passphrase, 'utf8').toString('base64'));
    await expect(stat(passphraseBlobPath(tmp))).rejects.toMatchObject({ code: 'ENOENT' });

    const read = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'win32', isTTY: false, exec: fakeDpapi },
      ADDRESS,
    );
    expect(read).toEqual({ passphrase: created.passphrase, source: 'dpapi' });
  });

  it('legacy blob fallback: served with a migration that re-keys the file and removes the old blob', async () => {
    const legacyPass = 'legacy-dpapi-pass';
    await writeFile(passphraseBlobPath(tmp), Buffer.from(legacyPass, 'utf8').toString('base64'));

    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'win32', isTTY: false, exec: fakeDpapi },
      ADDRESS,
    );
    expect(res.passphrase).toBe(legacyPass);
    await expect(res.migrateLegacy?.()).resolves.toBe(true);
    const migrated = await readFile(passphraseBlobPathFor(ACCOUNT, tmp), 'utf8');
    expect(Buffer.from(migrated.trim(), 'base64').toString('utf8')).toBe(legacyPass);
    await expect(stat(passphraseBlobPath(tmp))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('read miss: a missing blob file is a miss WITHOUT spawning PowerShell', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: '' }));
    await expect(
      resolvePassphrase({ env: {}, dir: tmp, platform: 'win32', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });

  it('store failure: a PowerShell protect error refuses and writes no blob', async () => {
    const { exec } = recordingExec((call) =>
      call.args.at(-1) === '$null' ? { stdout: '' } : exited('powershell.exe', 1),
    );
    await expect(
      resolvePassphraseForCreate(
        { env: {}, dir: tmp, platform: 'win32', isTTY: false, exec },
        ADDRESS,
      ),
    ).rejects.toMatchObject({ code: 'REFUSED' });
    await expect(stat(passphraseBlobPathFor(ACCOUNT, tmp))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('desktop-Linux secret-service backend', () => {
  it('read hit: secret-tool lookup on the wallet own account yields the stored passphrase', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: 'secret-pass' }));
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'linux', isTTY: false, exec },
      ADDRESS,
    );
    expect(res).toEqual({ passphrase: 'secret-pass', source: 'secret-service' });
    const call = first(calls);
    expect(call.file).toBe('secret-tool');
    expect(call.args).toContain('lookup');
    expect(call.args).toContain(ACCOUNT);
  });

  it('read: secret-tool not installed (ENOENT) is absent, so the legacy slot is skipped', async () => {
    const { exec, calls } = recordingExec(() => enoent('secret-tool'));
    await expect(
      resolvePassphrase({ env: {}, dir: tmp, platform: 'linux', isTTY: false, exec }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(1);
  });

  it('store success: secret-tool store under the wallet account, secret on stdin, verified by read-back', async () => {
    let stored = '';
    const { exec, calls } = recordingExec((call) => {
      if (call.args[0] === 'store') {
        stored = call.stdin ?? '';
        return { stdout: '' };
      }
      return stored === '' ? exited('secret-tool', 1) : { stdout: stored };
    });
    const res = await resolvePassphraseForCreate(
      { env: {}, dir: tmp, platform: 'linux', isTTY: false, exec },
      ADDRESS,
    );
    expect(res.source).toBe('secret-service');
    const store = calls.find((c) => c.args[0] === 'store') as ExecCall;
    expect(store.args).toContain(ACCOUNT);
    expect(store.stdin).toBe(res.passphrase);
    expect(store.args.some((a) => a.includes(res.passphrase))).toBe(false);
    // probe, pre-read, store, read-back
    expect(calls.map((c) => c.args[0])).toEqual(['lookup', 'lookup', 'store', 'lookup']);
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
          if (args[0] === 'default-keychain') return { stdout: '', stderr: '' };
          if (args[0] === '-i') {
            kept = stdin?.match(/-w '([^']+)'/)?.[1] ?? '';
            return { stdout: '', stderr: '' };
          }
          const account = args[args.indexOf('-a') + 1];
          if (account === ACCOUNT && kept !== '') return { stdout: `${kept}\n`, stderr: '' };
          throw notFound();
        }
        if (file === 'secret-tool') {
          if (args[0] === 'store') {
            kept = stdin ?? '';
            return { stdout: '', stderr: '' };
          }
          const account = args[args.indexOf('account') + 1];
          if (account === ACCOUNT && kept !== '') return { stdout: kept, stderr: '' };
          throw exited('secret-tool', 1);
        }
        // powershell.exe: fake DPAPI as base64 <-> plaintext.
        const script = args[args.length - 1] ?? '';
        if (script === '$null') return { stdout: '', stderr: '' };
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
        { env: {}, dir, platform, isTTY: false, exec },
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

    for (const { call, secret } of recorded) {
      expect(call.args.some((a) => a.includes(secret))).toBe(false);
    }
    const carriedOnStdin = recorded.filter(({ call, secret }) =>
      (call.stdin ?? '').includes(secret),
    );
    expect(carriedOnStdin.length).toBeGreaterThanOrEqual(3);
  });
});

// S2: a failed store CLI's stdout (for a read, the passphrase) never reaches
// any message, fix, detail, warning or waiting line.
describe('no secret in errors (S2)', () => {
  const leaky = { stdout: 'SECRET', stderr: 'boom', code: 1 };
  const leakyExec: ExecFn = async () => {
    throw leaky;
  };
  const clean = (err: unknown): void => {
    const e = err as CliError;
    expect(e.message).not.toContain('SECRET');
    expect(e.fix ?? '').not.toContain('SECRET');
    expect(JSON.stringify(e.details ?? null)).not.toContain('SECRET');
  };

  it('a sidecar-recorded keychain read', async () => {
    await writePassphraseRecord(tmp, ACCOUNT, { store: 'keychain', by: 'create' });
    const err = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec: leakyExec },
      ADDRESS,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    clean(err);
  });

  it('a no-sidecar read', async () => {
    const err = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: false, exec: leakyExec },
      ADDRESS,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    clean(err);
  });

  it("storeDurably's pre-read and read-back, and create's refusal", async () => {
    const onWait = vi.fn();
    await expect(
      storeDurably(
        { env: {}, dir: tmp, platform: 'darwin', isTTY: true, exec: leakyExec, onWait },
        'keychain',
        ADDRESS,
        's',
      ),
    ).resolves.toBe('uncertain');
    let wrote = false;
    const readBackLeaks: ExecFn = async (_file, args) => {
      if (args[0] === '-i') {
        wrote = true;
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'default-keychain') return { stdout: '', stderr: '' };
      if (wrote) throw leaky;
      throw notFound();
    };
    const err = await resolvePassphraseForCreate(
      { env: {}, dir: tmp, platform: 'darwin', isTTY: true, exec: readBackLeaks, onWait },
      ADDRESS,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CliError);
    clean(err);
    for (const [line] of onWait.mock.calls) expect(String(line)).not.toContain('SECRET');
  });
});

// The deadline is real (it kills a live child), and it is per call. Every other
// test in this file injects `exec`, which bypasses the executor entirely, so
// these drive the actual execFile path. `process.execPath` keeps them portable.
describe('defaultExecFor', () => {
  const hang = ['-e', 'setTimeout(() => {}, 30000)'];

  it('kills a child that outlives its per-call deadline, and rejects fast with a StoreExecError', async () => {
    const started = Date.now();
    const err = await defaultExecFor()(process.execPath, hang, undefined, { timeoutMs: 300 }).catch(
      (e) => e,
    );
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(err).toBeInstanceOf(StoreExecError);
    expect((err as StoreExecError).killed).toBe(true);
  });

  it('lets a child run as long as it needs when no deadline is given', async () => {
    const slower = ['-e', 'setTimeout(() => {}, 600)'];
    await expect(defaultExecFor()(process.execPath, slower)).resolves.toEqual({
      stdout: '',
      stderr: '',
    });
  });

  it('S2: a failing child that printed a secret rejects with no stdout, anywhere', async () => {
    const err = await defaultExecFor()(process.execPath, [
      '-e',
      "process.stdout.write('SECRET');process.exit(1)",
    ]).catch((e) => e);
    expect(err).toBeInstanceOf(StoreExecError);
    expect(err).not.toHaveProperty('stdout');
    expect((err as StoreExecError).code).toBe(1);
    expect((err as StoreExecError).message).not.toContain('SECRET');
    expect(JSON.stringify(err)).not.toContain('SECRET');
  });

  it('a missing binary is enoent', async () => {
    const err = await defaultExecFor()('tenjin-no-such-binary-xyz', []).catch((e) => e);
    expect(err).toBeInstanceOf(StoreExecError);
    expect((err as StoreExecError).enoent).toBe(true);
  });
});

describe('describeStoreLocation', () => {
  it('names each store the way an operator finds it', async () => {
    expect(describeStoreLocation('keychain', ACCOUNT)).toBe(
      `your macOS keychain (service tenjin-cli, account ${ACCOUNT})`,
    );
    expect(describeStoreLocation('secret-service', ACCOUNT)).toBe(
      `your Linux keyring (Secret Service, service tenjin-cli, account ${ACCOUNT})`,
    );
    expect(describeStoreLocation('dpapi', ACCOUNT)).toBe(
      `a DPAPI-encrypted file (passphrase.${ACCOUNT}.dpapi)`,
    );
    expect(describeStoreLocation('file', ACCOUNT, tmp)).toBe(passphraseFilePathFor(ACCOUNT, tmp));
    const { homedir } = await import('node:os');
    expect(describeStoreLocation('file', ACCOUNT, join(homedir(), '.tenjin'))).toBe(
      `~/.tenjin/passphrase.${ACCOUNT}.plain`,
    );
  });
});

describe('the file store read', () => {
  it('a 0644 file still reads; an empty one is a miss', async () => {
    await mkdir(tmp, { recursive: true });
    await writeFile(passphraseFilePathFor(ACCOUNT, tmp), 'loose-pass\n', { mode: 0o644 });
    const res = await resolvePassphrase(
      { env: {}, dir: tmp, platform: 'freebsd', isTTY: false },
      ADDRESS,
    );
    expect(res).toEqual({ passphrase: 'loose-pass', source: 'file' });
    await writeFile(passphraseFilePathFor(ACCOUNT, tmp), '');
    await expect(
      resolvePassphrase({ env: {}, dir: tmp, platform: 'freebsd', isTTY: false }, ADDRESS),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});
