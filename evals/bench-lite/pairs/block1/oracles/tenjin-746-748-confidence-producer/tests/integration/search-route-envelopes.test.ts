// The four search surfaces now share one module, so the thing worth pinning
// across them is the boundary the module must NOT move: each route's top-level
// response envelope. The per-route suites already assert content in depth; this
// file asserts the SHAPE, in one place, so a change inside lib/search that adds
// or drops a top-level field on any surface fails here rather than in whichever
// client notices first.
//
// It is deliberately a key-set assertion and not a full-body snapshot: bodies
// carry ids, timestamps and prices that churn for reasons that are not contract
// changes, and a snapshot people re-bless on every unrelated diff guards nothing.
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import * as schema from '@/lib/db/schema';
import { withApi } from '@/lib/api';
import { __resetRateLimitForTest } from '@/lib/rate-limit';
import { __resetQueryCacheForTest } from '@/lib/search/query-cache';
import { createSearchHandler } from '@/app/api/agent/search/route';
import { createArticlesHandler } from '@/app/api/articles/route';
import { createUnifiedSearchHandler } from '@/app/api/search/route';
import { embedPostContent } from '@/lib/content-embeddings';
import type { EmbeddingProvider } from '@/lib/embeddings';
import { startTestDb, stopTestDb, describeIntegration, type TestDb } from './_support/db';
import { makeCreator, makePost } from './_support/fixtures';
import { must } from './_support/assert';
import { createInlineScheduler } from './_support/scheduler';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await startTestDb();
}, 60_000);

afterAll(async () => {
  if (tdb) await stopTestDb(tdb);
});

beforeEach(async () => {
  // The query-embedding cache is process-global; without this a vector cached
  // by an earlier case makes a later degrade case serve hybrid from memory.
  __resetQueryCacheForTest();
  await tdb.db.execute(
    sql`TRUNCATE TABLE ${schema.creators}, ${schema.lookups}, ${schema.searchQueries} CASCADE`,
  );
  __resetRateLimitForTest();
});

const { runInline } = createInlineScheduler();
const TERM = 'envelopeterm';

// A sentence that exists ONLY inside the paid body. Any surface that echoes it,
// or any score derived from it, is the non-surfacing boundary breaking.
const BODY_SECRET = 'the settlement window closes at four seventeen utc';

const NEAR = (() => {
  const v = new Array<number>(1536).fill(0);
  v[0] = 1;
  return v;
})();

// Every text embeds to the same vector, so the seeded post is a guaranteed dense
// hit: this file is pinning what a MATCH discloses, not what ranking picks.
const denseStub: EmbeddingProvider = {
  model: 'stub-embed',
  embed: async (texts) => texts.map(() => NEAR),
};

async function seedMatch(opts: { embedBody?: boolean; eligible?: boolean } = {}) {
  const creator = must(await makeCreator(tdb), 'creator');
  const post = must(
    await makePost(tdb, creator, {
      status: 'published',
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      title: `The ${TERM} guide`,
      bodyMd: `${BODY_SECRET}\n\nMore paid prose about ${TERM}.`,
    }),
    'post',
  );
  await tdb.db
    .insert(schema.resourceMetadata)
    .values({ postId: post.id, cacheEligible: true, questionsAnswered: [`how does ${TERM} work`] });
  if (opts.embedBody) await embedPostContent(tdb.db, denseStub, post.id);
  // Applied AFTER embedding, so the content vectors linger. An ineligible card is
  // now a BOTTOM-TIER decision candidate rather than an excluded one, so the MISS
  // case below reaches the tail through an appliesTo filter this seed cannot
  // answer; the flag keeps the browse pointer honest about what it points at.
  if (opts.eligible === false) {
    await tdb.db
      .update(schema.resourceMetadata)
      .set({ cacheEligible: false })
      .where(sql`${schema.resourceMetadata.postId} = ${post.id}`);
  }
  return post;
}

