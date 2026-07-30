import { describe, expect, it } from 'vitest';
import { originOf, tryOriginOf, trimSlash } from './url';

describe('trimSlash', () => {
  it('drops trailing slashes so `${base}/path` never doubles one', () => {
    expect(trimSlash('https://tenjin.blog/')).toBe('https://tenjin.blog');
    expect(trimSlash('https://tenjin.blog///')).toBe('https://tenjin.blog');
    expect(trimSlash('https://tenjin.blog')).toBe('https://tenjin.blog');
  });
});

/**
 * This value binds a wallet-derived credential to one deployment, so the only
 * property that matters is that two different hosts never compare equal.
 */
describe('tryOriginOf', () => {
  it('returns scheme://host[:port], dropping the default port and the path', () => {
    expect(tryOriginOf('https://tenjin.blog/api/read/iris/slug')).toBe('https://tenjin.blog');
    expect(tryOriginOf('https://tenjin.blog:443/x')).toBe('https://tenjin.blog');
    expect(tryOriginOf('http://127.0.0.1:8799/x?y=1')).toBe('http://127.0.0.1:8799');
  });

  // `new URL(url).origin` is the opaque string "null" for every non-special
  // scheme, so a bare `.origin` makes two unrelated hosts compare EQUAL — the
  // exact equal-comparing sentinel this predicate exists to avoid.
  it('rejects non-http schemes instead of collapsing them to the "null" origin', () => {
    for (const url of [
      'foo://tenjin.blog',
      'bar://evil.example',
      'file:///etc/passwd',
      'data:text/plain,x',
      'javascript:alert(1)',
      'ftp://tenjin.blog',
    ]) {
      expect(tryOriginOf(url), url).toBeNull();
    }
    // The pair that motivated this: same opaque origin, different hosts.
    expect(new URL('foo://tenjin.blog').origin).toBe(new URL('bar://evil.example').origin);
    expect(tryOriginOf('foo://tenjin.blog')).toBe(tryOriginOf('bar://evil.example')); // both null
    // ...and null is never usable as an origin, so nothing can be presented to it.
    expect(tryOriginOf('foo://tenjin.blog')).toBeNull();
  });

  it('returns null on anything unparseable rather than throwing', () => {
    for (const url of ['tenjin.blog', '', '   ', 'https://', '://x']) {
      expect(tryOriginOf(url), url).toBeNull();
    }
  });

  it('distinguishes hosts that differ only in scheme, port, or suffix', () => {
    const base = tryOriginOf('https://tenjin.blog');
    for (const other of [
      'http://tenjin.blog',
      'https://tenjin.blog:8443',
      'https://tenjin.blog.evil.example',
      'https://evil.example',
    ]) {
      expect(tryOriginOf(other), other).not.toBe(base);
    }
  });
});

describe('originOf', () => {
  it('is tryOriginOf for callers that cannot proceed without one', () => {
    expect(originOf('https://tenjin.blog/x')).toBe('https://tenjin.blog');
  });

  it('throws USAGE rather than returning a sentinel two bad values would share', () => {
    for (const url of ['tenjin.blog', 'foo://tenjin.blog', '']) {
      expect(() => originOf(url), url).toThrow(/Invalid base URL/);
    }
  });
});
