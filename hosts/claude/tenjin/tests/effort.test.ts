import type { On } from 'claude-code';
import { describe, expect, mock, test, type TestBody } from 'claude-code/testing';

import { bucketOf, HOLDOUT_PERCENT, LADDER, type Level } from '../hooks/effort-rules';
import { NOW, SESSION, sha256Hex } from './fixtures';

/**
 * MAIN-AGENT EFFORT through the mod: each class and floor, one step and never
 * the wrong way, main-loop steps only, held for the turn, the holdout, `off`
 * as today, the switch's floor, and records with no text.
 */

type $ = Parameters<TestBody>[0];
type Run = { argv: readonly string[]; stdin: string };

const HOME = '/home/test';
const SONNET = 'claude-sonnet-5-5';
const CONFIG = `${HOME}/.tenjin/config.json`;
const CWD = `${HOME}/proj`;
const LONG =
  'Please read the three files in the docs folder and summarise each one in two short sentences for me.';

/** The engine beneath the mod: the events a main turn raises, and what the mod sends and writes. */
function engine(on: On, files: Record<string, string> = {}) {
  const sent: { effort: unknown; agentId?: string }[] = [];
  const runs: Run[] = [];
  const logs: string[] = [];
  const statuses: (string | undefined)[] = [];
  const disk = new Map(Object.entries(files));
  disk.set(`${CWD}/.git`, '');
  mock.env(on, { HOME });
  mock.clock(on, { now: NOW });
  on('session.id', () => ({ value: SESSION }));
  on('session.cwd', () => ({ value: CWD }));
  on('fs.exists', (_$, e) => ({ value: disk.has(e.path) }));
  on('fs.read', (_$, e) => {
    const text = disk.get(e.path);
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text };
  });
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin ?? '' });
    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on('ui.log', (_$, e) => {
    logs.push(e.text);
    return { value: undefined };
  });
  on('ui.status', (_$, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on('prompt.submit', (_$, e) => ({ text: e.text }));
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  // The model's answer with no streamed pieces: the stream is the result alone.
  // eslint-disable-next-line require-yield
  on('turn.step', async function* (_$, e) {
    sent.push({ effort: e.effort, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) });
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });
  on('turn.complete', (_$, e) => ({ text: e.answer }));
  return { sent, runs, logs, statuses, disk };
}

const config = (router: Record<string, unknown>) => ({ [CONFIG]: JSON.stringify({ router }) });
const APPLY = config({ effort: 'apply' });

type TurnOptions = {
  origin?: string;
  effort?: Level | number;
  model?: string;
  steps?: number;
  answer?: string;
  command?: { name: string; args: string };
  /** Raised between the first and the second step, as a subagent's request. */
  agentStep?: boolean;
  /** Typed while the turn runs, before its second step. */
  typedMidTurn?: string;
};

let next = 0;
/** A turn id outside the holdout, or inside it with `held`. */
async function turnId(held = false): Promise<string> {
  for (;;) {
    const id = `turn-${(next += 1)}`;
    const inside = bucketOf(await sha256Hex(`${SESSION}:${id}`)) < HOLDOUT_PERCENT;
    if (inside === held) return id;
  }
}

async function turn($: $, text: string, o: TurnOptions = {}, id?: string): Promise<string> {
  const turn = id ?? (await turnId());
  await $.prompt.submit({
    text,
    wait: false,
    origin: { kind: (o.origin ?? 'composer') as 'composer' },
    ...(o.command !== undefined ? { command: o.command } : {}),
  });
  await $.turn.start({ text, turnId: turn });
  const steps = o.steps ?? 1;
  for (let index = 0; index < steps; index += 1) {
    if (index === 1 && o.agentStep === true) {
      await drain($, turn, index, o.effort ?? 'high', o.model, 'a1');
    }
    if (index === 1 && o.typedMidTurn !== undefined) {
      await $.prompt.submit({
        text: o.typedMidTurn,
        wait: false,
        origin: { kind: 'composer' },
        turnId: turn,
      });
    }
    await drain($, turn, index, o.effort ?? 'high', o.model);
  }
  await $.turn.complete({
    turnId: turn,
    answer: o.answer ?? 'Done.',
    durationMs: 2500,
    isAborted: false,
    reason: 'answer',
    usage: {
      model: 'claude-sonnet',
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 30,
    },
  });
  return turn;
}

