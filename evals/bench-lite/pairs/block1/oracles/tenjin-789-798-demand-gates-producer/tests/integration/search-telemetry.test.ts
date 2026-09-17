// Integration coverage for search telemetry against testcontainer Postgres:
// the two rollups' ordering / distinct-searcher minCount / unmet-demand
// semantics over seeded rows, plus the GET /api/articles route actually
// landing a search row when driven with ?q= (and NOT landing one on a
// cursor'd page of the same walk).
import { it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { uuidv7 } from 'uuidv7';

import {
  creators,
  hiddenSearchTerms,
  lookupCandidates,
  lookupOutcomes,
  lookups,
  searchQueries,
} from '@/lib/db/schema';
import { getAgentSearchDemandSummary } from '@/lib/agent-search-demand';
import {
  CONVERTED_QUESTIONS_WINDOW_DAYS,
  QUESTION_JUDGE_PAGE_SIZE,
  QUESTIONS_WINDOW_DAYS,
  getAgentQuestions,
  getAnsweredQuestions,
  getConvertedQuestions,
  getPendingAgentQuestions,
  countDogfoodExclusions,
  getPendingUnmetSearchTerms,
  getQuestionJudgingWorklist,
  getTopSearchTerms,
  getUnmetSearchTerms,
  getWaitingQuestions,
  normalizeQuery,
  type SearchSource,
} from '@/lib/search-telemetry';
import { ANSWER_BODY_EXAMPLE } from '@/lib/payments/answer-example';
import * as verdictStore from '@/lib/question-verdicts';
import {
  __resetQuestionVerdictsForTest,
  storeQuestionVerdict,
  TOPICALITY_FLOOR,
  type QuestionVerdict,
} from '@/lib/question-verdicts';
import { runQuestionJudgingPass } from '@/lib/question-judging';
import { env } from '@/lib/env';
import { emitSearch } from '@/lib/search/telemetry';
import type { RequestAttribution } from '@/lib/mcp/request-context';
import { createArticlesHandler } from '@/app/api/articles/route';
import { startTestDb, stopTestDb, describeIntegration, type TestDb } from './_support/db';
import { makeCreator, makePost, makePayment, makeTags, attachTags } from './_support/fixtures';
import { must } from './_support/assert';
import { hashSearcher } from '@/lib/client-identity';
import { internalMcpHopHeaders } from '@/lib/mcp/request-context';
import { createInlineScheduler } from './_support/scheduler';

let tdb: TestDb;

const { runInline } = createInlineScheduler();

// Distinct searcher identities for seeding (the real hash is sha256(ip+day);
// the rollups only compare them for equality, so any distinct strings work).
const SEARCHER_A = 'hash-a';
const SEARCHER_B = 'hash-b';

// Explicit created_at so a test can order rows within a query group (the unmet
// rollup reads the LATEST row per term). query is passed pre-normalized.
async function makeSearch(
  query: string,
  source: SearchSource,
  resultCount: number,
  createdAtLiteral: string,
  searcherHash: string,
): Promise<void> {
  await tdb.db.execute(sql`
    INSERT INTO search_queries (id, query, source, searcher_hash, result_count, created_at)
    VALUES (${uuidv7()}, ${query}, ${source}, ${searcherHash}, ${resultCount}, ${createdAtLiteral}::timestamptz)
  `);
}

// The same seeder plus client_name, which marks probe traffic. NULL is an
// ordinary agent row.
async function makeSearchWith(
  query: string,
  resultCount: number,
  createdAtLiteral: string,
  searcherHash: string,
  extra: { clientName?: string | null } = {},
): Promise<void> {
  await tdb.db.execute(sql`
    INSERT INTO search_queries (id, query, source, searcher_hash, result_count, client_name, created_at)
    VALUES (${uuidv7()}, ${query}, 'agent', ${searcherHash}, ${resultCount},
            ${extra.clientName ?? null}, ${createdAtLiteral}::timestamptz)
  `);
}

// OLDER sits past the unmet list's 24h persistence delay (first-seen must be
// more than 24 hours old); NEWER is fresh. Both inside the 30-day window.
const OLDER = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
const NEWER = new Date().toISOString();

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000);

// One answer-search decision row. `decision` is what the questions rollup reads
// for `answered`; candidate_count only has to agree with it.
// Returns the lookup id, which is what a payment stamps to attribute a sale back
// to the question that surfaced it (payments.lookup_id).
async function makeQuestion(
  text: string | null,
  decision: 'miss' | 'candidates',
  at: Date,
  requesterHmac: string | null,
  clientName: string | null = null,
): Promise<string> {
  const [row] = await tdb.db
    .insert(lookups)
    .values({
      decision,
      candidateCount: decision === 'miss' ? 0 : 1,
      requesterHmac,
      clientName,
      generalizedQuery: text,
      createdAt: at,
    })
    .returning({ id: lookups.id });
  return must(row, 'lookup insert returned no row').id;
}

/** What the asking agent reported back about a lookup (#705 / #706). */
async function makeOutcome(
  lookupId: string,
  status: string,
  at: Date,
  postId: string | null = null,
): Promise<void> {
  await tdb.db.insert(lookupOutcomes).values({ lookupId, status, postId, createdAt: at });
}

/** What that lookup was OFFERED, in display order. */
async function makeCandidate(lookupId: string, postId: string, rank: number): Promise<void> {
  await tdb.db.insert(lookupCandidates).values({ lookupId, postId, rank });
}

// A settled sale attributed to one lookup. Each payment needs its own post so the
// per-post paywall shape stays realistic; the tier reads payments.lookup_id and
// the payer-versus-owner compare, nothing else. `selfPay` makes the piece's own
// creator the payer, which is the one case the converted tier must not count.
async function makeSale(lookupId: string, opts: { selfPay?: boolean } = {}): Promise<void> {
  const creator = must(await makeCreator(tdb), 'creator');
  const post = must(await makePost(tdb, creator), 'post');
  await makePayment(tdb, post, {
    lookupId,
    searchAttributed: true,
    ...(opts.selfPay ? { payerAddress: creator.walletAddress } : {}),
  });
}

// The gate reads env at call time, so the rollups can be driven with a list set.
// Restored in `finally` because leaking it would silently filter later tests.
async function withDogfoodHashes(hashes: string[], fn: () => Promise<void>): Promise<void> {
  const previous = env.DOGFOOD_SEARCHER_HASHES;
  env.DOGFOOD_SEARCHER_HASHES = hashes;
  try {
    await fn();
  } finally {
    env.DOGFOOD_SEARCHER_HASHES = previous;
  }
}

const QUESTION_OPTS = { days: 7, limit: 50, maxPerRequester: 3 };
// The converted tier's own, longer window (CONVERTED_QUESTIONS_WINDOW_DAYS).
const CONVERTED_OPTS = { days: 30, limit: 10, maxPerRequester: 3 };

/** A cached judge verdict that clears every semantic bar. */
function allowingVerdict(over: Partial<QuestionVerdict> = {}): QuestionVerdict {
  return {
    privateContext: false,
    pii: false,
    topicSimilarity: null,
    model: 'test-judge',
    judgedAt: new Date().toISOString(),
    ...over,
  };
}

/** Seed an ALLOWING verdict for each question, as the daily judging pass would.
 *  The gated tiers publish nothing without one (fail closed), so tests that
 *  exercise the OTHER gates seed permissive verdicts for every string — proving
 *  those gates hold independently of the judge. */
async function allowQuestions(...texts: string[]): Promise<void> {
  for (const text of texts) {
    await storeQuestionVerdict(normalizeQuery(text), allowingVerdict());
  }
}

