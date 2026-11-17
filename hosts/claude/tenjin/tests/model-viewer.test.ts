import type { AgentInfo, On, ToolCallResult, TurnStepChunk, TurnStepResult } from 'claude-code';
import { expect, mock, test, type TestBody } from 'claude-code/testing';
import type { TenjinModelViewerState } from '../types';
import { DATA, NOW, OFFER, SESSION, SURFACES, sha256Hex, shownLines, toolRow } from './fixtures';

const ACCEPT = 'mcp__plugin_tenjin_router__subagent';
const HEADER = 'DeepSeek #1 · Read selected source\n';
const TYPE = 'tenjin:deepseek-viewer';
const WORKER = 'tenjin-worker-f30fcbad-15d3-4515-86d5-5856048032bf';
const INPUT = {
  prompt: 'Read src/example.ts. Preserve exactly this final line: DONE.',
  description: 'Read selected source',
  subagent_type: 'Explore',
};
type Engine = Parameters<TestBody>[0];
async function step($: Engine, agentId: string, index = 0, turnId = 'viewer-turn') {
  const stream = $.turn.step({ agentId, index, turnId, model: 'inherit', messageCount: 0 });
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
function setup(_$: Engine, on: On) {
  const files = new Map<string, string>();
  const clock = mock.clock(on, { now: NOW });
  mock.env(on, { HOME: '/home/test' });
  files.set(DATA + '/config.json', JSON.stringify({ router: { subagents: true } }));
  const store = new Map<string, unknown>();
  const state = {
    cwd: '/repo',
    parentSessionId: SESSION,
    agents: [] as AgentInfo[],
    listFails: false,
    statFails: false,
    stateFails: false,
    spawnFails: false,
    spawnBlocked: undefined as Promise<void> | undefined,
    calls: 0,
    registrations: [] as unknown[],
    nativeSteps: 0,
    phase: 'running',
    started: true,
    rows: undefined as unknown[] | undefined,
    sequence: undefined as number | undefined,
    result: undefined as string | undefined,
    inspections: 0,
    reads: 0,
    aliasReads: 0,
    lists: 0,
    offer: OFFER,
    nativeProfile: 'Explore',
    inspectionBlocked: undefined as Promise<void> | undefined,
    inspectionFails: false,
    followFails: false,
    follows: 0,
    followWait: undefined as Promise<void> | undefined,
    finishFollow: (() => undefined) as () => void,
    coreToolUses: 0,
    cancellations: [] as unknown[],
    captures: [] as { input: Record<string, unknown>; tool: string }[],
    nativeCalls: [] as unknown[],
    accepted: 0,
    snapshot: undefined as TenjinModelViewerState | undefined,
    liveFile: true,
    work: (() => ({ result: 'actual worker result' })) as () =>
      ToolCallResult | Promise<ToolCallResult>,
  };
  on('session.cwd', () => ({ value: state.cwd }));
  on('session.id', () => ({ value: state.parentSessionId }));
  on('fs.stat', (_$, e) => {
    if (state.statFails) throw Error('Controlled scope refusal');
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path } };
  });
  on('store.get', (_$, e) => {
    state.reads++;
    if (e.key.startsWith('deepseek-viewer-alias-v1:')) state.aliasReads++;
    return { value: store.get(e.key) };
  });
  on('store.set', (_$, e) => {
    store.set(e.key, structuredClone(e.value));
    return { value: undefined };
  });
  on('state.set', { plugin: 'tenjin', key: 'modelViewers' }, async (_$, e, next) => {
    const result = await next(e);
    if ('value' in result && result.value?.isSet)
      state.snapshot = structuredClone(e.value as TenjinModelViewerState);
    return result;
  });
  on('state.get', { plugin: 'tenjin', key: 'modelViewers' }, (_$, e, next) => {
    if (state.stateFails) return { deny: 'Controlled private-state refusal' };
    return next(e);
  });
  on('agent.register', (_$, e) => {
    state.registrations.push(e);
    return { value: { agent: TYPE } };
  });
  on('agent.list', () => {
    state.lists++;
    if (state.listFails) return { deny: 'Controlled metadata refusal' };
    return { value: state.agents };
  });
  on('agent.spawn', async (_$, e) => {
    state.calls++;
    if (state.spawnFails) return { deny: 'Controlled viewer denial' };
    // The 2.1.325 test kit models this noun through its underlying Agent tool boundary.
    // Its native production event has the documented camelCase fields instead.
    const actual = e as unknown as { subagent_type?: string };
    const id = 'native-viewer-' + state.calls;
    state.agents.push({
      id,
      description: e.description,
      type: actual.subagent_type ?? e.subagentType,
      status: 'running',
      spawnedBy: 'tenjin',
      ...(e.parentAgentId ? { parentId: e.parentAgentId } : {}),
    });
    await state.spawnBlocked;
    // No core child starts in this virtual engine; the public contract strips hook-minted ids.
    return { model: 'inherit' };
  });
  // What the CLI reports for the owned worker, through MCP or its live file alike.
  const activity = () => ({
    status: 'activity',
    activity: {
      version: 1,
      offerId: state.offer,
      workerHandle: WORKER,
      generation: 'owned-generation',
      nativeProfile: state.nativeProfile,
      sequence: state.sequence ?? (state.phase === 'running' ? 2 : 3),
      state: state.phase,
      started: state.started,
      droppedRows: 8,
      toolUses: 1,
      tokens: 41_234,
      ...(state.result !== undefined ? { result: state.result } : {}),
      rows: state.rows ?? [
        {
          id: 'tool-actual',
          sequence: 1,
          kind: 'tool',
          name: 'Read',
          state: 'completed',
          inputSummary: '/repo/src/example.ts',
          outputPreview: 'export const answer = 42;',
        },
        { id: 'not-a-row', kind: 'thinking', text: 'PRIVATE_RAW_THINKING' },
      ],
      spend: {
        actualAtomic: '4300',
        reservedAtomic: '8000',
        uncertain: [],
        extra: 'PRIVATE_SPEND',
      },
      auth: 'PRIVATE_AUTH',
    },
  });
  // The live file the CLI writes while the accept call runs (`model-worker-progress.ts`).
  on('fs.read', async (_$, e) => {
    if (
      state.liveFile &&
      e.path ===
        `${DATA}/progress/model-workers/${await sha256Hex(state.parentSessionId)}-${await sha256Hex(state.offer)}.json`
    )
      return { value: JSON.stringify(activity()) };
    const text = files.get(e.path);
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text };
  });
  on('mcp.call', async (_$, e) => {
    if (e.tool === 'subagent') {
      state.cancellations.push(e.args);
      return {
        value: {
          isError: false,
          content: [{ type: 'text' as const, text: '{"status":"cancelled"}' }],
        },
      };
    }
    if (e.args.follow === true) {
      state.follows++;
      if (state.followFails)
        return {
          value: {
            isError: true,
            content: [{ type: 'text' as const, text: '{"status":"unavailable"}' }],
          },
        };
      await state.followWait;
    } else {
      state.inspections++;
      await state.inspectionBlocked;
      if (state.inspectionFails) throw Error('Controlled inspector failure');
    }
    return {
      value: {
        isError: false,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(activity()),
          },
        ],
      },
    };
  });
  on('tool.call', { tool: ACCEPT }, async (_$, e) => {
    if (e.capture) {
      state.captures.push(
        structuredClone(e.capture) as { input: Record<string, unknown>; tool: string },
      );
      const offered = JSON.stringify({
        action: 'offer',
        started: false,
        offer_id: state.offer,
        label: 'DeepSeek V4.1 Flash 1017',
      });
      return { result: offered, text: offered };
    }
    state.accepted++;
    try {
      return await state.work();
    } finally {
      state.finishFollow();
    }
  });
  on('ui.render', { component: 'AbovePrompt', plugin: 'tenjin' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['native band'] }),
  );
  // Older test engines delegate an untagged band; newer ones give this fixture its own row.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    return e.plugin === undefined ? Text({ children: ['native band'] }) : Box({ children: [] });
  });
  on('turn.complete', (_$, e) => ({ text: e.answer }));
  on('tool.call', { tool: ['Agent', 'Task', 'SendMessage'] }, (_$, e) => {
    state.nativeCalls.push(e);
    return { result: 'native unchanged' as never };
  });
  on('classic.SubagentStart', () => ({}));
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    state.nativeSteps++;
    yield { kind: 'text', index: 0, text: 'native pass-through' };
    yield { kind: 'stop', stopReason: 'end_turn', usage: null };
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'native pass-through',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });
  return { files, clock, store, state };
}
const remember = ($: Engine, input: Record<string, unknown> = INPUT) =>
  $.tool.call({ tool: 'Agent', ...input });
