import type { EngineInterface } from 'claude-code';

/**
 * WHAT THE MOD'S MODULES SHARE, one copy each: where the CLI keeps its data,
 * the hash the CLI names its records by, a JSON reader that never throws, the
 * cleaning every outside string gets before a terminal shows it, and the
 * plugin's one status entry. `register.tsx`, `agents.tsx`, `effort.ts` and
 * `effort-turn.ts` import it, since a module of the mod may import another by a
 * relative path (`MOD_FILES` ships each).
 */

type Dollar = EngineInterface;
export type Json = Record<string, unknown>;

/** The CLI's data dir: `TENJIN_DATA_DIR`, else `~/.tenjin`; null with no home. */
export async function tenjinDataDir($: Dollar): Promise<string | null> {
  const override = await $.env.get('TENJIN_DATA_DIR');
  if (override !== undefined && override.length > 0) return override;
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'));
  return home !== undefined && home.length > 0 ? `${home}/.tenjin` : null;
}

/** Hex SHA-256, the name the CLI gives a session's, a call's or a turn's record. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A file's JSON object, or null when it is absent, unreadable, not JSON or not an object. */
export async function readJson($: Dollar, path: string): Promise<Json | null> {
  try {
    return asRecord(parseJson(await $.fs.read(path))) ?? null;
  } catch {
    return null;
  }
}

export function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** Outside text is hostile on a terminal: control and format characters go. */
export function clean(value: string, limit: number): string {
  const text = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join('')}…`;
}

// THE STATUS ENTRY ------------------------------------------------------------

/** The parts of the entry, in the order it shows them. */
const STATUS_PARTS = ['subagents', 'turns'] as const;
export type StatusPart = (typeof STATUS_PARTS)[number];

/**
 * ONE `$.ui.status` ENTRY FOR THE PLUGIN, which a later call replaces: the
 * delegated tasks' counts (`agents.tsx`) and the main agent's turn counts
 * (`effort.ts`) share it as two parts, `Tenjin subagents: … | turns: …`, each
 * drawn alone when the other has nothing to say. A part set to undefined
 * leaves, and the entry clears when none is left. An unchanged part draws
 * nothing. Memory per load: a reload starts empty, and the next count redraws.
 */
export function createStatus(): Status {
  return { parts: new Map() };
}

export type Status = { parts: Map<StatusPart, string> };

/** Set one part of the entry and draw the whole of it. */
export function showStatus(
  $: Dollar,
  status: Status,
  part: StatusPart,
  text: string | undefined,
): void {
  const { parts } = status;
  if (parts.get(part) === text) return;
  if (text === undefined) parts.delete(part);
  else parts.set(part, text);
  const shown = STATUS_PARTS.flatMap((key) => {
    const value = parts.get(key);
    return value === undefined ? [] : [`${key}: ${value}`];
  });
  $.ui.status(shown.length === 0 ? undefined : `Tenjin ${shown.join(' | ')}`);
}
