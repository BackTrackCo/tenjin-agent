import { styleText } from 'node:util';
import { Stream } from 'node:stream';
import { CliError } from './errors';
import { SCHEMA_VERSION } from '../schemas';
import type { OutputError } from '../schemas';

/**
 * Injected streams + TTY fact. Every command receives one via CommandContext,
 * so tests drive the CLI in-process with memory buffers and no child process.
 * `isTTY` is the real terminal fact; the separate `--json` flag (passed to the
 * emit functions) is what suppresses human rendering — the two are ANDed, never
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
  /** The global --json flag. When true, all stderr human rendering is suppressed. */
  json?: boolean;
}

/**
 * Emit exactly one pretty-printed success envelope to stdout. When on a TTY and
 * --json is off, the optional human lines are rendered to stderr (never stdout —
 * stdout stays a clean single JSON object for the agent that piped us).
 */
export function emitSuccess(
  io: Io,
  command: string,
  data: unknown,
  humanLines: string[] = [],
  opts: EmitOptions = {},
): void {
  writeJson(io.stdout, { schemaVersion: SCHEMA_VERSION, command, ok: true, data });
  if (shouldRenderHuman(io, opts) && humanLines.length > 0) {
    writeLines(io.stderr, humanLines);
  }
}

/**
 * Strip C0/C1 control characters and ANSI escape sequences from a string headed
 * for a terminal. Commands apply this to every SERVER-sourced string (titles,
 * handles) they put into human lines or the buy confirm prompt; without it a
 * malicious deployment could use cursor-movement escapes to overwrite the very
 * price a human is being asked to confirm. It is not applied to whole human
 * lines here because trusted callers (doctor) paint their own ANSI colors. JSON
 * stdout is untouched (JSON.stringify escapes control characters itself).
 */
export function sanitizeForTerminal(text: string): string {
  return (
    text
      // CSI/OSC/charset escape sequences first, then any stray ESC and the rest
      // of C0 (except \t) plus DEL and the C1 range.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, '')
  );
}

/**
 * Emit exactly one pretty-printed failure envelope to stdout and (on a TTY, with
 * --json off) a red error line plus a `fix` line to stderr. Accepts a CliError or
 * any thrown value; anything that is not a CliError normalizes to INTERNAL.
 * Returns the normalized CliError so the caller can read its `exitCode`.
 */
export function emitFailure(
  io: Io,
  command: string,
  err: unknown,
  opts: EmitOptions = {},
): CliError {
  const cliErr = normalizeError(err);
  const error: OutputError = {
    code: cliErr.code,
    message: cliErr.message,
    ...(cliErr.fix !== undefined ? { fix: cliErr.fix } : {}),
    ...(cliErr.details !== undefined ? { details: cliErr.details } : {}),
  };
  writeJson(io.stdout, { schemaVersion: SCHEMA_VERSION, command, ok: false, error });
  if (shouldRenderHuman(io, opts)) {
    // Error messages can embed server-sourced text (api error passthrough) and
    // never carry intentional ANSI, so sanitize before painting.
    const lines = [paint(io, 'red', `error: ${sanitizeForTerminal(cliErr.message)}`)];
    if (cliErr.fix !== undefined) {
      lines.push(paint(io, 'dim', `fix: ${sanitizeForTerminal(cliErr.fix)}`));
    }
    writeLines(io.stderr, lines);
  }
  return cliErr;
}

/** CliError passes through; every other thrown value becomes an INTERNAL CliError. */
export function normalizeError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof Error) return new CliError('INTERNAL', err.message, { cause: err });
  return new CliError('INTERNAL', 'Unexpected error', { details: err });
}

function shouldRenderHuman(io: Io, opts: EmitOptions): boolean {
  return io.isTTY && opts.json !== true;
}

function writeJson(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeLines(stream: NodeJS.WritableStream, lines: string[]): void {
  if (lines.length > 0) stream.write(`${lines.join('\n')}\n`);
}

/**
 * Color the human line for stderr. styleText emits ANSI only when the target
 * stream is color-capable (a real TTY with color depth) and honors
 * NO_COLOR/FORCE_COLOR natively (verified on Node 22/23). The `stream` option is
 * passed only when stderr is a genuine Stream — styleText throws on anything
 * else, and a test/redirected sink is not one, so it falls back to the default
 * (process.stdout) capability check and simply comes out plain.
 */
function paint(io: Io, format: Parameters<typeof styleText>[0], text: string): string {
  if (io.stderr instanceof Stream) return styleText(format, text, { stream: io.stderr });
  return styleText(format, text);
}
