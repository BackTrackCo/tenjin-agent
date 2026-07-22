import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCandidate,
  dropCandidate,
  listCandidates,
  readCandidate,
  type CreateCandidateInput,
} from './candidate-store';

const isWindows = process.platform === 'win32';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-cstore-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function input(over: Partial<CreateCandidateInput> = {}): CreateCandidateInput {
  return {
    draft: '# draft\n\nbody\n',
    lookupId: '0197aaaa-bbbb-cccc-dddd-000000000001',
    question: 'how do I X?',
    created: '2026-07-18T00:00:00.000Z',
    sourceProject: '/repo/x',
    ...over,
  };
}

describe('candidate-store', () => {
  it('round-trips add -> read: id, draft, and full meta shape', async () => {
    const created = await createCandidate(dir, input());
    const read = await readCandidate(dir, created.id);
    expect(read).not.toBeNull();
    expect(read?.id).toBe(created.id);
    expect(read?.meta).toEqual({
      schemaVersion: 1,
      lookupId: '0197aaaa-bbbb-cccc-dddd-000000000001',
      question: 'how do I X?',
      created: '2026-07-18T00:00:00.000Z',
      sourceProject: '/repo/x',
    });
    expect(await readFile(created.draftPath, 'utf8')).toBe('# draft\n\nbody\n');
  });

  it('omits question from meta when not provided', async () => {
    const created = await createCandidate(dir, input({ question: undefined }));
    const read = await readCandidate(dir, created.id);
    expect(read?.meta.question).toBeUndefined();
    expect('question' in (read?.meta ?? {})).toBe(false);
  });

  it('lists newest-first by created, tie-broken deterministically', async () => {
    await createCandidate(dir, input({ created: '2026-07-18T00:00:00.000Z' }));
    await createCandidate(dir, input({ created: '2026-07-20T00:00:00.000Z' }));
    await createCandidate(dir, input({ created: '2026-07-19T00:00:00.000Z' }));
    const list = await listCandidates(dir);
    expect(list.map((c) => c.meta.created)).toEqual([
      '2026-07-20T00:00:00.000Z',
      '2026-07-19T00:00:00.000Z',
      '2026-07-18T00:00:00.000Z',
    ]);
  });

  it('gives a total order when created values tie, via the id tie-break', async () => {
    const created = '2026-07-20T00:00:00.000Z';
    const a = await createCandidate(dir, input({ created }));
    const b = await createCandidate(dir, input({ created }));
    const c = await createCandidate(dir, input({ created }));
    const listed = (await listCandidates(dir)).map((r) => r.id);
    // Equal timestamps fall back to id, descending, so the order is total and
    // deterministic rather than dependent on readdir/insertion order.
    expect(listed).toEqual([a.id, b.id, c.id].sort((x, y) => (x < y ? 1 : -1)));
  });

  it.skipIf(isWindows)('writes 0600 files inside a 0700 candidate dir', async () => {
    const created = await createCandidate(dir, input());
    expect((await stat(created.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(created.draftPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(created.dir, 'meta.json'))).mode & 0o777).toBe(0o600);
  });

  it('drops a candidate and reports unknown / malformed ids as not found', async () => {
    const created = await createCandidate(dir, input());
    expect(await dropCandidate(dir, created.id)).toBe(true);
    expect(await readCandidate(dir, created.id)).toBeNull();
    // Second drop of the same id is a clean false, not a throw.
    expect(await dropCandidate(dir, created.id)).toBe(false);
    // A malformed id can never resolve to a path outside the store.
    expect(await dropCandidate(dir, '../../etc')).toBe(false);
    expect(await readCandidate(dir, 'not-a-uuid')).toBeNull();
  });

  it('empty when the store has never been written', async () => {
    expect(await listCandidates(dir)).toEqual([]);
  });

  it('drop removes a crash-orphaned dir that has no meta', async () => {
    const orphan = '0197aaaa-bbbb-cccc-dddd-0000000000ff';
    const odir = join(dir, 'candidates', orphan);
    await mkdir(odir, { recursive: true });
    await writeFile(join(odir, 'draft.md'), 'leaked secret', 'utf8');
    // list hides the orphan, but drop can still clean it up by id.
    expect(await listCandidates(dir)).toEqual([]);
    expect(await dropCandidate(dir, orphan)).toBe(true);
    expect(await dropCandidate(dir, orphan)).toBe(false);
  });

  it('list skips a meta with an unknown schemaVersion or wrong shape', async () => {
    const good = await createCandidate(dir, input());
    const v2 = join(dir, 'candidates', '0197aaaa-bbbb-cccc-dddd-000000000002');
    await mkdir(v2, { recursive: true });
    await writeFile(
      join(v2, 'meta.json'),
      JSON.stringify({ schemaVersion: 2, lookupId: 'x', created: 'c', sourceProject: 'p' }),
      'utf8',
    );
    const wrong = join(dir, 'candidates', '0197aaaa-bbbb-cccc-dddd-000000000003');
    await mkdir(wrong, { recursive: true });
    await writeFile(join(wrong, 'meta.json'), JSON.stringify({ nope: true }), 'utf8');
    expect((await listCandidates(dir)).map((c) => c.id)).toEqual([good.id]);
  });

  it('skips a dir with an absent or corrupt meta (half-written add)', async () => {
    const good = await createCandidate(dir, input());
    // A dir whose draft exists but meta does not yet (mid-commit) is invisible.
    const partial = join(dir, 'candidates', '0197aaaa-bbbb-cccc-dddd-000000000abc');
    await mkdir(partial, { recursive: true });
    await writeFile(join(partial, 'draft.md'), 'x', 'utf8');
    // A dir with corrupt meta is likewise skipped, never throws.
    const corrupt = join(dir, 'candidates', '0197aaaa-bbbb-cccc-dddd-000000000def');
    await mkdir(corrupt, { recursive: true });
    await writeFile(join(corrupt, 'meta.json'), 'not json', 'utf8');

    const list = await listCandidates(dir);
    expect(list.map((c) => c.id)).toEqual([good.id]);
  });

  it('concurrent adds land in distinct dirs and both survive', async () => {
    const [a, b] = await Promise.all([
      createCandidate(dir, input({ question: 'a' })),
      createCandidate(dir, input({ question: 'b' })),
    ]);
    expect(a.id).not.toBe(b.id);
    const list = await listCandidates(dir);
    expect(list).toHaveLength(2);
    expect(new Set(list.map((c) => c.meta.question))).toEqual(new Set(['a', 'b']));
  });
});
