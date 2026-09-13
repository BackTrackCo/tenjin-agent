/**
 * The harness adapter contract (tenjin-notes loop-redesign/04-harness-adapters.md).
 *
 * This and `error-markers.ts` (data both sides read) are the ONLY files the
 * kernel (`src/hooks/*`) imports from `src/adapters/`.
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
export type Harness = 'claude' | 'codex';

/** The same union at run time: the installer's ownership predicate matches a
 *  registered URL against `/hook/<harness>`, and a list it cannot iterate would
 *  have to be spelled a second time. */
export const HARNESSES: readonly Harness[] = ['claude', 'codex'];

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

/**
 * What a tool IS to the arms. Anything unmatched is `'other'`, never a key.
 *
 * `web` and `fetch` are separate kinds because they are separate arms: a page
 * fetch and a real web search ask different questions, and one agent's six page
 * fetches must not spend the budget its search needed.
 */
export type ToolKind = 'web' | 'fetch' | 'dispatch' | 'shell' | 'edit' | 'read';

export interface ToolResult {
  stdout?: string;
  stderr?: string;
  error?: string;
  text?: string;
}

interface ToolBase {
  /** The native tool name, verbatim. */
  name: string;
  callId?: string;
  /**
   * `tool.after` only, and DECIDED IN DECODE, never by an arm reading the
   * result text. `false` is a failure the harness stated or an error marker in
   * a shell's output; `true` is a completion the harness vouched for;
   * `undefined` is unknown, which is what a harness that reports no exit status
   * leaves behind. No marker never means success.
   */
  ok?: boolean;
  result?: ToolResult;
  interrupted?: boolean;
}

/**
 * The fields the arms read, canonical per kind. Native argument shapes (a
 * `file_path`, a patch body, a `message`) stop at the adapter; an arm never
 * reads a vendor field. One native invocation is one tool value, so an edit
 * that touches several files carries them all in `paths` and the context arm
 * marks every one in a single fire.
 */
export type HookTool = ToolBase &
  (
    | { kind: 'shell'; command: string }
    | { kind: 'edit'; paths: string[] }
    | { kind: 'read'; paths: string[] }
    | { kind: 'dispatch'; task: string; description?: string }
    | { kind: 'web'; query: string }
    | { kind: 'fetch'; url: string; prompt: string }
    | { kind: 'other' }
  );

/** The normalized payload the kernel runs on. */
export interface HookInput {
  harness: Harness;
  event: Event;
  /** `hook_event_name` verbatim; `encode` stamps its response with it. */
  native: { event: string };
  /** The ROOT session as the harness names it: the id the lead and all its
   *  children share. `actorOf` namespaces it by harness before anything is
   *  stored, so equal native ids across harnesses never share state. */
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
  /** Claude/Codex `stop_hook_active`: this stop was raised by a hook's own
   *  feedback rather than by the agent finishing. The capture arm reads it to
   *  tell an ask turn from the answer turn after one. */
  stopFuse?: boolean;
  transcript?: { path?: string; agentPath?: string };
  /** `session.start` source (`startup`, `clear`, `compact`, `resume`). */
  source?: string;
  /** The native payload. Ledger `question` on error rows and tests only; never read by arms. */
  raw: unknown;
}

/**
 * What the kernel hands back to the harness. `null` is "nothing to say" (204).
 *
 * ONE CHANNEL. Everything an arm says is context beside the turn, including the
 * turn-end ask: on Stop and SubagentStop `additionalContext` keeps the
 * conversation going through the same loop protections a blocking decision
 * would, and shows in the transcript as hook feedback rather than a hook error.
 * A second channel with a red banner said the same words for a worse price.
 */
export interface Emit {
  context?: string;
}

/**
 * What the installer needs to register a harness, and nothing the daemon runs
 * on: `selectArm` reads the event and tool kind off the decoded input, so a
 * registrar carries no event or tool metadata that would claim an enforcement
 * nothing performs.
 */
export interface Registrar {
  /** The harness's own hooks file under `home`. */
  configPath(home: string, env?: NodeJS.ProcessEnv): string;
  /**
   * Entries the installer merges additively into that file, each
   * `{ event, matcher?, hooks }` in the harness's own JSON shape.
   */
  plan(target: { url: string; token: string; shimPath: string; timeoutSeconds: number }): unknown[];
  /** Before installing hook entries in a file this harness reads: how the
   *  operator activates them, when the harness gates untrusted entries. */
  activation?: string;
}

export interface HarnessAdapter {
  id: Harness;
  /** Pure. `null` = drop the fire quietly (unknown event, invalid identity). */
  decode(raw: unknown): HookInput | null;
  /** Pure. `null` = respond 204 with no body. */
  encode(emit: Emit | null, input: HookInput): unknown;
  registrar: Registrar;
}
