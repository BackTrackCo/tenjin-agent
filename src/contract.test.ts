import { describe, it, expect, beforeAll } from 'vitest';
import type { z } from 'zod';
import fixtureJson from './fixtures/openapi.fixture.json';
import { searchBrowseSchema, searchCandidateSchema, searchResponseSchema } from './lib/agent-api';
import { OUTCOME_STATUS_VALUES } from './lib/agent-api';
import { previewCardSchema } from './lib/read-client';
import { buildPostCreateBody } from './lib/posts-api';
import { deriveCard } from './lib/card';

// Pins the CLI's wire schemas against the committed server contract fixture
// (the live tenjin.blog/openapi.json, the A3 publish deploy: it carries the
// resource card + the cacheEligible echo alongside the A2 agent-search surface).
// Every assertion here is a pure walk of the OpenAPI document, so a server-side
// rename or removal that would break the CLI fails THIS suite before it fails in
// production. The env-gated section at the bottom re-runs the same walks against a
// live deployment and is the only test allowed to touch the network.

const fixtureDoc: unknown = fixtureJson;

/** Walk a path of keys/indices into an unknown JSON value; undefined on miss. */
function get(value: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[key];
    } else {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  return cur;
}

/**
 * The keys a zod object schema demands (rejects undefined for). Derived from the
 * schema itself so the pin tracks what the CLI actually requires, not a copy.
 */
function requiredKeys(schema: { shape: Record<string, z.ZodType> }): string[] {
  return Object.entries(schema.shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key)
    .sort();
}

// The contract the CLI relies on, written out long-hand: if either the CLI
// schema or the fixture drifts from these lists, the drift is the failure.
const RESPONSE_REQUIRED = ['calibration', 'decision', 'schemaVersion', 'searchId'];
// The lean candidate of search v2: eleven keys, no card fields. Everything the
// candidate used to carry about what a piece actually says now lives on the read
// route's 402 body, one free unpaid GET away (see READ_CARD_REQUIRED below).
const CANDIDATE_REQUIRED = [
  'artifactType',
  'asOf',
  'creator',
  'estimatedTokens',
  'matchReasons',
  'price',
  'resourceId',
  'slug',
  'title',
  'url',
  'validUntil',
];
// The card fields that MOVED from the candidate to the 402 preview. Pinned as a
// negative: a server that puts them back on a candidate has un-done search v2, and
// the CLI would be re-reading depth from the breadth step.
const CANDIDATE_MOVED_TO_INSPECT = [
  'questionsAnswered',
  'tasksSupported',
  'appliesTo',
  'scope',
  'exclusions',
  'temporalMode',
];
// The answer card on the unpaid 402 body: twelve fields, all required WITHIN the
// card, with the card itself optional (an uncarded piece omits the key entirely).
const READ_CARD_REQUIRED = [
  'appliesTo',
  'artifactType',
  'asOf',
  'exclusions',
  'maintenanceCadence',
  'methodologySummary',
  'provenanceSummary',
  'questionsAnswered',
  'scope',
  'tasksSupported',
  'temporalMode',
  'validUntil',
];
// The MISS-only browse tail (tenjin#460). Deliberately minimal: if the server
// ever grows it a matchReasons/confidence field, that is a contract change the
// CLI must see, because a browse pointer must never read as a scored candidate.
const BROWSE_REQUIRED = ['creator', 'price', 'resourceId', 'title', 'url'];

function assertAgentPaths(doc: unknown): void {
  expect(get(doc, 'paths', '/api/agent/search', 'post', 'operationId')).toBe('agentSearch');
  expect(get(doc, 'paths', '/api/agent/searches/{id}/outcomes', 'post', 'operationId')).toBe(
    'agentSearchOutcomes',
  );
}

function assertSchemaDeclares(doc: unknown, schemaName: string, fields: string[]): void {
  const schema = get(doc, 'components', 'schemas', schemaName);
  expect(schema, `components.schemas.${schemaName} missing`).toBeDefined();
  const properties = get(schema, 'properties');
  const required = get(schema, 'required');
  for (const field of fields) {
    expect(get(properties, field), `${schemaName}.properties.${field} missing`).toBeDefined();
    expect(required, `${schemaName}.required must list ${field}`).toContain(field);
  }
}

