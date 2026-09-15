import { describe, it, expect } from 'vitest';
import { nativeSessionOf, readActor, sessionKey } from './session';

// Covered through the callers too, but pinned here because they all read ONE
// copy: a change to precedence moves what a sweep closes and what the hook
// raises at once, and no caller's tests would name this file.
describe('readActor', () => {
  it('prefers the operator override, taken as the whole stored key', () => {
    const env = { TENJIN_SESSION_ID: 'operator', CLAUDE_CODE_SESSION_ID: 'harness' };
    expect(readActor(env)).toEqual({ session: 'operator' });
  });

  it('namespaces the Claude session and names no child', () => {
    expect(readActor({ CLAUDE_CODE_SESSION_ID: 'harness' })).toEqual({ session: 'claude:harness' });
    expect(readActor({})).toBeUndefined();
    // Whitespace is not an id: it would scope a sweep to a session nothing stamps.
    expect(readActor({ TENJIN_SESSION_ID: '   ' })).toBeUndefined();
    expect(readActor({ TENJIN_SESSION_ID: '  ', CLAUDE_CODE_SESSION_ID: 'harness' })).toEqual({
      session: 'claude:harness',
    });
  });

  it('a Codex root thread is the lead: the thread id equals the session id', () => {
    expect(readActor({ CODEX_SESSION_ID: 's-1', CODEX_THREAD_ID: 's-1' })).toEqual({
      session: 'codex:s-1',
    });
    expect(readActor({ CODEX_SESSION_ID: 's-1' })).toEqual({ session: 'codex:s-1' });
  });

  it('a distinct Codex thread is the child, filed under the root session', () => {
    expect(readActor({ CODEX_SESSION_ID: 's-1', CODEX_THREAD_ID: 't-2' })).toEqual({
      session: 'codex:s-1',
      agent: 't-2',
    });
  });

  it('a Codex thread id this build cannot file a child under names no child', () => {
    expect(readActor({ CODEX_SESSION_ID: 's-1', CODEX_THREAD_ID: 'bad id' })).toEqual({
      session: 'codex:s-1',
    });
  });

  it('Claude wins over Codex when both are exported, and neither is read raw', () => {
    expect(readActor({ CLAUDE_CODE_SESSION_ID: 'c', CODEX_SESSION_ID: 'x' })).toEqual({
      session: 'claude:c',
    });
  });
});

describe('sessionKey', () => {
  it('keeps equal native ids on two harnesses apart', () => {
    expect(sessionKey('claude', 'abc')).not.toBe(sessionKey('codex', 'abc'));
    expect(nativeSessionOf(sessionKey('codex', 'abc'))).toBe('abc');
    expect(nativeSessionOf('abc')).toBe('abc');
    // A native id may itself carry a colon; only the first one is the prefix.
    expect(nativeSessionOf(sessionKey('claude', 'a:b'))).toBe('a:b');
  });
});
