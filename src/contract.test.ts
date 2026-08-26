import { describe, it, expect, beforeAll } from 'vitest';
import type { z } from 'zod';
import fixtureJson from './fixtures/openapi.fixture.json';
import { searchCandidateSchema, searchResultSchema } from './lib/agent-api';
import { OUTCOME_STATUS_VALUES } from './lib/agent-api';
import { previewCardSchema } from './lib/read-client';
import {
  buildPostCreateBody,
  buildPostUpdateBody,
  ownPostSchema,
  resourceEchoSchema,
  SEARCH_ID_MAX,
  SEARCH_ID_WIRE_RE,
  creatorProfileSchema,
  PROFILE_BIO_MAX,
  PROFILE_DISPLAY_NAME_MAX,
  PROFILE_HANDLE_RE,
} from './lib/posts-api';
import { deriveCard } from './lib/card';
import { CliError } from './lib/errors';

/** A well-formed searchId (uuidv7, as the server mints). */
const SEARCH_ID = '0197aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

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
const RESULT_REQUIRED = ['calibration', 'items', 'matched', 'schemaVersion', 'searchId'];
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
//
// `temporalMode` is deliberately NOT in this list any more. The server put it back
// on the candidate as a cheap freshness label (it is one open-registry string, not
// an answer card), and both live `/openapi.json` and the vendored
// `skills/tenjin/SKILL.md` now document it as a candidate field. The record tracks
// reality: five fields are still card-only, and those five are what this pins.
const CANDIDATE_MOVED_TO_INSPECT = [
  'questionsAnswered',
  'tasksSupported',
  'appliesTo',
  'scope',
  'exclusions',
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

/**
 * An operation the CLI calls, pinned with the retirement state the server
 * advertises TODAY. Presence alone is a lagging signal: a path stays green until
 * the server deletes it, and by then released CLIs are already taking 404s.
 * `deprecated` is the server's own retirement notice and it lands a release
 * ahead of the deletion, so recording it is what buys lead time.
 */
interface PinnedOp {
  path: string;
  method: 'get' | 'post' | 'put';
  operationId: string;
  /** The state live advertises now. A change in EITHER direction is drift. */
  deprecated: boolean;
  /** Named in the failure message, so a red run says where the callers go. */
  migration: string;
}

const AGENT_OPS: PinnedOp[] = [
  {
    path: '/api/search',
    method: 'post',
    operationId: 'search',
    // THE search endpoint since #137. The `/api/agent/search` alias this client
    // used to call is deprecated and answers 410 after one release, so there is
    // nothing left to fall back to: if this path retires, `tenjin search` stops.
    deprecated: false,
    migration:
      'search has no second path since the /api/agent/search alias retired (#137); `tenjin search` stops here',
  },
  {
    path: '/api/searches/{id}/outcomes',
    method: 'post',
    operationId: 'agentSearchOutcomes',
    // tenjin#616 dropped the `/agent` prefix here. The prefixed spelling survives
    // as an undocumented alias for one window, so pinning the documented path is
    // what keeps the CLI on the surviving one.
    deprecated: false,
    migration: 'outcome reporting has no second path; `tenjin outcome` stops here',
  },
];

function assertPinnedOp(doc: unknown, op: PinnedOp): void {
  const label = `${op.method.toUpperCase()} ${op.path}`;
  expect(
    get(doc, 'paths', op.path, op.method, 'operationId'),
    `${label} (${op.operationId}) is gone from the spec: ${op.migration}`,
  ).toBe(op.operationId);
  // Equality against the RECORDED state, not `.not.toBe(true)`: an already
  // announced retirement stays green (it is recorded, and #137 tracks it) while
  // a newly announced one fails here, one release before the path stops
  // answering. Un-deprecating fails too, because the record must track reality.
  expect(
    get(doc, 'paths', op.path, op.method, 'deprecated') === true,
    op.deprecated
      ? `${label} is recorded DEPRECATED but the spec no longer marks it; drop the record if the retirement is off`
      : `${label} is newly DEPRECATED and still answering, so this is the lead time: ${op.migration}`,
  ).toBe(op.deprecated);
}

function assertAgentPaths(doc: unknown): void {
  for (const op of AGENT_OPS) assertPinnedOp(doc, op);
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
  const properties = get(doc, 'components', 'schemas', 'SearchRequestV3', 'properties');
  for (const field of ['schemaVersion', 'query', 'view', 'filters', 'limit']) {
    expect(get(properties, field), `SearchRequestV3.properties.${field} missing`).toBeDefined();
  }
  expect(get(properties, 'query', 'maxLength')).toBe(512);
  // `decision` has to be a value `view` accepts, or every search this CLI sends
  // is a 400. Pinned as membership rather than as the default, because the CLI
  // names the view explicitly instead of relying on the server's default.
  expect(get(properties, 'view', 'enum')).toContain('decision');
  // The narrowings moved UNDER `filters` in v3, and that object is a strictObject
  // server-side: a top-level `maxPrice` is stripped into `warnings` and the search
  // silently runs unfiltered, so where these live is load-bearing, not cosmetic.
  const filters = get(properties, 'filters', 'properties');
  for (const field of ['freshWithin', 'maxPrice', 'appliesTo']) {
    expect(get(filters, field), `SearchRequestV3.filters.${field} missing`).toBeDefined();
  }
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

/** A deep copy of the fixture with one operation patched (or dropped), so the
 *  pin can be pointed at the drift it exists to catch. */
function patchedFixture(
  path: string,
  method: string,
  patch: Record<string, unknown> | null,
): unknown {
  const doc = structuredClone(fixtureJson) as unknown as {
    paths: Record<string, Record<string, unknown> | undefined>;
  };
  const ops = doc.paths[path];
  if (ops === undefined) throw new Error(`fixture declares no path ${path}`);
  if (patch === null) {
    delete ops[method];
    return doc;
  }
  const op = ops[method];
  if (op === null || typeof op !== 'object')
    throw new Error(`fixture declares no ${method} ${path}`);
  Object.assign(op, patch);
  return doc;
}

/** The retired alias, recorded as deprecated, so the "a retirement cannot be
 *  called off" arm below still has a real deprecated operation to exercise. It is
 *  deliberately NOT in AGENT_OPS: the CLI does not call it any more, and pinning
 *  a path nothing depends on would make its eventual deletion a red build for
 *  nobody. */
const RETIRED_ALIAS: PinnedOp = {
  path: '/api/agent/search',
  method: 'post',
  operationId: 'agentSearch',
  deprecated: true,
  migration: 'the alias is retired; POST /api/search with `view: "decision"` is the endpoint',
};

describe('contract fixture pins the agent endpoints', () => {
  it('declares POST /api/search and /api/searches/{id}/outcomes', () => {
    assertAgentPaths(fixtureDoc);
  });

  it('the alias the CLI moved off is still advertised as deprecated, not as live', () => {
    assertPinnedOp(fixtureDoc, RETIRED_ALIAS);
  });

  // The guard exercised against the drift it is for. A pin that has only ever
  // passed is an assumption, and the failure TEXT is half the point: a red
  // scheduled run has to say where the callers go.
  it('fails on a newly deprecated operation, one release before it stops answering', () => {
    expect(() =>
      assertAgentPaths(patchedFixture('/api/searches/{id}/outcomes', 'post', { deprecated: true })),
    ).toThrow(/newly DEPRECATED and still answering/);
  });

  it('fails on a removed operation naming the migration, not undefined-vs-string', () => {
    expect(() => assertAgentPaths(patchedFixture('/api/search', 'post', null))).toThrow(
      /gone from the spec: search has no second path/,
    );
  });

  it('fails when a recorded retirement is called off, so the record cannot go stale', () => {
    expect(() =>
      assertPinnedOp(
        patchedFixture('/api/agent/search', 'post', { deprecated: false }),
        RETIRED_ALIAS,
      ),
    ).toThrow(/recorded DEPRECATED but the spec no longer marks it/);
  });
});

describe('contract fixture covers every field the CLI requires', () => {
  it('the CLI requires exactly the pinned SearchResult fields', () => {
    expect(requiredKeys(searchResultSchema)).toEqual(RESULT_REQUIRED);
  });

  it('the CLI requires exactly the pinned SearchCandidate fields', () => {
    expect(requiredKeys(searchCandidateSchema)).toEqual(CANDIDATE_REQUIRED);
  });

  it.each(RESULT_REQUIRED)('SearchResult declares required field %s', (field) => {
    assertSchemaDeclares(fixtureDoc, 'SearchResult', [field]);
  });

  it('SearchResult declares the optional miss hint the CLI renders', () => {
    // Optional, so it can never fail parsing: it fails SILENTLY instead, and a
    // renamed `hint` would just stop telling the reader where to browse.
    const properties = get(fixtureDoc, 'components', 'schemas', 'SearchResult', 'properties');
    expect(get(properties, 'hint'), 'SearchResult.properties.hint missing').toBeDefined();
    expect(get(properties, 'truncated'), 'SearchResult.properties.truncated missing').toBeDefined();
  });

  it.each(CANDIDATE_REQUIRED)('SearchCandidate declares required field %s', (field) => {
    assertSchemaDeclares(fixtureDoc, 'SearchCandidate', [field]);
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
  // The third state (tenjin#500): a piece that HAS a card the server could not
  // load. Also optional, because it is absent for both an uncarded piece and a
  // carded one, and the CLI reads it only to keep "attests nothing" from being
  // confused with "temporarily unreadable".
  expect(
    get(preview, 'properties', 'cardUnavailable'),
    'ReadArticlePreview.properties.cardUnavailable missing',
  ).toBeDefined();
  expect(
    get(preview, 'required'),
    'ReadArticlePreview must not require cardUnavailable',
  ).not.toContain('cardUnavailable');
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
  // estimatedTokens, and the v3 hit/miss split on whether `items` is empty.
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
    schemaVersion: 3,
    searchId: '0f8b2d4c-6a1e-4b3f-8c5d-7e9f1a2b3c4d',
    calibration: 'lexical-v1',
    items: [candidate],
    matched: 1,
  };

  it('the hand-built candidate only uses fields the fixture declares', () => {
    const declared = get(fixtureDoc, 'components', 'schemas', 'SearchCandidate', 'properties');
    for (const key of Object.keys(candidate)) {
      expect(get(declared, key), `fixture does not declare candidate field ${key}`).toBeDefined();
    }
  });

  it('searchResultSchema.parse accepts a result with matches', () => {
    const parsed = searchResultSchema.parse(response);
    expect(parsed.matched).toBe(1);
    expect(parsed.items).toHaveLength(1);
  });

  it('searchResultSchema.parse accepts a miss: empty items, a hint, no decision', () => {
    const miss = {
      schemaVersion: 3,
      searchId: response.searchId,
      calibration: 'lexical-v1',
      items: [],
      matched: 0,
      hint: 'No matches. Browse the catalog at GET /api/articles.',
    };
    const parsed = searchResultSchema.parse(miss);
    expect(parsed.items).toEqual([]);
    expect(parsed.matched).toBe(0);
    expect(parsed.hint).toBe('No matches. Browse the catalog at GET /api/articles.');
  });

  it('searchResultSchema.parse refuses the v2 envelope rather than reading it as a miss', () => {
    // The alias shape, which a mis-pointed base URL could still serve. `items` is
    // required, so this is a parse REFUSAL and not a silent zero-match result.
    const v2 = {
      schemaVersion: 2,
      searchId: response.searchId,
      decision: 'CANDIDATES',
      calibration: 'lexical-v1',
      candidates: [candidate],
    };
    expect(searchResultSchema.safeParse(v2).success).toBe(false);
  });

  it('searchResultSchema.parse keeps the optional truncated flag', () => {
    expect(searchResultSchema.parse({ ...response, truncated: true }).truncated).toBe(true);
    expect(searchResultSchema.parse(response).truncated).toBeUndefined();
  });
});

// The publish surface (A3, tenjin#382): the CLI sends a strictObject PostCreate
// with an optional strictObject `resource` card and reads the cacheEligible echo.
// Every field the CLI emits must be declared by the fixture, and the card bounds
// the CLI validates locally must match the server's, or the drift fails here.
const POST_CREATE_FIELDS = [
  'title',
  'bodyMd',
  'excerpt',
  'tags',
  'price',
  'handle',
  'status',
  'searchId',
];
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

const PUBLISH_OPS: PinnedOp[] = [
  {
    path: '/api/posts',
    method: 'post',
    operationId: 'createPost',
    deprecated: false,
    migration: 'publish has no second write path; `tenjin publish` stops here',
  },
  {
    path: '/api/posts/{id}',
    method: 'get',
    operationId: 'getOwnPost',
    deprecated: false,
    migration: '`tenjin edit` reads the current post through this before it merges',
  },
  {
    path: '/api/posts/{id}',
    method: 'put',
    operationId: 'updatePost',
    deprecated: false,
    migration: '`tenjin edit` writes through this alone',
  },
];

const ACCOUNT_OPS: PinnedOp[] = [
  {
    path: '/api/me',
    method: 'get',
    operationId: 'getMe',
    deprecated: false,
    migration: '`tenjin profile` reads through this alone',
  },
  {
    path: '/api/me',
    method: 'put',
    operationId: 'upsertMe',
    deprecated: false,
    migration: '`tenjin profile set` writes through this alone',
  },
  {
    path: '/api/me/stats',
    method: 'get',
    operationId: 'getMyStats',
    deprecated: false,
    migration: '`tenjin stats` reads through this alone',
  },
];

function assertPostPaths(doc: unknown): void {
  for (const op of PUBLISH_OPS) assertPinnedOp(doc, op);
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
  // searchId is SENT, in two declared shapes: one id bare, several as an array.
  // The pattern is narrower than lib/ids.ts's UUID_RE and the CLI mirrors it, and
  // SEARCH_ID_MAX copies a number the server owns; nothing else would notice
  // either of them moving.
  const searchIdForms = get(top, 'searchId', 'anyOf');
  expect(get(searchIdForms, 0, 'pattern')).toBe(SEARCH_ID_WIRE_RE.source);
  expect(get(searchIdForms, 1, 'type')).toBe('array');
  expect(get(searchIdForms, 1, 'items', 'pattern')).toBe(SEARCH_ID_WIRE_RE.source);
  expect(get(searchIdForms, 1, 'minItems')).toBe(1);
  expect(get(searchIdForms, 1, 'maxItems')).toBe(SEARCH_ID_MAX);

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

function postUpdateProps(doc: unknown): unknown {
  return get(doc, 'components', 'schemas', 'PostUpdate', 'properties');
}
function cardUpdateProps(doc: unknown): unknown {
  return get(postUpdateProps(doc), 'resource', 'properties');
}

/**
 * PostUpdate is the merge-update twin of PostCreate: strict at both levels, every
 * field optional, and carrying the same bounds the CLI validates locally. The one
 * deliberate difference is `handle`, which is create-only.
 */
function assertUpdateContract(doc: unknown): void {
  expect(get(doc, 'components', 'schemas', 'PostUpdate', 'additionalProperties')).toBe(false);
  expect(get(doc, 'components', 'schemas', 'PostUpdate', 'required')).toBeUndefined();
  for (const field of ['title', 'bodyMd', 'excerpt', 'tags', 'price', 'status']) {
    expect(get(postUpdateProps(doc), field), `PostUpdate.${field} missing`).toBeDefined();
  }
  expect(get(postUpdateProps(doc), 'resource', 'additionalProperties')).toBe(false);
  for (const field of CARD_INPUT_FIELDS) {
    expect(get(cardUpdateProps(doc), field), `PostUpdate resource.${field} missing`).toBeDefined();
  }
  const top = postUpdateProps(doc);
  expect(bound(top, 'title', 'maxLength')).toBe(200);
  expect(bound(top, 'bodyMd', 'maxLength')).toBe(200000);
  expect(bound(top, 'excerpt', 'maxLength')).toBe(500);
  expect(bound(top, 'tags', 'maxItems')).toBe(5);
  expect(bound(top, 'tags', 'items', 'maxLength')).toBe(50);
  expect(bound(top, 'price', 'pattern')).toBe('^(0|[1-9]\\d{0,12})$');
  expect(bound(top, 'status', 'enum')).toEqual(['draft', 'published', 'unlisted']);
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
      searchId: SEARCH_ID,
    });
    const declared = postCreateProps(fixtureDoc);
    for (const key of Object.keys(body)) {
      expect(get(declared, key), `fixture does not declare PostCreate field ${key}`).toBeDefined();
    }
  });

  // The emitted body diffed against the DECLARED schema, value by value, rather
  // than against our own types: `searchId` reached the wire only after this
  // pinned it, because a field the CLI simply never sent satisfies every
  // type-level check there is (tenjin-agent #161).
  it('every value buildPostCreateBody emits satisfies the declared PostCreate pattern', () => {
    const body = buildPostCreateBody({
      status: 'published',
      title: 'T',
      bodyMd: 'B',
      priceAtomic: '100000',
      handle: 'iris',
      searchId: SEARCH_ID,
    }) as Record<string, unknown>;
    const declared = postCreateProps(fixtureDoc);
    for (const [key, value] of Object.entries(body)) {
      const pattern = get(nonNull(get(declared, key)), 'pattern');
      if (typeof pattern !== 'string' || typeof value !== 'string') continue;
      expect(new RegExp(pattern).test(value), `${key}=${value} violates ${pattern}`).toBe(true);
    }
  });

  // The attribution field is the whole point of `--search-id`; a body that drops
  // it publishes an answer nothing can tie to the demand that asked for it.
  it('carries searchId when one is named, and omits the key entirely otherwise', () => {
    const withId = buildPostCreateBody({
      status: 'published',
      title: 'T',
      bodyMd: 'B',
      searchId: SEARCH_ID,
    });
    expect(withId.searchId).toBe(SEARCH_ID);
    const without = buildPostCreateBody({ status: 'published', title: 'T', bodyMd: 'B' });
    expect('searchId' in without).toBe(false);
  });

  // Each emitted shape against the branch it lands on: the value loop above
  // skips this field now that its bounds live under `anyOf`.
  it('emits a searchId that satisfies the declared branch it takes', () => {
    const forms = get(postCreateProps(fixtureDoc), 'searchId', 'anyOf');
    const scalar = new RegExp(String(get(forms, 0, 'pattern')));
    const item = new RegExp(String(get(forms, 1, 'items', 'pattern')));
    const many = [SEARCH_ID, '0197aaaa-bbbb-7ccc-8ddd-ffffffffffff'];

    const one = buildPostCreateBody({
      status: 'published',
      title: 'T',
      bodyMd: 'B',
      searchId: [SEARCH_ID],
    }).searchId;
    expect(typeof one).toBe('string');
    expect(scalar.test(String(one))).toBe(true);

    const batch = buildPostCreateBody({
      status: 'published',
      title: 'T',
      bodyMd: 'B',
      searchId: many,
    }).searchId as string[];
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.length).toBeGreaterThanOrEqual(Number(get(forms, 1, 'minItems')));
    expect(batch.length).toBeLessThanOrEqual(Number(get(forms, 1, 'maxItems')));
    for (const id of batch)
      expect(item.test(id), `${id} violates the declared item pattern`).toBe(true);
  });

  // Refused at the builder too, not only at the command edge: PostCreate is a
  // strictObject with a pattern on this field, so an id the server would 400 must
  // never be handed to a signed request.
  it('refuses a searchId the declared pattern rejects', () => {
    for (const bad of ['not-a-uuid', '', '0197aaaa-bbbb-cccc-dddd-00000000000']) {
      expect(() =>
        buildPostCreateBody({ status: 'published', title: 'T', bodyMd: 'B', searchId: bad }),
      ).toThrow(CliError);
    }
  });

  it('the PostUpdate shape the CLI merge-updates through is fully declared', () => {
    assertUpdateContract(fixtureDoc);
  });

  it('every field buildPostUpdateBody emits is a declared PostUpdate field', () => {
    const body = buildPostUpdateBody({
      title: 'T',
      bodyMd: 'B',
      excerpt: 'e',
      tags: ['x'],
      priceAtomic: '100000',
      status: 'published',
      resource: { scope: 's' },
    });
    const declared = postUpdateProps(fixtureDoc);
    for (const key of Object.keys(body)) {
      expect(get(declared, key), `fixture does not declare PostUpdate field ${key}`).toBeDefined();
    }
    // handle is create-only; sending it on an update would trip the strict body.
    expect(get(declared, 'handle')).toBeUndefined();
  });

  it('every clear the CLI sends is a shape PostUpdate accepts', () => {
    const card = cardUpdateProps(fixtureDoc);
    // The nullable scalars: an explicit null is the clear, so each must declare a
    // null branch or `--clear <field>` would be a validation_failed.
    for (const field of [
      'scope',
      'exclusions',
      'asOf',
      'validUntil',
      'provenanceSummary',
      'methodologySummary',
      'supersedesPostId',
    ]) {
      const branches = get(get(card, field), 'anyOf');
      expect(Array.isArray(branches), `resource.${field} must be nullable`).toBe(true);
      expect(
        (branches as unknown[]).some((b) => get(b, 'type') === 'null'),
        `resource.${field} declares no null branch`,
      ).toBe(true);
    }
    // The containers clear with an empty value, so neither may demand a minimum.
    for (const field of ['questionsAnswered', 'tasksSupported']) {
      expect(get(card, field, 'type')).toBe('array');
      expect(get(card, field, 'minItems')).toBeUndefined();
    }
    expect(get(card, 'appliesTo', 'type')).toBe('object');
    expect(get(card, 'appliesTo', 'minProperties')).toBeUndefined();
  });

  it('every field the CLI DEMANDS back is one the fixture guarantees', () => {
    // The request side is pinned above; this is the response side. A key the CLI
    // requires but the server may omit is a CONTRACT_MISMATCH on a good response,
    // so what we demand must be a subset of what the contract guarantees.
    const postRequired = get(fixtureDoc, 'components', 'schemas', 'OwnPost', 'required');
    expect(Array.isArray(postRequired)).toBe(true);
    for (const key of requiredKeys(ownPostSchema)) {
      expect(postRequired, `OwnPost.required must guarantee ${key}`).toContain(key);
    }
    const cardRequired = get(fixtureDoc, 'components', 'schemas', 'ResourceCard', 'required');
    expect(Array.isArray(cardRequired)).toBe(true);
    for (const key of requiredKeys(resourceEchoSchema)) {
      expect(cardRequired, `ResourceCard.required must guarantee ${key}`).toContain(key);
    }
  });

  it('every optional field the CLI READS is a declared response field', () => {
    // Optional keys never fail parsing, so they fail silently instead: a renamed
    // `bodyMd` would quietly make every diff look like a body change.
    const postProps = get(fixtureDoc, 'components', 'schemas', 'OwnPost', 'properties');
    for (const key of Object.keys(ownPostSchema.shape)) {
      expect(get(postProps, key), `OwnPost.properties.${key} missing`).toBeDefined();
    }
    const cardProps = get(fixtureDoc, 'components', 'schemas', 'ResourceCard', 'properties');
    for (const key of Object.keys(resourceEchoSchema.shape)) {
      expect(get(cardProps, key), `ResourceCard.properties.${key} missing`).toBeDefined();
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
/**
 * The account surface (#208). The CLI's zod schemas are hand-written, so each
 * required list and bound is pinned here against the fixture rather than trusted
 * to stay in step by itself.
 */
function accountSchema(doc: unknown, name: string): unknown {
  return get(doc, 'components', 'schemas', name);
}

function assertAccountShapes(doc: unknown): void {
  for (const op of ACCOUNT_OPS) assertPinnedOp(doc, op);

  // Creator: what the CLI DEMANDS is what the fixture guarantees, and what the
  // CLI treats as optional-or-null is NOT in the required list.
  const creatorRequired = get(accountSchema(doc, 'Creator'), 'required') as string[];
  for (const field of ['walletAddress', 'defaultPrice']) {
    expect(creatorRequired, `Creator no longer guarantees ${field}`).toContain(field);
  }
  for (const field of ['handle', 'displayName', 'bio']) {
    expect(creatorRequired, `Creator now requires ${field}; loosen the CLI schema`).not.toContain(
      field,
    );
    expect(get(accountSchema(doc, 'Creator'), 'properties', field, 'type')).toContain('null');
  }
  expect(get(accountSchema(doc, 'MeResponse'), 'required')).toEqual(['address', 'creator']);

  // Stats: all three scalars required, earnings a string (atomic USDC).
  expect(get(accountSchema(doc, 'Stats'), 'required')).toEqual([
    'earningsThisMonth',
    'readsThisMonth',
    'glancesThisMonth',
  ]);
  expect(get(accountSchema(doc, 'Stats'), 'properties', 'earningsThisMonth', 'type')).toBe(
    'string',
  );

  // Profile (the PUT body): every key updateMe can send is declared, the object
  // is closed, and the bounds the CLI enforces at the edge are the server's.
  const profile = accountSchema(doc, 'Profile');
  expect(get(profile, 'additionalProperties')).toBe(false);
  for (const field of ['handle', 'displayName', 'bio']) {
    expect(get(profile, 'properties', field), `Profile.${field} missing`).toBeDefined();
  }
  expect(get(profile, 'required'), 'Profile fields must all be optional for merge').toBeUndefined();
  expect(get(profile, 'properties', 'handle', 'pattern')).toBe(PROFILE_HANDLE_RE.source);
  expect(get(profile, 'properties', 'displayName', 'maxLength')).toBe(PROFILE_DISPLAY_NAME_MAX);
  expect(get(profile, 'properties', 'bio', 'maxLength')).toBe(PROFILE_BIO_MAX);
}

describe('contract fixture pins the account endpoints', () => {
  it('declares GET/PUT /api/me and GET /api/me/stats with the shapes the CLI relies on', () => {
    assertAccountShapes(fixtureDoc);
  });

  it('a Creator that omits handle/displayName/bio parses (they are not required)', () => {
    const parsed = creatorProfileSchema.safeParse({
      id: 'x',
      walletAddress: '0xabc',
      defaultPrice: '0',
    });
    expect(parsed.success).toBe(true);
  });

  it('a Creator without defaultPrice is a contract mismatch, since the fixture requires it', () => {
    expect(creatorProfileSchema.safeParse({ id: 'x', walletAddress: '0xabc' }).success).toBe(false);
  });
});

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

    it('declares the search and outcomes operations', () => {
      assertAgentPaths(liveDoc);
    });

    it('SearchResult and SearchCandidate declare every CLI-required field', () => {
      assertSchemaDeclares(liveDoc, 'SearchResult', RESULT_REQUIRED);
      assertSchemaDeclares(liveDoc, 'SearchCandidate', CANDIDATE_REQUIRED);
    });

    it('SearchRequestV3 matches what the CLI sends', () => {
      assertSearchRequest(liveDoc);
    });

    it('SearchOutcomeSubmit status enum matches the CLI', () => {
      assertOutcomeStatusEnum(liveDoc);
    });

    it('declares the publish endpoints and the resource-card shape the CLI sends', () => {
      assertPostPaths(liveDoc);
      assertPublishContract(liveDoc);
      assertUpdateContract(liveDoc);
    });

    it('declares the account endpoints and shapes', () => {
      assertAccountShapes(liveDoc);
    });

    it('the 402 preview declares the optional answer card', () => {
      assertReadCard(liveDoc);
    });
  },
);
