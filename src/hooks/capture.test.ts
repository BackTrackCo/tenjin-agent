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
import { setFact } from './facts';
import { runFire } from './fire';
import { getMark, setMark } from './gates';
import { CAPTURE_ASK } from './prose';
import type { LoopDb } from './store';
import type { Actor, Deps, KernelConfig } from './types';

/**
 * Capture through the two arms that call it (from #298's suite, re-keyed onto
 * the kernel). Both audiences are asked ONCE, with evidence, as context, and
 * every stop after that says nothing: the ask names a command, so there is
 * nothing left for a later turn to collect. The LEAD's ask also names what this
 * session left open: its unanswered searches, the errors it fixed, what its
 * children published. A child's ask carries none of those.
 */

const TEAM = kernelConfig();
const PUBLIC_ONLY: KernelConfig = { ...TEAM, baseUrl: PRODUCTION_ORIGIN };
const SEARCH_ID = '11111111-1111-4111-8111-111111111111';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  cleanup();
});

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
function seedFire(db: LoopDb, actor: Actor, arm: string, reason: string, event = 'prompt'): void {
  db.prepare(
    `INSERT INTO fires (id, at, session, agent, arm, harness, event, cwd, wait, deadline_ms,
       elapsed_ms, reason) VALUES (?, ?, ?, ?, ?, 'claude', ?, '', 'tool', 1, 1, ?)`,
  ).run(randomUUID(), NOW - 50, actor.session, actor.agent, arm, event, reason);
}

/** One `searches` row, as `tenjin search` would have left it. */
function seedSearch(
  db: LoopDb,
  over: { id: string; decision?: string; source?: string | null; resolvedAt?: string | null },
): void {
  db.prepare(
    `INSERT INTO searches (search_id, at, session, question, fingerprint, decision, candidates,
       source, resolved_at) VALUES (?, ?, ?, ?, 'fp', ?, '[]', ?, ?)`,
  ).run(
    over.id,
    NOW - 20,
    LEAD.session,
    'does ox 0.14 still export Bytes.from?',
    over.decision ?? 'MISS',
    over.source === undefined ? 'cli' : over.source,
    over.resolvedAt ?? null,
  );
}

