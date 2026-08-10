import { CliError } from './errors';
import { ATOMIC_RE } from './ids';
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

/**
 * Whether an atomic price would actually cost something: true paid, false free,
 * null when the string is not an atomic amount at all and so cannot answer.
 *
 * A Tenjin piece may be priced at zero and is then delivered by `read` with no
 * payment, so "there is a price field" and "there is a purchase to make" are
 * different questions. The third state is not decoration: only the wire schema
 * enforces ATOMIC_RE, and the local search store types `price` as a bare string,
 * so a hand-edited or half-written entry can hold "-1" or "0.1". Those must not
 * read as "free", or corrupt local data would start refusing honest reports.
 * Never throws, which is why the check is a regex and not a BigInt compare.
 *
 * Matched against the RAW string, with no trimming. The contract carries the
 * canonical form and nothing else, so " 0 " did not come off the wire; padding is
 * evidence the value was edited, and normalizing it away would launder a corrupt
 * entry into a confident "free" and hand back the false refusal this avoids.
 */
export function isPaidPrice(atomic: string): boolean | null {
  if (!ATOMIC_RE.test(atomic)) return null;
  return /[1-9]/.test(atomic);
}

/** Dual-form money object for machine output. */
export function toMoney(atomic: string): Money {
  return { atomic, usd: atomicToUsd(atomic) };
}

/**
 * Canonical USD for human COPY (a price a person reads): always at least two
 * decimals ("0.10", "5.00"), keeping any finer precision below a cent
 * ("0.000001"). Distinct from `atomicToUsd`, which trims to the shortest exact
 * form for machine output; use this only where a dollar amount is shown to a human.
 */
export function formatUsdDisplay(atomic: string): string {
  const [whole, frac = ''] = atomicToUsd(atomic).split('.');
  return `${whole}.${frac.padEnd(2, '0')}`;
}
