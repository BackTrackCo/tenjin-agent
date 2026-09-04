import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { authorized, bearerOf, isJson, tokenMatches } from './auth';

// Only `headers` is read; the cast keeps the fakes honest about that.
function req(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

const TOKEN = 'a'.repeat(64);

describe('tokenMatches', () => {
  it('accepts the exact token', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
  });

  it('rejects a same-length different token', () => {
    expect(tokenMatches('b'.repeat(64), TOKEN)).toBe(false);
  });

  // `timingSafeEqual` throws on unequal buffer lengths; a short bad token must
  // be a plain 401, not an uncaught exception in the daemon.
  it('rejects a different-length token without throwing', () => {
    expect(() => tokenMatches('short', TOKEN)).not.toThrow();
    expect(tokenMatches('short', TOKEN)).toBe(false);
    expect(tokenMatches('', TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN + 'x', TOKEN)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });
});

describe('bearerOf', () => {
  it('parses "Bearer x"', () => {
    expect(bearerOf(req({ authorization: 'Bearer abc' }))).toBe('abc');
  });

  it('parses a lowercase scheme', () => {
    expect(bearerOf(req({ authorization: 'bearer abc' }))).toBe('abc');
  });

  it('tolerates surrounding whitespace', () => {
    expect(bearerOf(req({ authorization: '  Bearer   abc  ' }))).toBe('abc');
  });

  it('rejects other schemes', () => {
    expect(bearerOf(req({ authorization: 'Basic abc' }))).toBeUndefined();
  });

  it('rejects a bare scheme with no token', () => {
    expect(bearerOf(req({ authorization: 'Bearer' }))).toBeUndefined();
    expect(bearerOf(req({ authorization: 'Bearer ' }))).toBeUndefined();
  });

  it('rejects a missing header', () => {
    expect(bearerOf(req({}))).toBeUndefined();
    expect(bearerOf(req({ authorization: undefined }))).toBeUndefined();
  });
});

describe('isJson', () => {
  it('accepts application/json', () => {
    expect(isJson(req({ 'content-type': 'application/json' }))).toBe(true);
  });

  it('accepts application/json with a charset parameter', () => {
    expect(isJson(req({ 'content-type': 'application/json; charset=utf-8' }))).toBe(true);
    expect(isJson(req({ 'content-type': 'Application/JSON; charset=utf-8' }))).toBe(true);
  });

  it('rejects text/plain', () => {
    expect(isJson(req({ 'content-type': 'text/plain' }))).toBe(false);
  });

  // A browser form can send this without a preflight; it must not pass.
  it('rejects form encodings and json lookalikes', () => {
    expect(isJson(req({ 'content-type': 'application/x-www-form-urlencoded' }))).toBe(false);
    expect(isJson(req({ 'content-type': 'application/jsonp' }))).toBe(false);
    expect(isJson(req({ 'content-type': 'text/application/json' }))).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(isJson(req({}))).toBe(false);
  });
});

describe('authorized', () => {
  const good = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  it('passes when both the bearer and the content-type are right', () => {
    expect(authorized(req(good), TOKEN)).toBe(true);
  });

  it('fails on a wrong token even with json content-type', () => {
    expect(authorized(req({ ...good, authorization: 'Bearer nope' }), TOKEN)).toBe(false);
  });

  it('fails on a missing bearer', () => {
    expect(authorized(req({ 'content-type': 'application/json' }), TOKEN)).toBe(false);
  });

  it('fails on a non-json content-type even with the right token', () => {
    expect(authorized(req({ ...good, 'content-type': 'text/plain' }), TOKEN)).toBe(false);
  });

  it('fails on a missing content-type', () => {
    expect(authorized(req({ authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(false);
  });
});
