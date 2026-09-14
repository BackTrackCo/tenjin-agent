// Independent synthetic contracts. No model/API calls or historical answer fixtures.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { testEnv } from '../tests/setup/test-env';
import { startDatabase } from '#benchmark/database';
let service: any, schema: any, fixtures: any, retrieval: any, embeddings: any, limiter: any;
let generation: any, chunks: any, projection: any, routes: any, api: any, NextRequest: any;
let queryCache: any;
const question = 'zircon observatory alignment';
const secret = 'PAID_BODY_SYNTHETIC_SENTINEL_7dcd';
const vector = (cosine = 1) => { const v = Array(1536).fill(0); v[0] = cosine; v[1] = Math.sqrt(1 - cosine * cosine); return v; };
const provider = { model: 'independent-optics', embed: async (texts: string[]) => texts.map(() => vector()) };
const ids = (rows: any[]) => rows.map(row => row.postId ?? row.id).sort();

beforeAll(async () => {
  for (const [key, value] of Object.entries(testEnv)) vi.stubEnv(key, value);
  vi.stubEnv('POSTGRES_URL', process.env.BENCHMARK_DATABASE_URL!);
  vi.stubEnv('POSTGRES_URL_NON_POOLING', process.env.BENCHMARK_DATABASE_URL!);
  vi.stubEnv('EMBEDDING_DAILY_BUDGET', '100');
  vi.stubEnv('ANSWER_API', 'on');
  vi.stubEnv('ANSWER_CREATOR_ALLOWLIST', 'fictional');
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-unused-oracle-key');
  vi.stubGlobal('fetch', () => { throw new Error('Unexpected outbound request'); });
  schema = await import('../lib/db/schema');
  service = await startDatabase(schema);
  fixtures = await import('../tests/integration/_support/fixtures');
  retrieval = await import('../lib/search/retrieve/candidates');
  embeddings = await import('../lib/embeddings');
  limiter = await import('../lib/rate-limit');
  generation = await import('../lib/content-embeddings');
  chunks = await import('../lib/content-chunks');
  projection = await import('../lib/search/project');
  queryCache = await import('../lib/search/query-cache');
  routes = {
    v2: (await import('../app/api/agent/search/route')).createSearchHandler,
    v3: (await import('../app/api/search/route')).createUnifiedSearchHandler,
    articles: (await import('../app/api/articles/route')).createArticlesHandler,
  };
  api = await import('../lib/api');
  ({ NextRequest } = await import('next/server'));
}, 60000);
afterAll(async () => { if (service) await service.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
beforeEach(async () => {
  await service.pool.query('TRUNCATE creators, lookups CASCADE');
  limiter.__resetRateLimitForTest();
  queryCache.__resetQueryCacheForTest();
});

async function post(options: any = {}) {
  const owner = await fixtures.makeCreator(service, options.ownerHandle ? { handle: options.ownerHandle } : {});
  const item = await fixtures.makePost(service, owner, {
    status: options.status ?? 'published', publishedAt: new Date(Date.now() - 86400000),
    title: options.title ?? 'A sealed optical assembly', bodyMd: '# Calibration\n\n' + secret,
    excerpt: options.excerpt ?? 'A public description of the apparatus.', price: options.price ?? '1.00',
  });
  if (options.card !== false) await service.db.insert(schema.resourceMetadata).values({
    postId: item.id, cacheEligible: options.eligible ?? true,
    questionsAnswered: [options.cardText ?? 'What are the assembly dimensions?'],
    scope: options.cardText ?? 'Mechanical dimensions only', validUntil: options.expired ? new Date(Date.now() - 86400000) : null,
  });
  return item;
}
async function content(item: any, cosine = 1, count = 1) {
  await service.db.insert(schema.contentEmbeddings).values(Array.from({ length: count }, (_, index) => ({
    postId: item.id, model: provider.model, textHash: randomUUID(), chunkIdx: index, source: 'body', embedding: vector(cosine),
  })));
}
const request = (questionText = question, extra: any = {}) => ({ question: questionText, limit: 10, ...extra });

it('lexical retrieval rewards public content and excludes an answer-card-only match', async () => {
  const genuine = await post({ title: 'Zircon observatory alignment manual' });
  await post({ cardText: question });
  expect(ids(await retrieval.queryLookup(service.db, request()))).toEqual([genuine.id]);
});

it('dense retrieval reads body vectors, permits a 0.49 match and excludes a 0.45 match', async () => {
  const genuine = await post(); await content(genuine, 0.49);
  const low = await post(); await content(low, 0.45);
  const cardOnly = await post({ cardText: question });
  await embeddings.embedPostCard(service.db, provider, cardOnly.id);
  expect(ids(await retrieval.denseLookup(service.db, request(), vector()))).toEqual([genuine.id]);
});

it('dense decision preserves card eligibility, visibility, expiration, price and creator scope', async () => {
  const good = await post({ price: '0.10' }); await content(good);
  for (const options of [{ card: false }, { eligible: false }, { expired: true }, { status: 'unlisted' }, { price: '9.00' }]) {
    const item = await post(options); await content(item);
  }
  expect(ids(await retrieval.denseLookup(service.db, request(question, { maxPrice: '1.00' }), vector()))).toEqual([good.id]);
  expect(await retrieval.denseLookup(service.db, request(), vector(), { creatorHandles: ['absent-fictional-creator'] })).toEqual([]);
});

it('the body scan reaches a second post after 256 nearer chunks from one post', async () => {
  const flooder = await post(); await content(flooder, 1, 256);
  const second = await post(); await content(second, 0.7);
  expect(ids(await retrieval.denseLookup(service.db, request(), vector()))).toEqual([flooder.id, second.id].sort());
});

it('content generation embeds and persists only the first 256 chunks', async () => {
  const body = Array.from({ length: 300 }, (_, i) => `## Optical station ${i}\n\n${('Independent calibration passage ' + i + ' ').repeat(55)}`).join('\n\n');
  // The public generation boundary owns this policy. Implementations may cap
  // the chunker or its caller, provided both provider input and storage agree.
  const expected = chunks.contentChunks('Instrument ledger', body).slice(0, 256);
  expect(expected).toHaveLength(256);
  const item = await post({ title: 'Instrument ledger' });
  await service.pool.query('UPDATE posts SET body_md=$1 WHERE id=$2', [body, item.id]);
  await content(item, 1, 1); // A stale vector must not survive reconciliation.
  const embed = vi.fn(async (texts: string[]) => texts.map(() => vector()));
  const result = await generation.embedPostContent(service.db, { ...provider, embed }, item.id);
  expect(result.inserted).toBe(256);
  expect(embed).toHaveBeenCalledTimes(1);
  expect(embed.mock.calls[0][0]).toEqual(expected);
  expect(embed.mock.calls[0][0][0]).toContain('Optical station 0');
  expect(embed.mock.calls[0][0].join('\n')).not.toContain('Optical station 299');
  const { rows } = await service.pool.query('SELECT chunk_idx, text_hash FROM content_embeddings WHERE post_id=$1 ORDER BY chunk_idx', [item.id]);
  expect(rows.map((row: any) => row.chunk_idx)).toEqual(Array.from({ length: 256 }, (_, i) => i));
  expect(rows.map((row: any) => row.text_hash)).toEqual(expected.map((text: string) => embeddings.embeddingTextHash(provider.model, text)));
  expect(chunks.contentChunks('', '')).toEqual([]);
});

// Exercise public operations with their default budgets, not a newly invented
// signature or private limiter key. Unique queries avoid the intentional cache.
async function spendSearch(surface: string, count: number, prefix: string) {
  let calls = 0;
  for (let i = 0; i < count; i++) {
    const result = await route(surface === 'decision' ? 'v2' : 'v3', surface, true, {
      noSeed: true, defaultBudget: true, question: `What aligns ${prefix} optical station ${i}?`,
    });
    calls += result.embeddingCalls;
  }
  return calls;
}
it('actual search, answer and generation calls spend independent daily shares', async () => {
  expect(await spendSearch('display', 11, 'display')).toBe(10);
  expect(await spendSearch('decision', 36, 'decision')).toBe(35);
  expect(await spendAnswers(21)).toBe(20);
  let calls = 0;
  const stub = { ...provider, embed: async (texts: string[]) => { calls++; return texts.map(() => vector()); } };
  for (let i = 0; i < 35; i++) {
    const item = await post();
    expect((await generation.embedPostContent(service.db, stub, item.id)).inserted).toBe(1);
    expect((await generation.embedPostContent(service.db, stub, item.id)).inserted).toBe(0);
  }
  const last = await post();
  expect((await generation.embedPostContent(service.db, stub, last.id)).skipped).toBe('budget');
  expect(calls).toBe(35);
}, 60000);

it('a day counter survives the hourly in-memory cleanup sweep', async () => {
  const clock = vi.spyOn(Date, 'now');
  const epoch = Date.now(); clock.mockReturnValue(epoch);
  try {
    const rule = { id: 'synthetic-day', max: 1, windowMs: 86400000 };
    expect((await limiter.checkRateLimit('first', rule)).allowed).toBe(true);
    clock.mockReturnValue(epoch + 61 * 60000);
    for (let i = 0; i < 1100; i++) await limiter.checkRateLimit('unrelated-' + i, { id: 'short', max: 1, windowMs: 60000 });
    expect((await limiter.checkRateLimit('first', rule)).allowed).toBe(false);
    expect((await limiter.checkRateLimit('second', rule)).allowed).toBe(true);
    clock.mockReturnValue(epoch + 86400001);
    expect((await limiter.checkRateLimit('first', rule)).allowed).toBe(true);
  } finally { clock.mockRestore(); }
});

function assertPublic(value: any) {
  expect(JSON.stringify(value)).not.toContain(secret);
  function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      expect(['score', 'distance', 'embedding', 'vector', 'bodyMd', 'body_md', 'chunkText', 'chunk_text']).not.toContain(key);
      walk(child);
    }
  }
  walk(value);
}
async function route(kind: string, view = 'decision', eligible = true, opts: any = {}) {
  const queryText = opts.question ?? question;
  const item = opts.noSeed ? null : await post({ title: opts.bodyOnly ? 'A sealed optical assembly' : 'Zircon observatory alignment notes', eligible, card: opts.cardless ? false : true });
  if (item) await content(item, opts.cosine ?? 1);
  if (opts.budgetOverflow) {
    const oversized = await post(); await content(oversized, 0.9);
    await service.pool.query('UPDATE posts SET slug=$1 WHERE id=$2', ['x'.repeat(10000), oversized.id]);
    const tail = await post(); await content(tail, 0.8);
  }
  let embeddingCalls = 0;
  const counted = { ...provider, embed: async (texts: string[]) => { embeddingCalls++; return texts.map(() => vector()); } };
  const scheduled: Promise<any>[] = [];
  const schedule = (task: () => Promise<any>) => { scheduled.push(Promise.resolve().then(task)); };
  const meters: any[] = [];
  const limit = async (key: string, rule: any) => { meters.push({ key, ...rule }); return { allowed: true, limit: rule.max, remaining: rule.max - 1, reset: Date.now() + rule.windowMs }; };
  const handler = routes[kind](service.db, schedule, counted, opts.defaultBudget ? undefined : async () => true, limit);
  const path = kind === 'v2' ? '/api/agent/search' : kind === 'articles' ? '/api/articles?q=' + encodeURIComponent(queryText) : '/api/search';
  const req = new NextRequest('https://fictional.example' + path, kind === 'articles' ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(kind === 'v2' ? { schemaVersion: 2, question: queryText } : { view, query: queryText }) });
  const response = await api.withApi('/independent-oracle', handler)(req);
  expect(response.status).toBe(200);
  const body = await response.json();
  await Promise.all(scheduled);
  return { body, meters, item, embeddingCalls };
}

