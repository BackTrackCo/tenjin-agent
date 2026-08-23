import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NOTE_ID_RE,
  NOTES_MAX_BYTES,
  NOTES_MAX_FILES,
  addNote,
  commitAndPushNote,
  getNote,
  isGitRepo,
  listNotes,
  NOTE_MODERATE,
  newNoteId,
  noteFilesDir,
  parseNote,
  removeNote,
  runGit,
  scoreNote,
  searchNotes,
  serializeNote,
  writeCaptureMarker,
  type Note,
} from './notes';
import { notesDir, pushDir } from './paths';

let root: string;
let dataDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenjin-notes-lib-'));
  dataDir = join(root, 'data');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const SAMPLE: Note = {
  id: '20260822-k3x9q2',
  question: 'Does pkg@1.2 do Y under Z?',
  appliesTo: ['pkg@1.2', 'product'],
  scope: 'where it holds',
  asOf: '2026-08-22',
  author: 'vraspar',
  source: 'session:abc',
  visibility: 'team',
  body: 'Line one.\nLine two, with detail.\n',
};

describe('newNoteId', () => {
  it('matches the id format', () => {
    expect(newNoteId()).toMatch(NOTE_ID_RE);
  });

  it('encodes the given date', () => {
    const id = newNoteId(new Date(2026, 7, 22, 10, 0, 0));
    expect(id.startsWith('20260822-')).toBe(true);
  });
});

describe('parseNote / serializeNote', () => {
  it('round-trips a note through serialize then parse', () => {
    const raw = serializeNote(SAMPLE);
    expect(parseNote(SAMPLE.id, raw)).toEqual(SAMPLE);
  });

  it('quotes a field that contains a colon or hash, and strips it back out', () => {
    const note: Note = { ...SAMPLE, scope: 'holds for v1: the old client', source: '#123' };
    const raw = serializeNote(note);
    expect(raw).toContain('scope: "holds for v1: the old client"');
    expect(parseNote(note.id, raw)).toEqual(note);
  });

  it('parses quotes stripped and arrays split on commas, per the format', () => {
    const raw = [
      '---',
      'question: "Does X do Y?"',
      'applies_to: [a, b, c]',
      'scope: s',
      'as_of: 2026-08-22',
      'author: someone',
      'source: ""',
      'visibility: team',
      '---',
      'body text',
    ].join('\n');
    const note = parseNote('20260822-aaaaaa', raw);
    expect(note.question).toBe('Does X do Y?');
    expect(note.appliesTo).toEqual(['a', 'b', 'c']);
    expect(note.source).toBe('');
    expect(note.body).toBe('body text');
  });

  /**
   * Front matter is line-oriented and the parser is last-key-wins, so a newline
   * inside a scalar is a new FIELD. `source` spoofing `author` is the sharp end:
   * the push hook renders the author as "by <name>" in every teammate's context,
   * which is what says how far to trust the note.
   */
  it('cannot be made to write a second field out of one scalar', () => {
    const note: Note = {
      ...SAMPLE,
      author: 'mallory',
      source: 'session:1\nauthor: vraspar',
    };
    const raw = serializeNote(note);
    expect(raw.split('\n').filter((l) => l.startsWith('author:'))).toHaveLength(1);
    expect(parseNote(note.id, raw).author).toBe('mallory');
  });

  it('cannot be made to close its own front matter', () => {
    const note: Note = { ...SAMPLE, question: 'Q?\n---\nSURPRISE' };
    const raw = serializeNote(note);
    const parsed = parseNote(note.id, raw);
    // Everything after the injected delimiter would otherwise have been lost.
    expect(parsed.appliesTo).toEqual(SAMPLE.appliesTo);
    expect(parsed.author).toBe(SAMPLE.author);
    expect(parsed.body).toBe(SAMPLE.body);
    expect(parsed.question).not.toContain('\n');
  });

  it('throws when the opening delimiter is missing', () => {
    expect(() => parseNote('x', 'question: y\n---\nbody')).toThrow();
  });

  it('throws when the closing delimiter is missing', () => {
    expect(() => parseNote('x', '---\nquestion: y\nbody')).toThrow();
  });
});

