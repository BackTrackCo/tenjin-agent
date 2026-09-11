import { join } from 'node:path';
import { AGENT_ID_RE } from '../lib/grade';
import { CONTEXT_MAX } from '../hooks/constants';
import { hasErrorMarker } from './error-markers';
import type { Emit, Event, HarnessAdapter, HookInput, HookTool, Registrar } from './types';

/**
 * Codex CLI as a harness. Every mapping here is backed by a payload the
 * installed `codex-cli 0.153.4` sent (`fixtures/codex/README.md`, captured
 * 2026-09-08); the schema source is openai/codex at `rust-v0.153.4`.
 *
 * What is NOT mapped, on purpose: the spawn tool (`collaborationspawn_agent`)
 * carries its task as opaque ciphertext, so there is no work order to look up
 * and no dispatch handoff; a shell PostToolUse carries no exit status, so a
 * failure is known only from an error marker and success is never known; the
 * web tool (`webrun`) is hooked by this CLI but stays outside the first
 * release's scope. Each decodes as `other`, or as unknown status, never as a
 * guess.
 */

const NATIVE_TO_EVENT: Record<string, Event> = {
  SessionStart: 'session.start',
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool.before',
  PostToolUse: 'tool.after',
  SubagentStart: 'agent.start',
  SubagentStop: 'agent.stop',
  Stop: 'turn.end',
};

/** The hook-facing tool names, spelled once for the decoder and the matchers. */
const SHELL_TOOL = 'Bash';
const PATCH_TOOL = 'apply_patch';

/** The events whose only continuation is `decision: block`: their response
 *  schema has no `hookSpecificOutput` at all (schema.rs, StopCommandOutputWire). */
const BLOCK_EVENTS: ReadonlySet<Event> = new Set<Event>(['turn.end', 'agent.stop']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** `*** Add File: p`, `*** Update File: p`, `*** Delete File: p`, `*** Move to: q`. */
const PATCH_PATH_RE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/;

/**
 * Every path an apply_patch names, in order, once each. The patch grammar is
 * the tool's own (apply-patch/src/parser.rs); a rename names both its source
 * and its target, because both were attempted work.
 */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split('\n')) {
    const m = PATCH_PATH_RE.exec(line.trimEnd());
    const path = m?.[1]?.trim();
    if (path !== undefined && path.length > 0 && !out.includes(path)) out.push(path);
  }
  return out;
}

function canonicalTool(name: string, input: Record<string, unknown>): HookTool {
  if (name === SHELL_TOOL) return { name, kind: 'shell', command: str(input.command) ?? '' };
  if (name === PATCH_TOOL)
    return { name, kind: 'edit', paths: patchPaths(str(input.command) ?? '') };
  return { name, kind: 'other' };
}

/**
 * Pure. Returns null for an unknown event, a missing session, or an `agent_id`
 * that is present but fails `AGENT_ID_RE`, exactly as the Claude adapter does:
 * a child this build cannot name is dropped rather than filed under the lead.
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
    harness: 'codex',
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
  const turn = str(raw.turn_id);
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
    const tool = canonicalTool(name, isRecord(raw.tool_input) ? raw.tool_input : {});
    const callId = str(raw.tool_use_id);
    if (callId !== undefined) tool.callId = callId;
    if (event === 'tool.after') {
      // The response is the output text and nothing else: no exit status, on
      // a nonzero exit as much as on a clean one (PostToolUse-silent-exit).
      // So a marker is the only failure evidence, and its absence is unknown.
      const text = str(raw.tool_response);
      if (text !== undefined) tool.result = { text };
      if (tool.kind === 'shell' && text !== undefined && hasErrorMarker(text)) tool.ok = false;
    }
    input.tool = tool;
  }
  return input;
}

/**
 * Pure. `null` when there is nothing to say (the daemon answers 204).
 *
 * Two envelopes, because Codex has two: context beside the turn on prompt,
 * tool and start events, and on Stop/SubagentStop only `decision: block` with
 * the words as the `reason`, which the captured sessions show continues the
 * turn and trips `stop_hook_active` on the next stop. Both wire structs deny
 * unknown fields, so nothing else rides along.
 */
export function encode(emit: Emit | null, input: HookInput): unknown {
  if (emit === null || emit.context === undefined || emit.context.length === 0) return null;
  const text = emit.context.slice(0, CONTEXT_MAX);
  if (BLOCK_EVENTS.has(input.event)) return { decision: 'block', reason: text };
  return { hookSpecificOutput: { hookEventName: input.native.event, additionalContext: text } };
}

/** `$CODEX_HOME`, else `~/.codex`: the same root the CLI reads its config from. */
export function codexHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CODEX_HOME;
  return override !== undefined && override.length > 0 ? override : join(home, '.codex');
}

function commandHandler(shimPath: string, timeoutSeconds: number) {
  return {
    type: 'command',
    command: `node ${JSON.stringify(shimPath)} --harness codex`,
    timeout: timeoutSeconds,
  };
}

export const registrar: Registrar = {
  configPath(home, env) {
    return join(codexHome(home, env), 'hooks.json');
  },
  /**
   * Seven `command` entries, every one through the shim: a Codex handler
   * carries no URL or token, so the daemon is ensured on each fire and the
   * entry holds nothing worth protecting. The matchers are the two hooked
   * tool names the arms read; a child's fires arrive through the same entries.
   */
  plan({ shimPath, timeoutSeconds }) {
    const command = [commandHandler(shimPath, timeoutSeconds)];
    return [
      { event: 'SessionStart', hooks: command },
      { event: 'UserPromptSubmit', hooks: command },
      { event: 'PreToolUse', matcher: `${SHELL_TOOL}|${PATCH_TOOL}`, hooks: command },
      { event: 'PostToolUse', matcher: SHELL_TOOL, hooks: command },
      { event: 'SubagentStart', hooks: command },
      { event: 'SubagentStop', hooks: command },
      { event: 'Stop', hooks: command },
    ];
  },
  /**
   * Codex reads hooks once, at session start. `install` now trusts the entries
   * it writes through Codex's own supported path (lib/codex-trust.ts), so the
   * `/hooks` walkthrough this used to carry is gone; what is left is the one
   * fact no installer can change, which is that the session already open still
   * has the hook set it started with (tenjin-agent#343).
   */
  activation() {
    return ['Start a new Codex session: hooks are read at session start.'];
  },
};

export const codexAdapter: HarnessAdapter = { id: 'codex', decode, encode, registrar };
