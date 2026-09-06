import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHILD, LEAD, NOW, cleanup, freshDb } from '../arms/test-support';
import { getFact } from '../facts';
import { setMark } from '../gates';
import type { LoopDb } from '../store';
import type { Actor } from '../types';
import {
  closeOpenPairings,
  findPairing,
  isTrackedPath,
  linkPost,
  openPairing,
  pairingAnswer,
  projectOf,
  rememberReplay,
  repoPath,
  replayedPairings,
} from './pairings';

/**
 * This machine's error-to-fix record. Under test: the #269 close rule (an
 * edit by THIS agent, in THIS checkout, since the failure, always), the
 * ranking a lookup answers with, and the record as an `Answer`.
 */

const REPO = '/repo/one';
const PROJECT = projectOf(REPO);
const OTHER_SESSION: Actor = { session: 's2', agent: '' };

let db: LoopDb;

beforeEach(() => {
  db = freshDb();
});

afterEach(cleanup);

function open(over: Partial<Parameters<typeof openPairing>[1]> = {}, at = NOW): number {
  return openPairing(
    db,
    {
      session: LEAD.session,
      cwd: REPO,
      kind: 'sig_v1',
      key: 'k-fine',
      coarseKey: 'k-coarse',
      cmdHead: 'pnpm',
      cmd: 'pnpm db:migrate',
      errorLine: "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'",
      errorFiles: ['migrate.ts'],
      ...over,
    },
    at,
  );
}

/** The context arm's mark: the path as the value, the time as `at`. */
function edited(actor: Actor, path: string, at: number): void {
  setMark(db, actor, 'edited:' + path, path, at);
}

function pass(actor: Actor = LEAD, command = 'pnpm db:migrate', at = NOW + 100): void {
  closeOpenPairings(db, actor, REPO, command, ['pnpm'], at);
}

function row(id: number): Record<string, unknown> {
  return db.prepare('SELECT * FROM pairings WHERE id = ?').get(id) as Record<string, unknown>;
}

describe('the #269 close rule', () => {
  it('closes on an edit of a file the error named, recording the repo-relative path', () => {
    const id = open();
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW + 10);
    pass(LEAD, 'pnpm test');
    expect(row(id)).toMatchObject({ status: 'unverified', closes: 1, scope: 'code' });
    expect(JSON.parse(String(row(id).fix_files))).toEqual(['src/migrate.ts']);
  });

  it('does not close on a same-command pass with no edit at all', () => {
    const id = open();
    pass();
    expect(row(id)).toMatchObject({ status: 'open', closes: 0 });
  });

  it('widens which files count on the same command, never whether any do', () => {
    const id = open();
    edited(LEAD, `${REPO}/src/unrelated.ts`, NOW + 10);
    pass(LEAD, 'pnpm test');
    expect(row(id)).toMatchObject({ status: 'open' });
    pass(LEAD, 'pnpm db:migrate');
    expect(row(id)).toMatchObject({ status: 'unverified' });
    expect(JSON.parse(String(row(id).fix_files))).toEqual(['src/unrelated.ts']);
  });

  it('ignores an edit outside the checkout, even when its basename matches the error', () => {
    const id = open();
    edited(LEAD, '/tmp/some-other-project/src/migrate.ts', NOW + 10);
    edited(LEAD, '/Users/me/.claude/notes/migrate.ts', NOW + 11);
    pass();
    expect(row(id)).toMatchObject({ status: 'open' });
  });

  it('ignores an untracked edit: a vendor directory, an env file', () => {
    const id = open();
    edited(LEAD, `${REPO}/node_modules/x/migrate.ts`, NOW + 10);
    edited(LEAD, `${REPO}/.env.local`, NOW + 11);
    pass();
    expect(row(id)).toMatchObject({ status: 'open' });
  });

  it('counts only edits AFTER the failure', () => {
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW - 10);
    const id = open();
    pass();
    expect(row(id)).toMatchObject({ status: 'open' });
  });

  it("closes on a child's pass only with the child's own edits", () => {
    const id = open();
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW + 10);
    pass(CHILD);
    expect(row(id)).toMatchObject({ status: 'open' });
    edited(CHILD, `${REPO}/src/migrate.ts`, NOW + 20);
    pass(CHILD);
    expect(row(id)).toMatchObject({ status: 'unverified' });
    expect(db.prepare('SELECT agent_id FROM pairing_closes WHERE pairing_id = ?').get(id)).toEqual({
      agent_id: CHILD.agent,
    });
  });

  it('closes the pairing this agent was SHOWN, and a second session verifies it', () => {
    const id = open({ session: 's0' });
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW + 10);
    pass(LEAD, 'pnpm db:migrate');
    // Another session is shown the record, fixes the same file, passes.
    rememberReplay(db, OTHER_SESSION, 'pnpm', id, NOW + 200);
    edited(OTHER_SESSION, `${REPO}/src/migrate.ts`, NOW + 210);
    pass(OTHER_SESSION, 'pnpm test', NOW + 220);
    expect(row(id)).toMatchObject({ status: 'verified', closes: 2 });
  });

  it('records but does not count a second close whose fix does not overlap', () => {
    const id = open();
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW + 10);
    pass();
    rememberReplay(db, OTHER_SESSION, 'pnpm', id, NOW + 200);
    edited(OTHER_SESSION, `${REPO}/src/other.ts`, NOW + 210);
    pass(OTHER_SESSION, 'pnpm db:migrate', NOW + 220);
    expect(row(id)).toMatchObject({ status: 'unverified', closes: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM pairing_closes').get()).toEqual({ n: 2 });
  });

  it('marks a machine-level failure `user` however it was closed', () => {
    const id = open({ errorLine: 'listen EADDRINUSE: address already in use :::3000' });
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW + 10);
    pass();
    expect(row(id)).toMatchObject({ status: 'unverified', scope: 'user' });
  });

  it('never closes a pairing from another checkout', () => {
    const id = open({ cwd: '/repo/two' });
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW + 10);
    pass();
    expect(row(id)).toMatchObject({ status: 'open' });
  });

  it('updates the linked post fact on close, for sync to attest', () => {
    const id = open();
    linkPost(db, id, 'post-1', 'https://shelf.acme.internal', NOW);
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW + 10);
    pass();
    expect(JSON.parse(getFact(db, `pairing_post:${id}`) ?? '')).toEqual({
      postId: 'post-1',
      origin: 'https://shelf.acme.internal',
      at: NOW,
      closedAt: NOW + 100,
      status: 'unverified',
      fixFiles: ['src/migrate.ts'],
    });
  });
});

