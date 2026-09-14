import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSessionScores } from './commands/push';
import { openStore, STORE_SQL } from './lib/state-store';

// An independent behavioral oracle over synthetic store rows. No model or network.
const NOW = Date.UTC(2026, 0, 20, 12);
const START = NOW - 120_000;

async function patterns(actor: string | null, owner: string | null, sameSession = true) {
  const dir = await mkdtemp(join(tmpdir(), 'bench3-worker-'));
  try {
    const store = await openStore(dir);
    if (!store) throw new Error('SQLite unavailable');
    try {
      store.run(STORE_SQL.touchSession, [
        'conversation',
        'fixture',
        '/synthetic',
        START,
        'fixture',
      ]);
      for (const [index, hook] of ['failure', 'edit'].entries()) {
        store.run(STORE_SQL.insertEvent, [
          `event-${index}`,
          START + index * 10_000,
          'conversation',
          actor,
          'fixture',
          'fixture',
          hook,
          hook === 'edit' ? 'Edit' : 'Bash',
          null,
          JSON.stringify(['src/widget.ts']),
          JSON.stringify({ command: 'node test.mjs', head: 'node' }),
        ]);
      }
      const session = sameSession ? 'conversation' : 'unrelated-conversation';
      store.run(STORE_SQL.claimClose, [
        71,
        session,
        owner,
        START + 20_000,
        'node test.mjs',
        '["src/widget.ts"]',
        'code',
      ]);
      store.run(STORE_SQL.recordSearch, [
        'search-one',
        START + 5_000,
        session,
        owner,
        'synthetic question',
        'fingerprint',
        'CANDIDATES',
        '[]',
        'push-hook',
        null,
        null,
      ]);
    } finally {
      store.close();
    }
    const rows = await readSessionScores(dir, NOW);
    const row = rows.find((item) => item.session === 'conversation' && item.agent === actor);
    expect(row, 'the worker with event evidence must remain visible').toBeDefined();
    return row!.patterns;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('session scoring respects evidence ownership', () => {
  it.each([
    ['worker-x', 'worker-y'],
    ['worker-x', null],
    [null, 'worker-y'],
  ] as const)('does not credit %s for evidence owned by %s', async (worker, owner) => {
    const result = await patterns(worker, owner);
    expect(result).not.toContain('error-edit-resolved');
    expect(result).not.toContain('research-then-edit');
  });

  it.each(['worker-x', null])('credits matching evidence for %s', async (worker) => {
    const result = await patterns(worker, worker);
    expect(result).toContain('error-edit-resolved');
    expect(result).toContain('research-then-edit');
  });

  it('does not join the same worker name across conversations', async () => {
    const result = await patterns('worker-x', 'worker-x', false);
    expect(result).not.toContain('error-edit-resolved');
    expect(result).not.toContain('research-then-edit');
  });
});
