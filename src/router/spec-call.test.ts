import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSpecRequest, specInputProblems, specText, mergedInput } from './spec-call';
import { readSpec, storeSpecs } from './specs';
import type { OfferSpec, ToolSpec } from './decision';

const ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d01';

/** An image service with a pinned model, an enum, a bounded integer and a
 *  `pattern` the compiler refuses: the shapes a spec has to read and check. */
function spec(over: Partial<ToolSpec> = {}): OfferSpec {
  return {
    id: ID,
    capabilityId: 'discovered:tenjin:0a1b2c3d',
    provider: 'BlockRun (OpenAI GPT Image 2)',
    description: 'Best all-round image quality with precise prompt following.',
    priceAtomic: '64000',
    priceVaries: true,
    maxAmountAtomic: '1000000',
    payTo: '0x1111111111111111111111111111111111111111',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    request: {
      method: 'POST',
      url: 'https://blockrun.ai/api/v1/images/generations',
      fields: { model: 'body', prompt: 'body', size: 'body', n: 'body', seed: 'body' },
      location: 'body',
    },
    input: {
      type: 'object',
      required: ['prompt'],
      properties: {
        model: { type: 'string', enum: ['openai/gpt-image-2'] },
        prompt: { type: 'string', description: 'Text description of the image to generate' },
        size: { type: 'string', enum: ['1024x1024', '1536x1024'], description: 'Image size' },
        n: { type: 'integer', minimum: 1, maximum: 4 },
        seed: { type: 'string', pattern: '^[0-9]+$' },
      },
      additionalProperties: false,
    },
    pinned: { model: 'openai/gpt-image-2' },
    example: { prompt: 'a paper plane over a city', size: '1024x1024' },
    returns: 'JSON {data:[{url}]}: a hosted PNG URL per image',
    ...over,
  };
}

describe('a request spec as the agent reads it', () => {
  it('names each input with its type, description and allowed values, and what is pinned', () => {
    const text = specText(ID, spec());
    expect(text).toContain('BlockRun (OpenAI GPT Image 2): Best all-round image quality');
    expect(text).toContain('prompt (string, required); Text description of the image');
    expect(text).toContain('size (string); Image size; one of "1024x1024", "1536x1024"');
    expect(text).toContain('n (integer); min 1; max 4');
    // Required first, and a pinned field is not an input to fill.
    expect(text.indexOf('- prompt')).toBeLessThan(text.indexOf('- size'));
    expect(text).not.toContain('- model');
    expect(text).toContain(
      'Set by Tenjin on every call (leave these out): model = "openai/gpt-image-2"',
    );
    expect(text).toContain(
      'Example input: {"prompt":"a paper plane over a city","size":"1024x1024"}',
    );
    expect(text).toContain('Returns: JSON {data:[{url}]}: a hosted PNG URL per image');
    expect(text).toContain('the price varies with the input (up to $1)');
    expect(text).toContain(`request({id: "${ID}", input: {...}})`);
  });

  it('lets a pin win over the agent, and reports every problem at once', () => {
    const merged = mergedInput(spec(), { model: 'flux', size: 'huge', n: 9, extra: true });
    expect(merged.model).toBe('openai/gpt-image-2');
    const problems = specInputProblems(spec(), merged);
    expect(problems).toEqual(
      expect.arrayContaining([
        'prompt is required',
        'size must be one of "1024x1024", "1536x1024"',
        'n must be <= 4',
        'the input has no field "extra"',
      ]),
    );
  });

  it("refuses an input that misses the spec's whole-input guard before anything is sent", () => {
    // Apollo's spec: one of these field sets, or the call buys a billed miss.
    const apollo = spec({
      request: {
        method: 'POST',
        url: 'https://x402.orthogonal.com/apollo/api/v1/people/match',
        fields: {},
        location: 'body',
      },
      input: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          first_name: { type: 'string' },
          last_name: { type: 'string' },
          domain: { type: 'string' },
        },
        required: [],
        additionalProperties: false,
        anyOf: [{ required: ['email'] }, { required: ['first_name', 'last_name', 'domain'] }],
        minProperties: 1,
      },
      pinned: {},
    });
    expect(specInputProblems(apollo, { first_name: 'Patrick', last_name: 'Collison' })).not.toEqual(
      [],
    );
    expect(specInputProblems(apollo, {})).not.toEqual([]);
    expect(
      specInputProblems(apollo, {
        first_name: 'Patrick',
        last_name: 'Collison',
        domain: 'stripe.com',
      }),
    ).toEqual([]);
  });

  it('still checks the rest of a schema that carries a regular expression', () => {
    // The pattern itself is left to the provider; the type beside it is not.
    expect(specInputProblems(spec(), mergedInput(spec(), { prompt: 'x', seed: 'abc' }))).toEqual(
      [],
    );
    expect(specInputProblems(spec(), mergedInput(spec(), { prompt: 'x', seed: 7 }))).toEqual([
      'seed must be string',
    ]);
  });
});

describe("a spec's request, filled from the input", () => {
  it('posts the body fields as JSON, pins included', () => {
    const built = buildSpecRequest(spec(), mergedInput(spec(), { prompt: 'a plane' }));
    expect(built).toEqual({
      url: 'https://blockrun.ai/api/v1/images/generations',
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a plane', model: 'openai/gpt-image-2' }),
    });
  });

  it('puts a path field in its segment, encoded, and the rest in the query', () => {
    const get = spec({
      request: {
        method: 'GET',
        url: 'https://glim.sh/api/v1/twitter/users/{ref}/tweets',
        fields: { ref: 'path', limit: 'query' },
        location: 'query',
      },
      pinned: {},
    });
    expect(buildSpecRequest(get, { ref: 'jack/../x', limit: 5 })).toMatchObject({
      url: 'https://glim.sh/api/v1/twitter/users/jack%2F..%2Fx/tweets?limit=5',
      method: 'GET',
    });
    const segment =
      'ref goes in the URL path, so each must be a non-empty string or number other than "." or ".."';
    expect(buildSpecRequest(get, { limit: 5 })).toEqual({ problem: segment });
    // `encodeURIComponent` leaves these as they are: `..` would call
    // /twitter/tweets on the same origin.
    for (const ref of ['.', '..', ''])
      expect(buildSpecRequest(get, { ref, limit: 5 })).toEqual({ problem: segment });
    expect(buildSpecRequest(get, { ref: 'jack', tags: ['a'] })).toEqual({
      problem: 'tags goes in the query string, so each must be a string, number or boolean',
    });
  });
});

describe('the specs a hook keeps', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'router-specs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a spec back by its id, and nothing for another id', async () => {
    await storeSpecs(dir, [spec()]);
    expect(await readSpec(dir, ID)).toEqual(spec());
    expect(await readSpec(dir, '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d99')).toBeNull();
  });

  it('forgets a spec once the server has expired its offer, and prunes it on the next write', async () => {
    await storeSpecs(dir, [spec()]);
    const [name] = await readdir(join(dir, 'progress', 'specs'));
    const path = join(dir, 'progress', 'specs', name!);
    // The server keeps an offer's id 15 minutes, and so does its spec.
    const recent = new Date(Date.now() - 14 * 60_000);
    await utimes(path, recent, recent);
    expect(await readSpec(dir, ID)).toEqual(spec());
    const old = new Date(Date.now() - 16 * 60_000);
    await utimes(path, old, old);
    expect(await readSpec(dir, ID)).toBeNull();
    const other = { ...spec(), id: '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d02' };
    await storeSpecs(dir, [other]);
    expect(await readdir(join(dir, 'progress', 'specs'))).toHaveLength(1);
  });
});
