/**
 * The `statusLine` key in Claude Code's settings file, as releases up to
 * alpha.26 wrote it. `install` no longer sets it (a plugin cannot), so the
 * router reads this module only to recognise a status line an earlier release
 * wrote and take it back (`legacy-install.ts`).
 *
 * OWNERSHIP IS ONE MARKER, the command naming `tenjin status-line`, so a status
 * line that is not Tenjin's is never touched.
 */

/** The command an earlier `install` registered. */
export const STATUS_LINE_COMMAND = 'tenjin status-line';
/** The marker that makes a status line ours, composed or not. */
const OUR_MARKER = STATUS_LINE_COMMAND;

/**
 * What is in the file: ours alone, ours appended to someone else's, someone
 * else's alone, or nothing.
 */
export type StatusLineState = 'ours' | 'composed' | 'foreign' | 'absent';

export function classifyStatusLine(value: unknown): StatusLineState {
  if (value === null || value === undefined) return 'absent';
  const command =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && !Array.isArray(value)
        ? (value as { command?: unknown }).command
        : undefined;
  // A status line whose command this build cannot read is still the user's.
  if (typeof command !== 'string' || command.trim().length === 0) return 'foreign';
  if (command.trim() === OUR_MARKER) return 'ours';
  return command.includes(OUR_MARKER) ? 'composed' : 'foreign';
}

const shQuote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;
const shUnquote = (value: string): string => value.replaceAll(String.raw`'\''`, "'");

/** The inner script, with the user's own command as the one hole in it. */
function composedScript(existing: string): string {
  return [
    'event=$(cat)',
    `yours=$(printf %s "$event" | ${existing})`,
    `tenjin=$(printf %s "$event" | ${STATUS_LINE_COMMAND})`,
    'printf %s "$yours${tenjin:+ · $tenjin}"',
  ].join('; ');
}

/**
 * The command a composition was built from, or null when this is not a
 * composition an earlier release wrote. It is the exact inverse of
 * {@link composeCommand}: a hand-edited line matches nothing and is kept whole,
 * because guessing at someone's shell is how an uninstall breaks a prompt.
 */
export function decomposeCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed.startsWith("sh -c '") || !trimmed.endsWith("'")) return null;
  const script = shUnquote(trimmed.slice("sh -c '".length, -1));
  const prefix = 'event=$(cat); yours=$(printf %s "$event" | ';
  if (!script.startsWith(prefix)) return null;
  const rest = script.slice(prefix.length);
  const suffix = `); tenjin=$(printf %s "$event" | ${STATUS_LINE_COMMAND}); printf %s "$yours\${tenjin:+ · $tenjin}"`;
  if (!rest.endsWith(suffix)) return null;
  const existing = rest.slice(0, -suffix.length);
  return existing.length > 0 && composedScript(existing) === script ? existing : null;
}

/**
 * The user's status line with ours appended after a separator, on one line, as
 * an earlier `install --status-line compose` wrote it. The harness writes its
 * event on stdin ONCE, so the event is captured first and replayed into each.
 */
export function composeCommand(existing: string): string {
  return `sh -c ${shQuote(composedScript(existing))}`;
}