const translate = ($: Engine, targetTool: string, input: Record<string, unknown>) =>
  $.tool.call({ tool: targetTool, ...input });
const complete = (
  $: Engine,
  agentId: string,
  reason: 'aborted' | 'error' | 'answer' = 'aborted',
  turnId = 'viewer-turn',
) =>
  $.turn.complete({
    agentId,
    reason,
    turnId,
    isAborted: reason === 'aborted',
    answer: '',
    durationMs: 1,
  });
async function startWithViewer($: Engine, f: ReturnType<typeof setup>) {
  let release: () => void = () => undefined;
  f.state.spawnBlocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.followWait = new Promise<void>((resolve) => {
    f.state.finishFollow = resolve;
  });
  const running = $.tool.call({
    tool: ACCEPT,
    offer_id: f.state.offer,
    tool_use_id: 'parent_accept',
  });
  await f.clock.settle();
  const nativeId = 'native-viewer-' + f.state.calls;
  await $.classic.SubagentStart({ agent_id: nativeId, agent_type: TYPE });
  const stream = $.turn.step({
    agentId: nativeId,
    index: 0,
    turnId: 'viewer-turn',
    model: 'inherit',
    messageCount: 0,
  });
  const marker = await stream.next();
  // The transcript opens with the worker's own name; its rows draw live under it.
  expect(marker.value).toMatchObject({ kind: 'text', index: 0 });
  expect((marker.value as { text: string }).text).toMatch(/^DeepSeek #\d+ · .+\n$/);
  const firstStep = (async () => {
    while (true) {
      const item = await stream.next();
      if (item.done) return item.value;
      if (item.value.kind === 'tool') f.state.coreToolUses++;
    }
  })();
  release();
  await f.clock.settle();
  return { running, firstStep };
}
function band(agentId: string | undefined = 'native-viewer-1') {
  return {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 12 },
    view: agentId ? { agentId } : {},
  };
}

test('the owned viewer binds before spawn returns while the parent work runs exactly once', async ($, on) => {
  const f = setup($, on);
  const exact = { result: { actual: 'unchanged worker result' }, text: 'exact handback' };
  let worked = 0;
  f.state.work = async () => {
    worked++;
    f.state.phase = 'completed';
    return exact;
  };
  await remember($);
  const { running, firstStep } = await startWithViewer($, f);
  const result = await running;
  expect(result).toEqual(exact);
  expect(worked).toBe(1);
  expect(f.state.calls).toBe(1);
  expect(f.state.registrations).toContainEqual(expect.objectContaining({ maxTurns: 1, tools: [] }));
  for (const registration of f.state.registrations) {
    // Explicit MCP servers append model-visible tools independently of tools: [].
    expect(registration).not.toHaveProperty('mcpServers');
  }
  expect(f.state.nativeSteps).toBe(0);
  expect((await firstStep).toolUses).toEqual([]);
  expect((await firstStep).usage).toBe(null);
  expect(f.state.follows).toBe(1);
  expect(f.state.coreToolUses).toBe(0);
  expect(JSON.stringify(await firstStep)).not.toContain('PRIVATE_');
  expect(JSON.stringify(await firstStep)).not.toContain('export const answer');
  expect(JSON.stringify(result)).not.toContain('export const answer');
  await f.clock.settle();
  const finished = await step($, 'native-viewer-1', 1);
  expect(finished.toolUses).toEqual([]);
  expect(finished.answer).toContain('observation finished');
  expect(f.state.nativeSteps).toBe(0);
});

test('spawn failure preserves the original parent call and does not cancel work', async ($, on) => {
  const f = setup($, on);
  f.state.spawnFails = true;
  let work = 0;
  const exact = { result: { correct: 'real original answer' } };
  f.state.work = async () => {
    work++;
    return exact;
  };
  await remember($);
  expect(await $.tool.call({ tool: ACCEPT, offer_id: OFFER })).toEqual(exact);
  expect(work).toBe(1);
  expect(f.state.cancellations).toEqual([]);
});

