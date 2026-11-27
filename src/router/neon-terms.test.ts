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

/**
 * The router's answer to a `{tool}` lookup of the Neon row, whole, as the server builds it: the
 * spec `capabilitySpec` returns for the row, the fixed hint of an inference row (no call to make,
 * no id in it), and `jev` as the object the route sends for a free lookup. The spec and the hint
 * are the server's own code (`INFERENCE_HINT` in its route); a test must not shape them to fit
 * this parser.
 */
const SERVER_ANSWER = {
  schemaVersion: 1,
  routerVersion: 'server',
  decision: {
    action: 'spec',
    id: '6f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a11',
    spec: {
      capabilityId: 'x402inference-gemini-4-neon',
      provider: 'x402inference (NanoGPT) (Google Gemini 4 Neon)',
      label: 'Gemini 4 Neon',
      holds: {},
      output: 'json',
      description:
        "Google's Gemini 4 Neon by chat completions, for a Tenjin door that runs a subagent on it. It settles in batches on Base: the call is charged what it used, list price plus x402inference's 5%.",
      priceAtomic: '1000',
      priceVaries: true,
      maxAmountAtomic: '277200',
      payTo: '0x6Be3A763E0FAddAa2f2FCBbaFf60f1A91d49227A',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      request: {
        method: 'POST',
        url: 'https://x402inference.com/accountless/chat/completions',
        fields: { model: 'body', messages: 'body', max_tokens: 'body' },
        location: 'body',
      },
      input: {
        $comment:
          "Only the daily catalog check reads this input and the spec's maxAmountAtomic, to probe the seller. A door calls with more (tools, tool messages, a longer input) and quotes from inference.price and the live 402, so a real call can quote above maxAmountAtomic.",
        type: 'object',
        properties: {
          model: {
            type: 'string',
            enum: ['google/gemini-4-neon'],
            default: 'google/gemini-4-neon',
          },
          messages: { type: 'array', minItems: 1 },
          max_tokens: { type: 'integer', minimum: 1, maximum: 16000 },
        },
        required: ['model', 'messages'],
        additionalProperties: false,
      },
      pinned: { model: 'google/gemini-4-neon' },
      example: { messages: [{ role: 'user', content: 'Say hello.' }], max_tokens: 16 },
      returns: 'an OpenAI chat completion with the reply, the reasoning and the usage',
      inference: {
        model: 'google/gemini-4-neon',
        wire: 'chat',
        scheme: 'batch-settlement',
        usage: 'nanogpt',
        price: {
          inputAtomicPerMillion: '3150000',
          outputAtomicPerMillion: '15750000',
          cacheReadAtomicPerMillion: '157500',
        },
      },
      requires: ['inference'],
    },
    hint: 'This is an inference provider. Only a Tenjin door runs it; a request call does not.',
  },
  jev: { calls: 0, latencyMs: 0 },
};
const ROW = SERVER_ANSWER.decision.spec.capabilityId;

/** The server's answer for `rowId`, with the spec changed by `over`. */
const answer = (
  rowId: string = ROW,
  over: Record<string, unknown> = {},
  inference: Record<string, unknown> = SERVER_ANSWER.decision.spec.inference,
) => ({
  ...SERVER_ANSWER,
  decision: {
    ...SERVER_ANSWER.decision,
    spec: { ...SERVER_ANSWER.decision.spec, capabilityId: rowId, ...over, inference },
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
    { ctx, baseUrl: 'https://router.example', fetchImpl: router(answer(), seen) as never },
    ROW,
  );
  expect(terms).toEqual({
    rowId: ROW,
    label: 'Gemini 4 Neon',
    url: 'https://x402inference.com/accountless/chat/completions',
    payTo: '0x6Be3A763E0FAddAa2f2FCBbaFf60f1A91d49227A',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    model: 'google/gemini-4-neon',
    wire: 'chat',
    scheme: 'batch-settlement',
    usage: 'nanogpt',
    inputAtomicPerMillion: '3150000',
    outputAtomicPerMillion: '15750000',
    cacheReadAtomicPerMillion: '157500',
  });
  // The lookup is the free `{tool}` form, and only it asks for the inference token.
  expect(seen.body).toMatchObject({ tool: ROW });
  expect(seen.body!.accepts).toContain('inference');
});

// Failure caught: the first live run of the door refused with "did not give the provider row"
// although the lookup was answered. The decision was thrown away whole because its hint, the
// server's fixed line for an inference row, names no call and carries no id, as the hint of a
// runnable service must. The parse now takes the server's own answer as it is.
it("reads the server's whole answer for the Neon row, hint, jev and the input's comment included", async () => {
  const terms = await lookupNeonTerms({
    ctx,
    baseUrl: 'https://router.example',
    fetchImpl: router(SERVER_ANSWER) as never,
  });
  expect(terms).toMatchObject({
    rowId: ROW,
    model: 'google/gemini-4-neon',
    scheme: 'batch-settlement',
  });
  expect(ROW).toBe(NEON_ROW_ID);
  expect(SERVER_ANSWER.decision.spec.input).toHaveProperty('$comment');
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
      ...answer(),
      decision: {
        ...answer().decision,
        spec: { ...answer().decision.spec, inference: undefined },
      },
    }),
  ],
  [
    'a wire shape this build has no adapter for',
    router(answer(ROW, {}, { ...SERVER_ANSWER.decision.spec.inference, wire: 'messages' })),
  ],
  [
    'a payment scheme this build has no adapter for',
    router(answer(ROW, {}, { ...SERVER_ANSWER.decision.spec.inference, scheme: 'exact' })),
  ],
  [
    'a seller URL that is not https',
    router(
      answer(ROW, {
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
    lookupNeonTerms({ ctx, baseUrl: 'https://router.example', fetchImpl: fetchImpl as never }, ROW),
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
