import { describe, it, expect, beforeAll } from 'vitest';
import type { z } from 'zod';
import fixtureJson from './fixtures/openapi.fixture.json';
import { LookupCandidateSchema, LookupResponseSchema } from './lib/api';
import { OUTCOME_STATUSES } from './commands/outcome';

// Pins the CLI's wire schemas against the committed server contract fixture
// (generated from tenjin main af607b3, the A2 merge). Every assertion here is a
// pure walk of the OpenAPI document, so a server-side rename or removal that
// would break the CLI fails THIS suite before it fails in production. The
// env-gated section at the bottom re-runs the same walks against a live
// deployment and is the only test allowed to touch the network.

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
const RESPONSE_REQUIRED = ['calibration', 'decision', 'lookupId', 'schemaVersion'];
const CANDIDATE_REQUIRED = [
  'appliesTo',
  'artifactType',
  'asOf',
  'creator',
  'estimatedTokens',
  'exclusions',
  'matchReasons',
  'price',
  'questionsAnswered',
  'resourceId',
  'scope',
  'tasksSupported',
  'temporalMode',
  'title',
  'url',
  'validUntil',
];

function assertAgentPaths(doc: unknown): void {
  expect(get(doc, 'paths', '/api/agent/lookup', 'post', 'operationId')).toBe('agentLookup');
  expect(get(doc, 'paths', '/api/agent/lookups/{id}/outcomes', 'post', 'operationId')).toBe(
    'agentLookupOutcomes',
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

function assertLookupRequest(doc: unknown): void {
  const properties = get(doc, 'components', 'schemas', 'LookupRequest', 'properties');
  for (const field of [
    'schemaVersion',
    'question',
    'freshWithin',
    'maxPrice',
    'appliesTo',
    'limit',
  ]) {
    expect(get(properties, field), `LookupRequest.properties.${field} missing`).toBeDefined();
  }
  expect(get(properties, 'question', 'maxLength')).toBe(512);
}

function assertOutcomeStatusEnum(doc: unknown): void {
  // LookupOutcomeSubmit is an anyOf of a single report object and a batch array
  // of the same object; the status enum must be identical wherever it appears.
  const schema = get(doc, 'components', 'schemas', 'LookupOutcomeSubmit');
  expect(schema, 'components.schemas.LookupOutcomeSubmit missing').toBeDefined();
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
    expect(found).toEqual([...OUTCOME_STATUSES]);
  }
}

describe('contract fixture pins the agent endpoints', () => {
  it('declares POST /api/agent/lookup and /api/agent/lookups/{id}/outcomes', () => {
    assertAgentPaths(fixtureDoc);
  });
});

describe('contract fixture covers every field the CLI requires', () => {
  it('the CLI requires exactly the pinned LookupResponse fields', () => {
    expect(requiredKeys(LookupResponseSchema)).toEqual(RESPONSE_REQUIRED);
  });

  it('the CLI requires exactly the pinned LookupCandidate fields', () => {
    expect(requiredKeys(LookupCandidateSchema)).toEqual(CANDIDATE_REQUIRED);
  });

  it.each(RESPONSE_REQUIRED)('LookupResponse declares required field %s', (field) => {
    assertSchemaDeclares(fixtureDoc, 'LookupResponse', [field]);
  });

  it.each(CANDIDATE_REQUIRED)('LookupCandidate declares required field %s', (field) => {
    assertSchemaDeclares(fixtureDoc, 'LookupCandidate', [field]);
  });
});

describe('contract fixture request shapes', () => {
  it('LookupRequest carries the fields the CLI sends, question capped at 512', () => {
    assertLookupRequest(fixtureDoc);
  });

  it('LookupOutcomeSubmit status enum is exactly the five CLI statuses', () => {
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
    title: 'Base fee snapshot, July 2026',
    artifactType: 'document',
    price: '500000',
    asOf: '2026-07-01T00:00:00.000Z',
    validUntil: null,
    temporalMode: 'snapshot',
    appliesTo: { products: ['Base'] },
    questionsAnswered: ['What do Base transactions cost right now?'],
    tasksSupported: ['estimate gas spend'],
    scope: 'L2 execution fees only',
    exclusions: null,
    matchReasons: ['answer-card: base fees'],
    estimatedTokens: 1200,
    creator: { handle: 'alice' },
  };
  const response = {
    schemaVersion: 1,
    lookupId: '0f8b2d4c-6a1e-4b3f-8c5d-7e9f1a2b3c4d',
    decision: 'CANDIDATES',
    calibration: 'lexical-v1',
    candidates: [candidate],
  };

  it('the hand-built candidate only uses fields the fixture declares', () => {
    const declared = get(fixtureDoc, 'components', 'schemas', 'LookupCandidate', 'properties');
    for (const key of Object.keys(candidate)) {
      expect(get(declared, key), `fixture does not declare candidate field ${key}`).toBeDefined();
    }
  });

  it('LookupResponseSchema.parse accepts a CANDIDATES response', () => {
    const parsed = LookupResponseSchema.parse(response);
    expect(parsed.decision).toBe('CANDIDATES');
    expect(parsed.candidates).toHaveLength(1);
  });

  it('LookupResponseSchema.parse accepts a MISS with candidates omitted', () => {
    const miss = {
      schemaVersion: 1,
      lookupId: response.lookupId,
      decision: 'MISS',
      calibration: 'lexical-v1',
    };
    expect(LookupResponseSchema.parse(miss).candidates).toBeUndefined();
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

    it('declares the agent lookup and outcomes operations', () => {
      assertAgentPaths(liveDoc);
    });

    it('LookupResponse and LookupCandidate declare every CLI-required field', () => {
      assertSchemaDeclares(liveDoc, 'LookupResponse', RESPONSE_REQUIRED);
      assertSchemaDeclares(liveDoc, 'LookupCandidate', CANDIDATE_REQUIRED);
    });

    it('LookupRequest matches what the CLI sends', () => {
      assertLookupRequest(liveDoc);
    });

    it('LookupOutcomeSubmit status enum matches the CLI', () => {
      assertOutcomeStatusEnum(liveDoc);
    });
  },
);