test('a disabled feature never creates a native viewer', async ($, on) => {
  const f = setup($, on);
  f.files.set(DATA + '/config.json', JSON.stringify({ router: { subagents: false } }));
  let work = 0;
  f.state.work = async () => {
    work++;
    return { result: 'native unchanged' };
  };
  await remember($);
  await $.tool.call({ tool: ACCEPT, offer_id: OFFER });
  expect(work).toBe(1);
  expect(f.state.calls).toBe(0);
  expect(f.state.inspections).toBe(0);
});

test('native type marking fails closed for a viewer metadata failure but leaves ordinary agents alone', async ($, on) => {
  const f = setup($, on);
  await $.classic.SubagentStart({ agent_id: 'marked-viewer', agent_type: TYPE });
  f.state.listFails = true;
  f.state.statFails = true;
  const refused = await step($, 'marked-viewer');
  expect(refused.toolUses).toEqual([]);
  expect(refused.answer).toContain('unavailable');
  expect(f.state.nativeSteps).toBe(0);
  const native = await step($, 'ordinary-child');
  expect(native.answer).toBe('native pass-through');
  expect(f.state.nativeSteps).toBe(1);
});

test('an engine-tagged viewer cannot fall back to inference when both private state and native metadata fail', async ($, on) => {
  const f = setup($, on);
  await $.classic.SubagentStart({ agent_id: 'engine-tagged-viewer', agent_type: TYPE });
  f.state.stateFails = true;
  f.state.listFails = true;
  const owned = await step($, 'engine-tagged-viewer');
  expect(owned.answer).toContain('unavailable');
  expect(owned.toolUses).toEqual([]);
  expect(f.state.nativeSteps).toBe(0);
  const ordinary = await step($, 'ordinary-native-child');
  expect(ordinary.answer).toBe('native pass-through');
  expect(f.state.nativeSteps).toBe(1);
});

test('many completed viewer guards never evict an older live viewer guard', async ($, on) => {
  const f = setup($, on);
  await $.classic.SubagentStart({ agent_id: 'long-running-viewer', agent_type: TYPE });
  for (let i = 0; i < 24; i++) {
    const id = 'completed-viewer-' + i;
    await $.classic.SubagentStart({ agent_id: id, agent_type: TYPE });
    await complete($, id, 'answer');
  }
  expect(f.state.snapshot?.knownIds).not.toContain('long-running-viewer');
  f.state.stateFails = true;
  f.state.listFails = true;
  const live = await step($, 'long-running-viewer');
  expect(live.answer).toContain('unavailable');
  expect(f.state.nativeSteps).toBe(0);
});

test('a full live-viewer guard skips only optional UI and reuses a slot after native completion', async ($, on) => {
  const f = setup($, on);
  for (let i = 0; i < 16; i++)
    await $.classic.SubagentStart({ agent_id: 'live-viewer-' + i, agent_type: TYPE });
  f.state.work = () => ({ result: 'actual worker runs without extra UI' });
  await remember($);
  expect((await $.tool.call({ tool: ACCEPT, offer_id: OFFER })).result).toBe(
    'actual worker runs without extra UI',
  );
  expect(f.state.accepted).toBe(1);
  expect(f.state.calls).toBe(0);
  await f.clock.settle();
  await complete($, 'live-viewer-4', 'answer');
  f.state.offer = 'f30fcbad-15d3-4515-86d5-5856048032bf';
  await remember($);
  const { running, firstStep } = await startWithViewer($, f);
  expect((await firstStep).toolUses).toEqual([]);
  await running;
  expect(f.state.calls).toBe(1);
  f.state.stateFails = true;
  f.state.listFails = true;
  expect((await step($, 'live-viewer-0')).answer).toContain('unavailable');
  expect(f.state.nativeSteps).toBe(0);
});

test('viewer type metadata never grants a mismatched child offer authority or inference', async ($, on) => {
  const f = setup($, on);
  await remember($);
  f.state.agents.push({
    id: 'foreign-viewer',
    type: TYPE,
    description: 'No matching trusted pending description',
    status: 'running',
    spawnedBy: 'another-plugin',
  });
  const answer = await step($, 'foreign-viewer');
  expect(answer.toolUses).toEqual([]);
  expect(f.state.nativeSteps).toBe(0);
  expect(f.state.cancellations).toEqual([]);
});

test('the live file renders actual activity and settled spend with no MCP read while the worker runs', async ($, on) => {
  const f = setup($, on);
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'only parent answer' };
  };
  await remember($);
  const { running } = await startWithViewer($, f);
  await f.clock.advance(1000);
  expect(JSON.stringify(f.state.snapshot)).not.toContain('PRIVATE_');
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'AbovePrompt',
      props: band(),
    });
    const shown = (await shownLines(ui)).join(' ');
    expect(shown).toContain('Read');
    expect(shown).toContain('/repo/src/example.ts');
    expect(shown).toContain('export const answer = 42;');
    // While it runs, only what has settled, never the reservation.
    expect(shown).toContain('Spent $0.0043 so far');
    expect(shown).not.toContain('$0.008');
    expect(shown).toContain('1 tool use · 41.2k tokens');
    expect(shown).toContain('24');
    expect(shown).toContain('8 earlier');
    expect(shown).not.toContain('PRIVATE_RAW_THINKING');
    expect(shown).not.toContain('PRIVATE_AUTH');
    await ui.unmount();
  }
  // Nothing waited on a second call over the connection the accept call holds.
  expect(f.state.inspections).toBe(0);
  release();
  expect((await running).result).toBe('only parent answer');
  await f.clock.settle();
  const polls = f.state.inspections;
  await f.clock.advance(2000);
  expect(f.state.inspections).toBe(polls);
});

