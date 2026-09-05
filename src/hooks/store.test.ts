import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loopDbPath } from '../lib/paths';
import { LOOP_DDL, openLoopDb, type LoopDb } from './store';

const dirs: string[] = [];
const open: LoopDb[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tenjin-b-store-'));
  dirs.push(dir);
  return dir;
}

function track(db: LoopDb): LoopDb {
  open.push(db);
  return db;
}

afterEach(async () => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function names(db: LoopDb, type: 'table' | 'index'): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'`)
      .all(type) as Array<{ name: string }>
  )
    .map((r) => r.name)
    .sort();
}

const FIRE = {
  id: 'f1',
  at: 1,
  session: 's',
  arm: 'lead',
  harness: 'claude',
  event: 'UserPromptSubmit',
  wait: 'human',
  deadline_ms: 2500,
  elapsed_ms: 3,
  reason: 'no-question',
};

function insertFire(db: LoopDb, id = FIRE.id): void {
  db.prepare(
    `INSERT INTO fires (id, at, session, arm, harness, event, wait, deadline_ms, elapsed_ms, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    FIRE.at,
    FIRE.session,
    FIRE.arm,
    FIRE.harness,
    FIRE.event,
    FIRE.wait,
    FIRE.deadline_ms,
    FIRE.elapsed_ms,
    FIRE.reason,
  );
}

describe('openLoopDb', () => {
  it('creates loop.db with its three tables and both fires indexes', async () => {
    // A nested, not-yet-existing dataDir: the daemon may be the first thing to
    // touch ~/.tenjin on a fresh machine.
    const dir = join(await freshDir(), 'nested', 'data');
    const db = track(openLoopDb(dir));
    expect(existsSync(loopDbPath(dir))).toBe(true);
    expect(names(db, 'table')).toEqual(['fires', 'legs', 'marks']);
    expect(names(db, 'index')).toEqual(['fires_actor', 'fires_at']);
  });

  it('sets wal, foreign_keys and incremental auto_vacuum', async () => {
    const db = track(openLoopDb(await freshDir()));
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 1 });
  });

  it('honours busyTimeoutMs and defaults it for the daemon', async () => {
    const dir = await freshDir();
    expect(track(openLoopDb(dir)).prepare('PRAGMA busy_timeout').get()).toEqual({
      timeout: 2000,
    });
    expect(
      track(openLoopDb(dir, { busyTimeoutMs: 250 }))
        .prepare('PRAGMA busy_timeout')
        .get(),
    ).toEqual({ timeout: 250 });
  });

  it('reopens an existing file without error and keeps its rows', async () => {
    const dir = await freshDir();
    const first = openLoopDb(dir);
    first.prepare(`INSERT INTO marks (session, key, value, at) VALUES ('s', 'k', 'v', 1)`).run();
    first.close();

    const again = track(openLoopDb(dir));
    // Every statement is IF NOT EXISTS, so the DDL is safe against a live file.
    expect(() => again.exec(LOOP_DDL)).not.toThrow();
    expect(again.prepare('SELECT value FROM marks').all()).toEqual([{ value: 'v' }]);
    expect(names(again, 'table')).toEqual(['fires', 'legs', 'marks']);
    expect(again.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  });

  it('deletes a fire’s legs with the fire', async () => {
    const db = track(openLoopDb(await freshDir()));
    insertFire(db, 'f1');
    insertFire(db, 'f2');
    const leg = db.prepare(
      `INSERT INTO legs (fire_id, stage, shelf, status, elapsed_ms) VALUES (?, ?, ?, 'ok', 1)`,
    );
    leg.run('f1', 0, 'team');
    leg.run('f1', 0, 'public');
    leg.run('f2', 0, 'team');

    db.prepare(`DELETE FROM fires WHERE id = 'f1'`).run();

    expect(db.prepare('SELECT fire_id FROM legs').all()).toEqual([{ fire_id: 'f2' }]);
    // The FK is enforced on insert too, not only on delete.
    expect(() => leg.run('missing', 0, 'team')).toThrow(/FOREIGN KEY/);
  });

  it('a second writer gives up after its busy_timeout instead of hanging', async () => {
    const dir = await freshDir();
    const daemon = track(openLoopDb(dir));
    const cli = track(openLoopDb(dir, { busyTimeoutMs: 50 }));

    daemon.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    expect(() => insertFire(cli)).toThrow(/database is locked/);
    const elapsed = performance.now() - started;
    daemon.exec('ROLLBACK');

    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2000);
    // And once the lock is gone the same connection writes fine.
    insertFire(cli);
    expect(daemon.prepare('SELECT count(*) AS n FROM fires').get()).toEqual({ n: 1 });
  });

  it("rebuilds a loop.db whose tables are a different build's shape", async () => {
    // PR B's `legs` had no `calibration`, and `CREATE TABLE IF NOT EXISTS` is
    // silent about a table that already exists in another shape: every leg
    // insert would then throw and ROLLBACK its whole fire, leaving a ledger that
    // looks alive while every real lookup vanishes. The no-migration rule says
    // delete the file, so this is where it is deleted.
    const dir = await freshDir();
    const old = track(new (await import('node:sqlite')).DatabaseSync(loopDbPath(dir)));
    old.exec(`CREATE TABLE fires (id TEXT PRIMARY KEY, reason TEXT);
              CREATE TABLE legs (fire_id TEXT, stage INTEGER, shelf TEXT);
              CREATE TABLE marks (session TEXT, agent TEXT, key TEXT, value TEXT, at INTEGER);`);
    old.prepare('INSERT INTO fires (id, reason) VALUES (?, ?)').run('stale', 'hit');
    old.close();

    const db = track(openLoopDb(dir));
    expect(names(db, 'table')).toEqual(['fires', 'legs', 'marks']);
    // The stale rows went with the file; a fire written now records in full.
    expect(db.prepare('SELECT count(*) AS n FROM fires').get()).toEqual({ n: 0 });
    insertFire(db);
    db.prepare(
      `INSERT INTO legs (fire_id, stage, shelf, status, elapsed_ms, calibration)
       VALUES (?, 0, 'team', 'ok', 12, 'hybrid-v1')`,
    ).run(FIRE.id);
    expect(db.prepare('SELECT count(*) AS n FROM legs').get()).toEqual({ n: 1 });
  });

  it('leaves a loop.db of the CURRENT shape alone, rows and all', async () => {
    const dir = await freshDir();
    const first = track(openLoopDb(dir));
    insertFire(first);
    first.close();
    const second = track(openLoopDb(dir));
    expect(second.prepare('SELECT count(*) AS n FROM fires').get()).toEqual({ n: 1 });
  });

  it.skipIf(process.platform === 'win32')('leaves the file 0600', async () => {
    const dir = await freshDir();
    track(openLoopDb(dir));
    expect(statSync(loopDbPath(dir)).mode & 0o777).toBe(0o600);
  });
});
