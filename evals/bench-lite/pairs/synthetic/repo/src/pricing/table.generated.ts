// GENERATED FILE. Written by scripts/build-pricing.mjs from src/pricing/rules.ts.
// Hand edits do not survive.

export const PRICING_TABLE: Record<string, { flatCents: number; basisPoints: number }> = {
  'scale:credit': { flatCents: 0, basisPoints: 5 },
  'scale:debit': { flatCents: 0, basisPoints: 15 },
  'standard:credit': { flatCents: 5, basisPoints: 0 },
  'standard:debit': { flatCents: 10, basisPoints: 25 },
  'starter:credit': { flatCents: 10, basisPoints: 0 },
  'starter:debit': { flatCents: 25, basisPoints: 0 },
};