it.each([['v2', 'decision'], ['v3', 'decision'], ['v3', 'display'], ['articles', 'display']])('%s %s meters daily searches and returns public fields only', async (kind, view) => {
  const { body, meters, item } = await route(kind, view);
  expect(meters).toContainEqual(expect.objectContaining({ max: 1000, windowMs: 86400000 }));
  expect(meters.some(row => row.windowMs === 60000)).toBe(true);
  assertPublic(body);
  expect(JSON.stringify(body)).toContain(item.id);
});

it('suggest stays outside the daily decision meter and returns a nonempty public suggestion', async () => {
  const { body, meters } = await route('v3', 'suggest');
  expect(meters.some(row => row.windowMs === 86400000)).toBe(false);
  expect(body.items.length).toBeGreaterThan(0);
  assertPublic(body);
});

it('a decision MISS can browse a card-ineligible post without exposing body-derived data', async () => {
  const { body, item } = await route('v2', 'decision', false);
  expect(body.decision).toBe('MISS');
  expect(JSON.stringify(body.browse)).toContain(item.id);
  assertPublic(body);
});

it.each(['v2', 'v3'])('%s persists the dense contribution for the candidates actually returned', async kind => {
  const { body } = await route(kind);
  const persisted = (await service.pool.query("SELECT candidate_count, to_jsonb(l)->'dense_contributed' AS dense FROM lookups l WHERE id=$1", [body.searchId])).rows;
  expect(persisted).toHaveLength(1);
  expect(persisted[0]).toMatchObject({ candidate_count: 1, dense: 1 });
});

