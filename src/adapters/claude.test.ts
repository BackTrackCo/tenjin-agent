import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { claudeAdapter, decode, encode, registrar } from './claude';
import { EVENTS } from './types';
import type { Event, HookInput, ToolKind } from './types';
import { CLAUDE_CONTEXT_MAX } from '../hooks/constants';
import SessionStart from './fixtures/claude/SessionStart.json';
import UserPromptSubmit from './fixtures/claude/UserPromptSubmit.json';
import PreToolUse from './fixtures/claude/PreToolUse.json';
import PostToolUse from './fixtures/claude/PostToolUse.json';
import PostToolUseFailure from './fixtures/claude/PostToolUseFailure.json';
import SubagentStart from './fixtures/claude/SubagentStart.json';
import SubagentStop from './fixtures/claude/SubagentStop.json';
import Stop from './fixtures/claude/Stop.json';

const FIXTURES = {
  SessionStart,
  UserPromptSubmit,
  PreToolUse,
  PostToolUse,
  PostToolUseFailure,
  SubagentStart,
  SubagentStop,
  Stop,
} as const;

const SESSION = '6d2f0c8a-9b41-4e7a-8c3d-1f5e2a7b9c04';
const TRANSCRIPT = `/Users/dev/.claude/projects/-Users-dev-proj/${SESSION}.jsonl`;
const PROMPT_ID = '01J9X4M2K7Q8R3T5V6W7Y8Z9A0';

/** Every fixture decodes; `null` here would hide a fixture typo behind a TypeError. */
function decoded(name: keyof typeof FIXTURES): HookInput {
  const input = decode(FIXTURES[name]);
  if (input === null) throw new Error(`${name} fixture did not decode`);
  return input;
}

