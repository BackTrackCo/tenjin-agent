import { describe, it, expect } from 'vitest';
import pkg from '../../package.json';
import {
  CALLER_USER_AGENT_ENV,
  TENJIN_PRODUCT,
  TENJIN_USER_AGENT,
  WEBSEARCH_HOOK_PRODUCT,
  WEBSEARCH_HOOK_USER_AGENT,
  composeUserAgent,
} from './client-meta';

/**
 * These assertions pin the STRING, not the constant: every other test in the
 * suite compares TENJIN_USER_AGENT to itself, so a shape change (dropping the
 * space before the comment, renaming the product) would keep the whole suite
 * green while the server silently attributes the CLI as `none`. The origin in
 * the comment stays a literal here for the same reason: the source reads it from
 * PRODUCTION_ORIGIN, so this file is the second, independent copy that makes an
 * origin flip a deliberate two-file diff rather than one line.
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

/**
 * The WebSearch hook's own identity, pinned as a literal because it is the name
 * the server stores in `client_name` and anything classifying hook demand keys
 * on, across a repo boundary that no type checks.
 */
describe('WEBSEARCH_HOOK_USER_AGENT', () => {
  it('is the package version behind a `tenjin-websearch-hook` product token', () => {
    const [product, ...rest] = WEBSEARCH_HOOK_USER_AGENT.split(' ');
    expect(product).toBe(`tenjin-websearch-hook/${pkg.version}`);
    expect(rest.join(' ')).toBe('(+https://tenjin.blog)');
  });

  it("parses to the hook's attribution label under the server's product regex", () => {
    const match = FIRST_PRODUCT_RE.exec(WEBSEARCH_HOOK_USER_AGENT);
    expect(match?.[1]).toBe('tenjin-websearch-hook');
    expect(match?.[2]).toBe(pkg.version);
  });

  it('is a different client from a deliberate `tenjin search`', () => {
    expect(FIRST_PRODUCT_RE.exec(TENJIN_USER_AGENT)?.[1]).toBe('tenjin-cli');
    expect(WEBSEARCH_HOOK_USER_AGENT.length).toBeLessThanOrEqual(USER_AGENT_MAX_LENGTH);
  });
});

/**
 * The caller handoff (spec: user-agent-telemetry-and-client-attribution.md,
 * "Composition contract"). An empty env object is passed everywhere the handoff
 * is meant to be absent, so a real `TENJIN_CALLER_USER_AGENT` on the developer's
 * machine cannot decide whether these pass.
 */
