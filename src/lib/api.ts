import { z } from 'zod';
import pkg from '../../package.json';
import { CliError } from './errors';
import type { FetchResponseSuccess } from './http';

/**
 * Wire schemas for the server responses the B2 commands consume, validated
 * loosely on purpose: the server contract is the source of truth and additive
 * fields must never break an older CLI, so every object is `looseObject` and
 * only the fields the CLI actually reads are pinned. A parse failure here means
 * the server and CLI genuinely disagree (CONTRACT_MISMATCH), not that the
 * server moved ahead.
 */

export const CLIENT_LABEL = `tenjin-cli/${pkg.version}`;

/** Base headers for every Tenjin API request (attribution per spec 09 §3). */
export function baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { accept: 'application/json', 'x-tenjin-client': CLIENT_LABEL, ...extra };
}

export const LookupCandidateSchema = z.looseObject({
  resourceId: z.string(),
  url: z.string(),
  title: z.string(),
  artifactType: z.string(),
  price: z.string().regex(/^\d+$/),
  asOf: z.string().nullable(),
  validUntil: z.string().nullable(),
  temporalMode: z.string(),
  appliesTo: z.record(z.string(), z.array(z.string())),
  questionsAnswered: z.array(z.string()),
  tasksSupported: z.array(z.string()),
  scope: z.string().nullable(),
  exclusions: z.string().nullable(),
  matchReasons: z.array(z.string()),
  estimatedTokens: z.number(),
  creator: z.looseObject({ handle: z.string() }),
});
export type LookupCandidate = z.infer<typeof LookupCandidateSchema>;

export const LookupResponseSchema = z.looseObject({
  schemaVersion: z.number(),
  lookupId: z.string(),
  decision: z.enum(['CANDIDATES', 'MISS']),
  calibration: z.string(),
  candidates: z.array(LookupCandidateSchema).optional(),
});
export type LookupResponse = z.infer<typeof LookupResponseSchema>;

export const OutcomeAcceptedSchema = z.looseObject({ accepted: z.number() });

/** ArticleBase subset both the 402 preview and the unlocked body share. */
const articleFields = {
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  excerpt: z.string().nullish(),
  price: z.string().regex(/^\d+$/),
  publishedAt: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  creator: z.looseObject({
    handle: z.string().nullish(),
    displayName: z.string().nullish(),
    walletAddress: z.string().nullish(),
  }),
};

export const ArticlePreviewSchema = z.looseObject({
  ...articleFields,
  bodyMdPreview: z.string(),
  rereadHint: z.string().optional(),
});
export type ArticlePreview = z.infer<typeof ArticlePreviewSchema>;

export const ArticleUnlockedSchema = z.looseObject({
  ...articleFields,
  bodyMd: z.string(),
  related: z.array(z.looseObject({ url: z.string(), title: z.string() })).optional(),
});
export type ArticleUnlocked = z.infer<typeof ArticleUnlockedSchema>;

export const ServerErrorSchema = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

/** Parse a response body against a schema, or fail as CONTRACT_MISMATCH. */
export function parseBody<T>(schema: z.ZodType<T>, res: FetchResponseSuccess, what: string): T {
  const parsed = schema.safeParse(res.json);
  if (!parsed.success) {
    throw new CliError(
      'CONTRACT_MISMATCH',
      `The server's ${what} response did not match the contract this CLI understands.`,
      {
        fix: 'Upgrade tenjin-cli, or check --base-url points at a Tenjin deployment.',
        details: { issues: parsed.error.issues, requestId: res.requestId },
      },
    );
  }
  return parsed.data;
}

/** The server error envelope's code/message when the body carries one. */
export function serverError(res: FetchResponseSuccess): { code: string; message: string } | null {
  const parsed = ServerErrorSchema.safeParse(res.json);
  return parsed.success ? parsed.data.error : null;
}

/**
 * Map an unexpected non-2xx API response to the CLI error contract: 429 becomes
 * RATE_LIMITED (with Retry-After seconds in details), anything else API_ERROR
 * carrying the server envelope so agents can branch on the server's stable code.
 */
export function apiErrorFrom(res: FetchResponseSuccess, context: string): CliError {
  if (res.status === 429) {
    const retryAfter = res.header('retry-after');
    return new CliError('RATE_LIMITED', `${context}: rate limited by the server.`, {
      fix: retryAfter !== null ? `Retry after ${retryAfter}s.` : 'Retry shortly.',
      details: {
        ...(retryAfter !== null ? { retryAfterSeconds: Number(retryAfter) } : {}),
        requestId: res.requestId,
      },
    });
  }
  const err = serverError(res);
  return new CliError(
    'API_ERROR',
    err !== null
      ? `${context}: ${err.message}`
      : `${context}: request failed with status ${res.status}.`,
    {
      details: {
        status: res.status,
        ...(err !== null ? { serverCode: err.code } : {}),
        requestId: res.requestId,
      },
    },
  );
}
