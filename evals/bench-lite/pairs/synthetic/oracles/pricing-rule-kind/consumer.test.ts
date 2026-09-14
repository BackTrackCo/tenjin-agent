import { beforeEach, describe, expect, it } from 'vitest';
import { cellFor, priceFor } from '../../src/pricing/index.ts';
import { PRICING_RULES } from '../../src/pricing/rules.ts';
import { PRICING_TABLE } from '../../src/pricing/table.generated.ts';
import { postEntry } from '../../src/ledger.ts';
import { resetWorld, seedAccount } from '../../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
});

describe('the volume discount', () => {
  it('does not apply at or below the threshold', () => {
    expect(priceFor('scale', 'debit', 100_000)).toBe(150);
    expect(priceFor('scale', 'debit', 50_000)).toBe(75);
  });

  it('applies above the threshold', () => {
    expect(priceFor('scale', 'debit', 200_000)).toBe(255);
    expect(priceFor('scale', 'debit', 150_000)).toBe(191);
  });

  it('applies from the first cent over the threshold', () => {
    expect(priceFor('scale', 'debit', 100_001)).toBe(128);
  });

  it('leaves the other cells alone', () => {
    expect(priceFor('scale', 'credit', 1_000_000)).toBe(500);
    expect(priceFor('standard', 'debit', 1_000_000)).toBe(2_510);
    expect(priceFor('starter', 'debit', 1_000_000)).toBe(25);
  });
});

describe('the rules', () => {
  it('holds one tier rule, on scale debits', () => {
    const tiers = PRICING_RULES.filter((rule) => rule.kind === 'tier');
    expect(tiers).toEqual([
      {
        plan: 'scale',
        appliesTo: 'debit',
        kind: 'tier',
        aboveCents: 100_000,
        discountBasisPoints: 1_500,
      },
    ]);
  });
});

describe('the folded table', () => {
  it('carries the tier on the cell it applies to', () => {
    expect(PRICING_TABLE['scale:debit']).toMatchObject({
      flatCents: 0,
      basisPoints: 15,
      tier: { aboveCents: 100_000, discountBasisPoints: 1_500 },
    });
  });

  it('carries a null tier everywhere else', () => {
    expect(PRICING_TABLE['scale:credit']?.tier).toBeNull();
    expect(PRICING_TABLE['standard:debit']?.tier).toBeNull();
    expect(cellFor('starter', 'debit').tier).toBeNull();
  });

  it('is still six cells', () => {
    expect(Object.keys(PRICING_TABLE)).toHaveLength(6);
  });
});

describe('a posted entry', () => {
  it('is charged the discounted fee', () => {
    const account = seedAccount('scale');
    const entry = postEntry({ accountId: account.id, amountCents: 200_000, kind: 'debit' });
    expect(entry.feeCents).toBe(255);
  });
});
