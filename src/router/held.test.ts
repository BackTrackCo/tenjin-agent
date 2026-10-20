import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { heldRowPath, markHeld, markNative, markRouted, readHeld } from './held';
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
    await markRouted(dir, OFFER, 2_000, 'toolu_request');
    expect(await outcome('toolu_a')).toBe('routed');
    // The first call that ran the offer is the one named; a later one is not.
    await markRouted(dir, OFFER, 3_000, 'toolu_later');
    expect((await readHeld(heldRowPath(dir, 'toolu_a')))?.routedToolUseId).toBe('toolu_request');
    expect(await outcome('toolu_b')).toBe('routed');
    // Another offer's hold is not this request's.
    expect(await outcome('toolu_other')).toBe('held');
  });

  it('stays held when the request comes after the turn it was made in', async () => {
    await markHeld(dir, 'toolu_old', TERMS, 1_000);
    await markRouted(dir, OFFER, 1_000 + EXPIRY_MS + 1);
    expect(await outcome('toolu_old')).toBe('held');
  });

  it('reads native when the same search runs natively, and only then', async () => {
    const search = 'WebSearch rust async runtimes';
    await markHeld(dir, 'toolu_a', { ...TERMS, target: search }, 1_000);
    await markNative(dir, 'WebSearch something else', 'toolu_x', 2_000);
    expect(await outcome('toolu_a')).toBe('held');
    await markNative(dir, search, 'toolu_retry', 2_000);
    expect(await readHeld(heldRowPath(dir, 'toolu_a'))).toMatchObject({
      outcome: 'native',
      nativeToolUseId: 'toolu_retry',
    });
  });

  it('leaves a routed row, and a hold from an earlier turn, as they are', async () => {
    const search = 'WebSearch rust async runtimes';
    await markHeld(dir, 'toolu_a', { ...TERMS, target: search }, 1_000);
    await markRouted(dir, OFFER, 1_500);
    await markNative(dir, search, 'toolu_retry', 2_000);
    expect(await outcome('toolu_a')).toBe('routed');
    await markHeld(
      dir,
      'toolu_old',
      { ...TERMS, offerId: 'o2', target: 'WebFetch https://a.test/' },
      1_000,
    );
    await markNative(dir, 'WebFetch https://a.test/', 'toolu_late', 1_000 + EXPIRY_MS + 1);
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
