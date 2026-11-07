import { WriteStream } from 'node:tty';
import { styleText } from 'node:util';
import { CliError } from './errors';
import { SCHEMA_VERSION } from '../schemas';
import type { UpdateAvailable } from '../schemas';
import type { FailureEnvelope, OutputError, SuccessEnvelope } from '../schemas';

/**
 * Injected streams and TTY facts, so tests drive the CLI in-process with memory
 * buffers. `isTTY` describes stdout; `--json` is a separate flag, so `--json`
 * on a TTY still yields pure machine output.
 */
export interface Io {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  isTTY: boolean;
}

export function defaultIo(): Io {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: Boolean(process.stdout.isTTY),
  };
}

export interface EmitOptions {
  /** The global --json flag. When true, the JSON envelope is emitted even at a TTY. */
  json?: boolean;
  /** Keep a complete agent handoff on one line, including through `tail`. */
  compactJson?: boolean;
  /**
   * "A newer tenjin-cli exists", from the daily check's cache. Rides the
   * envelope so an agent learns it; a human at a TTY gets a stderr line.
   */
  updateAvailable?: UpdateAvailable | null;
}

/**
 * The pure envelope builders, shared by the CLI's emit functions and the MCP
 * adapter so both surfaces produce the same wire object.
 */
export function buildSuccessEnvelope(
  command: string,
  data: unknown,
  updateAvailable?: UpdateAvailable | null,
): SuccessEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: true,
    data,
    ...(updateAvailable != null ? { updateAvailable: updateAvailable } : {}),
  };
}

export function buildFailureEnvelope(
  command: string,
  err: CliError,
  updateAvailable?: UpdateAvailable | null,
): FailureEnvelope {
  const error: OutputError = {
    code: err.code,
    message: err.message,
    ...(err.fix !== undefined ? { fix: err.fix } : {}),
    ...(err.details !== undefined ? { details: err.details } : {}),
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    command,
    ok: false,
    error,
    ...(updateAvailable != null ? { updateAvailable: updateAvailable } : {}),
  };
}

/**
 * Output contract (human-first): at a TTY without `--json`, print ONLY the human
 * rendering to stdout, no JSON envelope. With `--json`, or when stdout is not a
 * TTY (a pipe, an agent), print exactly one JSON envelope to stdout and nothing
 * else. Exit codes are identical on both paths; only the stdout shape differs.
 */
export function emitSuccess(
  io: Io,
  command: string,
  data: unknown,
  humanLines: string[] = [],
  opts: EmitOptions = {},
): void {
  if (humanMode(io, opts)) {
    writeLines(io.stdout, humanLines);
    return;
  }
  writeJson(io.stdout, buildSuccessEnvelope(command, data, opts.updateAvailable), opts.compactJson);
}

/**
 * The failure half of the same contract: a red error line and a `fix` line in
 * human mode, otherwise one failure envelope. Returns the normalized CliError so
 * the caller reads its `exitCode`.
 */
export function emitFailure(
  io: Io,
  command: string,
  err: unknown,
  opts: EmitOptions = {},
): CliError {
  const cliErr = normalizeError(err);
  if (humanMode(io, opts)) {
    // Error messages can embed server-sourced text (api error passthrough) and
    // never carry intentional ANSI, so sanitize before painting.
    const lines = [paint(io, 'red', `error: ${sanitizeForTerminal(cliErr.message)}`)];
    if (cliErr.fix !== undefined) {
      lines.push(paint(io, 'dim', `fix: ${sanitizeForTerminal(cliErr.fix)}`));
    }
    // `details` is machine-only: a human sees the message and the fix.
    writeLines(io.stdout, lines);
    return cliErr;
  }
  writeJson(io.stdout, buildFailureEnvelope(command, cliErr, opts.updateAvailable));
  return cliErr;
}

/**
 * One dim advisory line on stderr, human mode only, for facts that belong to no
 * command's result (an unreadable spend ledger, a newer release). Sanitized
 * here because what these lines quote is not the command's own prose.
 */
export function emitNotice(io: Io, text: string, opts: EmitOptions = {}): void {
  if (!humanMode(io, opts)) return;
  io.stderr.write(`${paint(io, 'dim', sanitizeForTerminal(text))}\n`);
}

