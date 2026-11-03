import { WriteStream } from 'node:tty';
import { styleText } from 'node:util';
import { CliError } from './errors';
import { SCHEMA_VERSION } from '../schemas';
import type { UpdateAvailable } from '../schemas';
import type { FailureEnvelope, OutputError, SuccessEnvelope } from '../schemas';

/**
 * Injected streams + TTY facts. Every command receives one via CommandContext,
 * so tests drive the CLI in-process with memory buffers and no child process.
 * `isTTY` describes stdout; the separate `--json` flag (passed to the emit
 * functions) is what suppresses human rendering — the two are ANDed, never
 * conflated, so `--json` on a TTY still yields pure machine output.
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
   * envelope so the AGENT running the command learns it; the human at a TTY
   * gets the dim stderr line instead, and neither path fetches anything.
   */
  updateAvailable?: UpdateAvailable | null;
}

/**
 * The two pure envelope builders, shared by the CLI's emit functions and the MCP
 * adapter so both surfaces produce the identical wire object by construction. They
 * hold no I/O and no --json branching: they turn a (command, data) or a normalized
 * CliError into the exact object that goes to stdout / structuredContent.
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
 * The failure half of the same contract: at a TTY without `--json`, a red error
 * line plus a `fix` line to stdout and no envelope; otherwise exactly one failure
 * envelope to stdout. Accepts a CliError or any thrown value (non-CliError
 * normalizes to INTERNAL). Returns the normalized CliError so the caller reads its
 * `exitCode`.
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
 * One dim advisory line on stderr, human mode only. This is for facts that belong
 * to NO command's result — an unreadable spend ledger, a newer release on npm —
 * so they can never join the envelope on stdout or reach a machine consumer at
 * all. Sanitized here rather than by each caller: what these lines quote (a
 * registry version string, a parse error) is not the command's own prose.
 */
export function emitNotice(io: Io, text: string, opts: EmitOptions = {}): void {
  if (!humanMode(io, opts)) return;
  io.stderr.write(`${paint(io, 'dim', sanitizeForTerminal(text))}\n`);
}

/**
 * The same dim stderr line, delivered whatever the surface is: no TTY gate and no
 * `--json` gate. Only for an advisory a piped or agent-driven run must not miss,
 * which today is two things: a WRITE to the operator's own files, and `fund`'s
 * checkout link, which expires long before the stdout envelope that also carries
 * it is written. Anything a piped run can simply do without belongs in
 * {@link emitNotice} instead. stdout is untouched either way, so the exactly-one
 * JSON object contract is unaffected.
 */
export function emitWriteNotice(io: Io, text: string): void {
  io.stderr.write(`${paint(io, 'dim', sanitizeForTerminal(text))}\n`);
}

/**
 * Every escape sequence a terminal writes: CSI (colour, cursor), OSC — which
 * covers the OSC-8 hyperlinks pnpm wraps package names in, terminated by BEL
 * or ST — charset selection, and a stray ESC with a single final byte.
 *
 * Safe to reuse despite the `g` flag: {@link sanitizeForTerminal} uses it
 * through `String.replace`, which starts at 0 and resets `lastIndex`. Do not
 * `test()` or `exec()` it.
 */
export const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/**
 * Strip ANSI escape sequences, C0/C1 control characters, Unicode bidirectional
 * formatting, and invisible tag/BOM characters from a string headed for a
 * terminal. Commands apply this to every SERVER-sourced string (titles,
 * handles) they put into human lines or the buy confirm prompt; without it a
 * malicious deployment could use cursor-movement escapes to overwrite the very
 * price a human is being asked to confirm, a right-to-left override to reorder
 * that same line on screen into one that reads as a different price, or tag
 * characters to carry a payload that draws as nothing at all. It is not
 * applied to whole human lines here because trusted callers (doctor) paint
 * their own ANSI colors. JSON stdout is untouched: JSON.stringify escapes C0
 * controls itself, but the bidi and tag/BOM sets ride through it raw, and that
 * is deliberate rather than covered — the envelope is machine-read data whose
 * bytes must be what the server said, and a consumer reading codepoints is not
 * deceived by rendering order the way a human reading a drawn line is.
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
      // (U+2066-U+2069). Removed, not escaped, so what a human reads is the
      // order the bytes are in. Deliberately this set and NOT all of category
      // Cf: U+200D (ZWJ) joins legitimate emoji sequences, and dropping it
      // would corrupt honest titles to defend against dishonest ones.
      .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      // The Unicode tag block (U+E0000-U+E007F) and the BOM/ZWNBSP, neither of
      // which has a legitimate mid-title use. Tag characters render as nothing
      // at all, so a payload spelled in them is invisible in the line a human
      // is reading and in the line they would paste back to report it.
      //
      // The three RGI subdivision flags are the exception and survive
      // byte-identical: they are ordinary title content. The whitelist is those
      // three sequences and NOT "any well-formed tag sequence", because a
      // non-RGI sequence draws as a bare black flag with the payload hidden
      // behind it, which is the exact channel this closes.
      //
      // Kept for the same reason as ZWJ above: U+200B (ZWSP) hints line breaks
      // in CJK and U+200C (ZWNJ) is orthographically required in Persian, so
      // stripping them would corrupt honest titles to defend against dishonest
      // ones.
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