function assertSearchRequest(doc: unknown): void {
  const properties = get(doc, 'components', 'schemas', 'SearchRequest', 'properties');
  for (const field of [
    'schemaVersion',
    'question',
    'freshWithin',
    'maxPrice',
    'appliesTo',
    'limit',
  ]) {
    expect(get(properties, field), `SearchRequest.properties.${field} missing`).toBeDefined();
  }
  expect(get(properties, 'question', 'maxLength')).toBe(512);
}

function assertOutcomeStatusEnum(doc: unknown): void {
  // SearchOutcomeSubmit is an anyOf of a single report object and a batch array
  // of the same object; the status enum must be identical wherever it appears.
  const schema = get(doc, 'components', 'schemas', 'SearchOutcomeSubmit');
  expect(schema, 'components.schemas.SearchOutcomeSubmit missing').toBeDefined();
  const branches = get(schema, 'anyOf');
  const variants = Array.isArray(branches) ? branches : [schema];
  const enums = variants
    .map(
      (v) =>
        get(v, 'properties', 'status', 'enum') ?? get(v, 'items', 'properties', 'status', 'enum'),
    )
    .filter((e) => e !== undefined);
  expect(enums.length).toBeGreaterThan(0);
  for (const found of enums) {
    expect(found).toEqual([...OUTCOME_STATUS_VALUES]);
  }
}

describe('contract fixture pins the agent endpoints', () => {
  it('declares POST /api/agent/search and /api/agent/searches/{id}/outcomes', () => {
    assertAgentPaths(fixtureDoc);
  });
});

describe('contract fixture covers every field the CLI requires', () => {
  it('the CLI requires exactly the pinned SearchResponse fields', () => {
    expect(requiredKeys(searchResponseSchema)).toEqual(RESPONSE_REQUIRED);
  });

  it('the CLI requires exactly the pinned SearchCandidate fields', () => {
    expect(requiredKeys(searchCandidateSchema)).toEqual(CANDIDATE_REQUIRED);
  });

  it.each(RESPONSE_REQUIRED)('SearchResponse declares required field %s', (field) => {
    assertSchemaDeclares(fixtureDoc, 'SearchResponse', [field]);
  });

  it.each(CANDIDATE_REQUIRED)('SearchCandidate declares required field %s', (field) => {
    assertSchemaDeclares(fixtureDoc, 'SearchCandidate', [field]);
  });

  it('the CLI requires exactly the pinned SearchBrowse fields', () => {
    expect(requiredKeys(searchBrowseSchema)).toEqual(BROWSE_REQUIRED);
  });

  it.each(BROWSE_REQUIRED)('SearchBrowse declares required field %s', (field) => {
    assertSchemaDeclares(fixtureDoc, 'SearchBrowse', [field]);
  });

  it('SearchBrowse carries no score-like field a candidate would have', () => {
    const properties = get(fixtureDoc, 'components', 'schemas', 'SearchBrowse', 'properties');
    for (const scoreish of ['matchReasons', 'estimatedTokens', 'confidence']) {
      expect(
        get(properties, scoreish),
        `SearchBrowse must not declare ${scoreish}`,
      ).toBeUndefined();
    }
  });

  it('SearchCandidate carries none of the card fields that moved to inspect', () => {
    const properties = get(fixtureDoc, 'components', 'schemas', 'SearchCandidate', 'properties');
    for (const moved of CANDIDATE_MOVED_TO_INSPECT) {
      expect(get(properties, moved), `SearchCandidate must not declare ${moved}`).toBeUndefined();
    }
  });
});

// The 402 preview's answer card (tenjin#500): the depth half of the two-step
// flow, and the only place the CLI can now read what a piece actually claims
// before paying. Pinned here rather than trusted, because search v2 removed the
// fallback: if the card silently vanishes from the preview, `tenjin inspect`
// renders a price and nothing to judge it against.
function readCardProps(doc: unknown): unknown {
  return get(
    doc,
    'components',
    'schemas',
    'ReadArticlePreview',
    'properties',
    'card',
    'properties',
  );
}

function assertReadCard(doc: unknown): void {
  const preview = get(doc, 'components', 'schemas', 'ReadArticlePreview');
  expect(preview, 'components.schemas.ReadArticlePreview missing').toBeDefined();
  // The card is OPTIONAL on the preview: an uncarded piece omits the key rather
  // than sending null, which is exactly what the CLI branches on.
  expect(get(preview, 'required'), 'ReadArticlePreview must not require card').not.toContain(
    'card',
  );
  const card = get(preview, 'properties', 'card');
  expect(card, 'ReadArticlePreview.properties.card missing').toBeDefined();
  const required = get(card, 'required');
  for (const field of READ_CARD_REQUIRED) {
    expect(get(readCardProps(doc), field), `card.properties.${field} missing`).toBeDefined();
    expect(required, `card.required must list ${field}`).toContain(field);
  }
}