describe('decode', () => {
  const EXPECTED: Record<keyof typeof FIXTURES, Event> = {
    SessionStart: 'session.start',
    UserPromptSubmit: 'prompt',
    PreToolUse: 'tool.before',
    PostToolUse: 'tool.after',
    PostToolUseFailure: 'tool.after',
    SubagentStart: 'agent.start',
    SubagentStop: 'agent.stop',
    Stop: 'turn.end',
  };

  it.each(Object.keys(FIXTURES) as (keyof typeof FIXTURES)[])(
    'maps %s onto its canonical event and keeps the common fields',
    (name) => {
      const input = decoded(name);
      expect(input.harness).toBe('claude');
      expect(input.event).toBe(EXPECTED[name]);
      expect(input.native).toEqual({ event: name });
      expect(input.session).toBe(SESSION);
      expect(input.cwd).toBe('/Users/dev/proj');
      expect(input.transcript?.path).toBe(TRANSCRIPT);
      expect(input.raw).toBe(FIXTURES[name]);
    },
  );

  it('SessionStart carries source and no turn (prompt_id is absent until the first prompt)', () => {
    const input = decoded('SessionStart');
    expect(input.source).toBe('startup');
    expect(input.turn).toBeUndefined();
    expect(input.agent).toBeUndefined();
    expect(input.tool).toBeUndefined();
  });

  it('UserPromptSubmit carries the prompt and the turn from prompt_id', () => {
    const input = decoded('UserPromptSubmit');
    expect(input.turn).toBe(PROMPT_ID);
    expect(input.prompt).toBe(UserPromptSubmit.prompt);
    expect(input.tool).toBeUndefined();
  });

  it('PreToolUse decodes the tool with its kind, input and callId, and no ok', () => {
    const input = decoded('PreToolUse');
    expect(input.turn).toBe(PROMPT_ID);
    expect(input.tool).toEqual({
      name: 'WebFetch',
      kind: 'web',
      input: PreToolUse.tool_input,
      callId: PreToolUse.tool_use_id,
    });
  });

  it('PostToolUse is ok with stdout/stderr from tool_response', () => {
    const input = decoded('PostToolUse');
    expect(input.tool).toEqual({
      name: 'Bash',
      kind: 'shell',
      input: PostToolUse.tool_input,
      callId: PostToolUse.tool_use_id,
      ok: true,
      result: { stdout: PostToolUse.tool_response.stdout, stderr: '' },
    });
  });

  it('PostToolUseFailure is not ok and carries the error text', () => {
    const input = decoded('PostToolUseFailure');
    expect(input.event).toBe('tool.after');
    expect(input.tool).toEqual({
      name: 'Bash',
      kind: 'shell',
      input: PostToolUseFailure.tool_input,
      callId: PostToolUseFailure.tool_use_id,
      ok: false,
      result: { error: PostToolUseFailure.error },
      interrupted: false,
    });
  });

  it('SubagentStart names the child and its type', () => {
    const input = decoded('SubagentStart');
    expect(input.agent).toBe('a7c31e9f');
    expect(input.agentType).toBe('Explore');
    expect(input.turn).toBe(PROMPT_ID);
    expect(input.stopFuse).toBeUndefined();
  });

  it('SubagentStop carries the child transcript, last message and fuse', () => {
    const input = decoded('SubagentStop');
    expect(input.agent).toBe('a7c31e9f');
    expect(input.agentType).toBe('Explore');
    expect(input.transcript).toEqual({
      path: TRANSCRIPT,
      agentPath: SubagentStop.agent_transcript_path,
    });
    expect(input.lastMessage).toBe(SubagentStop.last_assistant_message);
    expect(input.stopFuse).toBe(false);
  });

  it('Stop carries the fuse and last message for the lead', () => {
    const input = decoded('Stop');
    expect(input.agent).toBeUndefined();
    expect(input.stopFuse).toBe(false);
    expect(input.lastMessage).toBe(Stop.last_assistant_message);
    expect(input.transcript).toEqual({ path: TRANSCRIPT });
  });

  it('reads stop_hook_active true as a tripped fuse', () => {
    expect(decode({ ...Stop, stop_hook_active: true })?.stopFuse).toBe(true);
  });

  describe('tool kind', () => {
    const KINDS: [string, ToolKind | 'other'][] = [
      ['WebSearch', 'web'],
      ['WebFetch', 'web'],
      ['Agent', 'dispatch'],
      ['Task', 'dispatch'],
      ['Bash', 'shell'],
      ['Edit', 'edit'],
      ['Write', 'edit'],
      ['MultiEdit', 'edit'],
      ['Read', 'read'],
      ['Grep', 'other'],
      ['mcp__neon__run_sql', 'other'],
      ['bash', 'other'],
    ];
    it.each(KINDS)('%s -> %s', (name, kind) => {
      const input = decode({ ...PreToolUse, tool_name: name });
      expect(input?.tool).toMatchObject({ name, kind });
    });

    it('a missing tool_name is an empty other tool with an empty input', () => {
      const rest = { ...PreToolUse } as Record<string, unknown>;
      delete rest.tool_name;
      delete rest.tool_input;
      expect(decode(rest)?.tool).toEqual({
        name: '',
        kind: 'other',
        input: {},
        callId: PreToolUse.tool_use_id,
      });
    });

    it('a non-object tool_input decodes as an empty input', () => {
      expect(decode({ ...PreToolUse, tool_input: 'ls' })?.tool?.input).toEqual({});
      expect(decode({ ...PreToolUse, tool_input: ['ls'] })?.tool?.input).toEqual({});
    });
  });

  describe('tool result', () => {
    it('keeps a string tool_response as text', () => {
      const input = decode({ ...PostToolUse, tool_name: 'Read', tool_response: 'file body' });
      expect(input?.tool).toMatchObject({ kind: 'read', ok: true, result: { text: 'file body' } });
    });

    it('keeps one text key when there is no stdout/stderr/error', () => {
      expect(decode({ ...PostToolUse, tool_response: { content: 'a' } })?.tool?.result).toEqual({
        text: 'a',
      });
      expect(decode({ ...PostToolUse, tool_response: { result: 'b' } })?.tool?.result).toEqual({
        text: 'b',
      });
    });

    it('omits the result when tool_response is absent or unreadable', () => {
      const rest = { ...PostToolUse } as Record<string, unknown>;
      delete rest.tool_response;
      expect(decode(rest)?.tool?.result).toBeUndefined();
      expect(decode({ ...rest, tool_response: 42 })?.tool?.result).toBeUndefined();
    });

    it('records an interrupted tool', () => {
      expect(decode({ ...PostToolUse, is_interrupt: true })?.tool?.interrupted).toBe(true);
    });

    it('ok is decided by the event literal, never by the response text', () => {
      const failing = { ...PostToolUse, tool_response: { stdout: '', stderr: 'FAIL: 3 tests' } };
      expect(decode(failing)?.tool?.ok).toBe(true);
      const clean = { ...PostToolUseFailure, error: '' };
      expect(decode(clean)?.tool?.ok).toBe(false);
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
      expect(decode({ ...SubagentStart, agent_id: id })).toBeNull();
    });

    it('accepts the longest valid agent_id and the allowed punctuation', () => {
      expect(decode({ ...SubagentStart, agent_id: 'a'.repeat(128) })?.agent).toBe('a'.repeat(128));
      expect(decode({ ...SubagentStart, agent_id: 'A-z_09' })?.agent).toBe('A-z_09');
    });

    it('absent or null agent_id is the lead', () => {
      const rest = { ...SubagentStart } as Record<string, unknown>;
      delete rest.agent_id;
      expect(decode(rest)?.agent).toBeUndefined();
      expect(decode({ ...rest, agent_id: null })?.agent).toBeUndefined();
    });

    it('a missing or empty session_id drops the fire', () => {
      const rest = { ...Stop } as Record<string, unknown>;
      delete rest.session_id;
      expect(decode(rest)).toBeNull();
      expect(decode({ ...rest, session_id: '' })).toBeNull();
      expect(decode({ ...rest, session_id: 7 })).toBeNull();
    });
  });

  it('an unknown hook_event_name drops the fire', () => {
    expect(decode({ ...Stop, hook_event_name: 'SessionEnd' })).toBeNull();
    expect(decode({ ...Stop, hook_event_name: 'Notification' })).toBeNull();
    expect(decode({ ...Stop, hook_event_name: 'stop' })).toBeNull();
    const rest = { ...Stop } as Record<string, unknown>;
    delete rest.hook_event_name;
    expect(decode(rest)).toBeNull();
  });

  it('a non-object payload drops the fire', () => {
    for (const raw of [null, undefined, 'Stop', 0, true, [Stop]]) expect(decode(raw)).toBeNull();
  });

  it('records an empty cwd rather than dropping the fire', () => {
    const rest = { ...Stop } as Record<string, unknown>;
    delete rest.cwd;
    expect(decode(rest)?.cwd).toBe('');
  });

  it('omits transcript when neither path is present', () => {
    const rest = { ...Stop } as Record<string, unknown>;
    delete rest.transcript_path;
    expect(decode(rest)?.transcript).toBeUndefined();
  });
});