// Field names that would carry a matched fragment or a raw per-result number.
// The dense legs rank on paid body chunks (#628), so the thing that keeps the
// paywall standing is that nothing chunk-derived — not the text, not an offset,
// not a raw score or cosine similarity — is ever serialized. A key-set deny-list
// catches the accidental spread (`...row`) that would leak `distance`,
// `similarity`, or a chunk field straight off a dense row.
const FORBIDDEN_KEYS = [
  'distance',
  'similarity',
  'score',
  'relevance',
  'snippet',
  'snippets',
  'highlight',
  'highlights',
  'chunk',
  'chunks',
  'chunkIdx',
  'embedding',
  'vector',
  'textHash',
  'bodyMd',
  'matchedText',
];

// The decision candidate's two exceptions to FORBIDDEN_KEYS: a coarse
// high/medium/low bucket and a boolean, never a raw number (project.ts
// deriveConfidence/deriveCorroborated). Every OTHER surface (display, suggest,
// browse) must still never carry either — see expectNeverSurfacing below, which
// denies FORBIDDEN_KEYS plus these.
const CONFIDENCE_KEYS = ['confidence', 'corroborated'];

function forbiddenKeysIn(value: unknown, deny: string[], path = '$'): string[] {
  if (Array.isArray(value))
    return value.flatMap((v, i) => forbiddenKeysIn(v, deny, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (deny.includes(key)) found.push(`${path}.${key}`);
    found.push(...forbiddenKeysIn(child, deny, `${path}.${key}`));
  }
  return found;
}

/** The chunk-leak assertion: no chunk text/offset, on any surface. `rows` proves
 *  non-emptiness FIRST — every assertion below passes trivially on a response
 *  that returned nothing, so a fixture that stops matching would turn all five
 *  guards green while checking nothing at all. */
function expectNonSurfacing(body: unknown, rows: unknown) {
  expect(Array.isArray(rows) ? rows.length : 0).toBeGreaterThan(0);
  expect(forbiddenKeysIn(body, FORBIDDEN_KEYS)).toEqual([]);
  expect(JSON.stringify(body)).not.toContain(BODY_SECRET);
}

/** The stricter form for a surface that must never carry a confidence bucket
 *  either (display, suggest, the MISS browse tail — none of them are a scored
 *  candidate). */
function expectNeverSurfacing(body: unknown, rows: unknown) {
  expect(Array.isArray(rows) ? rows.length : 0).toBeGreaterThan(0);
  expect(forbiddenKeysIn(body, [...FORBIDDEN_KEYS, ...CONFIDENCE_KEYS])).toEqual([]);
  expect(JSON.stringify(body)).not.toContain(BODY_SECRET);
}

const keys = (o: unknown) => Object.keys(o as Record<string, unknown>).sort();

describeIntegration('search route envelopes', () => {
  it('POST /api/agent/search — CANDIDATES carries the v2 envelope plus the inline card', async () => {
    await seedMatch();
    // embedder pinned to null: the default reads OPENAI_API_KEY off the ambient
    // env, which would make this depend on whose shell it runs in.
    const res = await withApi(
      '/test',
      createSearchHandler(tdb.db, runInline, null),
    )(
      new NextRequest('https://tenjin.xyz/api/agent/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 2, question: TERM }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(keys(body)).toEqual(
      ['calibration', 'candidates', 'decision', 'inspect', 'schemaVersion', 'searchId'].sort(),
    );
    expect(keys(body.candidates[0])).toEqual(
      [
        'artifactType',
        'asOf',
        'creator',
        'estimatedTokens',
        'excerpt',
        'matchReasons',
        'price',
        'resourceId',
        'slug',
        'temporalMode',
        'title',
        'url',
        'validUntil',
      ].sort(),
    );
    // The lexical-only path never fuses, so there is nothing to derive
    // `confidence`/`corroborated` from — pin the absence over the wire, not
    // just in-process.
    expect(body.calibration).toBe('lexical-v1');
    expect('confidence' in body.candidates[0]).toBe(false);
    expect('corroborated' in body.candidates[0]).toBe(false);
  });

  it('POST /api/agent/search — MISS omits candidates and keeps the four always-present fields', async () => {
    const res = await withApi(
      '/test',
      createSearchHandler(tdb.db, runInline, null),
    )(
      new NextRequest('https://tenjin.xyz/api/agent/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 2, question: 'nothingmatchesthisatall' }),
      }),
    );
    const body = await res.json();
    expect(body.decision).toBe('MISS');
    expect(keys(body)).toEqual(['calibration', 'decision', 'schemaVersion', 'searchId']);
  });

  it('GET /api/articles?q= — the B3 list envelope, unchanged by the query path', async () => {
    await seedMatch();
    const res = await withApi(
      '/test',
      createArticlesHandler(tdb.db, runInline, null),
    )(new NextRequest(`https://tenjin.xyz/api/articles?q=${TERM}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(keys(body)).toContain('items');
    expect(body.items.length).toBeGreaterThan(0);
    // The search path must not introduce a field the plain feed lacks.
    const plain = await withApi(
      '/test',
      createArticlesHandler(tdb.db, runInline, null),
    )(new NextRequest('https://tenjin.xyz/api/articles'));
    expect(keys(body)).toEqual(keys(await plain.json()));
  });

  // #628: ranking moved onto paid body chunks, so "we never surface it" stopped
  // being a property of what is INDEXED and became a property of what is
  // SERIALIZED. These pin that on every surface at once.
  it('decision (v2) discloses a coarse confidence bucket but no chunk text or raw score, on a dense hit', async () => {
    await seedMatch({ embedBody: true });
    const res = await withApi(
      '/test',
      createSearchHandler(tdb.db, runInline, denseStub),
    )(
      new NextRequest('https://tenjin.xyz/api/agent/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 2, question: TERM }),
      }),
    );
    const body = await res.json();
    expect(body.decision).toBe('CANDIDATES');
    expectNonSurfacing(body, body.candidates);
    // The two deliberate exceptions (2026-08-22): a dense hit's confidence
    // bucket and whether the lexical leg also matched ARE meant to serialize
    // here, as coarse labels — never the raw score/cosine (both stay in
    // FORBIDDEN_KEYS above, so expectNonSurfacing already denies them). The
    // seed title contains the query term, so this is a corroborated hit.
    expect(['high', 'medium', 'low']).toContain(body.candidates[0].confidence);
    expect(body.candidates[0].corroborated).toBe(true);
  });

  it('decision (v3) discloses a coarse confidence bucket but no chunk text or raw score, on a dense hit', async () => {
    await seedMatch({ embedBody: true });
    const res = await withApi(
      '/test',
      createUnifiedSearchHandler(tdb.db, runInline, denseStub),
    )(
      new NextRequest('https://tenjin.xyz/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ view: 'decision', query: TERM }),
      }),
    );
    const body = await res.json();
    expectNonSurfacing(body, body.items);
    expect(['high', 'medium', 'low']).toContain(body.items[0].confidence);
    expect(body.items[0].corroborated).toBe(true);
  });

  it('display discloses no score and no body text, even on a dense hit', async () => {
    await seedMatch({ embedBody: true });
    const res = await withApi(
      '/test',
      createUnifiedSearchHandler(tdb.db, runInline, denseStub),
    )(
      new NextRequest('https://tenjin.xyz/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ view: 'display', query: TERM }),
      }),
    );
    const body = await res.json();
    expectNeverSurfacing(body, body.items);
  });

  it('suggest discloses no score and no body text', async () => {
    await seedMatch({ embedBody: true });
    const res = await withApi(
      '/test',
      createUnifiedSearchHandler(tdb.db, runInline, denseStub),
    )(
      new NextRequest('https://tenjin.xyz/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ view: 'suggest', query: TERM }),
      }),
    );
    const body = await res.json();
    expectNeverSurfacing(body, body.items);
  });

  it('the MISS browse tail discloses no score and no body text', async () => {
    await seedMatch({ embedBody: true, eligible: false });
    const res = await withApi(
      '/test',
      createSearchHandler(tdb.db, runInline, denseStub),
    )(
      new NextRequest('https://tenjin.xyz/api/agent/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 2,
          question: 'zzzznothinglexical',
          // The seed attests no applicability, so this filter drops it from the
          // candidate legs by NULL propagation. Browse applies no such filter.
          appliesTo: { products: ['zzznosuchproduct'] },
        }),
      }),
    );
    const body = await res.json();
    expect(body.decision).toBe('MISS');
    expectNeverSurfacing(body, body.browse);
  });
});
