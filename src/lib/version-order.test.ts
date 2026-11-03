import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
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

/**
 * THE RELEASE CONTRACT. Every installed runtime (alpha.32 on) reads npm's
 * `latest` tag through parseVersion, so the version this repo publishes must be
 * one it accepts. Anything else is not "older", it is unreadable: each
 * machine's daily `tenjin update` throws on it, installs refuse it, and the
 * build itself can never update again. The version PR's CI and the publish
 * job's check suite both run this file, which is what stops a hand-edited
 * version PR (`0.2.0-beta.1`, `0.2.0-rc.1`) before it reaches `latest`.
 *
 * Widening VERSION_RE in the same release does not help: the machines reading
 * `latest` run the code they already have. So the version is also held to
 * SHIPPED_IN_FIELD, a frozen copy of the grammar alpha.32 shipped: a PR that
 * widens VERSION_RE and moves the version to the new shape passes the live
 * check, and fails this one. Widen it only once a build that reads the wider
 * grammar has reached users.
 */
const SHIPPED_IN_FIELD = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/;

describe('the version this repo publishes', () => {
  it('is one every installed runtime can read', () => {
    expect(parseVersion(pkg.version), pkg.version).not.toBeNull();
    expect(pkg.version).toMatch(SHIPPED_IN_FIELD);
  });
});
