import { describe, it, expect } from 'vitest';
import { ownedByThisSession, readSessionId } from './session';

// Covered through the callers too, but pinned here because both read ONE copy:
// a change to precedence or to the unstamped rule moves what a sweep closes and
// what the hook raises at once, and neither caller's tests would name this file.
describe('readSessionId', () => {
  it('prefers the operator override over the harness value', () => {
    const env = { TENJIN_SESSION_ID: 'operator', CLAUDE_CODE_SESSION_ID: 'harness' };
    expect(readSessionId(env)).toBe('operator');
  });

  it('falls back to the harness value, and to undefined when neither is usable', () => {
    expect(readSessionId({ CLAUDE_CODE_SESSION_ID: 'harness' })).toBe('harness');
    expect(readSessionId({})).toBeUndefined();
    // Whitespace is not an id: it would scope a sweep to a session nothing stamps.
    expect(readSessionId({ TENJIN_SESSION_ID: '   ' })).toBeUndefined();
    expect(readSessionId({ TENJIN_SESSION_ID: '  ', CLAUDE_CODE_SESSION_ID: 'harness' })).toBe(
      'harness',
    );
  });
});

describe('ownedByThisSession', () => {
  it('claims this session and refuses a sibling', () => {
    expect(ownedByThisSession('a', 'a')).toBe(true);
    expect(ownedByThisSession('b', 'a')).toBe(false);
  });

  // Both directions of "unknown" stay in scope, so no loop is strandable.
  it('keeps an unstamped entry, and every entry when the caller has no session', () => {
    expect(ownedByThisSession(undefined, 'a')).toBe(true);
    expect(ownedByThisSession('b', undefined)).toBe(true);
    expect(ownedByThisSession(undefined, undefined)).toBe(true);
  });
});