describe('contract fixture pins the 402 answer card', () => {
  it('the CLI requires exactly the pinned card fields', () => {
    expect(requiredKeys(previewCardSchema)).toEqual(READ_CARD_REQUIRED);
  });

  it('ReadArticlePreview declares an optional card with every required field', () => {
    assertReadCard(fixtureDoc);
  });

  it('a 402 body shaped like the fixture parses through the CLI preview schema', () => {
    const parsed = previewCardSchema.parse({
      artifactType: 'document',
      temporalMode: 'snapshot',
      asOf: '2026-07-01T00:00:00.000Z',
      validUntil: null,
      questionsAnswered: ['What do Base transactions cost right now?'],
      tasksSupported: ['estimate gas spend'],
      appliesTo: { products: ['Base'] },
      scope: 'L2 execution fees only',
      exclusions: null,
      provenanceSummary: 'Measured against mainnet over one week.',
      methodologySummary: null,
      maintenanceCadence: null,
    });
    expect(parsed.artifactType).toBe('document');
  });
});

describe('contract fixture request shapes', () => {
  it('SearchRequest carries the fields the CLI sends, question capped at 512', () => {
    assertSearchRequest(fixtureDoc);
  });

  it('SearchOutcomeSubmit status enum is exactly the five CLI statuses', () => {
    assertOutcomeStatusEnum(fixtureDoc);
  });
});

describe('a response shaped like the fixture parses through the CLI schema', () => {
  // Hand-built to the fixture's declared shapes (the fixture embeds no example):
  // uuid ids, atomic USDC digit-string price, nullable date-times, integer
  // estimatedTokens, and the CANDIDATES/MISS split on `candidates` presence.
  const candidate = {
    resourceId: '5b3e2b1a-8c4d-4f6e-9a2b-1c3d5e7f9a0b',
    url: 'https://tenjin.blog/api/read/alice/base-fee-snapshot',
    slug: 'base-fee-snapshot',
    title: 'Base fee snapshot, July 2026',
    artifactType: 'document',
    price: '500000',
    asOf: '2026-07-01T00:00:00.000Z',
    validUntil: null,
    matchReasons: ['answer-card: base fees'],
    estimatedTokens: 1200,
    creator: { handle: 'alice' },
  };
  const response = {
    schemaVersion: 2,
    searchId: '0f8b2d4c-6a1e-4b3f-8c5d-7e9f1a2b3c4d',
    decision: 'CANDIDATES',
    calibration: 'lexical-v1',
    candidates: [candidate],
  };

  it('the hand-built candidate only uses fields the fixture declares', () => {
    const declared = get(fixtureDoc, 'components', 'schemas', 'SearchCandidate', 'properties');
    for (const key of Object.keys(candidate)) {
      expect(get(declared, key), `fixture does not declare candidate field ${key}`).toBeDefined();
    }
  });

  it('searchResponseSchema.parse accepts a CANDIDATES response', () => {
    const parsed = searchResponseSchema.parse(response);
    expect(parsed.decision).toBe('CANDIDATES');
    expect(parsed.candidates).toHaveLength(1);
  });

  it('searchResponseSchema.parse accepts a MISS with candidates omitted', () => {
    const miss = {
      schemaVersion: 2,
      searchId: response.searchId,
      decision: 'MISS',
      calibration: 'lexical-v1',
    };
    expect(searchResponseSchema.parse(miss).candidates).toBeUndefined();
  });

  it('searchResponseSchema.parse keeps the optional truncated flag', () => {
    expect(searchResponseSchema.parse({ ...response, truncated: true }).truncated).toBe(true);
    expect(searchResponseSchema.parse(response).truncated).toBeUndefined();
  });
});

