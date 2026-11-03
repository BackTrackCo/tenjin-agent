import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  liveDir,
  liveObservations,
  markUnlockPending,
  pidAlive,
  pruneDeadObservations,
  readObservations,
  readUnlockRecord,
  removeObservationSync,
  servedObservations,
  writeObservation,
  writeUnlockRecord,
  type RouterObservation,
} from './router-observation';

const isWindows = process.platform === 'win32';
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-ro-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function obs(over: Partial<RouterObservation> = {}): RouterObservation {
  return {
    version: 1,
    pid: 4242,
    startedAt: 1_000_000,
    at: 1_000_500,
    cliVersion: '0.1.0-alpha.31',
    harness: 'claude',
    launchedByPlugin: true,
    cwd: '/work',
    address: A,
    servedSession: true,
    env: { passphraseSet: false, keySet: false },
    sign: { status: 'ready', source: 'keychain' },
    ...over,
  };
}

async function writeRaw(name: string, value: unknown): Promise<void> {
  await mkdir(liveDir(dir), { recursive: true });
  await writeFile(
    join(liveDir(dir), name),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
}

describe('observations', () => {
  it('round-trips at 0600', async () => {
    const o = obs({ routing: { status: 'blocked', reason: 'wallet_low', at: 5 } });
    await writeObservation(dir, o);
    expect(await readObservations(dir)).toEqual([o]);
    if (!isWindows) {
      expect((await stat(join(liveDir(dir), '4242.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(liveDir(dir))).mode & 0o777).toBe(0o700);
    }
  });

  it('removeObservationSync removes it, and tolerates a missing file', async () => {
    await writeObservation(dir, obs());
    removeObservationSync(dir, 4242);
    removeObservationSync(dir, 4242);
    expect(await readObservations(dir)).toEqual([]);
  });

  it('reads nothing from an absent directory', async () => {
    expect(await readObservations(dir)).toEqual([]);
  });

  it('drops malformed, mismatched and servedSession-less files', async () => {
    const withoutServed: Partial<RouterObservation> = obs({ pid: 3 });
    delete withoutServed.servedSession;
    await writeRaw('1.json', '{not json');
    await writeRaw('2.json', obs({ pid: 99 })); // name/pid mismatch
    await writeRaw('3.json', withoutServed);
    await writeRaw('4.json', { ...obs({ pid: 4 }), version: 2 });
    await writeRaw('5.json', { ...obs({ pid: 5 }), harness: 'cursor' });
    await writeRaw('notes.json', obs());
    await writeRaw('6.json.tmp', obs({ pid: 6 }));
    await writeRaw('7.json', obs({ pid: 7 }));
    expect((await readObservations(dir)).map((o) => o.pid)).toEqual([7]);
  });

  it('servedObservations drops unserved and codex observations (B2)', () => {
    const served = obs({ pid: 1 });
    const all = [served, obs({ pid: 2, servedSession: false }), obs({ pid: 3, harness: 'codex' })];
    expect(servedObservations(all)).toEqual([served]);
  });

  it('liveObservations with a ps list keeps a listed pid within 2 s', () => {
    const near = obs({ pid: 1, startedAt: 10_000 });
    const far = obs({ pid: 2, startedAt: 10_000 });
    const unlisted = obs({ pid: 3 });
    const unknownStart = obs({ pid: 4 });
    const routers = [
      { pid: 1, startedAt: 11_999 },
      { pid: 2, startedAt: 12_001 },
      { pid: 4, startedAt: null },
    ];
    expect(liveObservations([near, far, unlisted, unknownStart], routers, () => true)).toEqual([
      near,
      unknownStart,
    ]);
  });

  it('liveObservations with a null list uses the injected alive', () => {
    const a = obs({ pid: 1 });
    const b = obs({ pid: 2 });
    expect(liveObservations([a, b], null, (pid) => pid === 2)).toEqual([b]);
  });

  it('pruneDeadObservations unlinks the dead and keeps the living', async () => {
    await writeObservation(dir, obs({ pid: 1 }));
    await writeObservation(dir, obs({ pid: 2 }));
    await writeRaw('keep.txt', 'x');
    await pruneDeadObservations(dir, (pid) => pid === 2);
    expect((await readdir(liveDir(dir))).sort()).toEqual(['2.json', 'keep.txt']);
  });

  it('pidAlive: this process is alive, a nonsense pid is not', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(1.5)).toBe(false);
    expect(pidAlive(2 ** 22 + 12_345)).toBe(false);
  });
});

describe('unlock-state', () => {
  it('round-trips per address and keeps the others', async () => {
    await writeUnlockRecord(dir, {
      version: 1,
      address: A,
      status: 'blocked',
      reason: 'passphrase_wrong',
      at: 1,
      inputs: {
        envPassphraseSet: true,
        envKeySet: false,
        walletMtimeMs: 10,
        sidecarMtimeMs: null,
        cliVersion: 'v',
      },
    });
    await writeUnlockRecord(dir, { version: 1, address: B, status: 'ready', at: 2 });
    expect(await readUnlockRecord(dir, A)).toMatchObject({
      status: 'blocked',
      reason: 'passphrase_wrong',
    });
    expect(await readUnlockRecord(dir, B)).toEqual({
      version: 1,
      address: B,
      status: 'ready',
      at: 2,
    });
    expect(await readUnlockRecord(dir, A.toUpperCase().replace('0X', '0x'))).not.toBeNull();
  });

  it.skipIf(isWindows)('is written at 0600', async () => {
    await markUnlockPending(dir, A, 7);
    expect((await stat(join(dir, 'router', 'unlock-state.json'))).mode & 0o777).toBe(0o600);
  });

  it('markUnlockPending gives awaiting_confirmation', async () => {
    await writeUnlockRecord(dir, { version: 1, address: A, status: 'blocked', at: 1 });
    await markUnlockPending(dir, A, 7);
    expect(await readUnlockRecord(dir, A)).toEqual({
      version: 1,
      address: A,
      status: 'awaiting_confirmation',
      at: 7,
    });
  });

  it('reads null for an absent or corrupt file', async () => {
    expect(await readUnlockRecord(dir, A)).toBeNull();
    await mkdir(join(dir, 'router'), { recursive: true });
    await writeFile(join(dir, 'router', 'unlock-state.json'), '{nope');
    expect(await readUnlockRecord(dir, A)).toBeNull();
  });
});