describe('encode', () => {
  const stop = decoded('Stop');

  it('null emit is nothing to say', () => {
    expect(encode(null, stop)).toBeNull();
  });

  it('an empty context is nothing to say', () => {
    expect(encode({}, stop)).toBeNull();
    expect(encode({ context: '' }, stop)).toBeNull();
  });

  it('stamps hookEventName from the native event verbatim', () => {
    expect(encode({ context: 'hi' }, stop)).toEqual({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'hi' },
    });
    // PostToolUseFailure normalizes to tool.after but Claude wants its own name back.
    expect(encode({ context: 'hi' }, decoded('PostToolUseFailure'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'hi' },
    });
  });

  it('slices additionalContext at CLAUDE_CONTEXT_MAX', () => {
    expect(CLAUDE_CONTEXT_MAX).toBe(10_000);
    const out = encode({ context: 'x'.repeat(CLAUDE_CONTEXT_MAX + 50) }, stop) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(out.hookSpecificOutput.additionalContext).toHaveLength(CLAUDE_CONTEXT_MAX);
    const exact = encode({ context: 'y'.repeat(CLAUDE_CONTEXT_MAX) }, stop) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(exact.hookSpecificOutput.additionalContext).toHaveLength(CLAUDE_CONTEXT_MAX);
  });

  it('blocks only when the fuse is present and false', () => {
    const block = { block: { reason: 'answer the parked question first' } };
    expect(encode(block, stop)).toEqual({
      decision: 'block',
      reason: 'answer the parked question first',
    });
    expect(encode(block, { ...stop, stopFuse: true })).toBeNull();
    expect(encode(block, { ...stop, stopFuse: undefined })).toBeNull();
    expect(encode(block, decoded('UserPromptSubmit'))).toBeNull();
  });

  it('block and context travel together', () => {
    expect(encode({ context: 'ctx', block: { reason: 'r' } }, stop)).toEqual({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'ctx' },
      decision: 'block',
      reason: 'r',
    });
  });

  it('a tripped fuse keeps the context and drops only the block', () => {
    expect(encode({ context: 'ctx', block: { reason: 'r' } }, { ...stop, stopFuse: true })).toEqual(
      {
        hookSpecificOutput: { hookEventName: 'Stop', additionalContext: 'ctx' },
      },
    );
  });
});

