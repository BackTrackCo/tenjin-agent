// Route-level coverage for the hybrid (lexical + dense) path of the decision view
// of POST /api/search (#447), against testcontainer Postgres with pgvector. A
// deterministic stub embedder replaces OpenAI: body chunk texts and queries are
// mapped to fixed unit vectors so designated paraphrase pairs are NEAR (cosine 1)
// and everything else is FAR (cosine 0), which makes dense hits, the cosine
// floor, and RRF fusion assertable without a live model.
//
// Covers: a dense-only hit surfaces as CANDIDATES with a 'semantic match' reason
// and calibration 'hybrid-v1'; the cosine gate abstains just under the floor and
// admits just over it, whatever the floor is set to; the dense leg carries the
// SAME gates as the lexical one (appliesTo hard, cache-eligibility softened to a
// ranking tier); the flag-off path is byte-for-byte lexical-v1; an embedder
// failure degrades to lexical; and RRF ranks a both-legs post above single-leg
// posts.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { uuidv7 } from 'uuidv7';
import * as schema from '@/lib/db/schema';
import { withApi } from '@/lib/api';
import { __setLogDestinationForTest } from '@/lib/log';
import { __resetRateLimitForTest } from '@/lib/rate-limit';
import { __resetQueryCacheForTest } from '@/lib/search/query-cache';
import { type EmbeddingProvider } from '@/lib/embeddings';
import { contentChunks } from '@/lib/content-chunks';
import { embedPostContent } from '@/lib/content-embeddings';
import { DENSE_COSINE_SIMILARITY_FLOOR } from '@/lib/search';
import { searchQuery } from '@/lib/search/retrieve/tsquery';
import { createUnifiedSearchHandler } from '@/app/api/search/route';
import {
  atCosine,
  basis,
  concept,
  conceptVector,
  DIM,
  FAR,
  mix,
  reset as resetStubEmbedder,
  stub,
  throwingStub,
} from './_support/embedder';
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
  await tdb.db.execute(sql`TRUNCATE TABLE ${schema.creators}, ${schema.lookups} CASCADE`);
  __resetRateLimitForTest();
  resetStubEmbedder();
});

const { runInline, flush } = createInlineScheduler();

interface LookupBody {
  // The wire field is searchId (renamed from lookupId by #463); storage still
  // keys the row on lookups.id, so this id is what stored() looks up.
  searchId: string;
  calibration: string;
  items: Array<{ resourceId: string; matchReasons: string[] }>;
  matched: number;
}

