import { describe, expect, it } from 'vitest';
import { USDC_ADDRESS } from '../../lib/usdc';
import { advertisedPrice } from './pricing';

const offer = (amount: unknown = '7000') => ({
  scheme: 'exact',
  network: 'eip155:8453',
  asset: USDC_ADDRESS,
  payTo: `0x${'1'.repeat(40)}`,
  amount,
});

describe('advertised USDC price summaries', () => {
  it.each([
    ['0', '0'],
    ['1', '0.000001'],
    ['7000', '0.007'],
    ['1000000', '1'],
    ['1000001', '1.000001'],
    ['1234567890123456789012345', '1234567890123456789.012345'],
    ['999999999999999999999999999999', '999999999999999999999999.999999'],
  ])('renders %s atomic as exact decimal USDC without floating point', (atomic, decimal) => {
    expect(advertisedPrice({ accepts: [offer(atomic)] })).toEqual({
      status: 'known',
      currency: 'USDC',
      network: 'eip155:8453',
      decimals: 6,
      basis: 'advertised-ceiling',
      liveQuoteRequired: true,
      supportedAlternatives: 1,
      pricedAlternatives: 1,
      ignoredAlternatives: 0,
      minCeilingAtomic: atomic,
      maxCeilingAtomic: atomic,
      minCeilingUSDC: decimal,
      maxCeilingUSDC: decimal,
      comparisonCeilingAtomic: atomic,
      comparisonCeilingUSDC: decimal,
    });
  });

  it.each([
    '1e6',
    '-1',
    '+1',
    '1.5',
    '',
    ' 1',
    '01',
    '00',
    '١',
    0,
    7000,
    null,
    {},
    [],
    true,
    '1'.repeat(31),
    '1'.repeat(80),
    '1'.repeat(81),
    '1'.repeat(100_000),
  ])('never treats malformed or unsupported amounts as free (%s)', (amount) => {
    const price = advertisedPrice({ accepts: [offer(amount)] });
    expect(price).toMatchObject({
      status: 'unknown',
      reason: 'missing-or-invalid-amount',
      pricedAlternatives: 0,
    });
    expect(price).not.toHaveProperty('comparisonCeilingAtomic');
    expect(price).not.toHaveProperty('knownRange');
  });

  it('uses amount before maxAmountRequired and only falls back for nullish amount', () => {
    for (const amount of [undefined, null])
      expect(
        advertisedPrice({ accepts: [{ ...offer(amount), amount, maxAmountRequired: '12000' }] }),
      ).toMatchObject({
        status: 'known',
        comparisonCeilingAtomic: '12000',
        comparisonCeilingUSDC: '0.012',
      });
    expect(
      advertisedPrice({ accepts: [{ ...offer('7000'), maxAmountRequired: '12000' }] }),
    ).toMatchObject({ status: 'known', comparisonCeilingAtomic: '7000' });
    expect(
      advertisedPrice({ accepts: [{ ...offer('invalid'), maxAmountRequired: '12000' }] }).status,
    ).toBe('unknown');
    const missing: Record<string, unknown> = offer();
    delete missing.amount;
    expect(advertisedPrice({ accepts: [missing] })).toMatchObject({
      status: 'unknown',
      reason: 'missing-or-invalid-amount',
    });
  });

  it('reports the range across compatible alternatives and compares using its conservative maximum', () => {
    const contract = {
      accepts: [offer('12000'), offer('0'), { ...offer('7000'), payTo: `0x${'2'.repeat(40)}` }],
    };
    const before = JSON.stringify(contract);
    expect(advertisedPrice(contract)).toMatchObject({
      status: 'known',
      supportedAlternatives: 3,
      pricedAlternatives: 3,
      minCeilingAtomic: '0',
      maxCeilingAtomic: '12000',
      minCeilingUSDC: '0',
      maxCeilingUSDC: '0.012',
      comparisonCeilingAtomic: '12000',
      comparisonCeilingUSDC: '0.012',
      liveQuoteRequired: true,
    });
    expect(JSON.stringify(contract)).toBe(before);
  });

  it('preserves partial price uncertainty without a comparison ceiling', () => {
    for (const incomplete of [{ ...offer(), amount: undefined }, offer('malformed')]) {
      const price = advertisedPrice({ accepts: [offer('7000'), incomplete] });
      expect(price).toMatchObject({
        status: 'unknown',
        reason: 'partial-pricing',
        supportedAlternatives: 2,
        pricedAlternatives: 1,
        knownRange: {
          minCeilingAtomic: '7000',
          maxCeilingAtomic: '7000',
          minCeilingUSDC: '0.007',
          maxCeilingUSDC: '0.007',
        },
      });
      expect(price).not.toHaveProperty('comparisonCeilingAtomic');
      expect(price).not.toHaveProperty('maxCeilingAtomic');
    }
  });

  it('ignores unsupported rails, assets, merchants and malformed entries rather than calling them free', () => {
    const ignored = [
      null,
      [],
      'free',
      { ...offer('0'), scheme: 'upto' },
      { ...offer('0'), network: 'base' },
      { ...offer('0'), network: 'eip155:84532' },
      { ...offer('0'), asset: `0x${'9'.repeat(40)}` },
      { ...offer('0'), asset: 1 },
      { ...offer('0'), payTo: 'not-an-address' },
      { ...offer('0'), payTo: `0x${'g'.repeat(40)}` },
      { ...offer('0'), payTo: undefined },
    ];
    expect(advertisedPrice({ accepts: ignored })).toMatchObject({
      status: 'unknown',
      reason: 'no-supported-alternatives',
      supportedAlternatives: 0,
      pricedAlternatives: 0,
      ignoredAlternatives: ignored.length,
    });
    expect(
      advertisedPrice({
        accepts: [...ignored, { ...offer('7000'), asset: USDC_ADDRESS.toLowerCase() }],
      }),
    ).toMatchObject({
      status: 'known',
      comparisonCeilingAtomic: '7000',
      ignoredAlternatives: ignored.length,
    });
    expect(advertisedPrice({ accepts: [] })).toMatchObject({
      status: 'unknown',
      reason: 'no-supported-alternatives',
    });
    const serialized = JSON.stringify(advertisedPrice({ accepts: [offer()] }));
    expect(serialized).not.toContain('payTo');
    expect(serialized).not.toContain(USDC_ADDRESS);
  });
});
