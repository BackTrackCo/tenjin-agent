import { styleText } from 'node:util';
import { Stream } from 'node:stream';
import { CliError } from './errors';
import { SCHEMA_VERSION } from '../schemas';
import type { FailureEnvelope, OutputError, SuccessEnvelope } from '../schemas';

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
  /** The global --json flag. When true, the JSON envelope is emitted even at a TTY. */
  json?: boolean;
}

/**
 * The two pure envelope builders, shared by the CLI's emit functions and the MCP
 * adapter so both surfaces produce the identical wire object by construction. They
 * hold no I/O and no --json branching: they turn a (command, data) or a normalized
 * CliError into the exact object that goes to stdout / structuredContent.
 */
export function buildSuccessEnvelope(command: string, data: unknown): SuccessEnvelope {
  return { schemaVersion: SCHEMA_VERSION, command, ok: true, data };
}

export function buildFailureEnvelope(command: string, err: CliError): FailureEnvelope {
  const error: OutputError = {
    code: err.code,
    message: err.message,
    ...(err.fix !== undefined ? { fix: err.fix } : {}),
    ...(err.details !== undefined ? { details: err.details } : {}),
  };
  return { schemaVersion: SCHEMA_VERSION, command, ok: false, error };
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
  writeJson(io.stdout, buildSuccessEnvelope(command, data));
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
    // Scan findings are the one detail shape a human needs inline: without them an
    // interactive publish hitting NEEDS_CONFIRMATION / PUBLISH_BLOCKED sees the
    // count but not WHICH lines tripped. Every other details shape stays machine-only.
    lines.push(...findingLines(io, cliErr.details));
    writeLines(io.stdout, lines);
    return cliErr;
  }
  writeJson(io.stdout, buildFailureEnvelope(command, cliErr));
  return cliErr;
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

/**
 * Render `details.findings` (the scan-finding projection publish attaches to
 * NEEDS_CONFIRMATION / PUBLISH_BLOCKED) as one dim line per finding:
 * `  <check> (line N): <excerpt>`. The excerpt is already masked for secret
 * findings at the source; sanitize it anyway since it can echo file content.
 * Returns [] for any other details shape, so no other error leaks a detail dump.
 */
function findingLines(io: Io, details: unknown): string[] {
  if (typeof details !== 'object' || details === null || !('findings' in details)) return [];
  const { findings } = details as { findings: unknown };
  if (!Array.isArray(findings) || findings.length === 0) return [];
  const rendered: string[] = [];
  for (const f of findings) {
    if (typeof f !== 'object' || f === null) continue;
    const { check, line, excerpt } = f as { check?: unknown; line?: unknown; excerpt?: unknown };
    if (typeof check !== 'string' || typeof line !== 'number' || typeof excerpt !== 'string') {
      continue;
    }
    rendered.push(paint(io, 'dim', `  ${check} (line ${line}): ${sanitizeForTerminal(excerpt)}`));
  }
  return rendered;
}

function writeJson(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeLines(stream: NodeJS.WritableStream, lines: string[]): void {
  if (lines.length > 0) stream.write(`${lines.join('\n')}\n`);
}

/**
 * Color a human line for stdout (the human surface now). styleText emits ANSI only
 * when the target stream is color-capable (a real TTY with color depth) and honors
 * NO_COLOR/FORCE_COLOR natively. The `stream` option is passed only when stdout is
 * a genuine Stream; a test/redirected sink is not one, so it falls back to the
 * default capability check and comes out plain.
 */
function paint(io: Io, format: Parameters<typeof styleText>[0], text: string): string {
  if (io.stdout instanceof Stream) return styleText(format, text, { stream: io.stdout });
  return styleText(format, text);
}