test('only the selected owned native viewer receives the bounded activity panel', async ($, on) => {
  const f = setup($, on);
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'original worker answer' };
  };
  await remember($);
  const { running, firstStep } = await startWithViewer($, f);
  await f.clock.advance(1000);
  const polls = f.state.inspections;
  for (const surface of SURFACES) {
    const owned = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'AbovePrompt',
      props: band(),
    });
    expect((await shownLines(owned)).join(' ')).toContain('export const answer = 42;');
    await owned.unmount();
    for (const props of [
      band(''),
      band('foreign-native'),
      { ...band(), hasSurvey: true },
      { ...band(), isCollapsed: true },
      { ...band(), maxRows: 0 },
      { ...band(), bodyColumns: 0 },
    ]) {
      const other = await $.ui.mount({
        plugin: 'tenjin',
        surface,
        component: 'AbovePrompt',
        props,
      });
      expect(await shownLines(other)).toEqual(['native band']);
      await other.unmount();
    }
    const narrow = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'AbovePrompt',
      props: { ...band(), maxRows: 6, bodyColumns: 22, scroll: { offset: 0, bodyRows: 6 } },
    });
    const lines = await shownLines(narrow);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.every((line) => Array.from(line).length <= 22)).toBe(true);
    await narrow.unmount();
  }
  f.state.parentSessionId = 'foreign-parent';
  const foreign = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: band(),
  });
  expect(await shownLines(foreign)).toEqual(['native band']);
  await foreign.unmount();
  f.state.parentSessionId = SESSION;
  expect(f.state.inspections).toBe(polls);
  expect(f.state.coreToolUses).toBe(0);
  release();
  expect((await running).result).toBe('original worker answer');
  expect((await firstStep).toolUses).toEqual([]);
  await f.clock.settle();
});

test('a pending direct host follow remains observational while the clock advances', async ($, on) => {
  const f = setup($, on);
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'original worker answer' };
  };
  await remember($);
  const { running, firstStep } = await startWithViewer($, f);
  let finished = false;
  void firstStep.then(() => {
    finished = true;
  });
  await f.clock.advance(11000);
  expect(finished).toBe(false);
  expect(f.state.accepted).toBe(1);
  expect(f.state.follows).toBe(1);
  expect(f.state.coreToolUses).toBe(0);
  expect(f.state.nativeSteps).toBe(0);
  expect(f.state.cancellations).toEqual([]);
  release();
  expect((await running).result).toBe('original worker answer');
  expect((await firstStep).toolUses).toEqual([]);
  await f.clock.settle();
});

test('confirmed aliases preserve the full follow-up and original Explore profile through the existing capture', async ($, on) => {
  const f = setup($, on);
  f.state.work = async () => {
    f.state.phase = 'completed';
    return { result: 'done' };
  };
  await remember($);
  await (
    await startWithViewer($, f)
  ).running;
  await f.clock.settle();
  f.state.agents = [];
  const task = 'Continue exactly.\nFinal line: NEVER CHANGE THIS.';
  await translate($, 'Agent', { resume: 'native-viewer-1', prompt: task });
  expect(f.state.captures.at(-1)?.input).toEqual({
    resume: WORKER,
    prompt: task,
    subagent_type: 'Explore',
  });
  await translate($, 'SendMessage', {
    to: 'native-viewer-1',
    message: task,
    summary: 'follow-up',
  });
  expect(f.state.captures.at(-1)?.input).toEqual({
    to: WORKER,
    message: task,
    summary: 'follow-up',
  });
  expect(JSON.stringify([...f.store.values()])).not.toContain('export const answer');
  expect(JSON.stringify([...f.store.values()])).not.toContain('PRIVATE_');
  expect(JSON.stringify([...f.store.values()])).not.toContain(INPUT.prompt);
  f.state.cwd = '/another-repository';
  expect(
    (await translate($, 'Agent', { resume: 'native-viewer-1', prompt: task })).result,
  ).toMatchObject({ agentId: 'tenjin-unavailable', canContinueAgent: false });
  expect(f.state.nativeCalls).toEqual([]);
});

test('Claude display aliases preserve the full normalized SendMessage assignment', async ($, on) => {
  const f = setup($, on);
  f.state.work = async () => {
    f.state.phase = 'completed';
    return { result: 'done' };
  };
  await remember($);
  await (
    await startWithViewer($, f)
  ).running;
  await f.clock.settle();
  const task =
    'Continue the same read-only assignment and recall its fixture seed.\nFINAL_LINE_KEEP_qualified';
  const before = f.state.captures.length;
  await translate($, 'SendMessage', {
    to: 'native-viewer-1',
    message: task,
    type: 'message',
    recipient: 'native-viewer-1',
    recipient_kind: 'agent',
    content: task.slice(0, 49) + '…',
  });
  expect(f.state.captures.length).toBe(before + 1);
  expect(f.state.captures.at(-1)?.input).toEqual({ to: WORKER, message: task });
  expect(f.state.accepted).toBe(1);
  expect(f.state.nativeCalls).toEqual([]);
});

test('normalized durable handles avoid alias lookups and preserve short, Unicode and legacy messages', async ($, on) => {
  const f = setup($, on);
  for (const [message, content] of [
    ['Read once.\nFINAL', 'Read once.\nFINAL'],
    ['界'.repeat(40) + '\nFINAL_LINE_UNCHANGED', '界'.repeat(24) + '…'],
  ]) {
    await translate($, 'SendMessage', {
      to: WORKER,
      message,
      type: 'message',
      recipient: WORKER,
      recipient_kind: 'name',
      content,
      summary: 'preserve summary',
      notify_when_idle: false,
    });
    expect(f.state.captures.at(-1)?.input).toEqual({
      to: WORKER,
      message,
      summary: 'preserve summary',
      notify_when_idle: false,
    });
  }
  for (const input of [
    { to: WORKER, message: 'Plain modern task' },
    { recipient: WORKER, content: 'Plain legacy task' },
  ]) {
    await translate($, 'SendMessage', input);
    expect(f.state.captures.at(-1)?.input).toEqual(input);
  }
  expect(f.state.aliasReads).toBe(0);
  expect(f.state.lists).toBe(0);
  expect(f.state.accepted).toBe(0);
  expect(f.state.nativeCalls).toEqual([]);
});

test('single-target legacy SendMessage arrays retain their original shape and complete task', async ($, on) => {
  const f = setup($, on);
  f.state.work = async () => {
    f.state.phase = 'completed';
    return { result: 'done' };
  };
  await remember($);
  await (
    await startWithViewer($, f)
  ).running;
  await f.clock.settle();
  const message = 'Continue the original task.\nFINAL_LINE_LEGACY_ARRAY';
  for (const address of ['native-viewer-1', WORKER]) {
    for (const field of ['to', 'recipient']) {
      const before = f.state.captures.length;
      const input =
        field === 'to' ? { to: [address], message } : { recipient: [address], content: message };
      await translate($, 'SendMessage', input);
      expect(f.state.captures.length).toBe(before + 1);
      expect(f.state.captures.at(-1)?.input).toEqual(
        field === 'to' ? { to: [WORKER], message } : { recipient: [WORKER], content: message },
      );
    }
  }
  expect(f.state.accepted).toBe(1);
  expect(f.state.nativeCalls).toEqual([]);
});