describe('the lookup', () => {
  it('answers nothing until a row is closed', () => {
    open();
    expect(findPairing(db, PROJECT, 'k-fine', 'k-coarse')).toBeNull();
  });

  it('ranks an exact key over a verified coarse-only match', () => {
    const coarseOnly = open({ key: 'k-other', session: 'a' });
    const fine = open({ session: 'b' });
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW + 10);
    pass();
    rememberReplay(db, OTHER_SESSION, 'pnpm', coarseOnly, NOW + 200);
    edited(OTHER_SESSION, `${REPO}/src/migrate.ts`, NOW + 210);
    pass(OTHER_SESSION, 'pnpm db:migrate', NOW + 220);
    expect(row(coarseOnly).status).toBe('verified');
    expect(findPairing(db, PROJECT, 'k-fine', 'k-coarse')?.id).toBe(fine);
    // Coarse alone still answers when the fine key is unknown.
    expect(findPairing(db, PROJECT, 'k-unknown', 'k-coarse')?.id).toBe(coarseOnly);
  });

  it('is scoped to the checkout', () => {
    open();
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW + 10);
    pass();
    expect(findPairing(db, projectOf('/repo/two'), 'k-fine', 'k-coarse')).toBeNull();
  });
});

describe('the replayed mark', () => {
  it('is a list that grows without a cap and never repeats an id', () => {
    for (let id = 1; id <= 12; id += 1) rememberReplay(db, LEAD, 'pnpm', id, NOW + id);
    rememberReplay(db, LEAD, 'pnpm', 3, NOW + 99);
    expect(replayedPairings(db, LEAD, 'pnpm')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(replayedPairings(db, CHILD, 'pnpm')).toEqual([]);
  });
});

describe('the record as an Answer', () => {
  it('is a local answer with the error line as its title and the fix as its text', () => {
    const id = open();
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW + 10);
    pass(LEAD, 'DATABASE_URL=postgres://app:hunter2@db/x pnpm db:migrate');
    const match = findPairing(db, PROJECT, 'k-fine', 'k-coarse');
    const answer = pairingAnswer(match!, true);
    expect(answer).toMatchObject({
      shelf: 'local',
      resourceId: `pairing:${id}`,
      title: "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'",
    });
    expect(answer.text?.split('\n')).toEqual([
      'Someone once fixed this by touching: src/migrate.ts.',
      expect.stringMatching(/^It passed afterwards on: DATABASE_URL=postgres:\/\/app:[^h]/),
    ]);
    expect(answer.text).not.toContain('hunter2');
  });

  it('reads as a fix once verified, with the count', () => {
    const id = open();
    edited(LEAD, `${REPO}/src/migrate.ts`, NOW + 10);
    pass();
    rememberReplay(db, OTHER_SESSION, 'pnpm', id, NOW + 200);
    edited(OTHER_SESSION, `${REPO}/src/migrate.ts`, NOW + 210);
    pass(OTHER_SESSION, 'pnpm db:migrate', NOW + 220);
    const answer = pairingAnswer(findPairing(db, PROJECT, 'k-fine', null)!, true);
    expect(answer.text).toContain('Fixed here 2 time(s) by changing: src/migrate.ts.');
  });

  it('is a pointer with no text for a coarse test-identity match', () => {
    open({ kind: 'sig_v1_test', errorFiles: ['a.test.ts'] });
    edited(LEAD, `${REPO}/src/a.test.ts`, NOW + 10);
    pass();
    const answer = pairingAnswer(findPairing(db, PROJECT, 'k-fine', null)!, false);
    expect(answer.text).toBeUndefined();
    expect(answer.excerpt).toBe('A similar failure in a.test.ts has been fixed here before.');
  });
});

describe('paths', () => {
  it.each([
    ['/repo/one/src/a.ts', 'src/a.ts'],
    ['src/a.ts', 'src/a.ts'],
    ['/repo/one', null],
    ['/repo/one-more/src/a.ts', null],
    ['/tmp/x.ts', null],
  ])('names %s as the repo does', (path, rel) => {
    expect(repoPath(REPO, path)).toBe(rel);
  });

  it.each([
    ['/repo/one/src/a.ts', true],
    ['/repo/one/dist/a.js', false],
    ['/repo/one/.git/config', false],
    ['/repo/one/.env.local', false],
    ['/repo/one/.github/workflows/ci.yml', true],
  ])('%s tracked: %s', (path, tracked) => {
    expect(isTrackedPath(path)).toBe(tracked);
  });
});
