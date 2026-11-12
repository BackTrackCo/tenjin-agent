import type { AgentSpawnInput, On, TurnStepInput } from 'claude-code';
import { expect, mock, test, type TestBody } from 'claude-code/testing';

import { DATA, NOW, SESSION, SURFACES, sha256Hex, shownLines, toolRow } from './fixtures';

/**
 * DELEGATED TASKS: the offer line appended in `agent.spawn`, and the model and
 * effort the CLI's agent record names, each applied only under its own switch.
 * What breaks when these go red: an offer lost or doubled, a rewrite of a
 * resume, a fork, a held-out or kept spawn, a model or effort raised, any key
 * but `model` and `prompt` changed, an effort not set on a resumed run, a
 * main-loop step touched, or a row line that says what did not happen.
 */

type $ = Parameters<TestBody>[0];

const CALL = 'toolu_spawn';
const LINE = 'Tenjin router (installed by the user), optional: call request({id: "k3f9"}).';

/** The engine beneath the mod: spawns, model steps, the Agent row and the status line. */
function engine(on: On, env: Record<string, string> = {}, refuse?: string) {
  const files = new Map<string, string>();
  const spawned: AgentSpawnInput[] = [];
  const refused: AgentSpawnInput[] = [];
  /** What the mod keeps for each Agent row (`agentRows`), as it sets it. */
  const rows: unknown[] = [];
  on('state.set', (_engine, e, next) => {
    if ((e as { key?: string }).key === 'agentRows') rows.push((e as { value?: unknown }).value);
    return next(e);
  });
  const steps: TurnStepInput[] = [];
  const status: (string | undefined)[] = [];
  mock.env(on, { HOME: '/home/test', ...env });
  mock.clock(on, { now: NOW });
  on('session.id', () => ({ value: SESSION }));
  on('fs.read', (_$, e) => {
    const text = files.get(e.path);
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text };
  });
  // The host resolves a tier alias to its current model, and may refuse one.
  on('agent.spawn', (_$, e) => {
    if (refuse !== undefined && e.model === refuse) {
      refused.push(e);
      return { deny: `${refuse} is not offered here` };
    }
    spawned.push(e);
    const model = e.model ?? e.parentModel;
    return {
      model: model === 'haiku' ? 'claude-haiku-4-5' : model,
      agentId: e.resume?.agentId ?? 'agent-1',
    };
  });
  // The model's answer, whole, with no chunks: a stream hook is a generator.
  // eslint-disable-next-line require-yield
  on('turn.step', async function* (_$, e) {
    steps.push(e);
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: null,
    };
  });
  on('ui.status', (_$, e) => {
    status.push(e.text);
    return { value: undefined };
  });
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [`⏺ ${e.props.tool}(find the loader)`] });
  });
  return { files, spawned, refused, rows, steps, status };
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

/** The agent leg's record for the call, as `recordAgentSpawn` writes it. */
async function keepRoute(files: Map<string, string>, record: Record<string, unknown> = {}) {
  files.set(
    `${DATA}/agent-routes/${await sha256Hex(CALL)}.json`,
    JSON.stringify({
      version: 1,
      at: NOW,
      session: await sha256Hex(SESSION),
      toolUseId: CALL,
      route: 'claude',
      runsOn: { model: 'opus', effort: 'high' },
      model: { setting: 'apply', decided: 'sonnet', apply: true },
      effort: { setting: 'apply', decided: 'medium', apply: true },
      reason: 'read-only search agent',
      saving: { model: 40, effort: 15, both: 49 },
      holdout: false,
      ...record,
    }),
  );
}

/** The offer line the agent leg keeps for the call (`markDelegated`). */
async function keepLine(files: Map<string, string>, record: Record<string, unknown> = {}) {
  files.set(
    `${DATA}/progress/${await sha256Hex(SESSION)}/delegate-${await sha256Hex(CALL)}.json`,
    JSON.stringify({ version: 1, at: NOW, offerId: 'k3f9', line: LINE, ...record }),
  );
}

async function step($: $, index: number, agentId?: string, effort = 'high') {
  const stream = $.turn.step({
    turnId: 't1',
    index,
    model: 'claude-sonnet-5-5',
    effort: effort as TurnStepInput['effort'],
    messageCount: 1,
    ...(agentId !== undefined ? { agentId } : {}),
  });
  for await (const _ of stream) void _;
  return stream.result;
}

