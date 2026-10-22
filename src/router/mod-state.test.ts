import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OfferSpec } from './decision';
import { MOD_STATE_FILES } from './mod-state';
import { markOffered, sessionDir } from './progress';
import { storeChoices, storeSpecs } from './specs';

/**
 * THE FILES THE MOD READS, written by the CLI's own writers, with the fields
 * and version the mod checks before it reads them (`register.tsx`). A rename
 * or a version bump here fails this test before the mod silently says less.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-mod-state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d77';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const json = async (path: string) =>
  JSON.parse(await readFile(join(dir, path), 'utf8')) as Record<string, unknown>;

describe('the state contract between the CLI and the mod', () => {
  it('keeps a spec under the SHA-256 of its offer id, with the price fields the row shows', async () => {
    const spec: OfferSpec = {
      id: ID,
      capabilityId: 'exa-search',
      provider: 'Exa',
      description: 'web search',
      priceAtomic: '7000',
      priceVaries: false,
      maxAmountAtomic: '7000',
      payTo: '0x1111111111111111111111111111111111111111',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      request: { method: 'GET', url: 'https://api.exa.ai/search', fields: {}, location: 'query' },
      input: {},
      pinned: {},
    };
    await storeSpecs(dir, [spec]);
    expect(await json(`progress/specs/${sha256(ID)}.json`)).toMatchObject({
      capabilityId: 'exa-search',
      priceAtomic: '7000',
      maxAmountAtomic: '7000',
      priceVaries: false,
      shown: null,
    });
  });

  it('keeps the offer record under the session, keyed by the tool_use_id, with the offer id', async () => {
    await markOffered(
      dir,
      'sess-1',
      'toolu_held',
      {
        offerId: ID,
        label: 'Exa search',
        priceAtomic: '7000',
      },
      1,
    );
    const path = join(sessionDir(dir, 'sess-1'), `offer-${sha256('toolu_held')}.json`);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      version: 1,
      at: 1,
      offerId: ID,
      label: 'Exa search',
      priceAtomic: '7000',
    });
    expect(sessionDir(dir, 'sess-1')).toBe(join(dir, 'progress', sha256('sess-1')));
  });

  it("keeps a choice set beside the line's id, each option's key, label and own id", async () => {
    const other = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d78';
    await storeChoices(dir, ID, {
      choices: {
        group: 'image-frontier',
        default: 'gpt-image-2.5',
        input: ['prompt'],
        options: [
          { key: 'gpt-image-2.5', label: 'GPT Image 2.5 Sunburst', strength: 'text', id: ID },
          { key: 'nano-banana-2.1', label: 'Nano Banana 2.1', strength: 'photo', id: other },
        ],
        all: { totalAtomic: '85000' },
      },
      hint: 'pick one',
    } as never);
    const kept = await json(`progress/specs/${sha256(ID)}.choices.json`);
    expect((kept.choices as { options: unknown[] }).options[0]).toMatchObject({
      key: 'gpt-image-2.5',
      label: 'GPT Image 2.5 Sunburst',
      id: ID,
    });
  });

  it('names exactly these three files', () => {
    expect(MOD_STATE_FILES).toEqual(['spec', 'choices', 'offer']);
  });
});
