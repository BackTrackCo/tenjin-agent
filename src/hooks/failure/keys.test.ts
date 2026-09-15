import { describe, expect, it } from 'vitest';
import { POST_KEY_MAX_CHARS } from '../../lib/posts-api';
import { KEY_MAX_CHARS, failureKeyFingerprints, failureQuestionKey, testKey } from './keys';

/**
 * The two key formats the arm writes and the CLI reads back: the readable test
 * key, inside the server's bound, and the composed question key, which has to
 * survive a test name with any character in it.
 */

describe('testKey', () => {
  it('is the test name behind `test:`', () => {
    expect(testKey('src/a.test.ts > suite > one')).toBe('test:src/a.test.ts > suite > one');
  });

  it("stays inside the server's bound, the same one publish enforces", () => {
    expect(KEY_MAX_CHARS).toBe(POST_KEY_MAX_CHARS);
    const long = 'src/a.test.ts > ' + 'x'.repeat(400);
    const key = testKey(long);
    expect(key).toHaveLength(KEY_MAX_CHARS);
    expect(key).toMatch(/^test:src\/a\.test\.ts > x+#[0-9a-f]{16}$/);
    // The same name keys the same on the ask's side; a different one does not.
    expect(testKey(long)).toBe(key);
    expect(testKey(long + 'y')).not.toBe(key);
  });

  it('never cuts a surrogate pair in half', () => {
    // 'test:' + 'a.ts > ' is 12 units; 170 more puts the emoji's high half at
    // the last unit the head keeps.
    const key = testKey('a.ts > ' + 'x'.repeat(170) + '😀'.repeat(20));
    expect(key.length).toBeLessThanOrEqual(KEY_MAX_CHARS);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(key)).toBe(false);
  });
});

describe('the composed question key', () => {
  it('round-trips test names that carry `|`, `>` and quotes', () => {
    const keys = [testKey('a.test.ts > s > "x" | y'), testKey("b.test.ts > it's > z")];
    const composed = failureQuestionKey({ keys, lineKey: 'f'.repeat(32) });
    expect(failureKeyFingerprints(composed)).toEqual(keys);
  });

  it('drops the line hash on the way back, and is empty with nothing to compose', () => {
    expect(
      failureKeyFingerprints(failureQuestionKey({ keys: [], lineKey: 'f'.repeat(32) })),
    ).toEqual([]);
    expect(failureQuestionKey({ keys: [] })).toBe('');
  });

  it('reads no keys out of a row written before #350', () => {
    expect(failureKeyFingerprints('sig_v1:aaaabbbbccccdddd|line:' + 'f'.repeat(32))).toEqual([]);
  });
});
