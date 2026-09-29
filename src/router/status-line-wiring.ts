import { readFile, stat } from 'node:fs/promises';
import { writeFileAtomic } from '../lib/atomic-json';
import { CliError } from '../lib/errors';
import { inspectHooksFile } from '../lib/harness-hooks';

/**
 * The `statusLine` key in Claude Code's settings file: the one setting the live
 * footer needs, and the one piece of harness configuration a person is most
 * likely to have already set for themselves.
 *
 * SO IT IS NEVER REPLACED. An existing status line that is not ours is left
 * exactly as it is, and `install` prints the composition line instead;
 * `--status-line compose` writes that line only because it was asked for by
 * name. Writing over it and saying so in the output destroys a configuration
 * this CLI did not create.
 *
 * OWNERSHIP IS ONE MARKER, the command naming `tenjin status-line`, used by
 * `install`, `install --refresh`, `uninstall` and `doctor` alike, so the four
 * can never disagree about which status line is Tenjin's.
 */

/** The command `install` registers, in the shape the hook entries use: a plain
 *  command line on PATH, with no path into this build's dist directory. */
export const STATUS_LINE_COMMAND = 'tenjin status-line';
/** Claude Code re-runs the command on this interval, in seconds. */
export const STATUS_LINE_REFRESH_SECONDS = 1;
/** The marker that makes a status line ours, composed or not. */
const OUR_MARKER = STATUS_LINE_COMMAND;

/** What the user asked for, when they asked. Absent means the default path. */
export type StatusLineMode = 'own' | 'compose' | 'skip';

const MODES: readonly StatusLineMode[] = ['own', 'compose', 'skip'];

/** `--status-line <mode>`, refused rather than guessed at. */
export function statusLineMode(value: string): StatusLineMode {
  const mode = MODES.find((known) => known === value);
  if (mode === undefined) {
    throw new CliError('USAGE', `--status-line takes ${MODES.join(', ')}, not "${value}".`, {
      fix: 'Run `tenjin install --status-line own`.',
    });
  }
  return mode;
}

/**
 * What is in the file: ours alone, ours appended to someone else's, someone
 * else's alone, or nothing.
 */
export type StatusLineState = 'ours' | 'composed' | 'foreign' | 'absent';

export interface StatusLineResult {
  path: string;
  state: StatusLineState;
  /** True when this run changed the file. */
  wrote: boolean;
  /** The command now registered, when one of ours is. */
  command?: string;
  /** The exact command to set by hand, printed when a foreign line is kept. */
  compose?: string;
  /** Why nothing was written, for a file this run would not touch. */
  warning?: string;
}

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

function ours(): Record<string, unknown> {
  return {
    type: 'command',
    command: STATUS_LINE_COMMAND,
    refreshInterval: STATUS_LINE_REFRESH_SECONDS,
  };
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
 * composition this build wrote. It is the exact inverse of
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
 * The user's status line with ours appended after a separator, on one line.
 *
 * The harness writes its event on stdin ONCE, so a composition cannot simply
 * run two commands in sequence: the event is captured first and replayed into
 * each. Ours contributes nothing when this session has no activity, and the
 * separator goes with it, so a quiet session looks exactly as it did before.
 */
export function composeCommand(existing: string): string {
  return `sh -c ${shQuote(composedScript(existing))}`;
}

/** The command a status-line setting runs, in either shape it can take. */
function commandOf(value: unknown): string | undefined {
  const command =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as { command?: unknown }).command
        : undefined;
  return typeof command === 'string' && command.trim().length > 0 ? command.trim() : undefined;
}

/** What a foreign status line's owner is told to set, verbatim. */
function composeFor(value: unknown): string | undefined {
  const command = commandOf(value);
  return command === undefined ? undefined : composeCommand(command);
}

export interface EnsureStatusLineOpts {
  mode?: StatusLineMode;
  /**
   * `install --refresh` and the refresh `tenjin update` spawns: converge a
   * status line of ours that is already registered, and ADD NOTHING. A machine
   * whose owner removed ours, or never had it, keeps that answer across every
   * upgrade without a second place to record it.
   */
  refreshOnly?: boolean;
}

