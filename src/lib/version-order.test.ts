import { describe, expect, it } from 'vitest';
import { isNewer as reexported } from './update-check';
import { isNewer, parseVersion } from './version-order';

describe('parseVersion', () => {
  it('reads a release and an alpha, and nothing else this package never published', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, alpha: null });
    expect(parseVersion('0.1.0-alpha.32')).toEqual({ major: 0, minor: 1, patch: 0, alpha: 32 });
    for (const junk of ['', 'v1.2.3', '1.2', '1.2.3-beta.1', '1.2.3-alpha', '../1.2.3', '1.2.3 ']) {
      expect(parseVersion(junk), junk).toBeNull();
    }
  });
});

describe('isNewer', () => {
  it.each([
    ['0.1.0-alpha.11', '0.1.0-alpha.10', true],
    ['0.1.0-alpha.10', '0.1.0-alpha.11', false],
    ['0.1.0-alpha.10', '0.1.0-alpha.10', false],
    ['0.1.0', '0.1.0-alpha.99', true],
    ['0.1.0-alpha.99', '0.1.0', false],
    ['0.2.0-alpha.1', '0.1.9', true],
    ['1.0.0', '0.99.99', true],
    ['0.1.10', '0.1.9', true],
  ])('%s over %s is %s', (candidate, current, expected) => {
    expect(isNewer(candidate, current)).toBe(expected);
  });

  it('loses every comparison where either side does not parse', () => {
    expect(isNewer('not-a-version', '0.1.0')).toBe(false);
    expect(isNewer('0.2.0', 'not-a-version')).toBe(false);
    expect(isNewer('0.2.0-beta.1', '0.1.0')).toBe(false);
  });

  it('is the one update-check re-exports', () => {
    expect(reexported).toBe(isNewer);
  });
});
