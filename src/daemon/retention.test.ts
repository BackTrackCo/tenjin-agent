import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  FIRES_ROW_CAP,
  RETENTION_BATCH,
  RETENTION_DAYS,
  RETENTION_MAX_MS,
} from '../hooks/constants';
import { openLoopDb, type LoopDb } from '../hooks/store';
import { loopDbPath } from '../lib/paths';
import { runRetention } from './retention';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 3, 12);
const CUTOFF = NOW - RETENTION_DAYS * DAY_MS;
const OLD = CUTOFF - DAY_MS;
const FRESH = CUTOFF + DAY_MS;

let dir: string;
let db: LoopDb;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-b-retention-'));
  db = openLoopDb(dir);
});
afterEach(async () => {
  try {
    db.close();
  } catch {
    // Already closed by the test.
  }
  await rm(dir, { recursive: true, force: true });
});

function count(table: string, where = ''): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: unknown };
  return Number(row.n);
}

function ids(table: string): string[] {
  const col = table === 'legs' ? 'fire_id' : table === 'fires' ? 'id' : 'session';
  return (db.prepare(`SELECT ${col} AS v FROM ${table} ORDER BY v`).all() as { v: string }[]).map(
    (r) => r.v,
  );
}

function fireStmt() {
  return db.prepare(
    `INSERT INTO fires (id, at, session, agent, arm, harness, event, wait, deadline_ms, elapsed_ms, reason)
     VALUES (?, ?, 's', '', 'prompt', 'claude', 'UserPromptSubmit', 'human', 2500, 1, 'no-question')`,
  );
}

function seedFires(rows: Array<[id: string, at: number]>): void {
  const stmt = fireStmt();
  for (const [id, at] of rows) stmt.run(id, at);
}

function seedLeg(fireId: string): void {
  db.prepare(
    `INSERT INTO legs (fire_id, stage, shelf, status, elapsed_ms) VALUES (?, 1, 'team', 'hit', 5)`,
  ).run(fireId);
}

function seedMark(session: string, at: number): void {
  db.prepare(`INSERT INTO marks (session, agent, key, value, at) VALUES (?, '', 'k', 'v', ?)`).run(
    session,
    at,
  );
}

describe('runRetention: fires by age', () => {
  it('deletes fires older than RETENTION_DAYS with their legs, keeps the rest', () => {
    seedFires([
      ['old', OLD],
      ['edge-old', CUTOFF - 1],
      ['edge-keep', CUTOFF],
      ['fresh', FRESH],
    ]);
    for (const id of ['old', 'edge-old', 'edge-keep', 'fresh']) seedLeg(id);

    const report = runRetention(db, NOW);

    expect(report).toEqual({ fires: 2, marks: 0, truncated: false });
    expect(ids('fires')).toEqual(['edge-keep', 'fresh']);
    // Cascade: the legs of a deleted fire go with it, no orphan rows.
    expect(ids('legs')).toEqual(['edge-keep', 'fresh']);
  });

  it('removes more than RETENTION_BATCH old rows by looping batches', () => {
    const oldCount = RETENTION_BATCH * 2 + 201;
    const rows: Array<[string, number]> = [];
    for (let i = 0; i < oldCount; i++) rows.push([`old-${i}`, OLD - i]);
    for (let i = 0; i < 3; i++) rows.push([`fresh-${i}`, FRESH + i]);
    db.exec('BEGIN');
    seedFires(rows);
    db.exec('COMMIT');

    const report = runRetention(db, NOW);

    expect(report.fires).toBe(oldCount);
    expect(report.truncated).toBe(false);
    expect(count('fires')).toBe(3);
    expect(count('fires', `WHERE at < ${CUTOFF}`)).toBe(0);
  });

  it('returns zeros on an empty ledger', () => {
    expect(runRetention(db, NOW)).toEqual({ fires: 0, marks: 0, truncated: false });
  });
});

