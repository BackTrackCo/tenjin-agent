import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { codexAdapter, codexHome, decode, encode, patchPaths, registrar } from './codex';
import type { Event, HookInput } from './types';
import { CONTEXT_MAX } from '../hooks/constants';
import SessionStart from './fixtures/codex/SessionStart.json';
import UserPromptSubmit from './fixtures/codex/UserPromptSubmit.json';
import PreToolUse from './fixtures/codex/PreToolUse.json';
import PostToolUse from './fixtures/codex/PostToolUse.json';
import PostToolUseSilentExit from './fixtures/codex/PostToolUse-silent-exit.json';
import PostToolUseErrorOutput from './fixtures/codex/PostToolUse-error-output.json';
import PostToolUseLongExec from './fixtures/codex/PostToolUse-long-exec.json';
import PreToolUsePatchAdd from './fixtures/codex/PreToolUse-apply_patch-add.json';
import PreToolUsePatchMove from './fixtures/codex/PreToolUse-apply_patch-move.json';
import PreToolUsePatchDelete from './fixtures/codex/PreToolUse-apply_patch-delete.json';
import PostToolUsePatch from './fixtures/codex/PostToolUse-apply_patch.json';
import PreToolUseSpawn from './fixtures/codex/PreToolUse-spawn_agent.json';
import PreToolUseWait from './fixtures/codex/PreToolUse-wait_agent.json';
import PreToolUseWebrun from './fixtures/codex/PreToolUse-webrun.json';
import SubagentStart from './fixtures/codex/SubagentStart.json';
import SubagentStartSibling from './fixtures/codex/SubagentStart-sibling.json';
import nestedSubagentStart from './fixtures/codex/nested-SubagentStart.json';
import childPreToolUse from './fixtures/codex/child-PreToolUse.json';
import childPostToolUse from './fixtures/codex/child-PostToolUse.json';
import childPreToolUsePatch from './fixtures/codex/child-PreToolUse-apply_patch.json';
import nestedPostToolUse from './fixtures/codex/nested-PostToolUse.json';
import SubagentStop from './fixtures/codex/SubagentStop.json';
import SubagentStopFused from './fixtures/codex/SubagentStop-fused.json';
import Stop from './fixtures/codex/Stop.json';
import StopFused from './fixtures/codex/Stop-fused.json';
import SessionEnd from './fixtures/codex/SessionEnd.json';

/**
 * Every payload here is one the installed codex-cli 0.153.4 sent
 * (`fixtures/codex/README.md`, captured 2026-09-08). The relational ids are
 * the evidence: the root session is the same string on every event of a run,
 * and each child's `agent_id` is its own thread id.
 */

const FIXTURES = {
  SessionStart,
  UserPromptSubmit,
  PreToolUse,
  PostToolUse,
  SubagentStart,
  SubagentStop,
  Stop,
} as const;

function decoded(raw: unknown, name: string): HookInput {
  const input = decode(raw);
  if (input === null) throw new Error(`${name} fixture did not decode`);
  return input;
}

