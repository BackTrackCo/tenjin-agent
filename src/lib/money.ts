import { CliError } from './errors';
import type { Money } from '../schemas';

/** USDC is a 6-decimal token; one dollar is 1_000_000 atomic units. */
const USDC_DECIMALS = 6;

/**
 * Decimal USD at the CLI edge -> atomic USDC string (O1). Accepts "0", "0.25",
 * "5"; rejects negatives, non-numeric input, and more than 6 decimal places as
 * USAGE so a fat-fingered amount fails loudly instead of truncating money.
 * String math throughout — a float would lose precision at the 6th decimal.
 */
export function parseUsdToAtomic(input: string): string {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new CliError('USAGE', `Invalid USD amount: ${JSON.stringify(input)}`, {
      fix: 'Pass a non-negative decimal like 0.25 or 5.',
    });
  }
  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > USDC_DECIMALS) {
    throw new CliError(
      'USAGE',
      `USD amount ${JSON.stringify(input)} has more than 6 decimal places`,
      {
        fix: 'USDC supports at most 6 decimal places (micro-dollars).',
      },
    );
  }
  const atomic = BigInt(`${whole}${frac.padEnd(USDC_DECIMALS, '0')}`);
  return atomic.toString();
}

/**
 * Atomic USDC string -> decimal USD string, trailing zeros trimmed ("250000" ->
 * "0.25", "5000000" -> "5", "0" -> "0"). Throws INTERNAL on a malformed atomic
 * value: atomic strings come from validated config or on-chain reads, so a bad
 * one is a bug, not user input.
 */
export function atomicToUsd(atomic: string): string {
  const trimmed = atomic.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CliError('INTERNAL', `Malformed atomic amount: ${JSON.stringify(atomic)}`);
  }
  const value = BigInt(trimmed);
  const base = 10n ** BigInt(USDC_DECIMALS);
  const whole = value / base;
  const frac = (value % base).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
}

/** Dual-form money object for machine output. */
export function toMoney(atomic: string): Money {
  return { atomic, usd: atomicToUsd(atomic) };
}