async function drain(
  $: $,
  turnId: string,
  index: number,
  effort: unknown,
  model = SONNET,
  agentId?: string,
) {
  const stream = $.turn.step({
    turnId,
    index,
    model,
    ...(effort !== undefined ? { effort: effort as Level } : {}),
    messageCount: 10 + index,
    ...(agentId !== undefined ? { agentId } : {}),
  });
  for await (const _chunk of stream) void _chunk;
}

const records = (runs: Run[]) => runs.map((r) => JSON.parse(r.stdin) as Record<string, unknown>);
const lastEffort = (sent: { effort: unknown }[]) => sent.at(-1)?.effort;

describe('off, the default', () => {
  test('sends every request as the engine would, and draws and writes nothing', async ($, on) => {
    const w = engine(on);
    await turn($, LONG);
    await turn($, 'go ahead');
    await turn($, '<task-notification>done</task-notification>', { origin: 'task-notification' });
    await turn($, 'no, that is wrong');
    expect(w.sent.map((s) => s.effort)).toEqual(['high', 'high', 'high', 'high']);
    expect(w.runs).toEqual([]);
    expect(w.logs).toEqual([]);
    expect(w.statuses).toEqual([]);
  });

  test('a project file cannot turn it on', async ($, on) => {
    const w = engine(on, {
      [`${CWD}/.tenjin/config.json`]: JSON.stringify({ router: { effort: 'apply' } }),
    });
    await turn($, LONG);
    await turn($, 'go ahead');
    expect(w.sent.map((s) => s.effort)).toEqual(['high', 'high']);
    expect(w.runs).toEqual([]);
  });
});

describe('apply', () => {
  test('an ack runs one step lower, says so once, and counts it', async ($, on) => {
    const w = engine(on, APPLY);
    await turn($, LONG);
    await turn($, 'go ahead');
    expect(w.sent.map((s) => s.effort)).toEqual(['high', 'medium']);
    expect(w.logs).toEqual(['Tenjin ran this turn at medium; the session is on high']);
    expect(w.statuses.at(-1)).toContain('Tenjin turns: effort on · 1 lower');
  });

  test('a turn a background task started runs one step lower', async ($, on) => {
    const w = engine(on, APPLY);
    await turn($, LONG);
    await turn($, `<task-notification>${LONG}</task-notification>`, {
      origin: 'task-notification',
    });
    expect(lastEffort(w.sent)).toBe('medium');
    expect(records(w.runs).at(-1)).toMatchObject({ class: 'notification', effortUsed: 'medium' });
  });

  test('a long typed instruction, a question and a command keep the session level and leave no record', async ($, on) => {
    const w = engine(on, APPLY);
    await turn($, LONG);
    await turn(
      $,
      LONG.replace('three', 'four').replace('docs', 'notes').replace('summarise', 'list'),
    );
    await turn($, 'ready?');
    await turn($, 'x', { command: { name: 'review', args: '' } });
    expect(w.sent.map((s) => s.effort)).toEqual(['high', 'high', 'high', 'high']);
    expect(w.logs).toEqual([]);
    expect(w.runs).toEqual([]);
  });

  test('never raises a lowering class, and keeps the lowest level', async ($, on) => {
    const w = engine(on, APPLY);
    await turn($, LONG, { effort: 'max' });
    for (const level of [...LADDER].reverse()) {
      await turn($, 'go ahead', { effort: level });
      await turn($, 'ok', { effort: level });
    }
    const acks = w.sent.slice(1).map((s) => s.effort as Level);
    const asked = [...LADDER].reverse().flatMap((l) => [l, l]);
    acks.forEach((used, at) => {
      expect(LADDER.indexOf(used)).toBeLessThanOrEqual(LADDER.indexOf(asked[at] as Level));
    });
    expect(acks.at(-1)).toBe('low');
  });

  test('holds the level for every request of the turn, and never touches a subagent step', async ($, on) => {
    const w = engine(on, APPLY);
    await turn($, LONG);
    await turn($, 'go ahead', { steps: 3, agentStep: true });
    expect(w.sent.slice(1)).toEqual([
      { effort: 'medium' },
      { effort: 'high', agentId: 'a1' },
      { effort: 'medium' },
      { effort: 'medium' },
    ]);
  });

  test('a message typed into a lowered turn runs the rest of it as asked', async ($, on) => {
    const w = engine(on, APPLY);
    await turn($, LONG);
    await turn($, 'go ahead', { steps: 3, typedMidTurn: LONG });
    expect(w.sent.slice(1).map((s) => s.effort)).toEqual(['medium', 'high', 'high']);
    expect(records(w.runs).at(-1)).toMatchObject({ released: true, effortUsed: 'high' });
  });

  test('a held-out turn runs as asked, shows nothing, and is recorded as held out', async ($, on) => {
    const w = engine(on, APPLY);
    await turn($, LONG);
    await turn($, 'go ahead', {}, await turnId(true));
    expect(lastEffort(w.sent)).toBe('high');
    expect(w.logs).toEqual([]);
    expect(records(w.runs).at(-1)).toMatchObject({
      holdout: true,
      effortUsed: 'high',
      floor: null,
    });
    expect(w.statuses.at(-1)).toContain('1 held out');
  });
});

