import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runNotesAdd,
  runNotesList,
  runNotesNone,
  runNotesRm,
  runNotesSearch,
  runNotesShow,
} from './notes';
import { addNote, noteFilesDir } from '../lib/notes';
import { notesDir, pushDir } from '../lib/paths';
import { CAPTURE_REASON, stopHookScript } from '../lib/hook-scripts';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';

let root: string;
let dataDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenjin-notes-cmd-'));
  dataDir = join(root, 'data');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000 },
    dataDir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

describe('runNotesAdd', () => {
  it('refuses with no --question', async () => {
    await expect(runNotesAdd({ question: '' }, makeCtx(), { env: {} })).rejects.toThrow(CliError);
  });

  /**
   * The common shape: an agent writing up the debugging session it just had,
   * connection string and all, into a note that `notes add` pushes to the shared
   * remote a moment later.
   */
  it('refuses a body carrying a credential, before anything is written', async () => {
    await expect(
      runNotesAdd(
        {
          question: 'Why did Neon reject our pooled connection?',
          body: 'It works with DATABASE_URL=postgres://prod:hunter2@ep-x.neon.tech/main instead.',
        },
        makeCtx(),
        { env: {} },
      ),
    ).rejects.toThrow(/credential/);
    expect(existsSync(noteFilesDir(dataDir))).toBe(false);
  });

  it.each([
    ['a github token', 'the fix was to set GH_TOKEN to ghp_16C7e42F292c6912E7710c838347Ae178B'],
    ['an openai key', 'pass sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv as the header'],
    ['an aws key id', 'the role prints AKIAIOSFODNN7EXAMPLE on boot'],
    ['a named assignment', 'set api_key: 9fj3ksla02mfk3 in the env file'],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ])('refuses %s', async (_label, body) => {
    await expect(runNotesAdd({ question: 'q', body }, makeCtx(), { env: {} })).rejects.toThrow(
      /credential/,
    );
  });

  /**
   * The refusal names `<REDACTED>` as the remedy. Following it must not land the
   * writer back in the same refusal with the same advice.
   */
  it.each([
    [
      'a redacted connection string',
      'use DATABASE_URL=postgres://prod:<REDACTED>@ep-x.neon.tech/main',
    ],
    ['a redacted assignment', 'set api_key: <REDACTED> in the env file'],
    ['a bracket placeholder', 'set OPENAI_API_KEY=[REDACTED] before running it'],
    ['a starred placeholder', 'the header was authorization: ******** all along'],
  ])('accepts %s, the remedy it advises', async (_label, body) => {
    const res = await runNotesAdd({ question: 'q', body }, makeCtx(), { env: {} });
    expect(res.humanLines?.[0]).toContain('Saved note');
  });

  /** `_` is a word character, so `\bsecret` never fires inside a screaming-snake name. */
  it.each([
    ['an aws secret', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY fixed it'],
    ['a prefixed token', 'export CIRCLE_CI_TOKEN=9fj3ksla02mfk3zz and retry'],
    ['a suffixed api key', 'STRIPE_API_KEY_LIVE: 9fj3ksla02mfk3zz was the wrong one'],
  ])('refuses %s in a screaming-snake env name', async (_label, body) => {
    await expect(runNotesAdd({ question: 'q', body }, makeCtx(), { env: {} })).rejects.toThrow(
      /credential/,
    );
  });

  it('lets an ordinary note through', async () => {
    const res = await runNotesAdd(
      {
        question: 'Does the read beacon fire for hand-seeded posts?',
        body: 'It does not: the beacon needs a real session row, so hand-seeded posts read as zero.',
      },
      makeCtx(),
      { env: {} },
    );
    expect(res.humanLines?.[0]).toContain('Saved note');
  });

  it('refuses a multi-line --source, which would write a second field', async () => {
    await expect(
      runNotesAdd({ question: 'q', body: 'b', source: 'session:1\nauthor: vraspar' }, makeCtx(), {
        env: {},
      }),
    ).rejects.toThrow(/single line/);
  });

  it('refuses a multi-line --question', async () => {
    await expect(
      runNotesAdd({ question: 'Q?\n---\nSURPRISE', body: 'b' }, makeCtx(), { env: {} }),
    ).rejects.toThrow(/single line/);
  });

  it('refuses when neither a file nor --body is given', async () => {
    await expect(runNotesAdd({ question: 'q' }, makeCtx(), { env: {} })).rejects.toThrow(
      /needs a body/,
    );
  });

  it('refuses when both a file and --body are given', async () => {
    await expect(
      runNotesAdd({ question: 'q', file: 'x.md', body: 'b' }, makeCtx(), { env: {} }),
    ).rejects.toThrow(/either a file or --body/);
  });

  it('saves a note from --body, with applies-to split on commas', async () => {
    const result = await runNotesAdd(
      { question: 'Does X do Y?', body: 'the answer', appliesTo: 'pkg@1.2, product' },
      makeCtx(),
      { env: { USER: 'tester' }, now: new Date(2026, 7, 22) },
    );
    const data = result.data as {
      id: string;
      question: string;
      appliesTo: string[];
      author: string;
    };
    expect(data.question).toBe('Does X do Y?');
    expect(data.appliesTo).toEqual(['pkg@1.2', 'product']);
    expect(data.author).toBe('tester');
    expect(result.humanLines?.[0]).toContain(data.id);
  });

  it('reads the body from a file when one is given', async () => {
    const file = join(root, 'finding.md');
    await writeFile(file, 'file contents\n');
    const result = await runNotesAdd({ question: 'q', file }, makeCtx(), { env: {} });
    const data = result.data as { body: string };
    expect(data.body).toBe('file contents');
  });

  it('writes the Stop-hook capture-done marker after a successful add', async () => {
    await runNotesAdd({ question: 'q', body: 'b' }, makeCtx(), {
      env: { CLAUDE_SESSION_ID: 'sess-1' },
    });
    await expect(readFile(join(pushDir(dataDir), 'capture-done-sess-1'), 'utf8')).resolves.toBe('');
  });
});

describe('runNotesList / runNotesShow / runNotesSearch', () => {
  it('lists nothing on a fresh data dir', async () => {
    const result = await runNotesList(makeCtx());
    expect(result.humanLines).toEqual(['No notes yet.']);
    expect((result.data as { notes: unknown[] }).notes).toEqual([]);
  });

  it('lists a saved note without its body, and shows it in full', async () => {
    await addNote(dataDir, {
      question: 'Does X do Y?',
      body: 'full body here',
      appliesTo: ['pkg@1.2'],
    });

    const listed = await runNotesList(makeCtx());
    const notes = (listed.data as { notes: Array<{ id: string; question: string; body?: string }> })
      .notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.question).toBe('Does X do Y?');
    expect(notes[0]!.body).toBeUndefined();

    const shown = await runNotesShow({ id: notes[0]!.id }, makeCtx());
    expect((shown.data as { body: string }).body).toBe('full body here');
    expect(shown.humanLines).toContain('full body here');
  });

  it('show refuses a malformed id and 404s a well-formed but absent one', async () => {
    await expect(runNotesShow({ id: 'not-an-id' }, makeCtx())).rejects.toThrow(CliError);
    await expect(runNotesShow({ id: '20260101-zzzzzz' }, makeCtx())).rejects.toThrow(CliError);
  });

  /**
   * "No note <id>." is true of a note that is not there and a lie about one that
   * is. An unparseable file — a hand-edit, a half-finished rebase — is also
   * silently dropped from `list`, so the two together told an operator looking
   * straight at the file that it did not exist.
   */
  it('says a corrupt note is corrupt, not missing', async () => {
    const dir = noteFilesDir(dataDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '20260101-abcdef.md'), 'no front matter at all\n');

    const absent = await runNotesShow({ id: '20260101-zzzzzz' }, makeCtx()).catch(
      (e: unknown) => e as CliError,
    );
    expect(absent.code).toBe('RESOURCE_NOT_FOUND');
    expect(absent.message).toContain('No note');

    const corrupt = await runNotesShow({ id: '20260101-abcdef' }, makeCtx()).catch(
      (e: unknown) => e as CliError,
    );
    expect(corrupt.code).not.toBe('RESOURCE_NOT_FOUND');
    expect(corrupt.message).toContain('exists');
    expect(corrupt.message).toContain('does not parse');
    // And it names the file, because `notes list` will not.
    expect(corrupt.fix).toContain('20260101-abcdef.md');
  });

  it('preserves multi-line bodies across separate humanLines entries', async () => {
    const note = await addNote(dataDir, { question: 'q', body: 'line one\nline two' });
    const shown = await runNotesShow({ id: note.id }, makeCtx());
    expect(shown.humanLines).toContain('line one');
    expect(shown.humanLines).toContain('line two');
  });

  it('search ranks the matching note and reports no matches honestly', async () => {
    await addNote(dataDir, {
      question: 'esbuild treeshaking breaks dynamic import',
      body: 'esbuild worker bundling',
    });
    const hit = await runNotesSearch({ query: 'esbuild dynamic import' }, makeCtx());
    const results = (hit.data as { results: Array<{ strength: string }> }).results;
    expect(results.length).toBe(1);
    expect(results[0]!.strength).toBe('strong');

    const miss = await runNotesSearch({ query: 'totally unrelated' }, makeCtx());
    expect((miss.data as { results: unknown[] }).results).toEqual([]);
    expect(miss.humanLines?.[0]).toMatch(/No notes matched/);
  });
});