// The publish surface (A3, tenjin#382): the CLI sends a strictObject PostCreate
// with an optional strictObject `resource` card and reads the cacheEligible echo.
// Every field the CLI emits must be declared by the fixture, and the card bounds
// the CLI validates locally must match the server's, or the drift fails here.
const POST_CREATE_FIELDS = ['title', 'bodyMd', 'excerpt', 'tags', 'price', 'handle', 'status'];
const CARD_INPUT_FIELDS = [
  'artifactType',
  'mediaType',
  'temporalMode',
  'asOf',
  'validUntil',
  'supersedesPostId',
  'questionsAnswered',
  'tasksSupported',
  'scope',
  'exclusions',
  'appliesTo',
  'provenanceSummary',
  'methodologySummary',
  'maintenanceCadence',
  'reproductionMinutes',
  'estimatedPaidInputCost',
];

function assertPostPaths(doc: unknown): void {
  expect(get(doc, 'paths', '/api/posts', 'post', 'operationId')).toBe('createPost');
  expect(get(doc, 'paths', '/api/posts/{id}', 'put', 'operationId')).toBe('updatePost');
}

function postCreateProps(doc: unknown): unknown {
  return get(doc, 'components', 'schemas', 'PostCreate', 'properties');
}
function cardInputProps(doc: unknown): unknown {
  return get(postCreateProps(doc), 'resource', 'properties');
}

/**
 * The nullable card fields are declared as `anyOf: [<schema>, {type:'null'}]`, so
 * their bounds live one level in. Return the non-null branch (or the node itself
 * for a plain, non-nullable field) so a single `bound()` reads either shape.
 */
function nonNull(node: unknown): unknown {
  const anyOf = get(node, 'anyOf');
  if (Array.isArray(anyOf)) {
    return anyOf.find((b) => get(b, 'type') !== 'null') ?? node;
  }
  return node;
}
function bound(props: unknown, field: string, ...path: (string | number)[]): unknown {
  return get(nonNull(get(props, field)), ...path);
}

function assertPublishContract(doc: unknown): void {
  // PostCreate is strict and declares every top-level field the CLI sends.
  expect(get(doc, 'components', 'schemas', 'PostCreate', 'additionalProperties')).toBe(false);
  for (const field of POST_CREATE_FIELDS) {
    expect(get(postCreateProps(doc), field), `PostCreate.${field} missing`).toBeDefined();
  }
  // The resource card is a strictObject declaring every card field the CLI emits.
  expect(get(postCreateProps(doc), 'resource', 'additionalProperties')).toBe(false);
  for (const field of CARD_INPUT_FIELDS) {
    expect(get(cardInputProps(doc), field), `resource.${field} missing`).toBeDefined();
  }
  // The full bounds block the CLI hard-codes as literals. A server move on any of
  // these regenerates the fixture but silently diverges from the CLI, so pin the
  // lot — a mismatch here is the drift.
  const top = postCreateProps(doc);
  expect(bound(top, 'title', 'maxLength')).toBe(200);
  expect(bound(top, 'bodyMd', 'maxLength')).toBe(200000);
  expect(bound(top, 'excerpt', 'maxLength')).toBe(500);
  expect(bound(top, 'tags', 'maxItems')).toBe(5);
  expect(bound(top, 'tags', 'items', 'minLength')).toBe(1);
  expect(bound(top, 'tags', 'items', 'maxLength')).toBe(50);
  expect(bound(top, 'price', 'pattern')).toBe('^(0|[1-9]\\d{0,12})$');
  expect(bound(top, 'handle', 'pattern')).toBe('^[a-z0-9-]{2,32}$');
  expect(bound(top, 'status', 'enum')).toEqual(['draft', 'published', 'unlisted']);

  const card = cardInputProps(doc);
  expect(bound(card, 'mediaType', 'maxLength')).toBe(100);
  expect(bound(card, 'mediaType', 'pattern')).toBe('^[a-z0-9]+\\/[a-z0-9][a-z0-9.+-]*$');
  expect(bound(card, 'artifactType', 'enum')).toEqual(['document', 'skill', 'dataset']);
  expect(bound(card, 'temporalMode', 'enum')).toEqual(['snapshot', 'maintained', 'evergreen']);
  for (const f of ['scope', 'exclusions', 'provenanceSummary', 'methodologySummary']) {
    expect(bound(card, f, 'maxLength'), `resource.${f} maxLength`).toBe(500);
  }
  for (const f of ['questionsAnswered', 'tasksSupported']) {
    expect(bound(card, f, 'maxItems'), `resource.${f} maxItems`).toBe(10);
    expect(bound(card, f, 'items', 'maxLength'), `resource.${f} items`).toBe(200);
  }
  expect(bound(card, 'maintenanceCadence', 'maxLength')).toBe(120);
  expect(bound(card, 'reproductionMinutes', 'minimum')).toBe(0);
  expect(bound(card, 'reproductionMinutes', 'maximum')).toBe(1000000);
  expect(bound(card, 'appliesTo', 'additionalProperties', 'items', 'maxLength')).toBe(120);
  // The CLI's own appliesTo 8-KEY cap is local-stricter: the server accepts up to
  // 8 keys but the fixture declares no `maxProperties`, so this divergence has NO
  // fixture counterpart and cannot be pinned here — asserted only in card.test.ts.
  expect(bound(card, 'appliesTo', 'maxProperties')).toBeUndefined();

  // The echo the CLI reads back.
  const echo = get(doc, 'components', 'schemas', 'ResourceCard', 'properties');
  expect(get(echo, 'cacheEligible'), 'ResourceCard.cacheEligible missing').toBeDefined();
  expect(
    get(echo, 'cacheEligibleMissing'),
    'ResourceCard.cacheEligibleMissing missing',
  ).toBeDefined();
}