describe('floors', () => {
  test('the first turn of a session keeps its level', async ($, on) => {
    const w = engine(on, APPLY);
    await turn($, 'go ahead');
    expect(lastEffort(w.sent)).toBe('high');
    expect(records(w.runs).at(-1)).toMatchObject({ class: 'ack', floor: 'first-turn' });
  });

  test('effort set by hand since the last turn keeps the level and is counted', async ($, on) => {
    const w = engine(on, APPLY);
    await turn($, LONG);
    await turn($, 'go ahead', { effort: 'xhigh' });
    expect(lastEffort(w.sent)).toBe('xhigh');
    // A local command: it raises a submission and starts no model turn.
    await $.prompt.submit({
      text: '/effort xhigh',
      wait: false,
      origin: { kind: 'composer' },
      command: { name: 'effort', args: 'xhigh' },
    });
    await turn($, 'go ahead', { effort: 'xhigh' });
    expect(lastEffort(w.sent)).toBe('xhigh');
    const kept = records(w.runs).filter((r) => r.floor === 'effort-by-hand');
    expect(kept).toHaveLength(2);
    expect(kept.every((r) => r.effortByHand === true)).toBe(true);
    expect(w.statuses.at(-1)).toContain('2 set by hand');
  });

  test('an ack to a question about a push, money or a deletion keeps its level', async ($, on) => {
    const w = engine(on, APPLY);
    for (const answer of [
      'The branch is ready. Shall I push it?',
      'That costs $0.04 from the wallet. Go ahead?',
      'This deletes 12 files. Confirm and I will remove them.',
    ]) {
      await turn($, LONG, { answer });
      await turn($, 'yes');
      expect(lastEffort(w.sent)).toBe('high');
    }
    expect(records(w.runs).map((r) => r.floor)).toEqual(['approval', 'approval', 'approval']);
  });

  test('a level off the ladder is kept', async ($, on) => {
    const w = engine(on, APPLY);
    await turn($, LONG, { effort: 4096 });
    await turn($, 'go ahead', { effort: 4096 });
    expect(lastEffort(w.sent)).toBe(4096);
    expect(records(w.runs).at(-1)).toMatchObject({ floor: 'no-effort', effortUsed: null });
  });
});

describe('correction, the one raise', () => {
  const ON = config({ effort: 'apply', effortClasses: ['notification', 'ack', 'correction'] });

  test('is off unless listed: a correction or a think keyword keeps its level', async ($, on) => {
    const w = engine(on, APPLY);
    await turn($, LONG);
    await turn($, 'no, that is wrong');
    await turn($, 'think harder');
    expect(w.sent.map((s) => s.effort)).toEqual(['high', 'high', 'high']);
    const thought = records(w.runs);
    expect(thought).toHaveLength(1);
    expect(thought[0]).toMatchObject({ class: 'correction', moreThought: true, effortUsed: null });
    expect(w.statuses.at(-1)).toContain('1 asked to think');
  });

  test('listed, it runs a correction one step higher', async ($, on) => {
    const w = engine(on, ON);
    await turn($, LONG);
    await turn($, 'no, that is wrong');
    expect(lastEffort(w.sent)).toBe('xhigh');
    expect(w.logs).toEqual(['Tenjin ran this turn at xhigh; the session is on high']);
    expect(records(w.runs).at(-1)).toMatchObject({ class: 'correction', reason: 'negation' });
    expect(w.statuses.at(-1)).toContain('1 higher');
  });

  test('the same ask again is a correction', async ($, on) => {
    const w = engine(on, ON);
    await turn($, LONG);
    await turn($, LONG.replace('Please read', 'Read'));
    expect(lastEffort(w.sent)).toBe('xhigh');
    expect(records(w.runs).at(-1)).toMatchObject({ reason: 'repeat' });
  });

  test('never goes past the cap, xhigh by default', async ($, on) => {
    const w = engine(on, ON);
    await turn($, LONG, { effort: 'xhigh' });
    await turn($, 'try again', { effort: 'xhigh' });
    await turn($, 'think harder about it', { effort: 'xhigh' });
    expect(w.sent.map((s) => s.effort)).toEqual(['xhigh', 'xhigh', 'xhigh']);
    expect(records(w.runs).map((r) => [r.floor, r.moreThought])).toEqual([
      ['cap', false],
      ['cap', true],
    ]);
    expect(w.logs).toEqual([]);
  });

  test('a lower cap stops it sooner', async ($, on) => {
    const w = engine(
      on,
      config({ effort: 'apply', effortClasses: ['correction'], effortCap: 'high' }),
    );
    await turn($, LONG, { effort: 'medium' });
    await turn($, 'wrong, redo it', { effort: 'medium' });
    expect(lastEffort(w.sent)).toBe('high');
    await turn($, 'that is still wrong', { effort: 'medium' });
    expect(lastEffort(w.sent)).toBe('high');
  });

  test('a lower cap keeps a session already at it', async ($, on) => {
    const w = engine(
      on,
      config({ effort: 'apply', effortClasses: ['correction'], effortCap: 'high' }),
    );
    await turn($, LONG);
    await turn($, 'wrong, redo it');
    expect(lastEffort(w.sent)).toBe('high');
    expect(records(w.runs).at(-1)).toMatchObject({ floor: 'cap' });
  });
});

