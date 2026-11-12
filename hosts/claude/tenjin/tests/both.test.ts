import type { AgentSpawnInput, On, TurnStepInput } from 'claude-code';
import { expect, mock, test, type TestBody } from 'claude-code/testing';

import { bucketOf, HOLDOUT_PERCENT } from '../hooks/effort-rules';
import { DATA, NOW, SESSION, sha256Hex } from './fixtures';

/**
 * BOTH FEATURES IN ONE SESSION: main-agent effort (`effort.ts`) and a
 * delegated task's model and effort (`agents.tsx`) share the mod's one
 * `turn.step` hook and its one status entry. What breaks when this goes red:
 * a step sent to the wrong feature (a subagent given the main turn's level, or
 * a main turn given the subagent's), or one feature's status counts erasing
 * the other's.
 */

type $ = Parameters<TestBody>[0];

const HOME = '/home/test';
const CWD = `${HOME}/proj`;
const CALL = 'toolu_both';
const LONG =
  'Please read the three files in the docs folder and summarise each one in two short sentences for me.';

function engine(on: On) {
  const files = new Map<string, string>();
  const sent: { effort: unknown; agentId?: string }[] = [];
  const statuses: (string | undefined)[] = [];
  files.set(`${CWD}/.git`, '');
  files.set(`${DATA}/config.json`, JSON.stringify({ router: { effort: 'apply' } }));
  mock.env(on, { HOME });
  mock.clock(on, { now: NOW });
  on('session.id', () => ({ value: SESSION }));
  on('session.cwd', () => ({ value: CWD }));
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) }));
  on('fs.read', (_$, e) => {
    const text = files.get(e.path);
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text };
  });
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }));
  on('ui.log', () => ({ value: undefined }));
  on('ui.status', (_$, e) => {
    statuses.push(e.text);
    return { value: undefined };
  });
  on('prompt.submit', (_$, e) => ({ text: e.text }));
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('agent.spawn', (_$, e) => ({ model: e.model ?? e.parentModel, agentId: 'agent-1' }));
  // eslint-disable-next-line require-yield
  on('turn.step', async function* (_$, e) {
    sent.push({ effort: e.effort, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) });
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: null,
    };
  });
  on('turn.complete', (_$, e) => ({ text: e.answer }));
  return { files, sent, statuses };
}

/** A main-session turn outside the holdout, with one model request. */
async function turn($: $, text: string, seed: { next: number }) {
  let id: string;
  do id = `turn-${(seed.next += 1)}`;
  while (bucketOf(await sha256Hex(`${SESSION}:${id}`)) < HOLDOUT_PERCENT);
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } });
  await $.turn.start({ text, turnId: id });
  await step($, id, 'xhigh');
  await $.turn.complete({
    turnId: id,
    answer: 'Done.',
    durationMs: 1000,
    isAborted: false,
    reason: 'answer',
  });
}

async function step($: $, turnId: string, effort: string, agentId?: string) {
  const stream = $.turn.step({
    turnId,
    index: 0,
    model: 'claude-sonnet-5-5',
    effort: effort as TurnStepInput['effort'],
    messageCount: 1,
    ...(agentId !== undefined ? { agentId } : {}),
  });
  for await (const _ of stream) void _;
}

const SPAWN: AgentSpawnInput = {
  tool_use_id: CALL,
  prompt: 'Explore where the config loader lives.',
  description: 'find the loader',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  model: 'opus',
  parentModel: 'claude-opus-5-5',
  permissionMode: 'auto',
  background: false,
  fork: false,
};

test('a subagent step takes its record, a main step its turn, and the status keeps both', async ($, on) => {
  const w = engine(on);
  const seed = { next: 0 };
  await turn($, LONG, seed);
  w.files.set(
    `${DATA}/agent-routes/${await sha256Hex(CALL)}.json`,
    JSON.stringify({
      version: 1,
      at: NOW,
      session: await sha256Hex(SESSION),
      route: 'claude',
      runsOn: { model: 'opus', effort: 'xhigh' },
      model: { setting: 'apply', decided: 'sonnet', apply: true },
      effort: { setting: 'apply', decided: 'medium', apply: true },
      reason: 'read-only search agent',
      saving: { model: 40, effort: 28, both: 57 },
      holdout: false,
    }),
  );
  await $.agent.spawn(SPAWN);
  await step($, 'sub-1', 'xhigh', 'agent-1');
  await turn($, 'go ahead', seed);
  // The session is on xhigh: the ack runs one step lower, the subagent at its record's level.
  expect(w.sent).toEqual([
    { effort: 'xhigh' },
    { effort: 'medium', agentId: 'agent-1' },
    { effort: 'high' },
  ]);
  const last = w.statuses.at(-1) ?? '';
  expect(last).toMatch(/^Tenjin subagents: model on, effort on · 1 spawns · 1 routed/);
  expect(last).toContain(' | turns: effort on · 1 lower');
});