it('projection retains its existing response budget', () => {
  const row = { postId: randomUUID(), slug: 'optics', title: 'Optical bench', price: '1.00', handle: 'fictional', artifactType: 'guide', excerpt: '', temporalMode: 'evergreen', asOf: null, validUntil: null, wordCount: 100, postHit: false, semanticHit: true };
  const result = projection.buildSearchResponse([row, { ...row, postId: randomUUID(), slug: 'x'.repeat(10000) }, { ...row, postId: randomUUID() }], randomUUID(), 'hybrid-v1');
  expect(result.response.truncated).toBe(true);
  expect(result.response.candidates).toHaveLength(1);
  expect(projection.buildSearchResponse([], randomUUID()).response.decision).toBe('MISS');
});

it.each(['v2', 'v3'])('%s persists dense contribution after response-budget truncation', async kind => {
  const { body } = await route(kind, 'decision', true, { bodyOnly: true, budgetOverflow: true });
  expect(body.truncated).toBe(true);
  expect(kind === 'v2' ? body.candidates : body.items).toHaveLength(1);
  const rows = (await service.pool.query("SELECT candidate_count,to_jsonb(l)->'dense_contributed' AS dense FROM lookups l WHERE id=$1", [body.searchId])).rows;
  expect(rows).toEqual([{ candidate_count: 1, dense: 1 }]);
});

