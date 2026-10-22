import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWalletFacts, unlockStamp } from '../lib/wallet-facts';
import { ENV_PASSPHRASE_WRONG, REPAIR_CLAUSE } from '../lib/wallet-unlock';
import {
  liveDir,
  markUnlockPending,
  readObservations,
  readUnlockRecord,
  writeUnlockRecord,
} from './router-observation';
import { createRouterObserver, type RouterObserver } from './router-observer';
import type { PayerObservation } from './routing-payer';
import { stillLockedSentence, WALLET_REASONS, WALLET_UNLOCKED } from './wallet-reasons';

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const SECRET = 'correct-horse-battery-staple-test';
const NOW = 1_800_000_000_000;

const READY: PayerObservation = { sign: { status: 'ready', source: 'keychain' }, address: ADDRESS };
const BLOCKED: PayerObservation = {
  sign: {
    status: 'blocked',
    reason: 'passphrase_wrong',
    detail: WALLET_REASONS.passphrase_wrong.reason,
    fix: WALLET_REASONS.passphrase_wrong.fix,
  },
};

let dir: string;
let observers: RouterObserver[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-observer-'));
  await writeFile(join(dir, 'wallet.json'), JSON.stringify({ schemaVersion: 2, address: ADDRESS }));
  observers = [];
});
afterEach(async () => {
  for (const o of observers) o.dispose();
  await rm(dir, { recursive: true, force: true });
});

function observer(env: NodeJS.ProcessEnv = {}): RouterObserver {
  const o = createRouterObserver({
    dataDir: dir,
    pid: process.pid,
    startedAt: NOW - 5000,
    cliVersion: '9.9.9',
    harness: 'claude',
    launchedByPlugin: true,
    cwd: '/work',
    env,
    now: () => NOW,
  });
  observers.push(o);
  return o;
}

/** The observation once the writes in flight have landed. */
async function observed() {
  await vi.waitFor(async () => expect(await readObservations(dir)).toHaveLength(1));
  // Let any write queued behind the first land too.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return (await readObservations(dir))[0]!;
}

describe('a router that never serves a session (B2)', () => {
  it('writes the prewarm verdict, stays servedSession false, and never touches unlock-state', async () => {
    await markUnlockPending(dir, ADDRESS, NOW - 1000);
    const before = await readFile(join(dir, 'router', 'unlock-state.json'), 'utf8');
    const o = observer();
    o.observe(READY);
    const obs = await observed();
    expect(obs).toMatchObject({
      servedSession: false,
      sign: { status: 'ready' },
      address: ADDRESS,
    });
    // awaiting_confirmation survives a health-check router.
    expect(await readFile(join(dir, 'router', 'unlock-state.json'), 'utf8')).toBe(before);
    expect((await readUnlockRecord(dir, ADDRESS))?.status).toBe('awaiting_confirmation');
  });

  it('starts pending', async () => {
    observer();
    expect(await observed()).toMatchObject({ sign: { status: 'pending' }, servedSession: false });
  });
});

