import type { EntryKind, Plan } from '../types.ts';

/**
 * What posting an entry costs.
 *
 * Rules are written here, by hand, by whoever owns pricing. Several rules may
 * apply to the same plan and entry kind; they add up.
 */
export type PricingRule =
  | { plan: Plan; appliesTo: EntryKind; kind: 'flat'; valueCents: number }
  | { plan: Plan; appliesTo: EntryKind; kind: 'percent'; basisPoints: number };

export const PRICING_RULES: PricingRule[] = [
  { plan: 'starter', appliesTo: 'debit', kind: 'flat', valueCents: 25 },
  { plan: 'starter', appliesTo: 'credit', kind: 'flat', valueCents: 10 },

  { plan: 'standard', appliesTo: 'debit', kind: 'flat', valueCents: 10 },
  { plan: 'standard', appliesTo: 'debit', kind: 'percent', basisPoints: 25 },
  { plan: 'standard', appliesTo: 'credit', kind: 'flat', valueCents: 5 },

  { plan: 'scale', appliesTo: 'debit', kind: 'percent', basisPoints: 15 },
  { plan: 'scale', appliesTo: 'credit', kind: 'percent', basisPoints: 5 },
];

/** The key a rule contributes to in the generated table. */
export function cellKey(plan: Plan, appliesTo: EntryKind): string {
  return `${plan}:${appliesTo}`;
}