test('owned normalized SendMessage refuses conflicting or incomplete display tuples before capture', async ($, on) => {
  const f = setup($, on);
  f.state.work = async () => {
    f.state.phase = 'completed';
    return { result: 'done' };
  };
  await remember($);
  await (
    await startWithViewer($, f)
  ).running;
  await f.clock.settle();
  const message = 'Continue the same read-only assignment.\nFINAL_LINE_DO_NOT_DROP';
  const frame: Record<string, unknown> = {
    to: 'native-viewer-1',
    message,
    type: 'message',
    recipient: 'native-viewer-1',
    recipient_kind: 'agent',
    content: message.slice(0, 49) + '…',
  };
  const invalid = [
    ...['type', 'recipient', 'recipient_kind', 'content'].map((key) => {
      const changed = { ...frame };
      delete changed[key];
      return changed;
    }),
    { ...frame, recipient: 'ordinary-native' },
    { ...frame, recipient: ['native-viewer-1'] },
    { ...frame, to: ['native-viewer-1'] },
    { ...frame, to: ['native-viewer-1', 'ordinary-native'] },
    { ...frame, type: 'broadcast' },
    { ...frame, recipient_kind: 'name' },
    { ...frame, recipient_kind: 'session' },
    { ...frame, content: 'A different task' },
    { ...frame, content: message.slice(0, 25) },
    { ...frame, content: message + '…' },
    { ...frame, content: message.slice(0, 25) + '...' },
    { ...frame, message: '👩‍💻 complete grapheme\nFINAL', content: '👩…' },
    { ...frame, approve: false },
    { ...frame, request_id: 'a-request' },
    { ...frame, unrecognized: true },
    { ...frame, message: { text: message } },
    { to: 'native-viewer-1', recipient: 'native-viewer-1', message },
    { to: ['native-viewer-1', 'ordinary-native'], message },
    { to: [WORKER, WORKER], message },
    { recipient: ['native-viewer-1', 'ordinary-native'], content: message },
    { recipient: [WORKER, WORKER], content: message },
    { ...frame, to: WORKER, recipient: WORKER, recipient_kind: 'agent' },
  ];
  const before = f.state.captures.length;
  for (const input of invalid) {
    expect((await translate($, 'SendMessage', input)).result).toMatchObject({ success: false });
    expect(f.state.captures.length).toBe(before);
  }
  expect(f.state.nativeCalls).toEqual([]);
  expect(f.state.accepted).toBe(1);
});

test('foreign normalized SendMessage stays native without rewriting its presentation fields', async ($, on) => {
  const f = setup($, on);
  const frame = {
    to: 'ordinary-native',
    message: 'Foreign task\nFINAL',
    type: 'message',
    recipient: 'ordinary-native',
    recipient_kind: 'agent',
    content: 'Foreign task\nFINAL',
  };
  await translate($, 'SendMessage', frame);
  expect(f.state.nativeCalls.at(-1)).toMatchObject(frame);
  expect(f.state.captures).toEqual([]);
  expect(f.state.accepted).toBe(0);
});

test('unbound viewer IDs refuse while ordinary native resumes remain unchanged', async ($, on) => {
  const f = setup($, on);
  f.state.agents.push({
    id: 'unbound-viewer',
    description: 'Actual viewer without retained alias',
    type: TYPE,
    spawnedBy: 'tenjin',
    status: 'running',
  });
  const original = { resume: 'ordinary-native', prompt: 'Read one file' };
  await translate($, 'Agent', original);
  expect(f.state.captures.at(-1)?.input).toEqual(original);
  const before = f.state.captures.length;
  expect(
    (await translate($, 'Agent', { resume: 'unbound-viewer', prompt: 'Continue' })).result,
  ).toMatchObject({ agentId: 'tenjin-unavailable', canContinueAgent: false });
  expect(f.state.captures.length).toBe(before);
  expect(f.state.nativeCalls).toEqual([]);
});

test('initial assignments and existing durable worker handles avoid all alias and agent lookups', async ($, on) => {
  const f = setup($, on);
  for (const input of [{ prompt: INPUT.prompt }, { resume: WORKER, prompt: INPUT.prompt }]) {
    await translate($, 'Agent', input);
    expect(f.state.captures.at(-1)?.input).toEqual(input);
  }
  expect(f.state.lists).toBe(0);
  expect(f.state.aliasReads).toBe(0);
});

test('mixed accept operations pass through without spawning an observer', async ($, on) => {
  const f = setup($, on);
  let work = 0;
  f.state.work = () => {
    work++;
    return { result: 'original operation' };
  };
  await remember($);
  for (const operation of [{ cancel: OFFER }, { task: 'capture' }, { delegation_id: OFFER }])
    expect((await $.tool.call({ tool: ACCEPT, offer_id: OFFER, ...operation })).result).toBe(
      'original operation',
    );
  expect(work).toBe(3);
  expect(f.state.calls).toBe(0);
});

test('TaskStop still requests the owned cancellation after canonical cwd access is lost', async ($, on) => {
  const f = setup($, on);
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'actual cancellation handback' };
  };
  await remember($);
  const { running } = await startWithViewer($, f);
  f.state.statFails = true;
  await complete($, 'native-viewer-1');
  expect(f.state.cancellations).toEqual([{ cancel: OFFER }]);
  expect(f.state.accepted).toBe(1);
  release();
  expect((await running).result).toBe('actual cancellation handback');
  await f.clock.settle();
});

for (const terminal of ['completed', 'cancelled'] as const) {
  test(
    'a ' + terminal + ' worker retires its cached running view after cwd stat loss',
    async ($, on) => {
      const f = setup($, on);
      let release: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const exact = { result: 'unchanged ' + terminal + ' handback' };
      f.state.work = async () => {
        await blocked;
        return exact;
      };
      await remember($);
      const { running } = await startWithViewer($, f);
      await f.clock.advance(1000);
      expect(f.state.snapshot?.records[0]?.activity?.state).toBe('running');
      f.state.statFails = true;
      if (terminal === 'cancelled') await complete($, 'native-viewer-1');
      f.state.phase = terminal;
      release();
      expect(await running).toEqual(exact);
      await f.clock.settle();
      expect(f.state.snapshot?.records[0]?.active).toBe(false);
      const ui = await $.ui.mount({
        plugin: 'tenjin',
        surface: 'terminal',
        component: 'AbovePrompt',
        props: band(),
      });
      const shown = (await shownLines(ui)).join(' ');
      expect(shown).toContain('activity unavailable');
      expect(shown).not.toContain('1017 · running');
      expect(shown).toContain('Read');
      await ui.unmount();
    },
  );
}