describe('addNote / getNote / listNotes / removeNote', () => {
  it('writes a note that getNote reads back identically', async () => {
    const note = await addNote(dataDir, {
      question: 'q',
      body: 'b',
      now: new Date(2026, 7, 22),
    });
    expect(note.visibility).toBe('team');
    expect(note.asOf).toBe('2026-08-22');
    expect(await getNote(dataDir, note.id)).toEqual(note);
  });

  it('getNote returns null for a note that does not exist', async () => {
    expect(await getNote(dataDir, '20260101-zzzzzz')).toBeNull();
  });

  it('listNotes on a fresh data dir returns an empty array', async () => {
    expect(await listNotes(dataDir)).toEqual([]);
  });

  it('lists notes newest-id first and skips a note file that fails to parse', async () => {
    const older = await addNote(dataDir, {
      question: 'older',
      body: 'b',
      now: new Date(2026, 0, 1),
    });
    const newer = await addNote(dataDir, {
      question: 'newer',
      body: 'b',
      now: new Date(2026, 5, 1),
    });
    await mkdir(noteFilesDir(dataDir), { recursive: true });
    await writeFile(join(noteFilesDir(dataDir), 'not-a-note.md'), 'no front matter here');

    const notes = await listNotes(dataDir);
    expect(notes.map((n) => n.id)).toEqual([newer.id, older.id]);
  });

  /**
   * The notes directory is a git clone a TEAMMATE writes to, so its size is not
   * this machine's decision. The generated hook core has always been bounded
   * because it runs in front of a tool call; this side read every `.md` whole
   * into memory over the same pulled repo.
   */
  it('reads a bounded number of notes, and never an oversized one', async () => {
    const dir = noteFilesDir(dataDir);
    await mkdir(dir, { recursive: true });
    const write = async (id: string, body: string): Promise<void> => {
      await writeFile(
        join(dir, `${id}.md`),
        ['---', 'question: "q"', 'author: t', '---', body, ''].join('\n'),
      );
    };
    for (let i = 0; i < NOTES_MAX_FILES + 20; i += 1) {
      await write(`20260101-${String(i).padStart(6, '0')}`, 'b');
    }
    // One note past the byte cap, which must not be read at all.
    await write('20261231-999999', 'x'.repeat(NOTES_MAX_BYTES + 1));

    const notes = await listNotes(dataDir);
    expect(notes.length).toBeLessThanOrEqual(NOTES_MAX_FILES);
    expect(notes.some((n) => n.id === '20261231-999999')).toBe(false);
  });

  it('keeps the newest notes when the cap bites, whatever order readdir returns', async () => {
    const dir = noteFilesDir(dataDir);
    await mkdir(dir, { recursive: true });
    const write = async (id: string): Promise<void> => {
      await writeFile(
        join(dir, `${id}.md`),
        ['---', 'question: "q"', 'author: t', '---', 'b', ''].join('\n'),
      );
    };
    // Old notes in bulk, then one newer than all of them. Written LAST so a
    // creation-ordered readdir would put it past the cap.
    for (let i = 0; i < NOTES_MAX_FILES + 5; i += 1) {
      await write(`20240101-${String(i).padStart(6, '0')}`);
    }
    await write('20261201-newest');
    const notes = await listNotes(dataDir);
    expect(notes[0]?.id).toBe('20261201-newest');
    expect(notes.length).toBe(NOTES_MAX_FILES);
  });

  /**
   * A note file arrives by `git pull` from a repo any teammate can write, and
   * git records symlinks. `<id>.md -> /somewhere/else` whose target happens to
   * parse was listed, shown, and — through the push hook's team shelf —
   * injected into a session. A note is a file we wrote, not a pointer at one.
   */
  it('skips a note that is a symlink, in both list and show', async () => {
    const dir = noteFilesDir(dataDir);
    await mkdir(dir, { recursive: true });
    const real = await addNote(dataDir, { question: 'ours', body: 'b' });
    // A well-formed note living outside the repo, linked in.
    const outside = join(root, 'outside.md');
    await writeFile(
      outside,
      ['---', 'question: "not ours"', 'author: mallory', '---', 'their body', ''].join('\n'),
    );
    await symlink(outside, join(dir, '20261231-aaaaaa.md'));

    expect((await listNotes(dataDir)).map((n) => n.id)).toEqual([real.id]);
    expect(await getNote(dataDir, '20261231-aaaaaa')).toBeNull();
  });

  it('removeNote deletes an existing note and reports false for a missing one', async () => {
    const note = await addNote(dataDir, { question: 'q', body: 'b' });
    expect(await removeNote(dataDir, '20260101-zzzzzz')).toBe(false);
    expect(await removeNote(dataDir, note.id)).toBe(true);
    expect(await getNote(dataDir, note.id)).toBeNull();
  });
});

