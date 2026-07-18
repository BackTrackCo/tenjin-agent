import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passphraseBlobPath } from '../paths';
import {
  resolvePassphrase,
  resolvePassphraseForCreate,
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

/** The first recorded call, asserted present (satisfies noUncheckedIndexedAccess). */
function first(calls: ExecCall[]): ExecCall {
  expect(calls.length).toBeGreaterThan(0);
  return calls[0] as ExecCall;
}

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'tenjin-pass-'));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('resolvePassphrase — env and platform selection', () => {
  it('env beats every OS store and never touches exec', async () => {
    const { exec, calls } = recordingExec(() => new Error('exec must not run'));
    const res = await resolvePassphrase({
      env: { TENJIN_WALLET_PASSPHRASE: 'from-env' },
      platform: 'darwin',
      isTTY: false,
      exec,
    });
    expect(res).toEqual({ passphrase: 'from-env', source: 'env' });
    expect(calls).toHaveLength(0);
  });

  it('an unsupported platform has no store: a store miss falls straight to USAGE', async () => {
    const { exec, calls } = recordingExec(() => new Error('exec must not run'));
    await expect(
      resolvePassphrase({ env: {}, platform: 'freebsd', isTTY: false, exec }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });

  it('falls through a store miss to the interactive prompt', async () => {
    const { exec } = recordingExec(() => new Error('not found')); // keychain miss
    const prompt: PromptFn = async () => 'typed-pass';
    const res = await resolvePassphrase({ env: {}, platform: 'darwin', isTTY: true, exec, prompt });
    expect(res).toEqual({ passphrase: 'typed-pass', source: 'prompt' });
  });
});

describe('macOS keychain backend', () => {
  it('read hit: find-generic-password -w yields the stored passphrase', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: 'stored-pass\n' }));
    const res = await resolvePassphrase({ env: {}, platform: 'darwin', isTTY: false, exec });
    expect(res).toEqual({ passphrase: 'stored-pass', source: 'keychain' });
    const call = first(calls);
    expect(call.file).toBe('security');
    expect(call.args).toContain('find-generic-password');
    expect(call.stdin).toBeUndefined();
  });

  it('read miss: a nonzero `security` exit degrades to USAGE (no TTY)', async () => {
    const { exec } = recordingExec(() => new Error('SecKeychainSearchCopyNext: not found'));
    await expect(
      resolvePassphrase({ env: {}, platform: 'darwin', isTTY: false, exec }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('store success: writes via `security -i`, secret on stdin and never in argv', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: '' }));
    const res = await resolvePassphraseForCreate({
      env: {},
      platform: 'darwin',
      isTTY: false,
      exec,
    });
    expect(res.source).toBe('keychain');
    expect(res.passphrase).toMatch(BASE64URL);
    expect(calls).toHaveLength(1);
    const call = first(calls);
    expect(call.file).toBe('security');
    expect(call.args).toEqual(['-i']); // secret is NOT in argv
    expect(call.stdin).toBe(
      `add-generic-password -U -s tenjin-cli -a wallet -w '${res.passphrase}'\n`,
    );
    expect(call.args.some((a) => a.includes(res.passphrase))).toBe(false);
  });

  it('store failure: a `security` error degrades to USAGE', async () => {
    const { exec } = recordingExec(() => new Error('User interaction is not allowed.'));
    await expect(
      resolvePassphraseForCreate({ env: {}, platform: 'darwin', isTTY: false, exec }),
    ).rejects.toMatchObject({ code: 'USAGE' });
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

  it('roundtrip: store writes a DPAPI blob file, read unprotects it back', async () => {
    const created = await resolvePassphraseForCreate({
      env: {},
      dir: tmp,
      platform: 'win32',
      isTTY: false,
      exec: fakeDpapi,
    });
    expect(created.source).toBe('dpapi');
    expect(created.passphrase).toMatch(BASE64URL);

    // The on-disk file is the (fake) ciphertext, not the plaintext passphrase.
    const blob = await readFile(passphraseBlobPath(tmp), 'utf8');
    expect(blob).toBe(Buffer.from(created.passphrase, 'utf8').toString('base64'));

    const read = await resolvePassphrase({
      env: {},
      dir: tmp,
      platform: 'win32',
      isTTY: false,
      exec: fakeDpapi,
    });
    expect(read).toEqual({ passphrase: created.passphrase, source: 'dpapi' });
  });

  it('read miss: a missing blob file returns null WITHOUT spawning PowerShell', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: '' }));
    await expect(
      resolvePassphrase({ env: {}, dir: tmp, platform: 'win32', isTTY: false, exec }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(0);
  });

  it('store failure: a PowerShell error degrades to USAGE and writes no blob', async () => {
    const { exec } = recordingExec(() => new Error('powershell.exe not found'));
    await expect(
      resolvePassphraseForCreate({ env: {}, dir: tmp, platform: 'win32', isTTY: false, exec }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(stat(passphraseBlobPath(tmp))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('desktop-Linux secret-service backend', () => {
  it('read hit: secret-tool lookup yields the stored passphrase', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: 'secret-pass' }));
    const res = await resolvePassphrase({ env: {}, platform: 'linux', isTTY: false, exec });
    expect(res).toEqual({ passphrase: 'secret-pass', source: 'secret-service' });
    const call = first(calls);
    expect(call.file).toBe('secret-tool');
    expect(call.args).toContain('lookup');
  });

  it('read miss: secret-tool not installed (ENOENT) degrades to USAGE', async () => {
    const { exec, calls } = recordingExec(() => enoent());
    await expect(
      resolvePassphrase({ env: {}, platform: 'linux', isTTY: false, exec }),
    ).rejects.toMatchObject({ code: 'USAGE' });
    expect(calls).toHaveLength(1); // the lookup was attempted, then degraded silently
  });

  it('store success: secret-tool store, secret on stdin and never in argv', async () => {
    const { exec, calls } = recordingExec(() => ({ stdout: '' }));
    const res = await resolvePassphraseForCreate({
      env: {},
      platform: 'linux',
      isTTY: false,
      exec,
    });
    expect(res.source).toBe('secret-service');
    const call = first(calls);
    expect(call.file).toBe('secret-tool');
    expect(call.args).toContain('store');
    expect(call.stdin).toBe(res.passphrase);
    expect(call.args.some((a) => a.includes(res.passphrase))).toBe(false);
  });

  it('store failure: secret-tool ENOENT degrades to USAGE', async () => {
    const { exec } = recordingExec(() => enoent());
    await expect(
      resolvePassphraseForCreate({ env: {}, platform: 'linux', isTTY: false, exec }),
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
          return { stdout: `${kept}\n`, stderr: '' }; // find-generic-password -w
        }
        if (file === 'secret-tool') {
          if (args[0] === 'store') {
            kept = stdin ?? '';
            return { stdout: '', stderr: '' };
          }
          return { stdout: kept, stderr: '' }; // lookup (no trailing newline)
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
      const created = await resolvePassphraseForCreate({
        env: {},
        dir,
        platform,
        isTTY: false,
        exec,
      });
      const read = await resolvePassphrase({ env: {}, dir, platform, isTTY: false, exec });
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
