import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeChildFinding, readChildFinding, recentFindingIds } from './child-findings';
import { openStore, STORE_FINDING_HOOK, STORE_SQL } from './state-store';

/**
 * The queue read from a CLI process. What these pin is the defensive parse: the
 * rows were written by whichever build was installed when the child stopped, so
 * a field an older one did not write reads as absent rather than failing the
 * publish that was about to use it.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-child-findings-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(over: {
  uid: string;
  at?: number;
  hook?: string;
  data?: string;
}): Promise<void> {
  const store = await openStore(dir);
  if (store === null) throw new Error('no store');
  try {
    store.run(STORE_SQL.insertEvent, [
      over.uid,
      over.at ?? Date.now(),
      'parent',
      null,
      'machine',
      over.hook ?? STORE_FINDING_HOOK,
      'SubagentStop',
      null,
      null,
      over.data ??
        JSON.stringify({
          kind: 'finding',
          agentId: 'child-1',
          agentType: 'fork',
          searchId: 'search-1',
          body: 'ox 0.14 still exports Bytes.from.',
        }),
    ]);
  } finally {
    store.close();
  }
}

describe('readChildFinding', () => {
  it('hands back the whole stored body with its attribution', async () => {
    await seed({ uid: 'WHOLE' });
    const finding = await readChildFinding(dir, 'WHOLE');
    expect(finding.body).toBe('ox 0.14 still exports Bytes.from.');
    expect(finding.agentId).toBe('child-1');
    expect(finding.searchId).toBe('search-1');
    expect(describeChildFinding(finding)).toBe('fork subagent child-1, search search-1');
  });

  it('reads a row missing every optional field rather than failing', async () => {
    await seed({ uid: 'SPARSE', data: JSON.stringify({ body: 'a bare body' }) });
    const finding = await readChildFinding(dir, 'SPARSE');
    expect(finding).toMatchObject({ agentId: null, agentType: null, searchId: null });
    expect(finding.body).toBe('a bare body');
    expect(describeChildFinding(finding)).toBe('a subagent');
  });

  it('names the ids held here when the one asked for is not among them', async () => {
    await seed({ uid: 'HELD-A' });
    await seed({ uid: 'HELD-B' });
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
    expect(err.fix).toContain('hooks.capture');
  });

  // The hook predicate, not a filter here: a uid the subagent arm minted for a
  // stop row must not resolve as a body to publish.
  it('refuses a uid another arm minted', async () => {
    await seed({ uid: 'STOP-ROW', hook: 'subagent' });
    await expect(readChildFinding(dir, 'STOP-ROW')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('drops a row whose data is not readable JSON', async () => {
    await seed({ uid: 'TORN', data: '{not json' });
    await expect(readChildFinding(dir, 'TORN')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });
});

describe('recentFindingIds', () => {
  it('leaves out what has aged past the capture window', async () => {
    const eightHours = 8 * 60 * 60 * 1000;
    await seed({ uid: 'FRESH', at: 100_000 });
    await seed({ uid: 'STALE', at: 1 });
    expect(await recentFindingIds(dir, () => 100_000 + eightHours)).toEqual(['FRESH']);
  });

  it('is empty, not an error, on a machine with no store', async () => {
    expect(await recentFindingIds(join(dir, 'never-created'))).toEqual([]);
  });
});