describe('scoreNote / searchNotes', () => {
  it('scores a query against question + applies_to + body head', () => {
    const note: Note = {
      ...SAMPLE,
      question: 'esbuild treeshaking breaks dynamic import',
      body: '',
    };
    expect(scoreNote('esbuild dynamic import', note)).toBeGreaterThan(0.5);
    expect(scoreNote('completely unrelated topic', note)).toBe(0);
  });

  it('ranks the closer match first and labels strength', async () => {
    await addNote(dataDir, {
      question: 'esbuild treeshaking breaks dynamic import in workers',
      body: 'esbuild dynamic import worker bundling gotcha',
      now: new Date(2026, 0, 1),
    });
    await addNote(dataDir, {
      question: 'unrelated postgres timeout note',
      body: 'connection pool exhaustion under load',
      now: new Date(2026, 0, 2),
    });

    const results = await searchNotes(dataDir, 'esbuild dynamic import worker bundling');
    expect(results.length).toBe(1);
    expect(results[0]!.strength).toBe('strong');
    expect(results[0]!.score).toBeGreaterThanOrEqual(0.5);
  });

  it('a top score without enough margin over rank 2 is moderate, not strong', async () => {
    // Both notes share almost the same tokens, so rank 1's lead over rank 2 is
    // under the 0.15 margin even though its raw score clears 0.5.
    await addNote(dataDir, {
      question: 'redis cluster failover timeout gotcha',
      body: '',
      now: new Date(2026, 0, 1),
    });
    await addNote(dataDir, {
      question: 'redis cluster failover timeout workaround',
      body: '',
      now: new Date(2026, 0, 2),
    });

    const results = await searchNotes(dataDir, 'redis cluster failover timeout');
    expect(results[0]!.strength).toBe('moderate');
  });

  /**
   * The command reference promises nothing below 0.25 comes back, and it has to
   * be true here rather than at the caller: a note sharing one word out of six
   * with the query is not a result, and shipped as one it reads to the operator
   * as "the team has something on this" when the team does not.
   */
  it('returns nothing below the moderate floor, however many notes score above zero', async () => {
    await addNote(dataDir, {
      question: 'drizzle migration slot collision renumber',
      body: 'the generator will not catch a taken slot',
      now: new Date(2026, 0, 1),
    });
    // Shares exactly one of the six query words ('timeout'), so it scores
    // ~0.167: above zero, under the floor.
    await addNote(dataDir, {
      question: 'redis timeout',
      body: 'connection pool exhaustion under load',
      now: new Date(2026, 0, 2),
    });

    const query = 'drizzle migration slot collision renumber timeout';
    const results = await searchNotes(dataDir, query);
    expect(results).toHaveLength(1);
    expect(results[0]!.note.question).toContain('drizzle');
    // The hidden row really did score, and really is under the floor: this is a
    // filter, not a query that happened to match nothing.
    const hidden = (await listNotes(dataDir)).find((n) => n.question === 'redis timeout');
    const hiddenScore = scoreNote(query, hidden!);
    expect(hiddenScore).toBeGreaterThan(0);
    expect(hiddenScore).toBeLessThan(NOTE_MODERATE);
  });
});

// ---- git: bare origin + a clone at notesDir(dataDir) ----

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A throwaway bare "origin" plus a clone at exactly notesDir(dataDir), the
 *  shape commitAndPushNote expects. */