/** One pairing this session opened and closed, as the failure arm leaves it. */
function seedPairing(
  db: LoopDb,
  over: { key: string; kind?: string; scope?: string; postId?: string | null },
): void {
  const id = db
    .prepare(
      `INSERT INTO pairings (uid, at, session, project, machine, kind, key, error_line,
         error_files, scope, status, closes, closed_at, post_id)
       VALUES (?, ?, ?, NULL, 'm', ?, ?, ?, '[]', ?, 'unverified', 1, ?, ?) RETURNING id`,
    )
    .get(
      randomUUID(),
      NOW - 30,
      LEAD.session,
      over.kind ?? 'sig_v1_test',
      over.key,
      'AssertionError: expected 3 to be 4',
      over.scope ?? 'code',
      NOW - 20,
      over.postId ?? null,
    ) as { id: number };
  db.prepare(
    `INSERT INTO pairing_closes (pairing_id, session, at, fix_cmd, fix_files, scope)
     VALUES (?, ?, ?, 'vitest', '["src/http.ts"]', ?)`,
  ).run(id.id, LEAD.session, NOW - 20, over.scope ?? 'code');
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

  it('an edit, a web lookup, or a claimed handoff miss each earn the ask, and the mark says which', async () => {
    const cases: Array<[string, (db: LoopDb) => void]> = [
      ['edited', (db) => setMark(db, CHILD, 'edited:abc', 'src/a.ts', NOW)],
      ['research', (db) => seedFire(db, CHILD, 'research', 'no-hit')],
      ['research', (db) => seedFire(db, CHILD, 'fetch', 'seen')],
      ['handoff-miss', (db) => setMark(db, CHILD, 'handoff:miss', SEARCH_ID, NOW)],
    ];
    for (const [kind, seed] of cases) {
      const db = freshDb();
      started(db);
      seed(db);
      const emit = await fire(db, childStop());
      const reason = emit?.context ?? '';
      expect(reason.startsWith('Tenjin: this turn did work worth a second look.'), kind).toBe(true);
      expect(reason, kind).toContain(
        `write it as a file and run \`tenjin publish <file> --agent ${CHILD.agent}`,
      );
      expect(reason, kind).toContain('publish.mode is review');
      expect(getMark(db, CHILD, 'capture:asked'), kind).toBe(kind);
      if (kind === 'handoff-miss') expect(reason).toContain(` --search-id ${SEARCH_ID}`);
      else expect(reason).not.toContain('--search-id');
    }
  });

  /**
   * A READ ALONE IS NOT EVIDENCE (owner, 2026-09-12). Decision 2's "one Read is
   * a row" is withdrawn: it is the cheapest row an agent can leave, so it asked
   * nearly every child whatever it had been doing.
   */
  it('a Read-only child, a Bash-only child, a bare child, a capture-off machine and a workflow child are not asked', async () => {
    const bare = freshDb();
    started(bare);
    expect(await fire(bare, childStop())).toBeNull();
    expect(getMark(bare, CHILD, 'capture:asked')).toBeNull();

    // A Read is a context row on `tool.after`; a Bash call is one on
    // `tool.before`. Neither counts now.
    const readOnly = freshDb();
    started(readOnly);
    seedFire(readOnly, CHILD, 'context', 'no-question', 'tool.after');
    expect(await fire(readOnly, childStop())).toBeNull();
    expect(getMark(readOnly, CHILD, 'capture:asked')).toBeNull();

    const bashOnly = freshDb();
    started(bashOnly);
    seedFire(bashOnly, CHILD, 'context', 'no-question', 'tool.before');
    expect(await fire(bashOnly, childStop())).toBeNull();
    expect(getMark(bashOnly, CHILD, 'capture:asked')).toBeNull();

    const silent = freshDb();
    started(silent);
    setMark(silent, CHILD, 'edited:abc', 'src/a.ts', NOW);
    expect(await fire(silent, childStop(), kernelConfig({ publish: false }))).toBeNull();
    expect(getMark(silent, CHILD, 'capture:asked')).toBeNull();

    const workflow = freshDb();
    started(workflow, 'workflow-subagent');
    setMark(workflow, CHILD, 'edited:abc', 'src/a.ts', NOW);
    // The type its start recorded wins a stop payload that lost it.
    const { agentType, ...typeless } = childStop();
    void agentType;
    expect(await fire(workflow, typeless)).toBeNull();
    expect(getMark(workflow, CHILD, 'capture:asked')).toBeNull();
  });

  it('asks no shelf, and the answer turn after the ask is not asked again', async () => {
    const db = freshDb();
    started(db);
    setMark(db, CHILD, 'edited:abc', 'src/a.ts', NOW);
    const stub = shelf();
    expect(await fire(db, childStop())).not.toBeNull();
    expect(stub.calls).toBe(0);

    // The turn that ANSWERS the ask, and every turn after it: the row is still
    // written, and the agent reads nothing new.
    const answer = await fire(db, childStop({ stopFuse: true, lastMessage: 'Published it.' }));
    expect(answer).toBeNull();
    expect(await fire(db, childStop({ stopFuse: true, lastMessage: 'Again.' }))).toBeNull();
    expect(stub.calls).toBe(0);
    expect(fireCount(db)).toBe(3);
  });

  it('carries no miss or fix line, though the lead in the same session gets both', async () => {
    const db = freshDb();
    started(db);
    setMark(db, CHILD, 'edited:abc', 'src/a.ts', NOW);
    seedSearch(db, { id: 'open-1' });
    seedPairing(db, { key: 'ab12' });

    // The open search and the closed pairing are the session's, and only the
    // lead can act on either: a child must not be handed them.
    const child = (await fire(db, childStop()))?.context ?? '';
    expect(child.startsWith('Tenjin: this turn did work worth a second look.')).toBe(true);
    expect(child).not.toContain('had no answer');
    expect(child).not.toContain('open-1');
    expect(child).not.toContain('You fixed');
    expect(child).not.toContain('ab12');

    seedFire(db, LEAD, 'research', 'hit');
    const lead = (await fire(db, leadStop()))?.context ?? '';
    expect(lead).toContain('(open-1) had no answer');
    expect(lead).toContain('`--key fingerprint=sig_v1_test:ab12`');
  });
});