async function rowLines($: $) {
  const lines: string[][] = [];
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: toolRow(CALL, 'Agent', { prompt: SPAWN.prompt }, 'done'),
    });
    lines.push(await shownLines(ui));
    await ui.unmount();
  }
  return lines;
}

/** Every key but the two the mod may set, as the engine received them. */
const fixed = (e: AgentSpawnInput) =>
  Object.fromEntries(Object.entries(e).filter(([key]) => key !== 'model' && key !== 'prompt'));

test('a routed spawn runs on the lower model with the offer, and every other key as asked', async ($, on) => {
  const { files, spawned, status } = engine(on);
  await keepRoute(files);
  await keepLine(files);
  await $.agent.spawn(SPAWN);
  expect(spawned).toHaveLength(1);
  expect(spawned[0]!.model).toBe('sonnet');
  expect(spawned[0]!.prompt).toBe(`${SPAWN.prompt}\n\n${LINE}`);
  expect(fixed(spawned[0]!)).toEqual(fixed(SPAWN));
  for (const lines of await rowLines($)) {
    expect(lines).toEqual([
      '⏺ Agent(find the loader)',
      '  ⎿  Tenjin ran this on Sonnet (asked Opus) at medium (asked high) · read-only search agent · about 49% less usage',
    ]);
  }
  expect(status.at(-1)).toBe(
    'Tenjin subagents: model on, effort on · 1 spawns · 1 routed · 0 held out · explore and research only',
  );
});

test('the effort is set on every step of the routed subagent, a resumed run included, and nowhere else', async ($, on) => {
  const { files, steps } = engine(on);
  await keepRoute(files);
  await $.agent.spawn(SPAWN);
  await step($, 0, 'agent-1');
  await step($, 1, 'agent-1');
  // The main loop and another subagent are untouched.
  await step($, 2);
  await step($, 0, 'agent-other');
  // A resume: the engine falls back to the effort first asked for.
  await $.agent.spawn({ ...SPAWN, prompt: 'one more thing', resume: { agentId: 'agent-1' } });
  await step($, 0, 'agent-1');
  expect(steps.map((s) => [s.agentId ?? 'main', s.effort])).toEqual([
    ['agent-1', 'medium'],
    ['agent-1', 'medium'],
    ['main', 'high'],
    ['agent-other', 'high'],
    ['agent-1', 'medium'],
  ]);
});

test('a resume, a fork, a missing, stale or foreign record runs as asked', async ($, on) => {
  const { files, spawned } = engine(on);
  await keepLine(files);
  await keepRoute(files);
  await $.agent.spawn({ ...SPAWN, resume: { agentId: 'agent-9' } });
  await $.agent.spawn({ ...SPAWN, fork: true });
  await keepRoute(files, { at: NOW - 11 * 60_000 });
  await keepLine(files, { at: NOW - 11 * 60_000 });
  await $.agent.spawn(SPAWN);
  await keepRoute(files, { session: await sha256Hex('another session') });
  files.delete(
    `${DATA}/progress/${await sha256Hex(SESSION)}/delegate-${await sha256Hex(CALL)}.json`,
  );
  await $.agent.spawn(SPAWN);
  expect(spawned).toHaveLength(4);
  for (const e of spawned) {
    expect(e.model).toBe('opus');
    expect(e.prompt).toBe(SPAWN.prompt);
  }
});

test('a held-out spawn runs as asked and says so; a kept one shows nothing', async ($, on) => {
  const { files, spawned, steps } = engine(on);
  await keepRoute(files, {
    holdout: true,
    model: { setting: 'apply', decided: 'sonnet', apply: false },
    effort: { setting: 'apply', decided: 'medium', apply: false },
  });
  await $.agent.spawn(SPAWN);
  await step($, 0, 'agent-1');
  expect(spawned[0]!.model).toBe('opus');
  expect(steps[0]!.effort).toBe('high');
  for (const lines of await rowLines($)) {
    expect(lines).toEqual(['⏺ Agent(find the loader)', '  ⎿  Tenjin left this as asked (holdout)']);
  }
});

