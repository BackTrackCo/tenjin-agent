import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WALLET_FUNDED, WALLET_UNLOCKED } from './wallet-reasons';
import { firstNoticeFor, noticeCleared, noticeFor, settleCurrent } from './notice-markers';

const NOW = 1_800_000_000_000;
const WEEK = 7 * 86_400_000;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notice-markers-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const notices = () => join(dir, 'router', 'notices');

describe('noticeFor', () => {
  it('tells once per (session, reason), quiet on a repeat, and tells a new reason', async () => {
    expect(await noticeFor(dir, 's1', 'wallet_low', NOW)).toBe('tell');
    expect(await noticeFor(dir, 's1', 'wallet_low', NOW + 1)).toBe('quiet');
    expect(await noticeFor(dir, 's1', 'passphrase_missing', NOW + 2)).toBe('tell');
    expect(await noticeFor(dir, 's1', 'passphrase_missing', NOW + 3)).toBe('quiet');
    // Another session is its own.
    expect(await noticeFor(dir, 's2', 'wallet_low', NOW + 4)).toBe('tell');
  });

  it('records the reason told last in .current, and no session id or reason names a file', async () => {
    await noticeFor(dir, 'sess-secretish', 'passphrase_wrong', NOW);
    const names = await readdir(notices());
    expect(names.join(' ')).not.toContain('sess-secretish');
    expect(names.join(' ')).not.toContain('passphrase_wrong');
    const current = names.find((n) => n.endsWith('.current'));
    expect(current).toBeDefined();
    expect(await readFile(join(notices(), current!), 'utf8')).toBe(`${NOW}\npassphrase_wrong`);
  });
});

describe('noticeCleared', () => {
  it('says funded after wallet_low, once', async () => {
    await noticeFor(dir, 's', 'wallet_low', NOW);
    expect(await noticeCleared(dir, 's', NOW + 1)).toBe(WALLET_FUNDED);
    expect(await noticeCleared(dir, 's', NOW + 2)).toBeNull();
  });

  it('says unlocked after passphrase_missing, exactly once when two callers race', async () => {
    await noticeFor(dir, 's', 'passphrase_missing', NOW);
    const answers = await Promise.all([
      noticeCleared(dir, 's', NOW + 1),
      noticeCleared(dir, 's', NOW + 1),
      noticeCleared(dir, 's', NOW + 1),
    ]);
    expect(answers.filter((a) => a === WALLET_UNLOCKED)).toHaveLength(1);
    expect(answers.filter((a) => a === null)).toHaveLength(2);
  });

  it('tells a relapse again after it cleared', async () => {
    await noticeFor(dir, 's', 'passphrase_wrong', NOW);
    expect(await noticeCleared(dir, 's', NOW + 1)).toBe(WALLET_UNLOCKED);
    expect(await noticeFor(dir, 's', 'passphrase_wrong', NOW + 2)).toBe('tell');
  });

  it('gives null for a non-wallet reason and for a session told nothing', async () => {
    expect(await noticeCleared(dir, 'never', NOW)).toBeNull();
    await noticeFor(dir, 's', 'no_payer', NOW);
    expect(await noticeCleared(dir, 's', NOW + 1)).toBeNull();
    // The non-wallet marker stays: it is still quiet.
    expect(await noticeFor(dir, 's', 'no_payer', NOW + 2)).toBe('quiet');
  });
});

describe('settleCurrent', () => {
  it('marks the session cleared and lets every unlock reason be told again', async () => {
    await noticeFor(dir, 's', 'passphrase_missing', NOW);
    await noticeFor(dir, 's', 'keychain_locked', NOW);
    await settleCurrent(dir, 's', NOW + 1);
    // Already said by the router's wallet news: no second clear line.
    expect(await noticeCleared(dir, 's', NOW + 2)).toBeNull();
    expect(await noticeFor(dir, 's', 'passphrase_missing', NOW + 3)).toBe('tell');
    expect(await noticeFor(dir, 's', 'keychain_locked', NOW + 3)).toBe('tell');
  });

  it('leaves wallet_low alone', async () => {
    await noticeFor(dir, 's', 'wallet_low', NOW);
    await settleCurrent(dir, 's', NOW + 1);
    expect(await noticeFor(dir, 's', 'wallet_low', NOW + 2)).toBe('quiet');
  });
});

describe('pruning', () => {
  it('removes old-format and new files older than a week and keeps fresh ones, .current included', async () => {
    await noticeFor(dir, 'old', 'wallet_low', NOW - WEEK - 1);
    await firstNoticeFor(dir, 'old-format', NOW - WEEK - 1);
    await noticeFor(dir, 'fresh', 'wallet_low', NOW - 1000);
    await firstNoticeFor(dir, 'fresh-format', NOW - 1000);
    await writeFile(join(notices(), 'garbage'), 'not a time');
    const before = await readdir(notices());
    expect(before).toHaveLength(7);

    // A create prunes on the way past.
    await noticeFor(dir, 'trigger', 'wallet_low', NOW);
    const after = await readdir(notices());
    // fresh (marker + .current), fresh-format, trigger (marker + .current).
    expect(after).toHaveLength(5);
    expect(after.filter((n) => n.endsWith('.current'))).toHaveLength(2);
    expect(after).not.toContain('garbage');
    expect(await noticeFor(dir, 'fresh', 'wallet_low', NOW)).toBe('quiet');
    expect(await noticeFor(dir, 'old', 'wallet_low', NOW)).toBe('tell');
  });
});

describe('firstNoticeFor', () => {
  it('is true once per session, as before', async () => {
    expect(await firstNoticeFor(dir, 's', NOW)).toBe(true);
    expect(await firstNoticeFor(dir, 's', NOW + 1)).toBe(false);
    expect(await firstNoticeFor(dir, 't', NOW + 2)).toBe(true);
  });
});
