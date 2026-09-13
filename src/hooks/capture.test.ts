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
 * the kernel). Both audiences are asked ONCE, with evidence, as context; the
 * LEAD is re-armed by a failure newer than its ask and by nothing else, and every
 * other stop says nothing, because the ask names a command and there is nothing
 * left for a later turn to collect. The LEAD's ask also names what this session
 * left open: its unanswered searches and what its children published. A child's
 * ask carries neither, and both carry the failures the actor itself hit that
 * nothing answered.
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

/** One ledger row, as a fire by `actor` on `arm` would have left it. The
 *  question half is what a failure leaves behind — `fires` IS the record the
 *  turn-end ask reads back — so it is seeded here rather than in a helper of
 *  its own. */
function seedFire(
  db: LoopDb,
  actor: Actor,
  arm: string,
  reason: string,
  event = 'prompt',
  over: { questionKey?: string; question?: string; at?: number } = {},
): void {
  db.prepare(
    `INSERT INTO fires (id, at, session, agent, arm, harness, event, cwd, wait, deadline_ms,
       elapsed_ms, reason, question_key, question)
     VALUES (?, ?, ?, ?, ?, 'claude', ?, '', 'tool', 1, 1, ?, ?, ?)`,
  ).run(
    randomUUID(),
    over.at ?? NOW - 50,
    actor.session,
    actor.agent,
    arm,
    event,
    reason,
    over.questionKey ?? null,
    over.question ?? null,
  );
}

const ENOENT_LINE = "Error: ENOENT: no such file or directory, open 'drizzle.config.ts'";
const ENOENT_KEY = 'sig_v1:aaaabbbbccccdddd|line:' + 'f'.repeat(32);

/** One failure fire the shelves had nothing for, as the arm would have left
 *  it: the composed question key, and the masked line under it. */
function seedFailure(
  db: LoopDb,
  actor: Actor,
  over: { questionKey?: string; question?: string; reason?: string; at?: number } = {},
): void {
  seedFire(db, actor, 'failure', over.reason ?? 'no-hit', 'tool.after', {
    questionKey: over.questionKey ?? ENOENT_KEY,
    question: over.question ?? ENOENT_LINE,
    ...(over.at === undefined ? {} : { at: over.at }),
  });
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
      expect(reason, kind).toContain(`tenjin publish <file> --agent ${CHILD.agent}`);
      expect(reason, kind).toContain('publish.mode is review');
      expect(reason, kind).toContain(
        `write it as a file and run \`tenjin publish <file> --agent ${CHILD.agent}`,
      );
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
  it('a Read-only, Bash-only, bare, capture-off or workflow child is not asked', async () => {
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
    expect(await fire(db, childStop({ stopFuse: true, lastMessage: 'Published it.' }))).toBeNull();
    expect(await fire(db, childStop({ stopFuse: true, lastMessage: 'Again.' }))).toBeNull();
    expect(stub.calls).toBe(0);
    expect(fireCount(db)).toBe(3);
  });

  it('carries no miss line, though the lead in the same session gets one', async () => {
    const db = freshDb();
    started(db);
    setMark(db, CHILD, 'edited:abc', 'src/a.ts', NOW);
    seedSearch(db, { id: 'open-1' });

    // The open search is the session's, and only the lead can act on it: a
    // child must not be handed it.
    const child = (await fire(db, childStop()))?.context ?? '';
    expect(child.startsWith('Tenjin: this turn did work worth a second look.')).toBe(true);
    expect(child).not.toContain('had no answer');
    expect(child).not.toContain('open-1');

    seedFire(db, LEAD, 'research', 'hit');
    const lead = (await fire(db, leadStop()))?.context ?? '';
    expect(lead).toContain('(open-1) had no answer');
  });

  it("names the failures it hit itself, and never the lead's", async () => {
    const db = freshDb();
    started(db);
    setMark(db, CHILD, 'edited:abc', 'src/a.ts', NOW);
    seedFailure(db, CHILD);
    seedFailure(db, LEAD, {
      questionKey: 'line:' + '0'.repeat(32),
      question: 'error: linting failed for the workspace',
    });

    // A failure belongs to the actor that hit it: the child is the one that can
    // explain its own wall, and the lead never walked into it.
    const child = (await fire(db, childStop()))?.context ?? '';
    expect(child).toContain(
      '- Encountered this turn: `' +
        ENOENT_LINE +
        '`. If you settled it and the answer would save a teammate the same hour, publish it with ' +
        '`--key fingerprint=sig_v1:aaaabbbbccccdddd`.',
    );
    expect(child).not.toContain('linting failed');
    // The line reports what came up. It asserts no fix, because nothing on the
    // row says one was made.
    expect(child).not.toContain('You fixed');
  });

  it('is asked once however many failures follow', async () => {
    const db = freshDb();
    started(db);
    setMark(db, CHILD, 'edited:abc', 'src/a.ts', NOW);
    await fire(db, childStop());

    // The re-arm is the LEAD's, and only the lead's: `stop()` sends an
    // already-asked child nowhere. A child's later turns are its answer turn
    // and whatever follows it, and it has no loop of its own to re-arm.
    seedFailure(db, CHILD, { at: NOW + 20 });
    expect(await fire(db, childStop({ lastMessage: 'done' }), TEAM, () => NOW + 30)).toBeNull();
  });
});

