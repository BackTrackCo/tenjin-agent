import { join } from 'node:path';
import { AGENT_ID_RE } from '../lib/grade';
import { CLAUDE_CONTEXT_MAX } from '../hooks/constants';
import type {
  Emit,
  Event,
  HarnessAdapter,
  HookInput,
  HookTool,
  Registrar,
  ToolKind,
} from './types';

/**
 * Claude Code as a harness. Facts from https://code.claude.com/docs/en/hooks
 * (fetched 2026-09-03) and the 2.1.259 binary: the http hook body is the same
 * JSON a command hook reads on stdin; a 2xx JSON response is parsed with the
 * same output schema; non-2xx, non-JSON, connection failure or timeout is a
 * non-blocking error that lets the turn continue.
 */

const NATIVE_TO_EVENT: Record<string, Event> = {
  SessionStart: 'session.start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool.before',
  PostToolUse: 'tool.after',
  PostToolUseFailure: 'tool.after',
  SubagentStart: 'agent.start',
  SubagentStop: 'agent.stop',
  Stop: 'turn.end',
};

/** Native tool names per kind, spelled once (the matchers below derive from them). */
const TOOLS: Record<ToolKind, RegExp> = {
  web: /^WebSearch$/,
  fetch: /^WebFetch$/,
  dispatch: /^(Agent|Task)$/,
  shell: /^Bash$/,
  edit: /^(Edit|Write|MultiEdit)$/,
  read: /^Read$/,
};

/** A regex `^(A|B)$` back to the `A|B` matcher string Claude's settings want. */
function matcherOf(re: RegExp): string {
  return re.source.replace(/^\^\(?/, '').replace(/\)?\$$/, '');
}

const SESSION_START_MATCHER = 'startup|clear|compact';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function toolKind(name: string): ToolKind | 'other' {
  for (const kind of Object.keys(TOOLS) as ToolKind[]) if (TOOLS[kind].test(name)) return kind;
  return 'other';
}

function toolResult(v: unknown): HookTool['result'] | undefined {
  if (typeof v === 'string') return { text: v };
  if (!isRecord(v)) return undefined;
  const out: NonNullable<HookTool['result']> = {};
  const stdout = str(v.stdout);
  const stderr = str(v.stderr);
  const error = str(v.error);
  if (stdout !== undefined) out.stdout = stdout;
  if (stderr !== undefined) out.stderr = stderr;
  if (error !== undefined) out.error = error;
  if (stdout === undefined && stderr === undefined && error === undefined) {
    // A Read or a WebFetch answers with text under various keys; keep one.
    const text = str(v.text) ?? str(v.content) ?? str(v.result);
    if (text !== undefined) out.text = text;
  }
  return out;
}

/**
 * Pure. Returns null for an unknown event, a missing session, or an `agent_id`
 * that is present but fails `AGENT_ID_RE`: the harness named a worker this build
 * cannot use, and recording the fire anyway would file a child's work under the
 * lead (`hook-scripts.ts` `identityOf` rule, kept verbatim).
 */
export function decode(raw: unknown): HookInput | null {
  if (!isRecord(raw)) return null;
  const native = str(raw.hook_event_name);
  if (native === undefined) return null;
  const event = NATIVE_TO_EVENT[native];
  if (event === undefined) return null;
  const session = str(raw.session_id);
  if (session === undefined || session.length === 0) return null;

  const input: HookInput = {
    harness: 'claude',
    event,
    native: { event: native },
    session,
    cwd: str(raw.cwd) ?? '',
    raw,
  };
  if (raw.agent_id !== undefined && raw.agent_id !== null) {
    const id = raw.agent_id;
    if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) return null;
    input.agent = id;
  }
  const turn = str(raw.prompt_id);
  if (turn !== undefined) input.turn = turn;
  const prompt = str(raw.prompt);
  if (prompt !== undefined) input.prompt = prompt;
  const agentType = str(raw.agent_type);
  if (agentType !== undefined) input.agentType = agentType;
  const lastMessage = str(raw.last_assistant_message);
  if (lastMessage !== undefined) input.lastMessage = lastMessage;
  if (typeof raw.stop_hook_active === 'boolean') input.stopFuse = raw.stop_hook_active;
  const source = str(raw.source);
  if (source !== undefined) input.source = source;
  const path = str(raw.transcript_path);
  const agentPath = str(raw.agent_transcript_path);
  if (path !== undefined || agentPath !== undefined) {
    input.transcript = {};
    if (path !== undefined) input.transcript.path = path;
    if (agentPath !== undefined) input.transcript.agentPath = agentPath;
  }

  if (event === 'tool.before' || event === 'tool.after') {
    const name = str(raw.tool_name) ?? '';
    const tool: HookTool = {
      name,
      kind: toolKind(name),
      input: isRecord(raw.tool_input) ? raw.tool_input : {},
    };
    const callId = str(raw.tool_use_id);
    if (callId !== undefined) tool.callId = callId;
    if (event === 'tool.after') {
      // Decided here, never by an arm reading the text: PostToolUseFailure is
      // a distinct event literal in the 2.1.259 schema.
      tool.ok = native === 'PostToolUseFailure' ? false : true;
      if (native === 'PostToolUseFailure') {
        if (typeof raw.error === 'string') tool.result = { error: raw.error };
        else {
          const result = toolResult(raw.error);
          if (result !== undefined) tool.result = result;
        }
      } else {
        const result = toolResult(raw.tool_response);
        if (result !== undefined) tool.result = result;
      }
      if (typeof raw.is_interrupt === 'boolean') tool.interrupted = raw.is_interrupt;
    }
    input.tool = tool;
  }
  return input;
}