test('foreign sessions, unbound native IDs and stale turns cannot request worker cancellation', async ($, on) => {
  const f = setup($, on);
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'original worker answer' };
  };
  await remember($);
  const { running } = await startWithViewer($, f);
  await complete($, 'ordinary-native-child');
  await complete($, 'native-viewer-1', 'aborted', 'stale-viewer-turn');
  f.state.parentSessionId = 'foreign-parent-session';
  await complete($, 'native-viewer-1');
  expect(f.state.cancellations).toEqual([]);
  f.state.parentSessionId = SESSION;
  release();
  await running;
  await f.clock.settle();
});

test('a direct readonly observer failure never cancels or replaces the actual worker', async ($, on) => {
  const f = setup($, on);
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'original worker answer' };
  };
  f.state.followFails = true;
  await remember($);
  const { running, firstStep } = await startWithViewer($, f);
  const observer = await firstStep;
  expect(observer.answer).toContain('unavailable');
  expect(observer.toolUses).toEqual([]);
  await complete($, 'native-viewer-1', 'error');
  expect(f.state.cancellations).toEqual([]);
  expect(f.state.accepted).toBe(1);
  release();
  expect((await running).result).toBe('original worker answer');
  await f.clock.settle();
});

test('a blocked final inspector cannot delay or alter the exact original parent handback', async ($, on) => {
  const f = setup($, on);
  let release: () => void = () => undefined;
  f.state.inspectionBlocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exact = {
    result: { actual: ['original', { receipt: 'opaque' }] },
    text: 'verbatim handback',
  };
  f.state.work = () => exact;
  await remember($);
  let returned: unknown;
  const { running: pending } = await startWithViewer($, f);
  const running = pending.then((value) => {
    returned = value;
    return value;
  });
  await f.clock.settle();
  expect(returned).toEqual(exact);
  // The viewer's last read and the retirement's: both wait, and neither holds the handback.
  expect(f.state.inspections).toBe(2);
  release();
  await f.clock.settle();
  expect(await running).toEqual(exact);
  expect(f.state.cancellations).toEqual([]);
});

test('failed final inspection labels the cached activity unavailable instead of still running', async ($, on) => {
  const f = setup($, on);
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'done' };
  };
  await remember($);
  const { running } = await startWithViewer($, f);
  await f.clock.advance(1000);
  f.state.inspectionFails = true;
  release();
  await running;
  await f.clock.settle();
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: band(),
  });
  const shown = (await shownLines(ui)).join(' ');
  expect(shown).toContain('activity unavailable');
  expect(shown).not.toContain('1017 · running');
  expect(shown).toContain('Read');
  await ui.unmount();
});

test('a real CAS conflict preserves both the first-step binding and the concurrent native marker', async ($, on) => {
  const f = setup($, on);
  let conflicted = false;
  on('state.set', { plugin: 'tenjin', key: 'modelViewers' }, async (_$, e, next) => {
    if (!conflicted && e.previous && e.value.records.some((r) => r.nativeId)) {
      conflicted = true;
      const competing = structuredClone(e.previous);
      competing.knownIds.push('concurrent-native-marker');
      await next({ ...e, value: competing });
    }
    return next(e);
  });
  f.state.work = () => ({ result: 'real work once' });
  await remember($);
  const { running, firstStep } = await startWithViewer($, f);
  const result = await running;
  expect(result.result).toBe('real work once');
  expect(conflicted).toBe(true);
  expect((await firstStep).toolUses).toEqual([]);
  const saved = f.state.snapshot;
  expect(saved?.knownIds).toContain('concurrent-native-marker');
  expect(saved?.records[0]?.nativeId).toBe('native-viewer-1');
  expect(f.state.nativeSteps).toBe(0);
});

test('authoritative Explore profile survives a SendMessage-shaped offer and later Agent resume', async ($, on) => {
  const f = setup($, on);
  f.state.work = () => {
    f.state.phase = 'completed';
    return { result: 'done' };
  };
  await translate($, 'SendMessage', { to: WORKER, message: 'Continue the original worker' });
  await (
    await startWithViewer($, f)
  ).running;
  await f.clock.settle();
  const input = { resume: 'native-viewer-1', prompt: 'Continue in the original profile' };
  await translate($, 'Agent', input);
  expect(f.state.captures.at(-1)?.input).toEqual({
    ...input,
    resume: WORKER,
    subagent_type: 'Explore',
  });
});

test('the first durable viewer alias survives more than sixteen completed viewers and a cold UI owner', async ($, on) => {
  const f = setup($, on);
  f.state.work = () => {
    f.state.phase = 'completed';
    return { result: 'done' };
  };
  for (let i = 0; i < 18; i++) {
    f.state.offer = i.toString(16).padStart(8, '0') + '-5aed-4a50-8c25-240e871602f3';
    await remember($);
    await (
      await startWithViewer($, f)
    ).running;
    await f.clock.settle();
    await complete($, 'native-viewer-' + f.state.calls, 'answer');
  }
  f.state.cwd = '/another-repository';
  await remember($);
  f.state.cwd = '/repo';
  f.state.agents = [];
  await translate($, 'Agent', { resume: 'native-viewer-1', prompt: 'Continue after days' });
  expect(f.state.captures.at(-1)?.input).toEqual({
    resume: WORKER,
    prompt: 'Continue after days',
    subagent_type: 'Explore',
  });
  expect(f.state.snapshot?.records.length).toBeLessThanOrEqual(16);
});

test('the worker starts before its viewer does, and the viewer still binds to its running record', async ($, on) => {
  const f = setup($, on);
  let release: () => void = () => undefined;
  f.state.spawnBlocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = () => ({ result: 'fast worker answer' });
  await remember($);
  // The viewer's spawn has not returned, and the worker has already answered.
  const result = await $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
  expect(result.result).toBe('fast worker answer');
  expect(f.state.calls).toBe(1);
  expect(f.state.snapshot?.records[0]?.active).toBe(true);
  await $.classic.SubagentStart({ agent_id: 'native-viewer-1', agent_type: TYPE });
  expect((await step($, 'native-viewer-1')).answer).toContain(HEADER);
  release();
  await f.clock.settle();
  expect(f.state.snapshot?.records[0]).toMatchObject({
    active: false,
    nativeId: 'native-viewer-1',
  });
  expect(f.state.nativeSteps).toBe(0);
});

