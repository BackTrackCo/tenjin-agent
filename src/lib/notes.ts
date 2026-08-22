/**
 * The team notes store (plan of record: tenjin-notes/plans/sidecar/README.md).
 * A note is a durable, reusable finding — a probe result, a version-specific
 * gotcha, a tested workaround — worth one team never re-discovering twice. Notes
 * live as flat markdown files with a tiny hand-rolled front matter (no YAML
 * library) inside a `notes` git clone under the data dir, so `tenjin team sync`
 * is a plain `git pull --rebase && git push` and the repo is readable with `cat`.
 *
 * The parser here is MIRRORED as plain JS inside the generated push-hook core
 * (lib/push-scripts.ts) so the team shelf can be searched from a hook with no
 * import of this module possible; keep both trivially parseable and change them
 * together.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-json';
import { notesDir, pushDir } from './paths';

export interface Note {
  id: string;
  question: string;
  appliesTo: string[];
  scope: string;
  asOf: string;
  author: string;
  source: string;
  visibility: string;
  body: string;
}

/** `<yyyymmdd>-<6 lowercase base36>`, e.g. `20260822-k3x9q2`. */
export const NOTE_ID_RE = /^\d{8}-[a-z0-9]{6}$/;

const FRONT_MATTER_DELIM = '---';

/** The directory each note file lives in: `<notesDir>/notes/<id>.md`. */
export function noteFilesDir(dataDir: string): string {
  return join(notesDir(dataDir), 'notes');
}

/** `yyyymmdd-xxxxxx`: a sortable date prefix (also sorts notes newest-first as
 *  plain strings) plus six random base36 characters, collision-safe enough for
 *  one team's daily note volume. */
export function newNoteId(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}-${randomSuffix()}`;
}

function randomSuffix(): string {
  let out = '';
  // base36 of a random uint32 can be shorter than 6 chars (leading zeros are
  // dropped by toString), so keep drawing until there is enough to slice.
  while (out.length < 6) out += randomBytes(4).readUInt32BE(0).toString(36);
  return out.slice(0, 6);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Strip one layer of surrounding double quotes, if present; otherwise trim. */
function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/** `[a, b]` -> `['a', 'b']`; `[]` or absent -> `[]`. No nested brackets, no
 *  commas inside an element — the format is deliberately not YAML. */
function parseInlineArray(raw: string): string[] {
  const t = raw.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) return [];
  const inner = t.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(',')
    .map((entry) => unquote(entry))
    .filter((entry) => entry.length > 0);
}

/**
 * Parse one note file's text. Deliberately not YAML: every front-matter line is
 * `key: value` (first `:` splits), arrays are `[a, b]`, quotes are optional and
 * stripped. Throws on missing delimiters so a corrupt file is a decision for the
 * caller (listNotes skips it) rather than a silently wrong Note.
 */
export function parseNote(id: string, raw: string): Note {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== FRONT_MATTER_DELIM) {
    throw new Error(`note ${id}: missing opening front-matter delimiter`);
  }
  const fields: Record<string, string> = {};
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === FRONT_MATTER_DELIM) {
      closeIdx = i;
      break;
    }
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
  }
  if (closeIdx === -1) {
    throw new Error(`note ${id}: missing closing front-matter delimiter`);
  }
  const body = lines.slice(closeIdx + 1).join('\n');
  return {
    id,
    question: unquote(fields.question ?? ''),
    appliesTo: parseInlineArray(fields.applies_to ?? ''),
    scope: unquote(fields.scope ?? ''),
    asOf: unquote(fields.as_of ?? ''),
    author: unquote(fields.author ?? ''),
    source: unquote(fields.source ?? ''),
    visibility: unquote(fields.visibility ?? 'team'),
    body,
  };
}

/**
 * One front-matter scalar, on one line.
 *
 * A NEWLINE IN A SCALAR IS A NEW FRONT-MATTER LINE, so it is flattened here and
 * nowhere else is enough. The format is line-oriented and the parser is
 * last-key-wins, so a \n in `source` writes a second `author:` line that
 * overwrites the real one (the push hook renders that as "by <name>", which is
 * what a teammate reads as how far to trust the note), and a \n---\n in
 * `question` closes the front matter early and drops every field after it into
 * the body. Quoting alone does not help: the quotes are on the first line and
 * the injected lines are still lines.
 */
function scalar(value: string): string {
  const flat = String(value)
    .replace(/[\r\n]+/g, ' ')
    .trim();
  // `:` or `#` would be read as the next key or a comment, so those get quotes.
  return /[:#]/.test(flat) ? `"${flat.replace(/"/g, "'")}"` : flat;
}