describe('max', () => {
  const MAX = config({
    effort: 'apply',
    effortClasses: ['notification', 'ack', 'correction'],
    effortCap: 'max',
  });

  test('a correction from xhigh with the cap at max runs at max, on Sonnet and Opus', async ($, on) => {
    const w = engine(on, MAX);
    await turn($, LONG, { effort: 'xhigh' });
    await turn($, 'no, that is wrong', { effort: 'xhigh' });
    expect(lastEffort(w.sent)).toBe('max');
    await turn($, 'try again', { effort: 'xhigh', model: 'claude-opus-5-5' });
    expect(lastEffort(w.sent)).toBe('max');
    expect(w.logs.at(-1)).toBe('Tenjin ran this turn at max; the session is on xhigh');
  });

  test('a correction at max stays at max', async ($, on) => {
    const w = engine(on, MAX);
    await turn($, LONG, { effort: 'max' });
    await turn($, 'no, that is wrong', { effort: 'max' });
    expect(lastEffort(w.sent)).toBe('max');
    expect(records(w.runs).at(-1)).toMatchObject({ floor: 'cap', effortUsed: 'max' });
  });

  test('a max session steps down one level, and a floored turn keeps max', async ($, on) => {
    const w = engine(on, MAX);
    await turn($, 'go ahead', { effort: 'max' });
    expect(lastEffort(w.sent)).toBe('max');
    await turn($, 'go ahead', { effort: 'max' });
    expect(lastEffort(w.sent)).toBe('xhigh');
    expect(w.logs).toEqual(['Tenjin ran this turn at xhigh; the session is on max']);
  });

  test('a model not known to take max keeps its level, recorded with the reason', async ($, on) => {
    const w = engine(on, MAX);
    const model = 'claude-haiku-4-5';
    await turn($, LONG, { effort: 'xhigh', model });
    await turn($, 'no, that is wrong', { effort: 'xhigh', model });
    expect(lastEffort(w.sent)).toBe('xhigh');
    expect(records(w.runs).at(-1)).toMatchObject({ floor: 'max-unverified', effortUsed: 'xhigh' });
    expect(w.logs).toEqual([]);
  });
});

