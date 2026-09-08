import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFact } from '../hooks/facts';
import { describeChildFinding, readChildFinding, recentFindingIds } from './child-findings';
import { withLoopDb } from './loop-db';

/**
 * The queue read from a CLI process. What these pin is the defensive parse: the
 * fact was written by whichever build was installed when the child stopped, so a
 * field an older one did not write reads as absent rather than failing the
 * publish that was about to use it.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-child-findings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function seed(id: string, over: Record<string, unknown> = {}, at = Date.now()): void {
  withLoopDb(dir, (db) =>
    setFact(
      db,
      `finding:${id}`,
      JSON.stringify({
        title: 'ox 0.14 keeps Bytes.from',
        body: 'ox 0.14 still exports Bytes.from.',
        session: 'parent',
        agent: 'child-1',
        agentType: 'fork',
        project: null,
        searchId: 'search-1',
        at,
        ...over,
      }),
      at,
    ),
  );
}

describe('readChildFinding', () => {
  it('hands back the whole stored body with its title and attribution', async () => {
    seed('WHOLE');
    const finding = await readChildFinding(dir, 'WHOLE');
    expect(finding.body).toBe('ox 0.14 still exports Bytes.from.');
    expect(finding.title).toBe('ox 0.14 keeps Bytes.from');
    expect(finding.agentId).toBe('child-1');
    expect(finding.searchId).toBe('search-1');
    expect(describeChildFinding(finding)).toBe('fork subagent child-1, search search-1');
  });

  it('reads a fact missing every optional field rather than failing', async () => {
    withLoopDb(dir, (db) =>
      setFact(db, 'finding:SPARSE', JSON.stringify({ body: 'a bare body' }), Date.now()),
    );
    const finding = await readChildFinding(dir, 'SPARSE');
    expect(finding).toMatchObject({ agentId: null, agentType: null, searchId: null, title: '' });
    expect(finding.body).toBe('a bare body');
    expect(describeChildFinding(finding)).toBe('a subagent');
  });

  it('names the ids held here when the one asked for is not among them', async () => {
    seed('HELD-A');
    seed('HELD-B');
    const err = (await readChildFinding(dir, 'GONE').catch((e: unknown) => e)) as {
      code: string;
      fix?: string;
      details: unknown;
    };
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
    expect(err.fix).toContain('HELD-A');
    expect(err.fix).toContain('HELD-B');
    expect((err.details as { known: string[] }).known).toHaveLength(2);
  });

  it('says the queue is empty rather than naming ids that are not there', async () => {
    const err = (await readChildFinding(dir, 'GONE').catch((e: unknown) => e)) as { fix?: string };
    expect(err.fix).toContain('hooks.publish');
  });

  it('drops a fact whose value is not readable JSON', async () => {
    withLoopDb(dir, (db) => setFact(db, 'finding:TORN', '{not json', Date.now()));
    await expect(readChildFinding(dir, 'TORN')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });
});

describe('recentFindingIds', () => {
  // The window and the ten-id cap are gone (E2): a finding is publishable by
  // its own id forever, so a listing that aged rows out made a real id look
  // like a typo.
  it('names every id this project holds, newest first, however old', async () => {
    seed('ANCIENT', { project: 'proj' }, 1);
    for (let i = 0; i < 12; i += 1) seed(`ID-${i}`, { project: 'proj' }, 1000 + i);
    expect(await recentFindingIds(dir, 'proj')).toEqual([
      ...Array.from({ length: 12 }, (_, i) => `ID-${11 - i}`),
      'ANCIENT',
    ]);
  });

  it("does not hand one project a listing of another's work", async () => {
    seed('MINE', { project: 'proj' });
    seed('THEIRS', { project: 'other' });
    seed('PLACELESS');
    expect(await recentFindingIds(dir, 'proj')).toEqual(['MINE']);
    expect(await recentFindingIds(dir, null)).toEqual(['PLACELESS']);
  });

  it('is empty, not an error, on a machine with no findings', async () => {
    expect(await recentFindingIds(dir)).toEqual([]);
  });
});
