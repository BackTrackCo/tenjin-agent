import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withFileLock, LockTimeoutError } from './lock';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-lock-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('withFileLock', () => {
  it('serializes overlapping critical sections (no interleave)', async () => {
    const lock = join(dir, 'a.lock');
    const events: string[] = [];
    const section = (id: string) =>
      withFileLock(lock, async () => {
        events.push(`${id}:start`);
        await delay(30);
        events.push(`${id}:end`);
      });
    await Promise.all([section('x'), section('y')]);
    // Serialized: one holder's start+end fully precede the other's — never
    // interleaved (which would be x:start,y:start,...). Order between them is free.
    expect([
      ['x:start', 'x:end', 'y:start', 'y:end'],
      ['y:start', 'y:end', 'x:start', 'x:end'],
    ]).toContainEqual(events);
  });

  it('N concurrent critical sections all land their update, no leftover lock dir', async () => {
    // Regression for the stale-steal lost-update bug: without a sound mutex, N
    // read-modify-writes read the same base and the last writer drops the rest.
    // Every section must land, and the last holder's finally must leave no dir.
    const lock = join(dir, 'multi.lock');
    const target = join(dir, 'state.json');
    await writeFile(target, '{}');
    const bump = (key: string) =>
      withFileLock(lock, async () => {
        const obj = JSON.parse(await readFile(target, 'utf8')) as Record<string, boolean>;
        await delay(5); // widen the read-modify-write window a lost update would exploit
        obj[key] = true;
        await writeFile(target, JSON.stringify(obj));
      });
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(bump));
    const final = JSON.parse(await readFile(target, 'utf8')) as Record<string, boolean>;
    expect(Object.keys(final).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    await expect(stat(lock)).rejects.toThrow(); // released, nothing leftover
  });

  it('times out with an actionable error when a live lock is never released', async () => {
    const lock = join(dir, 'live.lock');
    await mkdir(lock);
    await writeFile(
      join(lock, 'meta'),
      JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
    );
    const err = await withFileLock(lock, async () => 'unreached', {
      timeoutMs: 60,
      retryMs: 10,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as LockTimeoutError).lockPath).toBe(lock);
    expect((err as Error).message).toContain(lock);
    expect((err as Error).message).toMatch(/remove that directory/);
  });
});

// Opt-in only: a wrongly-stolen lock costs a redundant pass where the protected
// work is idempotent (the skills self-heal) and could lose data where it is not
// (the spend ledger), which is why nothing gets this behavior by default.
describe('withFileLock: staleMs recovery', () => {
  it('steals and re-acquires a lock older than staleMs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenjin-lock-stale-'));
    try {
      const lock = join(dir, 'x.lock');
      await mkdir(lock, { recursive: true });
      const hourAgo = Date.now() / 1000 - 3600;
      utimesSync(lock, hourAgo, hourAgo);

      const ran = await withFileLock(lock, async () => 'did the work', {
        staleMs: 60_000,
        timeoutMs: 300,
      });

      expect(ran).toBe('did the work');
      expect(existsSync(lock)).toBe(false); // released again
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves a FRESH lock alone and times out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenjin-lock-fresh-'));
    try {
      const lock = join(dir, 'x.lock');
      await mkdir(lock, { recursive: true });
      await expect(
        withFileLock(lock, async () => 'nope', { staleMs: 60_000, timeoutMs: 150 }),
      ).rejects.toBeInstanceOf(LockTimeoutError);
      expect(existsSync(lock)).toBe(true); // the holder's lock survives
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('without staleMs, an ancient lock still blocks (the default is unchanged)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tenjin-lock-default-'));
    try {
      const lock = join(dir, 'x.lock');
      await mkdir(lock, { recursive: true });
      const hourAgo = Date.now() / 1000 - 3600;
      utimesSync(lock, hourAgo, hourAgo);
      await expect(
        withFileLock(lock, async () => 'nope', { timeoutMs: 150 }),
      ).rejects.toBeInstanceOf(LockTimeoutError);
      expect(existsSync(lock)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
