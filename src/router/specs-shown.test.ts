import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OfferSpec } from './decision';
import { shownInputField, storeSpecs } from './specs';

/** A catalog spec with the fields the rule reads, the rest filled in. */
function spec(over: Partial<OfferSpec>): OfferSpec {
  return {
    id: 'offer-1',
    capabilityId: 'cap',
    provider: 'Provider',
    description: 'a service',
    priceAtomic: '7000',
    priceVaries: false,
    maxAmountAtomic: '7000',
    payTo: '0xC751344Ee09B5159160173F77D4a1169bCd386A1',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    request: { method: 'POST', url: 'https://p.test/x', fields: {}, location: 'body' },
    input: { type: 'object', properties: {} },
    pinned: {},
    ...over,
  };
}

describe('the one input a row may show', () => {
  it('names no field for a media service, the held field for a lookup, else the first required string', () => {
    expect(shownInputField(spec({ output: 'media', holds: { WebSearch: 'q' } }))).toBeNull();
    expect(shownInputField(spec({ holds: { WebSearch: 'q' } }))).toBe('q');
    expect(
      shownInputField(
        spec({
          output: 'json',
          input: {
            type: 'object',
            properties: { limit: { type: 'number' }, company: { type: 'string' } },
            required: ['company'],
          },
        }),
      ),
    ).toBe('company');
  });
});

describe('the record the mod reads', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'router-shown-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps the field in each spec file, null for a media service', async () => {
    await storeSpecs(dir, [
      spec({ id: 'search', holds: { WebSearch: 'query' }, output: 'json' }),
      spec({ id: 'image', output: 'media' }),
    ]);
    const read = async (id: string) =>
      JSON.parse(
        await readFile(
          join(dir, 'progress', 'specs', `${createHash('sha256').update(id).digest('hex')}.json`),
          'utf8',
        ),
      ) as { shown?: unknown };
    expect((await read('search')).shown).toBe('query');
    expect((await read('image')).shown).toBeNull();
  });
});