it('the migrated dense-contribution column is nullable smallint with candidate-count bounds', async () => {
  const columns = (await service.pool.query("SELECT data_type,is_nullable FROM information_schema.columns WHERE table_name='lookups' AND column_name='dense_contributed'")).rows;
  expect(columns).toEqual([{ data_type: 'smallint', is_nullable: 'YES' }]);
  for (const dense of [null, 0, 1]) await service.pool.query("INSERT INTO lookups (id,decision,candidate_count,dense_contributed) VALUES ($1,'candidates',1,$2)", [randomUUID(), dense]);
  for (const dense of [-1, 2]) await expect(service.pool.query("INSERT INTO lookups (id,decision,candidate_count,dense_contributed) VALUES ($1,'candidates',1,$2)", [randomUUID(), dense])).rejects.toThrow();
});


async function spendAnswers(count: number) {
  const { createAnswerHandler } = await import('../app/api/answer/route');
  let embedded = 0;
  const stub = { ...provider, embed: async (texts: string[]) => { embedded++; return texts.map(() => vector()); } };
  const pending: Promise<any>[] = [];
  const schedule = (task: () => Promise<any>) => { pending.push(Promise.resolve().then(task)); };
  const handler = createAnswerHandler(service.db, schedule, null, stub, {}, undefined, async () => {}, undefined, () => ({}));
  for (let i = 0; i < count; i++) {
    const req = new NextRequest('https://fictional.example/api/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'What aligns the fictional optic station ' + i + '?' }) });
    const response = await api.withApi('/independent-answer-oracle', handler)(req);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.decision).toBe('MISS');
    await Promise.all(pending);
    const rows = (await service.pool.query("SELECT candidate_count,to_jsonb(l)->'dense_contributed' AS dense FROM lookups l WHERE id=$1", [body.searchId])).rows;
    expect(rows).toEqual([{ candidate_count: 0, dense: 0 }]);
  }
  return embedded;
}

