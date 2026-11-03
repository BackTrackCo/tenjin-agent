import { describe, it, expect } from 'vitest';
import pkg from '../../package.json';
import {
  PRODUCTION_HOST,
  PRODUCTION_ORIGIN,
  isSameDeployment,
  knownDeploymentOrigins,
} from './production-origin';
import { CONFIG_DEFAULTS } from './config';
import { TENJIN_USER_AGENT } from './client-meta';

/**
 * Every module that ships the production origin reads it from here. These pin
 * the copies a flip could leave behind: the config default, the User-Agent, and
 * the package homepage, which is JSON and cannot import the constant.
 */
describe('PRODUCTION_ORIGIN', () => {
  it('is a bare https origin, and the host is derived from it', () => {
    const url = new URL(PRODUCTION_ORIGIN);
    expect(url.protocol).toBe('https:');
    // A path, trailing slash, query, or port would survive every consumer here
    // and then break the ones that concatenate (`${origin}/api/fund/link`).
    expect(PRODUCTION_ORIGIN).toBe(url.origin);
    expect(PRODUCTION_HOST).toBe(url.host);
  });

  it('is the shipped config default for baseUrl', () => {
    expect(CONFIG_DEFAULTS.baseUrl).toBe(PRODUCTION_ORIGIN);
  });

  it('is the origin in the User-Agent comment', () => {
    expect(TENJIN_USER_AGENT.endsWith(` (+${PRODUCTION_ORIGIN})`)).toBe(true);
  });

  it('is the origin of the homepage npm shows on the package page', () => {
    // JSON, so it cannot import the constant; pin it here instead. A stale
    // homepage is the one copy of the origin a published release advertises to
    // people who never run the CLI.
    expect(new URL(pkg.homepage).origin).toBe(PRODUCTION_ORIGIN);
  });
});

/**
 * The alias set exists so an installed CLI survives the cutover, and it is also
 * the widest place a signed credential may now be sent. Both halves get pinned:
 * a sibling origin is the same deployment, and everything else still is not.
 */
describe('isSameDeployment', () => {
  const others = knownDeploymentOrigins().filter((o) => o !== PRODUCTION_ORIGIN);

  /**
   * Exact, not `toContain`. This set ships baked into every released CLI, so it
   * is live on machines the operator no longer controls until each one updates,
   * and whoever holds a member origin receives wallet-signed credentials from a
   * CLI configured on the sibling. Adding a member, or failing to remove one
   * that was sold or repointed, has to be a line a human wrote on purpose in a
   * reviewed diff.
   * The expected value is written out here rather than read from the module, for
   * the same reason. Removal runbook: docs/safety-model.md.
   */
  it('is exactly the two deployment origins, and nothing has crept in', () => {
    expect(knownDeploymentOrigins()).toEqual([PRODUCTION_ORIGIN, 'https://tenjin.blog']);
  });

  it('lists the production origin and at least one alias for the cutover', () => {
    expect(knownDeploymentOrigins()).toContain(PRODUCTION_ORIGIN);
    // Without a second member the set is a no-op and tenjin#738 stays broken.
    expect(others.length).toBeGreaterThan(0);
    for (const origin of knownDeploymentOrigins()) {
      expect(origin).toBe(new URL(origin).origin);
      expect(new URL(origin).protocol).toBe('https:');
    }
  });

  it('aliases the deployment origins to each other, in both directions', () => {
    for (const other of others) {
      expect(isSameDeployment(PRODUCTION_ORIGIN, other)).toBe(true);
      expect(isSameDeployment(other, PRODUCTION_ORIGIN)).toBe(true);
    }
  });

  it('gives an origin outside the set no aliasing in either position', () => {
    for (const other of others) {
      expect(isSameDeployment('https://evil.example', other)).toBe(false);
      expect(isSameDeployment(other, 'https://evil.example')).toBe(false);
    }
    // A self-hosted deployment is aliased to nothing but itself.
    expect(isSameDeployment('https://notes.internal', PRODUCTION_ORIGIN)).toBe(false);
    expect(isSameDeployment('https://notes.internal', 'https://notes.internal')).toBe(true);
  });

  it('does not alias across scheme or port, which are part of the origin', () => {
    const downgraded = PRODUCTION_ORIGIN.replace('https://', 'http://');
    const ported = `${PRODUCTION_ORIGIN}:8443`;
    for (const other of others) {
      expect(isSameDeployment(downgraded, other)).toBe(false);
      expect(isSameDeployment(ported, other)).toBe(false);
    }
  });
});
