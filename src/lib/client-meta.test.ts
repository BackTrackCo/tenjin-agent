import { describe, it, expect } from 'vitest';
import pkg from '../../package.json';
import { TENJIN_USER_AGENT } from './client-meta';

/**
 * These assertions pin the STRING, not the constant: every other test in the
 * suite compares TENJIN_USER_AGENT to itself, so a shape change (dropping the
 * space before the comment, renaming the product) would keep the whole suite
 * green while the server silently attributes the CLI as `none`.
 */

/**
 * A copy of the server's `FIRST_PRODUCT_RE` (tenjin `lib/client-product.ts`),
 * which is the consumer of this string: an RFC 9110 product token, an optional
 * `/version`, and then whitespace or end of string. Copied rather than imported
 * because that repo is closed-source and not a dependency of this CLI; the value
 * of the check is that a change here fails HERE rather than in production
 * telemetry.
 */
const PRODUCT_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const FIRST_PRODUCT_RE = new RegExp(`^(${PRODUCT_TOKEN})(?:/(${PRODUCT_TOKEN}))?(?:\\s|$)`);
/** The server's bound; a longer UA is discarded whole, not truncated. */
const USER_AGENT_MAX_LENGTH = 512;

describe('TENJIN_USER_AGENT', () => {
  it('is the package version behind a `tenjin-cli` product token and nothing else', () => {
    const [product, ...rest] = TENJIN_USER_AGENT.split(' ');
    expect(product).toBe(`tenjin-cli/${pkg.version}`);
    expect(rest.join(' ')).toBe('(+https://tenjin.blog)');
  });

  it("parses to the `tenjin-cli` attribution label under the server's product regex", () => {
    const match = FIRST_PRODUCT_RE.exec(TENJIN_USER_AGENT);
    expect(match?.[1]).toBe('tenjin-cli');
    expect(match?.[2]).toBe(pkg.version);
  });

  it('stays inside the bounds the server accepts: printable ASCII, under 512 chars', () => {
    expect(TENJIN_USER_AGENT.length).toBeLessThanOrEqual(USER_AGENT_MAX_LENGTH);
    expect(TENJIN_USER_AGENT).toMatch(/^[\x20-\x7e]+$/);
  });

  it('separates the product token from the comment, which is what the regex needs', () => {
    // The failure this pins: `tenjin-cli/1.2.3(+https://tenjin.blog)` still looks
    // right to a human and to every other test, but `(` is outside the product
    // token and no whitespace follows, so the regex misses and attribution for
    // the entire CLI drops to `none`.
    const collapsed = TENJIN_USER_AGENT.replace(' (', '(');
    expect(FIRST_PRODUCT_RE.exec(collapsed)).toBeNull();
  });
});