describeIntegration('search-telemetry rollups', () => {
  beforeAll(async () => {
    tdb = await startTestDb();
  }, 60_000);

  afterAll(async () => {
    if (tdb) await stopTestDb(tdb);
  });

  beforeEach(async () => {
    await tdb.db.execute(
      sql`TRUNCATE TABLE ${searchQueries}, ${hiddenSearchTerms}, ${lookups}, ${creators} CASCADE`,
    );
    __resetQuestionVerdictsForTest();
  });

  /**
   * The question lists read the same `lookups` rows this count does, but they
   * also require stored text, a publishable shape and a shorter window, so a
   * counted row can be unlistable. Junk on that arm is therefore invisible: the
   * total moves and a reader has nowhere to look for what moved it. Two shapes
   * are refused here, and a third is deliberately kept.
   */
  it('getAgentSearchDemandSummary drops synthetic answer rows but keeps untexted ones', async () => {
    const now = new Date();
    await tdb.db.insert(lookups).values([
      // Real demand, and the floor this window needs.
      {
        id: uuidv7(),
        decision: 'candidates',
        candidateCount: 2,
        generalizedQuery: 'how do I settle an x402 payment on Base',
        requesterHmac: 'real-a',
        createdAt: now,
      },
      {
        id: uuidv7(),
        decision: 'miss',
        candidateCount: 0,
        generalizedQuery: 'pgvector probe count default',
        requesterHmac: 'real-b',
        createdAt: now,
      },
      // No question text stored. A request was still made, so it counts.
      {
        id: uuidv7(),
        decision: 'candidates',
        candidateCount: 1,
        requesterHmac: 'real-c',
        createdAt: now,
      },
      // A fourth requester, so the operator veto below removes a ROW without
      // dropping the arm under its distinct-requester floor. Without this the
      // test would measure the floor rather than the veto.
      {
        id: uuidv7(),
        decision: 'candidates',
        candidateCount: 3,
        generalizedQuery: 'does drizzle push run migrations in order',
        requesterHmac: 'real-d',
        createdAt: now,
      },
      // The CLI fixture string a live hook path emits (tenjin-agent#197).
      {
        id: uuidv7(),
        decision: 'miss',
        candidateCount: 0,
        generalizedQuery: 'a question',
        requesterHmac: 'junk-a',
        createdAt: now,
      },
      // The marketplace's own reply composed back into a question.
      {
        id: uuidv7(),
        decision: 'miss',
        candidateCount: 0,
        generalizedQuery: 'What is the latest on Found 3 article(s).?',
        requesterHmac: 'junk-b',
        createdAt: now,
      },
    ]);

    // Four counted: three texted, one untexted. Neither synthetic shape survives.
    await expect(
      getAgentSearchDemandSummary(tdb.db, { days: 30, minSearchers: 3 }),
    ).resolves.toEqual({ total: 4, matched: 3, missed: 1 });

    // The operator half of the same veto, which is what makes a new junk term
    // droppable with no deploy. Inserted AFTER the rows were logged, like the
    // term-tier takedown above, and it moves this count too.
    await tdb.db
      .insert(hiddenSearchTerms)
      .values([
        { term: normalizeQuery('how do I settle an x402 payment on Base'), reason: 'test veto' },
      ]);

    await expect(
      getAgentSearchDemandSummary(tdb.db, { days: 30, minSearchers: 3 }),
    ).resolves.toEqual({ total: 3, matched: 2, missed: 1 });
  });

  it('getAgentSearchDemandSummary combines answer and catalog outcomes without exposing questions', async () => {
    const now = new Date();
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    await tdb.db.insert(lookups).values([
      {
        id: uuidv7(),
        decision: 'candidates',
        candidateCount: 2,
        requesterHmac: 'real-a',
        createdAt: now,
      },
      {
        id: uuidv7(),
        decision: 'miss',
        candidateCount: 0,
        clientName: 'tenjin-cli',
        requesterHmac: 'real-b',
        createdAt: now,
      },
      {
        id: uuidv7(),
        // The decision registry is open; candidate_count remains the durable
        // matched/missed truth used by the public aggregate.
        decision: 'future-decision',
        candidateCount: 0,
        clientName: 'other-agent',
        requesterHmac: 'real-c',
        createdAt: now,
      },
      {
        id: uuidv7(),
        decision: 'candidates',
        candidateCount: 4,
        clientName: 'Tenjin-Eval',
        requesterHmac: 'eval',
        createdAt: now,
      },
      {
        id: uuidv7(),
        decision: 'miss',
        candidateCount: 0,
        clientName: 'TENJIN-ADMIN-PROBE',
        requesterHmac: 'probe',
        createdAt: now,
      },
      {
        id: uuidv7(),
        decision: 'candidates',
        candidateCount: 1,
        requesterHmac: 'old',
        createdAt: old,
      },
    ]);

    await makeSearchWith('catalog lexical hit', 3, NEWER, 'real-a');
    await makeSearchWith('catalog second hit', 2, NEWER, 'real-b');
    await makeSearchWith('catalog miss', 0, NEWER, 'real-c');
    await makeSearchWith('catalog eval', 8, NEWER, 'eval', { clientName: 'TENJIN-EVAL' });
    await makeSearch('human directory hit', 'web', 4, NEWER, 'human');

    await expect(
      getAgentSearchDemandSummary(tdb.db, { days: 30, minSearchers: 3 }),
    ).resolves.toEqual({
      total: 6,
      matched: 3,
      missed: 3,
    });
  });

  it('requires each search surface to clear the requester floor independently', async () => {
    await tdb.db.insert(lookups).values(
      Array.from({ length: 40 }, (_, index) => ({
        id: uuidv7(),
        decision: index % 2 === 0 ? 'candidates' : 'miss',
        candidateCount: index % 2 === 0 ? 2 : 0,
        requesterHmac: 'one-repeating-agent',
        createdAt: new Date(),
      })),
    );
    await tdb.db.insert(lookups).values(
      Array.from({ length: 10 }, () => ({
        id: uuidv7(),
        decision: 'miss',
        candidateCount: 0,
        requesterHmac: null,
        createdAt: new Date(),
      })),
    );

    await makeSearchWith('catalog one', 1, NEWER, 'catalog-a');
    await makeSearchWith('catalog two', 0, NEWER, 'catalog-b');
    await makeSearchWith('catalog three', 0, NEWER, 'catalog-c');

    await expect(
      getAgentSearchDemandSummary(tdb.db, { days: 30, minSearchers: 3 }),
    ).resolves.toEqual({ total: 3, matched: 1, missed: 2 });
  });

  it('publishes answer outcomes when catalog search alone stays below its floor', async () => {
    await tdb.db.insert(lookups).values([
      {
        id: uuidv7(),
        decision: 'candidates',
        candidateCount: 2,
        requesterHmac: 'answer-a',
        createdAt: new Date(),
      },
      {
        id: uuidv7(),
        decision: 'miss',
        candidateCount: 0,
        requesterHmac: 'answer-b',
        createdAt: new Date(),
      },
      {
        id: uuidv7(),
        decision: 'miss',
        candidateCount: 0,
        requesterHmac: 'answer-c',
        createdAt: new Date(),
      },
    ]);
    for (let index = 0; index < 20; index++) {
      await makeSearchWith(`catalog repeat ${index}`, 1, NEWER, 'one-catalog-agent');
    }

    await expect(
      getAgentSearchDemandSummary(tdb.db, { days: 30, minSearchers: 3 }),
    ).resolves.toEqual({ total: 3, matched: 1, missed: 2 });
  });

  it('counts every catalog outcome after that surface clears its requester floor', async () => {
    for (let index = 0; index < 25; index++) {
      await makeSearchWith(`catalog miss ${index}`, 0, NEWER, 'one-repeating-agent');
    }
    await makeSearchWith('second agent', 1, NEWER, 'second-agent');
    await makeSearchWith('third agent', 0, NEWER, 'third-agent');

    await expect(
      getAgentSearchDemandSummary(tdb.db, { days: 30, minSearchers: 3 }),
    ).resolves.toEqual({ total: 27, matched: 1, missed: 26 });
  });

  it('counts every answer outcome after that surface clears its requester floor', async () => {
    await tdb.db.insert(lookups).values([
      ...Array.from({ length: 25 }, () => ({
        id: uuidv7(),
        decision: 'miss' as const,
        candidateCount: 0,
        requesterHmac: 'one-repeating-answer-agent',
        createdAt: new Date(),
      })),
      {
        id: uuidv7(),
        decision: 'candidates',
        candidateCount: 1,
        requesterHmac: 'second-answer-agent',
        createdAt: new Date(),
      },
      {
        id: uuidv7(),
        decision: 'miss',
        candidateCount: 0,
        requesterHmac: 'third-answer-agent',
        createdAt: new Date(),
      },
    ]);

    await expect(
      getAgentSearchDemandSummary(tdb.db, { days: 30, minSearchers: 3 }),
    ).resolves.toEqual({ total: 27, matched: 1, missed: 26 });
  });

  it('getAgentSearchDemandSummary: the 402 sample question is not a search either', async () => {
    // The pulse sits directly above the tiers that already exclude this string,
    // so counting it there would print a number the lists below disown. Cased and
    // re-spaced, because the exclusion normalizes before it compares.
    const sample = ANSWER_BODY_EXAMPLE.question;
    await makeQuestion(sample, 'candidates', hoursAgo(1), 'scanner-a', 'CoinbaseBazaarDiscovery');
    await makeQuestion(sample.toUpperCase(), 'miss', hoursAgo(2), 'scanner-b', 'curl');
    await makeQuestion(sample.replace(' ', '  '), 'miss', hoursAgo(3), 'scanner-c');
    await makeQuestion(
      'how do i verify an eip-3009 authorization?',
      'candidates',
      hoursAgo(1),
      'a',
    );
    await makeQuestion('what changed in x402 2.19?', 'miss', hoursAgo(1), 'b');
    // Capture is per-route policy, so a row can carry no text at all. It is a real
    // search and must still count: the predicate is NULL-safe for exactly this.
    await makeQuestion(null, 'candidates', hoursAgo(1), 'c');

    await expect(
      getAgentSearchDemandSummary(tdb.db, { days: 30, minSearchers: 3 }),
    ).resolves.toEqual({ total: 3, matched: 2, missed: 1 });
  });

  it('getTopSearchTerms: count desc; minCount is DISTINCT searchers, so a lone searcher never surfaces', async () => {
    // 'rust': 3 rows across two distinct searchers ⇒ surfaces (searches = rows).
    await makeSearch('rust', 'agent', 5, NEWER, SEARCHER_A);
    await makeSearch('rust', 'web', 5, NEWER, SEARCHER_B);
    await makeSearch('rust', 'agent', 4, NEWER, SEARCHER_A);
    // 'python': 2 rows, 2 distinct searchers ⇒ surfaces.
    await makeSearch('python', 'web', 3, NEWER, SEARCHER_A);
    await makeSearch('python', 'agent', 3, NEWER, SEARCHER_B);
    // THE PRIVACY CASE: one searcher re-logging the same personal query 5 times
    // (paging / sort toggles) must NOT clear minCount 2.
    for (let i = 0; i < 5; i++) {
      await makeSearch('my rare disease', 'web', 2, NEWER, SEARCHER_A);
    }

    // Supply-side gate: a term whose latest search matched NOTHING never
    // reaches Most searched, even with plenty of distinct searchers.
    await makeSearch('no matches here', 'web', 0, NEWER, SEARCHER_A);
    await makeSearch('no matches here', 'agent', 0, NEWER, SEARCHER_B);
    // Display filter: a PII-shaped term is hidden regardless of counts.
    await makeSearch('bob@example.com', 'web', 4, NEWER, SEARCHER_A);
    await makeSearch('bob@example.com', 'agent', 4, NEWER, SEARCHER_B);

    const rows = await getTopSearchTerms(tdb.db, { days: 30, limit: 25, minCount: 2 });
    expect(rows.map((r) => ({ query: r.query, searches: r.searches }))).toEqual([
      { query: 'rust', searches: 3 },
      { query: 'python', searches: 2 },
    ]);
    expect(rows.some((r) => r.query === 'my rare disease')).toBe(false);

    // A second, distinct searcher corroborates the demand ⇒ now it surfaces.
    await makeSearch('my rare disease', 'web', 2, NEWER, SEARCHER_B);
    const after = await getTopSearchTerms(tdb.db, { days: 30, limit: 25, minCount: 2 });
    expect(after.map((r) => r.query)).toContain('my rare disease');
  });

  it('getUnmetSearchTerms: latest-zero terms only, distinct bar + 24h persistence + filter applied', async () => {
    // Latest is 0 and first seen 30h ago ⇒ unmet.
    await makeSearch('zk proofs', 'agent', 0, OLDER, SEARCHER_A);
    await makeSearch('zk proofs', 'agent', 0, NEWER, SEARCHER_B);
    // Started empty, now has hits (latest 5) ⇒ NOT unmet.
    await makeSearch('ai safety', 'agent', 0, OLDER, SEARCHER_A);
    await makeSearch('ai safety', 'web', 5, NEWER, SEARCHER_B);
    // Once had hits, now empty (latest 0) ⇒ unmet.
    await makeSearch('quantum', 'web', 5, OLDER, SEARCHER_A);
    await makeSearch('quantum', 'agent', 0, NEWER, SEARCHER_B);
    // ONE searcher's repeated zero-result query ⇒ below the distinct bar ⇒ absent.
    await makeSearch('solo', 'agent', 0, OLDER, SEARCHER_A);
    await makeSearch('solo', 'agent', 0, NEWER, SEARCHER_A);
    // Two searchers but first seen just now ⇒ the 24h persistence delay hides
    // it until tomorrow (slows single-actor gaming, leaves a takedown window).
    await makeSearch('brand new gap', 'web', 0, NEWER, SEARCHER_A);
    await makeSearch('brand new gap', 'agent', 0, NEWER, SEARCHER_B);
    // Aged and multi-searcher, but PII-shaped ⇒ the display filter hides it.
    await makeSearch('carol@example.com', 'web', 0, OLDER, SEARCHER_A);
    await makeSearch('carol@example.com', 'agent', 0, NEWER, SEARCHER_B);
    // Two searchers, first seen 30h ago (past the delay), but every row on ONE
    // UTC day ⇒ the cross-day bar hides it: a same-day proxy burst cannot
    // qualify however many IPs it rotates.
    await makeSearch('one day burst', 'agent', 0, OLDER, SEARCHER_A);
    await makeSearch('one day burst', 'agent', 0, OLDER, SEARCHER_B);

    const rows = await getUnmetSearchTerms(tdb.db, { days: 30, limit: 10, minCount: 2 });
    // Both have 2 searches, so the count tie breaks on query asc: quantum, zk proofs.
    expect(rows.map((r) => r.query)).toEqual(['quantum', 'zk proofs']);
  });

  it('the LATEST result count decides the tier, not any earlier one', async () => {
    // The catalog answers this term now, so an older zero must not keep it on the
    // unmet list: the tier reads the latest row, and result_count is the whole
    // basis for that read since the always-hybrid rework fused the rescue in.
    await makeSearchWith('stablecoin depeg risk', 0, OLDER, SEARCHER_A);
    await makeSearchWith('stablecoin depeg risk', 5, NEWER, SEARCHER_B);
    // Zero on the latest row is genuinely unmet.
    await makeSearchWith('unicorn futures desk', 0, OLDER, SEARCHER_A);
    await makeSearchWith('unicorn futures desk', 0, NEWER, SEARCHER_B);

    const unmet = await getUnmetSearchTerms(tdb.db, { days: 30, limit: 10, minCount: 2 });
    expect(unmet.map((r) => r.query)).toEqual(['unicorn futures desk']);
    // And the answered term is not silently lost from both lists.
    const met = await getTopSearchTerms(tdb.db, { days: 30, limit: 25, minCount: 2 });
    expect(met.map((r) => r.query)).toEqual(['stablecoin depeg risk']);
  });

  it('probe traffic never counts as demand on either list (#516)', async () => {
    // An eval sweep over gold queries would otherwise manufacture the very unmet
    // demand it was measuring, and inflate the met list with its own hits.
    await makeSearchWith('gold sweep query', 0, OLDER, SEARCHER_A, { clientName: 'tenjin-eval' });
    await makeSearchWith('gold sweep query', 0, NEWER, SEARCHER_B, { clientName: 'tenjin-eval' });
    await makeSearchWith('probe hit query', 7, OLDER, SEARCHER_A, {
      clientName: 'tenjin-admin-probe',
    });
    await makeSearchWith('probe hit query', 7, NEWER, SEARCHER_B, {
      clientName: 'tenjin-admin-probe',
    });
    // A real agent that happens to send its own client name is ordinary demand.
    await makeSearchWith('real agent gap', 0, OLDER, SEARCHER_A, { clientName: 'acme-agent' });
    await makeSearchWith('real agent gap', 0, NEWER, SEARCHER_B, { clientName: 'acme-agent' });
    // Case is not a bypass: the header is stored verbatim, so a differently-cased
    // probe name would sail through an equality filter.
    await makeSearchWith('cased probe query', 0, OLDER, SEARCHER_A, { clientName: 'Tenjin-Eval' });
    await makeSearchWith('cased probe query', 0, NEWER, SEARCHER_B, { clientName: 'TENJIN-EVAL' });

    expect(
      (await getUnmetSearchTerms(tdb.db, { days: 30, limit: 10, minCount: 2 })).map((r) => r.query),
    ).toEqual(['real agent gap']);
    expect(
      (await getTopSearchTerms(tdb.db, { days: 30, limit: 25, minCount: 2 })).map((r) => r.query),
    ).toEqual([]);
    // The moderation queue reads the same predicate, so a probe cannot page an
    // operator either.
    expect(
      (await getPendingUnmetSearchTerms(tdb.db, { days: 30, limit: 50, minCount: 2 })).map(
        (r) => r.query,
      ),
    ).toEqual(['real agent gap']);
  });

  it('an operator veto (hidden_search_terms) removes a term retroactively from every list', async () => {
    // A fully qualifying unmet term (2 searchers, spans 2 UTC days, aged) and a
    // fully qualifying met term.
    await makeSearch('zk proofs', 'agent', 0, OLDER, SEARCHER_A);
    await makeSearch('zk proofs', 'agent', 0, NEWER, SEARCHER_B);
    await makeSearch('rust', 'agent', 5, NEWER, SEARCHER_A);
    await makeSearch('rust', 'web', 5, NEWER, SEARCHER_B);

    // Published before the veto.
    expect(
      (await getUnmetSearchTerms(tdb.db, { days: 30, limit: 10, minCount: 2 })).map((r) => r.query),
    ).toEqual(['zk proofs']);
    expect(
      (await getTopSearchTerms(tdb.db, { days: 30, limit: 25, minCount: 2 })).map((r) => r.query),
    ).toEqual(['rust']);

    // One insert each (the documented takedown), AFTER the rows were logged.
    await tdb.db.insert(hiddenSearchTerms).values([
      { term: 'zk proofs', reason: 'test veto' },
      { term: 'rust', reason: 'test veto' },
    ]);

    // Gone from the published lists AND from the cron's pending queue.
    expect(await getUnmetSearchTerms(tdb.db, { days: 30, limit: 10, minCount: 2 })).toEqual([]);
    expect(await getTopSearchTerms(tdb.db, { days: 30, limit: 25, minCount: 2 })).toEqual([]);
    expect(await getPendingUnmetSearchTerms(tdb.db, { days: 30, limit: 50, minCount: 2 })).toEqual(
      [],
    );
  });

  it('getPendingUnmetSearchTerms: the same bars minus the 24h delay (the moderation queue)', async () => {
    // Fully qualifying (already published) ⇒ pending by definition.
    await makeSearch('zk proofs', 'agent', 0, OLDER, SEARCHER_A);
    await makeSearch('zk proofs', 'agent', 0, NEWER, SEARCHER_B);
    // Fails the cross-day bar ⇒ not pending either: the queue only carries
    // terms that can actually publish. (A term that is strictly pending, i.e.
    // spans 2 UTC days entirely within the last 24h, cannot be fixtured
    // deterministically without clock control: whether now-23h falls on
    // yesterday's UTC date depends on the run's time of day. The delay clause
    // is the ONLY difference between the two functions, so the published-list
    // tests above cover it.)
    await makeSearch('one day burst', 'agent', 0, OLDER, SEARCHER_A);
    await makeSearch('one day burst', 'agent', 0, OLDER, SEARCHER_B);

    const pending = await getPendingUnmetSearchTerms(tdb.db, { days: 30, limit: 50, minCount: 2 });
    expect(pending.map((r) => r.query)).toEqual(['zk proofs']);
  });

  it('source option scopes every gate to one write surface (the agent-only /trending posture)', async () => {
    // Web-only demand: two distinct searchers, matched results.
    await makeSearch('webby topic', 'web', 3, NEWER, SEARCHER_A);
    await makeSearch('webby topic', 'web', 3, NEWER, SEARCHER_B);
    // Agent demand, same shape.
    await makeSearch('agent topic', 'agent', 3, NEWER, SEARCHER_A);
    await makeSearch('agent topic', 'agent', 3, NEWER, SEARCHER_B);
    // Mixed: two distinct searchers overall, but only ONE on the agent side, so
    // the agent-scoped distinct bar must not count the web row.
    await makeSearch('mixed topic', 'agent', 3, NEWER, SEARCHER_A);
    await makeSearch('mixed topic', 'web', 3, NEWER, SEARCHER_B);

    const all = await getTopSearchTerms(tdb.db, { days: 30, limit: 25, minCount: 2 });
    expect(all.map((r) => r.query).sort()).toEqual(['agent topic', 'mixed topic', 'webby topic']);

    const agentOnly = await getTopSearchTerms(tdb.db, {
      days: 30,
      limit: 25,
      minCount: 2,
      source: 'agent',
    });
    expect(agentOnly.map((r) => r.query)).toEqual(['agent topic']);
  });

  it('GET /api/articles logs one agent row for a first-page q, and none for the cursor walk', async () => {
    const creator = must(await makeCreator(tdb, { handle: 'alice' }), 'alice');
    // Two published essays matching "rustlang" so page 1 (limit 1) yields a cursor.
    await makePost(tdb, creator, {
      slug: 'r1',
      title: 'Rustlang essay one',
      status: 'published',
      publishedAt: new Date(),
    });
    await makePost(tdb, creator, {
      slug: 'r2',
      title: 'Rustlang essay two',
      status: 'published',
      publishedAt: new Date(),
    });

    // Inline scheduler: production schedules the telemetry insert through
    // afterResponse (next/server after()), which outside a Next request scope
    // swallows the task entirely, so the test injects a scheduler that runs it
    // immediately and keeps the row observable.
    const handler = createArticlesHandler(tdb.db, runInline, null);
    const res = await handler(
      // An explicit sort, because relevance mode is single-page in v3 (a fused
      // ranking has no stable keyset) and this case is about the CURSOR WALK not
      // writing a second demand row.
      new NextRequest('https://tenjin.xyz/api/articles?q=RustLang&limit=1&sort=newest'),
    );
    expect(res.status).toBe(200);
    const page1 = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();

    // The insert is fire-and-forget even through the inline scheduler, so poll
    // until the row lands rather than assuming it completed before the response.
    const row = await waitForSearchRow('rustlang');
    expect(row).toBeTruthy();
    expect(row!.source).toBe('agent');
    // result_count is the RETURNED page length (limit 1), but match_count is the
    // true total (both essays match), so ?limit=1 is no longer read as "only 1
    // matched". requested_limit records the cap; sort/tag are absent, so null.
    expect(row!.resultCount).toBe(1);
    expect(row!.matchCount).toBe(2);
    expect(row!.requestedLimit).toBe(1);
    expect(row!.sort).toBe('newest');
    expect(row!.tag).toBeNull();
    expect(row!.searcherHash).toMatch(/^[0-9a-f]{64}$/); // keyed HMAC hex, never a raw IP
    expect(row!.userAgent).toBeNull();

    // Page 2 of the same walk carries a cursor ⇒ no new row (the last page's 0
    // would otherwise falsely flag a matched term as unmet).
    const res2 = await handler(
      new NextRequest(
        `https://tenjin.xyz/api/articles?q=RustLang&limit=1&sort=newest&cursor=${encodeURIComponent(page1.nextCursor!)}`,
      ),
    );
    expect(res2.status).toBe(200);
    // Give a stray (buggy) fire-and-forget insert time to land before counting.
    await new Promise((r) => setTimeout(r, 200));
    const count = await tdb.db
      .select({ n: sql<number>`count(*)::int` })
      .from(searchQueries)
      .where(eq(searchQueries.query, 'rustlang'));
    expect(count[0]!.n).toBe(1);
  });

  it('GET /api/articles: match_count respects a tag facet, and the options round-trip', async () => {
    const creator = must(await makeCreator(tdb, { handle: 'facet' }), 'facet');
    const [tag] = await makeTags(tdb, ['robotics']);
    const tagRow = must(tag, 'tag');
    // Three published essays all match "widgets"; only two carry the robotics tag.
    const w1 = must(
      await makePost(tdb, creator, {
        slug: 'w1',
        title: 'Widgets one',
        status: 'published',
        publishedAt: new Date(),
      }),
      'w1',
    );
    const w2 = must(
      await makePost(tdb, creator, {
        slug: 'w2',
        title: 'Widgets two',
        status: 'published',
        publishedAt: new Date(),
      }),
      'w2',
    );
    await makePost(tdb, creator, {
      slug: 'w3',
      title: 'Widgets three',
      status: 'published',
      publishedAt: new Date(),
    });
    await attachTags(tdb, w1.id, [tagRow.id]);
    await attachTags(tdb, w2.id, [tagRow.id]);

    const handler = createArticlesHandler(tdb.db, runInline, null);
    const res = await handler(
      new NextRequest(
        `https://tenjin.xyz/api/articles?q=widgets&tag=${tagRow.slug}&sort=newest&limit=1`,
      ),
    );
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: unknown[] };
    expect(page.items).toHaveLength(1);

    const row = await waitForSearchRow('widgets');
    expect(row).toBeTruthy();
    expect(row!.resultCount).toBe(1); // the returned page length under limit 1
    // match_count counts only the TAGGED matches (the full predicate), not all
    // three "widgets" hits: proof it respects the facet, not just q.
    expect(row!.matchCount).toBe(2);
    expect(row!.requestedLimit).toBe(1);
    expect(row!.sort).toBe('newest');
    expect(row!.tag).toBe(tagRow.slug);
  });

  it('GET /api/articles keeps the canonical product and stores no raw User-Agent', async () => {
    const creator = must(await makeCreator(tdb, { handle: 'uaware' }), 'uaware');
    await makePost(tdb, creator, {
      slug: 'ua1',
      title: 'Telemetry essay',
      status: 'published',
      publishedAt: new Date(),
    });

    const handler = createArticlesHandler(tdb.db, runInline, null);
    const res = await handler(
      new NextRequest('https://tenjin.xyz/api/articles?q=telemetry', {
        headers: { 'user-agent': 'x402scan/1.2 (+https://x402scan.com)' },
      }),
    );
    expect(res.status).toBe(200);

    // The search row stays attributable without the raw header: the parsed
    // product columns carry it, and request_telemetry holds the raw UA for the
    // same request, joinable by requester HMAC and time.
    const row = await waitForSearchRow('telemetry');
    expect(row).toBeTruthy();
    expect(row!.source).toBe('agent');
    expect(row!.userAgent).toBeNull();
    expect(row!.clientName).toBe('x402scan');
    expect(row!.clientVersion).toBe('1.2');
    expect(row!.transport).toBe('http');
  });

  it('GET /api/articles stores authenticated outer MCP context and no inner runtime UA', async () => {
    const creator = must(await makeCreator(tdb, { handle: 'mcpaware' }), 'mcpaware');
    await makePost(tdb, creator, {
      slug: 'mcp1',
      title: 'MCP attribution essay',
      status: 'published',
      publishedAt: new Date(),
    });
    const requesterHmac = hashSearcher('203.0.113.88');
    const handler = createArticlesHandler(tdb.db, runInline, null);
    const res = await handler(
      new NextRequest('https://tenjin.xyz/api/articles?q=attribution', {
        headers: internalMcpHopHeaders({
          requesterHmac,
          clientName: 'chatgpt',
          clientVersion: '1.0',
        }),
      }),
    );
    expect(res.status).toBe(200);
    const row = await waitForSearchRow('attribution');
    expect(row).toMatchObject({
      searcherHash: requesterHmac,
      clientName: 'chatgpt',
      clientVersion: '1.0',
      transport: 'mcp',
      userAgent: null,
    });
  });

  it('keeps the eval marker the harness leads its User-Agent with', async () => {
    const creator = must(await makeCreator(tdb, { handle: 'evalmarker' }), 'evalmarker');
    await makePost(tdb, creator, {
      slug: 'eval1',
      title: 'Eval marker essay',
      status: 'published',
      publishedAt: new Date(),
    });
    const handler = createArticlesHandler(tdb.db, runInline, null);
    const res = await handler(
      new NextRequest('https://tenjin.xyz/api/articles?q=eval-marker', {
        headers: { 'user-agent': 'tenjin-eval/1.0.0 node/24.4.0 undici/7.0' },
      }),
    );
    expect(res.status).toBe(200);
    const row = await waitForSearchRow('eval-marker');
    expect(row).toMatchObject({
      clientName: 'tenjin-eval',
      clientVersion: '1.0.0',
      transport: 'http',
    });
  });

  it('an over-long User-Agent lands nothing, and never suppresses the demand row', async () => {
    const creator = must(await makeCreator(tdb, { handle: 'uabound' }), 'uabound');
    await makePost(tdb, creator, {
      slug: 'ub1',
      title: 'Bounded essay',
      status: 'published',
      publishedAt: new Date(),
    });

    // 513 chars: one past the 512 cap the attribution still bounds for
    // request_telemetry. Nothing of it reaches search_queries either way, and the
    // demand row itself still LANDS, so a hostile header cannot suppress the signal.
    const handler = createArticlesHandler(tdb.db, runInline, null);
    const res = await handler(
      new NextRequest('https://tenjin.xyz/api/articles?q=bounded', {
        headers: { 'user-agent': 'a'.repeat(513) },
      }),
    );
    expect(res.status).toBe(200);

    const row = await waitForSearchRow('bounded');
    expect(row).toBeTruthy();
    expect(row!.resultCount).toBe(1);
    expect(row!.userAgent).toBeNull();
  });

  // The 'web' rows elsewhere in this suite are raw-SQL fixtures, so nothing
  // reached the real writer to pin this. Drive the seam itself with a UA on the
  // attribution, on BOTH sources: the column used to be nulled for 'web' and
  // captured for everything else, and the cutover is that the source no longer
  // decides anything — nothing offers the header to the insert at all. Running
  // both here is what separates "the gate flipped direction" from "the gate is
  // gone"; a per-source null would still pass a 'web'-only assertion.
  it('drops the raw UA on every source, not just the one the old gate named', async () => {
    await emitSearch(tdb.db, {
      view: 'display',
      query: 'web ua invariant',
      capture: 'always',
      attribution: uaAttribution(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      ),
      source: 'web',
      resultCount: 3,
      matchCount: 3,
    });

    const row = await waitForSearchRow('web ua invariant');
    expect(row).toBeTruthy();
    expect(row!.source).toBe('web');
    expect(row!.userAgent).toBeNull();

    await emitSearch(tdb.db, {
      view: 'display',
      query: 'agent ua invariant',
      capture: 'always',
      attribution: uaAttribution('x402scan/1.2'),
      source: 'agent',
      resultCount: 3,
      matchCount: 3,
    });
    const agentRow = await waitForSearchRow('agent ua invariant');
    expect(agentRow!.source).toBe('agent');
    expect(agentRow!.userAgent).toBeNull();
    // The row still lands with the rest of its attribution, so this is the UA
    // leaving rather than the write failing.
    expect(agentRow!.searcherHash).toBe(SEARCHER_A);
    expect(agentRow!.resultCount).toBe(3);
  });

  it('getAgentQuestions: one row per normalized question, newest first, latest row deciding answered', async () => {
    // Three phrasings of one question: case and an internal whitespace run are
    // the only differences, so they normalize together and publish once. The
    // LATEST row decides, and it found candidates, so the group reads answered
    // even though the first two asks missed.
    await makeQuestion('How do I mint an NFT?', 'miss', hoursAgo(50), 'hash-a');
    await makeQuestion('how do i  mint an nft?', 'miss', hoursAgo(40), 'hash-b');
    await makeQuestion('HOW DO I MINT AN NFT?', 'candidates', hoursAgo(30), 'hash-c');
    // A second question, asked longer ago, so it sorts after the one above.
    await makeQuestion('does drizzle support partial indexes', 'miss', hoursAgo(61), 'hash-d');
    await makeQuestion('does drizzle support partial indexes', 'miss', hoursAgo(60), 'hash-e');
    await allowQuestions('how do i mint an nft?', 'does drizzle support partial indexes');

    const rows = await getAgentQuestions(tdb.db, QUESTION_OPTS);
    expect(rows).toEqual([
      // The stored text of the LATEST row, not the normalized key: the caller's
      // own capitalization is what publishes. `requesters` counts DISTINCT
      // askers across the whole normalized group (all three phrasings).
      {
        query: 'HOW DO I MINT AN NFT?',
        answered: true,
        requesters: 3,
        askedOn: utcDayOf(hoursAgo(30)),
      },
      {
        query: 'does drizzle support partial indexes',
        answered: false,
        requesters: 2,
        askedOn: utcDayOf(hoursAgo(60)),
      },
    ]);
    // No requester field can reach a caller, and no time of day either.
    expect(Object.keys(rows[0]!).sort()).toEqual(['answered', 'askedOn', 'query', 'requesters']);
  });

  it('getAgentQuestions: drops probe traffic, unattributed rows, and rows with no question text', async () => {
    // An eval sweep or an operator probe would otherwise publish its own script
    // as the questions agents are asking.
    await makeQuestion('gold sweep question', 'miss', hoursAgo(30), 'hash-a', 'tenjin-eval');
    await makeQuestion('probe question', 'miss', hoursAgo(30), 'hash-b', 'TENJIN-ADMIN-PROBE');
    // Capture is per-route policy, so a row can hold no text at all.
    await makeQuestion(null, 'miss', hoursAgo(30), 'hash-c');
    // Unattributed: the per-requester cap cannot be enforced on it, so it fails
    // closed rather than publishing uncapped.
    await makeQuestion('who wrote this row', 'miss', hoursAgo(30), null);
    await makeQuestion('a real agent question', 'miss', hoursAgo(30), 'hash-d', 'acme-agent');
    await makeQuestion('a real agent question', 'miss', hoursAgo(29), 'hash-e', 'acme-agent');
    // Every string verdicted, so only the gates under test decide the outcome.
    await allowQuestions(
      'gold sweep question',
      'probe question',
      'who wrote this row',
      'a real agent question',
    );

    const rows = await getAgentQuestions(tdb.db, QUESTION_OPTS);
    expect(rows.map((r) => r.query)).toEqual(['a real agent question']);
  });

  it('the question tiers, the queue and the judging worklist all drop seeding traffic', async () => {
    // Driven through the real entry points, not the predicate: the gate is five
    // separate compositions into five WHERE clauses, and a rollup that never
    // composed it would still pass a test that built its own SELECT.
    const listed = 'a'.repeat(64);
    const stranger = 'b'.repeat(64);
    await makeQuestion('seeding loop question', 'miss', hoursAgo(30), listed, 'tenjin-cli');
    // Same operator, same egress, different client: real demand that must survive.
    await makeQuestion('hook question', 'miss', hoursAgo(30), listed, 'tenjin-websearch-hook');
    // NULL client_name is "cannot prove it is seeding". A bare NOT over a NULL
    // compare is itself NULL, which a WHERE drops, so without the coalesce this
    // row disappears: the listed searcher's whole pre-client_name history would
    // go with their loop.
    await makeQuestion('web question', 'miss', hoursAgo(30), listed, null);
    // Every external CLI user stores 'tenjin-cli', so the name alone must never
    // exclude anyone.
    await makeQuestion('stranger cli question', 'miss', hoursAgo(30), stranger, 'tenjin-cli');
    await allowQuestions(
      'seeding loop question',
      'hook question',
      'web question',
      'stranger cli question',
    );

    const survivors = ['hook question', 'stranger cli question', 'web question'];
    await withDogfoodHashes([listed], async () => {
      expect((await getAgentQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query).sort()).toEqual(
        survivors,
      );
      expect((await getWaitingQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query).sort()).toEqual(
        survivors,
      );
      // The queue and the worklist gate too, so seeding cannot page an operator
      // or spend judge budget on our own questions.
      expect(
        (await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions
          .map((r) => r.query)
          .sort(),
      ).toEqual(survivors);
      const worklist = await getQuestionJudgingWorklist(tdb.db, {
        days: 7,
        limit: QUESTION_JUDGE_PAGE_SIZE,
      });
      expect(worklist.questions.map((r) => r.query).sort()).toEqual(survivors);
    });

    // Unset is the non-production default: every row counts again, which is what
    // makes the exclusion reversible without a deploy.
    expect((await getAgentQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toHaveLength(4);
  });

  it('the term tiers and both halves of the stats-line pulse drop seeding traffic', async () => {
    const listed = 'a'.repeat(64);
    const stranger = 'b'.repeat(64);
    // The catalog side, which the pulse's second half and the term tiers share.
    await makeSearchWith('seeding term', 0, OLDER, listed, { clientName: 'tenjin-cli' });
    await makeSearchWith('seeding term', 0, NEWER, listed, { clientName: 'tenjin-cli' });
    await makeSearchWith('real gap term', 0, OLDER, stranger, { clientName: 'tenjin-cli' });
    await makeSearchWith('real gap term', 0, NEWER, SEARCHER_B, { clientName: 'acme-agent' });
    // A third distinct catalog searcher, so the catalog half still clears the
    // pulse's requester floor once the seeding rows are gone. Its own term stays
    // below the tier's minCount, keeping the tier assertions about one term.
    await makeSearchWith('lonely term', 0, NEWER, 'e'.repeat(64), { clientName: 'acme-agent' });
    // The answer side, above the pulse's 3-requester floor without the seeding row.
    await makeQuestion('pulse seeding question', 'miss', hoursAgo(2), listed, 'tenjin-cli');
    await makeQuestion('pulse question one', 'candidates', hoursAgo(2), stranger, 'acme-agent');
    await makeQuestion('pulse question two', 'miss', hoursAgo(2), 'c'.repeat(64), 'acme-agent');
    await makeQuestion('pulse question three', 'miss', hoursAgo(2), 'd'.repeat(64), null);

    await withDogfoodHashes([listed], async () => {
      expect(
        (await getUnmetSearchTerms(tdb.db, { days: 30, limit: 10, minCount: 2 })).map(
          (r) => r.query,
        ),
      ).toEqual(['real gap term']);
      expect(
        (await getPendingUnmetSearchTerms(tdb.db, { days: 30, limit: 50, minCount: 2 })).map(
          (r) => r.query,
        ),
      ).toEqual(['real gap term']);
      // 3 answer rows + 3 catalog rows: both halves still clear their floors, and
      // the seeding rows on each side are gone.
      await expect(
        getAgentSearchDemandSummary(tdb.db, { days: 30, minSearchers: 3 }),
      ).resolves.toEqual({ total: 6, matched: 1, missed: 5 });
    });

    await expect(
      getAgentSearchDemandSummary(tdb.db, { days: 30, minSearchers: 3 }),
    ).resolves.toEqual({ total: 9, matched: 1, missed: 8 });
  });

  it('countDogfoodExclusions reports per hash, and zero for one that no longer matches', async () => {
    const listed = 'a'.repeat(64);
    const rotated = 'f'.repeat(64);
    await makeQuestion('seeding one', 'miss', hoursAgo(2), listed, 'tenjin-cli');
    await makeQuestion('seeding two', 'miss', hoursAgo(2), listed, 'tenjin-cli');
    // Not excluded, so not counted: the number has to track the gate, not the hash.
    await makeQuestion('hook question', 'miss', hoursAgo(2), listed, 'tenjin-websearch-hook');
    await makeSearchWith('seeding term', 0, NEWER, listed, { clientName: 'tenjin-cli' });

    expect(await countDogfoodExclusions(tdb.db, { days: 30, hashes: [listed, rotated] })).toEqual([
      { hash: listed, lookups: 2, searches: 1 },
      // A rotated secret or a moved egress looks exactly like this, which is the
      // signal the daily emit alerts on.
      { hash: rotated, lookups: 0, searches: 0 },
    ]);
  });

  it('getAgentQuestions: an operator veto beats an ALLOWING verdict, retroactively, on the NORMALIZED text', async () => {
    await makeQuestion('Should I Use Postgres Or SQLite?', 'miss', hoursAgo(31), 'hash-a');
    await makeQuestion('should i use postgres or sqlite?', 'miss', hoursAgo(30), 'hash-b');
    await allowQuestions('should i use postgres or sqlite?');
    expect((await getAgentQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'should i use postgres or sqlite?',
    ]);

    // The operator vetoes the normalized form — the same one SQL groups on, and
    // the same column shape a term veto uses. AFTER the row was logged, and with
    // the allowing judge verdict still cached: the human veto always wins.
    await tdb.db
      .insert(hiddenSearchTerms)
      .values({ term: 'should i use postgres or sqlite?', reason: 'test veto' });

    expect(await getAgentQuestions(tdb.db, QUESTION_OPTS)).toEqual([]);
    // And from the moderation queue, so a vetoed question stops paging anyone.
    expect((await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions).toEqual([]);
  });

  it('getAgentQuestions: the 402 sample question is not demand, whichever client replays it', async () => {
    // We publish this sentence in our own 402 body, openapi.json and the Bazaar
    // entry; scanners POST it back to check x402 compliance and retrieval logs a
    // lookup before the charge decision. Cased and re-spaced, because the rollup
    // groups on the normalized text.
    const sample = ANSWER_BODY_EXAMPLE.question;
    await makeQuestion(sample, 'candidates', hoursAgo(50), 'hash-a', 'CoinbaseBazaarDiscovery');
    await makeQuestion(sample.toUpperCase(), 'miss', hoursAgo(40), 'hash-b', 'x402-census-probe');
    await makeQuestion(sample.replace(' ', '  '), 'miss', hoursAgo(30), 'hash-c', 'curl');
    // The SAME generic runtimes carry the most substantive real questions in the
    // table, which is why the discriminator is the string and not the client.
    const real = 'does vercel respect .nvmrc for serverless builds?';
    await makeQuestion(real, 'miss', hoursAgo(31), 'hash-d', 'curl');
    await makeQuestion(real, 'miss', hoursAgo(30), 'hash-e', 'Go-http-client');
    // Both verdicted, so the exclusion (not the judge gate) is what decides.
    await allowQuestions(sample, real);

    expect((await getAgentQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([real]);
    expect((await getWaitingQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([real]);
    expect(await getAnsweredQuestions(tdb.db, QUESTION_OPTS)).toEqual([]);
    // The queue drops it too and still carries everything that publishes: an
    // operator has nothing to veto here, and no gate went missing on one surface.
    expect(
      (await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions.map((r) => r.query),
    ).toEqual([real]);
  });

  it('no tier can publish the sample question, whatever the sample is edited to', async () => {
    // Read off the exported object rather than respelt, so editing
    // ANSWER_BODY_EXAMPLE moves both the exclusion and this assertion with it.
    // Seeded past every other bar — four askers, past the delay, under the cap,
    // verdicted, latest row answered — so only the exclusion can keep it off
    // the page.
    const normalized = normalizeQuery(ANSWER_BODY_EXAMPLE.question);
    await allowQuestions(ANSWER_BODY_EXAMPLE.question);
    for (let i = 0; i < 4; i++) {
      await makeQuestion(
        ANSWER_BODY_EXAMPLE.question,
        i === 3 ? 'candidates' : 'miss',
        hoursAgo(40 - i),
        `asker-${i}`,
      );
    }

    for (const tier of [
      getAgentQuestions,
      getWaitingQuestions,
      getAnsweredQuestions,
      async (db: typeof tdb.db, opts: typeof QUESTION_OPTS) =>
        (await getPendingAgentQuestions(db, opts)).questions,
    ]) {
      const rows = await tier(tdb.db, QUESTION_OPTS);
      expect(rows.map((r) => normalizeQuery(r.query))).not.toContain(normalized);
    }
  });

  it('the sample-question exclusion is scoped to the questions tier, not the term tiers', async () => {
    // GET /api/trending reads search_queries, a different population reached
    // through /api/articles?q=. A catalog search for the same words is ordinary
    // demand, and PR 1 must leave that surface byte-identical.
    const sample = normalizeQuery(ANSWER_BODY_EXAMPLE.question);
    await makeSearchWith(sample, 2, OLDER, SEARCHER_A);
    await makeSearchWith(sample, 2, NEWER, SEARCHER_B);
    await makeSearchWith('unmet sample words', 0, OLDER, SEARCHER_A);
    await makeSearchWith('unmet sample words', 0, NEWER, SEARCHER_B);

    const termOpts = { days: 30, limit: 10, minCount: 2 };
    expect((await getTopSearchTerms(tdb.db, termOpts)).map((r) => r.query)).toEqual([sample]);
    expect((await getUnmetSearchTerms(tdb.db, termOpts)).map((r) => r.query)).toEqual([
      'unmet sample words',
    ]);
  });

  it('getConvertedQuestions: only questions a payment is stamped to, and one asker is enough', async () => {
    // The buyer asked once and paid, and both questions carry a verdict: the
    // converted tier needs BOTH bars, because payments.lookup_id is a
    // self-reported header (see the bypass test below).
    const bought = await makeQuestion(
      'how do i verify an eip-3009 authorization offline?',
      'candidates',
      hoursAgo(30),
      'buyer-a',
    );
    await makeSale(bought);
    // Twenty days old: inside the converted tier's 30-day window, outside the
    // 7-day one the waiting and matched tiers read.
    const older = await makeQuestion(
      'why does x402scan show zero transactions for my server?',
      'candidates',
      hoursAgo(20 * 24),
      'buyer-b',
    );
    await makeSale(older);
    // Matched, never bought: the tier below this one on the page, not this one.
    await makeQuestion('what is a spend permission', 'candidates', hoursAgo(30), 'browser-a');
    await allowQuestions(
      'how do i verify an eip-3009 authorization offline?',
      'why does x402scan show zero transactions for my server?',
    );

    expect((await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).map((r) => r.query)).toEqual([
      'how do i verify an eip-3009 authorization offline?',
      'why does x402scan show zero transactions for my server?',
    ]);
    // The un-verdicted third question publishes on no tier at all.
    expect((await getAgentQuestions(tdb.db, CONVERTED_OPTS)).map((r) => r.query)).not.toContain(
      'what is a spend permission',
    );
    // And the ungated queue still carries it, so the operator sees what the
    // judging pass has not reached yet.
    expect(
      (await getPendingAgentQuestions(tdb.db, CONVERTED_OPTS)).questions.map((r) => r.query),
    ).toContain('what is a spend permission');
  });

  it('getConvertedQuestions: a bought lookup with NO verdict publishes nothing (the paid bypass is closed)', async () => {
    // The attack the exemption used to allow: payments.lookup_id is self-reported
    // (lib/payments/settlement.ts), and boughtLookup only asserts SOME payment
    // carries this lookup's id from a non-creator wallet. So minting a lookup
    // with a free search and buying any cheap piece with X-Tenjin-Search-Id set
    // to it bought publication of arbitrary text. It must now buy nothing.
    const payload = await makeQuestion(
      'internal codename bluefin ships to acme corp in march',
      'candidates',
      hoursAgo(30),
      'attacker-a',
    );
    await makeSale(payload);
    expect(await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).toEqual([]);

    // The same row with a DENYING verdict stays off, so the tier reads the
    // verdict rather than merely requiring one to exist.
    await storeQuestionVerdict(
      normalizeQuery('internal codename bluefin ships to acme corp in march'),
      {
        ...allowingVerdict(),
        privateContext: true,
      },
    );
    expect(await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).toEqual([]);

    // And an allowing verdict is what publishes it: the payment gates WHICH tier,
    // the verdict gates WHETHER the text may appear at all.
    await allowQuestions('internal codename bluefin ships to acme corp in march');
    expect((await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).map((r) => r.query)).toEqual([
      'internal codename bluefin ships to acme corp in march',
    ]);
  });

  it('getConvertedQuestions: a sale with no lookup attribution converts nothing', async () => {
    const asked = await makeQuestion(
      'how do i price an answer endpoint?',
      'candidates',
      hoursAgo(30),
      'buyer-a',
    );
    const creator = must(await makeCreator(tdb), 'creator');
    const post = must(await makePost(tdb, creator), 'post');
    // A direct web sale: no lookup_id at all.
    await makePayment(tdb, post, {});
    // A sale attributed to a lookup that no longer exists. lookup_id is FK-less
    // because telemetry rows expire on the 90-day sweep, so a dangling id is the
    // steady state and must not match some other question.
    await makePayment(tdb, post, { lookupId: uuidv7() });

    expect(await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).toEqual([]);
    // The lookup itself is untouched: it just never converted.
    expect(asked).toBeTruthy();
  });

  it('getConvertedQuestions: a sale exempts the row from no gate at all', async () => {
    // Every gate, each with a sale behind it, so only the gate can be what keeps
    // the row off the page. Every row here is verdicted, so the verdict is never
    // what drops the six.
    await makeSale(await makeQuestion('vetoed but bought', 'candidates', hoursAgo(30), 'buyer-a'));
    await tdb.db.insert(hiddenSearchTerms).values({ term: 'vetoed but bought', reason: 'test' });
    await makeSale(await makeQuestion('bought an hour ago', 'candidates', hoursAgo(1), 'buyer-b'));
    await makeSale(
      await makeQuestion('probe bought this', 'candidates', hoursAgo(30), 'buyer-c', 'tenjin-eval'),
    );
    await makeSale(
      await makeQuestion(ANSWER_BODY_EXAMPLE.question, 'candidates', hoursAgo(30), 'buyer-d'),
    );
    await makeSale(
      await makeQuestion('email alice@example.com about it', 'candidates', hoursAgo(30), 'buyer-e'),
    );
    const clean = 'how do i keep drizzle snapshots honest after a hand-edited migration?';
    await makeSale(await makeQuestion(clean, 'candidates', hoursAgo(30), 'buyer-f'));
    await allowQuestions(
      'vetoed but bought',
      'bought an hour ago',
      'probe bought this',
      ANSWER_BODY_EXAMPLE.question,
      'email alice@example.com about it',
      clean,
    );

    expect((await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).map((r) => r.query)).toEqual([
      clean,
    ]);
  });

  it('getConvertedQuestions: a window with demand but no sale publishes nothing', async () => {
    // The empty state the page renders as an invitation rather than as absence.
    await makeQuestion('does vercel respect .nvmrc?', 'candidates', hoursAgo(30), 'hash-a');
    await makeQuestion('does vercel respect .nvmrc?', 'candidates', hoursAgo(29), 'hash-b');
    await makeQuestion('what changed in x402 2.19?', 'miss', hoursAgo(30), 'hash-c');
    await allowQuestions('does vercel respect .nvmrc?');

    expect(await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).toEqual([]);
    // The same window still has plenty to say on the tiers below it.
    expect((await getAgentQuestions(tdb.db, CONVERTED_OPTS)).map((r) => r.query)).toEqual([
      'does vercel respect .nvmrc?',
    ]);
  });

  it('getConvertedQuestions: the creator buying their own piece is not a conversion', async () => {
    // The disclosed bar for this tier. A self-purchase costs facilitator fee +
    // gas rather than the post price, so it would be the cheapest way to place a
    // chosen sentence on the page the payment is supposed to have earned.
    const selfBought = await makeQuestion(
      'how do i seed my own demand page?',
      'candidates',
      hoursAgo(30),
      'owner-a',
    );
    await makeSale(selfBought, { selfPay: true });
    const bought = await makeQuestion(
      'how do i settle an x402 payment offline?',
      'candidates',
      hoursAgo(29),
      'buyer-a',
    );
    await makeSale(bought);
    await allowQuestions(
      'how do i seed my own demand page?',
      'how do i settle an x402 payment offline?',
    );

    expect((await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).map((r) => r.query)).toEqual([
      'how do i settle an x402 payment offline?',
    ]);

    // The gate drops the self-purchase, never the question: one real buyer on the
    // same lookup converts it.
    await makeSale(selfBought);
    expect((await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).map((r) => r.query)).toEqual([
      'how do i settle an x402 payment offline?',
      'how do i seed my own demand page?',
    ]);
  });

  it('getConvertedQuestions: a settled re-ask cannot un-convert a question that already sold', async () => {
    // Where #705 meets the converted tier. The settled drop gates OPEN demand, so
    // it must not reach a tier whose bar is a sale that already happened here.
    const query = 'how do i verify an eip-3009 authorization offline?';
    await makeSale(await makeQuestion(query, 'candidates', hoursAgo(40), 'buyer-a'));
    // The same words asked again, missed, and then settled off Tenjin by EVERY
    // asker in the group, which is what the open-demand drop now takes.
    const reAskedByBuyer = await makeQuestion(query, 'miss', hoursAgo(31), 'buyer-a');
    await makeOutcome(reAskedByBuyer, 'regenerated', hoursAgo(29));
    const reAsked = await makeQuestion(query, 'miss', hoursAgo(30), 'buyer-b');
    await makeOutcome(reAsked, 'regenerated', hoursAgo(29));
    // The same settled shape with no sale behind it, so only the sale can be what
    // separates the two.
    const alsoSettled = await makeQuestion(
      'what changed in x402 2.19?',
      'miss',
      hoursAgo(40),
      'hash-a',
    );
    const settled = await makeQuestion(
      'what changed in x402 2.19?',
      'miss',
      hoursAgo(30),
      'hash-b',
    );
    await makeOutcome(alsoSettled, 'regenerated', hoursAgo(29));
    await makeOutcome(settled, 'regenerated', hoursAgo(29));
    // Both strings verdicted, so the sale and the settled drop are the only
    // things deciding.
    await allowQuestions(query, 'what changed in x402 2.19?');

    expect((await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).map((r) => r.query)).toEqual([
      query,
    ]);
    // Both are settled demand, so the open-demand tiers publish neither, and the
    // converted row reaches the page through that tier alone.
    expect(await getWaitingQuestions(tdb.db, CONVERTED_OPTS)).toEqual([]);
    expect(await getAgentQuestions(tdb.db, CONVERTED_OPTS)).toEqual([]);
  });

  it('the in-code veto seed and the zzq_probe_ prefix publish on no tier', async () => {
    // Two requesters and a first ask past the delay on every string, so only the
    // exclusion under test can be what keeps a row off the page.
    const seed = async (text: string, decision: 'miss' | 'candidates') => {
      await makeQuestion(text, decision, hoursAgo(31), 'hash-a');
      await makeQuestion(text, decision, hoursAgo(30), 'hash-b');
    };
    await seed('a question', 'candidates');
    await seed('zzq_probe_value_9137', 'miss');
    // Not in the list: the reserved prefix is what excludes this one, so a new
    // probe string needs no code change.
    await seed('zzq_probe_fresh_2026', 'miss');
    await makeSale(await makeQuestion('a question', 'candidates', hoursAgo(29), 'buyer-a'));

    const answeredText = 'how do i keep a drizzle snapshot honest?';
    const waitingText = 'which base rpc survives a reorg?';
    await seed(answeredText, 'candidates');
    await seed(waitingText, 'miss');
    // Every string verdicted, the excluded ones included, so the veto seed and
    // the prefix are the only thing that can be keeping them off the page.
    await allowQuestions(
      'a question',
      'zzq_probe_value_9137',
      'zzq_probe_fresh_2026',
      answeredText,
      waitingText,
    );

    const texts = (rows: { query: string }[]) => rows.map((r) => r.query).sort();
    expect(texts(await getAgentQuestions(tdb.db, QUESTION_OPTS))).toEqual(
      [answeredText, waitingText].sort(),
    );
    expect(texts(await getAnsweredQuestions(tdb.db, QUESTION_OPTS))).toEqual([answeredText]);
    expect(texts(await getWaitingQuestions(tdb.db, QUESTION_OPTS))).toEqual([waitingText]);
    expect(await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).toEqual([]);
    // Dropped from the moderation queue too: an in-code veto is not actionable,
    // so listing it would only bury the rows an operator can still act on.
    expect(texts((await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions)).toEqual(
      [answeredText, waitingText].sort(),
    );
  });

  it('the question shape gate drops its three shapes and nothing looser', async () => {
    const seed = async (text: string) => {
      await makeQuestion(text, 'miss', hoursAgo(31), 'hash-a');
      await makeQuestion(text, 'miss', hoursAgo(30), 'hash-b');
    };
    await seed('hi');
    await seed('12345');
    await seed('test 2');
    // Short, and real. The operator's bias is explicit: a test slipping through
    // beats an empty page, so nothing looser than the three anchored rules ships.
    await seed('why x402?');
    // All four verdicted, so the shape gate is the only thing deciding.
    await allowQuestions('hi', '12345', 'test 2', 'why x402?');

    expect((await getWaitingQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'why x402?',
    ]);
  });

  it('the question shape gate leaves the term tiers alone', async () => {
    // One-word catalog searches are healthy supply signal, and the term tiers
    // already carry their own distinct-searcher floors.
    await makeSearchWith('x402', 2, OLDER, SEARCHER_A);
    await makeSearchWith('x402', 2, NEWER, SEARCHER_B);
    await makeSearchWith('test', 0, OLDER, SEARCHER_A);
    await makeSearchWith('test', 0, NEWER, SEARCHER_B);

    const termOpts = { days: 30, limit: 10, minCount: 2 };
    expect((await getTopSearchTerms(tdb.db, termOpts)).map((r) => r.query)).toEqual(['x402']);
    expect((await getUnmetSearchTerms(tdb.db, termOpts)).map((r) => r.query)).toEqual(['test']);
  });

  it('a term the tiers already publish never repeats as a question', async () => {
    // The live defect: /trending listed the bare words `crypto` and `x402` under
    // "Answered and bought" while both were healthy top terms at 63 and 5
    // searches. Seeded at the floors the anti-join reads, which are the constants
    // /trending itself passes: MET_MIN_SEARCHERS distinct searchers on a matched
    // term, and UNMET_MIN_SEARCHERS over 2 UTC days past the 24h delay on one
    // that matched nothing.
    for (const hash of ['s-1', 's-2', 's-3']) {
      await makeSearchWith('crypto', 4, NEWER, hash);
    }
    for (const hash of ['s-1', 's-2', 's-3', 's-4', 's-5']) {
      await makeSearchWith('x402', 0, OLDER, hash);
      await makeSearchWith('x402', 0, NEWER, hash);
    }
    // Searched once, so it publishes on NEITHER term tier: the compare is against
    // what the tiers publish, not against everything ever searched.
    await makeSearchWith('zk proofs', 3, NEWER, 's-1');

    const ask = async (text: string) => {
      await makeQuestion(text, 'candidates', hoursAgo(31), 'hash-a');
      await makeQuestion(text, 'candidates', hoursAgo(30), 'hash-b');
    };
    // Cased and re-spaced: both sides normalize, so neither slips through.
    await ask('CRYPTO ');
    await ask('x402');
    await ask('zk proofs');
    // A short question is not the one-word term inside it.
    await ask('why x402?');
    await makeSale(await makeQuestion('crypto', 'candidates', hoursAgo(29), 'buyer-a'));
    // Every question verdicted, the suppressed ones included, so the anti-join is
    // the only thing that can be keeping them off the page.
    await allowQuestions('crypto', 'x402', 'zk proofs', 'why x402?');

    const texts = (rows: { query: string }[]) => rows.map((r) => r.query).sort();
    const kept = ['why x402?', 'zk proofs'];
    expect(texts(await getAgentQuestions(tdb.db, QUESTION_OPTS))).toEqual(kept);
    expect(texts(await getAnsweredQuestions(tdb.db, QUESTION_OPTS))).toEqual(kept);
    expect(await getWaitingQuestions(tdb.db, QUESTION_OPTS)).toEqual([]);
    // The observed heading: a sale on the bare term buys it no slot either.
    expect(await getConvertedQuestions(tdb.db, CONVERTED_OPTS)).toEqual([]);
    // KEPT by the queue, unlike the veto: this exclusion lifts by itself the
    // minute the term drops off its tier, so an operator has to have seen the
    // question BEFORE that, while its 24h delay still has time left on it.
    expect(texts((await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions)).toEqual([
      'crypto',
      'why x402?',
      'x402',
      'zk proofs',
    ]);

    // The term tiers are untouched, at the floors /trending reads them with.
    expect(
      (await getTopSearchTerms(tdb.db, { days: 30, limit: 25, minCount: 3 })).map((r) => r.query),
    ).toEqual(['crypto']);
    expect(
      (await getUnmetSearchTerms(tdb.db, { days: 30, limit: 10, minCount: 5 })).map((r) => r.query),
    ).toEqual(['x402']);
  });

  it('a sentence pumped into a term cannot suppress the identical question', async () => {
    // The anti-join matches on exact text, so an unbounded one hands anybody who
    // can mint MET_MIN_SEARCHERS IP-derived searcher hashes a free takedown of
    // any question on the page. These three are seeded ABOVE that floor and still
    // suppress nothing, because none could be a catalog term. ONE FIXTURE PER
    // CLAUSE, so neither bar can be deleted with the suite still green: `sentence`
    // fails both, `phrase` fails only TERM_MAX_WORDS, `longToken` fails only the
    // 80-char cap (three tokens, 83 chars, which is the shape a hyphenated or
    // base64-ish slug reaches).
    const sentence =
      'how do i settle an x402 payment on base when the facilitator returns an expired nonce?';
    const phrase = 'base x402 payment nonce';
    const longToken =
      'x402-payment-required-facilitator-settlement-nonce-expiry-runbook base-mainnet usdc';
    // Three words and inside the cap, so this one is a term and does suppress:
    // the bound has to be a bound, not a repeal.
    const term = 'base dex aggregators';
    const pumped = [sentence, phrase, longToken, term];
    expect([sentence.length > 80, phrase.length <= 80, longToken.length > 80]).toEqual([
      true,
      true,
      true,
    ]);
    expect(longToken.split(' ')).toHaveLength(3);

    for (const hash of ['s-1', 's-2', 's-3']) {
      for (const text of pumped) {
        await makeSearchWith(text, 4, NEWER, hash);
      }
    }

    for (const text of pumped) {
      await makeQuestion(text, 'candidates', hoursAgo(31), 'hash-a');
      await makeQuestion(text, 'candidates', hoursAgo(30), 'hash-b');
    }
    // All four verdicted, so the anti-join's bound is the only thing deciding
    // which of them survives as a question.
    await allowQuestions(...pumped);

    expect((await getAgentQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query).sort()).toEqual(
      [phrase, sentence, longToken].sort(),
    );
    // All four clear the SQL FLOORS, so the three questions above survive on the
    // anti-join's own bound rather than on the term failing to qualify. Only two
    // reach the published term tier: toRows' 80-char display filter drops the
    // other two after the SQL limit, which is exactly why termShaped has to spell
    // that cap out instead of inheriting it.
    expect(
      (await getTopSearchTerms(tdb.db, { days: 30, limit: 25, minCount: 3 }))
        .map((r) => r.query)
        .sort(),
    ).toEqual([phrase, term].sort());
  });

  it('getAgentQuestions: the display filter drops PII, wallet, URL and over-length questions', async () => {
    await makeQuestion('email alice@example.com about the invoice', 'miss', hoursAgo(30), 'hash-a');
    await makeQuestion('what is at 0xdeadbeefcafe1234', 'miss', hoursAgo(30), 'hash-b');
    await makeQuestion(
      'summarize https://internal.example.com/runbook',
      'miss',
      hoursAgo(30),
      'hash-c',
    );
    await makeQuestion('call me on 555 867 5309 about it', 'miss', hoursAgo(30), 'hash-d');
    // The questions tier uses its own display cap (QUESTIONS_MAX_DISPLAY_LENGTH,
    // 256): a full-sentence question longer than the 80-char term cap still
    // publishes, while storage's 512-char worth of text does not.
    await makeQuestion('x'.repeat(300), 'miss', hoursAgo(30), 'hash-e');
    await makeQuestion(
      `how do i ${'really '.repeat(14)}verify a merkle proof`,
      'miss',
      hoursAgo(30),
      'hash-f',
    );
    await makeQuestion(
      `how do i ${'really '.repeat(14)}verify a merkle proof`,
      'miss',
      hoursAgo(29),
      'hash-h',
    );
    await makeQuestion('what is a merkle proof', 'miss', hoursAgo(30), 'hash-g');
    await makeQuestion('what is a merkle proof', 'miss', hoursAgo(29), 'hash-i');
    // Every string verdicted — including the PII-shaped ones — so the display
    // filter is what drops them, independent of the judge.
    await allowQuestions(
      'email alice@example.com about the invoice',
      'what is at 0xdeadbeefcafe1234',
      'summarize https://internal.example.com/runbook',
      'call me on 555 867 5309 about it',
      'x'.repeat(300),
      `how do i ${'really '.repeat(14)}verify a merkle proof`,
      'what is a merkle proof',
    );

    const rows = await getAgentQuestions(tdb.db, QUESTION_OPTS);
    expect(rows.map((r) => r.query).sort()).toEqual([
      `how do i ${'really '.repeat(14)}verify a merkle proof`,
      'what is a merkle proof',
    ]);
  });

  it('getAgentQuestions: holds a question 24h, which is exactly what the moderation queue carries', async () => {
    // First seen 30h ago ⇒ past the delay, published.
    await makeQuestion('aged question about rollups', 'miss', hoursAgo(30), 'hash-a');
    // First seen an hour ago ⇒ inside the takedown window, not yet published.
    await makeQuestion('brand new question', 'miss', hoursAgo(1), 'hash-b');
    await makeQuestion('brand new question', 'miss', hoursAgo(1), 'hash-e');
    // Re-asked recently, but the GROUP's first appearance is what the delay
    // reads, so a fresh row cannot re-hide a question that already published.
    await makeQuestion('aged question about rollups', 'candidates', hoursAgo(1), 'hash-c');
    await allowQuestions('aged question about rollups', 'brand new question');

    expect((await getAgentQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'aged question about rollups',
    ]);
    // The queue is the published list plus everything that could publish next:
    // it drops the delay AND the judge-verdict gate, which are the two
    // differences between the functions.
    expect(
      (await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions.map((r) => r.query).sort(),
    ).toEqual(['aged question about rollups', 'brand new question']);
  });

  it('getAgentQuestions: caps one requester at maxPerRequester so a single actor cannot fill the surface', async () => {
    // Five questions with the flooder as the LATEST asker on each, which is who
    // the cap attributes a published row to. With no requester floor this cap
    // is the SOLE volume bound on the surface (leaky per #728 — the hash
    // churns with IP — but it is the bound).
    for (let i = 0; i < 5; i++) {
      await makeQuestion(`flood question ${i}`, 'miss', hoursAgo(50 - i), 'bystander');
      await makeQuestion(`flood question ${i}`, 'miss', hoursAgo(40 - i), 'flooder');
    }
    await makeQuestion('someone else asked this', 'miss', hoursAgo(31), 'hash-b');
    await makeQuestion('someone else asked this', 'miss', hoursAgo(30), 'hash-c');
    await allowQuestions(...[0, 1, 2, 3, 4].map((i) => `flood question ${i}`));
    await allowQuestions('someone else asked this');

    const rows = await getAgentQuestions(tdb.db, QUESTION_OPTS);
    // The flooder keeps its three NEWEST questions and loses the rest; the other
    // requester is unaffected, and ordering stays newest-first overall.
    expect(rows.map((r) => r.query)).toEqual([
      'someone else asked this',
      'flood question 4',
      'flood question 3',
      'flood question 2',
    ]);

    // The cap is per requester, not global: raising it publishes the rest.
    const uncapped = await getAgentQuestions(tdb.db, { ...QUESTION_OPTS, maxPerRequester: 5 });
    expect(uncapped).toHaveLength(6);
  });

  it('a single asker IS enough once judged: the page is a live feed, not a ranked board', async () => {
    // The requester floor is gone by design (482 of 494 distinct prod questions
    // had one asker); what replaced it as the WHETHER-gate is the judge verdict.
    await makeQuestion('how do i verify an x402 settle response?', 'miss', hoursAgo(30), 'solo');
    await allowQuestions('how do i verify an x402 settle response?');

    const rows = await getAgentQuestions(tdb.db, QUESTION_OPTS);
    expect(rows.map((r) => [r.query, r.requesters])).toEqual([
      ['how do i verify an x402 settle response?', 1],
    ]);
  });

  it('an UNJUDGED question never publishes, however often it is asked (judge fails closed)', async () => {
    // A judge outage, a spent budget, and a question the daily pass has not
    // reached yet all look identical to the render: no verdict. Nothing may
    // publish on absence — the opposite of the publish gate's fail-open.
    for (let i = 0; i < 6; i++) {
      await makeQuestion('buy my token now', 'miss', hoursAgo(40 - i), 'planter');
    }
    await makeQuestion('buy my token now', 'miss', hoursAgo(30), 'someone-else');
    expect(await getAgentQuestions(tdb.db, QUESTION_OPTS)).toEqual([]);
    expect(await getWaitingQuestions(tdb.db, QUESTION_OPTS)).toEqual([]);
    expect(await getAnsweredQuestions(tdb.db, QUESTION_OPTS)).toEqual([]);

    // The moderation queue still carries it — the queue is the judging worklist
    // and the operator's preview, so it must show what the judge has not seen.
    expect(
      (await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions.map((r) => r.query),
    ).toEqual(['buy my token now']);
  });

  it('a DENY verdict (private context or pii) keeps the question off every published tier', async () => {
    await makeQuestion('what does acme corp pay its staff?', 'miss', hoursAgo(30), 'hash-a');
    await storeQuestionVerdict(
      normalizeQuery('what does acme corp pay its staff?'),
      allowingVerdict({ pii: true }),
    );

    expect(await getAgentQuestions(tdb.db, QUESTION_OPTS)).toEqual([]);
    expect(await getWaitingQuestions(tdb.db, QUESTION_OPTS)).toEqual([]);
    // Still on the operator's queue: a veto is the durable remedy, and the
    // queue must stay a superset of anything a verdict change could publish.
    expect(
      (await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions.map((r) => r.query),
    ).toEqual(['what does acme corp pay its staff?']);
  });

  it('the topicality floor drops far-off-topic questions and does NOT require candidates', async () => {
    // Both are MISSES — zero candidates, the unmet demand the page exists to
    // show — so the floor must be measurable without any candidate at all.
    await makeQuestion('how do agents settle x402 payments?', 'miss', hoursAgo(30), 'hash-a');
    await makeQuestion('best sourdough starter recipe', 'miss', hoursAgo(30), 'hash-b');
    await storeQuestionVerdict(
      normalizeQuery('how do agents settle x402 payments?'),
      allowingVerdict({ topicSimilarity: TOPICALITY_FLOOR + 0.05 }),
    );
    await storeQuestionVerdict(
      normalizeQuery('best sourdough starter recipe'),
      allowingVerdict({ topicSimilarity: TOPICALITY_FLOOR - 0.05 }),
    );

    expect((await getWaitingQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'how do agents settle x402 payments?',
    ]);
    // The queue ignores the floor with the rest of the verdict, as above.
    expect(
      (await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions.map((r) => r.query).sort(),
    ).toEqual(['best sourdough starter recipe', 'how do agents settle x402 payments?']);
  });

  it('a cached verdict is the whole render path: judged once ever, never on a render', async () => {
    // Drive the REAL pipeline once: the cron's judging pass with a stub judge,
    // then render twice. The judge runs exactly once for the question, and the
    // renders read only the cache — a render can never trigger a model call
    // (search-telemetry does not even import the judge).
    await makeQuestion('what is an erc-8004 registry?', 'miss', hoursAgo(30), 'hash-a');
    let judgeCalls = 0;
    const judge = {
      model: 'stub-judge',
      judge: async () => {
        judgeCalls += 1;
        return { privateContext: false, rightsEncumbered: false, pii: false };
      },
    };
    // The whole cron entry point, worklist paging included, so the SQL grouping
    // key the verdict is stored under is the one the page reads.
    const pass = async () =>
      runQuestionJudgingPass(tdb.db, {
        judge,
        provider: null,
        consumeJudgeBudget: async () => true,
        consumeEmbeddingBudget: async () => true,
      });

    await pass();
    expect(judgeCalls).toBe(1);
    expect((await getAgentQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'what is an erc-8004 registry?',
    ]);
    await getAgentQuestions(tdb.db, QUESTION_OPTS);
    await pass(); // a later cron run sees the cached verdict
    expect(judgeCalls).toBe(1);
  });

  it('the judging worklist survives a flood the operator queue does not', async () => {
    // One hash asks 60 questions today; a real agent asks one. The operator
    // queue is per-requester-capped and page-sized, which is right for a veto
    // surface and fatal as a worklist: fed to the judge, the real question never
    // gets a verdict and, fail-closed, never publishes.
    for (let i = 0; i < 60; i++) {
      await makeQuestion(`flood question number ${i}`, 'miss', hoursAgo(30), 'flooder');
    }
    const real = 'how do i verify a siwx signature from an agent?';
    await makeQuestion(real, 'miss', hoursAgo(29), 'real-agent');

    const queue = (await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions.map(
      (r) => r.query,
    );
    expect(queue.filter((q) => q.startsWith('flood question')).length).toBeLessThanOrEqual(
      QUESTION_OPTS.maxPerRequester,
    );

    const worklist = (
      await getQuestionJudgingWorklist(tdb.db, {
        days: CONVERTED_QUESTIONS_WINDOW_DAYS,
        limit: QUESTION_JUDGE_PAGE_SIZE,
      })
    ).questions;
    expect(worklist.map((r) => r.query)).toContain(real);
    // No per-requester cap: the flood is judged too, rather than displacing.
    expect(worklist.filter((r) => r.query.startsWith('flood question')).length).toBe(60);
    // Deterministic gates still apply, so no judge call is spent on a row that
    // could never publish anyway.
    await makeQuestion('email alice@example.com about it', 'miss', hoursAgo(30), 'hash-z');
    await makeQuestion('zzq_probe_value_9137', 'miss', hoursAgo(30), 'hash-y');
    const gated = (
      await getQuestionJudgingWorklist(tdb.db, {
        days: CONVERTED_QUESTIONS_WINDOW_DAYS,
        limit: QUESTION_JUDGE_PAGE_SIZE,
      })
    ).questions.map((r) => r.query);
    expect(gated).not.toContain('email alice@example.com about it');
    expect(gated).not.toContain('zzq_probe_value_9137');
  });

  it('the judging worklist reaches the converted tier’s full 30-day window', async () => {
    // The converted tier is now verdict-gated, so a 20-day-old bought question
    // must still be in the worklist; the 7-day display window would miss it.
    const old = 'why does my x402 facilitator return 402 twice?';
    await makeSale(await makeQuestion(old, 'candidates', hoursAgo(20 * 24), 'buyer-a'));

    const wide = (
      await getQuestionJudgingWorklist(tdb.db, {
        days: CONVERTED_QUESTIONS_WINDOW_DAYS,
        limit: QUESTION_JUDGE_PAGE_SIZE,
      })
    ).questions;
    expect(wide.map((r) => r.query)).toContain(old);
    const narrow = (
      await getQuestionJudgingWorklist(tdb.db, {
        days: QUESTIONS_WINDOW_DAYS,
        limit: QUESTION_JUDGE_PAGE_SIZE,
      })
    ).questions;
    expect(narrow.map((r) => r.query)).not.toContain(old);
  });

  it('the pass PAGES past a cached prefix: already-judged rows cannot hold the newest out', async () => {
    // A verdict lives in Redis, so no SQL predicate can skip the already-judged.
    // With one fixed-size worklist slice the oldest N slots stay occupied by
    // cached rows forever and every newer question goes unjudged — and under
    // fail-closed, unpublished. Pages of 3 stand in for the production size.
    for (let i = 0; i < 7; i++) {
      await makeQuestion(`old judged question ${i}`, 'miss', hoursAgo(40 + i), `hash-${i}`);
      await allowQuestions(`old judged question ${i}`);
    }
    const newest = 'how do i rotate an embedding model without downtime?';
    await makeQuestion(newest, 'miss', hoursAgo(30), 'hash-new');

    let judged: string[] = [];
    const summary = await runQuestionJudgingPass(tdb.db, {
      judge: {
        model: 'stub-judge',
        judge: async ({ bodyMd }) => {
          judged.push(bodyMd);
          return { privateContext: false, rightsEncumbered: false, pii: false };
        },
      },
      provider: null,
      consumeJudgeBudget: async () => true,
      consumeEmbeddingBudget: async () => true,
      pageSize: 3,
      loadPage: (offset, limit) =>
        getQuestionJudgingWorklist(tdb.db, {
          days: CONVERTED_QUESTIONS_WINDOW_DAYS,
          limit,
          offset,
        }),
    });

    // The seven cached rows cost no judge call; the newest one is still reached.
    expect(judged).toEqual([newest]);
    expect(summary.cached).toBe(7);
    expect(summary.judged).toBe(1);
    expect((await getAgentQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toContain(newest);

    // A second pass finds everything cached and spends nothing.
    judged = [];
    const again = await runQuestionJudgingPass(tdb.db, {
      judge: {
        model: 'stub-judge',
        judge: async ({ bodyMd }) => {
          judged.push(bodyMd);
          return { privateContext: false, rightsEncumbered: false, pii: false };
        },
      },
      provider: null,
      consumeJudgeBudget: async () => true,
      consumeEmbeddingBudget: async () => true,
      pageSize: 3,
      loadPage: (offset, limit) =>
        getQuestionJudgingWorklist(tdb.db, {
          days: CONVERTED_QUESTIONS_WINDOW_DAYS,
          limit,
          offset,
        }),
    });
    expect(judged).toEqual([]);
    expect(again.judged).toBe(0);
    expect(again.cached).toBe(8);
  });

  it('a spent judge budget stops the pager instead of re-deferring every page', async () => {
    for (let i = 0; i < 9; i++) {
      await makeQuestion(`unjudged question ${i}`, 'miss', hoursAgo(40 + i), `hash-${i}`);
    }
    let pagesLoaded = 0;
    const summary = await runQuestionJudgingPass(tdb.db, {
      judge: {
        model: 'stub-judge',
        judge: async () => ({ privateContext: false, rightsEncumbered: false, pii: false }),
      },
      provider: null,
      // Two calls, then the daily window is spent.
      consumeJudgeBudget: (() => {
        let left = 2;
        return async () => left-- > 0;
      })(),
      consumeEmbeddingBudget: async () => true,
      pageSize: 3,
      loadPage: (offset, limit) => {
        pagesLoaded += 1;
        return getQuestionJudgingWorklist(tdb.db, {
          days: CONVERTED_QUESTIONS_WINDOW_DAYS,
          limit,
          offset,
        });
      },
    });
    expect(summary.judged).toBe(2);
    expect(summary.halted).toBe('judge-budget');
    // It stopped on the page that ran dry rather than walking all three.
    expect(pagesLoaded).toBe(1);
  });

  it('the worklist interleaves by requester: a backlog cannot monopolise the judge budget', async () => {
    // The starvation a global oldest-first FIFO allows. The attacker's rows are
    // OLDER than the real question by construction, and the daily judge budget is
    // finite, so pure min(created_at) order would judge only backlog for as long
    // as the backlog lasts and the real question would age out unjudged.
    for (let i = 0; i < 40; i++) {
      await makeQuestion(`backlog question ${i}`, 'miss', hoursAgo(200 + i), 'attacker');
    }
    const real = 'how do i pin a drizzle migration to a preview branch?';
    await makeQuestion(real, 'miss', hoursAgo(30), 'real-agent');

    const page = (
      await getQuestionJudgingWorklist(tdb.db, {
        days: CONVERTED_QUESTIONS_WINDOW_DAYS,
        limit: 3,
      })
    ).questions.map((r) => r.query);
    // Rank 1 for every requester comes first, so the real question is in the very
    // first page despite 40 older rows sitting in front of it by timestamp.
    expect(page).toContain(real);
  });

  it('pre-asking a target text does not bury it: a group takes its BEST asker rank', async () => {
    // Ranking by the group's FIRST asker would let a loaded hash own a text's
    // queue position forever: fill it with junk, then pre-ask the target under
    // it and the group sits at rank ~N where no later, cleaner asker can pull it
    // forward. Under best-rank a clean hash asking it ranks it 1.
    const target = 'how do i verify an erc-8004 identity onchain?';
    for (let i = 0; i < 20; i++) {
      await makeQuestion(`junk filler question ${i}`, 'miss', hoursAgo(300 + i), 'attacker');
    }
    // The attacker pre-asks the target LAST, so under first-asker ranking it
    // owns the group and lands at rank 21.
    await makeQuestion(target, 'miss', hoursAgo(280), 'attacker');
    // A real agent asks the same text later; it is that hash's first question.
    await makeQuestion(target, 'miss', hoursAgo(30), 'real-agent');

    const page = (
      await getQuestionJudgingWorklist(tdb.db, {
        days: CONVERTED_QUESTIONS_WINDOW_DAYS,
        limit: 3,
      })
    ).questions.map((r) => r.query);
    expect(page).toContain(target);
  });

  it('a store-read failure halts the pass instead of re-judging the whole worklist', async () => {
    // Round-2 finding: an outage read as an empty map is indistinguishable from
    // a page of brand-new questions, so the pager would burn the day's budget
    // judging rows that are already verdicted while every write failed too.
    for (let i = 0; i < 6; i++) {
      await makeQuestion(`question about x402 number ${i}`, 'miss', hoursAgo(30 + i), `hash-${i}`);
    }
    const readSpy = vi
      .spyOn(verdictStore, 'getQuestionVerdicts')
      .mockResolvedValue(null as unknown as Map<string, QuestionVerdict>);
    let judgeCalls = 0;
    const summary = await runQuestionJudgingPass(tdb.db, {
      judge: {
        model: 'stub-judge',
        judge: async () => {
          judgeCalls += 1;
          return { privateContext: false, rightsEncumbered: false, pii: false };
        },
      },
      provider: null,
      consumeJudgeBudget: async () => true,
      consumeEmbeddingBudget: async () => true,
      pageSize: 2,
    });
    expect(summary.halted).toBe('store-read');
    expect(judgeCalls).toBe(0);
    // One page attempted, not the whole worklist.
    expect(readSpy).toHaveBeenCalledTimes(1);
    readSpy.mockRestore();
  });

  it('the moderation queue ranks on FIRST ask, so a truncating caller sheds the already-live rows', async () => {
    // The cron emit keeps a byte-bounded PREFIX of this list, so position is the
    // veto window. `stale` published five days ago and being re-asked this
    // morning cannot buy it back the operator's attention; `fresh` has not
    // published at all yet and is the row a cut must not reach.
    await makeQuestion('stale question about rollups', 'miss', hoursAgo(120), 'hash-a');
    await makeQuestion('stale question about rollups', 'miss', hoursAgo(1), 'hash-b');
    await makeQuestion('fresh question about rollups', 'miss', hoursAgo(2), 'hash-c');

    expect(
      (await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions.map((r) => r.query),
    ).toEqual(['fresh question about rollups', 'stale question about rollups']);
  });

  it('the moderation queue reports the window total, not the size of the slice it returns', async () => {
    // `matched` is what the cron emit logs as `count`. Read off the page rather
    // than off `questions`, which the limit caps: a limit-sized page must still
    // say how many questions it is not naming.
    for (let i = 0; i < 4; i++) {
      await makeQuestion(`distinct question number ${i}`, 'miss', hoursAgo(30 + i), `hash-${i}`);
    }

    const page = await getPendingAgentQuestions(tdb.db, { ...QUESTION_OPTS, limit: 2 });
    expect(page.questions).toHaveLength(2);
    expect(page.matched).toBe(4);
  });

  it('the moderation queue drops the delay and the verdict, so it names what each tier hides', async () => {
    // Under the limit, so this is the gate difference and not the slice: the
    // queue is not a superset in general (its own limit cuts a differently
    // ordered population), which is why the containment check below is scoped to
    // a fixture no limit reaches.
    // One of each verdict state, all past the delay: allowed, denied, unjudged.
    await makeQuestion('allowed question about x402', 'candidates', hoursAgo(30), 'hash-a');
    await makeQuestion('denied question about x402', 'miss', hoursAgo(30), 'hash-b');
    await makeQuestion('unjudged question about x402', 'miss', hoursAgo(30), 'hash-c');
    await allowQuestions('allowed question about x402');
    await storeQuestionVerdict(
      normalizeQuery('denied question about x402'),
      allowingVerdict({ privateContext: true }),
    );

    const pending = (await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions.map(
      (r) => r.query,
    );
    for (const tier of [getAgentQuestions, getWaitingQuestions, getAnsweredQuestions]) {
      for (const row of await tier(tdb.db, QUESTION_OPTS)) {
        expect(pending).toContain(row.query);
      }
    }
    expect((await getAgentQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'allowed question about x402',
    ]);
    expect(pending.sort()).toEqual([
      'allowed question about x402',
      'denied question about x402',
      'unjudged question about x402',
    ]);
  });

  it('getWaitingQuestions: unanswered only, ranked by distinct askers across the window', async () => {
    // Ranked by askers, NOT recency.
    for (const hmac of ['a', 'b', 'c']) {
      await makeQuestion('three sources want this', 'miss', hoursAgo(40), `hash-${hmac}`);
    }
    for (const hmac of ['d', 'e']) {
      await makeQuestion('two sources want this', 'miss', hoursAgo(30), `hash-${hmac}`);
    }
    // Answered, so it belongs to the other tier however much demand it carries.
    for (const hmac of ['f', 'g', 'h', 'i']) {
      await makeQuestion('this one found a piece', 'candidates', hoursAgo(35), `hash-${hmac}`);
    }
    await allowQuestions(
      'three sources want this',
      'two sources want this',
      'this one found a piece',
    );

    const waiting = await getWaitingQuestions(tdb.db, QUESTION_OPTS);
    expect(waiting.map((r) => [r.query, r.requesters])).toEqual([
      ['three sources want this', 3],
      ['two sources want this', 2],
    ]);

    const answered = await getAnsweredQuestions(tdb.db, QUESTION_OPTS);
    expect(answered.map((r) => r.query)).toEqual(['this one found a piece']);
  });

  it('getWaitingQuestions: ranks over the WINDOW, not over the newest `limit` rows', async () => {
    // What a TS sort over a newest-first page cannot do: the most-asked question
    // is the OLDEST, past a limit-sized run of newer ones. SIX decoys against
    // `limit: 2`, so the grouped subquery's own LIMIT (limit * OVERSCAN = 4)
    // truncates: without an ORDER BY inside it, the row under test is one of the
    // groups the aggregate is free to drop before the outer sort ever sees it.
    for (const hmac of ['a', 'b', 'c', 'd']) {
      await makeQuestion('the oldest and most asked', 'miss', hoursAgo(60), `hash-${hmac}`);
    }
    for (let i = 0; i < 6; i++) {
      await makeQuestion(`newer question ${i}`, 'miss', hoursAgo(30 - i), 'hash-x');
      await makeQuestion(`newer question ${i}`, 'miss', hoursAgo(29 - i), 'hash-y');
    }
    await allowQuestions(
      'the oldest and most asked',
      ...[0, 1, 2].map((i) => `newer question ${i}`),
    );

    const waiting = await getWaitingQuestions(tdb.db, { ...QUESTION_OPTS, limit: 2 });
    expect(waiting[0]!.query).toBe('the oldest and most asked');
  });

  it('#705: a miss the asking agent settled itself leaves Still waiting for NO other tier', async () => {
    await makeQuestion('nobody has answered this one', 'miss', hoursAgo(40), 'hash-a');
    await makeQuestion('nobody has answered this one', 'miss', hoursAgo(39), 'hash-b');
    const firstAsker = await makeQuestion(
      'the agent worked this one out itself',
      'miss',
      hoursAgo(38),
      'hash-c',
    );
    const latest = await makeQuestion(
      'the agent worked this one out itself',
      'miss',
      hoursAgo(37),
      'hash-d',
    );
    // Both verdicted, so the settled drop is the only thing that can move either.
    await allowQuestions('nobody has answered this one', 'the agent worked this one out itself');

    // Both are open demand until the outcomes land.
    expect((await getWaitingQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query).sort()).toEqual([
      'nobody has answered this one',
      'the agent worked this one out itself',
    ]);

    await makeOutcome(latest, 'regenerated', hoursAgo(36));

    // One asker settling speaks for that asker alone: the other still wants an
    // answer, so the question stays exactly where it was.
    expect((await getWaitingQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query).sort()).toEqual([
      'nobody has answered this one',
      'the agent worked this one out itself',
    ]);

    await makeOutcome(firstAsker, 'regenerated', hoursAgo(35));

    // Gone from Still waiting, and NOT promoted into Answered recently: Tenjin
    // never answered it, the agent did.
    expect((await getWaitingQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'nobody has answered this one',
    ]);
    expect(await getAnsweredQuestions(tdb.db, QUESTION_OPTS)).toEqual([]);
    // And off the landing strip's tier too, which publishes the same rollup.
    expect((await getAgentQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'nobody has answered this one',
    ]);
    // The moderation queue does not apply the settled drop: a settled question
    // republishes the moment it is asked again, so an operator must still see it.
    expect(
      (await getPendingAgentQuestions(tdb.db, QUESTION_OPTS)).questions.map((r) => r.query).sort(),
    ).toEqual(['nobody has answered this one', 'the agent worked this one out itself']);
  });

  it('#705: a rejected outcome settles it too, and a used one leaves the tiers alone', async () => {
    const firstReject = await makeQuestion('this one was rejected', 'miss', hoursAgo(40), 'hash-a');
    const rejected = await makeQuestion('this one was rejected', 'miss', hoursAgo(39), 'hash-b');
    await makeQuestion('this one found a piece', 'candidates', hoursAgo(38), 'hash-c');
    const used = await makeQuestion('this one found a piece', 'candidates', hoursAgo(37), 'hash-d');
    await makeOutcome(firstReject, 'rejected', hoursAgo(36));
    await makeOutcome(rejected, 'rejected', hoursAgo(36));
    await makeOutcome(used, 'used', hoursAgo(36));
    await allowQuestions('this one was rejected', 'this one found a piece');

    expect(await getWaitingQuestions(tdb.db, QUESTION_OPTS)).toEqual([]);
    expect((await getAnsweredQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'this one found a piece',
    ]);
  });

  it('#705: a new ask republishes a settled question, and the queue never lost it', async () => {
    const first = await makeQuestion(
      'both askers settled this one',
      'miss',
      hoursAgo(40),
      'hash-a',
    );
    const second = await makeQuestion(
      'both askers settled this one',
      'miss',
      hoursAgo(39),
      'hash-b',
    );
    await makeOutcome(first, 'regenerated', hoursAgo(38));
    await makeOutcome(second, 'regenerated', hoursAgo(37));
    await allowQuestions('both askers settled this one');

    expect(await getWaitingQuestions(tdb.db, QUESTION_OPTS)).toEqual([]);

    // Asked again, by one of the same two sources: that requester's latest ask
    // carries no outcome any more, so the demand is open again. The republication
    // rests on the coalesce that keeps an unreported lookup out of the settled
    // set, which is why it gets its own test.
    await makeQuestion('both askers settled this one', 'miss', hoursAgo(1), 'hash-a');

    expect((await getWaitingQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'both askers settled this one',
    ]);
  });

  it('#705/#706: a replayed ask cannot settle the group or name the piece it links', async () => {
    // The question is published verbatim and a search is anonymous, so anyone can
    // own the group's NEWEST lookup by sending the sentence back and then report
    // whatever they like against it. Neither gate keys on that lookup.
    const creator = must(await makeCreator(tdb, { handle: 'ada' }), 'ada');
    const planted = must(
      await makePost(tdb, creator, {
        status: 'published',
        publishedAt: new Date(),
        slug: 'planted',
        title: 'Planted',
      }),
      'planted post',
    );
    for (const hmac of ['hash-a', 'hash-b']) {
      await makeQuestion('two sources are still waiting for this', 'miss', hoursAgo(40), hmac);
      await makeQuestion('two sources found a piece for this', 'candidates', hoursAgo(39), hmac);
    }
    // One search and one 202 per group, which is the whole attack.
    const suppress = await makeQuestion(
      'two sources are still waiting for this',
      'miss',
      hoursAgo(2),
      'hash-replay',
    );
    await makeOutcome(suppress, 'regenerated', hoursAgo(1));
    const place = await makeQuestion(
      'two sources found a piece for this',
      'candidates',
      hoursAgo(2),
      'hash-replay',
    );
    await makeOutcome(place, 'used', hoursAgo(1), planted.id);
    // Both strings verdicted, so the corroboration floor and the per-requester
    // settled test are the only things the replay can be measured against.
    await allowQuestions(
      'two sources are still waiting for this',
      'two sources found a piece for this',
    );

    // The two real askers still want it, so it still publishes as open demand.
    expect((await getWaitingQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'two sources are still waiting for this',
    ]);
    // And the answered row publishes with NO piece: one report is not
    // corroboration, and there is no rank-1 fallback to steer either.
    const [row] = await getAnsweredQuestions(tdb.db, QUESTION_OPTS);
    expect(must(row, 'answered row').query).toBe('two sources found a piece for this');
    expect(row).not.toHaveProperty('post');
  });

  it('#706: repeat reports of one piece never outrank another the same sources corroborated', async () => {
    // Nothing dedupes lookup_outcomes, so a row count is the one number in this
    // path an actor can inflate alone. Two pieces, the same two requesters behind
    // each, and one of them reported over and over: the tie breaks on the id, so
    // the spun-up rows decide nothing.
    const creator = must(await makeCreator(tdb, { handle: 'ada' }), 'ada');
    const posts = await Promise.all(
      ['quiet', 'spammed'].map(async (slug) =>
        must(
          await makePost(tdb, creator, {
            status: 'published',
            publishedAt: new Date(),
            slug,
            title: slug,
          }),
          `${slug} post`,
        ),
      ),
    );
    const [quiet, spammed] = posts as [(typeof posts)[0], (typeof posts)[0]];
    const first = await makeQuestion('which piece wins the tie', 'candidates', hoursAgo(40), 'r-a');
    const second = await makeQuestion(
      'which piece wins the tie',
      'candidates',
      hoursAgo(39),
      'r-b',
    );
    for (const lookup of [first, second]) {
      await makeOutcome(lookup, 'used', hoursAgo(38), quiet.id);
      await makeOutcome(lookup, 'used', hoursAgo(38), spammed.id);
    }
    for (let i = 0; i < 8; i++) {
      await makeOutcome(second, 'used', hoursAgo(37), spammed.id);
    }
    await allowQuestions('which piece wins the tie');

    const [row] = await getAnsweredQuestions(tdb.db, QUESTION_OPTS);
    const expected = quiet.id < spammed.id ? 'quiet' : 'spammed';
    expect(must(row, 'answered row').post?.slug).toBe(expected);
  });

  it('#705: the outcome and candidate probes never inflate the published requester count', async () => {
    // The fan-out a join BEFORE the GROUP BY would cause: one lookup carrying
    // three outcome rows and three candidate rows would multiply the group's rows
    // ninefold and publish `asked by 18` for two askers.
    const creator = must(await makeCreator(tdb, {}), 'creator');
    const offers = await Promise.all([
      makePost(tdb, creator, { status: 'published', publishedAt: new Date() }),
      makePost(tdb, creator, { status: 'published', publishedAt: new Date() }),
      makePost(tdb, creator, { status: 'published', publishedAt: new Date() }),
    ]);
    await makeQuestion('how many sources asked this', 'candidates', hoursAgo(40), 'hash-a');
    const latest = await makeQuestion(
      'how many sources asked this',
      'candidates',
      hoursAgo(39),
      'hash-b',
    );
    for (const [i, offer] of offers.entries()) {
      const post = must(offer, 'offered post');
      await makeOutcome(latest, 'used', hoursAgo(38 - i), post.id);
      await makeCandidate(latest, post.id, i + 1);
    }
    await allowQuestions('how many sources asked this');

    const rows = await getAnsweredQuestions(tdb.db, QUESTION_OPTS);
    expect(rows.map((r) => [r.query, r.requesters])).toEqual([['how many sources asked this', 2]]);
  });

  it('#706: an answered question links the piece its askers reported, never the one we offered', async () => {
    const creator = must(await makeCreator(tdb, { handle: 'ada' }), 'ada');
    const offered = must(
      await makePost(tdb, creator, {
        status: 'published',
        publishedAt: new Date(),
        slug: 'offered',
        title: 'Offered',
      }),
      'offered post',
    );
    const used = must(
      await makePost(tdb, creator, {
        status: 'published',
        publishedAt: new Date(),
        slug: 'used',
        title: 'What served it',
      }),
      'used post',
    );

    const firstAsk = await makeQuestion(
      'which piece served this',
      'candidates',
      hoursAgo(40),
      'hash-a',
    );
    const confirmed = await makeQuestion(
      'which piece served this',
      'candidates',
      hoursAgo(39),
      'hash-b',
    );
    await makeCandidate(confirmed, offered.id, 1);
    // Two independent sources reported the same piece, which is the bar. What we
    // OFFERED links nothing, whatever rank we gave it.
    await makeOutcome(firstAsk, 'used', hoursAgo(38), used.id);
    await makeOutcome(confirmed, 'partially_used', hoursAgo(38), used.id);

    // The same shape one report short of corroboration, and offered a piece on
    // top: it publishes as a question, unlinked.
    await makeQuestion('which piece did we offer', 'candidates', hoursAgo(36), 'hash-c');
    const unreported = await makeQuestion(
      'which piece did we offer',
      'candidates',
      hoursAgo(35),
      'hash-d',
    );
    await makeCandidate(unreported, offered.id, 1);
    await makeOutcome(unreported, 'used', hoursAgo(34), offered.id);
    await allowQuestions('which piece served this', 'which piece did we offer');

    const rows = await getAnsweredQuestions(tdb.db, QUESTION_OPTS);
    expect(rows.map((r) => [r.query, r.post])).toEqual([
      ['which piece did we offer', undefined],
      ['which piece served this', { title: 'What served it', slug: 'used', handle: 'ada' }],
    ]);
  });

  it('#706: an undiscoverable piece or a handle-less creator publishes the question unlinked', async () => {
    const creator = must(await makeCreator(tdb, { handle: 'ada' }), 'ada');
    const draft = must(await makePost(tdb, creator, { status: 'draft' }), 'draft post');
    const deleted = must(await makePost(tdb, creator, { status: 'deleted' }), 'deleted post');
    // The one status that KEEPS a live /a/ permalink while leaving every listing
    // (lib/post-visibility.ts): a future swap to readablePostStatuses would
    // publish it onto /trending, and this row is what refuses that.
    const unlisted = must(
      await makePost(tdb, creator, { status: 'unlisted', publishedAt: new Date() }),
      'unlisted post',
    );
    const anonymous = must(await makeCreator(tdb, {}), 'handle-less creator');
    await tdb.db.update(creators).set({ handle: null }).where(eq(creators.id, anonymous.id));
    const unlinkable = must(
      await makePost(tdb, anonymous, { status: 'published', publishedAt: new Date() }),
      'handle-less post',
    );

    // A requester pair per status, because four questions behind one pair would
    // hit QUESTIONS_MAX_PER_REQUESTER and drop the fourth for the wrong reason.
    for (const [i, post] of [draft, deleted, unlisted, unlinkable].entries()) {
      const first = await makeQuestion(
        `question ${i}`,
        'candidates',
        hoursAgo(40 - i),
        `ask-a${i}`,
      );
      const latest = await makeQuestion(
        `question ${i}`,
        'candidates',
        hoursAgo(30 - i),
        `ask-b${i}`,
      );
      await makeCandidate(latest, post.id, 1);
      // Corroborated by both askers, so the visibility gate is the only thing
      // left that can keep the link off the row.
      await makeOutcome(first, 'used', hoursAgo(10), post.id);
      await makeOutcome(latest, 'used', hoursAgo(10), post.id);
      await allowQuestions(`question ${i}`);
    }

    const rows = await getAnsweredQuestions(tdb.db, QUESTION_OPTS);
    expect(rows).toHaveLength(4);
    // No `post` key at all rather than a half-built one: nothing downstream can
    // assemble a dead permalink out of it.
    for (const row of rows) expect(row).not.toHaveProperty('post');
  });

  it('#706: a waiting question never carries a piece, however it was offered one', async () => {
    const creator = must(await makeCreator(tdb, { handle: 'ada' }), 'ada');
    const post = must(
      await makePost(tdb, creator, { status: 'published', publishedAt: new Date() }),
      'post',
    );
    const first = await makeQuestion('still waiting on this', 'miss', hoursAgo(40), 'hash-a');
    const latest = await makeQuestion('still waiting on this', 'miss', hoursAgo(39), 'hash-b');
    await makeCandidate(latest, post.id, 1);
    // Offered a piece AND reported one by both askers: a waiting row still
    // carries none, because the link means "this is what answered it".
    await makeOutcome(first, 'used', hoursAgo(38), post.id);
    await makeOutcome(latest, 'used', hoursAgo(38), post.id);
    await allowQuestions('still waiting on this');

    const [row] = await getWaitingQuestions(tdb.db, QUESTION_OPTS);
    expect(must(row, 'waiting row').query).toBe('still waiting on this');
    expect(row).not.toHaveProperty('post');
  });

  it('getAgentQuestions: the window is 7 days, shorter than the term tiers', async () => {
    await makeQuestion('inside the window', 'miss', hoursAgo(6 * 24), 'hash-a');
    await makeQuestion('inside the window', 'miss', hoursAgo(6 * 24 - 1), 'hash-b');
    await makeQuestion('outside the window', 'miss', hoursAgo(8 * 24), 'hash-c');
    await makeQuestion('outside the window', 'miss', hoursAgo(8 * 24 - 1), 'hash-d');
    await allowQuestions('inside the window', 'outside the window');

    expect((await getAgentQuestions(tdb.db, QUESTION_OPTS)).map((r) => r.query)).toEqual([
      'inside the window',
    ]);
  });
});

/** The UTC calendar day the rollup publishes for an instant. */
function utcDayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** SEARCHER_A's attribution, varying only the User-Agent under test. */
const uaAttribution = (userAgent: string): RequestAttribution => ({
  requesterHmac: SEARCHER_A,
  rateLimitKey: SEARCHER_A,
  clientName: null,
  clientVersion: null,
  transport: 'http',
  userAgent,
});

interface LoggedRow {
  source: string;
  resultCount: number;
  searcherHash: string;
  matchCount: number | null;
  requestedLimit: number | null;
  sort: string | null;
  tag: string | null;
  creator: string | null;
  minPrice: bigint | null;
  maxPrice: bigint | null;
  userAgent: string | null;
  clientName: string | null;
  clientVersion: string | null;
  transport: string | null;
}

async function waitForSearchRow(query: string): Promise<LoggedRow | undefined> {
  for (let i = 0; i < 40; i++) {
    const [row] = await tdb.db
      .select({
        source: searchQueries.source,
        resultCount: searchQueries.resultCount,
        searcherHash: searchQueries.searcherHash,
        matchCount: searchQueries.matchCount,
        requestedLimit: searchQueries.requestedLimit,
        sort: searchQueries.sort,
        tag: searchQueries.tag,
        creator: searchQueries.creator,
        minPrice: searchQueries.minPrice,
        maxPrice: searchQueries.maxPrice,
        userAgent: searchQueries.userAgent,
        clientName: searchQueries.clientName,
        clientVersion: searchQueries.clientVersion,
        transport: searchQueries.transport,
      })
      .from(searchQueries)
      .where(and(eq(searchQueries.query, query)))
      .limit(1);
    if (row) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}
