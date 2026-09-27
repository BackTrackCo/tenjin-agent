import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { CliError } from '../../lib/errors';
import { canonicalHash } from '../../lib/request-schema';
import { mask } from '../../lib/redact';
import type { CommandContext, CommandResult } from '../../context';
import type { RequestToolResult } from '../tool';
import { providerRead } from './account';
import { readPrivate, reviewDir, savePrivate } from './store';

export const ReviewMaterialSchema = z.strictObject({
  title: z.string().min(5).max(200),
  material: z.string().min(20).max(12_000),
  expertise: z.string().min(2).max(300),
});
export type ReviewMaterial = z.infer<typeof ReviewMaterialSchema>;
const JobSchema = z.strictObject({
  jobId: z.string().uuid(),
  intent: z.string().min(1).max(8_000),
  review: ReviewMaterialSchema,
  revision: z.string(),
  createdAt: z.string(),
  status: z.literal('draft'),
});
function jobPath(ctx: CommandContext, id: string): string {
  if (!z.string().uuid().safeParse(id).success)
    throw new CliError('USAGE', 'Invalid review job ID.');
  return join(reviewDir(ctx.dataDir), 'jobs', `${id}.json`);
}
export async function prepareReview(
  ctx: CommandContext,
  intent: string,
  material: unknown,
): Promise<RequestToolResult> {
  const parsed = ReviewMaterialSchema.safeParse(material);
  if (!parsed.success)
    return {
      isError: false,
      summary: 'Supply exact material for the human-review draft.',
      envelope: {
        status: 'needs_input',
        missing: ['review.title', 'review.material', 'review.expertise'],
        nextStep:
          'Call request with the same query and exact review material. A draft does not publish or spend.',
      },
    };
  if (mask(JSON.stringify(parsed.data)) !== JSON.stringify(parsed.data))
    throw new CliError(
      'REFUSED',
      'Review material contains a credential-shaped value. Remove it before preparing a draft.',
    );
  const job = {
    jobId: randomUUID(),
    intent,
    review: parsed.data,
    revision: canonicalHash(parsed.data),
    createdAt: new Date().toISOString(),
    status: 'draft' as const,
  };
  await savePrivate(jobPath(ctx, job.jobId), job);
  return reviewResult(job);
}
function reviewResult(job: z.infer<typeof JobSchema>): RequestToolResult {
  return {
    isError: false,
    summary: `Human review draft ${job.jobId}; nothing posted or paid.`,
    envelope: {
      ...job,
      provider: 'RentAHuman',
      pricing: 'quote_required',
      publication: 'The exact title, material and expertise may be public if later submitted.',
      nextStep: `Inspect this draft, then use tenjin jobs connect and tenjin jobs quote ${job.jobId} --price <worker-USD> --share.`,
      launchGate:
        'Live hiring is unavailable until authenticated all-in spending bounds and finalized-submission recovery have been verified.',
    },
  };
}
async function readJob(ctx: CommandContext, id: string): Promise<z.infer<typeof JobSchema>> {
  const job = await readPrivate(jobPath(ctx, id), JobSchema);
  if (!job)
    throw new CliError('REFUSED', 'No human-review job with that ID is saved on this machine.');
  if (job.jobId !== id || job.revision !== canonicalHash(job.review))
    throw new CliError('REFUSED', 'The saved draft failed its revision check.');
  return job;
}
export async function readReview(ctx: CommandContext, id: string): Promise<RequestToolResult> {
  return reviewResult(await readJob(ctx, id));
}
export function quoteTotalCents(value: unknown): number {
  const result = z
    .object({
      success: z.literal(true),
      dryRun: z.literal(true),
      fundingTotal: z.number().finite().positive(),
    })
    .safeParse(value);
  if (!result.success)
    throw new CliError(
      'REFUSED',
      'Provider quote has no verified all-in total; no local estimate is substituted.',
    );
  const cents = result.data.fundingTotal * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-7 || !Number.isSafeInteger(Math.round(cents)))
    throw new CliError('REFUSED', 'Provider total cannot be represented as exact cents.');
  return Math.round(cents);
}
export async function quoteReview(
  ctx: CommandContext,
  id: string,
  price: string,
  fetchImpl?: typeof fetch,
): Promise<CommandResult> {
  if (!/^\d+(\.\d{1,2})?$/.test(price) || Number(price) <= 0 || Number(price) > 10000)
    throw new CliError(
      'USAGE',
      'Supply worker compensation in USD with at most two decimals, up to $10,000.',
    );
  const job = await readJob(ctx, id);
  const result = await providerRead(
    ctx,
    '/bounties',
    {
      dryRun: true,
      title: job.review.title,
      description: job.review.material,
      completionCriteria: `One written critique with reasons and actionable changes. Requested expertise: ${job.review.expertise}`,
      evidenceTypes: ['text'],
      priceType: 'fixed',
      price: Number(price),
      estimatedHours: 1,
      spotsAvailable: 1,
      autoAccept: false,
      location: { isRemoteAllowed: true },
    },
    fetchImpl,
  );
  const fundingTotalCents = quoteTotalCents(result);
  return {
    data: {
      status: 'quoted',
      jobId: id,
      revision: job.revision,
      workerPriceUsd: price,
      fundingTotalCents,
      submitted: false,
      nextStep: 'Live hiring remains gated: a preview is not an enforceable spending limit.',
    },
  };
}