/**
 * The same dim stderr line on every surface, with no TTY or `--json` gate. Only
 * for what a piped run must not miss: a write to the operator's own files, or
 * `fund`'s checkout link, which expires before the stdout envelope is written.
 * Everything else belongs in {@link emitNotice}. stdout is untouched.
 */
export function emitWriteNotice(io: Io, text: string): void {
  io.stderr.write(`${paint(io, 'dim', sanitizeForTerminal(text))}\n`);
}

/**
 * Every escape sequence a terminal writes: CSI (colour, cursor), OSC (including
 * the OSC-8 hyperlinks pnpm wraps package names in, ended by BEL or ST),
 * charset selection, and a stray ESC with a single final byte.
 *
 * Safe to reuse despite the `g` flag only through `String.replace`, which
 * resets `lastIndex`. Do not `test()` or `exec()` it.
 */
export const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/**
 * Strip ANSI escapes, C0/C1 controls, Unicode bidi formatting, and invisible
 * tag/BOM characters from a string headed for a terminal. Commands apply it to
 * every server-sourced string in human lines or the pay confirm prompt, since a
 * hostile server could otherwise overwrite or reorder the price a human is
 * confirming, or hide a payload in characters that draw as nothing. Not applied
 * to whole lines because trusted callers (doctor) paint their own colors.
 * JSON stdout keeps the server's bytes on purpose: a machine reading
 * codepoints is not fooled by rendering order the way a human is.
 */
export function sanitizeForTerminal(text: string): string {
  return (
    text
      // CSI/OSC/charset escape sequences first, then any stray ESC and the rest
      // of C0 (except \t) plus DEL and the C1 range.
      .replace(ANSI_ESCAPE_RE, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, '')
      // The UAX#9 directional formatting set: the marks (LRM/RLM/ALM), the
      // embeddings and overrides (U+202A-U+202E), and the isolates
      // (U+2066-U+2069), so a human reads the bytes in order. Not all of Cf:
      // U+200D (ZWJ) joins legitimate emoji sequences.
      .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      // The Unicode tag block (U+E0000-U+E007F) and the BOM/ZWNBSP: tag
      // characters render as nothing, so a payload in them is invisible.
      // The three RGI subdivision flags survive byte-identical; any other tag
      // sequence draws as a bare black flag with the payload hidden behind it.
      // U+200B (ZWSP, CJK line breaks) and U+200C (ZWNJ, required in Persian)
      // stay, like ZWJ above.
      .replace(
        /(\u{1F3F4}\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F})|[\u{E0000}-\u{E007F}\u{FEFF}]/gu,
        (_match, rgiFlag: string | undefined) => rgiFlag ?? '',
      )
  );
}

/** CliError passes through; every other thrown value becomes an INTERNAL CliError. */
export function normalizeError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof Error) return new CliError('INTERNAL', err.message, { cause: err });
  return new CliError('INTERNAL', 'Unexpected error', { details: err });
}

/** True in human-first mode: a TTY without --json. Otherwise the JSON envelope wins. */
function humanMode(io: Io, opts: EmitOptions): boolean {
  return io.isTTY && opts.json !== true;
}

function writeJson(stream: NodeJS.WritableStream, value: unknown, compact = false): void {
  stream.write(`${JSON.stringify(value, null, compact ? undefined : 2)}\n`);
}

function writeLines(stream: NodeJS.WritableStream, lines: string[]): void {
  if (lines.length > 0) stream.write(`${lines.join('\n')}\n`);
}

export type StyleFormat = Parameters<typeof styleText>[0];

/**
 * Does `stream` take ANSI color? Node's own rule (`shouldColorize`): FORCE_COLOR
 * wins when set, otherwise a TTY whose color depth is above 2 (which reads
 * NO_COLOR, NODE_DISABLE_COLORS and TERM). Decided here because styleText only
 * checks the stream from Node 22.13 and colors unconditionally before it.
 */
export function colorCapable(stream: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined) return ['', '1', 'true', '2', '3'].includes(force);
  return stream instanceof WriteStream && stream.isTTY && stream.getColorDepth(env) > 2;
}

/** `text` in `format` when `stream` takes color, else plain. */
export function style(format: StyleFormat, text: string, stream: unknown = process.stdout): string {
  return colorCapable(stream) ? styleText(format, text, { validateStream: false }) : text;
}

/** Color a human line for stdout. A test or redirected sink is no TTY, so it comes out plain. */
export function paint(io: Io, format: StyleFormat, text: string): string {
  return style(format, text, io.stdout);
}
