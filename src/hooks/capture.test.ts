import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookInput } from '../adapters/types';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import { STARTED_MARK } from './actor';
import { stopArm } from './arms/stop';
import { subagentStopArm } from './arms/subagent-stop';
import { CHILD, cleanup, freshDb, hookInput, kernelConfig, LEAD, NOW } from './arms/test-support';
import { findingBlock } from './capture';
import { factsWithPrefix, setFact } from './facts';
import { runFire } from './fire';
import { getMark, setMark } from './gates';
import { CAPTURE_OPENING, FENCE_FALLBACK, FINDING_TAG, QUEUED_FINDINGS_TAIL } from './prose';
import type { LoopDb } from './store';
import type { Actor, Deps, KernelConfig } from './types';

/**
 * Capture through the two arms that call it (from #298's suite, re-keyed
 * onto the kernel). A child is asked once, with evidence, under `block`; the
 * lead is asked once and re-armed only by what its children queue; the stop
 * after an ask harvests the fence whole.
 */

const TEAM = kernelConfig({ push: 'on', capture: 'block' });
const PUBLIC_ONLY: KernelConfig = { ...TEAM, baseUrl: PRODUCTION_ORIGIN };
const SEARCH_ID = '11111111-1111-4111-8111-111111111111';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  cleanup();
});

function fence(body: string): string {
  return 'Done. Here is what I settled:\n```' + FINDING_TAG + '\n' + body + '\n```\n';
}

function childStop(over: Partial<HookInput> = {}): HookInput {
  return hookInput({
    event: 'agent.stop',
    native: { event: 'SubagentStop' },
    agent: CHILD.agent,
    agentType: 'general-purpose',
    turn: 'p1',
    stopFuse: false,
    ...over,
  });
}

function leadStop(over: Partial<HookInput> = {}): HookInput {
  return hookInput({
    event: 'turn.end',
    native: { event: 'Stop' },
    turn: 'p1',
    stopFuse: false,
    ...over,
  });
}

function started(db: LoopDb, agentType = 'general-purpose'): void {
  setMark(db, CHILD, STARTED_MARK, agentType, NOW - 100);
}

/** One ledger row, as a fire by `actor` on `arm` would have left it. */
function seedFire(db: LoopDb, actor: Actor, arm: string, reason: string): void {
  db.prepare(
    `INSERT INTO fires (id, at, session, agent, arm, harness, event, cwd, wait, deadline_ms,
       elapsed_ms, reason) VALUES (?, ?, ?, ?, ?, 'claude', 'x', '', 'tool', 1, 1, ?)`,
  ).run(randomUUID(), NOW - 50, actor.session, actor.agent, arm, reason);
}

function queueFinding(db: LoopDb, over: Record<string, unknown> = {}, at = NOW - 10): string {
  const id = randomUUID();
  setFact(
    db,
    `finding:${id}`,
    JSON.stringify({
      title: 'ox 0.14 keeps Bytes.from',
      body: 'Pinning the resolver to 4.1 stops the parse throw.',
      session: 's1',
      agent: CHILD.agent,
      agentType: 'general-purpose',
      project: null,
      searchId: SEARCH_ID,
      at,
      ...over,
    }),
    at,
  );
  return id;
}