describe('decode', () => {
  const EXPECTED: Record<keyof typeof FIXTURES, Event> = {
    SessionStart: 'session.start',
    UserPromptSubmit: 'prompt',
    PreToolUse: 'tool.before',
    PostToolUse: 'tool.after',
    SubagentStart: 'agent.start',
    SubagentStop: 'agent.stop',
    Stop: 'turn.end',
  };

  it.each(Object.keys(FIXTURES) as (keyof typeof FIXTURES)[])(
    'maps %s onto its canonical event and keeps the common fields',
    (name) => {
      const input = decoded(FIXTURES[name], name);
      expect(input.harness).toBe('codex');
      expect(input.event).toBe(EXPECTED[name]);
      expect(input.native).toEqual({ event: name });
      expect(input.session).toBe(FIXTURES[name].session_id);
      expect(input.cwd).toBe('/Users/dev/proj');
      expect(input.transcript?.path).toBe(FIXTURES[name].transcript_path);
      expect(input.raw).toBe(FIXTURES[name]);
    },
  );

  it('SessionStart carries source and neither turn nor agent', () => {
    const input = decoded(SessionStart, 'SessionStart');
    expect(input.source).toBe('startup');
    expect(input.turn).toBeUndefined();
    expect(input.agent).toBeUndefined();
    expect(input.tool).toBeUndefined();
  });

  it('UserPromptSubmit carries the prompt and the turn from turn_id', () => {
    const input = decoded(UserPromptSubmit, 'UserPromptSubmit');
    expect(input.turn).toBe(UserPromptSubmit.turn_id);
    expect(input.prompt).toBe(UserPromptSubmit.prompt);
  });

  it('SessionEnd and any other native event drop the fire', () => {
    expect(decode(SessionEnd)).toBeNull();
    expect(decode({ ...Stop, hook_event_name: 'PreCompact' })).toBeNull();
    expect(decode({ ...Stop, hook_event_name: 'Interrupt' })).toBeNull();
  });

  describe('the shell tool', () => {
    it('PreToolUse Bash is a shell tool with its command and callId, no status', () => {
      expect(decoded(PreToolUse, 'PreToolUse').tool).toEqual({
        name: 'Bash',
        kind: 'shell',
        command: 'echo hello-probe',
        callId: PreToolUse.tool_use_id,
      });
    });

    it('a clean PostToolUse is UNKNOWN status: the response is output text alone', () => {
      const tool = decoded(PostToolUse, 'PostToolUse').tool;
      expect(tool).toEqual({
        name: 'Bash',
        kind: 'shell',
        command: 'echo hello-probe',
        callId: PostToolUse.tool_use_id,
        result: { text: 'hello-probe\n' },
      });
      expect(tool?.ok).toBeUndefined();
    });

    it('a silent nonzero exit is indistinguishable from success on the wire, so it stays unknown', () => {
      // `sh -c "echo silent-failure-probe; exit 3"`: the harness sent the
      // output and nothing about the 3. No marker means no evidence, not ok.
      const tool = decoded(PostToolUseSilentExit, 'silent exit').tool;
      expect(tool?.result).toEqual({ text: 'silent-failure-probe\n' });
      expect(tool?.ok).toBeUndefined();
    });

    it('an error marker in the output is a failure, decided here', () => {
      const tool = decoded(PostToolUseErrorOutput, 'error output').tool;
      expect(tool).toMatchObject({
        kind: 'shell',
        ok: false,
        result: { text: 'Error: probe failure\n' },
      });
    });

    it('a long-running command that completed inside one call is one plain response', () => {
      const tool = decoded(PostToolUseLongExec, 'long exec').tool;
      expect(tool).toMatchObject({ kind: 'shell', command: 'sh -c "sleep 20; echo late-probe"' });
      expect(tool?.result).toEqual({ text: 'late-probe\n' });
      expect(tool?.ok).toBeUndefined();
    });

    it('an empty, missing or non-string response is no result and no status', () => {
      const rest = { ...PostToolUse } as Record<string, unknown>;
      delete rest.tool_response;
      expect(decode(rest)?.tool?.result).toBeUndefined();
      expect(decode(rest)?.tool?.ok).toBeUndefined();
      expect(decode({ ...PostToolUse, tool_response: '' })?.tool).toMatchObject({
        result: { text: '' },
      });
      expect(decode({ ...PostToolUse, tool_response: '' })?.tool?.ok).toBeUndefined();
      expect(
        decode({ ...PostToolUse, tool_response: { stdout: 'x' } })?.tool?.result,
      ).toBeUndefined();
    });
  });

  describe('apply_patch', () => {
    it.each([
      ['add', PreToolUsePatchAdd, ['notes/a.txt', 'README.md']],
      ['move', PreToolUsePatchMove, ['notes/a.txt', 'notes/b.txt']],
      ['delete', PreToolUsePatchDelete, ['notes/b.txt']],
    ])('%s is one edit naming every affected path', (name, fixture, paths) => {
      expect(decoded(fixture, `patch ${name}`).tool).toMatchObject({ kind: 'edit', paths });
    });

    it('its PostToolUse keeps the text and carries no status: nothing reads one on an edit', () => {
      const tool = decoded(PostToolUsePatch, 'patch after').tool;
      expect(tool).toMatchObject({ kind: 'edit', paths: ['notes/a.txt', 'README.md'] });
      expect(tool?.result?.text).toContain('Success. Updated the following files');
      expect(tool?.ok).toBeUndefined();
    });

    it('patchPaths reads the grammar exactly, once per path, in order', () => {
      const patch = [
        '*** Begin Patch',
        '*** Update File: src/a.ts',
        '*** Move to: src/b.ts',
        '@@',
        '-*** Add File: not/a/header',
        '+x',
        '*** Add File: src/c.ts  ',
        '+y',
        '*** Update File: src/a.ts',
        '*** Delete File: src/d.ts',
        '*** End Patch',
      ].join('\n');
      expect(patchPaths(patch)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
      expect(patchPaths('')).toEqual([]);
      expect(patchPaths('echo not a patch')).toEqual([]);
    });
  });

  describe('tools this release does not map', () => {
    it('the spawn tool is other: its message is opaque ciphertext, so there is no task', () => {
      const tool = decoded(PreToolUseSpawn, 'spawn').tool;
      expect(tool).toEqual({
        name: 'collaborationspawn_agent',
        kind: 'other',
        callId: PreToolUseSpawn.tool_use_id,
      });
      expect(PreToolUseSpawn.tool_input.message.startsWith('gAAAAA')).toBe(true);
    });

    it('wait_agent and the web tool are other', () => {
      expect(decoded(PreToolUseWait, 'wait').tool?.kind).toBe('other');
      expect(decoded(PreToolUseWebrun, 'webrun').tool).toMatchObject({
        name: 'webrun',
        kind: 'other',
      });
    });

    it('a missing tool_name is an empty other tool', () => {
      const rest = { ...PreToolUse } as Record<string, unknown>;
      delete rest.tool_name;
      delete rest.tool_input;
      expect(decode(rest)?.tool).toEqual({
        name: '',
        kind: 'other',
        callId: PreToolUse.tool_use_id,
      });
    });

    it('a non-object tool_input leaves the canonical fields empty', () => {
      expect(decode({ ...PreToolUse, tool_input: 'ls' })?.tool).toMatchObject({
        kind: 'shell',
        command: '',
      });
      expect(decode({ ...PreToolUsePatchAdd, tool_input: 7 })?.tool).toMatchObject({
        kind: 'edit',
        paths: [],
      });
    });
  });

  describe('children (captured: two siblings and a nested child under one root)', () => {
    it('SubagentStart names the child, its type and ITS OWN turn, under the root session', () => {
      const input = decoded(SubagentStart, 'SubagentStart');
      expect(input.agent).toBe(SubagentStart.agent_id);
      expect(input.agentType).toBe('default');
      // The spawn call is the parent's fire in the same run: same root
      // session, and a turn of the child's own that no handoff can key on.
      expect(input.session).toBe(PreToolUseSpawn.session_id);
      expect(input.turn).toBe(SubagentStart.turn_id);
      expect(input.turn).not.toBe(PreToolUseSpawn.turn_id);
    });

    it('siblings and a nested child are three distinct agents sharing one root session', () => {
      const a = decoded(SubagentStart, 'a');
      const b = decoded(SubagentStartSibling, 'b');
      const nested = decoded(nestedSubagentStart, 'nested');
      expect(new Set([a.agent, b.agent, nested.agent]).size).toBe(3);
      expect(new Set([a.session, b.session, nested.session]).size).toBe(1);
      expect(nested.agent).not.toBe(b.agent);
    });

    it("a child's tool fires carry its agent_id, and the shell it ran saw the same ids", () => {
      const before = decoded(childPreToolUse, 'child before');
      const after = decoded(childPostToolUse, 'child after');
      expect(before).toMatchObject({
        event: 'tool.before',
        agent: SubagentStart.agent_id,
        session: SubagentStart.session_id,
        turn: SubagentStart.turn_id,
        tool: { kind: 'shell', command: 'env | grep ^CODEX_' },
      });
      // What `readActor` will read inside that child: the root session and
      // the child's own thread, verbatim from the captured output.
      expect(after.tool?.result?.text).toContain(`CODEX_SESSION_ID=${SubagentStart.session_id}`);
      expect(after.tool?.result?.text).toContain(`CODEX_THREAD_ID=${SubagentStart.agent_id}`);
      expect(after.tool?.ok).toBeUndefined();
    });

    it("a nested child's shell saw the root session and its own id, not its parent's", () => {
      const input = decoded(nestedPostToolUse, 'nested after');
      expect(input.agent).toBe(nestedSubagentStart.agent_id);
      expect(input.tool?.result?.text).toContain(`CODEX_THREAD_ID=${nestedSubagentStart.agent_id}`);
      expect(input.tool?.result?.text).toContain(
        `CODEX_SESSION_ID=${nestedSubagentStart.session_id}`,
      );
    });

    it("a child's patch is an edit under the child", () => {
      expect(decoded(childPreToolUsePatch, 'child patch')).toMatchObject({
        agent: SubagentStartSibling.agent_id,
        tool: { kind: 'edit', paths: ['notes/child-b.txt'] },
      });
    });

    it('SubagentStop carries the child, both transcripts, the last message and the fuse', () => {
      const input = decoded(SubagentStop, 'SubagentStop');
      expect(input.agent).toBe(SubagentStart.agent_id);
      expect(input.agentType).toBe('default');
      expect(input.transcript).toEqual({
        path: SubagentStop.transcript_path,
        agentPath: SubagentStop.agent_transcript_path,
      });
      expect(input.lastMessage).toBe(SubagentStop.last_assistant_message);
      expect(input.stopFuse).toBe(false);
      // The stop after a block: same child, same turn, fuse tripped.
      const fused = decoded(SubagentStopFused, 'fused');
      expect(fused.agent).toBe(input.agent);
      expect(fused.turn).toBe(input.turn);
      expect(fused.stopFuse).toBe(true);
    });
  });

  it('Stop carries the fuse and last message for the lead, and the fused stop follows a block', () => {
    const input = decoded(Stop, 'Stop');
    expect(input.agent).toBeUndefined();
    expect(input.stopFuse).toBe(false);
    expect(input.lastMessage).toBe('DONE');
    const fused = decoded(StopFused, 'fused');
    expect(fused.stopFuse).toBe(true);
    expect(fused.turn).toBe(input.turn);
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

    it('a null last_assistant_message or transcript_path is simply absent', () => {
      const input = decode({ ...Stop, last_assistant_message: null, transcript_path: null });
      expect(input?.lastMessage).toBeUndefined();
      expect(input?.transcript).toBeUndefined();
    });

    it('a missing or empty session_id drops the fire', () => {
      const rest = { ...Stop } as Record<string, unknown>;
      delete rest.session_id;
      expect(decode(rest)).toBeNull();
      expect(decode({ ...rest, session_id: '' })).toBeNull();
    });

    it('a non-object payload drops the fire', () => {
      for (const raw of [null, undefined, 'Stop', 0, true, [Stop]]) expect(decode(raw)).toBeNull();
    });
  });
});

describe('encode', () => {
  const stop = decoded(Stop, 'Stop');
  const prompt = decoded(UserPromptSubmit, 'UserPromptSubmit');

  it('null or empty context is nothing to say', () => {
    expect(encode(null, prompt)).toBeNull();
    expect(encode({}, prompt)).toBeNull();
    expect(encode({ context: '' }, stop)).toBeNull();
  });

  it('context rides hookSpecificOutput under the native event name on prompt, tool and start events', () => {
    expect(encode({ context: 'hi' }, prompt)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'hi' },
    });
    for (const raw of [SessionStart, PreToolUse, PostToolUse, SubagentStart]) {
      const input = decoded(raw, raw.hook_event_name);
      expect(encode({ context: 'hi' }, input)).toEqual({
        hookSpecificOutput: { hookEventName: raw.hook_event_name, additionalContext: 'hi' },
      });
    }
  });

  it('Stop and SubagentStop have no context field: the words go as a block reason', () => {
    expect(encode({ context: 'publish?' }, stop)).toEqual({
      decision: 'block',
      reason: 'publish?',
    });
    expect(encode({ context: 'publish?' }, decoded(SubagentStop, 'SubagentStop'))).toEqual({
      decision: 'block',
      reason: 'publish?',
    });
    // The fuse changes nothing here; the capture arm reads it, the wire does not.
    expect(encode({ context: 'x' }, decoded(StopFused, 'fused'))).toEqual({
      decision: 'block',
      reason: 'x',
    });
  });

  it('slices at CONTEXT_MAX on both envelopes', () => {
    const long = 'x'.repeat(CONTEXT_MAX + 50);
    const ctx = encode({ context: long }, prompt) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(ctx.hookSpecificOutput.additionalContext).toHaveLength(CONTEXT_MAX);
    const block = encode({ context: long }, stop) as { reason: string };
    expect(block.reason).toHaveLength(CONTEXT_MAX);
  });
});

