import { CliError } from './errors';

/**
 * Did the agent USE what a push arm showed it? The transcript is the only place
 * that answer exists.
 *
 * The arms record what they injected (`injections`), and the shelf records what
 * it served, but neither can see what happened next: the finding lands as
 * additional context in the agent's turn, and from there it is either acted on
 * or it is not. Nobody reports that, so nothing has ever closed the loop on the
 * push experiment's own precision.
 *
 * WHAT COUNTS AS EVIDENCE, and why it is only ever a TOOL INPUT. An agent that
 * says "as the Tenjin note suggests" in prose has said nothing checkable — the
 * words are cheap, the sentence is generated beside a hundred others, and prose
 * agreeing with an injection is exactly what an injection makes likely whether
 * or not it helped. A tool call is a decision the agent spent something on. So
 * this reads two kinds of row and no others: the `hook_additional_context`
 * attachment that carries the injection (the anchor), and every later
 * `tool_use` block's input, serialized whole so a command, an edit's new text
 * and a written file all read the same way.
 *
 * TWO VERDICTS FOR "USED", ONE WEAK. Explicit `tenjin read|inspect <id>`, or the
 * injected url appearing in a tool input, is the agent following the pointer:
 * that is `read`, and it counts anywhere later in the session, because a piece
 * bought twenty tool calls after it was shown is still a piece the injection
 * sold. A backtick span copied out of the injected text is much weaker — it may
 * be a command the agent would have run anyway — so it counts only inside
 * {@link SPAN_WINDOW} tool calls of the anchor, needs at least two words, and is
 * reported to the shelf as `partially_used` rather than `used`.
 *
 * NOTHING IS NOT REJECTION UNTIL THE SESSION IS OVER. A row whose session is
 * still running has simply not been answered yet, and grading it `rejected`
 * would post a verdict the next tool call could contradict. So "nothing matched"
 * becomes `rejected` only once the session has ended — `sessions.ended_at`, or a
 * transcript nothing has written to for {@link ENDED_AFTER_MS}.
 *
 * RELAYED ROWS ANCHOR ON THE FIRST TOOL CALL. The subagent arm hands its finding
 * to a child at SubagentStart, and that text reaches no transcript at all: the
 * child is given it as its opening context, and neither the parent's file nor
 * the child's records a `hook_additional_context` row for it. So there is no
 * anchor to find, and there does not need to be — the pointer preceded every
 * call the child ever made, which makes the child's FIRST tool call evidence
 * rather than the row after the anchor. {@link gradeRelayed} judges from there,
 * inclusively, while {@link gradeInjection} keeps its exclusive `anchor + 1`.
 *
 * A relayed row also has no injected text on disk to take spans from — the arm
 * renders a title, a price and possibly a fetched body, and stores none of it —
 * so its span evidence comes from the piece's TITLE alone, which is usually no
 * spans at all. Relayed findings are therefore judged almost entirely on the
 * strong evidence (an explicit read, or the url), which is the right way round.
 * Storing the injected text is a second schema change and is not this one.
 *
 * The functions here are pure over parsed rows, except the two that touch the
 * filesystem at the bottom; the command in commands/push.ts owns the store.
 */

/** How many tool calls after the anchor a copied span may still be evidence. */
export const SPAN_WINDOW = 10;

/** A transcript nothing has appended to for this long belongs to a session that
 *  is over, whether or not a Stop hook ever stamped `ended_at` (a crashed or
 *  killed harness never does). */
export const ENDED_AFTER_MS = 30 * 60_000;

/** How many tool inputs `--explain` shows for a rejected row, and how much of
 *  each: enough to see what the agent did instead, not a transcript dump. */
const EVIDENCE_ROWS = 3;
const EVIDENCE_CHARS = 200;

/** A session id is used as a filename, so it is checked like one. */
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,80}$/;

/** An agent id becomes a filename too (`agent-<id>.jsonl`), so it gets the same
 *  treatment. This is the SAME bound the hook prelude's `identityOf` applies
 *  before it records one; a test in grade.test.ts pins the two together, because
 *  an id one side accepts and the other refuses is a row that can never be
 *  graded. */
