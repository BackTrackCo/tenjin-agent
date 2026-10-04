import { mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
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

  it("spells out a nested object's required fields, to a bound", () => {
    // clearcut's schema as the Tenjin list ships it: a required object whose
    // own fields are required, and an array of objects beside it.
    const clearcut = spec({
      provider: 'clearcut (Background removal)',
      input: {
        properties: {
          imageUrl: { type: 'string', format: 'uri', description: 'Public HTTP(S) URL.' },
          agent_context: {
            type: 'object',
            description: 'information about the calling agent.',
            required: ['agent_type', 'search_query'],
            properties: {
              agent_type: { type: 'string', maxLength: 80, description: "Your agent's name." },
              search_query: { type: 'string', enum: ['direct'], description: 'How you found it.' },
              note: { type: 'string', description: 'Optional, so only named.' },
            },
          },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: { filename: { type: 'string' }, content: { type: 'string' } },
              required: ['filename'],
            },
          },
        },
        required: ['imageUrl', 'agent_context'],
      },
      pinned: {},
    });
    const text = specText(ID, clearcut);
    expect(text).toContain(
      [
        '- agent_context (object {agent_type, search_query, note}, required); information about the calling agent.',
        "  - agent_context.agent_type (string, required); Your agent's name.; max length 80",
        '  - agent_context.search_query (string, required); How you found it.; one of "direct"',
        '- attachments (array of object {filename, content})',
        '  - attachments[].filename (string, required)',
      ].join('\n'),
    );
    expect(text).not.toContain('agent_context.note');

    // A schema that nests and widens without end adds at most three levels
    // and twenty lines, then says there is more.
    const level = (depth: number): Record<string, unknown> => {
      const names = ['a', 'b', 'c', 'd', 'e', 'f'];
      return {
        type: 'object',
        required: names,
        properties: Object.fromEntries(
          names.map((name) => [name, depth ? level(depth - 1) : { type: 'string' }]),
        ),
      };
    };
    const deep = specText(
      ID,
      spec({ input: { properties: { root: level(5) }, required: ['root'] }, pinned: {} }),
    );
    const nested = deep.split('\n').filter((line) => line.startsWith('  '));
    expect(nested).toHaveLength(21);
    expect(nested.at(-1)).toMatch(/^ {2,}- … more required fields, not listed here$/);
    expect(deep).toContain('      - root.a.a.a (object');
    expect(deep).not.toContain('root.a.a.a.a');
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

  it('refuses a field the spec does not name even where the schema allows extras, but never a pin', () => {
    const open = spec({ pinned: { model: 'openai/gpt-image-2', quality: 'high' } });
    delete open.input.additionalProperties;
    const merged = mergedInput(open, { prompt: 'a fox', style: 'vivid' });
    expect(specInputProblems(open, merged)).toEqual(['the input has no field "style"']);
    expect(specInputProblems(open, mergedInput(open, { prompt: 'a fox' }))).toEqual([]);
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

  it('checks a schema carrying a keyword Ajv does not know, as two shipped specs do', () => {
    // Both schemas as the Tenjin list ships them: OpenAPI's `example` on
    // Ideogram's model, a vendor `x-in` on the SEC ticker.
    const ideogram = spec({
      provider: 'AiSpace (Venice)',
      request: {
        method: 'POST',
        url: 'https://x402.aispace.bot/api/v1/image/generate',
        fields: { model: 'body', prompt: 'body', style_preset: 'body' },
        location: 'body',
      },
      input: {
        type: 'object',
        properties: {
          model: {
            type: 'string',
            example: 'venice-sd35',
            description: 'Venice image model id.',
            enum: ['ideogram-v4'],
            default: 'ideogram-v4',
          },
          prompt: { type: 'string', description: 'Image description. Up to ~2000 chars.' },
          style_preset: { type: 'string', description: 'Optional named style.' },
        },
        required: ['model', 'prompt'],
      },
      pinned: { model: 'ideogram-v4' },
    });
    expect(specInputProblems(ideogram, mergedInput(ideogram, { prompt: 7 }))).toEqual([
      'prompt must be string',
    ]);
    expect(specInputProblems(ideogram, mergedInput(ideogram, { prompt: 'A poster' }))).toEqual([]);
    const sec = spec({
      provider: 'x402atlas',
      request: {
        method: 'GET',
        url: 'https://sec.use.x402atlas.com/financials/{ticker}',
        fields: { ticker: 'path' },
        location: 'query',
      },
      input: {
        type: 'object',
        properties: {
          ticker: {
            type: 'string',
            'x-in': 'path',
            description: 'US ticker, substituted into the URL path',
          },
        },
        required: ['ticker'],
      },
      pinned: {},
    });
    expect(specInputProblems(sec, {})).toEqual(['ticker is required']);
    expect(specInputProblems(sec, { ticker: 7 })).toEqual(['ticker must be string']);
    expect(specInputProblems(sec, { ticker: 'AAPL' })).toEqual([]);
  });

  it('says nothing fits when the schema cannot be compiled at all', () => {
    const broken = spec({
      input: { type: 'object', properties: { prompt: { type: 'text' } }, required: ['prompt'] },
      pinned: {},
    });
    expect(specInputProblems(broken, { prompt: 'a fox' })).toBeUndefined();
  });

  it('checks a field named pattern, which is not a regular expression', () => {
    const named = spec({
      input: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
      pinned: {},
    });
    expect(specInputProblems(named, { pattern: 7 })).toEqual(['pattern must be string']);
    expect(specInputProblems(named, { pattern: 'stripes' })).toEqual([]);
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

  // The mod reads the file itself, for the row's label: the field must land on disk.
  it("keeps a spec's label in the file, and reads it back", async () => {
    await storeSpecs(dir, [spec({ label: 'GPT Image 2' })]);
    const [name] = await readdir(join(dir, 'progress', 'specs'));
    const saved = JSON.parse(await readFile(join(dir, 'progress', 'specs', name!), 'utf8'));
    expect(saved.label).toBe('GPT Image 2');
    expect((await readSpec(dir, ID))?.label).toBe('GPT Image 2');
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
