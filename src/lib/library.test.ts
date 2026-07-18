import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bodyPath,
  contentHash,
  findDelivered,
  headingOutline,
  receiptPath,
  resourceDir,
  saveDelivery,
} from './library';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-lib-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const RESOURCE = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function input(over: Partial<Parameters<typeof saveDelivery>[1]> = {}) {
  return {
    resourceId: RESOURCE,
    slug: 'my-slug',
    title: 'My Title',
    handle: 'iris',
    url: 'https://tenjin.blog/api/read/iris/my-slug',
    priceAtomic: '100000',
    entitlement: 'purchased' as const,
    bodyMd: '# Heading\n\nbody text\n',
    ...over,
  };
}

describe('saveDelivery + findDelivered', () => {
  it('writes the body under library/<resourceId>/<slug>.md and a receipt', async () => {
    const saved = await saveDelivery(dir, input());
    expect(saved.bodyPath).toBe(bodyPath(dir, RESOURCE, 'my-slug'));
    expect(await readFile(saved.bodyPath, 'utf8')).toBe('# Heading\n\nbody text\n');
    const receipt = JSON.parse(await readFile(receiptPath(dir, RESOURCE), 'utf8'));
    expect(receipt).toMatchObject({
      resourceId: RESOURCE,
      slug: 'my-slug',
      entitlement: 'purchased',
      contentHash: contentHash('# Heading\n\nbody text\n'),
    });
  });

  it('records the settlement tx hash when present', async () => {
    await saveDelivery(dir, input({ settlementTxHash: '0xdead' }));
    const found = await findDelivered(dir, RESOURCE);
    expect(found?.receipt.settlementTxHash).toBe('0xdead');
  });

  it('findDelivered returns the saved body + receipt (idempotent re-delivery source)', async () => {
    await saveDelivery(dir, input());
    const found = await findDelivered(dir, RESOURCE);
    expect(found).not.toBeNull();
    expect(found?.bodyMd).toBe('# Heading\n\nbody text\n');
    expect(found?.receipt.title).toBe('My Title');
  });

  it('findDelivered is null when nothing was saved', async () => {
    expect(await findDelivered(dir, RESOURCE)).toBeNull();
  });

  it('findDelivered is null (never throws) on a corrupt receipt', async () => {
    await mkdir(resourceDir(dir, RESOURCE), { recursive: true });
    await writeFile(receiptPath(dir, RESOURCE), '{ not json', 'utf8');
    expect(await findDelivered(dir, RESOURCE)).toBeNull();
  });

  it('re-saving overwrites (a free read can later become a purchase)', async () => {
    await saveDelivery(dir, input({ entitlement: 'free' }));
    await saveDelivery(dir, input({ entitlement: 'purchased' }));
    const found = await findDelivered(dir, RESOURCE);
    expect(found?.receipt.entitlement).toBe('purchased');
  });
});

describe('contentHash', () => {
  it('is the sha256 the outcome endpoint expects', () => {
    // sha256 of the empty string, "sha256:" prefixed.
    expect(contentHash('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('headingOutline', () => {
  it('extracts ATX headings with levels', () => {
    expect(headingOutline('# A\n## B\ntext\n### C')).toEqual([
      { level: 1, text: 'A' },
      { level: 2, text: 'B' },
      { level: 3, text: 'C' },
    ]);
  });
  it('ignores # inside fenced code blocks', () => {
    const md = '# Real\n\n```bash\n# not a heading\n```\n\n## Also real';
    expect(headingOutline(md)).toEqual([
      { level: 1, text: 'Real' },
      { level: 2, text: 'Also real' },
    ]);
  });
});
