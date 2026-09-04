import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  describeChildFinding,
  findingDocument,
  readChildFinding,
  recentFindingIds,
  type ChildFinding,
} from './child-findings';
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
  agentId?: string | null;
  data?: string;
}): Promise<void> {
  const store = await openStore(dir);
  if (store === null) throw new Error('no store');
  try {
    store.run(STORE_SQL.insertEvent, [
      over.uid,
      over.at ?? Date.now(),
      'parent',
      // `agent_id` is a COLUMN since tenjin-agent#247's store v2, and it is
      // where the child's identity lives; `data` carries only what nothing
      // joins on.
      over.agentId === undefined ? 'child-1' : over.agentId,
      null,
      'machine',
      over.hook ?? STORE_FINDING_HOOK,
      'SubagentStop',
      null,
      null,
      over.data ??
        JSON.stringify({
          kind: 'finding',
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
    await seed({ uid: 'SPARSE', agentId: null, data: JSON.stringify({ body: 'a bare body' }) });
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

/**
 * The publish-side title (tenjin-agent#228 PR 1).
 *
 * The harvest splits a child's `# ` line off its block BEFORE it flattens the
 * rest, so the ordinary path here is a join of two stored fields. What the rest
 * pin is the fallback for a row captured before that split: a title comes off
 * the finding's own opening words and the BODY IS NEVER REWRITTEN, because the
 * publish path's scan detectors are line-scoped and a body cut in two stops one
 * of them from seeing a run that spanned the cut.
 */
function finding(body: string, title: string | null = null): ChildFinding {
  return {
    id: 'f1',
    at: new Date(0).toISOString(),
    session: 's1',
    project: 'p1',
    agentType: 'general-purpose',
    agentId: 'a1',
    searchId: null,
    title,
    body,
  };
}

describe('findingDocument', () => {
  it("joins the child's own stored title to its stored body", () => {
    expect(
      findingDocument(
        finding('It throws on an optional chain until you do.', 'Pinning the resolver'),
      ),
    ).toBe('# Pinning the resolver\n\nIt throws on an optional chain until you do.');
  });

  it('takes a stored title verbatim, with no sentence cut and no full stop dropped', () => {
    // The child chose these words as its title, so nothing here second-guesses
    // them: this exact string used to publish under `1`.
    expect(
      findingDocument(finding('The lockfile pins it.', '1. Pin the resolver. 2. Rerun.')),
    ).toBe('# 1. Pin the resolver. 2. Rerun.\n\nThe lockfile pins it.');
  });

  it('derives from the first sentence when no title was stored, and keeps the body whole', () => {
    const body = 'Pinning the resolver to 4.1 stops the throw. Verified on 4.0.';
    expect(findingDocument(finding(body))).toBe(
      `# Pinning the resolver to 4.1 stops the throw\n\n${body}`,
    );
  });

  it('keeps the whole body of a stored one-liner that opens with a heading marker', () => {
    // A row an older build wrote: the marker is markup so it leaves the title,
    // and every WORD stays in the body.
    const body = '# Pinning the resolver. It throws on an optional chain until you do.';
    expect(findingDocument(finding(body))).toBe(`# Pinning the resolver\n\n${body}`);
  });

  it('keeps a body that already reads as a document', () => {
    const doc = '# ox 0.14 keeps Bytes.from\n\nVerified against the published tag.';
    expect(findingDocument(finding(doc))).toBe(doc);
  });

  it('walks past a sentence end with no word before it', () => {
    // `1.` is a list number, not a sentence, and cutting there published the
    // whole finding under the title `1`.
    expect(findingDocument(finding('# 1. Pin the resolver to 4.1. It throws until you do.'))).toBe(
      '# 1. Pin the resolver to 4.1\n\n# 1. Pin the resolver to 4.1. It throws until you do.',
    );
  });

  it('cuts a runaway first sentence at a word boundary, and still keeps the body', () => {
    const body = `# ${'word '.repeat(60)}end.`;
    const doc = findingDocument(finding(body));
    const title = doc.split('\n')[0] ?? '';
    expect(title.length).toBeLessThanOrEqual(122);
    expect(title.endsWith(' ')).toBe(false);
    // Nothing invented and nothing reordered: the title is a prefix of what the
    // child wrote, and the body under it is that finding entire.
    expect(body.startsWith(title)).toBe(true);
    expect(doc.endsWith(`\n\n${body}`)).toBe(true);
  });

  it('keeps a question mark, drops a full stop', () => {
    expect(findingDocument(finding('# Does pinning help? Yes, on 4.1.'))).toBe(
      '# Does pinning help?\n\n# Does pinning help? Yes, on 4.1.',
    );
  });

  it('hands back a body it can derive nothing from, untouched', () => {
    expect(findingDocument(finding('   '))).toBe('   ');
    expect(findingDocument(finding('#'))).toBe('#');
  });
});
