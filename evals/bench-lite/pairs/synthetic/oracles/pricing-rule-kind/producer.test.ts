import { describe, expect, it } from 'vitest';
import { cellFor, describePricing, priceFor } from '../../src/pricing/index.ts';
import { PRICING_RULES } from '../../src/pricing/rules.ts';
import { PRICING_TABLE } from '../../src/pricing/table.generated.ts';

describe('the floor', () => {
  it('lifts a small scale debit to the minimum', () => {
    expect(priceFor('scale', 'debit', 1_000)).toBe(20);
    expect(priceFor('scale', 'debit', 10_000)).toBe(20);
  });

  it('lifts a small scale credit to its own minimum', () => {
    expect(priceFor('scale', 'credit', 1_000)).toBe(10);
  });

  it('leaves a fee that is already above the minimum alone', () => {
    expect(priceFor('scale', 'debit', 100_000)).toBe(150);
    expect(priceFor('scale', 'credit', 1_000_000)).toBe(500);
  });

  it('takes effect exactly at the crossing point', () => {
    expect(priceFor('scale', 'debit', 13_333)).toBe(20);
    expect(priceFor('scale', 'debit', 13_334)).toBe(20);
    expect(priceFor('scale', 'debit', 14_000)).toBe(21);
  });

  it('leaves the other plans where they were', () => {
    expect(priceFor('starter', 'debit', 10_000)).toBe(25);
    expect(priceFor('starter', 'credit', 10_000)).toBe(10);
    expect(priceFor('standard', 'debit', 10_000)).toBe(35);
    expect(priceFor('standard', 'credit', 10_000)).toBe(5);
    expect(priceFor('standard', 'debit', 1)).toBe(10);
  });
});

describe('the rules', () => {
  it('holds a floor rule per scale entry kind', () => {
    const floors = PRICING_RULES.filter((rule) => rule.kind === 'floor');
    expect(floors).toHaveLength(2);
    expect(floors).toEqual(
      expect.arrayContaining([
        { plan: 'scale', appliesTo: 'debit', kind: 'floor', minimumCents: 20 },
        { plan: 'scale', appliesTo: 'credit', kind: 'floor', minimumCents: 10 },
      ]),
    );
  });
});

describe('the folded table', () => {
  it('carries the minimum on the cell', () => {
    expect(PRICING_TABLE['scale:debit']).toEqual({
      flatCents: 0,
      basisPoints: 15,
      minimumCents: 20,
    });
    expect(PRICING_TABLE['scale:credit']).toEqual({
      flatCents: 0,
      basisPoints: 5,
      minimumCents: 10,
    });
  });

  it('carries a zero minimum where no floor applies', () => {
    expect(PRICING_TABLE['standard:debit']).toEqual({
      flatCents: 10,
      basisPoints: 25,
      minimumCents: 0,
    });
    expect(cellFor('starter', 'credit').minimumCents).toBe(0);
  });

  it('is still six cells', () => {
    expect(Object.keys(PRICING_TABLE).sort()).toEqual([
      'scale:credit',
      'scale:debit',
      'standard:credit',
      'standard:debit',
      'starter:credit',
      'starter:debit',
    ]);
  });
});

describe('describePricing', () => {
  it('reports the minimum alongside the other parts', () => {
    const rows = describePricing();
    expect(rows.find((row) => row.key === 'scale:debit')).toEqual({
      key: 'scale:debit',
      flatCents: 0,
      basisPoints: 15,
      minimumCents: 20,
    });
    expect(rows.find((row) => row.key === 'starter:debit')).toMatchObject({ minimumCents: 0 });
  });
});