test('an accept call is one live DeepSeek row that ends in a native Done line, and the spinner names its step', async ($, on) => {
  const f = setup($, on);
  const spinners: { message: string | null }[] = [];
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    spinners.push(e.props);
    return $.ui.resolve(e).Text({ children: ['engine spinner'] });
  });
  on('ui.render', { component: 'ToolResult' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['engine result'] }),
  );
  const spinner = {
    word: 'Sauteing',
    message: 'running PermissionRequest hook',
    suffix: '…',
    mode: 'tool-use' as const,
  };
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handback = JSON.stringify({
    status: 'completed',
    label: 'DeepSeek V4.1 Flash 1017',
    elapsedMs: 133_000,
    toolUses: 12,
    tokens: 41_234,
    spend: { reservedAtomic: '50000', actualAtomic: '39000', uncertain: [] },
    result: 'worker report',
  });
  f.state.work = async () => {
    await blocked;
    return { result: handback, text: handback };
  };
  await remember($);
  // Claude Code is still starting: no activity file yet.
  f.state.liveFile = false;
  const running = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
  await f.clock.settle();
  const accept = toolRow('parent_accept', ACCEPT, { offer_id: OFFER });
  for (const surface of SURFACES) {
    // The row and the spinner say so from the moment of accept, before any tick.
    const row = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: accept,
    });
    expect((await shownLines(row)).join('')).toBe(
      '⏺DeepSeek(Read selected source) · starting · 0s',
    );
    await row.unmount();
    await (
      await $.ui.mount({ plugin: 'tenjin', surface, component: 'Spinner', props: spinner })
    ).unmount();
    expect(spinners.at(-1)?.message).toBe('DeepSeek · starting');
  }
  await f.clock.advance(12_000);
  const waiting = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: accept,
  });
  expect((await shownLines(waiting)).join('')).toBe(
    '⏺DeepSeek(Read selected source) · starting · 12s',
  );
  await waiting.unmount();
  f.state.liveFile = true;
  await f.clock.advance(1000);
  for (const surface of SURFACES) {
    const row = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: accept,
    });
    expect((await shownLines(row)).join('')).toBe(
      '⏺DeepSeek(Read selected source) · 1 tool use · 41.2k tokens · 13s · $0.0043 so far  ⎿  Read(src/example.ts)',
    );
    await row.unmount();
    const turn = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'Spinner',
      props: spinner,
    });
    expect(spinners.at(-1)?.message).toBe('DeepSeek · Read(src/example.ts)');
    await turn.unmount();
  }
  expect(f.state.inspections).toBe(0);
  release();
  expect((await running).text).toBe(handback);
  await f.clock.settle();
  const done = { ...accept, isRunning: false, output: handback };
  for (const surface of SURFACES) {
    const row = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props: done });
    const lines = await shownLines(row);
    expect(lines.join('')).toBe(
      '⏺DeepSeek(Read selected source)  ⎿  Done (12 tool uses · 41.2k tokens · 2m 13s · $0.039)',
    );
    const [dot] = await row.findAll({ type: 'Text', text: '⏺' });
    expect(dot?.props.color).toBe('success');
    await row.unmount();
    const result = {
      tool_use_id: 'parent_accept',
      tool: ACCEPT,
      output: handback,
      isErrored: false,
    };
    const compact = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolResult',
      props: result,
    });
    expect(await shownLines(compact)).toEqual([]);
    await compact.unmount();
    const full = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolResult',
      props: { ...result, isExpanded: true },
    });
    expect(await shownLines(full)).toEqual(['engine result']);
    await full.unmount();
    // The worker has answered: the spinner is the engine's own again.
    await (
      await $.ui.mount({ plugin: 'tenjin', surface, component: 'Spinner', props: spinner })
    ).unmount();
    expect(spinners.at(-1)?.message).toBe('running PermissionRequest hook');
  }
});

test('a worker that stops, is interrupted or never starts says so, never Done', async ($, on) => {
  setup($, on);
  const accept = toolRow('parent_accept', ACCEPT, { offer_id: OFFER });
  const stopped = JSON.stringify({
    status: 'unknown',
    elapsedMs: 3_400,
    toolUses: 1,
    tokens: 15,
    spend: { reservedAtomic: '9000', actualAtomic: '3000', uncertain: ['owned-invocation'] },
    partial: { rows: [], omittedRows: 0 },
  });
  const refused = JSON.stringify({ action: 'native', reason: 'Offer expired' });
  const notStarted = JSON.stringify({
    status: 'not_started',
    stopReason: { kind: 'not_started', reason: 'startup_timeout' },
    elapsedMs: 61_000,
    spend: { reservedAtomic: '0', actualAtomic: '0', uncertain: [] },
    nextStep: 'No worker started',
  });
  for (const [props, shown, color] of [
    [
      { ...accept, isRunning: false, output: notStarted },
      '⏺DeepSeek(subagent)  ⎿  Not started (1m 1s)',
      'error',
    ],
    [
      { ...accept, isRunning: false, output: stopped },
      '⏺DeepSeek(subagent)  ⎿  Stopped (1 tool use · 15 tokens · 3s · $0.003 · settlement unresolved)',
      'error',
    ],
    [
      { ...accept, isRunning: false, isInterrupted: true },
      '⏺DeepSeek(subagent)  ⎿  Interrupted',
      'error',
    ],
    [
      { ...accept, isRunning: false, output: refused },
      '⏺DeepSeek(subagent)  ⎿  Not started',
      undefined,
    ],
  ] as const) {
    const row = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolUse',
      props,
    });
    expect((await shownLines(row)).join('')).toBe(shown);
    const [dot] = await row.findAll({ type: 'Text', text: '⏺' });
    expect(dot?.props.color).toBe(color);
    await row.unmount();
  }
});

