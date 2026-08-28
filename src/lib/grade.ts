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
  const after = rows.slice(anchor + 1).filter((row) => row.kind === 'tool_use');
  const readRe = target.resourceId === null ? null : readCommandRe(target.resourceId);
  for (const row of after) {
    if (readRe !== null && readRe.test(row.text)) {
      return { outcome: 'used', by: 'read', evidence: cap(row.text) };
    }
    if (target.url !== null && target.url.length > 0 && row.text.includes(target.url)) {
      return { outcome: 'used', by: 'read', evidence: cap(row.text) };
    }
  }
  const spans = backtickSpans(rows[anchor]?.text ?? '');
  for (const row of after.slice(0, SPAN_WINDOW)) {
    const hit = spans.find((span) => row.text.includes(span));
    if (hit !== undefined) return { outcome: 'used', by: 'span', evidence: hit };
  }
  const evidence = after.slice(0, EVIDENCE_ROWS).map(cap);
  return opts.ended ? { outcome: 'rejected', by: 'none', evidence } : { outcome: null, evidence };
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
 * The transcript for a session, or null.
 *
 * BY READDIR, not by mangling the cwd into a directory name. Claude Code names
 * the project directory from the working directory with a substitution this CLI
 * would have to reimplement and keep in step (and which a worktree, a symlinked
 * home or a renamed checkout each break differently); the session id is a uuid
 * and is unique across them, so one listing finds it wherever it landed.
 */
export async function findTranscript(homeDir: string, sessionId: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const projects = join(homeDir, '.claude', 'projects');
  let dirs: string[];
  try {
    dirs = (await readdir(projects, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const path = join(projects, dir, `${sessionId}.jsonl`);
    try {
      const { stat } = await import('node:fs/promises');
      if ((await stat(path)).isFile()) return path;
    } catch {
      // Not in this project directory.
    }
  }
  return null;
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
