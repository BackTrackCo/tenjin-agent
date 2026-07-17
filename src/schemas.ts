import { z } from 'zod';

/**
 * Bumped only on a breaking change to any stdout envelope shape. Agents pin on
 * this: a consumer that sees an unexpected value should refuse to parse rather
 * than guess. Every envelope carries it, success or failure.
 */
export const SCHEMA_VERSION = 1;

/**
 * The closed set of machine error codes. `error.code` in a failure envelope is
 * always one of these; agents branch on it, humans read `message`/`fix`. The
 * exit-code mapping lives in lib/errors.ts (this enum is the single source of
 * the code names both sides agree on).
 */
export const ErrorCodeSchema = z.enum([
  'NODE_UNSUPPORTED',
  'USAGE',
  'CONFIG_INVALID',
  'WALLET_EXISTS',
  'WALLET_MISSING',
  'WALLET_INVALID_KEY',
  'PROVIDER_ERROR',
  'RPC_ERROR',
  'API_UNREACHABLE',
  'CONTRACT_MISMATCH',
  'REFUSED',
  'NETWORK_ERROR',
  'INTERNAL',
  'NOT_IMPLEMENTED',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * All money in machine output is dual-form: `atomic` is the 6-decimal USDC base
 * unit as a decimal string (never a JS number — precision), `usd` is the same
 * value formatted as decimal dollars. Emit both so agents compute on `atomic`
 * and humans read `usd` without either side re-deriving the other.
 */
export const MoneySchema = z.object({
  atomic: z.string(),
  usd: z.string(),
});
export type Money = z.infer<typeof MoneySchema>;

export const OutputErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  fix: z.string().optional(),
  details: z.unknown().optional(),
});
export type OutputError = z.infer<typeof OutputErrorSchema>;

export const SuccessEnvelopeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  command: z.string(),
  ok: z.literal(true),
  data: z.unknown(),
});
export type SuccessEnvelope = z.infer<typeof SuccessEnvelopeSchema>;

export const FailureEnvelopeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  command: z.string(),
  ok: z.literal(false),
  error: OutputErrorSchema,
});
export type FailureEnvelope = z.infer<typeof FailureEnvelopeSchema>;

/** The one thing every invocation prints to stdout, discriminated on `ok`. */
export const OutputEnvelopeSchema = z.discriminatedUnion('ok', [
  SuccessEnvelopeSchema,
  FailureEnvelopeSchema,
]);
export type OutputEnvelope = z.infer<typeof OutputEnvelopeSchema>;
