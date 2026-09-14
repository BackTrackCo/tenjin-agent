/**
 * Process configuration.
 *
 * Everything the operator can tune lives here, named `LEDGER_*` in the
 * environment. Defaults are the production values.
 */

const env = process.env;

export interface LedgerConfig {
  /** ISO-4217 code every amount in this process is denominated in. */
  currency: string;
  /** Largest batch `postEntries` will accept in one call. */
  maxBatchSize: number;
  /** How long settled entries are kept before the sweeper drops them. */
  retentionDays: number;
  /** Feature flags, comma separated in `LEDGER_FLAGS`. */
  flags: readonly string[];
  /** Reject fractional amounts instead of rounding them. */
  strictAmounts: boolean;
}

function readInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFlags(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((flag) => flag.trim())
    .filter((flag) => flag.length > 0);
}

export const config: LedgerConfig = Object.freeze({
  currency: env.LEDGER_CURRENCY ?? 'USD',
  maxBatchSize: readInt(env.LEDGER_MAX_BATCH, 50),
  retentionDays: readInt(env.LEDGER_RETENTION_DAYS, 90),
  flags: Object.freeze(readFlags(env.LEDGER_FLAGS)),
  strictAmounts: env.LEDGER_STRICT_AMOUNTS === '1',
});

/** True if the named feature flag is on. */
export function isFlagEnabled(name: string): boolean {
  return config.flags.includes(name);
}

/** The config as an object safe to put in a health payload. */
export function describeConfig(): Record<string, string | number | boolean> {
  return {
    currency: config.currency,
    maxBatchSize: config.maxBatchSize,
    retentionDays: config.retentionDays,
    flags: config.flags.join(','),
    strictAmounts: config.strictAmounts,
  };
}