describe('deeper lowering, an operator setting', () => {
  const DEEP = config({
    effort: 'apply',
    effortSteps: { notification: 2 },
    effortFloor: 'low',
  });
  const NOTICE = `<task-notification>${LONG}</task-notification>`;
  const notice = { origin: 'task-notification' } as const;

  test('two steps from high land on low, and the record keeps the class, the level asked and the level run', async ($, on) => {
    const w = engine(on, DEEP);
    await turn($, LONG);
    await turn($, NOTICE, notice);
    expect(lastEffort(w.sent)).toBe('low');
    expect(records(w.runs).at(-1)).toMatchObject({
      class: 'notification',
      sessionEffort: 'high',
      effortUsed: 'low',
      floor: null,
    });
    // `ack` was left at one step.
    await turn($, 'go ahead');
    expect(lastEffort(w.sent)).toBe('medium');
  });

  test('two steps from medium stop at the floor', async ($, on) => {
    const w = engine(on, DEEP);
    await turn($, LONG, { effort: 'medium' });
    await turn($, NOTICE, { ...notice, effort: 'medium' });
    expect(lastEffort(w.sent)).toBe('low');
    expect(records(w.runs).at(-1)).toMatchObject({ sessionEffort: 'medium', effortUsed: 'low' });
  });

  test('the medium floor, the default, refuses low: two steps from high stop at medium', async ($, on) => {
    const w = engine(on, config({ effort: 'apply', effortSteps: { notification: 2 } }));
    await turn($, LONG);
    await turn($, NOTICE, notice);
    expect(lastEffort(w.sent)).toBe('medium');
    await turn($, LONG, { effort: 'medium' });
    await turn($, 'go ahead', { effort: 'medium' });
    expect(lastEffort(w.sent)).toBe('medium');
    expect(records(w.runs).at(-1)).toMatchObject({
      class: 'ack',
      floor: 'effort-floor',
      sessionEffort: 'medium',
      effortUsed: 'medium',
    });
  });

  test('keeps a floored turn and holds out as before', async ($, on) => {
    const w = engine(on, DEEP);
    await turn($, NOTICE, notice);
    expect(lastEffort(w.sent)).toBe('high');
    expect(records(w.runs).at(-1)).toMatchObject({ floor: 'first-turn', effortUsed: 'high' });
    await turn($, NOTICE, notice, await turnId(true));
    expect(lastEffort(w.sent)).toBe('high');
    expect(records(w.runs).at(-1)).toMatchObject({ holdout: true, effortUsed: 'high' });
  });

  test('never raises: a session at low stays at low', async ($, on) => {
    const w = engine(on, DEEP);
    await turn($, LONG, { effort: 'low' });
    await turn($, NOTICE, { ...notice, effort: 'low' });
    expect(w.sent.map((sent) => sent.effort)).toEqual(['low', 'low']);
    expect(records(w.runs).at(-1)).toMatchObject({ floor: 'lowest', effortUsed: 'low' });
  });
});

describe('shadow', () => {
  test('decides and records, sends nothing different, and says would have', async ($, on) => {
    const w = engine(on, config({ effort: 'shadow' }));
    await turn($, LONG);
    await turn($, 'go ahead');
    expect(w.sent.map((s) => s.effort)).toEqual(['high', 'high']);
    expect(w.logs).toEqual(['Tenjin would have run this turn at medium; the session is on high']);
    expect(records(w.runs).at(-1)).toMatchObject({ mode: 'shadow', effortUsed: 'high' });
  });

  test('a project file lowers apply to shadow', async ($, on) => {
    const w = engine(on, {
      ...APPLY,
      [`${CWD}/.tenjin/config.local.json`]: JSON.stringify({ router: { effort: 'shadow' } }),
    });
    await turn($, LONG);
    await turn($, 'go ahead');
    expect(lastEffort(w.sent)).toBe('high');
  });
});

describe('records', () => {
  test('one 0600 file per turn the rules touched, holding no text and no hash of it', async ($, on) => {
    const w = engine(on, APPLY);
    const prompt = 'ship it now';
    await turn($, LONG);
    await turn($, prompt);
    expect(w.runs).toHaveLength(1);
    const [run] = w.runs;
    expect(run?.argv[0]).toBe('node');
    expect(run?.argv[2]).toContain('mode:0o600');
    expect(run?.argv[3]).toBe(`${HOME}/.tenjin/effort`);
    expect(run?.argv[4]).toMatch(/^turn-[0-9a-f]{64}\.json$/);
    const record = JSON.parse(run?.stdin ?? '{}') as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(
      [
        'version',
        'at',
        'session',
        'turn',
        'mode',
        'class',
        'reason',
        'floor',
        'sessionEffort',
        'effortUsed',
        'holdout',
        'released',
        'effortByHand',
        'moreThought',
        'steps',
        'seconds',
        'end',
        'model',
        'tokens',
      ].sort(),
    );
    expect(record).toMatchObject({
      class: 'ack',
      sessionEffort: 'high',
      effortUsed: 'medium',
      steps: 1,
      seconds: 2.5,
      tokens: { input: 10, output: 20, cacheRead: 4000, cacheCreation: 30 },
    });
    const body = run?.stdin ?? '';
    for (const text of [prompt, LONG, 'Done.']) {
      expect(body).not.toContain(text);
      expect(body).not.toContain(await sha256Hex(text));
    }
  });
});
