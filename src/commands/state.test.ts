import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStateQuery } from './state';
import { openStore, STORE_SQL } from '../lib/state-store';
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
  it('returns rows as data and as a JSON humanLine', async () => {
    const store = await openStore(dir);
    if (store === null) throw new Error('no store');
    store.run(STORE_SQL.setState, ['', 'foo', 'bar', 1000]);
    store.close();

    const result = await runStateQuery(
      { sql: "SELECT key, value FROM session_state WHERE key = 'foo'" },
      makeCtx(),
    );
    expect(result.data).toMatchObject({ rows: [{ key: 'foo', value: 'bar' }] });
    expect(JSON.parse(result.humanLines![0]!)).toEqual([{ key: 'foo', value: 'bar' }]);
  });

  it('rejects a non-SELECT statement', async () => {
    await expect(
      runStateQuery({ sql: 'DELETE FROM session_state' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});
