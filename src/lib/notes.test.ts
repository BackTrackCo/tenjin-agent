import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NOTE_ID_RE,
  addNote,
  commitAndPushNote,
  getNote,
  isGitRepo,
  listNotes,
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
