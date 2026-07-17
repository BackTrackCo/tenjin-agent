import { describe, it, expect } from 'vitest';
import { parseUsdToAtomic, atomicToUsd, toMoney } from './money';
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