describe('runNotesRm', () => {
  it('removes an existing note and 404s a missing one', async () => {
    const note = await addNote(dataDir, { question: 'q', body: 'b' });
    const result = await runNotesRm({ id: note.id }, makeCtx());
    expect(result.data).toEqual({ id: note.id, removed: true });
    await expect(readFile(join(noteFilesDir(dataDir), `${note.id}.md`), 'utf8')).rejects.toThrow();

    await expect(runNotesRm({ id: note.id }, makeCtx())).rejects.toThrow(CliError);
  });

  it('refuses a malformed id before touching the filesystem', async () => {
    await expect(runNotesRm({ id: 'nope' }, makeCtx())).rejects.toThrow(CliError);
  });
});

describe('runNotesNone', () => {
  it('writes the capture-done marker and never a note file', async () => {
    const result = await runNotesNone(makeCtx(), { env: { CLAUDE_SESSION_ID: 'sess-2' } });
    expect(result.data).toEqual({ ok: true });
    await expect(readFile(join(pushDir(dataDir), 'capture-done-sess-2'), 'utf8')).resolves.toBe('');
    await expect(readdir(noteFilesDir(dataDir))).rejects.toThrow();
  });
});

describe('git sync after add/rm (best-effort)', () => {
  function git(cwd: string, args: string[]): void {
    execFileSync('git', args, { cwd, encoding: 'utf8' });
  }

  it('commits and pushes when notesDir is a cloned team repo, warns on nothing', async () => {
    const origin = join(root, 'origin.git');
    execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
    const dir = notesDir(dataDir);
    await mkdir(dataDir, { recursive: true });
    git(root, ['clone', '--quiet', origin, dir]);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    await writeFile(join(dir, 'README.md'), 'team notes\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '--quiet', '-m', 'init']);
    git(dir, ['push', '--quiet', '-u', 'origin', 'HEAD']);

    const result = await runNotesAdd({ question: 'q', body: 'b' }, makeCtx(), { env: {} });
    // No warning line: the best-effort git sync landed cleanly.
    expect(result.humanLines?.length).toBe(1);

    const log = execFileSync('git', ['--git-dir', origin, 'log', '--format=%s'], {
      encoding: 'utf8',
    });
    expect(log).toContain(`note: ${(result.data as { id: string }).id}`);
  });
});

/**
 * The capture loop across the two halves that have to agree byte for byte: the
 * Stop hook writes `capture-pending` and later looks for `capture-done-<key>`,
 * and `notes none` is what writes that file. The key is a SANITIZED session id
 * on both sides, and the two sanitizers live in different languages (generated
 * JS in lib/hook-scripts.ts, TypeScript in lib/notes.ts), so nothing but running
 * the real generated bytes against the real command proves they still match.
 *
 * The session id here deliberately holds characters both sanitizers rewrite: an
 * id of plain word characters would pass even if one side stopped sanitizing.
 */
describe('the capture loop: Stop hook → `tenjin notes none` → Stop hook', () => {
  const SESSION = 'sess/one:two 3';
  const SANITIZED = 'sess_one_two_3';

  async function runStop(): Promise<{ code: number | null; stdout: string }> {
    const path = join(root, `stop-${Math.random().toString(36).slice(2)}.mjs`);
    await writeFile(path, stopHookScript(dataDir), { mode: 0o755 });
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '' },
      });
      let stdout = '';
      child.stdout.on('data', (c) => (stdout += String(c)));
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(
        JSON.stringify({ session_id: SESSION, hook_event_name: 'Stop', cwd: '/tmp' }),
      );
    });
  }

  it('blocks once, and `notes none` is what lets the session end', async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({ hooks: { capture: 'block' } }));
    // The research signal the ask is gated on.
    await writeFile(
      join(dataDir, 'searches.json'),
      JSON.stringify({
        schemaVersion: 1,
        searches: [
          {
            searchId: '22222222-2222-4222-8222-222222222222',
            at: new Date().toISOString(),
            question: 'pgvector collation',
            decision: 'CANDIDATES',
            candidates: [],
            source: 'cli',
            sessionId: SESSION,
          },
        ],
      }),
    );

    const first = await runStop();
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ decision: 'block', reason: CAPTURE_REASON });
    // Written with the RAW id: it is a file's contents, not a filename.
    expect(await readFile(join(pushDir(dataDir), 'capture-pending'), 'utf8')).toBe(SESSION);
    expect(existsSync(join(pushDir(dataDir), `capture-asked-${SANITIZED}`))).toBe(true);

    // No CLAUDE_SESSION_ID: the command has to learn the session from the
    // pending file the hook just wrote, which is the path that matters here.
    await runNotesNone(makeCtx(), { env: {} });
    expect(existsSync(join(pushDir(dataDir), `capture-done-${SANITIZED}`))).toBe(true);
    expect(existsSync(join(pushDir(dataDir), 'capture-pending'))).toBe(false);

    // The asked-marker would suppress the second ask on its own, so it is
    // removed first: what is under test is that the DONE marker `notes none`
    // wrote is the one the hook recognizes.
    await rm(join(pushDir(dataDir), `capture-asked-${SANITIZED}`), { force: true });
    const second = await runStop();
    expect(second.code).toBe(0);
    expect(second.stdout).toBe('');
  });
});