async function makeClonedTeamRepo(): Promise<{ origin: string }> {
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  const dir = notesDir(dataDir);
  await mkdir(join(root, 'data'), { recursive: true });
  git(root, ['clone', '--quiet', origin, dir]);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  // A bare repo has no HEAD to push to until something lands; commit a README so
  // `git push` on the first note has an upstream to fast-forward.
  await writeFile(join(dir, 'README.md'), 'team notes\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'init']);
  git(dir, ['push', '--quiet', '-u', 'origin', 'HEAD']);
  return { origin };
}

describe('isGitRepo / runGit', () => {
  it('is false for a plain directory and true once git-initialized', async () => {
    const dir = join(root, 'plain');
    await mkdir(dir, { recursive: true });
    expect(await isGitRepo(dir)).toBe(false);
    execFileSync('git', ['init', '--quiet', dir]);
    expect(await isGitRepo(dir)).toBe(true);
  });

  it('reports a nonzero git exit as not ok, without throwing', async () => {
    const dir = join(root, 'not-a-repo');
    await mkdir(dir, { recursive: true });
    const result = await runGit(['status'], dir);
    expect(result.ok).toBe(false);
  });
});

describe('commitAndPushNote', () => {
  it('is a silent no-op when notesDir is not a git repo', async () => {
    const warning = await commitAndPushNote(dataDir, '20260101-zzzzzz');
    expect(warning).toBeUndefined();
  });

  it('commits and pushes a new note file to the origin', async () => {
    const { origin } = await makeClonedTeamRepo();
    const note = await addNote(dataDir, { question: 'q', body: 'b' });

    const warning = await commitAndPushNote(dataDir, note.id);
    expect(warning).toBeUndefined();

    const log = execFileSync('git', ['--git-dir', origin, 'log', '--format=%s'], {
      encoding: 'utf8',
    });
    expect(log).toContain(`note: ${note.id}`);
  });
});

/**
 * The failure mode this exists to stop: one teammate pushes, and from that
 * moment every OTHER machine's `notes add` is behind, so its push is
 * non-fast-forward — permanently, because nothing in the warning ever told
 * anyone to sync. A best-effort rebase in front of the push makes the ordinary
 * case (our one commit onto theirs) need no decisions from anybody.
 */
describe('commitAndPushNote after a teammate has pushed', () => {
  it('rebases onto their commit instead of failing forever', async () => {
    const { origin } = await makeClonedTeamRepo();

    // A teammate, on their own clone, lands a note first.
    const theirs = join(root, 'teammate');
    git(root, ['clone', '--quiet', origin, theirs]);
    git(theirs, ['config', 'user.email', 'them@example.com']);
    git(theirs, ['config', 'user.name', 'Them']);
    await writeFile(join(theirs, 'THEIRS.md'), 'their note\n');
    git(theirs, ['add', '-A']);
    git(theirs, ['commit', '--quiet', '-m', 'note: theirs']);
    git(theirs, ['push', '--quiet']);

    // Ours is now behind. Without the rebase this push is non-fast-forward.
    const note = await addNote(dataDir, { question: 'q', body: 'b' });
    const warning = await commitAndPushNote(dataDir, note.id);
    expect(warning).toBeUndefined();

    const log = execFileSync('git', ['--git-dir', origin, 'log', '--format=%s'], {
      encoding: 'utf8',
    });
    expect(log).toContain(`note: ${note.id}`);
    expect(log).toContain('note: theirs');
  });

  /** When the rebase cannot save it, the warning has to name what will. */
  it('names `tenjin team sync` when the push still fails', async () => {
    await makeClonedTeamRepo();
    // Point the remote at nothing: pull and push both fail, exactly as they do
    // offline or against a revoked credential.
    git(notesDir(dataDir), ['remote', 'set-url', 'origin', join(root, 'gone.git')]);
    const note = await addNote(dataDir, { question: 'q', body: 'b' });

    const warning = await commitAndPushNote(dataDir, note.id);
    expect(warning).toContain('git push');
    expect(warning).toContain('tenjin team sync');
    // The note itself is untouched by any of it.
    expect(await getNote(dataDir, note.id)).not.toBeNull();
  });
});

describe('writeCaptureMarker', () => {
  it('uses CLAUDE_SESSION_ID when set, and cleans up capture-pending', async () => {
    const dir = pushDir(dataDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'capture-pending'), 'session-from-file');

    await writeCaptureMarker(dataDir, { CLAUDE_SESSION_ID: 'session-from-env' });

    await expect(readFile(join(dir, 'capture-done-session-from-env'), 'utf8')).resolves.toBe('');
    await expect(readFile(join(dir, 'capture-pending'), 'utf8')).rejects.toThrow();
  });

  it('falls back to capture-pending when the env var is unset', async () => {
    const dir = pushDir(dataDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'capture-pending'), 'session-from-file\n');

    await writeCaptureMarker(dataDir, {});

    await expect(readFile(join(dir, 'capture-done-session-from-file'), 'utf8')).resolves.toBe('');
  });

  it('is a no-op when there is neither an env var nor a pending file', async () => {
    await writeCaptureMarker(dataDir, {});
    await expect(readFile(join(pushDir(dataDir), 'capture-pending'), 'utf8')).rejects.toThrow();
  });
});
