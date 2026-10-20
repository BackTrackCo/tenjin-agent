import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { heldRowPath, markHeld, markRouted, readHeld } from './held';
import { EXPIRY_MS } from './progress';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-held-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const OFFER = 'b920ff14-5aed-4a50-8c25-240e871602f3';
const TERMS = { offerId: OFFER, label: 'Exa search', priceAtomic: '7000' };
const outcome = async (toolUseId: string) => (await readHeld(heldRowPath(dir, toolUseId)))?.outcome;

describe('a native call held for Tenjin', () => {
  it('reads held until the request tool runs its offer id, then routed', async () => {
    await markHeld(dir, 'toolu_a', TERMS, 1_000);
    await markHeld(dir, 'toolu_b', TERMS, 1_000);
    await markHeld(dir, 'toolu_other', { ...TERMS, offerId: 'another-offer' }, 1_000);
    expect(await outcome('toolu_a')).toBe('held');
    await markRouted(dir, OFFER, 2_000);
    expect(await outcome('toolu_a')).toBe('routed');
    expect(await outcome('toolu_b')).toBe('routed');
    // Another offer's hold is not this request's.
    expect(await outcome('toolu_other')).toBe('held');
  });

  it('stays held when the request comes after the turn it was made in', async () => {
    await markHeld(dir, 'toolu_old', TERMS, 1_000);
    await markRouted(dir, OFFER, 1_000 + EXPIRY_MS + 1);
    expect(await outcome('toolu_old')).toBe('held');
  });

  it('keeps only user text: the label and price, never the search or the reason', async () => {
    await markHeld(dir, 'toolu_a', { ...TERMS, label: 'Exa\u0007 search' }, 1_000);
    const raw = await readFile(
      join(dir, 'progress', 'held', `${createHash('sha256').update('toolu_a').digest('hex')}.json`),
      'utf8',
    );
    expect(JSON.parse(raw)).toEqual({
      version: 1,
      at: 1_000,
      outcome: 'held',
      label: 'Exa search',
      priceAtomic: '7000',
      offerId: OFFER,
    });
  });
});
