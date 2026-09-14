import { describe, expect, it } from 'vitest';
import { digest, isKey, shortKey } from '../src/hash.ts';

describe('digest', () => {
  it('is stable for the same parts', () => {
    expect(digest(['acc_1', '500', 'debit'])).toBe(digest(['acc_1', '500', 'debit']));
  });

  it('gives a 32-character hex key', () => {
    const key = digest(['acc_1', '500']);
    expect(key).toHaveLength(32);
    expect(isKey(key)).toBe(true);
  });

  it('separates the parts, so a shifted boundary is a different key', () => {
    expect(digest(['ab', 'c'])).not.toBe(digest(['a', 'bc']));
  });

  it('takes a salt', () => {
    expect(digest(['x'], { salt: 'entries' })).not.toBe(digest(['x']));
  });
});

describe('isKey', () => {
  it('rejects something that is not one of ours', () => {
    expect(isKey('not-a-key')).toBe(false);
    expect(isKey('ABCDEF0123456789abcdef0123456789')).toBe(false);
  });
});

describe('shortKey', () => {
  it('is the first eight characters', () => {
    const key = digest(['x']);
    expect(shortKey(key)).toBe(key.slice(0, 8));
  });
});