it.each(['v3', 'articles'])('%s dense display rescues cardless body matches and rejects card-only/subfloor decoys', async kind => {
  const low = await post({ card: false }); await content(low, 0.45);
  const decoy = await post({ cardText: question }); await embeddings.embedPostCard(service.db, provider, decoy.id);
  const { body, item, embeddingCalls } = await route(kind, 'display', true, { bodyOnly: true, cardless: true, cosine: 0.49 });
  expect(JSON.stringify(body)).toContain(item.id);
  expect(JSON.stringify(body)).not.toContain(low.id);
  expect(JSON.stringify(body)).not.toContain(decoy.id);
  expect(embeddingCalls).toBe(1);
  assertPublic(body);
});

it('MISS browse keeps a subfloor cardless body neighbor and reuses the decision embedding', async () => {
  const { body, item, embeddingCalls } = await route('v2', 'decision', false, { bodyOnly: true, cardless: true, cosine: 0.45 });
  expect(body.decision).toBe('MISS');
  expect(JSON.stringify(body.browse)).toContain(item.id);
  expect(embeddingCalls).toBe(1);
  assertPublic(body);
});

it('an identical cached decision does not call the embedding provider twice', async () => {
  const first = await route('v2');
  const second = await route('v2');
  expect(first.embeddingCalls).toBe(1);
  expect(second.embeddingCalls).toBe(0);
});

it('an unsigned answer quote records positive dense contribution without payment or synthesis', async () => {
  const { createPaymentResourceServer } = await import('../lib/payments/server');
  const { paymentConfig } = await import('../lib/payments/config');
  const { createAnswerHandler } = await import('../app/api/answer/route');
  const forbidden = async () => { throw new Error('Payment or synthesis must not run'); };
  const server = createPaymentResourceServer(paymentConfig, { facilitatorClient: {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: 'exact', network: paymentConfig.network }], extensions: [], signers: {} }),
    verify: forbidden, settle: forbidden,
  } });
  const item = await post({ ownerHandle: 'fictional' }); await content(item);
  const pending: Promise<any>[] = [];
  const schedule = (task: () => Promise<any>) => { pending.push(Promise.resolve().then(task)); };
  const handler = createAnswerHandler(service.db, schedule, null, provider, { server }, undefined, async () => {}, undefined, () => ({}));
  const req = new NextRequest('https://fictional.example/api/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
  const response = await api.withApi('/independent-answer-quote', handler)(req);
  expect(response.status).toBe(402);
  const body = await response.json();
  expect(JSON.stringify(body.sources)).toContain(item.id);
  assertPublic(body);
  await Promise.all(pending);
  const rows = (await service.pool.query("SELECT candidate_count,to_jsonb(l)->'dense_contributed' AS dense FROM lookups l WHERE id=$1", [body.searchId])).rows;
  expect(rows).toEqual([{ candidate_count: 1, dense: 1 }]);
});

it('generated search metadata keeps public identity and reason labels without exposing vectors', async () => {
  const { buildOpenApiDocument } = await import('../lib/openapi');
  const doc = buildOpenApiDocument('https://fictional.example', 'on') as any;
  const fields = doc.components.schemas.SearchCandidate.properties;
  expect(fields.resourceId.format).toBe('uuid');
  expect(fields.url.format).toBe('uri');
  expect(fields.matchReasons).toMatchObject({ type: 'array', items: { type: 'string' } });
  expect(fields.creator.properties.handle.type).toBe('string');
  for (const key of ['title', 'excerpt', 'price']) expect(fields[key]).toBeDefined();
  for (const key of ['bodyMd', 'body_md', 'score', 'distance', 'embedding', 'vector', 'chunkText']) expect(fields[key]).toBeUndefined();
  expect(doc.paths['/api/agent/search'].post).toBeDefined();
  expect(doc.paths['/api/search'].post).toBeDefined();
});