export const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** The only two row kinds that decide anything; see the module note. */
export interface TranscriptRow {
  /** 1-based line number in the JSONL, for `--explain`. */
  line: number;
  kind: 'context' | 'tool_use';
  text: string;
}

export interface GradeTarget {
  resourceId: string | null;
  url: string | null;
  title: string | null;
}

export type Verdict =
  | { outcome: 'used'; by: 'read' | 'span'; evidence: string }
  | { outcome: 'rejected'; by: 'none'; evidence: string[] }
  | { outcome: 'unobserved'; by: 'none' }
  /** Still open: the session may yet answer, so nothing is written. */
  | { outcome: null; evidence: string[] };

/**
 * The transcript, reduced to the rows that can decide a verdict.
 *
 * A malformed line is skipped rather than failing the parse: a transcript being
 * appended to while this runs can end mid-line, and one truncated row is not a
 * reason to refuse to grade a session.
 *
 * `isCompactSummary` rows are dropped. A compaction REPLAYS earlier tool calls
 * into a summary the assistant then carries, so counting them would let one
 * injection be "used" by the echo of a call that happened before it was shown.
 */
export function parseTranscript(jsonl: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined || raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const line = i + 1;
    const attachment = parsed.attachment;
    if (isRecord(attachment) && attachment.type === 'hook_additional_context') {
      rows.push({ line, kind: 'context', text: contextText(attachment.content) });
      continue;
    }
    if (parsed.type !== 'assistant' || parsed.isCompactSummary === true) continue;
    const message = parsed.message;
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== 'tool_use') continue;
      rows.push({ line, kind: 'tool_use', text: JSON.stringify(block.input ?? null) });
    }
  }
  return rows;
}

/**
 * Where the injection landed, as an index into `rows`, or -1.
 *
 * THE FIRST MATCH, not the nearest one after the row's timestamp. The
 * `injections_shown_once` index makes one injected row per (session,
 * resourceId), so there is only ever one context row naming a given piece, and
 * matching it by content beats matching it by clock: the hook's `at` and the
 * transcript's line order are written by different processes.
 *
 * Id, then url, then title, weakest last: a title is display text that could
 * appear in an unrelated context row, so it is what is tried when the piece has
 * nothing more specific to be found by.
 */
export function findAnchor(rows: TranscriptRow[], target: GradeTarget): number {
  for (const needle of [target.resourceId, target.url, target.title]) {
    if (needle === null || needle.length === 0) continue;
    const at = rows.findIndex((row) => row.kind === 'context' && row.text.includes(needle));
    if (at !== -1) return at;
  }
  return -1;
}

/**
 * The backtick spans in the injected text worth looking for later: at least two
 * whitespace-separated words, deduped.
 *
 * TWO WORDS IS THE FLOOR because one is noise. A note names `pnpm`, `useEffect`
 * or a filename, the agent types the same token in the next command, and a
 * one-word rule calls that reuse — on a machine where the agent was going to
 * type it anyway. Two words is a phrase somebody copied.
 */
export function backtickSpans(text: string): string[] {
  const spans = new Set<string>();
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const span = (match[1] ?? '').trim();
    if (span.split(/\s+/).filter((w) => w.length > 0).length >= 2) spans.add(span);
  }
  return [...spans];
}

/**
 * The verdict for one injection, given its transcript and its anchor.
 *
 * Read beats span: both may be present, and "the agent went and read the piece"
 * is the stronger claim, so it is the one reported.
 */
export function gradeInjection(
  rows: TranscriptRow[],
  anchor: number,
  target: GradeTarget,
  opts: { ended: boolean },
): Verdict {
  if (anchor < 0 || anchor >= rows.length) return { outcome: 'unobserved', by: 'none' };
  // EXCLUSIVE: the anchor row IS the injection, so the calls that can answer for
  // it are the ones after it.
  const after = rows.slice(anchor + 1).filter((row) => row.kind === 'tool_use');
  return judge(after, backtickSpans(rows[anchor]?.text ?? ''), target, opts.ended);
}