describe('registrar', () => {
  const TARGET = {
    url: 'http://127.0.0.1:30417/hook/claude',
    token: 'tok_0123456789abcdef',
    shimPath: '/Users/dev/.tenjin/hooks/tenjin-shim.mjs',
    timeoutSeconds: 5,
  };
  const http = {
    type: 'http',
    url: TARGET.url,
    headers: { Authorization: `Bearer ${TARGET.token}` },
    timeout: 5,
  };
  const command = {
    type: 'command',
    command: `node "${TARGET.shimPath}" --harness claude`,
    timeout: 5,
  };

  it('configPath is the user settings file', () => {
    expect(registrar.configPath('/Users/dev')).toBe(join('/Users/dev', '.claude', 'settings.json'));
  });

  it('plan is the 9 http and 2 command entries of 02-redesign.md section 4', () => {
    expect(registrar.plan(TARGET)).toEqual([
      { event: 'SessionStart', matcher: 'startup|clear|compact', hooks: [command] },
      { event: 'UserPromptSubmit', hooks: [command] },
      { event: 'PreToolUse', matcher: 'WebSearch|WebFetch', hooks: [http] },
      { event: 'PreToolUse', matcher: 'Agent|Task', hooks: [http] },
      { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|Bash', hooks: [http] },
      { event: 'PostToolUse', matcher: 'Bash', hooks: [http] },
      { event: 'PostToolUse', matcher: 'Read', hooks: [http] },
      { event: 'PostToolUseFailure', matcher: 'Bash', hooks: [http] },
      { event: 'SubagentStart', hooks: [http] },
      { event: 'SubagentStop', hooks: [http] },
      { event: 'Stop', hooks: [http] },
    ]);
  });

  it('plan counts: 11 entries, 2 command, 9 http, token as a literal', () => {
    const plan = registrar.plan(TARGET) as { hooks: { type: string }[] }[];
    expect(plan).toHaveLength(11);
    const handlers = plan.flatMap((entry) => entry.hooks);
    expect(handlers.filter((h) => h.type === 'command')).toHaveLength(2);
    expect(handlers.filter((h) => h.type === 'http')).toHaveLength(9);
    const text = JSON.stringify(plan);
    expect(text).toContain(`Bearer ${TARGET.token}`);
    expect(text).not.toContain('$');
  });

  it('plan carries the timeout the installer chose', () => {
    const plan = registrar.plan({ ...TARGET, timeoutSeconds: 8 }) as {
      hooks: { timeout: number }[];
    }[];
    for (const entry of plan) for (const h of entry.hooks) expect(h.timeout).toBe(8);
  });

  it('events map covers all seven canonical events under their native names', () => {
    expect(Object.keys(registrar.events).sort()).toEqual([...EVENTS].sort());
    expect(registrar.events).toEqual({
      'session.start': {
        native: 'SessionStart',
        matcher: 'startup|clear|compact',
        canBlock: false,
      },
      prompt: { native: 'UserPromptSubmit', canBlock: true },
      'tool.before': { native: 'PreToolUse', canBlock: true },
      'tool.after': { native: 'PostToolUse', canBlock: false },
      'agent.start': { native: 'SubagentStart', canBlock: false },
      'agent.stop': { native: 'SubagentStop', canBlock: true },
      'turn.end': { native: 'Stop', canBlock: true },
    });
  });

  it('tools regexes anchor on the whole native name', () => {
    const { tools } = registrar;
    expect(tools.web?.test('WebSearch')).toBe(true);
    expect(tools.web?.test('WebFetch')).toBe(true);
    expect(tools.web?.test('WebFetchX')).toBe(false);
    expect(tools.dispatch?.test('Agent')).toBe(true);
    expect(tools.dispatch?.test('Task')).toBe(true);
    expect(tools.dispatch?.test('TaskOutput')).toBe(false);
    expect(tools.shell?.test('Bash')).toBe(true);
    expect(tools.shell?.test('BashOutput')).toBe(false);
    expect(tools.edit?.test('Edit')).toBe(true);
    expect(tools.edit?.test('Write')).toBe(true);
    expect(tools.edit?.test('MultiEdit')).toBe(true);
    expect(tools.edit?.test('NotebookEdit')).toBe(false);
    expect(tools.read?.test('Read')).toBe(true);
    expect(tools.read?.test('ReadMcpResourceTool')).toBe(false);
  });

  it('children are tagged', () => {
    expect(registrar.childrenTagged).toBe(true);
  });

  it('transcriptFor prefers the child transcript, then the session one, else null', () => {
    expect(registrar.transcriptFor(decoded('SubagentStop'))).toEqual({
      path: SubagentStop.agent_transcript_path,
    });
    expect(registrar.transcriptFor(decoded('Stop'))).toEqual({ path: TRANSCRIPT });
    const stop = decoded('Stop');
    expect(registrar.transcriptFor({ ...stop, transcript: undefined })).toBeNull();
    expect(registrar.transcriptFor({ ...stop, transcript: {} })).toBeNull();
  });
});

describe('claudeAdapter', () => {
  it('bundles the three pieces under the claude id', () => {
    expect(claudeAdapter.id).toBe('claude');
    expect(claudeAdapter.decode).toBe(decode);
    expect(claudeAdapter.encode).toBe(encode);
    expect(claudeAdapter.registrar).toBe(registrar);
  });
});
