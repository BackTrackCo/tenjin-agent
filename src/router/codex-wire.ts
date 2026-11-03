/**
 * Codex CLI's hook payloads, as the router reads them. Every mapping here is
 * backed by a payload the installed `codex-cli 0.153.4` sent
 * (`fixtures/harness/codex/README.md`, captured 2026-09-08); the schema source
 * is openai/codex at `rust-v0.153.4`.
 *
 * The router's legs read the root session's prompt and the web tool
 * (`webrun`), so that is what is decoded: the prompt, the tool call before and
 * after it runs, and who they belong to. Every other event drops. The web tool
 * is read through {@link splitWebrun}.
 */

const NATIVE_TO_EVENT = {
  UserPromptSubmit: 'prompt',
  PreToolUse: 'tool.before',
  PostToolUse: 'tool.after',
} as const;

export type CodexEvent = (typeof NATIVE_TO_EVENT)[keyof typeof NATIVE_TO_EVENT];

/**
 * A child's id as Codex names it (the child's own thread id). One that fails
 * this is a child this build cannot name, so its fire drops rather than being
 * filed under the lead.
 */
export const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface CodexTool {
  name: string;
  callId?: string;
  /** The output text, on `tool.after`; Codex sends no exit status with it. */
  result?: { text: string };
}

export interface CodexHookInput {
  event: CodexEvent;
  /** The root session, on every event of a run, inside children too. */
  session: string;
  /** The child the fire came from; absent for the lead. */
  agent?: string;
  cwd: string;
  prompt?: string;
  transcriptPath?: string;
  tool?: CodexTool;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** One search or one page open, as the router weighs it. */
export type WebrunEntry = { tool: 'WebSearch'; query: string } | { tool: 'WebFetch'; url: string };

/**
 * A `webrun` call as the router reads it: the one entry it weighs, the exact
 * rest of the call, and every search and URL in it.
 */
export interface WebrunSplit {
  entry: WebrunEntry;
  /** The input without the entry, filters and all; null when no operation remains. */
  rest: Record<string, unknown> | null;
  /** Every search and URL in the call, the entry first. */
  targets: WebrunEntry[];
}

const HTTP_URL_RE = /^https?:\/\//i;

const plainSearch = (v: unknown): v is { q: string } =>
  isRecord(v) &&
  Object.keys(v).every((key) => key === 'q') &&
  typeof v.q === 'string' &&
  v.q.trim().length > 0;

const urlOpen = (v: unknown): v is { ref_id: string } =>
  isRecord(v) && typeof v.ref_id === 'string' && HTTP_URL_RE.test(v.ref_id.trim());

/**
 * Pure. The entry is the first search that is only `q`, else the first open of
 * an http(s) URL with no `lineno`; null when the call holds neither. The rest
 * is the input minus that one entry, so entry plus rest is the whole call.
 */
export function splitWebrun(input: Record<string, unknown>): WebrunSplit | null {
  const searches = Array.isArray(input.search_query) ? (input.search_query as unknown[]) : [];
  const opens = Array.isArray(input.open) ? (input.open as unknown[]) : [];
  const s = searches.findIndex(plainSearch);
  const o =
    s === -1
      ? opens.findIndex((v) => urlOpen(v) && Object.keys(v as object).every((k) => k === 'ref_id'))
      : -1;
  if (s === -1 && o === -1) return null;
  const key = s !== -1 ? 'search_query' : 'open';
  const index = s !== -1 ? s : o;
  const entry: WebrunEntry =
    s !== -1
      ? { tool: 'WebSearch', query: (searches[s] as { q: string }).q }
      : { tool: 'WebFetch', url: (opens[o] as { ref_id: string }).ref_id.trim() };
  const rest: Record<string, unknown> = { ...input };
  const left = (s !== -1 ? searches : opens).filter((_, i) => i !== index);
  if (left.length === 0) delete rest[key];
  else rest[key] = left;
  const others: WebrunEntry[] = [
    ...searches.flatMap((v, i): WebrunEntry[] =>
      key === 'search_query' && i === index
        ? []
        : isRecord(v) && typeof v.q === 'string' && v.q.trim().length > 0
          ? [{ tool: 'WebSearch', query: v.q }]
          : [],
    ),
    ...opens.flatMap((v, i): WebrunEntry[] =>
      (key === 'open' && i === index) || !urlOpen(v)
        ? []
        : [{ tool: 'WebFetch', url: v.ref_id.trim() }],
    ),
  ];
  const operations = Object.keys(rest).filter((k) => k !== 'response_length');
  return { entry, rest: operations.length === 0 ? null : rest, targets: [entry, ...others] };
}

/**
 * Pure. Returns null for an event the router does not read, a missing session,
 * or an `agent_id` that is present but fails {@link AGENT_ID_RE}.
 */
export function decode(raw: unknown): CodexHookInput | null {
  if (!isRecord(raw)) return null;
  const native = str(raw.hook_event_name);
  if (native === undefined || !Object.hasOwn(NATIVE_TO_EVENT, native)) return null;
  const event = NATIVE_TO_EVENT[native as keyof typeof NATIVE_TO_EVENT];
  const session = str(raw.session_id);
  if (session === undefined || session.length === 0) return null;

  const input: CodexHookInput = { event, session, cwd: str(raw.cwd) ?? '' };
  if (raw.agent_id !== undefined && raw.agent_id !== null) {
    const id = raw.agent_id;
    if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) return null;
    input.agent = id;
  }
  const prompt = str(raw.prompt);
  if (prompt !== undefined) input.prompt = prompt;
  const path = str(raw.transcript_path);
  if (path !== undefined) input.transcriptPath = path;

  if (event === 'tool.before' || event === 'tool.after') {
    const tool: CodexTool = { name: str(raw.tool_name) ?? '' };
    const callId = str(raw.tool_use_id);
    if (callId !== undefined) tool.callId = callId;
    if (event === 'tool.after') {
      // The response is the output text and nothing else: a string, or a list
      // of `input_text` blocks. Any other shape is no result.
      const blocks = Array.isArray(raw.tool_response) ? raw.tool_response : undefined;
      const text =
        str(raw.tool_response) ??
        (blocks?.every((b) => isRecord(b) && b.type === 'input_text' && typeof b.text === 'string')
          ? blocks.map((b) => String((b as Record<string, unknown>).text)).join('\n')
          : undefined);
      if (text !== undefined) tool.result = { text };
    }
    input.tool = tool;
  }
  return input;
}