/** The inverse of {@link parseNote}. Round-trips: `parseNote(id,
 *  serializeNote(n)) equals n` for any Note this module produced — every scalar
 *  goes through {@link scalar}, so there is no Note it can emit that reads back
 *  as a different one. */
export function serializeNote(note: Note): string {
  const front = [
    FRONT_MATTER_DELIM,
    `question: ${scalar(note.question)}`,
    `applies_to: [${note.appliesTo.map(scalar).join(', ')}]`,
    `scope: ${scalar(note.scope)}`,
    `as_of: ${scalar(note.asOf)}`,
    `author: ${scalar(note.author)}`,
    `source: ${scalar(note.source)}`,
    `visibility: ${scalar(note.visibility)}`,
    FRONT_MATTER_DELIM,
    '',
  ].join('\n');
  return front + note.body;
}

export interface AddNoteInput {
  question: string;
  appliesTo?: string[];
  scope?: string;
  body: string;
  author?: string;
  source?: string;
  /** Overrides the id's date and `as_of`; tests only. */
  now?: Date;
}

/** Write a new note file and return the parsed Note. Never touches git — see
 *  {@link commitAndPushNote} for the best-effort sync the command layer runs
 *  after this. */
export async function addNote(dataDir: string, input: AddNoteInput): Promise<Note> {
  const now = input.now ?? new Date();
  const note: Note = {
    id: newNoteId(now),
    question: input.question,
    appliesTo: input.appliesTo ?? [],
    scope: input.scope ?? '',
    asOf: isoDate(now),
    author: input.author ?? '',
    source: input.source ?? '',
    visibility: 'team',
    body: input.body,
  };
  const dir = noteFilesDir(dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(join(dir, `${note.id}.md`), serializeNote(note), {
    mode: 0o644,
    dirMode: 0o700,
  });
  return note;
}

/** One note by id, read directly (no directory scan), or null if it does not
 *  exist or fails to parse. */
export async function getNote(dataDir: string, id: string): Promise<Note | null> {
  try {
    const path = join(noteFilesDir(dataDir), `${id}.md`);
    // The same lstat gate `listNotes` applies, for the same reason: a pulled
    // repo can carry `<id>.md` as a symlink to anywhere on this machine.
    const entry = await lstat(path);
    if (!entry.isFile() || entry.size > NOTES_MAX_BYTES) return null;
    return parseNote(id, await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * ⚠ MIRRORS `NOTES_MAX_FILES` / `NOTES_MAX_BYTES` in the generated push core
 * (lib/push-scripts.ts), and for the same reason it has them: the notes
 * directory is a git clone a TEAMMATE writes to, so its size is not this
 * machine's decision. The hook core has always been bounded because it runs in
 * front of a tool call; this side read every `.md` whole into memory, which is
 * the same pulled repo and the same unbounded allocation with nothing in front
 * of it. Change both together.
 */
export const NOTES_MAX_FILES = 500;
export const NOTES_MAX_BYTES = 65536;

/** Every note, newest id first, bounded. A note file that fails to parse is
 *  skipped — one corrupt hand-edit should not sink `tenjin notes list` — and so
 *  is one past {@link NOTES_MAX_BYTES}; past {@link NOTES_MAX_FILES} entries the
 *  walk stops. */
export async function listNotes(dataDir: string): Promise<Note[]> {
  const dir = noteFilesDir(dataDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const notes: Note[] = [];
  let seen = 0;
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    seen += 1;
    if (seen > NOTES_MAX_FILES) break;
    const id = name.slice(0, -'.md'.length);
    const path = join(dir, name);
    try {
      // LSTAT, NOT STAT. A note file arrives by `git pull` from a repo any
      // teammate can write, and git records symlinks: `notes/<id>.md ->
      // /etc/hosts`, or -> a private key, gets listed, shown, and injected into
      // a session by the push hook if its bytes happen to parse. A note is a
      // file we wrote; a link to somewhere else is not one, whatever it points
      // at. Size first too, so an enormous file is never read at all.
      const entry = await lstat(path);
      if (!entry.isFile()) continue;
      if (entry.size > NOTES_MAX_BYTES) continue;
      notes.push(parseNote(id, await readFile(path, 'utf8')));
    } catch {
      // Skipped: a corrupt or unreadable note should not sink the whole list.
    }
  }
  notes.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return notes;
}

/** Delete a note file. Returns false when it did not exist (not an error);
 *  rethrows anything else (permissions, I/O). */
export async function removeNote(dataDir: string, id: string): Promise<boolean> {
  try {
    await rm(join(noteFilesDir(dataDir), `${id}.md`));
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

// ---- search: lexical overlap, same model as the push hook's judge() ----

/** Mirrors push-scripts.ts's STOPWORDS exactly, so a query scores the same
 *  whether it lands here or in the generated hook core. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'what', 'how', 'why',
  'does', 'not', 'are', 'was', 'has', 'have', 'can', 'you', 'your', 'use', 'using', 'after',
  'before', 'error', 'errors', 'failed', 'failure', 'exit', 'code', 'command', 'running', 'run',
  'file', 'files', 'line', 'lines', 'module', 'test', 'tests', 'found', 'cannot', 'could',
  'should', 'would', 'will', 'than', 'then', 'them', 'they', 'there', 'here', 'about', 'also',
  'some', 'any', 'all', 'but', 'our', 'out', 'get', 'set', 'one', 'two', 'new', 'old', 'fix',
  'issue', 'problem', 'version', 'versions', 'npm', 'pnpm', 'yarn', 'node', 'undefined', 'null',
  'true', 'false', 'string', 'number', 'object', 'function', 'type', 'types', 'expected',
  'received', 'value', 'values', 'unknown', 'invalid', 'missing', 'while', 'where', 'which',
]); // prettier-ignore

/** Content words of `text`, lowercased and deduped. Package-ish tokens keep
 *  their internal punctuation (`@scope/name`, `next.config`) so they match as a
 *  unit; a leading/trailing `.`, `_`, `/` or `-` is trimmed first. */
function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9@._/-]+/)) {
    const w = raw.replace(/^[._/-]+|[._/-]+$/g, '');
    if (w.length < 3 || STOPWORDS.has(w) || /^[\d.]+$/.test(w)) continue;
    out.add(w);
  }
  return out;
}

/** What a query is scored against: the question, the applies_to tags, and the
 *  first 600 chars of the body — enough to catch a note whose title is terse
 *  but whose opening line names the package and version. */
function cardText(note: Note): string {
  return `${note.question} ${note.appliesTo.join(' ')} ${note.body.slice(0, 600)}`;
}

/** Share of the query's content words this note's card covers, 0..1. */
export function scoreNote(query: string, note: Note): number {
  const q = tokenize(query);
  if (q.size === 0) return 0;
  const card = tokenize(cardText(note));
  let hit = 0;
  for (const t of q) if (card.has(t)) hit += 1;
  return hit / q.size;
}

export const NOTE_STRONG = 0.5;
export const NOTE_MODERATE = 0.25;
export const NOTE_MARGIN = 0.15;

export type NoteStrength = 'strong' | 'moderate' | 'none';

export interface NoteSearchResult {
  note: Note;
  score: number;
  strength: NoteStrength;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Strong needs score >= 0.5 AND a >= 0.15 lead over the next candidate down
 *  (the margin only ever applies to the top hit, mirroring push's judge()); a
 *  bare score >= 0.25 with no lead to check is moderate. */
function strengthOf(score: number, marginOverNext: number): NoteStrength {
  if (score >= NOTE_STRONG && marginOverNext >= NOTE_MARGIN) return 'strong';
  if (score >= NOTE_MODERATE) return 'moderate';
  return 'none';
}

/**
 * Every note that clears {@link NOTE_MODERATE}, ranked best first. Only rank 1
 * is margin-checked against rank 2 for `strong`; every other result stands on
 * its own score.
 *
 * THE FLOOR IS THE RESULT SET, NOT JUST A LABEL. A note scoring above zero but
 * under 0.25 is `none` — it shares a word or two with the query and nothing
 * more — and returning it made `notes search` answer a question about
 * migrations with a note about Redis, ranked last and labelled 'none', which no
 * reader distinguishes from a real weak hit. The margin is still measured
 * against the true rank 2, scored BEFORE the floor is applied: hiding a row must
 * not silently promote the row above it to `strong`.
 */
export async function searchNotes(dataDir: string, query: string): Promise<NoteSearchResult[]> {
  const notes = await listNotes(dataDir);
  const scored = notes
    .map((note) => ({ note, score: round3(scoreNote(query, note)) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
  const second = scored[1]?.score ?? 0;
  return scored
    .map((m, i) => ({
      ...m,
      // Rank 1 alone is margin-checked (against rank 2); everything below it has
      // no "next" to compare against, so its own score is the whole story —
      // Infinity always clears the margin gate in strengthOf.
      strength: strengthOf(m.score, i === 0 ? m.score - second : Infinity),
    }))
    .filter((m) => m.score >= NOTE_MODERATE);
}

// ---- git sync: best-effort, spawned, 10s timeout, never fails the command ----

const GIT_TIMEOUT_MS = 10_000;

interface GitResult {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  stderr: string;
}

/** Run one git subcommand in `cwd`. Never rejects: a start failure, a nonzero
 *  exit, and a timeout are all reported in the resolved result so every caller
 *  can decide for itself whether to throw. */
export function runGit(
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (cause) {
      resolve({ ok: false, code: null, timedOut: false, stderr: messageOf(cause) });
      return;
    }
    let timedOut = false;
    let stderr = '';
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (cause) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, timedOut: false, stderr: messageOf(cause) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code: code ?? null, timedOut, stderr: stderr.trim() });
    });
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeGitFailure(step: string, result: GitResult): string {
  const reason = result.timedOut
    ? 'timed out'
    : result.stderr.length > 0
      ? result.stderr
      : `exited ${result.code}`;
  return `${step} ${reason}`;
}

/** Whether `dir` is a git working tree: `.git` present, directory or file (a
 *  worktree's `.git` is a file pointing at the real one). No `git` spawn — a
 *  stat is enough and keeps this check free. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * `git add -A && git commit -m "note: <id>" && git push`, best-effort: a
 * missing repo is a silent no-op (most machines never run `tenjin team init`),
 * and any step that fails leaves the note saved locally, reported as a single
 * warning line rather than a thrown error — the note write already succeeded
 * before this runs.
 */
export async function commitAndPushNote(dataDir: string, id: string): Promise<string | undefined> {
  const dir = notesDir(dataDir);
  if (!(await isGitRepo(dir))) return undefined;
  const add = await runGit(['add', '-A'], dir);
  if (!add.ok) return warningLine(describeGitFailure('git add', add));
  const commit = await runGit(['commit', '-m', `note: ${id}`], dir);
  if (!commit.ok) return warningLine(describeGitFailure('git commit', commit));
  // ONE TEAMMATE'S PUSH BREAKS EVERY LATER `notes add` ON EVERY OTHER MACHINE.
  // From the moment their commit lands, ours is behind, the push is
  // non-fast-forward, and it stays that way until somebody thinks to run `team
  // sync` — which nothing told them to do. So: rebase first. The ordinary case
  // is one local commit onto theirs, which needs no decisions from anybody.
  //
  // Best-effort, exactly like the rest of this function. A conflict, an offline
  // machine or no upstream leaves the pull failing, and the push runs anyway:
  // it may well still work (a first push, an unrelated failure), and where it
  // does not, the warning below names the command that will fix it. The note is
  // already saved locally either way.
  const pulled = await runGit(['pull', '--rebase'], dir);
  const push = await runGit(['push'], dir);
  if (!push.ok) {
    return warningLine(
      describeGitFailure('git push', push) +
        (pulled.ok ? '' : ` (${describeGitFailure('git pull --rebase', pulled)})`),
      'Run `tenjin team sync` to reconcile, then `tenjin notes add` again if it is still missing.',
    );
  }
  return undefined;
}

function warningLine(reason: string, remedy?: string): string {
  return `Warning: ${reason}; the note is saved locally but not synced to the team repo.${
    remedy === undefined ? '' : ` ${remedy}`
  }`;
}

// ---- Stop-hook capture markers (docs/command-reference.md: capture) ----

/** Filename-safe session id. It MUST stay character-for-character identical to
 *  the generated Stop hook's `markerPath` (lib/hook-scripts.ts) and to the push
 *  core's `statePath` (lib/push-scripts.ts): the hook writes `capture-pending`
 *  and then looks for the `capture-done-<key>` this writes, so a sanitizer that
 *  drifts on either side turns the capture ask into a block nothing can clear.
 *  commands/notes.test.ts runs both halves against each other to hold the line. */
function sanitizeSessionId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * `tenjin notes add` / `tenjin notes none` both call this: it is what tells the
 * Stop hook this session already answered the capture nag, so a `Stop` decision
 * of `block` fires at most once per session. Best-effort and silent — losing a
 * marker costs one repeated nag, never a broken `notes add`/`none`.
 *
 * Session id: `$CLAUDE_SESSION_ID` when the harness sets it (the Bash tool this
 * command runs under), else the Stop hook's own `<pushDir>/capture-pending`
 * file, which it writes with the session id right before it blocks. Either way
 * `capture-pending` is removed once read, since it names a nag this call is
 * about to answer.
 */
export async function writeCaptureMarker(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const dir = pushDir(dataDir);
    const pendingPath = join(dir, 'capture-pending');
    const session = await resolveCaptureSession(pendingPath, env);
    if (session === null) return;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(dir, `capture-done-${sanitizeSessionId(session)}`), '', {
      mode: 0o600,
      dirMode: 0o700,
    });
    await rm(pendingPath, { force: true });
  } catch {
    // Bookkeeping only. Never the command's problem.
  }
}

async function resolveCaptureSession(
  pendingPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const fromEnv = env.CLAUDE_SESSION_ID;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  try {
    const raw = (await readFile(pendingPath, 'utf8')).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}
