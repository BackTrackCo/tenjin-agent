import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSelectOnly, runStateQuery } from './state';
import { setFact } from '../hooks/facts';
import { openLoopDb } from '../hooks/store';
import type { CommandContext } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-state-cmd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

describe('runStateQuery', () => {
  it('returns rows of loop.db as data and as a JSON humanLine', async () => {
    const db = openLoopDb(dir);
    setFact(db, 'published:abc', 'https://tenjin.blog/p/x', 1000);
    db.close();

    const result = await runStateQuery(
      { sql: "SELECT key, value FROM facts WHERE key = 'published:abc'" },
      makeCtx(),
    );
    expect(result.data).toMatchObject({
      rows: [{ key: 'published:abc', value: 'https://tenjin.blog/p/x' }],
    });
    expect(JSON.parse(result.humanLines![0]!)).toEqual([
      { key: 'published:abc', value: 'https://tenjin.blog/p/x' },
    ]);
  });

  it('rejects a non-SELECT statement', async () => {
    await expect(runStateQuery({ sql: 'DELETE FROM facts' }, makeCtx())).rejects.toMatchObject({
      code: 'USAGE',
    });
  });

  /** READ-ONLY BY CONTRACT: the statement is refused before the file is opened,
   *  so a data dir with no `loop.db` in it still answers USAGE rather than
   *  creating one. */
  it('refuses a write before it can create the database', async () => {
    await expect(
      runStateQuery({ sql: 'CREATE TABLE t (a INTEGER)' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(runStateQuery({ sql: 'SELECT 1 AS one' }, makeCtx())).rejects.toMatchObject({
      code: 'STATE_QUERY_FAILED',
    });
  });

  it('reports a bad table name as a query failure, not an internal error', async () => {
    openLoopDb(dir).close();
    await expect(
      runStateQuery({ sql: 'SELECT * FROM no_such_table' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'STATE_QUERY_FAILED' });
  });
});

describe('assertSelectOnly: literals, comments, and WITH-prefixed writes', () => {
  it('allows a `;` inside a string literal', () => {
    expect(assertSelectOnly("SELECT * FROM t WHERE msg = 'a;b'")).toBe(
      "SELECT * FROM t WHERE msg = 'a;b'",
    );
  });

  it('still rejects a real second statement after a literal', () => {
    expect(() => assertSelectOnly("SELECT * FROM t WHERE msg = 'a;b'; DROP TABLE t")).toThrow(
      /one statement/i,
    );
  });

  it('allows a leading line comment and a leading block comment', () => {
    expect(assertSelectOnly('-- note\nSELECT 1')).toBe('-- note\nSELECT 1');
    expect(assertSelectOnly('/* note */ SELECT 1')).toBe('/* note */ SELECT 1');
  });

  it('rejects a WITH clause that leads into a write', () => {
    expect(() => assertSelectOnly('WITH x AS (SELECT 1) DELETE FROM facts')).toThrow(/read-only/i);
    expect(() =>
      assertSelectOnly("WITH x AS (SELECT 1) INSERT INTO facts VALUES ('k', 'v', 0)"),
    ).toThrow(/read-only/i);
  });

  it('does not read a write keyword out of a string literal or a column name', () => {
    expect(assertSelectOnly("SELECT * FROM fires WHERE reason = 'insert failed'")).toBe(
      "SELECT * FROM fires WHERE reason = 'insert failed'",
    );
    expect(assertSelectOnly('SELECT closed_at FROM pairings')).toBe(
      'SELECT closed_at FROM pairings',
    );
  });

  it('rejects PRAGMA, and an empty statement', () => {
    expect(() => assertSelectOnly('PRAGMA journal_mode')).toThrow(/SELECT/i);
    expect(() => assertSelectOnly('   ')).toThrow(/required/i);
  });

  /** An unterminated `[` is one stray character, not a quoted identifier: masking
   *  it to end-of-input would blank the `;` this check exists to find. */
  it('keeps a `;` visible after an unmatched bracket, and allows a real one', () => {
    expect(() => assertSelectOnly('SELECT 1 [ ; DROP TABLE fires')).toThrow(/one statement/i);
    expect(assertSelectOnly('SELECT [my col] FROM pairings')).toBe('SELECT [my col] FROM pairings');
  });
});