describe('the lead ask', () => {
  it('is asked once on a lookup that ran, and nothing re-arms it: not a publish (#294), not a later turn', async () => {
    const db = freshDb();
    seedFire(db, LEAD, 'prompt', 'no-hit');
    const first = await fire(db, leadStop());
    expect(first?.context?.startsWith('Tenjin: this turn did work')).toBe(true);
    expect(first?.context).not.toContain('--agent');
    expect(getMark(db, LEAD, 'capture:asked')).toBe('lookup');

    // The answer turn (`stopFuse`), then an ordinary one, then one after a
    // publish: each writes its row and says nothing.
    expect(
      await fire(db, leadStop({ stopFuse: true, lastMessage: 'done' }), TEAM, () => NOW + 5),
    ).toBeNull();
    expect(await fire(db, leadStop(), TEAM, () => NOW + 10)).toBeNull();

    setFact(db, 'published:abc', 'https://tenjin.blog/p/abc', NOW + 15);
    expect(await fire(db, leadStop(), TEAM, () => NOW + 20)).toBeNull();
    expect(fireCount(db)).toBe(5);
  });

  it('team-mode repo activity is evidence; public-mode activity is not', async () => {
    const team = freshDb();
    setMark(team, LEAD, 'activity:mutation', String(NOW), NOW);
    expect((await fire(team, leadStop()))?.context).toBeDefined();
    expect(getMark(team, LEAD, 'capture:asked')).toBe('activity');

    const pub = freshDb();
    setMark(pub, LEAD, 'activity:mutation', String(NOW), NOW);
    expect(await fire(pub, leadStop(), PUBLIC_ONLY)).toBeNull();
  });

  it('is context whatever the fuse says, and the whole E13 block is the text', async () => {
    const db = freshDb();
    seedFire(db, LEAD, 'research', 'hit');
    const emit = await fire(db, leadStop());
    expect(emit).toEqual({
      context: CAPTURE_ASK.replace('<mode>', 'review').replace('<flags>', ''),
    });
    // The text itself, spelled out once: one paragraph, one command, no fence.
    expect(emit?.context).toBe(
      'Tenjin: this turn did work worth a second look. If it settled something reusable ' +
        '(a probe result, a version gotcha, a tested workaround; on the team shelf also a ' +
        'decision and why, or a code map), write it as a file and run `tenjin publish <file>`; ' +
        'publish.mode is review. The tenjin-publish skill has the shape. If nothing durable, ' +
        'just finish.',
    );

    // A harness that sends no fuse at all says the same thing: the ask is not a
    // decision, so there is nothing for the fuse to gate.
    const fuseless = freshDb();
    seedFire(fuseless, LEAD, 'research', 'hit');
    const { stopFuse, ...noFuse } = leadStop();
    void stopFuse;
    expect((await fire(fuseless, noFuse))?.context).toBe(emit?.context);

    const off = freshDb();
    seedFire(off, LEAD, 'research', 'hit');
    expect(await fire(off, leadStop(), kernelConfig({ publish: false }))).toBeNull();
    expect(getMark(off, LEAD, 'capture:asked')).toBeNull();
  });

  it("names this session's unclosed deliberate misses, and no closed or hook one", async () => {
    const db = freshDb();
    seedFire(db, LEAD, 'research', 'hit');
    seedSearch(db, { id: 'open-1' });
    seedSearch(db, { id: 'legacy-1', source: null });
    seedSearch(db, { id: 'closed-1', resolvedAt: '2026-09-06T00:00:00.000Z' });
    seedSearch(db, { id: 'hit-1', decision: 'HIT' });
    const reason = (await fire(db, leadStop()))?.context ?? '';
    expect(reason).toContain(
      "- Your search 'does ox 0.14 still export Bytes.from?' (open-1) had no answer: " +
        '`--search-id open-1` on the publish, or `tenjin outcome --search-id open-1 --status regenerated`',
    );
    expect(reason).toContain('(legacy-1)');
    expect(reason).not.toContain('closed-1');
    expect(reason).not.toContain('hit-1');
  });

  it('names a closed code-scope fix with its key, but not a user-scope or an already-published one', async () => {
    const db = freshDb();
    seedFire(db, LEAD, 'research', 'hit');
    seedPairing(db, { key: 'ab12' });
    seedPairing(db, { key: 'usr9', scope: 'user' });
    seedPairing(db, { key: 'done7', postId: 'post_1' });
    seedPairing(db, { key: 'cd34', kind: 'sig_v1' });
    const reason = (await fire(db, leadStop()))?.context ?? '';
    expect(reason).toContain(
      '- You fixed `AssertionError: expected 3 to be 4` (key `sig_v1_test:ab12`): ' +
        'publish the explanation with `--key fingerprint=sig_v1_test:ab12`',
    );
    expect(reason).toContain('`--key fingerprint=sig_v1:cd34`');
    expect(reason).not.toContain('usr9');
    expect(reason).not.toContain('done7');
  });

  it("names what this session's children published, and not another session's child", async () => {
    const db = freshDb();
    started(db);
    seedFire(db, LEAD, 'research', 'hit');
    setFact(
      db,
      `agent_published:${CHILD.agent}@${NOW - 5}`,
      JSON.stringify({ url: 'https://tenjin.blog/p/one', at: NOW - 5 }),
      NOW - 5,
    );
    setFact(
      db,
      `agent_published:${CHILD.agent}@${NOW - 4}`,
      JSON.stringify({ url: 'https://tenjin.blog/p/two', at: NOW - 4 }),
      NOW - 4,
    );
    setFact(
      db,
      `agent_published:stranger@${NOW - 3}`,
      JSON.stringify({ url: 'https://tenjin.blog/p/three', at: NOW - 3 }),
      NOW - 3,
    );
    const reason = (await fire(db, leadStop()))?.context ?? '';
    // One line per publish, not per agent: a child's second publish must not
    // hide its first.
    expect(reason).toContain(
      `- subagent general-purpose ${CHILD.agent} published https://tenjin.blog/p/one`,
    );
    expect(reason).toContain(
      `- subagent general-purpose ${CHILD.agent} published https://tenjin.blog/p/two`,
    );
    expect(reason).not.toContain('p/three');
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
    expect(emit?.context).toContain('publish.mode is auto');
    // One wording for both shelves: the team's extra kinds ride the same sentence.
    expect(emit?.context).toContain('on the team shelf also a decision and why');
  });

  it('a skipped lookup is not evidence', async () => {
    const db = freshDb();
    seedFire(db, LEAD, 'prompt', 'words');
    expect(await fire(db, leadStop())).toBeNull();
    expect(getMark(db, LEAD, 'capture:asked')).toBeNull();

    seedFire(db, LEAD, 'prompt', 'cached');
    expect(await fire(db, leadStop())).not.toBeNull();
    expect(getMark(db, LEAD, 'capture:asked')).toBe('lookup');
  });
});
