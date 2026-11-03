import { describe, expect, it } from 'vitest';
import { decode, type CodexEvent, type CodexHookInput } from './codex-wire';
import UserPromptSubmit from './fixtures/harness/codex/UserPromptSubmit.json';
import PreToolUse from './fixtures/harness/codex/PreToolUse.json';
import PostToolUse from './fixtures/harness/codex/PostToolUse.json';
import PreToolUseWebrun from './fixtures/harness/codex/PreToolUse-webrun.json';
import childPreToolUse from './fixtures/harness/codex/child-PreToolUse.json';
import SessionStart from './fixtures/harness/codex/SessionStart.json';
import SessionEnd from './fixtures/harness/codex/SessionEnd.json';
import Stop from './fixtures/harness/codex/Stop.json';

/**
 * Every payload here is one the installed codex-cli 0.153.4 sent
 * (`fixtures/harness/codex/README.md`, captured 2026-09-08).
 */

const FIXTURES = { UserPromptSubmit, PreToolUse, PostToolUse } as const;

function decoded(raw: unknown, name: string): CodexHookInput {
  const input = decode(raw);
  if (input === null) throw new Error(`${name} fixture did not decode`);
  return input;
}

describe('decode', () => {
  const EXPECTED: Record<keyof typeof FIXTURES, CodexEvent> = {
    UserPromptSubmit: 'prompt',
    PreToolUse: 'tool.before',
    PostToolUse: 'tool.after',
  };

  it.each(Object.keys(FIXTURES) as (keyof typeof FIXTURES)[])(
    'maps %s onto its event and keeps the common fields',
    (name) => {
      const input = decoded(FIXTURES[name], name);
      expect(input.event).toBe(EXPECTED[name]);
      expect(input.session).toBe(FIXTURES[name].session_id);
      expect(input.cwd).toBe('/Users/dev/proj');
      expect(input.transcriptPath).toBe(FIXTURES[name].transcript_path);
      expect(input.agent).toBeUndefined();
    },
  );

  it('UserPromptSubmit carries the prompt', () => {
    expect(decoded(UserPromptSubmit, 'UserPromptSubmit').prompt).toBe(UserPromptSubmit.prompt);
  });

  it('every event the router does not read drops the fire', () => {
    for (const raw of [SessionStart, SessionEnd, Stop, { ...Stop, hook_event_name: 'PreCompact' }])
      expect(decode(raw)).toBeNull();
    expect(decode({ ...Stop, hook_event_name: 'constructor' })).toBeNull();
  });

  it('a tool call carries its name and call id, and its result text only after it ran', () => {
    expect(decoded(PreToolUse, 'PreToolUse').tool).toEqual({
      name: 'Bash',
      callId: PreToolUse.tool_use_id,
    });
    expect(decoded(PostToolUse, 'PostToolUse').tool).toEqual({
      name: 'Bash',
      callId: PostToolUse.tool_use_id,
      result: { text: 'hello-probe\n' },
    });
    expect(decoded(PreToolUseWebrun, 'webrun').tool?.name).toBe('webrun');
  });

  it('reads a list of input_text blocks as one text, and any other response as none', () => {
    const blocks = [
      { type: 'input_text', text: 'a' },
      { type: 'input_text', text: 'b' },
    ];
    expect(decode({ ...PostToolUse, tool_response: blocks })?.tool?.result).toEqual({
      text: 'a\nb',
    });
    expect(decode({ ...PostToolUse, tool_response: '' })?.tool?.result).toEqual({ text: '' });
    const rest = { ...PostToolUse } as Record<string, unknown>;
    delete rest.tool_response;
    expect(decode(rest)?.tool?.result).toBeUndefined();
    expect(
      decode({ ...PostToolUse, tool_response: { stdout: 'x' } })?.tool?.result,
    ).toBeUndefined();
  });

  it("a child's fire carries its agent_id under the root session", () => {
    expect(decoded(childPreToolUse, 'child')).toMatchObject({
      event: 'tool.before',
      agent: childPreToolUse.agent_id,
      session: childPreToolUse.session_id,
    });
  });

  describe('identity', () => {
    it.each([
      ['a space', 'agent 1'],
      ['a colon', 'agent:1'],
      ['more than 128 chars', 'a'.repeat(129)],
      ['a non-string', 42],
      ['an empty string', ''],
    ])('present-but-invalid agent_id (%s) drops the fire', (_label, id) => {
      expect(decode({ ...childPreToolUse, agent_id: id })).toBeNull();
    });

    it('a null transcript_path is simply absent', () => {
      expect(
        decode({ ...UserPromptSubmit, transcript_path: null })?.transcriptPath,
      ).toBeUndefined();
    });

    it('a missing or empty session_id drops the fire', () => {
      const rest = { ...UserPromptSubmit } as Record<string, unknown>;
      delete rest.session_id;
      expect(decode(rest)).toBeNull();
      expect(decode({ ...rest, session_id: '' })).toBeNull();
    });

    it('a non-object payload drops the fire', () => {
      for (const raw of [null, undefined, 'Stop', 0, true, [UserPromptSubmit]])
        expect(decode(raw)).toBeNull();
    });
  });
});
