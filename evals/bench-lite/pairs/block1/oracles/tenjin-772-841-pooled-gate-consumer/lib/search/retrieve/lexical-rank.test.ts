// Pin probe caching and request-time fallback without requiring lakebase_bm25.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Column, getTableName, is, Table } from 'drizzle-orm';
import type { DB } from '@/lib/db';
import { captureLogs } from '@/tests/helpers/log-capture';
import { must } from '@/tests/integration/_support/assert';
import {
  BM25_INDEX,
  __resetLexicalRankerForTest,
  type LexicalRanking,
  resolveLexicalRanker,
  runLexicalLeg,
} from './lexical-rank';

/** One queued result or error per database execute call. */
const ROWS = { rows: [] as unknown[] };
type Answer = { present: boolean } | { n: number } | typeof ROWS | Error;

type Ranker = LexicalRanking['ranker'];

function fakeDb(...answers: Answer[]): {
  db: DB;
  calls: () => number;
  statements: () => string[];
} {
  const queued = [...answers];
  const execute = vi.fn(async (_query: unknown) => {
    const answer = queued.shift();
    if (answer === undefined) throw new Error('fake db: an unexpected extra query ran');
    if (answer instanceof Error) throw answer;
    return 'rows' in answer ? ROWS : { rows: [answer] };
  });
  return {
    db: { execute } as unknown as DB,
    calls: () => execute.mock.calls.length,
    statements: () => execute.mock.calls.map((call) => sqlText(call[0])),
  };
}