describe('takeNews', () => {
  it('sets servedSession on the first call', async () => {
    const o = observer();
    await o.takeNews('s1');
    expect((await observed()).servedSession).toBe(true);
  });

  it('returns only the queued lines while the verdict is pending, and reads no unlock-state', async () => {
    await markUnlockPending(dir, ADDRESS, NOW - 1000);
    const o = observer();
    o.queueNews(ENV_PASSPHRASE_WRONG);
    o.queueNews(ENV_PASSPHRASE_WRONG);
    const news = await o.takeNews('s1');
    expect(news.lines).toEqual([ENV_PASSPHRASE_WRONG]);
    await news.ack();
    expect((await readUnlockRecord(dir, ADDRESS))?.status).toBe('awaiting_confirmation');
    expect((await o.takeNews('s1')).lines).toEqual([]);
  });

  it('says unlocked after a repair, keeps saying it until acked, then not again', async () => {
    await markUnlockPending(dir, ADDRESS, NOW - 1000);
    const o = observer();
    o.observe(READY);
    const first = await o.takeNews('s1');
    expect(first.lines).toEqual([WALLET_UNLOCKED]);
    // No ack (the leg failed): still awaiting, and offered again.
    expect((await readUnlockRecord(dir, ADDRESS))?.status).toBe('awaiting_confirmation');
    const second = await o.takeNews('s1');
    expect(second.lines).toEqual([WALLET_UNLOCKED]);
    await second.ack();
    expect(await readUnlockRecord(dir, ADDRESS)).toMatchObject({ status: 'ready' });
    expect((await o.takeNews('s1')).lines).toEqual([]);
  });

  it('says unlocked once after an earlier block, after the ack', async () => {
    await writeUnlockRecord(dir, {
      version: 1,
      address: ADDRESS,
      status: 'blocked',
      reason: 'passphrase_missing',
      at: NOW - 1000,
    });
    const o = observer();
    o.observe(READY);
    const news = await o.takeNews('s1');
    expect(news.lines).toEqual([WALLET_UNLOCKED]);
    await news.ack();
    expect((await o.takeNews('s1')).lines).toEqual([]);
    // A new router for the next session: ready after ready is no news.
    const next = observer();
    next.observe(READY);
    expect((await next.takeNews('s2')).lines).toEqual([]);
  });

  it('says still locked, with the person fix, when a repair did not take', async () => {
    await markUnlockPending(dir, ADDRESS, NOW - 1000);
    const o = observer();
    o.observe(BLOCKED);
    const news = await o.takeNews('s1');
    expect(news.lines).toEqual([stillLockedSentence('passphrase_wrong')]);
    expect(news.lines[0]).toContain(REPAIR_CLAUSE);
    expect(news.lines[0]).not.toContain(WALLET_REASONS.passphrase_wrong.agentFix);
    await news.ack();
    expect(await readUnlockRecord(dir, ADDRESS)).toMatchObject({
      status: 'blocked',
      reason: 'passphrase_wrong',
    });
  });

  it('writes unlock-state with its inputs only after the ack, and every later change after that', async () => {
    const o = observer({ TENJIN_WALLET_PASSPHRASE: SECRET });
    o.observe(READY);
    const news = await o.takeNews('s1');
    expect(await readUnlockRecord(dir, ADDRESS)).toBeNull();
    await news.ack();
    const record = await readUnlockRecord(dir, ADDRESS);
    expect(record).toMatchObject({
      status: 'ready',
      inputs: { envPassphraseSet: true, envKeySet: false, cliVersion: '9.9.9' },
    });
    expect(record?.inputs?.walletMtimeMs).toEqual(expect.any(Number));
    o.observe(BLOCKED);
    await vi.waitFor(async () =>
      expect((await readUnlockRecord(dir, ADDRESS))?.status).toBe('blocked'),
    );
  });
});

describe('the observation file', () => {
  it('is 0600, carries no secret or env value, and is removed by dispose', async () => {
    const o = observer({
      TENJIN_WALLET_PASSPHRASE: SECRET,
      TENJIN_WALLET_KEY: `0x${'ab'.repeat(32)}`,
    });
    o.observe(BLOCKED);
    await o.takeNews('s1');
    const obs = await observed();
    expect(obs.env).toEqual({ passphraseSet: true, keySet: true });
    const path = join(liveDir(dir), `${process.pid}.json`);
    const text = await readFile(path, 'utf8');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('ab'.repeat(32));
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    o.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readdir(liveDir(dir))).toEqual([]);
  });

  it('gives the payer the wallet and sidecar stamp', async () => {
    const o = observer();
    expect(await o.unlockStamp()).toBe(unlockStamp(await readWalletFacts(dir, {})));
    expect(await o.unlockStamp()).toMatch(/:null$/);
  });
});