function lookupReq(body: unknown): NextRequest {
  return new NextRequest('https://tenjin.xyz/api/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
async function lookup(
  body: unknown,
  embedder: EmbeddingProvider | null = stub,
): Promise<LookupBody> {
  const res = await withApi(
    '/test',
    createUnifiedSearchHandler(tdb.db, runInline, embedder),
  )(lookupReq(body));
  return (await res.json()) as LookupBody;
}

async function makeResource(
  postId: string,
  over: Partial<typeof schema.resourceMetadata.$inferInsert> = {},
) {
  const [row] = await tdb.db
    .insert(schema.resourceMetadata)
    .values({ postId, cacheEligible: true, ...over })
    .returning();
  return must(row, 'resource');
}

// One eligible candidate whose card carries `questions` and whose BODY carries
// the same text. The dense legs read content_embeddings (#628), so the concept a
// case registers against questions[0] is re-registered against every chunk text
// the body yields, and the post answers to that vector. embed:false leaves it
// vector-less.
//
// The body must be UNIQUE per post: contentChunks is a pure function of (title,
// body), and the concept registry is keyed by text, so two posts with the same body would
// collapse to one map entry and every post would answer to the last vector
// written. Body text used to stay out of the LEXICAL leg because search_tsv's
// weight-D slot was `price = 0 ? body_md : body_md_preview` and these fixtures
// are paid with no preview written. 0049 ended that: the whole body is indexed
// for both price arms, so the body text IS lexically reachable now. What keeps
// the dense cases honest is therefore the QUERY, not the fixture — a paraphrase
// shares no indexed word with the piece it is meant to find — and the guard case
// below asserts exactly that.
//
// eligible:false / status:'unlisted' are applied AFTER embedding: embedPostContent
// deletes the vectors of an undiscoverable post, and the point of both is a post
// whose vectors LINGER while the post itself has dropped to the bottom candidate
// tier (eligible:false) or left discovery entirely (unlisted, which the tail must
// exclude).
async function seed(opts: {
  questions: string[];
  scope?: string;
  appliesTo?: Record<string, string[]>;
  title?: string;
  embed?: boolean;
  eligible?: boolean;
  publicReads?: number;
  price?: bigint;
  status?: 'published' | 'unlisted';
}) {
  const creator = must(await makeCreator(tdb), 'creator');
  const post = must(
    await makePost(tdb, creator, {
      status: 'published',
      publishedAt: new Date('2026-01-01T00:00:00Z'),
      title: opts.title ?? 'Untitled',
      bodyMd: `${opts.questions.join('\n\n')}\n\nfixture ${uuidv7()}`,
      publicReads: opts.publicReads ?? 0,
      ...(opts.price !== undefined ? { price: opts.price } : {}),
    }),
    'post',
  );
  await makeResource(post.id, {
    questionsAnswered: opts.questions,
    scope: opts.scope ?? null,
    appliesTo: opts.appliesTo ?? {},
  });
  if (opts.embed !== false) {
    const first = opts.questions[0];
    const vec = (first === undefined ? undefined : conceptVector(first)) ?? FAR;
    for (const chunk of contentChunks(post.title, post.bodyMd)) concept(chunk, vec);
    await embedPostContent(tdb.db, stub, post.id);
  }
  if (opts.eligible === false) {
    await tdb.db
      .update(schema.resourceMetadata)
      .set({ cacheEligible: false })
      .where(eq(schema.resourceMetadata.postId, post.id));
  }
  if (opts.status && opts.status !== 'published') {
    await tdb.db
      .update(schema.posts)
      .set({ status: opts.status })
      .where(eq(schema.posts.id, post.id));
  }
  return post;
}

describeIntegration('POST /api/search (decision) — hybrid dense leg', () => {
  it('keeps the dense cases QUERIES out of the lexical leg (fixture isolation guard)', async () => {
    // Every dense case here means "the LEXICAL leg could not have found this".
    // That rests on fixture shape, not on a guarantee, so assert it once rather
    // than letting a fixture change turn dense assertions into lexical ones.
    //
    // What is asserted moved with 0049. seed() writes the card phrases into
    // body_md, and the whole body is now indexed for a paid row, so probing with
    // the PHRASE would only re-prove that. The isolation the dense cases actually
    // rest on is about the QUERY: a paraphrase must share no indexed word with
    // the piece it is meant to find only semantically. Probe with the query the
    // paraphrase case issues, through the real builder (OR-joined, which is the
    // harder bar — one shared word would now be enough to match).
    concept('provisioning fresh signing credentials', basis(0));
    await seed({
      questions: ['provisioning fresh signing credentials'],
      title: 'Unrelated heading',
    });
    const lexical = await tdb.db
      .select({ postId: schema.posts.id })
      .from(schema.posts)
      .where(sql`${schema.posts.searchTsv} @@ ${searchQuery('rotate an api key')}`);
    expect(lexical).toEqual([]);
  });

  it('surfaces a paraphrase the lexical leg misses, tagged semantic match (hybrid-v1)', async () => {
    // Card and query share NO content words but map to the same concept vector.
    concept('provisioning fresh signing credentials', basis(0));
    const post = await seed({ questions: ['provisioning fresh signing credentials'] });
    concept('rotate an api key', basis(0));

    const body = await lookup({ view: 'decision', query: 'rotate an api key' });

    expect(body.calibration).toBe('hybrid-v1');
    expect(body.matched).toBeGreaterThan(0);
    const cand = must(body.items[0], 'candidate');
    expect(cand.resourceId).toBe(post.id);
    // Dense-only hit: no lexical flag, so 'semantic match' is the sole reason.
    expect(cand.matchReasons).toEqual(['semantic match']);
  });

  it('abstains just below the cosine floor (MISS, still hybrid-v1)', async () => {
    concept('provisioning fresh signing credentials', basis(0));
    await seed({ questions: ['provisioning fresh signing credentials'] });
    // 0.02 under the floor, so the dense leg must decline rather than offer its
    // nearest neighbor. Paired with the case below this pins the GATE: that it reads the
    // constant, compares strictly, and points the right way.
    concept('unrelated maintenance chore', atCosine(DENSE_COSINE_SIMILARITY_FLOOR - 0.02));

    const body = await lookup({ view: 'decision', query: 'unrelated maintenance chore' });

    expect(body.calibration).toBe('hybrid-v1');
    expect(body.matched).toBe(0);
    expect(body.items).toEqual([]);
  });

  it('admits just above the cosine floor (CANDIDATES via the dense leg)', async () => {
    concept('provisioning fresh signing credentials', basis(0));
    const post = await seed({ questions: ['provisioning fresh signing credentials'] });
    // 0.02 over the floor and sharing no content words with the card, so only the
    // dense leg can surface it. Without an upper case the abstain test alone passes with
    // the gate stuck shut, or reading a floor of 1.0.
    concept('quarterly capacity planning', atCosine(DENSE_COSINE_SIMILARITY_FLOOR + 0.02));

    const body = await lookup({ view: 'decision', query: 'quarterly capacity planning' });

    expect(body.calibration).toBe('hybrid-v1');
    expect(body.matched).toBeGreaterThan(0);
    const cand = must(body.items[0], 'candidate');
    expect(cand.resourceId).toBe(post.id);
    expect(cand.matchReasons).toEqual(['semantic match']);
  });

  it('gives the dense leg the same eligibility POSTURE as the lexical one', async () => {
    concept('provisioning fresh signing credentials', basis(0));
    const post = await seed({ questions: ['provisioning fresh signing credentials'] });
    // Flip the card ineligible AFTER embedding, so the vectors linger. The two
    // legs must then agree: on the decision view the piece is a bottom-tier
    // candidate reached SEMANTICALLY (the question shares no word with it), which
    // is the one path that proves the dense leg carries the same softened gate
    // rather than a stricter copy of it.
    await tdb.db
      .update(schema.resourceMetadata)
      .set({ cacheEligible: false })
      .where(eq(schema.resourceMetadata.postId, post.id));
    concept('rotate an api key', basis(0));

    const body = await lookup({ view: 'decision', query: 'rotate an api key' });
    expect(body.matched).toBeGreaterThan(0);
    expect(body.items.map((c) => c.resourceId)).toEqual([post.id]);
    expect(body.items[0]!.matchReasons).toEqual(['semantic match', 'incomplete answer card']);
  });

  it('applies the appliesTo gate to dense candidates', async () => {
    concept('provisioning fresh signing credentials', basis(0));
    await seed({
      questions: ['provisioning fresh signing credentials'],
      appliesTo: { products: ['vercel'] },
    });
    concept('rotate an api key', basis(0));

    // Same semantic hit, but a non-matching applies_to constraint gates it out...
    const miss = await lookup({
      view: 'decision',
      query: 'rotate an api key',
      filters: { appliesTo: { products: ['netlify'] } },
    });
    expect(miss.matched).toBe(0);

    // ...and a matching constraint lets the dense candidate through, proving the
    // gate (not the vector) was the cause.
    const hit = await lookup({
      view: 'decision',
      query: 'rotate an api key',
      filters: { appliesTo: { products: ['vercel'] } },
    });
    expect(hit.matched).toBeGreaterThan(0);
  });

  it('ranks a both-legs post above single-leg posts (RRF fusion)', async () => {
    // Lexical query is a single word so websearch AND-semantics stay simple. The
    // lexical leg reads post text only (#628 dropped the card from ranking), so a
    // leg-1 hit needs the term in the TITLE, not in the card.
    const both = await seed({
      questions: [concept('kubernetes scaling best practices', basis(0))],
      title: 'Kubernetes scaling best practices',
    });
    const lexOnly = await seed({
      questions: [concept('kubernetes networking overview', basis(4))], // far vector
      title: 'Kubernetes networking overview',
    });
    const denseOnly = await seed({
      questions: [concept('container orchestration cheatsheet', basis(0))],
      title: 'Container orchestration cheatsheet', // no 'kubernetes'
    });
    concept('kubernetes', basis(0));

    const body = await lookup({ view: 'decision', query: 'kubernetes' });
    expect(body.calibration).toBe('hybrid-v1');
    const ids = body.items.map((c) => c.resourceId);
    expect(ids[0]).toBe(both.id); // in both legs -> highest fused score
    expect(new Set(ids)).toEqual(new Set([both.id, lexOnly.id, denseOnly.id]));
  });

  it('surfaces a gate-passing card ranked behind 50 nearer, gated-out cards', async () => {
    // 50 decoys sit CLOSEST to the query (cosine 1) but FAIL the appliesTo gate;
    // the one gate-passing target is farther (cosine 0.8), so it ranks after all
    // 50, and the gate runs AFTER retrieval. This does NOT pin hnsw.ef_search at
    // any fixture size (it passes at a pool of 4): decoys that fail the gate let
    // the planner filter first instead of probing the index, so the pool never
    // binds. Pinning the beam width needs decoys that PASS the gate.
    concept('decoy semantic content', basis(0));
    for (let i = 0; i < 50; i++) {
      await seed({
        questions: ['decoy semantic content'],
        appliesTo: { products: ['decoyproduct'] },
      });
    }
    const target = await seed({
      questions: [
        concept(
          'target semantic content',
          mix([
            [0.8, basis(0)],
            [0.6, basis(3)],
          ]),
        ),
      ],
      appliesTo: { products: ['targetproduct'] },
    });
    concept('ef search probe', basis(0));

    const body = await lookup({
      view: 'decision',
      query: 'ef search probe',
      filters: { appliesTo: { products: ['targetproduct'] } },
    });
    expect(body.matched).toBeGreaterThan(0);
    expect(body.items.map((c) => c.resourceId)).toEqual([target.id]);
  });
});

describeIntegration('POST /api/search (decision) — hybrid graceful degrade', () => {
  it('never logs the QUESTION when a malformed vector faults the CANDIDATE leg', async () => {
    // The candidate leg is the worse of the two: its statement binds the question
    // into websearch_to_tsquery, so a drizzle error's `params:` dump carries the
    // caller's question verbatim, not only the embedding. This file's header
    // promises the question is never logged, and that was true of every path
    // except the one that fails. Driven through the real route so the route's
    // catch runs.
    concept('provisioning fresh signing credentials', basis(0));
    await seed({ questions: ['provisioning fresh signing credentials'] });
    const question = 'zzsecretquestionterm rotate an api key';
    const malformed: number[] = new Array(DIM).fill(0.1);
    (malformed as unknown as (number | null)[])[5] = null;
    concept(question, malformed);

    const lines: string[] = [];
    const restore = __setLogDestinationForTest(
      new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      }),
      'warn',
    );
    let body: LookupBody;
    try {
      body = await lookup({ view: 'decision', query: question });
    } finally {
      restore();
    }

    // Fail-soft as before: the request still answers, honestly degraded.
    expect(body.calibration).toBe('lexical-v1');
    const logged = lines.join('');
    expect(logged).toContain('lookup: dense retrieval failed');
    // Diagnosable by the structured pg fields...
    expect(logged).toContain('22P02');
    expect(logged).toContain('vector_in');
    // ...while neither thing the dump would have carried appears: the question
    // itself, or the embedding derived from it.
    expect(logged).not.toContain('zzsecretquestionterm');
    expect(logged).not.toContain('0.1,0.1');
    expect(logged).not.toContain('Failed query');
  });

  it('is exactly lexical-v1 when no embedder is configured (flag off)', async () => {
    // A post with vectors present but the dense leg off: response must match the
    // pre-feature lexical behavior, including calibration. The title carries the
    // query term because the lexical leg ranks on post text alone (#628).
    concept('kubernetes scaling best practices', basis(0));
    const post = await seed({
      questions: ['kubernetes scaling best practices'],
      title: 'Kubernetes scaling best practices',
    });
    concept('kubernetes', basis(0));

    const body = await lookup({ view: 'decision', query: 'kubernetes' }, null);
    expect(body.calibration).toBe('lexical-v1');
    // Lexical still matches on the shared word, and carries NO semantic reason.
    const cand = must(body.items[0], 'candidate');
    expect(cand.resourceId).toBe(post.id);
    expect(cand.matchReasons.some((r) => r.includes('semantic'))).toBe(false);
  });

  it('degrades to lexical when the embedder throws (no failed lookup)', async () => {
    concept('kubernetes scaling best practices', basis(0));
    const post = await seed({
      questions: ['kubernetes scaling best practices'],
      title: 'Kubernetes scaling best practices',
    });

    const body = await lookup({ view: 'decision', query: 'kubernetes' }, throwingStub);
    expect(body.calibration).toBe('lexical-v1');
    expect(must(body.items[0], 'candidate').resourceId).toBe(post.id);
  });

  it('keeps serving hybrid for a REPEATED query when the provider then fails', async () => {
    // The cache is what makes this true, and it is the intended behavior: a hit
    // makes no provider call, so an outage cannot degrade a phrase already
    // embedded. `hybrid-v1` stays the honest label, because the dense leg really
    // did run — on a cached vector.
    concept('kubernetes', basis(0));
    const req = { view: 'decision', query: 'kubernetes' };

    expect((await lookup(req)).calibration).toBe('hybrid-v1');
    expect((await lookup(req, throwingStub)).calibration).toBe('hybrid-v1');
  });

  it('persists the served calibration on the telemetry row (hybrid and degraded)', async () => {
    // Lift is only measurable if the stored calibration tracks what actually ran,
    // including the degrade: same query, two embedders, two different rows.
    concept('kubernetes scaling best practices', basis(0));
    await seed({ questions: ['kubernetes scaling best practices'] });
    concept('kubernetes', basis(0));

    // Two DIFFERENT questions on purpose: the query-embedding cache means a
    // repeat of the first one would never reach the throwing embedder, so
    // reusing it would exercise the cache rather than the degrade path.
    const hybrid = await lookup({ view: 'decision', query: 'kubernetes' });
    const degraded = await lookup(
      { view: 'decision', query: 'kubernetes ingress rollout' },
      throwingStub,
    );
    await flush();

    const stored = async (lookupId: string) =>
      (
        await tdb.db
          .select({ calibration: schema.lookups.calibration })
          .from(schema.lookups)
          .where(eq(schema.lookups.id, lookupId))
      )[0]?.calibration;

    expect(hybrid.calibration).toBe('hybrid-v1');
    expect(await stored(hybrid.searchId)).toBe('hybrid-v1');
    expect(degraded.calibration).toBe('lexical-v1');
    expect(await stored(degraded.searchId)).toBe('lexical-v1');
  });

  it('records how many shipped candidates the dense leg placed (#628)', async () => {
    // The counter exists because the two knobs that decide whether the dense leg
    // contributes — the similarity floor and the scan-pool beam — are otherwise
    // invisible in prod: both degrade to lexical results while calibration still
    // reads hybrid-v1, because the leg DID run. Zero here across live hybrid-v1
    // traffic is the shape of that failure.
    const term = 'densecounted';
    concept(term, basis(0));
    // Title carries nothing of the query, so the only route is the body vector.
    await seed({ questions: [term], title: 'Unrelated heading' });

    const hit = await lookup({ view: 'decision', query: term });
    expect(hit.matched).toBeGreaterThan(0);
    await flush();

    const counted = async (lookupId: string) =>
      (
        await tdb.db
          .select({ dense: schema.lookups.denseContributed })
          .from(schema.lookups)
          .where(eq(schema.lookups.id, lookupId))
      )[0]?.dense;

    expect(await counted(hit.searchId)).toBe(hit.items.length);

    // A lookup with no dense leg at all records 0, not null: the difference
    // between "the leg placed nothing" and "the leg never ran" is calibration's
    // job, and conflating them here would hide the former.
    const lexicalOnly = await lookup({ view: 'decision', query: term }, null);
    await flush();
    expect(await counted(lexicalOnly.searchId)).toBe(0);
  });

  it('serves lexical (no embed call) when the daily budget is exhausted', async () => {
    concept('kubernetes scaling best practices', basis(0));
    await seed({ questions: ['kubernetes scaling best practices'] });
    concept('kubernetes', basis(0));

    // A recording embedder proves the dense leg never even calls the model once
    // the budget gate says no.
    let embedCalls = 0;
    const recording: EmbeddingProvider = {
      model: 'stub-embed',
      embed: async (texts) => {
        embedCalls += 1;
        return texts.map((t) => conceptVector(t) ?? FAR);
      },
    };
    const req = { view: 'decision', query: 'kubernetes' };

    // Budget exhausted: consumeBudget returns false -> embedQuery returns null.
    const exhausted = (await (
      await withApi(
        '/test',
        createUnifiedSearchHandler(tdb.db, runInline, recording, async () => false),
      )(lookupReq(req))
    ).json()) as LookupBody;
    // Pure-lexical reference (no embedder at all).
    const lexicalOnly = await lookup(req, null);

    expect(embedCalls).toBe(0);
    expect(exhausted.calibration).toBe('lexical-v1');
    // Byte-identical to the lexical-only path, modulo the random lookupId.
    expect(exhausted.matched).toBe(lexicalOnly.matched);
    expect(exhausted.items).toEqual(lexicalOnly.items);
  });
});