/**
 * Pure. `null` when there is nothing to say (the daemon answers 204).
 * `decision: 'block'` only when the fuse is present AND false: `stop_hook_active`
 * true means this Stop was already raised by a hook's block, and blocking again
 * loops the turn (today's rule, `push-scripts.ts` `emitBlock`).
 */
export function encode(emit: Emit | null, input: HookInput): unknown {
  if (emit === null) return null;
  const out: Record<string, unknown> = {};
  if (emit.context !== undefined && emit.context.length > 0) {
    out.hookSpecificOutput = {
      hookEventName: input.native.event,
      additionalContext: emit.context.slice(0, CLAUDE_CONTEXT_MAX),
    };
  }
  if (emit.block !== undefined && input.stopFuse === false) {
    out.decision = 'block';
    out.reason = emit.block.reason;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** One settings.json handler, as `install` writes it (PR C). */
function httpHandler(url: string, token: string, timeoutSeconds: number) {
  // The token is a literal: Claude Code interpolates `$VAR` only from its own
  // environment and only for names in `allowedEnvVars`, which nothing exports.
  return {
    type: 'http',
    url,
    headers: { Authorization: `Bearer ${token}` },
    timeout: timeoutSeconds,
  };
}

function commandHandler(shimPath: string, timeoutSeconds: number) {
  return {
    type: 'command',
    command: `node ${JSON.stringify(shimPath)} --harness claude`,
    timeout: timeoutSeconds,
  };
}

export const registrar: Registrar = {
  configPath(home) {
    return join(home, '.claude', 'settings.json');
  },
  /**
   * 9 `http` entries and 2 `command` entries (02-redesign.md §4). SessionStart
   * and UserPromptSubmit run the shim because every turn begins with a prompt:
   * the daemon is then up before any tool-path fire of that turn.
   */
  plan({ url, token, shimPath, timeoutSeconds }) {
    const http = [httpHandler(url, token, timeoutSeconds)];
    const command = [commandHandler(shimPath, timeoutSeconds)];
    return [
      { event: 'SessionStart', matcher: SESSION_START_MATCHER, hooks: command },
      { event: 'UserPromptSubmit', hooks: command },
      // ONE entry for both web kinds. The arms are separate; the harness entry
      // is not, because a settings file with two PreToolUse entries whose
      // matchers overlap is two POSTs for one tool call.
      {
        event: 'PreToolUse',
        matcher: `${matcherOf(TOOLS.web)}|${matcherOf(TOOLS.fetch)}`,
        hooks: http,
      },
      { event: 'PreToolUse', matcher: matcherOf(TOOLS.dispatch), hooks: http },
      {
        event: 'PreToolUse',
        matcher: `${matcherOf(TOOLS.edit)}|${matcherOf(TOOLS.shell)}`,
        hooks: http,
      },
      { event: 'PostToolUse', matcher: matcherOf(TOOLS.shell), hooks: http },
      { event: 'PostToolUse', matcher: matcherOf(TOOLS.read), hooks: http },
      { event: 'PostToolUseFailure', matcher: matcherOf(TOOLS.shell), hooks: http },
      { event: 'SubagentStart', hooks: http },
      { event: 'SubagentStop', hooks: http },
      { event: 'Stop', hooks: http },
    ];
  },
  events: {
    'session.start': { native: 'SessionStart', matcher: SESSION_START_MATCHER, canBlock: false },
    // `canBlock` is where `stop_hook_active` exists: Claude sends the fuse on
    // Stop and SubagentStop only, and `encode` gates `block` on it, so a block
    // on a prompt or tool event could never be emitted (today's loop blocks
    // only at those two events too).
    prompt: { native: 'UserPromptSubmit', canBlock: false },
    'tool.before': { native: 'PreToolUse', canBlock: false },
    'tool.after': { native: 'PostToolUse', canBlock: false },
    'agent.start': { native: 'SubagentStart', canBlock: false },
    'agent.stop': { native: 'SubagentStop', canBlock: true },
    'turn.end': { native: 'Stop', canBlock: true },
  },
  tools: TOOLS,
  childrenTagged: true,
  transcriptFor(input) {
    const path = input.transcript?.agentPath ?? input.transcript?.path;
    return path === undefined ? null : { path };
  },
};

export const claudeAdapter: HarnessAdapter = { id: 'claude', decode, encode, registrar };