function shelf(): { calls: number } {
  const state = { calls: 0 };
  vi.stubGlobal('fetch', async () => {
    state.calls += 1;
    return new Response(
      JSON.stringify({
        schemaVersion: 3,
        searchId: SEARCH_ID,
        calibration: 'hybrid-v1',
        items: [],
        matched: 0,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return state;
}

async function fire(db: LoopDb, input: HookInput, config: KernelConfig = TEAM, clock = () => NOW) {
  const deps: Deps = {
    db,
    config: () => config,
    clock,
    log: () => undefined,
    arms: [subagentStopArm, stopArm],
    adapters: {},
  };
  const result = await runFire(input, deps);
  result.commit();
  return result.emit;
}

function findings(db: LoopDb): Array<Record<string, unknown>> {
  return factsWithPrefix(db, 'finding:').map((f) => JSON.parse(f.value) as Record<string, unknown>);
}

function fireCount(db: LoopDb): number {
  return Number((db.prepare('SELECT COUNT(*) AS n FROM fires').get() as { n: number }).n);
}

describe('the child ask', () => {
  it('a phantom stop writes nothing at all', async () => {
    const db = freshDb();
    setMark(db, CHILD, 'edited:abc', 'src/a.ts', NOW);
    expect(await fire(db, childStop())).toBeNull();
    expect(fireCount(db)).toBe(0);
    expect(getMark(db, CHILD, 'capture:asked')).toBeNull();
  });

  it('an edit, one Read row, or a claimed handoff miss each earn the ask, and the mark says which', async () => {
    const cases: Array<[string, (db: LoopDb) => void]> = [
      ['edited', (db) => setMark(db, CHILD, 'edited:abc', 'src/a.ts', NOW)],
      ['research', (db) => seedFire(db, CHILD, 'context', 'no-question')],
      ['handoff-miss', (db) => setMark(db, CHILD, 'handoff:miss', SEARCH_ID, NOW)],
    ];
    for (const [kind, seed] of cases) {
      const db = freshDb();
      started(db);
      seed(db);
      const emit = await fire(db, childStop());
      const reason = emit?.block?.reason ?? '';
      expect(reason.startsWith(CAPTURE_OPENING), kind).toBe(true);
      expect(reason, kind).toContain(`tenjin publish <file> --agent ${CHILD.agent}`);
      expect(reason, kind).toContain('publish.mode is review');
      expect(reason, kind).toContain(FENCE_FALLBACK);
      expect(reason, kind).not.toContain(QUEUED_FINDINGS_TAIL);
      expect(emit?.context, kind).toBeUndefined();
      expect(getMark(db, CHILD, 'capture:asked'), kind).toBe(kind);
      if (kind === 'handoff-miss') expect(reason).toContain(` --search-id ${SEARCH_ID}`);
      else expect(reason).not.toContain('--search-id');
    }
  });

  it('a child with no evidence, a nudge machine, and a workflow child are not asked', async () => {
    const bare = freshDb();
    started(bare);
    expect(await fire(bare, childStop())).toBeNull();
    expect(getMark(bare, CHILD, 'capture:asked')).toBeNull();

    const nudge = freshDb();
    started(nudge);
    setMark(nudge, CHILD, 'edited:abc', 'src/a.ts', NOW);
    expect(
      await fire(nudge, childStop(), kernelConfig({ push: 'on', capture: 'nudge' })),
    ).toBeNull();
    expect(getMark(nudge, CHILD, 'capture:asked')).toBeNull();

    const workflow = freshDb();
    started(workflow, 'workflow-subagent');
    setMark(workflow, CHILD, 'edited:abc', 'src/a.ts', NOW);
    // The type its start recorded wins a stop payload that lost it.
    const { agentType, ...typeless } = childStop();
    void agentType;
    expect(await fire(workflow, typeless)).toBeNull();
    expect(getMark(workflow, CHILD, 'capture:asked')).toBeNull();
  });

  it('the report is looked up log-only on the first stop; the answer turn harvests and looks nothing up', async () => {
    const db = freshDb();
    started(db);
    setMark(db, CHILD, 'edited:abc', 'src/a.ts', NOW);
    const stub = shelf();
    await fire(db, childStop({ lastMessage: 'Both worktrees share one Docker daemon.' }));
    expect(stub.calls).toBe(2);

    const body = 'Pinning the resolver to 4.1 stops the parse throw.';
    const emit = await fire(
      db,
      childStop({ stopFuse: true, lastMessage: fence('# ox 0.14 keeps Bytes.from\n' + body) }),
    );
    expect(emit).toBeNull();
    expect(stub.calls).toBe(2);
    expect(findings(db)).toMatchObject([
      {
        title: 'ox 0.14 keeps Bytes.from',
        body,
        session: 's1',
        agent: CHILD.agent,
        agentType: 'general-purpose',
        searchId: '',
      },
    ]);
    expect(getMark(db, CHILD, 'capture:harvested')).not.toBeNull();
  });

  it('stores title and body whole: a 300-character heading is still the title, and a key never is', async () => {
    const db = freshDb();
    started(db);
    setMark(db, CHILD, 'edited:abc', 'src/a.ts', NOW);
    await fire(db, childStop());
    const heading = 'w'.repeat(300);
    const body =
      'x'.repeat(5000) + ' sk-abcdefghijklmnopqrstuvwxyz012345 and src/lib/a.ts at a1b2c3d';
    await fire(db, childStop({ stopFuse: true, lastMessage: fence(`# ${heading}\n${body}`) }));
    const [stored] = findings(db);
    expect(stored?.title).toBe(heading);
    expect(String(stored?.body).startsWith('x'.repeat(5000))).toBe(true);
    expect(stored?.body).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(stored?.body).toContain('src/lib/a.ts at a1b2c3d');
  });

  it('a second stop after the harvest is a no-op', async () => {
    const db = freshDb();
    started(db);
    setMark(db, CHILD, 'handoff:miss', SEARCH_ID, NOW);
    await fire(db, childStop());
    await fire(db, childStop({ stopFuse: true, lastMessage: fence('first') }));
    await fire(db, childStop({ stopFuse: true, lastMessage: fence('second') }));
    expect(findings(db)).toMatchObject([{ body: 'first', searchId: SEARCH_ID }]);
  });

  it('push off is silent everywhere, whatever capture says', async () => {
    const db = freshDb();
    started(db);
    setMark(db, CHILD, 'edited:abc', 'src/a.ts', NOW);
    expect(await fire(db, childStop(), kernelConfig({ push: 'off', capture: 'block' }))).toBeNull();
    expect(getMark(db, CHILD, 'capture:asked')).toBeNull();
  });
});

describe('the lead ask', () => {
  it('is asked once on a lookup that ran, re-armed by a new queued finding and not by a publish (#294)', async () => {
    const db = freshDb();
    seedFire(db, LEAD, 'prompt', 'no-hit');
    const first = await fire(db, leadStop());
    expect(first?.block?.reason.startsWith(CAPTURE_OPENING)).toBe(true);
    expect(first?.block?.reason).not.toContain('--agent');
    expect(getMark(db, LEAD, 'capture:asked')).toBe('lookup');
    expect(await fire(db, leadStop())).toBeNull();

    setFact(db, 'published:abc', '{}', NOW + 10);
    setFact(db, 'agent_published:abc', '{}', NOW + 10);
    expect(await fire(db, leadStop(), TEAM, () => NOW + 20)).toBeNull();

    const id = queueFinding(db, {}, NOW + 30);
    const again = await fire(db, leadStop(), TEAM, () => NOW + 40);
    expect(again?.block?.reason).toContain(
      `- ${id} general-purpose subagent ${CHILD.agent}, search ${SEARCH_ID}: "ox 0.14 keeps Bytes.from"`,
    );
    expect(again?.block?.reason).toContain(QUEUED_FINDINGS_TAIL);
    expect(await fire(db, leadStop(), TEAM, () => NOW + 50)).toBeNull();
  });

  it('a queued finding alone is evidence, and the lines name this session only, titles cleaned', async () => {
    const db = freshDb();
    const mine = queueFinding(db, { title: 'a titlewith a bell\nand a break' });
    const theirs = queueFinding(db, { session: 's-other' });
    const own = queueFinding(db, { agent: '' });
    const emit = await fire(db, leadStop());
    const reason = emit?.block?.reason ?? '';
    expect(getMark(db, LEAD, 'capture:asked')).toBe('finding');
    expect(reason).toContain("1 finding(s) this session's subagents");
    expect(reason).toContain(`- ${mine} `);
    expect(reason).toContain('"a title with a bell and a break"');
    expect(reason).not.toContain(theirs);
    expect(reason).not.toContain(own);
    expect(reason).not.toContain('Pinning the resolver');
  });

  it('team-mode repo activity is evidence; public-mode activity is not', async () => {
    const team = freshDb();
    setMark(team, LEAD, 'activity:mutation', String(NOW), NOW);
    expect((await fire(team, leadStop()))?.block).toBeDefined();
    expect(getMark(team, LEAD, 'capture:asked')).toBe('activity');

    const pub = freshDb();
    setMark(pub, LEAD, 'activity:mutation', String(NOW), NOW);
    expect(await fire(pub, leadStop(), PUBLIC_ONLY)).toBeNull();
  });

  it('blocks only with the fuse false; nudge and a fuse-less harness get context', async () => {
    const fuseless = freshDb();
    seedFire(fuseless, LEAD, 'research', 'hit');
    const { stopFuse, ...noFuse } = leadStop();
    void stopFuse;
    const emit = await fire(fuseless, noFuse);
    expect(emit?.block).toBeUndefined();
    expect(emit?.context?.startsWith(CAPTURE_OPENING)).toBe(true);

    const nudge = freshDb();
    seedFire(nudge, LEAD, 'research', 'hit');
    const nudged = await fire(nudge, leadStop(), kernelConfig({ push: 'on', capture: 'nudge' }));
    expect(nudged?.block).toBeUndefined();
    expect(nudged?.context).toContain('tenjin publish <file>');
  });

  it('the public wording, and the project publish.mode, when the checkout has one', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'tenjin-d-capture-'));
    dirs.push(repo);
    mkdirSync(join(repo, '.git'));
    writeFileSync(join(repo, '.tenjin.json'), JSON.stringify({ publish: { mode: 'full-auto' } }));
    const db = freshDb();
    seedFire(db, LEAD, 'fetch', 'seen');
    const emit = await fire(db, leadStop({ cwd: repo }), PUBLIC_ONLY);
    // A project file narrows, never widens: full-auto reads as auto.
    expect(emit?.block?.reason).toContain('publish.mode is auto');
    expect(emit?.block?.reason).toContain('rights-clean');
  });

  it('the second stop harvests the lead own fence; a skipped lookup is not evidence', async () => {
    const db = freshDb();
    seedFire(db, LEAD, 'prompt', 'words');
    expect(await fire(db, leadStop())).toBeNull();

    seedFire(db, LEAD, 'prompt', 'cached');
    await fire(db, leadStop());
    await fire(db, leadStop({ stopFuse: true, lastMessage: fence('the lead settled this') }));
    expect(findings(db)).toMatchObject([
      { body: 'the lead settled this', agent: '', agentType: '' },
    ]);
  });
});

describe('the fence parse', () => {
  it('opens on the last marker line, closes fence-aware, and reads an unclosed block to the end', () => {
    const snippet = [
      '```' + FINDING_TAG,
      'the fix:',
      '```js',
      'z.object({}).passthrough();',
      '```',
      'and that is all.',
      '```',
    ].join('\n');
    const quoted = 'I was asked for a ```' + FINDING_TAG + '\nblock, so:\n\n' + snippet;
    expect(findingBlock(quoted)).toEqual({
      title: '',
      body: 'the fix:\n```js\nz.object({}).passthrough();\n```\nand that is all.',
    });
    expect(findingBlock('```' + FINDING_TAG + '\n# T\nforgot the close')).toEqual({
      title: 'T',
      body: 'forgot the close',
    });
    expect(findingBlock('nothing worth a ```' + FINDING_TAG + ' block here')).toBeNull();
    expect(findingBlock('```' + FINDING_TAG + '\n# only a heading\n```')).toEqual({
      title: '',
      body: '# only a heading',
    });
  });
});