describe('composeUserAgent', () => {
  const NO_ENV: NodeJS.ProcessEnv = {};

  it('sends the CLI identity alone when no caller hands one off', () => {
    expect(composeUserAgent({ env: NO_ENV })).toBe(TENJIN_USER_AGENT);
    expect(composeUserAgent({ caller: '', env: NO_ENV })).toBe(TENJIN_USER_AGENT);
    expect(composeUserAgent({ caller: '   ', env: NO_ENV })).toBe(TENJIN_USER_AGENT);
  });

  it('keeps the caller products, in order, behind the Tenjin product', () => {
    const composed = composeUserAgent({ caller: 'codex/1.2.0 node/24.4.0', env: NO_ENV });
    expect(composed).toBe(`${TENJIN_PRODUCT} codex/1.2.0 node/24.4.0 (+https://tenjin.blog)`);
    // Attribution still resolves to the CLI: the server reads the FIRST product.
    expect(FIRST_PRODUCT_RE.exec(composed)?.[1]).toBe('tenjin-cli');
  });

  it('preserves each caller product byte for byte', () => {
    const caller = "weird-Agent_9/2.0.0-rc.1+build.7 a~b|c/1.0 !#$%&'*.^`/x";
    const composed = composeUserAgent({ caller, env: NO_ENV });
    expect(composed).toContain(` ${caller} `);
  });

  it('reads the env when no programmatic value is given, and the value wins when it is', () => {
    const env: NodeJS.ProcessEnv = { [CALLER_USER_AGENT_ENV]: 'launcher/3.0' };
    expect(composeUserAgent({ env })).toBe(`${TENJIN_PRODUCT} launcher/3.0 (+https://tenjin.blog)`);
    expect(composeUserAgent({ caller: 'embedder/1.0', env })).toBe(
      `${TENJIN_PRODUCT} embedder/1.0 (+https://tenjin.blog)`,
    );
  });

  it('is idempotent: re-composing an already-composed field changes nothing', () => {
    const once = composeUserAgent({ caller: 'codex/1.2.0', env: NO_ENV });
    // What a retry, a nested helper, or an agent re-exporting the env it was
    // handed does. A naive prepend would grow a second `tenjin-cli` token here.
    expect(composeUserAgent({ caller: once, env: NO_ENV })).toBe(once);
    expect(composeUserAgent({ caller: TENJIN_USER_AGENT, env: NO_ENV })).toBe(TENJIN_USER_AGENT);
    expect(once.match(/tenjin-cli/g)).toHaveLength(1);
  });

  it('drops the sender product a caller carries, whatever its version or casing', () => {
    // A stale copy of our own product must not survive as a second, and wrong,
    // identity for the same request.
    expect(composeUserAgent({ caller: 'tenjin-cli/0.0.1 codex/1.2.0', env: NO_ENV })).toBe(
      `${TENJIN_PRODUCT} codex/1.2.0 (+https://tenjin.blog)`,
    );
    expect(composeUserAgent({ caller: 'Tenjin-CLI/0.0.1 codex/1.2.0', env: NO_ENV })).toBe(
      `${TENJIN_PRODUCT} codex/1.2.0 (+https://tenjin.blog)`,
    );
    expect(composeUserAgent({ caller: 'tenjin-cli', env: NO_ENV })).toBe(TENJIN_USER_AGENT);
  });

  it('leads with the product it is given, and drops both of ours from a handoff', () => {
    const product = WEBSEARCH_HOOK_PRODUCT;
    expect(composeUserAgent({ env: NO_ENV, product })).toBe(WEBSEARCH_HOOK_USER_AGENT);
    // Either identity handed back to us is a stale copy, never a second product.
    expect(
      composeUserAgent({
        caller: 'tenjin-cli/0.0.1 tenjin-websearch-hook/0.0.1 codex/1',
        env: NO_ENV,
        product,
      }),
    ).toBe(`${product} codex/1 (+https://tenjin.blog)`);
    expect(composeUserAgent({ caller: 'tenjin-websearch-hook/0.0.1 codex/1', env: NO_ENV })).toBe(
      `${TENJIN_PRODUCT} codex/1 (+https://tenjin.blog)`,
    );
  });

  it('omits a handoff that is not a bare product sequence, rather than sanitizing it', () => {
    const rejected = [
      'codex/1.2.0 (user@host)', // a comment, where a machine identifier hides
      'codex/1.2.0 wallet=0xd605b974', // free text
      'agent/1.0 for alice@example.com',
      'codex/1.2.0\nx-injected: 1', // CR/LF, outside printable ASCII
      'codex/1.2.0 émoji', // non-ASCII
      'codex/1.2.0; session=abc',
    ];
    for (const caller of rejected) {
      expect(composeUserAgent({ caller, env: NO_ENV })).toBe(TENJIN_USER_AGENT);
    }
  });

  it('omits an overlong handoff whole instead of truncating a product into a false identity', () => {
    const caller = `${'a'.repeat(USER_AGENT_MAX_LENGTH)}/1.0`;
    const composed = composeUserAgent({ caller, env: NO_ENV });
    expect(composed).toBe(TENJIN_USER_AGENT);
    expect(FIRST_PRODUCT_RE.exec(composed)?.[2]).toBe(pkg.version);
  });

  /**
   * The bound is inclusive, pinned one character either side. The test file
   * keeps its own copy of 512, so loosening the production constant fails here
   * rather than shipping a field the server discards whole.
   */
  it.each([
    [USER_AGENT_MAX_LENGTH - 1, true],
    [USER_AGENT_MAX_LENGTH, true],
    [USER_AGENT_MAX_LENGTH + 1, false],
  ])('composes to %i characters: kept = %s', (length, kept) => {
    const overhead = `${TENJIN_USER_AGENT} `.length;
    const caller = `a/${'x'.repeat(length - overhead - 2)}`;
    const composed = composeUserAgent({ caller, env: NO_ENV });
    expect(composed).toBe(
      kept ? `${TENJIN_PRODUCT} ${caller} (+https://tenjin.blog)` : TENJIN_USER_AGENT,
    );
    if (kept) expect(composed.length).toBe(length);
  });

  it('keeps every composition inside the bounds the server parses', () => {
    const composed = composeUserAgent({ caller: 'codex/1.2.0 node/24.4.0', env: NO_ENV });
    expect(composed.length).toBeLessThanOrEqual(USER_AGENT_MAX_LENGTH);
    expect(composed).toMatch(/^[\x20-\x7e]+$/);
  });
});