/**
 * Where a relayed finding's evidence starts: the first `tool_use` row, or -1.
 *
 * The caller reports it as the anchor line under `--explain`, so a verdict on a
 * child still names the row it was read from.
 */
export function firstToolCall(rows: TranscriptRow[]): number {
  return rows.findIndex((row) => row.kind === 'tool_use');
}

/**
 * The verdict for a finding RELAYED to a subagent, given that child's own
 * transcript.
 *
 * INCLUSIVE OF THE FIRST CALL, and with no anchor at all — see the module note.
 * A child that made no tool calls has done nothing that could be evidence, so it
 * is `rejected` once it is over and open while it runs, exactly as an
 * unanswered main-session row is.
 */
export function gradeRelayed(
  rows: TranscriptRow[],
  target: GradeTarget,
  opts: { ended: boolean },
): Verdict {
  const calls = rows.filter((row) => row.kind === 'tool_use');
  // The title is the only injected text this row left on disk; usually it holds
  // no two-word backtick span at all, and that is the documented limit of what
  // a relayed row can be judged `span` on.
  return judge(calls, backtickSpans(target.title ?? ''), target, opts.ended);
}

/**
 * The evidence rules themselves, over whichever tool calls the caller decided
 * are eligible. Shared byte-for-byte by both verdict functions, so a relayed row
 * and a main-session row can never drift into being judged by different rules.
 *
 * Read beats span: both may be present, and "the agent went and read the piece"
 * is the stronger claim, so it is the one reported.
 */
function judge(
  after: TranscriptRow[],
  spans: string[],
  target: GradeTarget,
  ended: boolean,
): Verdict {
  const readRe = target.resourceId === null ? null : readCommandRe(target.resourceId);
  for (const row of after) {
    if (readRe !== null && readRe.test(row.text)) {
      return { outcome: 'used', by: 'read', evidence: cap(row.text) };
    }
    if (target.url !== null && target.url.length > 0 && row.text.includes(target.url)) {
      return { outcome: 'used', by: 'read', evidence: cap(row.text) };
    }
  }
  for (const row of after.slice(0, SPAN_WINDOW)) {
    const hit = spans.find((span) => row.text.includes(span));
    // Capped like every other evidence string here: the span is copied out of
    // injected text, which came off a shelf, and `--explain` prints it.
    if (hit !== undefined) return { outcome: 'used', by: 'span', evidence: cap(hit) };
  }
  const evidence = after.slice(0, EVIDENCE_ROWS).map(cap);
  return ended ? { outcome: 'rejected', by: 'none', evidence } : { outcome: null, evidence };
}

/** `7d`, `24h`, `30m` as milliseconds. Anything else is a usage error rather
 *  than a silent default, so a typo cannot quietly widen or narrow a sweep. */
export function parseSince(text: string): number {
  const match = /^(\d+)([dhm])$/.exec(text.trim());
  const value = match === null ? 0 : Number(match[1]);
  if (match === null || value <= 0) {
    throw new CliError('USAGE', `Invalid --since window: ${JSON.stringify(text)}`, {
      fix: 'Pass a window like 7d, 24h or 30m.',
    });
  }
  const unit = { d: 24 * 60 * 60_000, h: 60 * 60_000, m: 60_000 }[match[2] as 'd' | 'h' | 'm'];
  return value * unit;
}

/**
 * Where a session's transcript is, or WHY there is none.
 *
 * `absent` is a FACT ABOUT THE SESSION: the projects directory was listed and
 * holds no file for it. `unreadable` is a fact about this machine right now —
 * no projects directory, a home that is not mounted, a permissions change
 * mid-run — and says nothing about the session at all.
 */
export type TranscriptLookup =
  { kind: 'found'; path: string } | { kind: 'absent' } | { kind: 'unreadable'; reason: string };

