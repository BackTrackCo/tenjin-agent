import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCandidateAdd, runCandidateDrop, runCandidateList } from './candidate';
import { listCandidates } from '../lib/candidate-store';
import { main } from '../cli';
import type { CommandContext } from '../context';
import type { Io } from '../lib/output';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-candidate-cmd-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000 },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const LOOKUP = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const at = (iso: string) => () => new Date(iso);

describe('runCandidateAdd', () => {
  it('parks a draft, records meta, and reports the id + path', async () => {
    const file = join(dir, 'draft.md');
    await writeFile(file, '# hi\n', 'utf8');
    const res = await runCandidateAdd(
      { file, lookupId: LOOKUP, question: 'how do I X?' },
      makeCtx(),
      { now: at('2026-07-20T00:00:00.000Z'), cwd: dir },
    );
    const data = res.data as Record<string, unknown>;
    expect(data.lookupId).toBe(LOOKUP);
    expect(data.question).toBe('how do I X?');
    expect(data.created).toBe('2026-07-20T00:00:00.000Z');
    expect(typeof data.id).toBe('string');
    // The draft is actually on disk and listable.
    const list = await listCandidates(dir);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(data.id);
  });

  it('captures the repo root as sourceProject when the cwd is inside a repo', async () => {
    const repo = join(dir, 'proj');
    const nested = join(repo, 'a', 'b');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(nested, { recursive: true });
    const file = join(dir, 'draft.md');
    await writeFile(file, 'x', 'utf8');
    const res = await runCandidateAdd({ file, lookupId: LOOKUP }, makeCtx(), { cwd: nested });
    expect((res.data as Record<string, unknown>).sourceProject).toBe(repo);
  });

  it('falls back to the cwd when not inside a repo', async () => {
    const plain = join(dir, 'plain');
    await mkdir(plain, { recursive: true });
    const file = join(dir, 'draft.md');
    await writeFile(file, 'x', 'utf8');
    const res = await runCandidateAdd({ file, lookupId: LOOKUP }, makeCtx(), { cwd: plain });
    expect((res.data as Record<string, unknown>).sourceProject).toBe(plain);
  });

  it('an unreadable draft file is a USAGE error (exit 2)', async () => {
    await expect(
      runCandidateAdd({ file: join(dir, 'nope.md'), lookupId: LOOKUP }, makeCtx()),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
  });
});

describe('runCandidateList', () => {
  it('lists newest-first with humanized age in human lines and ISO in data', async () => {
    const file = join(dir, 'draft.md');
    await writeFile(file, 'x', 'utf8');
    await runCandidateAdd({ file, lookupId: LOOKUP, question: 'older' }, makeCtx(), {
      now: at('2026-07-18T00:00:00.000Z'),
      cwd: dir,
    });
    await runCandidateAdd({ file, lookupId: LOOKUP, question: 'newer' }, makeCtx(), {
      now: at('2026-07-20T00:00:00.000Z'),
      cwd: dir,
    });
    const res = await runCandidateList(makeCtx(), { now: at('2026-07-20T02:00:00.000Z') });
    const candidates = (res.data as { candidates: Array<Record<string, unknown>> }).candidates;
    expect(candidates.map((c) => c.question)).toEqual(['newer', 'older']);
    expect(candidates[0]?.created).toBe('2026-07-20T00:00:00.000Z');
    // Newest is 2h old, next is 2d+ old.
    expect(res.humanLines?.[0]).toContain('2h ago');
    expect(res.humanLines?.[1]).toContain('d ago');
  });

  it('reports an empty store cleanly', async () => {
    const res = await runCandidateList(makeCtx());
    expect((res.data as { candidates: unknown[] }).candidates).toEqual([]);
    expect(res.humanLines).toEqual(['No pending candidates.']);
  });
});

describe('runCandidateDrop', () => {
  it('drops a known candidate', async () => {
    const file = join(dir, 'draft.md');
    await writeFile(file, 'x', 'utf8');
    const added = await runCandidateAdd({ file, lookupId: LOOKUP }, makeCtx(), { cwd: dir });
    const id = (added.data as Record<string, unknown>).id as string;
    const res = await runCandidateDrop({ id }, makeCtx());
    expect(res.data).toEqual({ id, dropped: true });
    expect(await listCandidates(dir)).toEqual([]);
  });

  it('an unknown id is a clean USAGE error (exit 2)', async () => {
    await expect(
      runCandidateDrop({ id: '0197aaaa-bbbb-cccc-dddd-000000000999' }, makeCtx()),
    ).rejects.toMatchObject({ code: 'USAGE', exitCode: 2 });
  });
});

describe('candidate via main (one JSON object per invocation)', () => {
  function captureIo(): { io: Io; stdout: () => string } {
    const out: string[] = [];
    const mk = () =>
      ({
        write: (c: string | Uint8Array) => (out.push(c.toString()), true),
      }) as unknown as NodeJS.WritableStream;
    return { io: { stdout: mk(), stderr: mk(), isTTY: false }, stdout: () => out.join('') };
  }

  let prevDataDir: string | undefined;
  beforeEach(() => {
    prevDataDir = process.env.TENJIN_DATA_DIR;
    process.env.TENJIN_DATA_DIR = dir;
  });
  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.TENJIN_DATA_DIR;
    else process.env.TENJIN_DATA_DIR = prevDataDir;
  });

  it('list emits exactly one success envelope and exits 0', async () => {
    const cap = captureIo();
    const code = await main(['candidate', 'list', '--json'], cap.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed).toMatchObject({ ok: true, command: 'candidate.list' });
  });

  it('drop of an unknown id emits one error envelope and exits 2', async () => {
    const cap = captureIo();
    const code = await main(
      ['candidate', 'drop', '0197aaaa-bbbb-cccc-dddd-000000000999', '--json'],
      cap.io,
    );
    expect(code).toBe(2);
    const parsed = JSON.parse(cap.stdout());
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('USAGE');
  });
});