test('a kept spawn changes nothing and draws only the engine row', async ($, on) => {
  const { files, spawned } = engine(on);
  await keepRoute(files, {
    route: 'keep',
    model: { setting: 'apply', apply: false },
    effort: { setting: 'apply', apply: false },
  });
  await $.agent.spawn(SPAWN);
  expect(spawned[0]).toEqual(SPAWN);
  for (const lines of await rowLines($)) expect(lines).toEqual(['⏺ Agent(find the loader)']);
});

test('each dimension changes only under its own switch', async ($, on) => {
  const { files, spawned, steps } = engine(on);
  await keepRoute(files, { effort: { setting: 'off', decided: 'medium', apply: false } });
  await $.agent.spawn(SPAWN);
  await step($, 0, 'agent-1');
  expect(spawned[0]!.model).toBe('sonnet');
  expect(steps[0]!.effort).toBe('high');
  for (const lines of await rowLines($)) {
    expect(lines.at(-1)).toBe(
      '  ⎿  Tenjin ran this on Sonnet (asked Opus) · read-only search agent · about 40% less usage',
    );
  }
});

test('the effort alone, with the model kept', async ($, on) => {
  const { files, spawned, steps } = engine(on);
  await keepRoute(files, { model: { setting: 'off', decided: 'sonnet', apply: false } });
  await $.agent.spawn(SPAWN);
  await step($, 0, 'agent-1');
  expect(spawned[0]!.model).toBe('opus');
  expect(steps[0]!.effort).toBe('medium');
  for (const lines of await rowLines($)) {
    expect(lines.at(-1)).toBe(
      '  ⎿  Tenjin ran this at medium (asked high) · read-only search agent · about 15% less usage',
    );
  }
});

test('shadow changes nothing and says what it would do', async ($, on) => {
  const { files, spawned, steps, status } = engine(on);
  await keepRoute(files, {
    model: { setting: 'shadow', decided: 'sonnet', apply: false },
    effort: { setting: 'shadow', decided: 'medium', apply: false },
  });
  await $.agent.spawn(SPAWN);
  await step($, 0, 'agent-1');
  expect(spawned[0]).toEqual(SPAWN);
  expect(steps[0]!.effort).toBe('high');
  for (const lines of await rowLines($)) {
    expect(lines.at(-1)).toBe(
      '  ⎿  Tenjin would run this on Sonnet (asked Opus) at medium (asked high) · read-only search agent · about 49% less usage',
    );
  }
  expect(status.at(-1)).toContain('1 would move');
});

test('a subagent asked for max effort is lowered on every step and the row names max', async ($, on) => {
  const { files, steps } = engine(on);
  await keepRoute(files, { runsOn: { model: 'opus', effort: 'max' } });
  await $.agent.spawn(SPAWN);
  await step($, 0, 'agent-1', 'max');
  await step($, 1, 'agent-1', 'max');
  expect(steps.map((s) => s.effort)).toEqual(['medium', 'medium']);
  for (const lines of await rowLines($)) {
    expect(lines.at(-1)).toContain('at medium (asked max)');
  }
});

test('a step whose effort is not a level this knows, or absent, is sent as it is', async ($, on) => {
  const { files, steps } = engine(on);
  await keepRoute(files);
  await $.agent.spawn(SPAWN);
  await step($, 0, 'agent-1', 'turbo');
  expect(steps[0]!.effort).toBe('turbo');
});

test('nothing is ever raised: a spawn already below the record runs as asked', async ($, on) => {
  const { files, spawned, steps } = engine(on);
  await keepRoute(files);
  await $.agent.spawn({ ...SPAWN, model: 'haiku' });
  await step($, 0, 'agent-1', 'low');
  expect(spawned[0]!.model).toBe('haiku');
  expect(steps[0]!.effort).toBe('low');
});

test('a model the session forces on every subagent is left to it', async ($, on) => {
  const { files, spawned } = engine(on, { CLAUDE_CODE_SUBAGENT_MODEL: 'opus' });
  await keepRoute(files);
  await $.agent.spawn(SPAWN);
  expect(spawned[0]!.model).toBe('opus');
});

