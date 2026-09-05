import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Emit } from '../adapters/types';
import { record, type FireRecord } from './ledger';
import { openLoopDb, type LoopDb } from './store';
import type { Actor, LegRow, Outcome } from './types';

const dirs: string[] = [];
const open: LoopDb[] = [];

async function freshDb(): Promise<LoopDb> {
  const dir = await mkdtemp(join(tmpdir(), 'tenjin-b-ledger-'));
  dirs.push(dir);
  const db = openLoopDb(dir);
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

const ACTOR: Actor = { session: 's1', agent: 'a7c31e9f' };

const OUTCOME: Outcome = { reason: 'hit', delivery: { mode: 'inject', resourceId: 'r1' } };

const LEG: LegRow = {
  stage: 0,
  shelf: 'team',
  status: 'ok',
  outcome: 'hit',
  elapsed_ms: 12,
  search_id: 'srch1',
  title: 'ryuk serializes testcontainers',
  url: 'https://tenjin.blog/p/1',
  form: 'digest',
  calibration: 'hybrid-v1',
};

const EMIT: Emit = { context: 'found it' };

function fullRecord(overrides: Partial<FireRecord> = {}): FireRecord {
  return {
    id: 'f1',
    at: 1_700_000_000_000,
    actor: ACTOR,
    arm: 'lead',
    harness: 'claude',
    event: 'UserPromptSubmit',
    promptId: 'p1',
    cwd: '/repo',
    wait: 'human',
    deadlineMs: 2500,
    elapsedMs: 37,
    outcome: OUTCOME,
    questionKey: 'qk1',
    question: 'how does ryuk serialize testcontainers',
    emit: EMIT,
    legs: [LEG],
    ...overrides,
  };
}

function fireRow(db: LoopDb, id = 'f1'): Record<string, unknown> {
  return db.prepare('SELECT * FROM fires WHERE id = ?').get(id) as Record<string, unknown>;
}

function legRows(db: LoopDb, id = 'f1'): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM legs WHERE fire_id = ? ORDER BY stage, shelf').all(id) as Array<
    Record<string, unknown>
  >;
}

describe('record', () => {
  it('writes every fires column for a full FireRecord, plus its legs', async () => {
    const db = await freshDb();
    const log = vi.fn();
    expect(record(db, log, fullRecord())).toBe(true);

    expect(fireRow(db)).toMatchObject({
      id: 'f1',
      at: 1_700_000_000_000,
      session: 's1',
      agent: 'a7c31e9f',
      arm: 'lead',
      harness: 'claude',
      event: 'UserPromptSubmit',
      prompt_id: 'p1',
      cwd: '/repo',
      wait: 'human',
      deadline_ms: 2500,
      elapsed_ms: 37,
      reason: 'hit',
      question_key: 'qk1',
      question: 'how does ryuk serialize testcontainers',
      delivered: 'inject:r1',
      emit: JSON.stringify(EMIT),
    });

    expect(legRows(db)).toEqual([
      {
        fire_id: 'f1',
        stage: 0,
        shelf: 'team',
        status: 'ok',
        outcome: 'hit',
        elapsed_ms: 12,
        search_id: 'srch1',
        title: 'ryuk serializes testcontainers',
        url: 'https://tenjin.blog/p/1',
        form: 'digest',
        calibration: 'hybrid-v1',
        graded: null,
        posted_at: null,
      },
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it('round-trips legs.calibration, and leaves it NULL when the leg had none', async () => {
    // `lexical-v1` is the shelf saying the meaning step never ran; without the
    // column a spent embedding budget looks exactly like an empty shelf.
    const db = await freshDb();
    const lexical: LegRow = { ...LEG, shelf: 'public', calibration: 'lexical-v1' };
    const none: LegRow = { ...LEG, shelf: 'keys' };
    delete none.calibration;
    expect(record(db, vi.fn(), fullRecord({ legs: [LEG, lexical, none] }))).toBe(true);

    expect(legRows(db).map((r) => [r.shelf, r.calibration])).toEqual([
      ['keys', null],
      ['public', 'lexical-v1'],
      ['team', 'hybrid-v1'],
    ]);
  });

  it('stamps "log:<id>" for a log-mode delivery', async () => {
    const db = await freshDb();
    record(
      db,
      vi.fn(),
      fullRecord({ outcome: { reason: 'hit', delivery: { mode: 'log', resourceId: 'r2' } } }),
    );
    expect(fireRow(db).delivered).toBe('log:r2');
  });

  it('writes NULL emit for a null Emit', async () => {
    const db = await freshDb();
    record(db, vi.fn(), fullRecord({ emit: null }));
    expect(fireRow(db).emit).toBeNull();
  });

  it('writes outcome.detail to its OWN column, beside whatever question it had', async () => {
    const db = await freshDb();
    record(
      db,
      vi.fn(),
      fullRecord({
        question: 'the question this fire had got as far as',
        outcome: { reason: 'error', detail: 'TypeError: boom' },
      }),
    );
    // An error past `plan` has both, and neither may evict the other: the
    // question is what was asked, `error` is what threw.
    expect(fireRow(db).question).toBe('the question this fire had got as far as');
    expect(fireRow(db).error).toBe('TypeError: boom');
  });

  it('leaves question and error NULL when the fire had neither', async () => {
    const db = await freshDb();
    record(db, vi.fn(), fullRecord({ question: undefined, outcome: { reason: 'no-question' } }));
    expect(fireRow(db).question).toBeNull();
    expect(fireRow(db).error).toBeNull();
  });

  it('does not throw on duplicate legs (same stage+shelf): ON CONFLICT DO NOTHING', async () => {
    const db = await freshDb();
    // Same (stage, shelf) as LEG but with different data: the second copy must
    // be silently dropped, not upserted, per ON CONFLICT DO NOTHING.
    const dup: LegRow = { ...LEG, elapsed_ms: 999, title: 'a later duplicate' };
    expect(record(db, vi.fn(), fullRecord({ legs: [LEG, dup] }))).toBe(true);

    const rows = legRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ elapsed_ms: 12, title: 'ryuk serializes testcontainers' });
  });

  it('a second record with the same fire id returns false, logs, writes nothing new, and does not throw', async () => {
    const db = await freshDb();
    const log = vi.fn();
    expect(record(db, log, fullRecord())).toBe(true);

    // A different leg on the second attempt, to show the whole transaction
    // (fires insert plus legs inserts) rolls back together on the id clash.
    const second = fullRecord({ legs: [{ ...LEG, shelf: 'public', title: 'a different leg' }] });
    expect(() => record(db, log, second)).not.toThrow();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('f1'));
    expect(db.prepare('SELECT count(*) AS n FROM fires').get()).toEqual({ n: 1 });
    expect(legRows(db)).toHaveLength(1);
  });

  it('a closed db returns false without throwing', async () => {
    const db = await freshDb();
    db.close();
    const log = vi.fn();
    expect(() => record(db, log, fullRecord())).not.toThrow();
    expect(record(db, log, fullRecord())).toBe(false);
    expect(log).toHaveBeenCalled();
  });
});
