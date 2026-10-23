import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every path any `node:fs/promises` call touched, and every `node:child_process`
 * call, so a test can prove what `alive` never reads and never runs.
 */
const seen = vi.hoisted(() => ({ paths: [] as string[], execs: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of ['readFile', 'open', 'stat', 'lstat', 'access', 'readdir'] as const) {
    const fn = actual[name] as (...args: unknown[]) => unknown;
    wrapped[name] = (...args: unknown[]) => {
      seen.paths.push(String(args[0]));
      return fn(...args);
    };
  }
  return wrapped;
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const counted = <T extends (...args: never[]) => unknown>(fn: T) =>
    ((...args: Parameters<T>) => {
      seen.execs += 1;
      return fn(...args);
    }) as unknown as T;
  return {
    ...actual,
    exec: counted(actual.exec),
    execFile: counted(actual.execFile),
    spawn: counted(actual.spawn),
    execFileSync: counted(actual.execFileSync),
    spawnSync: counted(actual.spawnSync),
  };
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePassphraseRecord } from '../lib/passphrase-record';
import { aliveMain, runAliveHook, walletAtStart, type AliveAnswer } from './alive';
import { noticeFor } from './notice-markers';
import { writeUnlockRecord } from './router-observation';
import { WALLET_REASONS } from './wallet-reasons';

const ADDRESS = '0x1234567890AbcdEF1234567890aBcdef12345678';
const NOW = 1_800_000_000_000;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'alive-'));
  seen.paths = [];
  seen.execs = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function wallet(): Promise<void> {
  await writeFile(join(dir, 'wallet.json'), JSON.stringify({ schemaVersion: 2, address: ADDRESS }));
}

const run = (env: NodeJS.ProcessEnv = {}, session = 'sess-1') =>
  runAliveHook({ session_id: session }, { dataDir: dir, version: '1.0.0', now: NOW, env });

describe('runAliveHook prints nothing', () => {
  it('for a machine with no wallet file (it may be --no-wallet on purpose)', async () => {
    expect(await run()).toBeNull();
  });

  it('for a healthy wallet whose passphrase is in the keychain', async () => {
    await wallet();
    await writePassphraseRecord(dir, ADDRESS, { store: 'keychain', by: 'create' });
    expect(await run()).toBeNull();
  });

  it.each([
    ['valid', `0x${'1'.repeat(64)}`],
    ['malformed', '0xnope'],
  ])('for a %s TENJIN_WALLET_KEY, which shadows the file', async (_label, key) => {
    await writeFile(join(dir, 'wallet.json'), 'not json');
    expect(await run({ TENJIN_WALLET_KEY: key })).toBeNull();
  });

  it('for the saved passphrase file missing while TENJIN_WALLET_PASSPHRASE is set', async () => {
    await wallet();
    await writePassphraseRecord(dir, ADDRESS, { store: 'file', by: 'create' });
    expect(await run({ TENJIN_WALLET_PASSPHRASE: 'set' })).toBeNull();
  });

  it("for a router's earlier blocked verdict: no replay (Q4)", async () => {
    await wallet();
    await writeUnlockRecord(dir, {
      version: 1,
      address: ADDRESS,
      status: 'blocked',
      reason: 'passphrase_wrong',
      at: NOW - 1000,
    });
    expect(await run()).toBeNull();
  });
});

describe('runAliveHook says one thing', () => {
  it.each([
    [
      'a corrupt wallet.json',
      'wallet_corrupt' as const,
      async () => writeFile(join(dir, 'wallet.json'), '{ not json'),
    ],
    [
      'the saved passphrase file gone with the variable unset',
      'passphrase_missing' as const,
      async () => {
        await wallet();
        await writePassphraseRecord(dir, ADDRESS, { store: 'file', by: 'create' });
      },
    ],
  ])('for %s', async (_label, reason, setup) => {
    await setup();
    const answer = await run();
    const r = WALLET_REASONS[reason];
    expect(answer).toEqual({
      systemMessage: `Tenjin can't use its wallet in this session: ${r.reason}. ${r.fix}`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `Tenjin's wallet cannot sign in this session (${r.reason}), so Tenjin lookups take the free path and paid lookups will not run. ${r.agentFix}`,
      },
    } satisfies AliveAnswer);
    // The model's half carries agentFix; no half ever puts the passphrase on a command line (B1).
    expect(answer!.hookSpecificOutput.additionalContext).toContain(r.agentFix);
    expect(JSON.stringify(answer)).not.toContain('TENJIN_WALLET_PASSPHRASE=');
    expect(await walletAtStart(dir, {})).toBe(reason);
  });

  it("writes the reason's notice marker, so the session's first prompt leg stays quiet", async () => {
    await wallet();
    await writePassphraseRecord(dir, ADDRESS, { store: 'file', by: 'create' });
    expect(await run()).not.toBeNull();
    expect(await noticeFor(dir, 'sess-1', 'passphrase_missing', NOW + 1)).toBe('quiet');
    expect(await noticeFor(dir, 'sess-2', 'passphrase_missing', NOW + 1)).toBe('tell');
  });
});

describe('runAliveHook stays inside the files', () => {
  it('never opens unlock-state.json and never execs anything', async () => {
    await wallet();
    await writePassphraseRecord(dir, ADDRESS, { store: 'file', by: 'create' });
    await writeUnlockRecord(dir, {
      version: 1,
      address: ADDRESS,
      status: 'awaiting_confirmation',
      at: NOW,
    });
    seen.paths = [];
    expect(await run()).not.toBeNull();
    expect(seen.paths.length).toBeGreaterThan(0);
    expect(seen.paths.filter((p) => p.includes('unlock-state'))).toEqual([]);
    expect(seen.execs).toBe(0);
  });

  it('never throws, even on an unreadable data dir', async () => {
    const file = join(dir, 'not-a-dir');
    await writeFile(file, '');
    const answer = await runAliveHook(
      { session_id: 's' },
      { dataDir: file, version: '1', env: {} },
    );
    expect(answer === null || answer.hookSpecificOutput.hookEventName === 'SessionStart').toBe(
      true,
    );
  });
});

describe('aliveMain', () => {
  it('writes one JSON line and waits for the write to land', async () => {
    await writeFile(join(dir, 'wallet.json'), '{ not json');
    let written = '';
    let landed: (() => void) | undefined;
    const stdout = {
      write: (chunk: string, cb?: () => void) => {
        written += chunk;
        landed = cb;
        return true;
      },
    } as unknown as Pick<NodeJS.WritableStream, 'write'>;
    let done = false;
    const main = aliveMain({
      dataDir: dir,
      version: '1',
      env: {},
      readEvent: async () => JSON.stringify({ session_id: 's' }),
      stdout,
    }).then(() => {
      done = true;
    });
    await vi.waitFor(() => expect(landed).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    landed!();
    await main;
    expect(done).toBe(true);
    expect(written.endsWith('\n')).toBe(true);
    expect(written.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(written)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'SessionStart' },
    });
  });

  it('writes nothing when there is nothing definite to say', async () => {
    const write = vi.fn();
    await aliveMain({
      dataDir: dir,
      version: '1',
      env: {},
      readEvent: async () => JSON.stringify({ session_id: 's' }),
      stdout: { write } as unknown as Pick<NodeJS.WritableStream, 'write'>,
    });
    expect(write).not.toHaveBeenCalled();
  });
});