/**
 * The transcript for a session, or for one subagent of it, or why it was not
 * found.
 *
 * BY READDIR, not by mangling the cwd into a directory name. Claude Code names
 * the project directory from the working directory with a substitution this CLI
 * would have to reimplement and keep in step (and which a worktree, a symlinked
 * home or a renamed checkout each break differently); the session id is a uuid
 * and is unique across them, so one listing finds it wherever it landed.
 *
 * WITH AN AGENT ID IT IS A DIFFERENT FILE, not a different search: a subagent
 * writes to `<session>/subagents/agent-<id>.jsonl` beside the parent's
 * `<session>.jsonl`, under the same project directory. The child's tool calls
 * appear in NO parent file, so a row stamped with an agent id is answered only
 * here.
 *
 * THE TWO NEGATIVE ANSWERS ARE NOT THE SAME ANSWER, and collapsing them to
 * `null` is how a transient fault becomes permanent: the caller turns "no
 * transcript" into `unobserved`, `unobserved` is a verdict, and a verdict is
 * never re-graded. One run under a home directory that could not be read would
 * have closed every open row on the machine as never-seen, with no way back.
 */
export async function findTranscript(
  homeDir: string,
  sessionId: string,
  agentId: string | null = null,
): Promise<TranscriptLookup> {
  // An id that cannot be a filename names no transcript in any project
  // directory, now or ever: that is absence, and it is permanent.
  if (!SESSION_ID_RE.test(sessionId)) return { kind: 'absent' };
  if (agentId !== null && !AGENT_ID_RE.test(agentId)) return { kind: 'absent' };
  const { readdir, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const projects = join(homeDir, '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = (await readdir(projects, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    // A missing projects directory included: a machine where the harness has
    // never run, or has not run yet, has not told us anything about this row.
    return { kind: 'unreadable', reason: errorReason(err) };
  }
  let blocked: string | null = null;
  for (const dir of dirs) {
    const path =
      agentId === null
        ? join(projects, dir, `${sessionId}.jsonl`)
        : join(projects, dir, sessionId, 'subagents', `agent-${agentId}.jsonl`);
    try {
      if ((await stat(path)).isFile()) return { kind: 'found', path };
    } catch (err) {
      // ENOENT is the ordinary answer — the session is simply not in THIS
      // project directory, and on the child path its `<session>/` directory may
      // not exist at all (ENOENT, or ENOTDIR where a plain file sits where the
      // directory would be). Anything else is a directory that could be hiding
      // it, so the sweep can no longer claim the file is absent.
      const code = errorCode(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') blocked ??= errorReason(err);
    }
  }
  return blocked === null ? { kind: 'absent' } : { kind: 'unreadable', reason: blocked };
}

/** Has nothing been appended to this transcript for {@link ENDED_AFTER_MS}? The
 *  half of "the session is over" that survives a harness which never stopped
 *  cleanly and so never stamped `ended_at`. Unreadable reads as NOT idle: an
 *  unknown must never manufacture a `rejected`. */
export async function transcriptIdle(path: string, nowMs: number): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    return nowMs - (await stat(path)).mtimeMs > ENDED_AFTER_MS;
  } catch {
    return false;
  }
}

/** An errno if the platform gave one, else the message: short enough to print
 *  on the one `--explain` line that says why a row was left alone. Exported so
 *  the caller's own read of the file it was handed reports failures in the same
 *  words this one does. */
export function errorReason(err: unknown): string {
  const code = errorCode(err);
  if (code !== null) return code;
  return cap(err instanceof Error ? err.message : 'unknown error');
}

function errorCode(err: unknown): string | null {
  return isRecord(err) && typeof err.code === 'string' ? err.code : null;
}

function readCommandRe(resourceId: string): RegExp {
  return new RegExp(`tenjin\\s+(?:read|inspect)\\s+${escapeRe(resourceId)}`);
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cap(row: TranscriptRow | string): string {
  const text = typeof row === 'string' ? row : row.text;
  return text.length > EVIDENCE_CHARS ? `${text.slice(0, EVIDENCE_CHARS)}…` : text;
}

/**
 * The injected text, whatever shape the attachment carried it in: a bare string,
 * an array of strings, or an array of `{ type: 'text', text }` blocks. All three
 * appear, and the anchor match only needs the words.
 */
function contextText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') parts.push(item);
    else if (isRecord(item) && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