test('a folded run that holds an accept unfolds, so the DeepSeek row draws in place of the count line', async ($, on) => {
  setup($, on);
  const groups: { isExpanded: boolean }[] = [];
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    groups.push(e.props);
    return $.ui.resolve(e).Text({ children: ['Calling plugin:tenjin:router…'] });
  });
  const accept = toolRow('parent_accept', ACCEPT, { offer_id: OFFER });
  const read = toolRow('read_1', 'Read', { file_path: '/repo/a.ts' });
  for (const [calls, unfolds] of [
    [[accept], true],
    [[read, accept], true],
    [[read], false],
    // A cancel is not an accept: its row stays the engine's.
    [[toolRow('parent_cancel', ACCEPT, { cancel: OFFER })], false],
  ] as const) {
    const group = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolGroup',
      props: { calls, isActive: true, isExpanded: false },
    });
    expect(groups.at(-1)?.isExpanded).toBe(unfolds);
    await group.unmount();
  }
});

for (const [phase, started, rows, ending] of [
  [
    'unknown',
    false,
    [],
    'Not started: Claude Code did not start, so no work ran. The parent keeps this task native.',
  ],
  ['cancelled', false, [], 'Not started: the start was interrupted, so no work ran.'],
  [
    'cancelled',
    true,
    undefined,
    '```\n⏺ Read(src/example.ts)\n```\n\nInterrupted (1 tool use · 41.2k tokens · 0s · $0.0043)\nInterrupted: the worker was stopped before it finished. What it had done is returned to the parent.',
  ],
] as const)
  test(
    'the viewer transcript ends by saying what happened to a worker that is ' +
      phase +
      (started ? '' : ' before it started'),
    async ($, on) => {
      const f = setup($, on);
      let release: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.state.work = async () => {
        await blocked;
        return { result: 'handback' };
      };
      await remember($);
      const { running, firstStep } = await startWithViewer($, f);
      f.state.phase = phase;
      f.state.started = started;
      if (rows) f.state.rows = [...rows];
      release();
      await running;
      // Nothing ran: no row, no counts, and never a line that reads as a finished run.
      expect((await firstStep).answer).toBe(HEADER + (rows ? '\n' : '') + ending);
      await f.clock.settle();
    },
  );

test("the viewer's transcript grows with the worker's rows and keeps the whole run, its denial and its answer", async ($, on) => {
  const f = setup($, on);
  on('ui.render', { component: 'AssistantMessage' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['stored: ' + e.props.text] }),
  );
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'handback' };
  };
  const read = {
    id: 'read',
    sequence: 1,
    kind: 'tool',
    name: 'Read',
    state: 'completed',
    inputSummary: '{"file_path":"/repo/src/router/model-mcp.ts"}',
    outputPreview: 'PRIVATE_FILE_BODY',
  };
  const said = {
    id: 'said',
    sequence: 2,
    kind: 'text',
    state: 'completed',
    text: 'The cancel path reads one turn. Checking lint.',
  };
  const push = {
    id: 'push',
    sequence: 3,
    kind: 'tool',
    name: 'Bash',
    state: 'error',
    inputSummary: '{"command":"[text: 20 chars]"}',
    command: 'git push origin main',
    outputPreview:
      'Permission to use Bash was denied by the classifier: pushes to main need a person.',
  };
  const lint = {
    id: 'lint',
    sequence: 4,
    kind: 'tool',
    name: 'Bash',
    state: 'completed',
    inputSummary: '{"command":"[text: 9 chars]"}',
    command: 'pnpm lint',
  };
  f.state.rows = [read];
  await remember($);
  const { running, firstStep } = await startWithViewer($, f);
  const transcript = async () => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: HEADER, isFirstOfReply: true },
    });
    const lines = await shownLines(ui);
    await ui.unmount();
    return lines;
  };
  await f.clock.advance(1000);
  expect(await transcript()).toEqual([
    'DeepSeek #1 · Read selected source',
    '⏺ Read(src/router/model-mcp.ts)',
    'Working…',
  ]);
  // The CLI's window moved on: the first row left it and stays in the transcript.
  f.state.rows = [said, { ...push, state: 'running', outputPreview: undefined }];
  f.state.sequence = 5;
  await f.clock.advance(1000);
  expect(await transcript()).toEqual([
    'DeepSeek #1 · Read selected source',
    '⏺ Read(src/router/model-mcp.ts)',
    'The cancel path reads one turn. Checking lint.',
    '⏺ Bash(git push origin main)',
    'Working…',
  ]);
  f.state.rows = [push, lint];
  f.state.sequence = 9;
  f.state.phase = 'completed';
  f.state.result = 'Cancel looks up the current turn only.\nLint passes.';
  release();
  await running;
  const stored = (await firstStep).answer;
  expect(stored).toBe(
    [
      'DeepSeek #1 · Read selected source',
      '```',
      '⏺ Read(src/router/model-mcp.ts)',
      '```',
      '',
      'The cancel path reads one turn. Checking lint.',
      '',
      '```',
      '⏺ Bash(git push origin main)',
      '  ⎿  Permission to use Bash was denied by the classifier: pushes to main need a person.',
      '⏺ Bash(pnpm lint)',
      '```',
      '',
      'Cancel looks up the current turn only.',
      'Lint passes.',
      '',
      'Done (1 tool use · 41.2k tokens · 2s · $0.0043)',
    ].join('\n'),
  );
  // A successful call's output is never copied into the transcript.
  expect(stored).not.toContain('PRIVATE_');
  await f.clock.settle();
  // Written: the rows held while it ran are released, and the engine draws the stored reply.
  expect(await transcript()).toEqual(['stored: ' + HEADER]);
});

test("the viewer's first message draws the worker's real assignment, and a short line once it is no longer held", async ($, on) => {
  setup($, on);
  const shown: string[] = [];
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    shown.push(e.props.text);
    return $.ui.resolve(e).Text({ children: [e.props.text] });
  });
  await remember($);
  const message = async (text: string) => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'UserMessage',
      props: { text, origin: { kind: 'plugin', name: 'tenjin' }, isExpanded: true },
    });
    await ui.unmount();
    return shown.at(-1);
  };
  const told = 'Observe only the already owned DeepSeek worker activity. ';
  expect(await message(told + 'DeepSeek #1 · Read selected source')).toBe(INPUT.prompt);
  // No record for it in this session, as after a restart: never the internal line.
  expect(await message(told + 'DeepSeek #9 · Earlier job')).toBe(
    'DeepSeek worker for: Earlier job',
  );
  // Any other message is the engine's own.
  expect(await message('Read src/example.ts.')).toBe('Read src/example.ts.');
});
