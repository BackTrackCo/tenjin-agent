import { expect, it } from 'vitest';
import type { CommandContext } from '../context';
import {
  lookupNeonTerms,
  NEON_ROW_ID,
  neonRowId,
  NeonLookupFailed,
  tokenCostAtomic,
} from './neon-terms';

const ctx = {
  flags: { json: true, timeout: 5_000 } as CommandContext['flags'],
  dataDir: '/nowhere',
  io: { stdout: process.stdout, stderr: process.stderr, isTTY: false },
} as CommandContext;

const INFERENCE = {
  model: 'test/model',
  wire: 'chat',
  scheme: 'batch-settlement',
  usage: 'nanogpt',
  price: {
    inputAtomicPerMillion: '3150000',
    outputAtomicPerMillion: '15750000',
    cacheReadAtomicPerMillion: '157500',
  },
};

/** The router's answer to a `{tool}` lookup of a row, as a stub. */
const answer = (rowId: string, overrides: Record<string, unknown> = {}, inference = INFERENCE) => ({
  schemaVersion: 1,
  routerVersion: 'test',
  decision: {
    action: 'spec',
    id: 'fresh-id',
    hint: 'Run request({id: "fresh-id", input: {}}) once.',
    spec: {
      capabilityId: rowId,
      provider: 'Test Seller',
      label: 'Test Writer',
      description: 'A model row',
      priceAtomic: '0',
      priceVaries: true,
      maxAmountAtomic: '500000',
      payTo: '0x00000000000000000000000000000000000000aa',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      request: { method: 'POST', url: 'https://seller.example/chat', fields: {}, location: 'body' },
      input: {},
      pinned: {},
      requires: ['inference'],
      inference,
      ...overrides,
    },
  },
});

function router(body: unknown, seen: { body?: Record<string, unknown> } = {}, status = 200) {
  return async (_input: string | URL | Request, init?: RequestInit) => {
    seen.body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

it('reads the seller, payee, model, wire, scheme, usage dialect and price rule from the row, asking with the inference token', async () => {
  const seen: { body?: Record<string, unknown> } = {};
  const terms = await lookupNeonTerms(
    { ctx, baseUrl: 'https://router.example', fetchImpl: router(answer('row-1'), seen) as never },
    'row-1',
  );
  expect(terms).toEqual({
    rowId: 'row-1',
    label: 'Test Writer',
    url: 'https://seller.example/chat',
    payTo: '0x00000000000000000000000000000000000000aa',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    model: 'test/model',
    wire: 'chat',
    scheme: 'batch-settlement',
    usage: 'nanogpt',
    inputAtomicPerMillion: '3150000',
    outputAtomicPerMillion: '15750000',
    cacheReadAtomicPerMillion: '157500',
  });
  // The lookup is the free `{tool}` form, and only it asks for the inference token.
  expect(seen.body).toMatchObject({ tool: 'row-1' });
  expect(seen.body!.accepts).toContain('inference');
});

// Failure caught: a failed lookup must fail the job with nothing sent, never fall back to a
// seller this build knows.
it.each([
  ['an unreachable router', async () => Promise.reject(new TypeError('fetch failed'))],
  ['a router error', router({ error: 'down' }, {}, 503)],
  [
    'a router that names no such row',
    router({
      schemaVersion: 1,
      routerVersion: 'x',
      decision: { action: 'native', reason: 'No such tool.', diagnostics: {} },
    }),
  ],
  ['a row that answers for another id', router(answer('another-row'))],
  [
    'a row with no inference terms',
    router({
      ...answer('row-1'),
      decision: {
        ...answer('row-1').decision,
        spec: { ...answer('row-1').decision.spec, inference: undefined },
      },
    }),
  ],
  [
    'a wire shape this build has no adapter for',
    router(answer('row-1', {}, { ...INFERENCE, wire: 'messages' })),
  ],
  [
    'a payment scheme this build has no adapter for',
    router(answer('row-1', {}, { ...INFERENCE, scheme: 'exact' })),
  ],
  [
    'a seller URL that is not https',
    router(
      answer('row-1', {
        request: {
          method: 'POST',
          url: 'http://seller.example/chat',
          fields: {},
          location: 'body',
        },
      }),
    ),
  ],
])('fails the lookup, with no fallback seller, on %s', async (_name, fetchImpl) => {
  await expect(
    lookupNeonTerms(
      { ctx, baseUrl: 'https://router.example', fetchImpl: fetchImpl as never },
      'row-1',
    ),
  ).rejects.toBeInstanceOf(NeonLookupFailed);
});

it('names a row by id, with a test-only override and no other source', () => {
  expect(neonRowId({})).toBe(NEON_ROW_ID);
  expect(neonRowId({ TENJIN_NEON_MODEL: 'other-row' })).toBe('other-row');
  expect(neonRowId({ TENJIN_NEON_MODEL: 'not a row id!' })).toBe(NEON_ROW_ID);
});

it('prices tokens by the rule per million, rounded up', () => {
  expect(tokenCostAtomic(16_000, '15750000')).toBe(252_000n);
  expect(tokenCostAtomic(1, '157500')).toBe(1n);
  expect(tokenCostAtomic(0, '15750000')).toBe(0n);
});