describe('the lead ask', () => {
  it('is asked once on a lookup that ran, and not re-armed by a publish (#294)', async () => {
    const db = freshDb();
    seedFire(db, LEAD, 'prompt', 'no-hit');
    const first = await fire(db, leadStop());
    expect(first?.context?.startsWith('Tenjin: this turn did work')).toBe(true);
    expect(first?.context).not.toContain('--agent');
    expect(getMark(db, LEAD, 'capture:asked')).toBe('lookup');

    // The answer turn (`stopFuse`), then an ordinary one, then one after a
    // publish: each writes its row and says nothing. Only a NEW failure re-arms
    // the lead, which is the case below.
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

  it('a failure is evidence whatever the lookup did, and a bare repeat is not', async () => {
    // NO OUTCOME DISQUALIFIES A FAILURE. `hit` says a note was injected, not
    // that it was right; `seen` is decided on the answer's resource id, so it
    // can mean only that a note about a NEIGHBOURING failure had been read.
    // Neither tells the agent this failure's key, which is what the next
    // teammate resolves under.
    for (const reason of ['no-hit', 'hit', 'seen', 'deadline', 'error', 'rate-server']) {
      const db = freshDb();
      seedFailure(db, LEAD, { reason });
      expect((await fire(db, leadStop()))?.context, reason).toContain(ENOENT_LINE);
      expect(getMark(db, LEAD, 'capture:asked'), reason).toBe('failure');
    }

    // The one thing a reason still decides: a claim answered from its own cache
    // ran no leg and cannot stand in for a first sighting.
    for (const reason of ['cached', 'asked']) {
      const repeat = freshDb();
      seedFailure(repeat, LEAD, { reason });
      expect(await fire(repeat, leadStop()), reason).toBeNull();
      expect(getMark(repeat, LEAD, 'capture:asked'), reason).toBeNull();
    }
  });

  it('names a second failure whose note the first failure had already shown', async () => {
    // The real shape: one actor hits the same error in two files, both prose
    // searches land on one note, so the first fire is `hit` and the second is
    // `seen` with nothing injected. Two distinct question keys, and the second
    // one's fingerprint has to survive into the ask.
    const db = freshDb();
    seedFailure(db, LEAD, { reason: 'hit', at: NOW - 50 });
    seedFailure(db, LEAD, {
      reason: 'seen',
      questionKey: 'sig_v1:bbbb1111bbbb1111',
      question: "TypeError: cfg.load is not a function ('src/b.ts')",
      at: NOW - 40,
    });
    const context = (await fire(db, leadStop()))?.context ?? '';
    const lines = context.split('\n').filter((l) => l.startsWith('- Encountered this turn'));
    expect(lines).toHaveLength(2);
    expect(context).toContain('--key fingerprint=sig_v1:aaaabbbbccccdddd');
    expect(context).toContain('--key fingerprint=sig_v1:bbbb1111bbbb1111');
  });

  it('names a failure the shelf rate-limited', async () => {
    // A 429 is one more way for the request not to land, the same class as
    // `deadline`. An allowlist of outcomes dropped it twice over.
    const db = freshDb();
    seedFailure(db, LEAD, { reason: 'rate-server' });
    expect((await fire(db, leadStop()))?.context).toContain(ENOENT_LINE);
    expect(getMark(db, LEAD, 'capture:asked')).toBe('failure');
  });

  it('names a failure whose lookup never finished, and the repeat behind it cannot stand in', async () => {
    // The gap the outcome filter left: `deadline` and `error` say nothing about
    // whether the shelf holds an answer, and reading only the misses dropped the
    // failure entirely, because every re-run behind it is a `cached` row.
    for (const reason of ['deadline', 'error']) {
      const db = freshDb();
      seedFailure(db, LEAD, { reason, at: NOW - 50 });
      seedFailure(db, LEAD, { reason: 'cached', at: NOW - 40 });
      const context = (await fire(db, leadStop()))?.context ?? '';
      expect(context, reason).toContain(ENOENT_LINE);
      expect(getMark(db, LEAD, 'capture:asked'), reason).toBe('failure');
    }

    // A repeat on its own is not a first sighting: `cached` alone earns nothing.
    const repeatOnly = freshDb();
    seedFailure(repeatOnly, LEAD, { reason: 'cached' });
    expect(await fire(repeatOnly, leadStop())).toBeNull();
  });

  it('names a failure whose prose note was delivered, because a note is not a key', async () => {
    // The first delivery, not the second: exact keys missed, a prose note came
    // back `strong` and was injected, and the fire recorded `hit`. Whether the
    // note solved it, needed a correction this repo alone knows, or missed the
    // problem is not legible from that row — and the note carries no
    // fingerprint of its own, so unless the agent files one the next teammate
    // resolving this key still finds nothing.
    const db = freshDb();
    seedFailure(db, LEAD, { reason: 'hit' });
    const context = (await fire(db, leadStop()))?.context ?? '';
    expect(context).toContain(ENOENT_LINE);
    expect(context).toContain('--key fingerprint=sig_v1:aaaabbbbccccdddd');
  });

  it('offers every fingerprint the arm resolves, one --key flag each', async () => {
    // Naming only the first filed the piece under `sig_v1` while the arm went on
    // asking `sig_v1_test` too, so the next teammate to hit that same test
    // resolved under a key nothing had ever been published against.
    const db = freshDb();
    seedFailure(db, LEAD, {
      questionKey: 'sig_v1:aaaabbbbccccdddd|sig_v1_test:0123456789abcdef',
    });
    const context = (await fire(db, leadStop()))?.context ?? '';
    expect(context).toContain(
      '`--key fingerprint=sig_v1:aaaabbbbccccdddd` `--key fingerprint=sig_v1_test:0123456789abcdef`',
    );
  });

  it('one line per failure, deduped by key, each naming what it can be filed under', async () => {
    const db = freshDb();
    // The same command re-run after a failed edit is one problem, not three.
    seedFailure(db, LEAD, { at: NOW - 50 });
    seedFailure(db, LEAD, { at: NOW - 40 });
    // A line too generic for `sigV1` to key. NOT NAMED: there is no key to
    // offer, so the line would say only what `CAPTURE_ASK` says already. The
    // arm still asks the shelf about it in words; only the nudge is dropped.
    seedFailure(db, LEAD, {
      questionKey: 'line:' + '0'.repeat(32),
      question: 'error: linting failed for the workspace',
      at: NOW - 30,
    });
    // A test identity and no error line at all: the empty `question` is a row
    // to name, not a row to filter, and the key is the whole of it.
    seedFailure(db, LEAD, {
      questionKey: 'sig_v1_test:0123456789abcdef',
      question: '',
      at: NOW - 20,
    });
    const reason = (await fire(db, leadStop()))?.context ?? '';
    const lines = reason.split('\n').filter((l) => l.startsWith('- Encountered this turn'));
    expect(lines).toEqual([
      '- Encountered this turn: `' +
        ENOENT_LINE +
        '`. If you settled it and the answer would save a teammate the same hour, publish it with ' +
        '`--key fingerprint=sig_v1:aaaabbbbccccdddd`.',
      '- Encountered this turn: A failure filed under ' +
        '`sig_v1_test:0123456789abcdef`. If you settled it and the answer would save a teammate the ' +
        'same hour, publish it with `--key fingerprint=sig_v1_test:0123456789abcdef`.',
    ]);
  });

  it('still asks for a failure with no fingerprint, and says nothing about it', async () => {
    // The whole turn is one unhashable failure: no edit, no search, no read, so
    // the failure is the only thing that can earn the ask. It must still earn
    // it. A piece published about this one carries no `--key` and is found by
    // the same words the failure arm searches with, so arming the ask off the
    // RENDERED LINES would close the write end of the loop the text stage opens.
    const db = freshDb();
    started(db);
    seedFailure(db, CHILD, {
      questionKey: 'line:' + '0'.repeat(32),
      question: 'error: linting failed for the workspace',
      at: NOW - 10,
    });
    const reason = (await fire(db, childStop()))?.context ?? '';
    expect(reason).toContain('Tenjin: this turn did work worth a second look.');
    // Asked, but with nothing added: the line would only repeat the ask above it.
    expect(reason).not.toContain('- Encountered this turn');
    expect(getMark(db, CHILD, 'capture:asked')).toBe('failure');
  });

  it('is re-armed by a failure hit after the ask, and not by one hit before it', async () => {
    const db = freshDb();
    seedFire(db, LEAD, 'prompt', 'no-hit');
    // Hit before the ask: the first ask already named it, so it re-arms nothing.
    seedFailure(db, LEAD, { at: NOW - 10 });
    expect((await fire(db, leadStop()))?.context).toContain('- Encountered this turn');
    await fire(db, leadStop({ stopFuse: true, lastMessage: 'first' }), TEAM, () => NOW + 5);
    expect(await fire(db, leadStop(), TEAM, () => NOW + 10)).toBeNull();

    // A wall it had to climb out of AFTER its first stop is something new to
    // say, and the first ask could not have named it.
    seedFailure(db, LEAD, {
      questionKey: 'sig_v1:1111222233334444|line:' + 'e'.repeat(32),
      question: 'error: EADDRINUSE: address already in use :::5433',
      at: NOW + 20,
    });
    const again = (await fire(db, leadStop(), TEAM, () => NOW + 30))?.context ?? '';
    expect(again).toContain('address already in use');
    expect(again).toContain('`--key fingerprint=sig_v1:1111222233334444`');
    // And only that one. The ENOENT did not come up this turn, and repeating
    // its `--key fingerprint=` offers a publish the agent may already have
    // made off the first ask.
    expect(again).not.toContain(ENOENT_LINE);
  });

  it('names a failure that keeps recurring once, and is not re-armed by its repeat', async () => {
    const db = freshDb();
    // `no-answer` is a leg that never landed, so the fire releases its
    // once-per-question claim: a shelf that cannot be reached writes a fresh
    // row behind every run of the same failing command.
    seedFailure(db, LEAD, { reason: 'no-answer', at: NOW - 10 });
    expect((await fire(db, leadStop()))?.context).toContain(ENOENT_LINE);
    await fire(db, leadStop({ stopFuse: true, lastMessage: 'first' }), TEAM, () => NOW + 5);

    seedFailure(db, LEAD, { reason: 'no-answer', at: NOW + 20 });
    expect(await fire(db, leadStop(), TEAM, () => NOW + 30)).toBeNull();
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
