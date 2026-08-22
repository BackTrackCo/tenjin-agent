import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { CliError } from '../lib/errors';
import {
  NOTE_ID_RE,
  addNote,
  commitAndPushNote,
  getNote,
  listNotes,
  removeNote,
  searchNotes,
  writeCaptureMarker,
  type Note,
  type NoteSearchResult,
} from '../lib/notes';
import { sanitizeForTerminal } from '../lib/output';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin notes add|list|show|search|rm|none`: the team's shared, reusable
 * findings, backed by the git-cloned sidecar repo `tenjin team init` sets up.
 * `add`/`rm` sync the repo best-effort (see commitAndPushNote) and clear the
 * Stop hook's capture nag (see writeCaptureMarker) — neither can fail the
 * command; the note write (or delete) already succeeded before either runs.
 */

export interface NotesAddArgs {
  file?: string;
  question: string;
  appliesTo?: string;
  scope?: string;
  body?: string;
  source?: string;
}

/** Seams for tests: nothing here is reachable from a flag. */
export interface NotesAddDeps {
  readFile?: typeof readFile;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export async function runNotesAdd(
  args: NotesAddArgs,
  ctx: CommandContext,
  deps: NotesAddDeps = {},
): Promise<CommandResult> {
  const question = args.question?.trim() ?? '';
  if (question.length === 0) {
    throw new CliError('USAGE', 'A note needs --question.', {
      fix: 'tenjin notes add --question "..." --body "..."',
    });
  }
  const body = await resolveBody(args, deps);
  const env = deps.env ?? process.env;
  const note = await addNote(ctx.dataDir, {
    question,
    appliesTo: parseAppliesTo(args.appliesTo),
    scope: args.scope?.trim() ?? '',
    body,
    author: defaultAuthor(env),
    source: args.source?.trim() ?? '',
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const warning = await commitAndPushNote(ctx.dataDir, note.id);
  await writeCaptureMarker(ctx.dataDir, env);
  const humanLines = [`Saved note ${note.id}: "${sanitizeForTerminal(note.question)}".`];
  if (warning !== undefined) humanLines.push(warning);
  return { data: note, humanLines };
}

async function resolveBody(args: NotesAddArgs, deps: NotesAddDeps): Promise<string> {
  const hasFile = typeof args.file === 'string' && args.file.length > 0;
  const hasBody = typeof args.body === 'string' && args.body.trim().length > 0;
  if (hasFile && hasBody) {
    throw new CliError('USAGE', 'Pass either a file or --body, not both.', {
      fix: 'Drop one of the two.',
    });
  }
  if (hasBody) return args.body!.trim();
  if (hasFile) {
    const read = deps.readFile ?? readFile;
    try {
      const text = (await read(args.file!, 'utf8')) as string;
      return text.trim();
    } catch (err) {
      throw new CliError(
        'USAGE',
        `Could not read ${args.file}: ${err instanceof Error ? err.message : String(err)}`,
        { fix: 'Check the path, or pass --body "..." instead.' },
      );
    }
  }
  throw new CliError('USAGE', 'A note needs a body: pass a file, or --body "...".', {
    fix: 'tenjin notes add --question "..." --body "..."',
  });
}

function parseAppliesTo(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** `$USER`/`$USERNAME`, falling back to the OS account name; empty when neither
 *  is available (a sandboxed or unusual environment) rather than guessing. */
function defaultAuthor(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.USER ?? env.USERNAME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

export async function runNotesList(ctx: CommandContext): Promise<CommandResult> {
  const notes = await listNotes(ctx.dataDir);
  const humanLines = notes.length === 0 ? ['No notes yet.'] : notes.map((n) => noteListLine(n));
  return { data: { notes: notes.map(summarize) }, humanLines };
}

function noteListLine(note: Note): string {
  const tags = note.appliesTo.length > 0 ? `  [${note.appliesTo.join(', ')}]` : '';
  return `${note.id}  ${sanitizeForTerminal(note.question)}${tags}`;
}

function summarize(note: Note): Omit<Note, 'body'> {
  return {
    id: note.id,
    question: note.question,
    appliesTo: note.appliesTo,
    scope: note.scope,
    asOf: note.asOf,
    author: note.author,
    source: note.source,
    visibility: note.visibility,
  };
}

export async function runNotesShow(
  args: { id: string },
  ctx: CommandContext,
): Promise<CommandResult> {
  assertNoteId(args.id);
  const note = await getNote(ctx.dataDir, args.id);
  if (note === null) throw notFound(args.id);
  const humanLines = [
    `${note.id}  "${sanitizeForTerminal(note.question)}"`,
    ...(note.appliesTo.length > 0 ? [`applies_to: ${note.appliesTo.join(', ')}`] : []),
    ...(note.scope !== '' ? [`scope: ${sanitizeForTerminal(note.scope)}`] : []),
    `as_of: ${note.asOf}  author: ${note.author || '(unknown)'}`,
    '',
    ...sanitizeBodyLines(note.body),
  ];
  return { data: note, humanLines };
}

/** sanitizeForTerminal strips \n along with the rest of C0 — right for a
 *  single-line title, wrong for a note's markdown body. Sanitize per line
 *  instead, so escape sequences and control chars are still stripped but the
 *  body's own line breaks survive into humanLines (one entry per line). */
function sanitizeBodyLines(body: string): string[] {
  return body.split('\n').map((line) => sanitizeForTerminal(line));
}

export interface NotesSearchArgs {
  query: string;
}

export async function runNotesSearch(
  args: NotesSearchArgs,
  ctx: CommandContext,
): Promise<CommandResult> {
  const results = await searchNotes(ctx.dataDir, args.query);
  const humanLines =
    results.length === 0
      ? [`No notes matched "${sanitizeForTerminal(args.query)}".`]
      : results.map((r) => searchResultLine(r));
  return {
    data: {
      query: args.query,
      results: results.map((r) => ({
        id: r.note.id,
        question: r.note.question,
        appliesTo: r.note.appliesTo,
        score: r.score,
        strength: r.strength,
        body: r.note.body,
      })),
    },
    humanLines,
  };
}

function searchResultLine(r: NoteSearchResult): string {
  return `${r.note.id}  (${r.strength}, ${r.score})  "${sanitizeForTerminal(r.note.question)}"`;
}

export async function runNotesRm(
  args: { id: string },
  ctx: CommandContext,
): Promise<CommandResult> {
  assertNoteId(args.id);
  const removed = await removeNote(ctx.dataDir, args.id);
  if (!removed) throw notFound(args.id);
  const warning = await commitAndPushNote(ctx.dataDir, args.id);
  const humanLines = [`Removed note ${args.id}.`];
  if (warning !== undefined) humanLines.push(warning);
  return { data: { id: args.id, removed: true }, humanLines };
}

export interface NotesNoneDeps {
  env?: NodeJS.ProcessEnv;
}

/** `tenjin notes none`: nothing durable came out of this session. Answers the
 *  Stop hook's capture nag exactly like `notes add` does, without a note. */
export async function runNotesNone(
  ctx: CommandContext,
  deps: NotesNoneDeps = {},
): Promise<CommandResult> {
  await writeCaptureMarker(ctx.dataDir, deps.env ?? process.env);
  return { data: { ok: true }, humanLines: ['Noted: nothing durable from this session.'] };
}

function assertNoteId(id: string): void {
  if (!NOTE_ID_RE.test(id)) {
    throw new CliError('USAGE', `Invalid note id: ${JSON.stringify(id)}`, {
      fix: 'Pass an id from `tenjin notes list`.',
    });
  }
}

function notFound(id: string): CliError {
  return new CliError('RESOURCE_NOT_FOUND', `No note ${id}.`, {
    fix: 'Run `tenjin notes list` to see what exists.',
  });
}