describe('runRetention: fires row cap', () => {
  it('trims the OLDEST rows past FIRES_ROW_CAP even when every row is recent', () => {
    const excess = 700;
    const total = FIRES_ROW_CAP + excess;
    // One transaction, or 50k autocommits fsync the test into the timeout.
    db.exec('BEGIN');
    const stmt = fireStmt();
    // Row i is i ms old, so the highest indices are the oldest.
    for (let i = 0; i < total; i++) stmt.run(`f-${i}`, NOW - i);
    db.exec('COMMIT');
    expect(count('fires')).toBe(total);

    const report = runRetention(db, NOW);

    expect(report).toEqual({ fires: excess, marks: 0, truncated: false });
    expect(count('fires')).toBe(FIRES_ROW_CAP);
    const min = db.prepare('SELECT MIN(at) AS v FROM fires').get() as { v: unknown };
    expect(Number(min.v)).toBe(NOW - (FIRES_ROW_CAP - 1));
    expect(count('fires', `WHERE id = 'f-${FIRES_ROW_CAP}'`)).toBe(0);
    expect(count('fires', `WHERE id = 'f-${FIRES_ROW_CAP - 1}'`)).toBe(1);
  });
});

describe('runRetention: marks', () => {
  it('deletes marks older than the cutoff, keeps newer ones', () => {
    seedMark('m-old', OLD);
    seedMark('m-edge', CUTOFF);
    seedMark('m-fresh', FRESH);
    seedFires([
      ['old', OLD],
      ['fresh', FRESH],
    ]);

    const report = runRetention(db, NOW);

    expect(report).toEqual({ fires: 1, marks: 1, truncated: false });
    expect(ids('marks')).toEqual(['m-edge', 'm-fresh']);
  });
});

describe('runRetention: time bound', () => {
  it('stops after the first batch once the clock passes RETENTION_MAX_MS', () => {
    const oldCount = RETENTION_BATCH * 2 + 200;
    const rows: Array<[string, number]> = [];
    for (let i = 0; i < oldCount; i++) rows.push([`old-${i}`, OLD - i]);
    db.exec('BEGIN');
    seedFires(rows);
    db.exec('COMMIT');
    seedMark('m-old', OLD);

    // Reads 0 at start and at the check before the first batch, then jumps
    // past the bound: the second check must refuse to run another batch.
    let reads = 0;
    const clock = () => (++reads <= 2 ? 0 : RETENTION_MAX_MS + 1);

    const report = runRetention(db, NOW, clock);

    expect(report.truncated).toBe(true);
    expect(report.fires).toBe(RETENTION_BATCH);
    expect(count('fires')).toBe(oldCount - RETENTION_BATCH);
    // The marks phase never ran: its rows and its count are untouched.
    expect(report.marks).toBe(0);
    expect(count('marks')).toBe(1);
  });

  it('finishes with truncated:false when the clock stays under the bound', () => {
    seedFires([['old', OLD]]);
    let t = 0;
    const clock = () => (t += 100);
    expect(runRetention(db, NOW, clock)).toEqual({ fires: 1, marks: 0, truncated: false });
  });
});

describe('runRetention: housekeeping', () => {
  it('never throws when a concurrent reader blocks the checkpoint', () => {
    db.close();
    // busy_timeout 0 so the blocked TRUNCATE checkpoint reports busy at once
    // instead of waiting out the daemon's 2 s.
    db = openLoopDb(dir, { busyTimeoutMs: 0 });
    seedFires([
      ['old', OLD],
      ['fresh', FRESH],
    ]);
    const reader = new DatabaseSync(loopDbPath(dir));
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM fires').get();
    try {
      expect(runRetention(db, NOW)).toEqual({ fires: 1, marks: 0, truncated: false });
      expect(count('fires')).toBe(1);
    } finally {
      reader.exec('COMMIT');
      reader.close();
    }
  });
});
