/**
 * The harness adapter contract (tenjin-notes loop-redesign/04-harness-adapters.md).
 *
 * This is the ONLY file the kernel (`src/hooks/*`) imports from `src/adapters/`.
 * A harness is one module exporting a {@link HarnessAdapter}: a pure `decode`
 * from its native payload to {@link HookInput}, a pure `encode` from the
 * kernel's {@link Emit} to its native response, and a {@link Registrar} the
 * installer uses to write its hook entries. The daemon holds one adapter per
 * member of {@link Harness} and one route, `POST /hook/:harness`.
 *
 * Adding a harness is an adapter file plus a transport; nothing in `src/hooks`
 * or `src/daemon` changes. The union gains a member when an adapter lands, not
 * before.
 */

/** Harnesses with an adapter in this build. */
export type Harness = 'claude';

/**
 * The canonical event vocabulary every adapter maps its native events onto.
 * `session.end` is deliberately absent: no arm registers on it and retention
 * never runs there (a daemon serves many sessions; one ending is not the
 * machine going quiet).
 */
export type Event =
  | 'session.start'
  | 'prompt'
  | 'tool.before'
  | 'tool.after'
  | 'agent.start'
  | 'agent.stop'
  | 'turn.end';

export const EVENTS: readonly Event[] = [
  'session.start',
  'prompt',
  'tool.before',
  'tool.after',
  'agent.start',
  'agent.stop',
  'turn.end',
];

/** What a tool IS to the arms. Anything unmatched is `'other'`, never a key. */
export type ToolKind = 'web' | 'dispatch' | 'shell' | 'edit' | 'read';

export interface HookTool {
  name: string;
  kind: ToolKind | 'other';
  callId?: string;
  input: Record<string, unknown>;
  /**
   * `tool.after` only, and DECIDED IN DECODE (Claude: `PostToolUseFailure`;
   * Codex: nonzero exit), never by an arm reading the result text.
   */
  ok?: boolean;
  result?: { stdout?: string; stderr?: string; error?: string; text?: string };
  interrupted?: boolean;
}

/** The normalized payload the kernel runs on. */
export interface HookInput {
  harness: Harness;
  event: Event;
  /** `hook_event_name` verbatim; `encode` stamps its response with it. */
  native: { event: string };
  /** The ROOT session: the id the lead and all its children share. */
  session: string;
  /** Child id; undefined = the lead. Present-but-invalid makes `decode` return null. */
  agent?: string;
  /** Required; '' is allowed and recorded. */
  cwd: string;
  /** Claude `prompt_id`, Codex `turn_id`. */
  turn?: string;
  tool?: HookTool;
  /** The prompt on `prompt`; the spawn prompt on `agent.start` when the harness has it. */
  prompt?: string;
  agentType?: string;
  lastMessage?: string;
  /**
   * Claude/Codex `stop_hook_active`. The kernel's loop guard: `block` is
   * emitted only when this is `=== false`, so a harness with no fuse cannot
   * block at all.
   */
  stopFuse?: boolean;
  transcript?: { path?: string; agentPath?: string };
  /** `session.start` source (`startup`, `clear`, `compact`, `resume`). */
  source?: string;
  /** The native payload. Ledger `question` on error rows and tests only; never read by arms. */
  raw: unknown;
}

/** What the kernel hands back to the harness. `null` is "nothing to say" (204). */
export interface Emit {
  context?: string;
  block?: { reason: string };
}

/** What the installer needs to register a harness. */
export interface Registrar {
  /** The harness's own settings file under `home`. */
  configPath(home: string): string;
  /** Opaque entries the installer merges additively into that file. */
  plan(target: { url: string; token: string; shimPath: string; timeoutSeconds: number }): unknown[];
  /**
   * Which canonical events this harness raises, under which native name and
   * matcher, and whether a `block` there means anything. An arm whose `on`
   * names an event absent here is not registered for this harness.
   */
  events: Partial<Record<Event, { native: string; matcher?: string; canBlock: boolean }>>;
  /** Native tool names per kind. Missing kinds decode as `'other'`. */
  tools: Partial<Record<ToolKind, RegExp>>;
  /**
   * `false` means the harness cannot tag a child's fires with its id, so the
   * actor is the session for this harness and subagent arms register marks only.
   */
  childrenTagged: boolean;
  transcriptFor(input: HookInput): { path: string } | null;
}

export interface HarnessAdapter {
  id: Harness;
  /** Pure. `null` = drop the fire quietly (unknown event, invalid identity). */
  decode(raw: unknown): HookInput | null;
  /** Pure. `null` = respond 204 with no body. */
  encode(emit: Emit | null, input: HookInput): unknown;
  registrar: Registrar;
}
