import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../../context';
import { prepareReview, quoteTotalCents, readReview } from './jobs';
import { reviewDir } from './store';
let ctx: CommandContext;
beforeEach(async () => {
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  ctx = {
    dataDir: await mkdtemp(join(tmpdir(), 'review-')),
    flags: { json: true, timeout: 1000 },
    io: { stdout: sink, stderr: sink, isTTY: false },
  };
});
afterEach(async () => {
  await rm(ctx.dataDir, { recursive: true, force: true });
});
const review = {
  title: 'Review checkout design',
  material: 'The checkout has three steps: delivery, payment, and confirmation.',
  expertise: 'UX design',
};
describe('review drafts', () => {
  it('persists exact material privately and resumes without a provider request', async () => {
    const result = await prepareReview(ctx, 'Second opinion on checkout', review);
    const id = result.envelope.jobId as string;
    const resumed = await readReview(ctx, id);
    expect(resumed.envelope.review).toEqual(review);
    expect(resumed.envelope.status).toBe('draft');
    expect(resumed.envelope).not.toHaveProperty('apiKey');
    if (process.platform !== 'win32')
      expect((await stat(join(reviewDir(ctx.dataDir), 'jobs', `${id}.json`))).mode & 0o777).toBe(
        0o600,
      );
  });
  it('requires explicit material and refuses changed drafts and traversal handles', async () => {
    expect((await prepareReview(ctx, 'Second opinion', undefined)).envelope.status).toBe(
      'needs_input',
    );
    const result = await prepareReview(ctx, 'Second opinion', review);
    const id = result.envelope.jobId as string;
    const path = join(reviewDir(ctx.dataDir), 'jobs', `${id}.json`);
    const value = JSON.parse(await readFile(path, 'utf8'));
    value.review.material = 'A replacement answer after the approval preview.';
    await writeFile(path, JSON.stringify(value));
    await expect(readReview(ctx, id)).rejects.toThrow('revision');
    await expect(readReview(ctx, '../../account')).rejects.toThrow('Invalid');
  });
  it('accepts only an authoritative exact provider total, never an MCP estimate', () => {
    expect(quoteTotalCents({ success: true, dryRun: true, fundingTotal: 5.9 })).toBe(590);
    expect(() =>
      quoteTotalCents({ success: true, dryRun: true, preview: { fundingTotal: 5.9 } }),
    ).toThrow();
    expect(() => quoteTotalCents({ success: true, dryRun: true, fundingTotal: 5.999 })).toThrow();
  });
});