test('an offer line that is stale, too long or carries control characters is not appended', async ($, on) => {
  const { files, spawned } = engine(on);
  for (const record of [
    { at: NOW - 11 * 60_000 },
    { line: 'x'.repeat(2_001) },
    { line: 'call it\u001b[2Jnow' },
    { version: 2 },
  ]) {
    await keepLine(files, record);
    await $.agent.spawn(SPAWN);
  }
  for (const e of spawned) expect(e.prompt).toBe(SPAWN.prompt);
});

const HAIKU_ROUTE = {
  runsOn: { model: 'sonnet', effort: 'high' },
  model: { setting: 'apply', decided: 'haiku', apply: true },
  effort: { setting: 'apply', apply: false },
  saving: { model: 67, both: 67 },
};

test('a spawn routed to Haiku runs on it, and its row keeps the model the host resolved', async ($, on) => {
  const { files, spawned, rows } = engine(on);
  await keepRoute(files, HAIKU_ROUTE);
  await $.agent.spawn({ ...SPAWN, model: 'sonnet' });
  expect(spawned[0]!.model).toBe('haiku');
  expect((rows.at(-1) as { model?: unknown } | undefined)?.model).toEqual({
    to: 'haiku',
    from: 'sonnet',
    done: true,
    resolved: 'claude-haiku-4-5',
  });
  for (const lines of await rowLines($)) {
    expect(lines.at(-1)).toBe(
      '  ⎿  Tenjin ran this on Haiku (asked Sonnet) · read-only search agent · about 67% less usage',
    );
  }
});

test('a Haiku spawn the host refuses runs once more, as asked, and the row claims no model', async ($, on) => {
  const { files, spawned, refused } = engine(on, {}, 'haiku');
  await keepRoute(files, HAIKU_ROUTE);
  await keepLine(files);
  await $.agent.spawn({ ...SPAWN, model: 'sonnet' });
  expect({ refused: refused.map((e) => e.model), spawned: spawned.map((e) => e.model) }).toEqual({
    refused: ['haiku'],
    spawned: ['sonnet'],
  });
  expect(spawned[0]!.model).toBe('sonnet');
  expect(spawned[0]!.prompt).toBe(`${SPAWN.prompt}\n\n${LINE}`);
  for (const lines of await rowLines($)) expect(lines).toEqual(['⏺ Agent(find the loader)']);
});

/**
 * The Agent tool's result as the host frames it, one report per run. The test
 * raises the spawn itself: a test's tool may not spawn, so the re-run's spawn
 * is raised after the call, as the host raises it inside the second run.
 */
function agentTool(on: On, reports: string[]) {
  const runs: number[] = [];
  on('tool.call', { tool: 'Agent' }, async () => {
    runs.push(runs.length + 1);
    const text = `[Subagent hand-back] The report follows:\n  ${reports.shift() ?? ''}`;
    return { result: text, text };
  });
  return runs;
}

const callAgent = ($: $) =>
  $.tool.call({ tool: 'Agent', tool_use_id: CALL, prompt: SPAWN.prompt, subagent_type: 'Explore' });

test('a Haiku run with no usable answer runs once more as asked, and is counted', async ($, on) => {
  const { files, spawned, status } = engine(on);
  await keepRoute(files, HAIKU_ROUTE);
  const runs = agentTool(on, ['', 'config.ts line 7 defines parseConfig']);
  await $.agent.spawn({ ...SPAWN, model: 'sonnet' });
  const ran = await callAgent($);
  await $.agent.spawn({ ...SPAWN, model: 'sonnet' });
  expect(runs).toEqual([1, 2]);
  expect(ran.text).toContain('parseConfig');
  expect(spawned.map((e) => e.model)).toEqual(['haiku', 'sonnet']);
  for (const lines of await rowLines($)) {
    expect(lines.at(-1)).toBe(
      '  ⎿  Tenjin ran this again as asked: its Haiku run gave no usable answer',
    );
  }
  expect(status.at(-1)).toContain('1 spawns');
  expect(status.at(-1)).toContain('1 re-spawned as asked');
});

test('a Haiku run with an answer is the result, run once', async ($, on) => {
  const { files } = engine(on);
  await keepRoute(files, HAIKU_ROUTE);
  const runs = agentTool(on, ['config.ts line 7 defines parseConfig']);
  await $.agent.spawn({ ...SPAWN, model: 'sonnet' });
  expect((await callAgent($)).text).toContain('parseConfig');
  expect(runs).toEqual([1]);
});
