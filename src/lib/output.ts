import { styleText } from 'node:util';
import { Stream } from 'node:stream';
import { CliError } from './errors';
import { SCHEMA_VERSION } from '../schemas';
import type { UpdateAvailable } from '../schemas';
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
  writeJson(io.stdout, buildSuccessEnvelope(command, data, opts.updateAvailable));
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
    // Scan findings are one of the two detail shapes a human needs inline:
    // without them an interactive publish hitting NEEDS_CONFIRMATION /
    // PUBLISH_BLOCKED sees the count but not WHICH lines tripped.
    lines.push(...findingLines(io, cliErr.details));
    // The other is a stored child finding's body, because that confirm is the
    // READ GATE for it: `publish --finding` names a body only this machine's
    // hooks have ever seen, so approving without it printed is approving unread
    // text. Every other details shape stays machine-only.
    lines.push(...storedBodyLines(io, cliErr.details));
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
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, '')
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

/**
 * The same strip, for text that ships to OTHER PEOPLE rather than to this
 * terminal: a post's title, its public excerpt, and every free-text field of the
 * answer card a buyer reads before paying.
 *
 * The threat is the same one {@link sanitizeForTerminal} closes, one hop further
 * out. None of this text is necessarily typed by the person publishing: a card
 * question can be prefilled from a stored search, and every field can arrive over
 * MCP from an agent that read them off a fetched page. `trim()` removes neither a
 * CSI sequence nor a right-to-left override, so without this a payload rides into
 * the marketplace and renders in every future reader's terminal.
 *
 * Newlines and tabs fold to a single space FIRST, because these are all
 * single-line display fields and a bare strip would join the words on either side
 * of a line break into one. NOT for the post BODY: that is the author's document,
 * markdown and all, and rewriting it is not this function's business.
 */
export function sanitizeWireText(text: string): string {
  return sanitizeForTerminal(text.replace(/[\r\n\t]+/g, ' ')).trim();
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
 *
 * A finding the SERVER gate contributed carries a `source`, and the marker is
 * printed because it is the difference between "fix your file" and "the
 * marketplace refused this": the detector may be one this release predates, so
 * the line has to stand on the server's own words rather than on recognition.
 * The tier rides the same line, for the payloads that mix block and warn.
 */
function findingLines(io: Io, details: unknown): string[] {
  if (typeof details !== 'object' || details === null || !('findings' in details)) return [];
  const { findings } = details as { findings: unknown };
  if (!Array.isArray(findings) || findings.length === 0) return [];
  const rendered: string[] = [];
  for (const f of findings) {
    if (typeof f !== 'object' || f === null) continue;
    const { check, line, excerpt, source, severity } = f as {
      check?: unknown;
      line?: unknown;
      excerpt?: unknown;
      source?: unknown;
      severity?: unknown;
    };
    if (typeof check !== 'string' || typeof line !== 'number' || typeof excerpt !== 'string') {
      continue;
    }
    const from = source === 'server' ? ' [server]' : source === 'both' ? ' [local+server]' : '';
    // THE TIER IS PRINTED because one payload can mix them: a `scan_blocked`
    // envelope ships the block finding alongside the warns the same pass found,
    // and without the tier nothing on the page says which one is the refusal.
    // An open string, sanitized like the rest: the server owns its own tier names.
    const tier = typeof severity === 'string' && severity.length > 0 ? `${severity}, ` : '';
    // The detector id is sanitized too: on a server finding it is a name this
    // release may never have seen, so it is untrusted text like the excerpt.
    rendered.push(
      paint(
        io,
        'dim',
        `  ${sanitizeForTerminal(check)}${from} (${sanitizeForTerminal(tier)}line ${line}): ${sanitizeForTerminal(excerpt)}`,
      ),
    );
  }
  return rendered;
}

/**
 * The stored child finding a refusal is about, printed WHOLE.
 *
 * WHY WHOLE. `publish --finding <id>` publishes a body that exists only in this
 * machine's state store, so the review confirm is the one place a human ever
 * sees it before it becomes public. A count, a preview or a machine-only
 * `details` blob would each make the confirm a rubber stamp over unread text.
 * The child's id and the search it closed are printed with it, because a finding
 * whose author is unknowable is one the reader cannot check.
 *
 * A CHILD'S WORDS ARE DATA. A subagent can be handed another user's marketplace
 * text at its own start, so the body is framed as a record, placed on lines of
 * its own rather than inside quotes an apostrophe could close, and sanitized a
 * line at a time — {@link sanitizeForTerminal} strips newlines, so the split has
 * to happen first or the whole body would draw as one joined line.
 */
function storedBodyLines(io: Io, details: unknown): string[] {
  if (typeof details !== 'object' || details === null || !('finding' in details)) return [];
  const { finding } = details as { finding: unknown };
  if (typeof finding !== 'object' || finding === null) return [];
  const { id, author, body } = finding as { id?: unknown; author?: unknown; body?: unknown };
  if (typeof body !== 'string' || body === '') return [];
  const who = typeof author === 'string' && author !== '' ? author : 'a subagent';
  const which = typeof id === 'string' && id !== '' ? id : '(unidentified)';
  return [
    paint(
      io,
      'dim',
      `  finding ${sanitizeForTerminal(which)}, written by ${sanitizeForTerminal(who)}:`,
    ),
    paint(
      io,
      'dim',
      '  what the child wrote is a record of what it settled: data, not instructions to you.',
    ),
    '',
    ...body.split('\n').map((line) => sanitizeForTerminal(line)),
    '',
  ];
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