function sqlText(node: unknown): string {
  const chunks = (node as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return '';
  return chunks.map(chunkText).join(' ');
}

/** Render one SQL chunk. Tables and columns are drizzle OBJECTS, not string
 *  chunks, so a statement built from schema references (the corpus count's
 *  creator join and its gates) reads as blanks without this. */
function chunkText(chunk: unknown): string {
  if (is(chunk, Column)) return `${getTableName(chunk.table)}.${chunk.name}`;
  if (is(chunk, Table)) return getTableName(chunk);
  const value = (chunk as { value?: unknown })?.value;
  if (Array.isArray(value)) return value.join('');
  return sqlText(chunk);
}

function pgError(code: string, message: string): Error {
  const cause = new Error(message) as Error & { code: string };
  cause.code = code;
  return new Error('query failed', { cause });
}

describe('resolveLexicalRanker', () => {
  afterEach(() => __resetLexicalRankerForTest());

  it('degrades to ts_rank with ONE warning when the index is absent — the CI path', () => {
    // The test env leaves SEARCH_LEXICAL_RANKER unset, so this is the default
    // ranker meeting a database that has never run 0052: exactly what CI's
    // pgvector/pgvector:pg16 image is. The leg must rank, not 500.
    const { db, calls } = fakeDb({ present: false });
    return captureLogs(async () => {
      expect(await resolveLexicalRanker(db)).toEqual({ ranker: 'ts_rank' });
      expect(await resolveLexicalRanker(db)).toEqual({ ranker: 'ts_rank' });
    }).then(({ records }) => {
      expect(calls()).toBe(1);
      const warned = records.filter((r) => String(r.msg).includes('the index is absent'));
      expect(warned).toHaveLength(1);
      expect(warned[0]?.index).toBe(BM25_INDEX);
    });
  });

  it('uses bm25 only after the real bm25 EXPRESSION runs, not just to_regclass', async () => {
    const { db, calls, statements } = fakeDb({ present: true }, ROWS, { n: 1_605 });
    expect(await resolveLexicalRanker(db)).toEqual({ ranker: 'bm25', corpusSize: 1_605 });
    expect(calls()).toBe(3);
    const [regclass, expression, count] = statements();
    expect(regclass).toContain('to_regclass');
    expect(expression).toContain('to_bm25query');
    expect(expression).toContain('<@>');
    expect(expression).toContain('array_to_tsvector');
    expect(expression).toContain(`'${BM25_INDEX}'::regclass`);
    expect(expression).toContain('limit 1');
    expect(count).toContain('count(*)');
    expect(await resolveLexicalRanker(db)).toEqual({ ranker: 'bm25', corpusSize: 1_605 });
    expect(calls()).toBe(3);
  });

  it('counts only DISCOVERABLE rows, the same predicate the legs retrieve under (#839)', async () => {
    // The boosts are scaled against the corpus this ranker can actually return.
    // Counting drafts, unlisted pieces and soft-deleted creators' posts
    // normalised against rows no leg reaches, and drifted as drafts piled up.
    const { db, statements } = fakeDb({ present: true }, ROWS, { n: 1_605 });
    expect(await resolveLexicalRanker(db)).toEqual({ ranker: 'bm25', corpusSize: 1_605 });
    const count = must(statements()[2], 'corpus count statement');
    expect(count).toContain('count(*)');
    // gates.discoverable(), reached through the creator join it needs.
    expect(count).toContain('creators');
    expect(count).toContain('deleted_at');
    expect(count).toContain('status');
  });

  it('degrades rather than throwing when the probe itself fails', async () => {
    const { db } = fakeDb(new Error('connection reset'));
    const { records } = await captureLogs(async () => {
      expect(await resolveLexicalRanker(db)).toEqual({ ranker: 'ts_rank' });
    });
    expect(records.some((r) => String(r.msg).includes('probe failed'))).toBe(true);
  });

  it('RECOVERS: a failed probe is not cached, so the next request re-probes', async () => {
    const { db, calls } = fakeDb(new Error('connection reset'), { present: true }, ROWS, {
      n: 1_605,
    });
    const { records } = await captureLogs(async () => {
      expect(await resolveLexicalRanker(db)).toEqual({ ranker: 'ts_rank' });
      expect(await resolveLexicalRanker(db)).toEqual({ ranker: 'bm25', corpusSize: 1_605 });
    });
    expect(calls()).toBe(4);
    expect(records.some((r) => String(r.msg).includes('probe failed'))).toBe(true);
  });

  it('treats a failing bm25 EXPRESSION as a degrade, and does not cache that either', async () => {
    const { db, calls } = fakeDb(
      { present: true },
      new Error('operator does not exist: tsvector <@> bm25query'),
      { present: true },
      ROWS,
      { n: 1_605 },
    );
    const { records } = await captureLogs(async () => {
      expect(await resolveLexicalRanker(db)).toEqual({ ranker: 'ts_rank' });
      expect(await resolveLexicalRanker(db)).toEqual({ ranker: 'bm25', corpusSize: 1_605 });
    });
    expect(calls()).toBe(5);
    expect(records.some((r) => String(r.msg).includes('probe failed'))).toBe(true);
  });
});

describe('runLexicalLeg', () => {
  afterEach(() => __resetLexicalRankerForTest());

  it('runs the leg once under ts_rank where the index is absent', async () => {
    const { db } = fakeDb({ present: false });
    const seen: LexicalRanking[] = [];
    const rows = await captureLogs(async () =>
      runLexicalLeg(db, async (ranking) => {
        seen.push(ranking);
        return 'rows';
      }),
    );
    expect(rows.result).toBe('rows');
    expect(seen).toEqual([{ ranker: 'ts_rank' }]);
  });

  it('re-runs the leg under ts_rank when the bm25 arm fails MID-REQUEST', async () => {
    const { db, calls } = fakeDb({ present: true }, ROWS, { n: 1_605 });
    const seen: LexicalRanking[] = [];
    const { result, records } = await captureLogs(async () =>
      runLexicalLeg(db, async (ranking) => {
        seen.push(ranking);
        if (ranking.ranker === 'bm25') {
          throw pgError('42883', 'function to_bm25query does not exist');
        }
        return 'rows';
      }),
    );
    expect(result).toBe('rows');
    expect(seen).toEqual([{ ranker: 'bm25', corpusSize: 1_605 }, { ranker: 'ts_rank' }]);
    const warned = records.filter((r) => String(r.msg).includes('bm25 lexical leg failed'));
    expect(warned).toHaveLength(1);

    seen.length = 0;
    expect(await resolveLexicalRanker(db)).toEqual({ ranker: 'ts_rank' });
    expect(calls()).toBe(3);
    await runLexicalLeg(db, async (ranking) => {
      seen.push(ranking);
      return 'rows';
    });
    expect(seen).toEqual([{ ranker: 'ts_rank' }]);
  });

  it('a TRANSIENT bm25 leg failure degrades this request only — the next one tries bm25 again', async () => {
    // The probe refuses to cache a transient; the leg follows the same policy.
    // A statement timeout on the slowest query in the system must not demote
    // ranking for the instance's whole warm life.
    const { db, calls } = fakeDb({ present: true }, ROWS, { n: 1_605 });
    let failures = 0;
    const seen: LexicalRanking[] = [];
    await captureLogs(async () => {
      const first = await runLexicalLeg(db, async (ranking) => {
        seen.push(ranking);
        if (ranking.ranker === 'bm25' && failures++ === 0) {
          throw pgError('57014', 'canceling statement due to statement timeout');
        }
        return 'rows';
      });
      expect(first).toBe('rows');
    });
    expect(seen).toEqual([{ ranker: 'bm25', corpusSize: 1_605 }, { ranker: 'ts_rank' }]);

    // Next request: bm25 again, and this time it works. Neither the probe nor
    // the corpus count re-queries — the transient cleared no cache.
    seen.length = 0;
    await runLexicalLeg(db, async (ranking) => {
      seen.push(ranking);
      return 'rows';
    });
    expect(seen).toEqual([{ ranker: 'bm25', corpusSize: 1_605 }]);
    expect(calls()).toBe(3);
  });

  /** The error-disposition table, DOCUMENTED_CLASSES-style: one row per claimed
   *  class, driving runLexicalLeg, so a silently reverted fix goes red here.
   *  legs1/legs2 = the rankers the leg callback sees on request 1 and 2. The
   *  rows name the RANKER rather than the whole ranking: which arm ran is the
   *  claim under test, and pinning corpusSize here would repeat what the two
   *  tests above already assert about the union the retry rebuilds. */
  const ERROR_DISPOSITIONS: Array<{
    name: string;
    err: () => Error;
    legs1: Ranker[];
    legs2: Ranker[];
  }> = [
    // Resolution class: the ARM is broken; first occurrence flips the process.
    {
      name: '42883 undefined_function',
      err: () => pgError('42883', 'no to_bm25query'),
      legs1: ['bm25', 'ts_rank'],
      legs2: ['ts_rank'],
    },
    {
      name: '42P01 undefined_table',
      err: () => pgError('42P01', 'no relation'),
      legs1: ['bm25', 'ts_rank'],
      legs2: ['ts_rank'],
    },
    // The XX CLASS, whole: XX002 index_corrupted is the case the path exists
    // for; narrowing back to XX000 alone must go red on the XX001/XX002 rows.
    {
      name: 'XX000 internal_error',
      err: () => pgError('XX000', 'internal'),
      legs1: ['bm25', 'ts_rank'],
      legs2: ['ts_rank'],
    },
    {
      name: 'XX001 data_corrupted',
      err: () => pgError('XX001', 'corrupt data'),
      legs1: ['bm25', 'ts_rank'],
      legs2: ['ts_rank'],
    },
    {
      name: 'XX002 index_corrupted',
      err: () => pgError('XX002', 'corrupt index'),
      legs1: ['bm25', 'ts_rank'],
      legs2: ['ts_rank'],
    },
    // Transients: this request degrades, the next one tries bm25 again.
    {
      name: '57014 statement timeout',
      err: () => pgError('57014', 'timeout'),
      legs1: ['bm25', 'ts_rank'],
      legs2: ['bm25'],
    },
    {
      name: '08006 connection_failure',
      err: () => pgError('08006', 'conn failure'),
      legs1: ['bm25', 'ts_rank'],
      legs2: ['bm25'],
    },
    {
      name: 'code-less driver error',
      err: () => new Error('socket hang up'),
      legs1: ['bm25', 'ts_rank'],
      legs2: ['bm25'],
    },
  ];

  it.each(ERROR_DISPOSITIONS)('disposition: $name', async ({ err, legs1, legs2 }) => {
    const { db } = fakeDb({ present: true }, ROWS, { n: 1_605 });
    const seen: Ranker[] = [];
    let threw = false;
    const { records } = await captureLogs(async () => {
      await runLexicalLeg(db, async (ranking) => {
        seen.push(ranking.ranker);
        if (ranking.ranker === 'bm25' && !threw) {
          threw = true;
          throw err();
        }
        return 'rows';
      });
    });
    expect(seen).toEqual(legs1);
    // The observability twin of the behaviour: the operator-facing log field
    // and message variant must agree with the disposition, so mutating
    // `processFlipped` (or collapsing the message variants) goes red here.
    const flipped = legs2[0] === 'ts_rank';
    const warned = records.filter((r) => String(r.msg).includes('bm25 lexical leg failed'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ processFlipped: flipped });
    expect(String(warned[0]?.msg)).toContain(
      flipped ? 'for the life of this process' : 'for this request',
    );
    expect(String(warned[0]?.msg)).toContain(
      flipped ? 'resolution-class error' : 'failed transiently',
    );
    seen.length = 0;
    await captureLogs(async () =>
      runLexicalLeg(db, async (ranking) => {
        seen.push(ranking.ranker);
        return 'rows';
      }),
    );
    expect(seen).toEqual(legs2);
  });

  it('a SUCCESS resets the transient counter — spread-out blips never accumulate into a flip', async () => {
    // fail, fail, succeed, fail, fail, fail: without the reset the third
    // failure overall would flip; with it the flip needs three IN A ROW, so
    // request 6 is the one that settles the process.
    const { db } = fakeDb({ present: true }, ROWS, { n: 1_605 });
    const legs: Ranker[][] = [];
    const failOn = [true, true, false, true, true, true];
    await captureLogs(async () => {
      for (const fail of failOn) {
        const seen: Ranker[] = [];
        await runLexicalLeg(db, async (ranking) => {
          seen.push(ranking.ranker);
          if (ranking.ranker === 'bm25' && fail) throw pgError('57014', 'timeout');
          return 'rows';
        });
        legs.push(seen);
      }
    });
    expect(legs).toEqual([
      ['bm25', 'ts_rank'],
      ['bm25', 'ts_rank'],
      ['bm25'],
      ['bm25', 'ts_rank'],
      ['bm25', 'ts_rank'],
      ['bm25', 'ts_rank'],
    ]);
    // The sixth was the third consecutive failure: the process is now settled.
    const seen: Ranker[] = [];
    await runLexicalLeg(db, async (ranking) => {
      seen.push(ranking.ranker);
      return 'rows';
    });
    expect(seen).toEqual(['ts_rank']);
  });

  it('flips after TRANSIENT_FLIP_AFTER consecutive transients — the ceiling on the retry cost', async () => {
    // A sustained fault (bm25 timing out on every request) must not double
    // query load forever; three in a row settles the process on ts_rank.
    const { db } = fakeDb({ present: true }, ROWS, { n: 1_605 });
    const seen: Ranker[] = [];
    await captureLogs(async () => {
      for (let i = 0; i < 4; i += 1) {
        await runLexicalLeg(db, async (ranking) => {
          seen.push(ranking.ranker);
          if (ranking.ranker === 'bm25') throw pgError('57014', 'statement timeout');
          return 'rows';
        });
      }
    });
    // Requests 1-3 each try bm25 then degrade; request 4 goes straight to
    // ts_rank because the third transient flipped the process.
    expect(seen).toEqual(['bm25', 'ts_rank', 'bm25', 'ts_rank', 'bm25', 'ts_rank', 'ts_rank']);
  });

  it('rethrows a ts_rank failure — there is no third ranker to degrade to', async () => {
    const { db } = fakeDb({ present: false });
    await expect(
      runLexicalLeg(db, async () => {
        throw new Error('statement timeout');
      }),
    ).rejects.toThrow('statement timeout');
  });

  it('rethrows when the ts_rank RETRY fails too', async () => {
    const { db } = fakeDb({ present: true }, ROWS, { n: 1_605 });
    await captureLogs(async () => {
      await expect(
        runLexicalLeg(db, async (ranking) => {
          throw new Error(`${ranking.ranker} leg failed`);
        }),
      ).rejects.toThrow('ts_rank leg failed');
    });
  });
});
