import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loopDbPath } from './paths';
import { openLoopDbForCli, withLoopDb } from './loop-db';
import { LOOP_DDL, openLoopDb } from '../hooks/store';

const dirs: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tenjin-loop-db-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A `loop.db` whose `handoff` is a different build's shape — the case
 *  `openLoopDb` answers by deleting the file. */
function writeForeignBuild(dir: string): void {
  const db = new DatabaseSync(loopDbPath(dir));
  db.exec(LOOP_DDL.replace('  question  TEXT NOT NULL,\n', ''));
  db.prepare(`INSERT INTO handoff (session, at) VALUES ('s', 1)`).run();
  db.close();
}

describe('openLoopDbForCli', () => {
  /**
   * The reason the flag exists. Two worktrees on one laptop means a CLI of one
   * build meets a daemon of another, and the daemon's answer to a shape it does
   * not know — delete the file — would take the running daemon's whole ledger
   * with it. The CLI says so instead, and the rows are untouched.
   */
  it('refuses a loop.db from another build, and leaves its rows alone', async () => {
    const dir = await freshDir();
    writeForeignBuild(dir);

    expect(() => openLoopDbForCli(dir)).toThrow(/another build/);
    try {
      openLoopDbForCli(dir);
    } catch (err) {
      expect(err).toMatchObject({ code: 'INTERNAL', exitCode: 1 });
      expect((err as Error).message).toContain('tenjin daemon stop');
    }

    // The ledger the other build is writing is still there, in its own shape.
    const foreign = new DatabaseSync(loopDbPath(dir));
    try {
      expect(foreign.prepare('SELECT count(*) AS n FROM handoff').get()).toEqual({ n: 1 });
      const columns = foreign.prepare('PRAGMA table_info(handoff)').all() as Array<{
        name: string;
      }>;
      expect(columns.map((c) => c.name)).not.toContain('question');
    } finally {
      foreign.close();
    }
  });

  it('opens a loop.db of the current shape, rows and all', async () => {
    const dir = await freshDir();
    const daemon = openLoopDb(dir);
    daemon.prepare(`INSERT INTO facts (key, value, at) VALUES ('k', 'v', 1)`).run();
    daemon.close();

    const db = openLoopDbForCli(dir);
    try {
      expect(db.prepare('SELECT value FROM facts WHERE key = ?').get('k')).toMatchObject({
        value: 'v',
      });
    } finally {
      db.close();
    }
  });

  it('creates the file when nothing has opened it yet', async () => {
    const dir = await freshDir();
    const db = openLoopDbForCli(dir);
    try {
      expect(db.prepare('SELECT count(*) AS n FROM searches').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  // The rebuild is the daemon's job, and it keeps it: the same file the CLI
  // refused is replaced by the process that owns the ledger.
  it('leaves the daemon rebuilding a mismatched file', async () => {
    const dir = await freshDir();
    writeForeignBuild(dir);
    const db = openLoopDb(dir);
    try {
      expect(db.prepare('SELECT count(*) AS n FROM handoff').get()).toEqual({ n: 0 });
      const columns = db.prepare('PRAGMA table_info(handoff)').all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain('question');
    } finally {
      db.close();
    }
  });

  it('reports a file that is not a database as a CliError', async () => {
    const dir = await freshDir();
    await writeFile(loopDbPath(dir), 'not a database');
    expect(() => openLoopDbForCli(dir)).toThrow();
    try {
      openLoopDbForCli(dir);
    } catch (err) {
      expect(err).toMatchObject({ code: 'INTERNAL' });
    }
  });
});

describe('withLoopDb', () => {
  it('runs the statements and hands back what they answered', async () => {
    const dir = await freshDir();
    withLoopDb(dir, (db) => {
      db.prepare(`INSERT INTO facts (key, value, at) VALUES ('k', 'v', 1)`).run();
    });
    expect(withLoopDb(dir, (db) => db.prepare('SELECT value FROM facts').get())).toMatchObject({
      value: 'v',
    });
  });

  // The close is in a `finally` for this: a command that threw mid-way must not
  // leave the file locked for the next one.
  it('closes the handle even when the body throws, and the error propagates', async () => {
    const dir = await freshDir();
    expect(() =>
      withLoopDb(dir, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    // The next open writes, which a leaked handle under WAL would still allow —
    // so the proof is that nothing here is left holding a connection.
    withLoopDb(dir, (db) => {
      db.prepare(`INSERT INTO facts (key, value, at) VALUES ('k', 'v', 1)`).run();
    });
    expect(withLoopDb(dir, (db) => db.prepare('SELECT count(*) AS n FROM facts').get())).toEqual({
      n: 1,
    });
  });

  // Nothing swallows: a bad statement is the caller's to see, not a silent false.
  it('lets a SQLite error out', async () => {
    const dir = await freshDir();
    expect(() => withLoopDb(dir, (db) => db.prepare('SELECT * FROM nope').get())).toThrow();
  });
});
