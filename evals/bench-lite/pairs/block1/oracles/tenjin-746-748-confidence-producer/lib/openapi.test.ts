import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildOpenApiDocument } from '@/lib/openapi';
import { postCreateSchema, postUpdateSchema } from '@/lib/posts';
import { profileSchema } from '@/lib/creators';
import { confirmUploadSchema } from '@/lib/images';
import { previewArticle, unlockedArticle, type PublicArticle } from '@/lib/public-read';
import { importJobCreateSchema, importCommitSchema } from '@/lib/import/schemas';
import { discoveryQuerySchema } from '@/lib/discovery';
import {
  lookupRequestSchema,
  outcomeBodySchema,
  type BrowseRow,
  type LookupRow,
} from '@/lib/search';
import { serializeResourceCard, type ResourceMetadataRow } from '@/lib/resource-write';
import { buildSearchResponse } from '@/lib/search-response';

const APP_URL = 'https://tenjin.sh';

// Minimal structural view of the subset of the OpenAPI document these tests
// poke at — enough to navigate without `any` (CONVENTIONS rule #6).
type JsonSchema = {
  type?: unknown;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  [k: string]: unknown;
};
type Operation = {
  security?: unknown;
  description?: string;
  responses?: Record<string, unknown>;
  parameters?: Array<{ name: string }>;
  ['x-payment-info']?: { protocols?: unknown[]; price?: Record<string, unknown> };
};
type PathItem = { get?: Operation; post?: Operation; put?: Operation; delete?: Operation };
type Doc = {
  openapi: string;
  info: {
    title: string;
    description: string;
    contact?: { email?: string };
    ['x-guidance']?: string;
  };
  servers: Array<{ url: string }>;
  paths: Record<string, PathItem | undefined>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: Record<
      string,
      { type: string; in: string; name: string; description: string }
    >;
  };
};

const doc = buildOpenApiDocument(APP_URL, 'on') as unknown as Doc;

/** Mirror lib/openapi.ts fromZod — the exact bytes a request schema must equal. */
function fromZod(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Record<
    string,
    unknown
  >;
  delete js.$schema;
  return js;
}

/** Collect every "$ref" string anywhere in the document. */
function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const v of node) collectRefs(v, out);
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') out.push(v);
      else collectRefs(v, out);
    }
  }
  return out;
}

