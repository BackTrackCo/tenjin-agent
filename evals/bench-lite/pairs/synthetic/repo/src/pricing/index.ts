import type { EntryKind, Plan } from '../types.ts';
import { cellKey } from './rules.ts';
import { PRICING_TABLE } from './table.generated.ts';

/** One folded pricing cell: a flat part and a proportional part. */
export interface PriceCell {
  flatCents: number;
  basisPoints: number;
}

const EMPTY_CELL: PriceCell = { flatCents: 0, basisPoints: 0 };

/** The cell that prices this plan and entry kind. */
export function cellFor(plan: Plan, kind: EntryKind): PriceCell {
  return PRICING_TABLE[cellKey(plan, kind)] ?? EMPTY_CELL;
}

/**
 * The fee, in whole cents, for posting `amountCents` on `plan`.
 *
 * Rounded half up, and never negative.
 */
export function priceFor(plan: Plan, kind: EntryKind, amountCents: number): number {
  const cell = cellFor(plan, kind);
  const fee = cell.flatCents + (amountCents * cell.basisPoints) / 10_000;
  return Math.max(0, Math.round(fee));
}

/** Every priced combination, for the pricing page and the health payload. */
export function describePricing(): { key: string; flatCents: number; basisPoints: number }[] {
  return Object.entries(PRICING_TABLE)
    .map(([key, cell]) => ({ key, flatCents: cell.flatCents, basisPoints: cell.basisPoints }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