describe('registrar', () => {
  const TARGET = {
    url: 'http://127.0.0.1:30417/hook/codex',
    token: 'tok_0123456789abcdef',
    shimPath: '/Users/dev/.tenjin/hooks/tenjin-shim.mjs',
    timeoutSeconds: 5,
  };
  const command = {
    type: 'command',
    command: `node "${TARGET.shimPath}" --harness codex`,
    timeout: 5,
  };

  it('configPath is hooks.json under ~/.codex, or under CODEX_HOME when set', () => {
    expect(registrar.configPath('/Users/dev', {})).toBe(join('/Users/dev', '.codex', 'hooks.json'));
    expect(registrar.configPath('/Users/dev', { CODEX_HOME: '/srv/codex' })).toBe(
      join('/srv/codex', 'hooks.json'),
    );
    expect(codexHome('/Users/dev', { CODEX_HOME: '' })).toBe(join('/Users/dev', '.codex'));
  });

  it('plan is seven command entries through the shim, matched on the two hooked tool names', () => {
    expect(registrar.plan(TARGET)).toEqual([
      { event: 'SessionStart', hooks: [command] },
      { event: 'UserPromptSubmit', hooks: [command] },
      { event: 'PreToolUse', matcher: 'Bash|apply_patch', hooks: [command] },
      { event: 'PostToolUse', matcher: 'Bash', hooks: [command] },
      { event: 'SubagentStart', hooks: [command] },
      { event: 'SubagentStop', hooks: [command] },
      { event: 'Stop', hooks: [command] },
    ]);
  });

  it('no entry carries the URL or the token: a Codex handler is not a place for either', () => {
    const text = JSON.stringify(registrar.plan(TARGET));
    expect(text).not.toContain(TARGET.token);
    expect(text).not.toContain(TARGET.url);
    expect(text).not.toContain('http');
  });

  it('leaves one note, not a walkthrough: install trusts what it writes', () => {
    // The six-step `/hooks` flow is gone. `install` completes trust through
    // Codex's own supported path, so the only remaining fact is the one no
    // installer can change: the session already open predates these hooks
    // (tenjin-agent#343).
    const steps = registrar.activation?.('/tmp/codex-home/hooks.json') ?? [];
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatch(/new Codex session/);
    expect(steps.join(' ')).not.toContain('/hooks');
  });
});

describe('codexAdapter', () => {
  it('bundles the three pieces under the codex id', () => {
    expect(codexAdapter.id).toBe('codex');
    expect(codexAdapter.decode).toBe(decode);
    expect(codexAdapter.encode).toBe(encode);
    expect(codexAdapter.registrar).toBe(registrar);
  });
});
