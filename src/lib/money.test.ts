import { describe, it, expect } from 'vitest';
import { parseUsdToAtomic, atomicToUsd, toMoney, formatUsdDisplay, isPaidPrice } from './money';
import { CliError } from './errors';

describe('parseUsdToAtomic', () => {
  it.each([
    ['0', '0'],
    ['0.25', '250000'],
    ['5', '5000000'],
    ['1.000000', '1000000'],
    ['0.000001', '1'],
    ['12.5', '12500000'],
  ])('%s USD -> %s atomic', (input, expected) => {
    expect(parseUsdToAtomic(input)).toBe(expected);
  });

  it.each(['-1', 'abc', '0.1234567', '', ' ', '1.', '.5', '1e3'])('rejects %j', (bad) => {
    expect(() => parseUsdToAtomic(bad)).toThrow(CliError);
  });

  it('rejects with the USAGE code', () => {
    let caught: unknown;
    try {
      parseUsdToAtomic('-1');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).code).toBe('USAGE');
  });
});

describe('atomicToUsd', () => {
  it.each([
    ['0', '0'],
    ['250000', '0.25'],
    ['5000000', '5'],
    ['1', '0.000001'],
    ['1000000', '1'],
  ])('%s atomic -> %s USD', (atomic, usd) => {
    expect(atomicToUsd(atomic)).toBe(usd);
  });

  it('round-trips USD -> atomic -> USD', () => {
    for (const usd of ['0', '0.25', '5', '12.5', '0.000001', '1000']) {
      expect(atomicToUsd(parseUsdToAtomic(usd))).toBe(usd);
    }
  });

  it('rejects a malformed atomic value as INTERNAL', () => {
    let caught: unknown;
    try {
      atomicToUsd('12.5');
    } catch (e) {
      caught = e;
    }
    expect((caught as CliError).code).toBe('INTERNAL');
  });
});

describe('toMoney', () => {
  it('emits both atomic and USD forms', () => {
    expect(toMoney('250000')).toEqual({ atomic: '250000', usd: '0.25' });
  });
});

// Three-valued on purpose: the caller refuses an incoherent outcome report on a
// `false`, so anything it cannot actually read has to come back `null` instead.
describe('isPaidPrice', () => {
  it.each([
    ['100000', true],
    ['1', true],
    [' 250000 ', true], // surrounding whitespace is not a malformed amount
    ['0', false],
    ['000', false],
  ])('%s -> %s', (atomic, expected) => {
    expect(isPaidPrice(atomic)).toBe(expected);
  });

  // Only the wire schema enforces ATOMIC_RE; the local store types `price` as a
  // bare string, so these can reach the helper from a corrupt or edited file. A
  // digit anywhere in the string must not be enough to call it paid.
  it.each([['-1'], ['0.1'], ['abc1'], ['1e6'], [''], ['   '], ['1'.repeat(40)]])(
    '%s is unknown, not paid and not free',
    (atomic) => {
      expect(isPaidPrice(atomic)).toBeNull();
    },
  );

  it('never throws on malformed input', () => {
    expect(() => isPaidPrice('💸')).not.toThrow();
  });
});

describe('formatUsdDisplay', () => {
  it.each([
    ['100000', '0.10'],
    ['5000000', '5.00'],
    ['0', '0.00'],
    ['250000', '0.25'],
    ['1', '0.000001'], // sub-cent precision is kept, never rounded to 0.00
    ['12500000', '12.50'],
  ])('%s atomic -> $%s canonical', (atomic, usd) => {
    expect(formatUsdDisplay(atomic)).toBe(usd);
  });
});