describe('contract fixture pins the publish endpoints', () => {
  it('declares POST /api/posts and PUT /api/posts/{id}', () => {
    assertPostPaths(fixtureDoc);
  });

  it('the PostCreate + resource card shape the CLI sends is fully declared', () => {
    assertPublishContract(fixtureDoc);
  });

  it('every field buildPostCreateBody emits is a declared PostCreate field', () => {
    const body = buildPostCreateBody({
      status: 'published',
      title: 'T',
      bodyMd: 'B',
      excerpt: 'e',
      tags: ['x'],
      priceAtomic: '100000',
      handle: 'iris',
    });
    const declared = postCreateProps(fixtureDoc);
    for (const key of Object.keys(body)) {
      expect(get(declared, key), `fixture does not declare PostCreate field ${key}`).toBeDefined();
    }
  });

  it('every field deriveCard emits is a declared resource field', () => {
    const card = deriveCard(
      {},
      {
        artifactType: 'document',
        temporalMode: 'snapshot',
        asOf: '2026-07-01T00:00:00Z',
        validUntil: '2026-08-01T00:00:00Z',
        question: ['q'],
        task: ['t'],
        scope: 's',
        exclusions: 'x',
        provenance: 'p',
        methodology: 'm',
        appliesTo: { products: ['Vercel'] },
      },
    );
    const declared = cardInputProps(fixtureDoc);
    for (const key of Object.keys(card ?? {})) {
      expect(get(declared, key), `fixture does not declare resource field ${key}`).toBeDefined();
    }
  });
});

// The only network-touching section in the whole suite, and only when
// TENJIN_CONTRACT_BASE_URL is set: fetch the live openapi.json and re-run the
// structural pins (assertions 1-4) against the deployment itself.
const liveBase = process.env.TENJIN_CONTRACT_BASE_URL;
describe.skipIf(liveBase === undefined || liveBase === '')(
  'live contract at TENJIN_CONTRACT_BASE_URL',
  () => {
    let liveDoc: unknown;
    beforeAll(async () => {
      const url = `${(liveBase as string).replace(/\/+$/, '')}/openapi.json`;
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`GET ${url} failed with status ${res.status}`);
      liveDoc = await res.json();
    });

    it('declares the agent search and outcomes operations', () => {
      assertAgentPaths(liveDoc);
    });

    it('SearchResponse, SearchCandidate and SearchBrowse declare every CLI-required field', () => {
      assertSchemaDeclares(liveDoc, 'SearchResponse', RESPONSE_REQUIRED);
      assertSchemaDeclares(liveDoc, 'SearchCandidate', CANDIDATE_REQUIRED);
      assertSchemaDeclares(liveDoc, 'SearchBrowse', BROWSE_REQUIRED);
    });

    it('SearchRequest matches what the CLI sends', () => {
      assertSearchRequest(liveDoc);
    });

    it('SearchOutcomeSubmit status enum matches the CLI', () => {
      assertOutcomeStatusEnum(liveDoc);
    });

    it('declares the publish endpoints and the resource-card shape the CLI sends', () => {
      assertPostPaths(liveDoc);
      assertPublishContract(liveDoc);
    });

    it('the 402 preview declares the optional answer card', () => {
      assertReadCard(liveDoc);
    });
  },
);