// A hand-built PublicArticle (no DB) for the read-schema drift guard — mirrors the
// loader's assembled shape (same literal as public-read.test.ts's fakeArticle).
function fakePublicArticle(): PublicArticle {
  return {
    id: '0190a0b0-0000-7000-8000-000000000000',
    creatorId: '0190a0b0-0000-7000-8000-000000000001',
    slug: 'an-essay',
    title: 'An Essay',
    excerpt: 'a teaser',
    bodyMdPreview: '# An Essay\n\nAbove the break.',
    coverImageId: null,
    price: 250_000n,
    arbiterId: null,
    status: 'published',
    sourceUrl: null,
    publishedAt: new Date('2026-01-02T03:04:05.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T03:04:05.000Z'),
    wordCount: 4,
    creator: {
      id: '0190a0b0-0000-7000-8000-000000000001',
      handle: 'alice',
      displayName: 'Alice',
      walletAddress: '0x' + 'a'.repeat(40),
      splitAddress: null,
      avatarImageId: null,
      defaultPrice: 500_000n,
      bio: '',
      showHumanButton: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    tags: ['reading', 'privacy'],
  };
}

function fakeResourceMetadataRow(
  overrides: Partial<ResourceMetadataRow> = {},
): ResourceMetadataRow {
  return {
    postId: '0190a0b0-0000-7000-8000-0000000000c0',
    artifactType: 'document',
    mediaType: 'text/markdown',
    temporalMode: 'snapshot',
    asOf: null,
    validUntil: null,
    supersedesPostId: null,
    questionsAnswered: [],
    tasksSupported: [],
    scope: null,
    exclusions: null,
    appliesTo: {},
    provenanceSummary: null,
    methodologySummary: null,
    maintenanceCadence: null,
    reproductionMinutes: null,
    paidInputCost: null,
    cacheEligible: false,
    schemaVersion: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const fakeResourceCard = (overrides: Partial<ResourceMetadataRow> = {}) =>
  serializeResourceCard(fakeResourceMetadataRow(overrides));

describe('buildOpenApiDocument', () => {
  it('is a valid OpenAPI 3.1 document with the SIWX security scheme', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Tenjin API');
    // A constant contact mailbox so agent tooling and x402 directories can attribute
    // and verify the origin's owner; it is NOT origin-derived (see the preview test).
    expect(doc.info.contact?.email).toBe('hello@tenjin.sh');
    // x-guidance is a required top-level field for x402scan discovery: a one-line
    // agent orientation that points at the concrete payable-resource list (the paid
    // read is a dynamic-priced template with no single probeable URL).
    expect(doc.info['x-guidance']).toContain(`${APP_URL}/.well-known/x402.json`);
    expect(doc.info['x-guidance']).toContain(`${APP_URL}/llms.txt`);
    const scheme = doc.components.securitySchemes.siwx!;
    // The header name is load-bearing: agents send exactly this casing.
    expect(scheme).toMatchObject({ type: 'apiKey', in: 'header', name: 'SIGN-IN-WITH-X' });
    // OpenAPI can't teach header construction — it must point at the worked example.
    expect(scheme.description).toContain(`${APP_URL}/llms.txt`);
  });

  it('GENERATES request bodies from the live zod schemas (drift guard)', () => {
    // If postCreateSchema/etc. change, these must change in lockstep — that is
    // the whole point of generating rather than hand-writing the request shapes.
    expect(doc.components.schemas.PostCreate).toEqual(fromZod(postCreateSchema));
    expect(doc.components.schemas.PostUpdate).toEqual(fromZod(postUpdateSchema));
    expect(doc.components.schemas.Profile).toEqual(fromZod(profileSchema));
    expect(doc.components.schemas.ImageRecordUpload).toEqual(fromZod(confirmUploadSchema));
    expect(doc.components.schemas.ImportJobCreate).toEqual(fromZod(importJobCreateSchema));
    expect(doc.components.schemas.ImportCommit).toEqual(fromZod(importCommitSchema));
    // SearchRequest is the ONE generated body with hand-added constraints: the
    // "one of question/query/q" rule is a zod refine that fromZod cannot emit.
    // Still pinned to the live schema for everything it CAN express — a field add
    // or rename fails here — but by containment rather than equality.
    expect(doc.components.schemas.SearchRequest).toMatchObject(fromZod(lookupRequestSchema));
    expect(doc.components.schemas.SearchOutcomeSubmit).toEqual(fromZod(outcomeBodySchema));
  });

  it('binds the READ schemas to previewArticle/unlockedArticle (drift guard)', () => {
    // ReadArticlePreview / ReadArticleUnlocked are hand-mirrored from the runtime
    // projections (not zod, so no fromZod here). Pin each to its live shape so a future
    // field add/rename in previewArticle / unlockedArticle (or the creator byline)
    // can't ship a silently divergent published spec, and so the [SAFE-B1-01]
    // one-representation invariant holds at the spec layer.
    const fixture = fakePublicArticle();
    // `card` and `cardUnavailable` are mutually exclusive, so NO single preview
    // carries every key: bind the schema to the UNION of the carded body and the
    // failed-load body, and pin the exclusivity separately below.
    const preview = previewArticle(fixture, fakeResourceCard({ questionsAnswered: ['Does X?'] }));
    const failedPreview = previewArticle(fixture, null, true);
    const previewKeys = new Set([...Object.keys(preview), ...Object.keys(failedPreview)]);
    const unlocked = unlockedArticle(fixture, '# The source\n');
    const previewSchema = doc.components.schemas.ReadArticlePreview!;
    const unlockedSchema = doc.components.schemas.ReadArticleUnlocked!;

    expect([...previewKeys].sort()).toEqual(Object.keys(previewSchema.properties!).sort());
    // The card binds field-for-field too, and stays OPTIONAL: an uncarded piece
    // omits the key, so `card` must never enter the preview's required list. A
    // PRESENT card is never partial, so its own required must list every emitted
    // key (same pin as the ResourceCard guard below).
    const cardSchema = previewSchema.properties!.card!;
    expect(Object.keys(preview.card!).sort()).toEqual(Object.keys(cardSchema.properties!).sort());
    expect((cardSchema.required ?? []).slice().sort()).toEqual(Object.keys(preview.card!).sort());
    expect(previewSchema.required).not.toContain('card');
    expect(previewSchema.required).not.toContain('cardUnavailable');
    // Uncarded is the byte-shape baseline: neither key. And the two never co-occur.
    const uncarded = previewArticle(fixture);
    expect(Object.hasOwn(uncarded, 'card')).toBe(false);
    expect(Object.hasOwn(uncarded, 'cardUnavailable')).toBe(false);
    expect(Object.hasOwn(failedPreview, 'card')).toBe(false);
    expect(Object.hasOwn(preview, 'cardUnavailable')).toBe(false);
    // The nested byline stays bound too (catches a creator field add/rename).
    expect(Object.keys(preview.creator).sort()).toEqual(
      Object.keys(previewSchema.properties!.creator!.properties!).sort(),
    );
    // Unlocked binds to its own schema — the same public fields plus bodyMd.
    expect(Object.keys(unlocked).sort()).toEqual(Object.keys(unlockedSchema.properties!).sort());
    // One representation per response ([SAFE-B1-01]): the preview (the 402 challenge
    // body) never carries the gated bodyMd, and the unlocked essay never carries the
    // bodyMdPreview (a literal prefix of what it already holds).
    expect(Object.hasOwn(preview, 'bodyMd')).toBe(false);
    expect(Object.hasOwn(unlocked, 'bodyMdPreview')).toBe(false);
  });

  it('binds ResourceCard to serializeResourceCard (drift guard)', () => {
    // Same one-representation pin as the READ schemas: a field add/rename in
    // serializeResourceCard, or a stale required list, must not silently diverge from
    // the published ResourceCard schema. A present card is never partial, so required
    // must list exactly the emitted keys.
    const card = fakeResourceCard();
    const schema = doc.components.schemas.ResourceCard!;
    expect(Object.keys(card).sort()).toEqual(Object.keys(schema.properties!).sort());
    expect((schema.required ?? []).slice().sort()).toEqual(Object.keys(card).sort());
  });

  it('binds the SearchCandidate schema to buildSearchResponse (runtime drift guard)', () => {
    // The lookup response is assembled inline by lib/lookup.ts (no zod source), so
    // pin the hand-maintained SearchCandidate schema to a REAL projected candidate:
    // a future field add/rename in projectCandidate can't ship a silently divergent
    // published spec (the previewArticle pattern above, for the lookup surface).
    const row: LookupRow = {
      postId: '0190a0b0-0000-7000-8000-000000000001',
      slug: 'a-post',
      title: 'A Post',
      price: 250_000n,
      handle: 'alice',
      artifactType: 'document',
      excerpt: 'A short public excerpt.',
      temporalMode: 'evergreen',
      asOf: new Date('2026-07-01T00:00:00.000Z'),
      validUntil: null,
      wordCount: 300,
      cacheEligible: true,
      carded: true,
      postHit: true,
    };
    const built = buildSearchResponse([row], '0190a0b0-0000-7000-8000-0000000000ff');
    expect(built.response.decision).toBe('CANDIDATES');
    const candidate = built.response.candidates![0]!;
    const schema = doc.components.schemas.SearchCandidate!;
    // `confidence`/`corroborated` are the only OPTIONAL candidate fields
    // (present only when retrieval fused both legs); this baseline row never
    // fused, so `properties` must have exactly those two more keys.
    expect(Object.keys(candidate).sort()).toEqual(
      Object.keys(schema.properties!)
        .filter((k) => k !== 'confidence' && k !== 'corroborated')
        .sort(),
    );
    // Every OTHER field is always present on a candidate, so `required` must list
    // them all: a field added to properties but left out of required would
    // publish an optional field the runtime never omits (the ResourceCard
    // pattern above) — except `confidence`/`corroborated`, deliberately absent
    // from both `required` and this baseline candidate.
    expect((schema.required ?? []).slice().sort()).toEqual(Object.keys(candidate).sort());
    expect((schema.required ?? []).includes('confidence')).toBe(false);
    expect((schema.required ?? []).includes('corroborated')).toBe(false);
    // The nested byline stays bound too (catches a creator field add/rename).
    expect(Object.keys(candidate.creator).sort()).toEqual(
      Object.keys(schema.properties!.creator!.properties!).sort(),
    );

    // A row a hybrid fusion actually scored publishes both extra keys, so the
    // schema's `confidence`/`corroborated` properties are pinned to something
    // real too.
    const fusedRow: LookupRow = { ...row, semanticHit: true, score: 0.05, similarity: 0.6 };
    const fusedCandidate = buildSearchResponse(
      [fusedRow],
      '0190a0b0-0000-7000-8000-0000000000fc',
      'hybrid-v1',
    ).response.candidates![0]!;
    expect(Object.keys(fusedCandidate).sort()).toEqual(Object.keys(schema.properties!).sort());
  });

  it('binds the SearchBrowse schema to a projected MISS browse item (runtime drift guard)', () => {
    // Browse-on-MISS (#460) is projected inline by lib/search-response.ts (no zod
    // source), so pin the hand-maintained SearchBrowse schema to a REAL projected
    // browse item — a future field add/rename can't ship a divergent spec.
    const browse: BrowseRow = {
      postId: '0190a0b0-0000-7000-8000-000000000002',
      slug: 'a-browse',
      title: 'A Browse',
      price: 50_000n,
      handle: 'bob',
    };
    const built = buildSearchResponse([], '0190a0b0-0000-7000-8000-0000000000fe', 'lexical-v1', [
      browse,
    ]);
    expect(built.response.decision).toBe('MISS');
    const item = built.response.browse![0]!;
    const schema = doc.components.schemas.SearchBrowse!;
    expect(Object.keys(item).sort()).toEqual(Object.keys(schema.properties!).sort());
    expect((schema.required ?? []).slice().sort()).toEqual(Object.keys(item).sort());
    // The nested byline stays bound too (catches a creator field add/rename).
    expect(Object.keys(item.creator).sort()).toEqual(
      Object.keys(schema.properties!.creator!.properties!).sort(),
    );
  });

  it('binds the SearchInspect schema to a projected inspect block (runtime drift guard)', () => {
    // The rank-1 card (#528) is projected inline by lib/search-response.ts with no
    // zod source, same as SearchCandidate/SearchBrowse above. It is the one block
    // that carries answer-card claims, so a silent field add here would publish a
    // spec that understates what search actually discloses.
    const row: LookupRow = {
      postId: '0190a0b0-0000-7000-8000-000000000001',
      slug: 'a-post',
      title: 'A Post',
      price: 250_000n,
      handle: 'alice',
      artifactType: 'document',
      excerpt: 'A short public excerpt.',
      temporalMode: 'evergreen',
      asOf: new Date('2026-07-01T00:00:00.000Z'),
      validUntil: null,
      wordCount: 300,
      cacheEligible: true,
      carded: true,
      postHit: true,
    };
    const built = buildSearchResponse(
      [row],
      '0190a0b0-0000-7000-8000-0000000000fd',
      'lexical-v1',
      [],
      {
        postId: row.postId,
        claims: { questionsAnswered: ['q'], scope: 'A scope', exclusions: 'Not X' },
      },
    );
    const inspect = built.response.inspect!;
    const schema = doc.components.schemas.SearchInspect!;
    expect(Object.keys(inspect).sort()).toEqual(Object.keys(schema.properties!).sort());
    // Every field is always present on the block, so `required` must list them all.
    expect((schema.required ?? []).slice().sort()).toEqual(Object.keys(inspect).sort());
  });

  it('documents search retrieval as hybrid, not lexical-only', () => {
    // Retrieval fuses a lexical leg with a dense one, so buildMatchReasons can
    // append `semantic match`. Pin the published prose against a drift back to
    // lexical-only on every field that names a calibration (a guard on the
    // operation summary alone missed the response description — #467 review).
    const reasons = doc.components.schemas.SearchCandidate!.properties!.matchReasons!
      .description as string;
    expect(reasons).toContain('semantic match');
    expect(reasons).not.toMatch(/honest lexical/);
    const response = doc.components.schemas.SearchResponse!.description as string;
    expect(response).not.toMatch(/honest lexical/);
    const op = doc.paths['/api/agent/search']?.post as { summary?: string } | undefined;
    expect(op?.summary).not.toMatch(/honest lexical/);
  });

  it('omits the buyer payer from the CreatorEvent schema (payer-privacy drift guard)', () => {
    // The sale feed deliberately does NOT expose the buyer wallet (no enumerable
    // buyer roster — see lib/creator-events.ts module header). Pin that at the
    // spec layer so a future field add to the response shape can't silently
    // republish `payer`: neither `required` nor `properties` may carry it.
    const event = doc.components.schemas.CreatorEvent!;
    expect(event.required).not.toContain('payer');
    expect(Object.hasOwn(event.properties!, 'payer')).toBe(false);
  });

  it('uses io:input so a transformed field is its SENT shape, not the parsed one', () => {
    // price -> .transform(BigInt): the wire value is a digit string, never a bigint
    // (which JSON Schema can't even express). status has a default -> optional on
    // input; partial drafts gave title/bodyMd defaults too, so they're required
    // only to PUBLISH (the superRefine) — beyond a static required list.
    const postCreate = doc.components.schemas.PostCreate!;
    expect(postCreate.properties?.price).toMatchObject({ type: 'string' });
    expect(postCreate.required ?? []).not.toContain('status');
    expect(postCreate.required ?? []).not.toContain('title');
    expect(postCreate.required ?? []).not.toContain('bodyMd');
    expect(Object.hasOwn(postCreate.properties!, 'title')).toBe(true);
    expect(Object.hasOwn(postCreate.properties!, 'bodyMd')).toBe(true);
  });

  it('describes the publish searchId by the name the search endpoint returns', () => {
    // The wire calls it searchId (#463); "lookup id" is the pre-rename spelling and
    // matches nothing an agent can see. Both authoring schemas share one .describe().
    for (const name of ['PostCreate', 'PostUpdate'] as const) {
      const description = doc.components.schemas[name]!.properties?.searchId?.description;
      expect(description, name).toMatch(/searchId/);
      expect(description, name).not.toMatch(/\blookup id\b/i);
    }
  });

  it('covers the conventional CRUD surface + the x402 paid read, but not the HTML reader', () => {
    for (const p of [
      '/api/posts',
      '/api/posts/{id}',
      '/api/me',
      '/api/me/stats',
      '/api/me/events',
      '/api/library',
      '/api/read/{handle}/{slug}/markdown',
      '/api/images',
      '/api/images/{id}',
      '/api/import/jobs',
      '/api/import/jobs/{id}',
      '/api/import/jobs/{id}/commit',
      '/api/agent/search',
      '/api/searches/{id}/outcomes',
      // Load-bearing: this list is an allowlist, so a new agent-facing surface is
      // only guarded once its path is named here. /api/answer was added with the
      // endpoint precisely so forgetting to advertise it fails a test.
      '/api/answer',
      '/api/health',
    ]) {
      expect(doc.paths[p], `missing path ${p}`).toBeTruthy();
    }
    // The x402 paid read IS declared now: x-payment-info + a 402 response is how
    // x402scan / CDP-Bazaar classify an operation as x402-paid. (The sibling
    // /markdown download — a plain SIWX/public read, not an x402 surface — is
    // modeled separately above.)
    const read = doc.paths['/api/read/{handle}/{slug}']?.get;
    expect(read, 'missing /api/read/{handle}/{slug}').toBeTruthy();
    expect(read?.['x-payment-info']?.protocols).toContainEqual({ x402: {} });
    // toEqual (not toMatchObject): pins that NO min/max band is published (a fabricated
    // band would mislead an indexer that risk-scores on it).
    expect(read?.['x-payment-info']?.price).toEqual({ mode: 'dynamic', currency: 'USD' });
    expect(read?.responses?.['402']).toBeTruthy();
    expect(read?.responses?.['200']).toBeTruthy();
    expect(read?.parameters).toContainEqual(
      expect.objectContaining({
        name: 'X-Tenjin-Search-Id',
        in: 'header',
        required: false,
        schema: { type: 'string', format: 'uuid' },
      }),
    );
    // A word-handle `latest` is non-payable: the 400 recovery contract must be
    // DECLARED, not just described in prose, so a generated client can model it and
    // read the address to persist from error.details.canonicalUrl.
    const resp400 = read?.responses?.['400'] as
      | {
          content?: {
            'application/json'?: {
              schema?: {
                properties?: {
                  error?: {
                    properties?: {
                      details?: {
                        required?: string[];
                        properties?: { canonicalUrl?: { type?: string; format?: string } };
                      };
                    };
                  };
                };
              };
              example?: { error?: { code?: string; details?: { canonicalUrl?: string } } };
            };
          };
        }
      | undefined;
    expect(resp400, 'missing 400 latest_requires_address recovery contract').toBeTruthy();
    const json400 = resp400?.content?.['application/json'];
    // The recovery field is TYPED (not the generic untyped Error.details), so a
    // generated client models details.canonicalUrl as a required uri string.
    const details400 = json400?.schema?.properties?.error?.properties?.details;
    expect(details400?.required).toContain('canonicalUrl');
    expect(details400?.properties?.canonicalUrl?.type).toBe('string');
    expect(details400?.properties?.canonicalUrl?.format).toBe('uri');
    // The example is code-correct AND absolute, matching the readApiUrl runtime shape
    // (a relative example would disagree with what the route actually returns).
    const ex400 = json400?.example;
    expect(ex400?.error?.code).toBe('latest_requires_address');
    expect(ex400?.error?.details?.canonicalUrl).toMatch(
      /^https?:\/\/.+\/api\/read\/0x[0-9a-fA-F]+\/latest$/,
    );
    // Payment (not SIWX) gates the body — the op declares no securityScheme.
    expect(read?.security).toBeUndefined();
    // The content-negotiated HTML reader (/a/<handle>/<slug>) is not modeled separately.
    expect(doc.paths['/a/{handle}/{slug}']).toBeUndefined();
    expect(doc.info.description).toMatch(/x402/);
    expect(doc.info.description).toContain(`${APP_URL}/llms.txt`);
  });

  it('documents exactly the discoveryQuerySchema keys as /api/articles GET params (drift guard)', () => {
    // discoveryQuerySchema (lib/discovery.ts) is the source of truth for the
    // GET /api/articles query params; the OpenAPI parameters list is hand-written
    // and can silently drift. Derive the expected key set from the schema shape —
    // never a hardcoded list — so this passes before and after a param is added to
    // both. Set equality both ways: a param documented but absent from the schema
    // (or vice versa) fails.
    const params = doc.paths['/api/articles']?.get?.parameters;
    expect(params, 'missing /api/articles GET parameters').toBeTruthy();
    const documented = params!.map((p) => p.name).sort();
    const schemaKeys = Object.keys(discoveryQuerySchema.shape).sort();
    expect(documented).toEqual(schemaKeys);
  });

  it('gates writes + authed reads with SIWX, leaves the public reads open', () => {
    const requiresSiwx = (op: Operation | undefined) =>
      expect(op?.security).toEqual([{ siwx: [] }]);
    requiresSiwx(doc.paths['/api/posts']?.post);
    requiresSiwx(doc.paths['/api/posts']?.get);
    requiresSiwx(doc.paths['/api/posts/{id}']?.put);
    requiresSiwx(doc.paths['/api/me']?.get);
    requiresSiwx(doc.paths['/api/library']?.get);
    requiresSiwx(doc.paths['/api/me/stats']?.get);
    requiresSiwx(doc.paths['/api/import/jobs']?.post);
    requiresSiwx(doc.paths['/api/import/jobs']?.get);
    requiresSiwx(doc.paths['/api/import/jobs/{id}']?.get);
    requiresSiwx(doc.paths['/api/import/jobs/{id}/commit']?.post);
    requiresSiwx(doc.paths['/api/me/events']?.get);
    // Public surface is EXPLICITLY open (security: []), not merely unspecified.
    expect(doc.paths['/api/health']?.get?.security).toEqual([]);
    expect(doc.paths['/api/images/{id}']?.get?.security).toEqual([]);
    // The agent lookup + outcome endpoints are anonymous (the uuid searchId is the
    // only capability) — explicitly open, never SIWX-gated.
    expect(doc.paths['/api/agent/search']?.post?.security).toEqual([]);
    expect(doc.paths['/api/searches/{id}/outcomes']?.post?.security).toEqual([]);
    // The markdown download is conditionally gated: free open, paid SIWX — modeled
    // as optional auth ("no auth OR siwx"), not [] and not [{siwx}].
    expect(doc.paths['/api/read/{handle}/{slug}/markdown']?.get?.security).toEqual([
      {},
      { siwx: [] },
    ]);
  });

  it('documents how logout revokes, including the session-delegation carve-out', () => {
    // OpenAPI is a standalone surface: a client that reads only this spec has no
    // other way to learn how to kill a session key. The route verifies the
    // presented proof itself rather than sitting behind withAuth, and it is the
    // one place a bare delegation authenticates, so pin both against a drift back
    // to the stale "withAuth-gated" prose (#517 review).
    const description = doc.paths['/api/auth/logout']?.post?.description ?? '';
    expect(description).not.toMatch(/withAuth/);
    expect(description).toContain('session delegation');
    expect(description).toContain('SIGN-IN-WITH-X');
  });

  it('every $ref resolves to a defined component', () => {
    const refs = collectRefs(doc);
    expect(refs.length).toBeGreaterThan(0);
    const components = doc.components as unknown as Record<string, Record<string, unknown>>;
    for (const ref of refs) {
      const m = ref.match(/^#\/components\/(schemas|securitySchemes)\/(.+)$/);
      expect(m, `unexpected $ref form: ${ref}`).toBeTruthy();
      const group = m![1]!;
      const name = m![2]!;
      expect(components[group]?.[name], `dangling $ref ${ref}`).toBeTruthy();
    }
  });

  it('builds the server URL from the caller origin (no hardcoded host, no double slash)', () => {
    const preview = buildOpenApiDocument(
      'https://tenjin-pr-42.vercel.app/',
      'on',
    ) as unknown as Doc;
    expect(preview.servers[0]?.url).toBe('https://tenjin-pr-42.vercel.app');
    expect(JSON.stringify(preview)).not.toContain('vercel.app//');
    // The prod host must not leak into any origin-DERIVED field — servers + the two
    // URL-bearing descriptions all build off `base`. (info.contact.email is a constant
    // mailbox that legitimately carries the domain, so we can't scan the whole doc.)
    expect(preview.servers[0]?.url).not.toContain('tenjin.sh');
    expect(preview.info.description).not.toContain('tenjin.sh');
    expect(preview.info['x-guidance']).not.toContain('tenjin.sh');
    expect(preview.components.securitySchemes.siwx!.description).not.toContain('tenjin.sh');
  });

  it('omits the answer endpoint while ANSWER_API is off', () => {
    const disabled = buildOpenApiDocument(APP_URL, 'off') as unknown as Doc;
    expect(disabled.paths['/api/answer']).toBeUndefined();
    expect(doc.paths['/api/answer']).toBeTruthy();
  });

  it('publishes `matched` on SearchResult as an optional non-negative count', () => {
    // The explicit hit count v2 expressed as decision:'MISS'. Optional because a
    // no-query browse listing never matched anything, so requiring it would
    // force a meaningless zero onto the catalog feed.
    const schema = doc.components.schemas.SearchResult as JsonSchema;
    const matched = schema?.properties?.matched as JsonSchema | undefined;
    expect(matched, 'SearchResult does not publish matched').toBeTruthy();
    expect(matched!.type).toBe('integer');
    expect(matched!.minimum).toBe(0);
    expect(String(matched!.description)).toMatch(/0 is a miss/i);
    // Required now: every v3 response is a search result, so the count always
    // applies — there is no no-query listing left for it to be meaningless on.
    expect(schema.required ?? []).toContain('matched');
  });

  it('publishes `warnings` on BOTH search response schemas, where the routes emit it', () => {
    // The prose promised `warnings` while no response schema carried it, so a
    // codegen client had no field to read it into. Pinned on both because both
    // routes emit it: v3 from SEARCH_REQUEST_KEYS, the alias from
    // LOOKUP_REQUEST_KEYS, each plus the redundant query spellings.
    for (const name of ['SearchResult', 'SearchResponse']) {
      const schema = doc.components.schemas[name] as JsonSchema;
      const warnings = schema?.properties?.warnings as JsonSchema | undefined;
      expect(warnings, `${name} does not publish warnings`).toBeTruthy();
      expect(warnings!.type).toBe('array');
      expect((warnings!.items as JsonSchema).type).toBe('string');
      expect(String(warnings!.description)).toMatch(/non-fatal/i);
      // Optional: a clean request omits it, so requiring it would be a lie.
      expect(schema.required ?? []).not.toContain('warnings');
    }
  });

  it('names both `warnings` contributors on OwnPost (review 4978761512)', () => {
    // OWN_POST_SCHEMA.warnings only documented dropped body images; an agent
    // branching on `warnings` had no contract for the empty-paid-preview nudge
    // (#721) landing in the same array.
    const schema = doc.components.schemas.OwnPost as JsonSchema;
    const warnings = schema?.properties?.warnings as JsonSchema | undefined;
    expect(warnings, 'OwnPost does not publish warnings').toBeTruthy();
    expect(String(warnings!.description)).toMatch(/image/i);
    expect(String(warnings!.description)).toMatch(/paywall/i);
  });
});
