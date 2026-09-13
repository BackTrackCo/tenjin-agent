import { it, expect, vi } from 'vitest';
import process from 'node:process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTestDb, startBlankDb, stopTestDb } from './_support/db';
import { startTestDb as aliasStart } from '@/tests/integration/_support/db';

// Mounted as a focused source test only by a credential-free container proof.
// The adapter redirects both relative and @ imports without changing source.
it('separate checkouts and subsequent runs cannot borrow another database', async () => {
  const first = await startTestDb();
  const second = await aliasStart();
  try {
    expect(first.url).not.toBe(second.url);
    for (const db of [first, second]) {
      await db.pool.query('CREATE TABLE benchmark_support_sentinel(value integer)');
    }
    await first.pool.query('INSERT INTO benchmark_support_sentinel VALUES(7)');
    expect((await second.pool.query('SELECT * FROM benchmark_support_sentinel')).rows).toEqual([]);
  } finally {
    await stopTestDb(first);
    await stopTestDb(second);
  }
  const third = await startTestDb();
  try {
    expect(
      (await third.pool.query("SELECT to_regclass('benchmark_support_sentinel') AS table_name"))
        .rows[0].table_name,
    ).toBeNull();
  } finally {
    await stopTestDb(third);
  }
});

it('blank checkout does not apply migrations before its caller requests them', async () => {
  const db = await startBlankDb();
  try {
    expect(
      (await db.pool.query("SELECT to_regclass('posts') AS table_name")).rows[0].table_name,
    ).toBeNull();
  } finally {
    await stopTestDb(db);
  }
});

it('failed migrations surface and leave no partially created database', async () => {
  const cwd = process.cwd();
  const empty = mkdtempSync(path.join(tmpdir(), 'benchmark-migration-failure-'));
  try {
    process.chdir(empty);
    await expect(startTestDb()).rejects.toThrow();
  } finally {
    process.chdir(cwd);
    rmSync(empty, { recursive: true, force: true });
  }
  const db = await startBlankDb();
  try {
    const result = await db.pool.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [
      `t_${process.pid}_%`,
    ]);
    expect(result.rows).toEqual([]);
  } finally {
    await stopTestDb(db);
  }
});

it('missing database cannot silently turn integration tests into skipped tests', async () => {
  const previous = process.env.BENCHMARK_DATABASE_URL;
  try {
    delete process.env.BENCHMARK_DATABASE_URL;
    vi.resetModules();
    await expect(import('./_support/db')).rejects.toThrow('integration tests cannot be skipped');
  } finally {
    if (previous === undefined) delete process.env.BENCHMARK_DATABASE_URL;
    else process.env.BENCHMARK_DATABASE_URL = previous;
  }
});
