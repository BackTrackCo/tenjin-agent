import { describe, expect, it } from 'vitest';
import { decodeEvent } from './hooks';
import { eventFromToolInput, HOOK_KINDS, hookToolInput } from './hook-tool';

/**
 * The `mcp_tool` entry's `input` and its way back: Claude Code substitutes
 * each `${field}` with the field's text (objects and booleans as JSON, absent
 * fields as an empty string), and the event the handlers read comes back out.
 */

describe('hookToolInput', () => {
  it('names the leg and substitutes only the fields that leg reads', () => {
    expect(hookToolInput('prompt')).toEqual({
      kind: 'prompt',
      hook_event_name: '${hook_event_name}',
      session_id: '${session_id}',
      transcript_path: '${transcript_path}',
      cwd: '${cwd}',
      prompt: '${prompt}',
    });
    expect(Object.keys(hookToolInput('shortfall'))).toEqual(
      expect.arrayContaining(['tool_input', 'tool_response', 'error', 'is_interrupt']),
    );
    expect(Object.keys(hookToolInput('native'))).not.toContain('tool_response');
    for (const kind of HOOK_KINDS) expect(hookToolInput(kind).kind).toBe(kind);
  });
});

describe('eventFromToolInput', () => {
  it('parses the JSON fields back, drops empty ones, and the handlers decode the event', () => {
    const event = eventFromToolInput({
      kind: 'shortfall',
      hook_event_name: 'PostToolUseFailure',
      session_id: 'sess-1',
      transcript_path: '',
      cwd: '/work',
      tool_name: 'WebFetch',
      tool_input: JSON.stringify({ url: 'https://x.test/a' }),
      tool_use_id: 'toolu_1',
      agent_id: '',
      agent_type: '',
      tool_response: '',
      error: 'getaddrinfo ENOTFOUND x.test',
      is_interrupt: 'false',
    });
    expect(event).toEqual({
      hook_event_name: 'PostToolUseFailure',
      session_id: 'sess-1',
      cwd: '/work',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://x.test/a' },
      tool_use_id: 'toolu_1',
      error: 'getaddrinfo ENOTFOUND x.test',
      is_interrupt: false,
    });
    expect(decodeEvent(event)).toMatchObject({ kind: 'shortfall', tool: 'WebFetch' });
  });

  it('keeps a JSON field that does not parse as the string it is', () => {
    expect(eventFromToolInput({ tool_response: 'plain text' })).toEqual({
      tool_response: 'plain text',
    });
  });

  it('ignores fields no leg sends', () => {
    expect(eventFromToolInput({ session_id: 's', extra: 'x', kind: 'prompt' })).toEqual({
      session_id: 's',
    });
  });
});