export async function ensureStatusLine(
  settingsPath: string,
  opts: EnsureStatusLineOpts = {},
): Promise<StatusLineResult> {
  const found = await inspectHooksFile(settingsPath);
  if ('refusal' in found) {
    return { path: settingsPath, state: 'absent', wrote: false, warning: found.refusal.reason };
  }
  const { path, settings } = found;
  const current = settings.statusLine;
  const state = classifyStatusLine(current);
  if (opts.mode === 'skip') {
    return { path, state, wrote: false, ...(state === 'foreign' ? kept(current) : {}) };
  }
  if (opts.mode === 'compose') {
    const composed = composeFor(current);
    if (composed === undefined) return writeStatusLine(found, ours(), 'ours');
    // THEIR OBJECT, with the command swapped. Rebuilding it from ours would
    // drop whatever else they had set on it, such as their own padding.
    const base =
      typeof current === 'object' && current !== null && !Array.isArray(current)
        ? (current as Record<string, unknown>)
        : ours();
    return state === 'composed'
      ? { path, state, wrote: false, command: composed }
      : writeStatusLine(found, { ...base, command: composed }, 'composed');
  }
  if (state === 'foreign') {
    // NOT REPLACED, AND NOT WRITTEN AROUND. The user keeps what they set, and
    // gets the one command that adds ours to it.
    return { path, state, wrote: false, ...kept(current) };
  }
  if (state === 'composed') return { path, state, wrote: false };
  if (state === 'absent' && opts.refreshOnly === true) {
    return { path, state, wrote: false };
  }
  return writeStatusLine(found, ours(), 'ours');
}

/** `uninstall`: take out a status line of OURS, and only if it is ours alone. */
export async function removeStatusLine(settingsPath: string): Promise<StatusLineResult> {
  const found = await inspectHooksFile(settingsPath);
  if ('refusal' in found) {
    return { path: settingsPath, state: 'absent', wrote: false, warning: found.refusal.reason };
  }
  const { path, settings } = found;
  const current = settings.statusLine;
  const state = classifyStatusLine(current);
  if (state === 'ours') return writeStatusLine(found, undefined, 'absent');
  // A COMPOSED LINE IS MOSTLY THE USER'S TEXT, so it is not deleted: the half
  // this build wrote is unwound and their own command is put back exactly as it
  // was. A composition that was hand-edited since inverts to nothing and is
  // left whole, because guessing at someone's shell is the worse failure.
  if (state === 'composed') {
    const command = commandOf(current);
    const original = command === undefined ? null : decomposeCommand(command);
    if (original === null) return { path, state, wrote: false };
    const kept = { ...(current as Record<string, unknown>), command: original };
    return writeStatusLine(found, kept, 'foreign');
  }
  return { path, state, wrote: false };
}

/** What `doctor` reports, without writing anything. */
export async function inspectStatusLine(
  settingsPath: string,
): Promise<{ path: string; state: StatusLineState; warning?: string }> {
  const found = await inspectHooksFile(settingsPath);
  if ('refusal' in found) {
    return { path: settingsPath, state: 'absent', warning: found.refusal.reason };
  }
  return { path: found.path, state: classifyStatusLine(found.settings.statusLine) };
}

function kept(current: unknown): { compose?: string } {
  const compose = composeFor(current);
  return compose === undefined ? {} : { compose };
}

type Inspection = { path: string; raw: string | null; settings: Record<string, unknown> };

/**
 * One key, written through the same read-compare-write the hooks writer uses:
 * every other key is copied through in its original order, the bytes are
 * re-read before the rename so a concurrent edit is refused rather than lost,
 * and the file keeps its mode.
 */
async function writeStatusLine(
  found: Inspection,
  value: Record<string, unknown> | undefined,
  state: StatusLineState,
): Promise<StatusLineResult> {
  const { path, raw, settings } = found;
  const next: Record<string, unknown> = { ...settings };
  if (value === undefined) delete next.statusLine;
  else next.statusLine = value;
  const body = `${JSON.stringify(next, null, 2)}\n`;
  const result: StatusLineResult = {
    path,
    state,
    wrote: false,
    ...(typeof value?.command === 'string' ? { command: value.command } : {}),
  };
  if (body === raw) return result;
  const mode = await stat(path)
    .then((s) => ({ mode: s.mode & 0o777 }))
    .catch(() => ({}));
  if (raw !== null && (await readFile(path, 'utf8').catch(() => null)) !== raw) {
    return {
      ...result,
      state: classifyStatusLine(settings.statusLine),
      warning: 'changed-since-read',
    };
  }
  try {
    await writeFileAtomic(path, body, mode);
  } catch (err) {
    return {
      ...result,
      state: classifyStatusLine(settings.statusLine),
      warning: err instanceof Error ? err.message : String(err),
    };
  }
  return { ...result, wrote: true };
}
