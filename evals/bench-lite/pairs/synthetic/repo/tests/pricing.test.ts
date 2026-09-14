import { describe, expect, it } from 'vitest';
import { cellFor, describePricing, priceFor } from '../src/pricing/index.ts';

describe('priceFor', () => {
  it('charges the starter flat fee', () => {
    expect(priceFor('starter', 'debit', 10_000)).toBe(25);
    expect(priceFor('starter', 'credit', 10_000)).toBe(10);
  });

  it('adds the flat and the proportional part on standard', () => {
    expect(priceFor('standard', 'debit', 10_000)).toBe(35);
    expect(priceFor('standard', 'credit', 10_000)).toBe(5);
  });

  it('is proportional only on scale', () => {
    expect(priceFor('scale', 'debit', 100_000)).toBe(150);
    expect(priceFor('scale', 'credit', 100_000)).toBe(50);
  });

  it('rounds to a whole cent', () => {
    expect(priceFor('scale', 'debit', 333)).toBe(0);
    expect(priceFor('scale', 'debit', 3_334)).toBe(5);
  });
});

describe('cellFor', () => {
  it('folds every rule for a plan and kind into one cell', () => {
    expect(cellFor('standard', 'debit')).toEqual({ flatCents: 10, basisPoints: 25 });
  });
});

describe('describePricing', () => {
  it('lists every priced combination', () => {
    expect(describePricing().map((row) => row.key)).toEqual([
      'scale:credit',
      'scale:debit',
      'standard:credit',
      'standard:debit',
      'starter:credit',
      'starter:debit',
    ]);
  });
});
