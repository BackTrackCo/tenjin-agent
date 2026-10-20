/**
 * THE HOOK EVENT, CARRIED BY AN `mcp_tool` ENTRY. Claude Code calls the `hook`
 * tool of the session's own `tenjin mcp` for each routing leg, with the event's
 * fields substituted into the entry's `input` (`${session_id}` and so on): a
 * string field arrives as written, an object one (`tool_input`,
 * `tool_response`) as its JSON text, a boolean as `true` or `false`, and a
 * field the event lacks as an empty string. This turns that back into the
 * event the handlers already read, and spells the `input` `install` writes.
 */

/** The routing legs, one per hook entry `install` writes. */
export const HOOK_KINDS = ['prompt', 'native', 'shortfall', 'agent', 'ask', 'answer'] as const;
export type HookKind = (typeof HOOK_KINDS)[number];

/** The tool `tenjin mcp` registers for the hook entries. */
export const HOOK_TOOL = 'hook';

/** The event fields each leg reads, as Claude Code names them. */
const COMMON = ['hook_event_name', 'session_id', 'transcript_path', 'cwd'] as const;
const CALL = ['tool_name', 'tool_input', 'tool_use_id', 'agent_id', 'agent_type'] as const;

const FIELDS: Record<HookKind, readonly string[]> = {
  prompt: [...COMMON, 'prompt'],
  native: [...COMMON, ...CALL],
  agent: [...COMMON, ...CALL],
  ask: [...COMMON, ...CALL],
  answer: [...COMMON, ...CALL, 'tool_response'],
  shortfall: [...COMMON, ...CALL, 'tool_response', 'error', 'is_interrupt'],
};

/** Fields whose value is an object or a boolean, sent as JSON text. */
const JSON_FIELDS = new Set(['tool_input', 'tool_response', 'is_interrupt']);

/** The `input` of one leg's `mcp_tool` entry. */
export function hookToolInput(kind: HookKind): Record<string, string> {
  return Object.fromEntries([
    ['kind', kind],
    ...FIELDS[kind].map((field) => [field, `\${${field}}`]),
  ]);
}

/** Every field any leg sends, for the tool's input schema. */
export const HOOK_TOOL_FIELDS: readonly string[] = [...new Set(Object.values(FIELDS).flat())];

export function isHookKind(value: unknown): value is HookKind {
  return typeof value === 'string' && (HOOK_KINDS as readonly string[]).includes(value);
}

/**
 * The harness event from the tool's arguments: empty fields dropped (the
 * event did not carry them), the JSON ones parsed back. A JSON field that does
 * not parse is kept as the string it is.
 */
export function eventFromToolInput(args: Record<string, unknown>): Record<string, unknown> {
  const event: Record<string, unknown> = {};
  for (const field of HOOK_TOOL_FIELDS) {
    const value = args[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (!JSON_FIELDS.has(field)) {
      event[field] = value;
      continue;
    }
    try {
      event[field] = JSON.parse(value) as unknown;
    } catch {
      event[field] = value;
    }
  }
  return event;
}
