import type { AgentInfo, On, ToolCallResult, TurnStepChunk, TurnStepResult } from 'claude-code';
import { expect, mock, test, type TestBody } from 'claude-code/testing';
import { raisedByThisPlugin } from '../hooks/model-viewer';
import type { TenjinModelViewerState } from '../types';
import { DATA, NOW, OFFER, SESSION, SURFACES, sha256Hex, shownLines, toolRow } from './fixtures';

const ACCEPT = 'mcp__plugin_tenjin_router__subagent';
const TYPE = 'tenjin:deepseek-viewer';
const SECOND_OFFER = 'b446d2eb-1bf8-4cf0-aa19-bc5df4aa668f';
const THIRD_OFFER = 'c2a1d7e0-52c3-4f0e-9d38-6f6a1b0c7d21';
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
function setup(_$: Engine, on: On, env: Record<string, string> = {}) {
  const files = new Map<string, string>();
  const clock = mock.clock(on, { now: NOW });
  mock.env(on, { HOME: '/home/test', ...env });
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
    viewerSpawned: undefined as ((agentId: string) => void) | undefined,
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
    /** Set: a follow read waits until the test opens it, and answers `waiting` while the worker runs. */
    followGate: undefined as (() => void)[] | undefined,
    follows: 0,
    followArgs: [] as Record<string, unknown>[],
    followWait: undefined as Promise<void> | undefined,
    finishFollow: (() => undefined) as () => void,
    viewerFollowing: undefined as ((offerId: string) => void) | undefined,
    coreToolUses: 0,
    cancellations: [] as unknown[],
    captures: [] as { input: Record<string, unknown>; tool: string }[],
    nativeCalls: [] as unknown[],
    keepNative: false,
    accepted: 0,
    snapshot: undefined as TenjinModelViewerState | undefined,
    liveFile: true,
    toolUses: 1,
    tokens: 41_234,
    actualAtomic: '4300',
    /** By offer id: what another worker's activity has of its own. */
    per: {} as Record<
      string,
      { phase?: string; toolUses?: number; tokens?: number; actualAtomic?: string }
    >,
    /** How the job ended, as the CLI reads it from the job's own record. */
    ended: undefined as Record<string, unknown> | undefined,
    /** False: the CLI process holds no live view (it restarted, or the session was resumed). */
    liveView: true,
    /** The job's stored handback, as an accept of an ended offer returns it. */
    handback: undefined as string | undefined,
    handbackReads: 0,
    /** Every plugin read refused, as the plugin's own hook did on alpha.52 (fault J). */
    readsRefused: false,
    work: (() => ({ result: 'actual worker result' })) as (e: {
      offer_id?: unknown;
      offer_ids?: unknown;
    }) => ToolCallResult | Promise<ToolCallResult>,
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
    state.viewerSpawned?.(id);
    await state.spawnBlocked;
    // No core child starts in this virtual engine; the public contract strips hook-minted ids.
    return { model: 'inherit' };
  });
  // What the CLI reports for the owned worker, through MCP or its live file alike.
  const activity = (offer: string = state.offer) => ({
    status: 'activity',
    activity: {
      version: 1,
      offerId: offer,
      workerHandle: WORKER,
      generation: 'owned-generation',
      nativeProfile: state.nativeProfile,
      sequence: state.sequence ?? ((state.per[offer]?.phase ?? state.phase) === 'running' ? 2 : 3),
      state: state.per[offer]?.phase ?? state.phase,
      started: state.started,
      droppedRows: 8,
      toolUses: state.per[offer]?.toolUses ?? state.toolUses,
      tokens: state.per[offer]?.tokens ?? state.tokens,
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
        actualAtomic: state.per[offer]?.actualAtomic ?? state.actualAtomic,
        reservedAtomic: '8000',
        uncertain: [],
        extra: 'PRIVATE_SPEND',
      },
      auth: 'PRIVATE_AUTH',
    },
  });
  // The live file the CLI writes while the accept call runs (`model-worker-progress.ts`).
  on('fs.read', async (_$, e) => {
    for (const offer of new Set([state.offer, ...Object.keys(state.per)]))
      if (
        state.liveFile &&
        e.path ===
          `${DATA}/progress/model-workers/${await sha256Hex(state.parentSessionId)}-${await sha256Hex(offer)}.json`
      )
        return { value: JSON.stringify(activity(offer)) };
    const text = files.get(e.path);
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text };
  });
  on('mcp.call', async (_$, e) => {
    const offer = typeof e.args.offer_id === 'string' ? e.args.offer_id : state.offer;
    if (e.args.follow === true) {
      state.followArgs.push(e.args);
      state.viewerFollowing?.(offer);
    }
    if (e.args.follow === true && state.followGate && state.phase === 'running') {
      state.follows++;
      await new Promise<void>((resolve) => state.followGate!.push(resolve));
      if (state.phase === 'running')
        return {
          value: {
            isError: false,
            content: [{ type: 'text' as const, text: '{"status":"waiting"}' }],
          },
        };
    }
    // The plugin's read of an ended offer: the stored handback, or a refusal while it runs.
    if (e.tool === 'subagent' && typeof e.args.offer_id === 'string') {
      state.handbackReads++;
      const kept =
        state.handback ??
        JSON.stringify({ action: 'native', reason: 'its worker is still running' });
      return { value: { isError: false, content: [{ type: 'text' as const, text: kept }] } };
    }
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
      // As the CLI's: at once when the activity moved past `after`, else once it ends.
      const now = activity(offer);
      const after = e.args.after;
      if (typeof after === 'number' && now.activity.sequence > after)
        return {
          value: {
            isError: false,
            content: [{ type: 'text' as const, text: JSON.stringify(now) }],
          },
        };
      await state.followWait;
      const ended = activity(offer);
      if (ended.activity.state === 'running') ended.activity.state = 'completed';
      return {
        value: {
          isError: false,
          content: [{ type: 'text' as const, text: JSON.stringify(ended) }],
        },
      };
    } else {
      state.inspections++;
      await state.inspectionBlocked;
      if (state.inspectionFails) throw Error('Controlled inspector failure');
    }
    const said = (value: unknown, isError = false) => ({
      value: { isError, content: [{ type: 'text' as const, text: JSON.stringify(value) }] },
    });
    if (state.readsRefused) return said('This read is the Tenjin plugin’s own', true);
    // A job that ended carries its own status and time, from the job's record.
    if (!state.liveView)
      return said(
        state.ended ? { status: 'ended', ended: state.ended } : { status: 'unavailable' },
      );
    return said({ ...activity(offer), ...(state.ended ? { ended: state.ended } : {}) });
  });
  on('tool.call', { tool: ACCEPT }, async (_$, e) => {
    if (e.capture) {
      state.captures.push(
        structuredClone(e.capture) as { input: Record<string, unknown>; tool: string },
      );
      // The CLI's answer to a held call sent again unchanged: it runs native, and the
      // CLI names the one open offer that repeat settled.
      if (state.keepNative) {
        const native = JSON.stringify({ action: 'native', settled: state.offer });
        return { result: native, text: native };
      }
      const offered = JSON.stringify({
        action: 'offer',
        started: false,
        offer_id: state.offer,
        label: 'DeepSeek V4.1 Flash 1017',
      });
      return { result: offered, text: offered };
    }
    if (typeof e.cancel === 'string' && e.offer_id === undefined) {
      const cancelled = JSON.stringify({ status: 'cancelled' });
      return { result: cancelled, text: cancelled };
    }
    state.accepted++;
    try {
      return await state.work(e);
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
  on('classic.SubagentStop', () => ({}));
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
  const firstStep = (async () => {
    while (true) {
      const item = await stream.next();
      if (item.done) return item.value;
      if (item.value.kind === 'tool') f.state.coreToolUses++;
    }
  })();
  // The step binds its viewer first, then waits for the worker's activity.
  await f.clock.settle();
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
  // Only the tools its steps' calls are answered as, and a model no step reaches.
  expect(f.state.registrations).toContainEqual(
    expect.objectContaining({
      tools: ['Read', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'],
      model: 'haiku',
    }),
  );
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
  // After its last step the viewer draws nothing more.
  expect(finished.answer).toBe('');
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
    // One status line: what the worker does is its transcript's to show, never this band's,
    // and no tool input is printed as raw JSON anywhere.
    expect(await shownLines(ui)).toEqual([
      'DeepSeek V4.1 Flash 1017 · running · 1 tool use · 41.2k tokens · $0.0043 so far',
    ]);
    const shown = (await shownLines(ui)).join(' ');
    // While it runs, only what has settled, never the reservation.
    expect(shown).not.toContain('$0.008');
    expect(shown).toContain('1 tool use · 41.2k tokens');
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
    expect((await shownLines(owned)).join(' ')).toContain('DeepSeek V4.1 Flash 1017 · running');
    expect((await shownLines(owned)).join(' ')).not.toContain('export const answer');
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
  // One read took the rows there were; the next waits for the activity to move.
  expect(f.state.follows).toBe(2);
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
  f.state.agents[0]!.status = 'killed';
  await complete($, 'native-viewer-1');
  expect(f.state.cancellations).toEqual([{ cancel: OFFER, reason: 'agent_stopped' }]);
  expect(f.state.accepted).toBe(1);
  release();
  expect((await running).result).toBe('actual cancellation handback');
  await f.clock.settle();
});

test('a new offer in another cwd preserves the earlier viewer cancellation binding', async ($, on) => {
  const f = setup($, on);
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'first worker handback' };
  };
  f.state.followWait = blocked;
  const spawned = new Promise<string>((resolve) => {
    f.state.viewerSpawned = resolve;
  });
  const observing = new Promise<void>((resolve) => {
    f.state.viewerFollowing = (offerId) => {
      if (offerId === OFFER) resolve();
    };
  });
  await remember($);
  const running = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
  let firstStep: ReturnType<typeof step> | undefined;
  try {
    const nativeId = await spawned;
    await $.classic.SubagentStart({ agent_id: nativeId, agent_type: TYPE });
    expect(f.state.snapshot?.records[0]).toMatchObject({ offerId: OFFER, active: true, nativeId });
    firstStep = step($, nativeId);
    // The follow starts after the viewer's turn id has been written to state.
    await Promise.race([
      observing,
      firstStep.then(() => {
        throw new Error('The viewer ended before following its worker');
      }),
    ]);
    f.state.cwd = '/another-repository';
    f.state.offer = OFFER2;
    await remember($, INPUT2);
    expect(f.state.snapshot?.records.map((r) => r.offerId)).toEqual([OFFER2]);
    f.state.agents[0]!.status = 'killed';
    await complete($, nativeId, 'aborted', 'foreign-turn');
    expect(f.state.cancellations).toEqual([]);
    await complete($, nativeId);
    expect(f.state.cancellations).toEqual([{ cancel: OFFER, reason: 'agent_stopped' }]);
    expect(f.state.snapshot?.priorStops).toEqual([]);
  } finally {
    release();
    await Promise.allSettled([running, firstStep]);
    await f.clock.settle();
  }
  expect((await running).result).toBe('first worker handback');
});

// Job 8f2d28ff: Claude Code's stall watchdog ended the viewer's one long step at 600 s,
// its turn completed `aborted`, and the mod cancelled a healthy worker.
test('a viewer turn the host ends never cancels its worker, and the row stays live', async ($, on) => {
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
  const { running } = await startWithViewer($, f);
  f.state.agents[0]!.status = 'failed';
  await complete($, 'native-viewer-1');
  await f.clock.advance(5000);
  expect(f.state.cancellations).toEqual([]);
  expect((await acceptRow($, 'parent_accept', OFFER))[0]).toMatch(
    /^⏺DeepSeek\(Read selected source\) · 1 tool use · 41\.2k tokens · \d+s · \$0\.0043 so far/,
  );
  release();
  await running;
  await f.clock.settle();
});

test('a viewer stopped from the agent list cancels its worker with the reason, also when the stop lands late', async ($, on) => {
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
  const { running } = await startWithViewer($, f);
  // The turn ends before the list marks the agent stopped.
  await complete($, 'native-viewer-1');
  expect(f.state.cancellations).toEqual([]);
  f.state.agents[0]!.status = 'killed';
  await f.clock.advance(1500);
  expect(f.state.cancellations).toEqual([{ cancel: OFFER, reason: 'agent_stopped' }]);
  // The reason is the plugin's word alone: the model's own is refused before the CLI.
  const own = await $.tool.call({ tool: ACCEPT, cancel: OFFER, reason: 'agent_stopped' });
  expect(own.deny).toContain('cancel alone');
  release();
  await running;
  await f.clock.settle();
});

// Eight minutes of the row's one-second ticks: longer than the kit's default time for a test.
test(
  "a viewer step ends before the host's ten-minute bound, and the next step of its turn follows on",
  { timeoutMs: 60_000 },
  async ($, on) => {
    const f = setup($, on);
    const gate: (() => void)[] = [];
    f.state.followGate = gate;
    // Each follow read waits 25 s, as the CLI's does.
    const read = async () => {
      await f.clock.advance(25_000);
      for (const open of gate.splice(0)) open();
      await f.clock.settle();
    };
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.work = async () => {
      await blocked;
      return { result: 'handback', text: 'handback' };
    };
    await remember($);
    const running = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
    await f.clock.settle();
    await $.classic.SubagentStart({ agent_id: 'native-viewer-1', agent_type: TYPE });
    const startedAt = f.clock.now();
    let endedAt: number | undefined;
    const first = step($, 'native-viewer-1', 0).then((value) => {
      endedAt = f.clock.now();
      return value;
    });
    while (endedAt === undefined && f.clock.now() - startedAt < 11 * 60_000) await read();
    // Five minutes, and the one read then in flight.
    expect(endedAt! - startedAt).toBeLessThanOrEqual(5 * 60_000 + 25_000);
    expect((await first).answer).toBe('');
    // Each read waits for the activity to move past what the viewer has: `after`.
    expect(f.state.followArgs.at(-1)).toMatchObject({ follow: true, after: 0 });
    const stop = {
      agent_id: 'native-viewer-1',
      agent_type: TYPE,
      stop_hook_active: false,
      agent_transcript_path: '/t.jsonl',
    };
    // The worker still runs: the viewer's stop is held, so its agent stays listed.
    expect((await $.classic.SubagentStop(stop)).block).toContain('still running');
    const second = step($, 'native-viewer-1', 1);
    await read();
    f.state.phase = 'completed';
    release();
    await read();
    expect((await second).answer).toContain('Done (');
    await running;
    await f.clock.settle();
    expect((await $.classic.SubagentStop(stop)).block).toBeUndefined();
    expect(f.state.cancellations).toEqual([]);
  },
);

// The host's own bound finds a step past its planned end: whatever the agent then reads,
// that abort is not a person's stop.
test(
  'a viewer stopped while a read runs past its step’s planned end still cancels its worker',
  { timeoutMs: 60_000 },
  async ($, on) => {
    const f = setup($, on);
    const gate: (() => void)[] = [];
    f.state.followGate = gate;
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.work = async () => {
      await blocked;
      return { result: 'handback', text: 'handback' };
    };
    await remember($);
    const running = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
    await f.clock.settle();
    await $.classic.SubagentStart({ agent_id: 'native-viewer-1', agent_type: TYPE });
    const first = step($, 'native-viewer-1', 0);
    await f.clock.settle();
    // One read held open past the planned end: a stop there once went unheard, and the
    // worker ran on after the person had stopped it.
    await f.clock.advance(5 * 60_000);
    f.state.agents[0]!.status = 'killed';
    await complete($, 'native-viewer-1');
    await f.clock.advance(1500);
    expect(f.state.cancellations).toEqual([{ cancel: OFFER, reason: 'agent_stopped' }]);
    for (const open of gate.splice(0)) open();
    await first;
    f.state.phase = 'completed';
    release();
    await running;
    await f.clock.settle();
  },
);

// The CLI's `endedBy` codes, each in a native-sounding word.
// A stop with a known cause reads `stopped`, the CLI's word since a failed model call
// read `unknown` (live case); an older CLI's `unknown` still draws.
for (const [endedBy, word, status] of [
  ['agent_stopped', 'Stopped by you', 'cancelled'],
  ['parent_cancel', 'Cancelled by the parent', 'cancelled'],
  ['host_aborted', 'Interrupted', 'cancelled'],
  ['session_ended', 'Session ended', 'cancelled'],
  ['time_limit', 'Time limit reached', 'unknown'],
  ['budget', 'Budget reached', 'stopped'],
  ['model_call_failed', 'Model call failed', 'stopped'],
  ['model_call_timeout', 'Model call timed out', 'stopped'],
  ['payment_refused', 'Payment refused', 'stopped'],
  ['provider', 'DeepSeek unavailable', 'stopped'],
  ['worker_error', 'Stopped', 'unknown'],
] as const)
  test('a worker ended by ' + endedBy + ' says so on its row', async ($, on) => {
    const f = setup($, on);
    const answer = JSON.stringify({
      status,
      elapsedMs: 61_000,
      toolUses: 3,
      tokens: 900,
      endedBy,
    });
    const line = '⏺DeepSeek(subagent)  ⎿  ' + word + ' (3 tool uses · 900 tokens · 1m 1s)';
    expect((await acceptRow($, 'parent_accept', OFFER, answer))[0]).toBe(line);
    // From the job's own record, for a row nothing here followed.
    f.state.liveView = false;
    f.state.liveFile = false;
    f.state.ended = JSON.parse(answer);
    await acceptRow($, 'accept_after_resume', OFFER, MOVED);
    await f.clock.settle();
    expect((await acceptRow($, 'accept_after_resume', OFFER, MOVED))[0]).toBe(line);
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
  expect((await step($, 'native-viewer-1')).answer).toContain('Done (');
  release();
  await f.clock.settle();
  expect(f.state.snapshot?.records[0]).toMatchObject({
    active: false,
    nativeId: 'native-viewer-1',
  });
  expect(f.state.nativeSteps).toBe(0);
});

test("an accept call is one live DeepSeek row that ends in a native Done line, and the parent's spinner stays the host's own", async ($, on) => {
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
    // The row says so from the moment of accept, before any tick.
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
    // The parent's spinner is the host's, as while a native subagent runs: its own words.
    expect(spinners.at(-1)).toEqual(spinner);
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
    expect(spinners.at(-1)).toEqual(spinner);
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

test('an accept sent again while its worker runs leaves the live row and its clock alone, and its own row says it started nothing', async ($, on) => {
  const f = setup($, on);
  const spinners: { message: string | null }[] = [];
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    spinners.push(e.props);
    return $.ui.resolve(e).Text({ children: ['engine spinner'] });
  });
  const spinning = async () => {
    const props = {
      word: 'Sauteing',
      message: 'engine step',
      suffix: '…',
      mode: 'tool-use' as const,
    };
    await (
      await $.ui.mount({ plugin: 'tenjin', surface: 'terminal', component: 'Spinner', props })
    ).unmount();
    return spinners.at(-1)?.message;
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
  const refused = JSON.stringify({ action: 'native', reason: 'its worker is still running' });
  let accepts = 0;
  f.state.work = async () => {
    if (++accepts > 1) return { result: refused, text: refused };
    await blocked;
    return { result: handback, text: handback };
  };
  await remember($);
  const running = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
  await f.clock.settle();
  await f.clock.advance(13_000);
  const again = await $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_again' });
  expect(again.text).toBe(refused);
  const first = toolRow('parent_accept', ACCEPT, { offer_id: OFFER });
  const second = {
    ...toolRow('parent_again', ACCEPT, { offer_id: OFFER }),
    isRunning: false,
    output: refused,
  };
  const shown = async (props: typeof first) => {
    const row = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolUse',
      props,
    });
    const lines = (await shownLines(row)).join('');
    await row.unmount();
    return lines;
  };
  const live = (seconds: number) =>
    `⏺DeepSeek(Read selected source) · 1 tool use · 41.2k tokens · ${seconds}s · $0.0043 so far  ⎿  Read(src/example.ts)`;
  // The repeat's own row: this call started nothing. The worker's row goes on, and the
  // parent's spinner is the host's throughout.
  const repeat = '⏺DeepSeek(Read selected source)  ⎿  Not started';
  expect(await shown(first)).toBe(live(13));
  expect(await shown(second)).toBe(repeat);
  expect(await spinning()).toBe('engine step');
  await f.clock.advance(1000);
  expect(await shown(first)).toBe(live(14));
  expect(await spinning()).toBe('engine step');
  release();
  expect((await running).text).toBe(handback);
  await f.clock.settle();
  const done =
    '⏺DeepSeek(Read selected source)  ⎿  Done (12 tool uses · 41.2k tokens · 2m 13s · $0.039)';
  expect(await shown({ ...first, isRunning: false, output: handback })).toBe(done);
  expect(await shown(second)).toBe(repeat);
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
  on('ui.render', { component: 'ToolResult' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['engine result'] }),
  );
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    groups.push(e.props);
    return $.ui.resolve(e).Text({ children: ['Calling plugin:tenjin:router…'] });
  });
  const accept = toolRow('parent_accept', ACCEPT, { offer_id: OFFER });
  const batch = toolRow('batch', ACCEPT, { offer_ids: [OFFER, SECOND_OFFER] });
  const read = toolRow('read_1', 'Read', { file_path: '/repo/a.ts' });
  for (const [calls, unfolds] of [
    [[accept], true],
    [[read, accept], true],
    [[read, batch], true],
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

  const completed = JSON.stringify({
    results: [OFFER, SECOND_OFFER].map((offer_id) => ({
      offer_id,
      outcome: { status: 'completed', elapsedMs: 3000, toolUses: 1 },
    })),
  });
  const compact = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [toolRow(batch.tool_use_id, ACCEPT, batch.input, completed)],
      isActive: false,
      isExpanded: false,
    },
  });
  const compactLines = (await shownLines(compact)).join('');
  expect(compactLines).toContain('2 DeepSeek agents finished');
  expect(compactLines.match(/⎿ {2}Done/g)).toHaveLength(2);
  expect(compactLines).not.toContain('engine result');
  await compact.unmount();

  const withNotice = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolGroup',
    props: { calls: [batch], isActive: true, isExpanded: false, isCallsOnly: false },
  });
  expect(groups.at(-1)?.isExpanded).toBe(true);
  expect(await shownLines(withNotice)).toEqual(['Calling plugin:tenjin:router…']);
  await withNotice.unmount();

  // Ctrl+O uses standalone ToolUse and ToolResult, without another ToolGroup.
  const row = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...toolRow(batch.tool_use_id, ACCEPT, batch.input, completed), isExpanded: true },
  });
  const expanded = (await shownLines(row)).join('');
  expect(expanded.match(/DeepSeek\(subagent\)/g)).toHaveLength(2);
  expect(expanded).not.toContain('2 DeepSeek agents finished');
  await row.unmount();
  const result = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolResult',
    props: {
      tool_use_id: batch.tool_use_id,
      tool: ACCEPT,
      output: completed,
      isErrored: false,
      isExpanded: true,
    },
  });
  expect(await shownLines(result)).toEqual(['engine result']);
  await result.unmount();
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
      if (rows) f.state.rows = [...rows];
      await remember($);
      const { running, firstStep } = await startWithViewer($, f);
      f.state.phase = phase;
      f.state.started = started;
      release();
      await running;
      // Nothing ran: no row, no counts, and never a line that reads as a finished run.
      expect((await firstStep).answer).toBe(ending);
      await f.clock.settle();
    },
  );

// The operator: a native subagent's transcript shows a result line under each call and the
// worker's text between calls, and no plugin-drawn spinner. Each step is one worker reply.
test("each viewer step is one worker reply: its text, and its calls answered as Claude Code's own with a short result line", async ($, on) => {
  const f = setup($, on);
  const seen: unknown[] = [];
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    seen.push(e.props);
    return $.ui.resolve(e).Text({ children: ['engine spinner'] });
  });
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'handback' };
  };
  const reply = (id: string, rest: Record<string, unknown>) => ({
    id,
    sequence: 1,
    state: 'completed',
    message: 'm1',
    ...rest,
  });
  f.state.rows = [
    reply('said', { kind: 'text', text: 'The cancel path reads one turn. Checking lint.' }),
    reply('tool:read', {
      kind: 'tool',
      name: 'Read',
      inputSummary: '{"file_path":"/repo/src/router/model-mcp.ts"}',
      outputPreview: 'PRIVATE_FILE_BODY',
      lines: 120,
    }),
    reply('tool:lint', {
      kind: 'tool',
      name: 'Bash',
      inputSummary: '{"command":"[text: 9 chars]"}',
      command: 'pnpm lint',
      // The CLI's preview, its values already replaced; terminal controls go here too.
      outputPreview: 'ok \u001b[31mDEEP=[env:DEEP]\nline 2\nline 3\nPRIVATE_FOURTH_LINE',
    }),
    // The next reply is still running: not a step yet.
    {
      ...reply('tool:push', { kind: 'tool', name: 'Bash', command: 'git push' }),
      message: 'm2',
      state: 'running',
    },
  ];
  await remember($);
  const running = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
  await f.clock.settle();
  await $.classic.SubagentStart({ agent_id: 'native-viewer-1', agent_type: TYPE });
  const chunksOf = async (index: number) => {
    const chunks: TurnStepChunk[] = [];
    const stream = $.turn.step({
      agentId: 'native-viewer-1',
      index,
      turnId: 'viewer-turn',
      model: 'inherit',
      messageCount: 0,
    });
    for (let item = await stream.next(); ; item = await stream.next()) {
      if (item.done) return { chunks, result: item.value };
      chunks.push(item.value);
    }
  };
  const first = await chunksOf(0);
  expect(first.result.stopReason).toBe('tool_use');
  expect(
    first.chunks.map((c) => [
      c.kind,
      'text' in c ? c.text : 'name' in c ? c.name : 'json' in c ? c.json : '',
    ]),
  ).toEqual([
    ['text', 'The cancel path reads one turn. Checking lint.'],
    ['tool', 'Read'],
    ['input', '{"file_path":"/repo/src/router/model-mcp.ts"}'],
    ['tool', 'Bash'],
    ['input', '{"command":"pnpm lint"}'],
    ['stop', ''],
  ]);
  const [readId, lintId] = first.chunks.flatMap((c) => (c.kind === 'tool' ? [c.id] : []));
  // The host runs each call; the plugin answers it from the worker's row and nothing runs.
  const read = await $.tool.call({
    tool: 'Read',
    file_path: '/repo/src/router/model-mcp.ts',
    tool_use_id: readId!,
    agentId: 'native-viewer-1',
  });
  expect(read.result).toEqual({
    type: 'text',
    file: {
      filePath: '/repo/src/router/model-mcp.ts',
      content: '',
      numLines: 120,
      startLine: 1,
      totalLines: 120,
    },
  });
  const lint = await $.tool.call({
    tool: 'Bash',
    command: 'pnpm lint',
    tool_use_id: lintId!,
    agentId: 'native-viewer-1',
  });
  expect(lint.result).toEqual({
    stdout: 'ok  [31mDEEP=[env:DEEP]\nline 2\nline 3',
    stderr: '',
    interrupted: false,
  });
  // Any other call in the viewer's loop is refused before it could run.
  const other = await $.tool.call({
    tool: 'Bash',
    command: 'rm -rf /repo',
    tool_use_id: 'toolu_other',
    agentId: 'native-viewer-1',
  });
  expect(JSON.stringify(other)).toContain('runs no tool');
  // The next reply: a refused call drawn with its reason, and a call of another tool as a line.
  f.state.rows = [
    {
      ...reply('tool:push', {
        kind: 'tool',
        name: 'Bash',
        command: 'git push',
        outputPreview: 'Permission to use Bash was denied.',
      }),
      message: 'm2',
      state: 'error',
    },
    reply('tool:fetch', {
      kind: 'tool',
      name: 'WebFetch',
      message: 'm2',
      inputSummary: '{"url":"[text: 20 chars]"}',
      outputPreview: 'Fetched 12 KB\nPRIVATE_PAGE',
    }),
  ];
  f.state.sequence = 5;
  const second = await chunksOf(1);
  const pushId = second.chunks.flatMap((c) => (c.kind === 'tool' ? [c.id] : []))[0];
  expect(second.chunks.filter((c) => c.kind === 'text')).toEqual([
    { kind: 'text', index: 1, text: '```\n⏺ WebFetch\n  ⎿  Fetched 12 KB\n```' },
  ]);
  expect(
    await $.tool.call({
      tool: 'Bash',
      command: 'git push',
      tool_use_id: pushId!,
      agentId: 'native-viewer-1',
    }),
  ).toMatchObject({
    deny: 'Permission to use Bash was denied.',
  });
  // The worker ends: its answer, in full, and the end line.
  f.state.rows = [];
  f.state.sequence = 9;
  f.state.phase = 'completed';
  f.state.result = 'Cancel looks up the current turn only.\nLint passes.';
  release();
  await running;
  const last = await chunksOf(2);
  expect(last.result.answer).toBe(
    'Cancel looks up the current turn only.\nLint passes.\n\nDone (1 tool use · 41.2k tokens · 0s · $0.0043)',
  );
  expect(JSON.stringify([first, second, last, read, lint])).not.toContain('PRIVATE_');
  expect(f.state.nativeSteps).toBe(0);
  // No spinner of the plugin's: the viewer's and the parent's are the host's own, here the
  // test's stand-in for the engine, drawn from the props as the host sent them.
  const spinner = { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' as const };
  for (const requestId of ['native-viewer-1', 'main']) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'Spinner',
      requestId,
      props: spinner,
    });
    expect(await shownLines(ui)).toEqual(['engine spinner']);
    await ui.unmount();
  }
  expect(seen).toEqual([spinner, spinner]);
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
  expect(await message(told + OFFER + ' Read selected source')).toBe(INPUT.prompt);
  // No record for it in this session, as after a restart: never the internal line.
  expect(await message(told + OFFER2 + ' Earlier job')).toBe('DeepSeek worker for: Earlier job');
  // A viewer an earlier build started was told its description alone.
  expect(await message(told + 'DeepSeek #9 · Earlier job')).toBe(
    'DeepSeek worker for: Earlier job',
  );
  // Any other message is the engine's own.
  expect(await message('Read src/example.ts.')).toBe('Read src/example.ts.');
});

test('an accept call the host moved to the background stays one live DeepSeek row and ends with the worker, never as Not started', async ($, on) => {
  const f = setup($, on);
  on('ui.render', { component: 'ToolResult' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['engine result'] }),
  );
  const shown: string[] = [];
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    shown.push(e.props.text);
    return $.ui.resolve(e).Text({ children: [e.props.text] });
  });
  // What the host answers the parent after two minutes, in place of the worker's envelope.
  const notice =
    'MCP tool "plugin:tenjin:router/subagent" is still running after 120s. It was moved to the background as task k854rfv5w and keeps running; you\'ll receive a notification with the result when it completes.';
  f.state.work = () => ({ result: notice, text: notice });
  await remember($);
  const moved = await $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
  expect(moved.text).toBe(notice);
  // Its viewer goes on following the worker, in short reads of its own.
  f.state.followWait = new Promise<void>((resolve) => {
    f.state.finishFollow = resolve;
  });
  await $.classic.SubagentStart({ agent_id: 'native-viewer-1', agent_type: TYPE });
  const viewing = step($, 'native-viewer-1');
  await f.clock.advance(1000);
  const row = async (output?: string) => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...toolRow('parent_accept', ACCEPT, { offer_id: OFFER }, output) },
    });
    const lines = (await shownLines(ui)).join('');
    const [dot] = await ui.findAll({ type: 'Text', text: '⏺' });
    await ui.unmount();
    return [lines, dot?.props.color] as const;
  };
  // The call has "a result" now, and the worker is still running: so is its row.
  expect(await row(notice)).toEqual([
    '⏺DeepSeek(Read selected source) · 1 tool use · 41.2k tokens · 1s · $0.0043 so far  ⎿  Read(src/example.ts)',
    undefined,
  ]);
  // The notice itself, which names the server and the tool, is not drawn under it.
  const result = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'parent_accept', tool: ACCEPT, output: notice, isErrored: false },
  });
  expect(await shownLines(result)).toEqual([]);
  await result.unmount();
  await f.clock.advance(120_000);
  expect((await row(notice))[0]).toContain('· 2m 1s ·');
  // The worker ends: its display file goes, and the CLI says how it ended.
  f.state.liveFile = false;
  f.state.phase = 'completed';
  await f.clock.advance(1000);
  await f.clock.settle();
  expect(await row(notice)).toEqual([
    '⏺DeepSeek(Read selected source)  ⎿  Done (1 tool use · 41.2k tokens · 2m 2s · $0.0043)',
    'success',
  ]);
  // And its viewer, never retired at the two-minute mark, keeps the whole run.
  f.state.finishFollow();
  expect((await viewing).answer).toBe(
    '```\n⏺ Read(src/example.ts)\n```\n\nDone (1 tool use · 41.2k tokens · 2m 2s · $0.0043)',
  );
  await f.clock.settle();
  // The task's own notification, by the task id or the call's, reads as a native
  // subagent's return does: one line naming the sender, and in full who finished.
  for (const task of [{ id: 'k854rfv5w' }, { toolUseId: 'parent_accept' }])
    for (const isExpanded of [false, true]) {
      const before = shown.length;
      const ui = await $.ui.mount({
        plugin: 'tenjin',
        surface: 'terminal',
        component: 'UserMessage',
        props: {
          text: 'MCP task k854rfv5w (plugin:tenjin:router/subagent) completed.',
          origin: { kind: 'task-notification' },
          isExpanded,
          task: { ...task, status: 'completed' },
        },
      });
      const lines = await shownLines(ui);
      await ui.unmount();
      if (isExpanded)
        expect(shown.at(-1)).toBe(
          'DeepSeek "Read selected source" finished · Done (1 tool use · 41.2k tokens · 2m 2s · $0.0043)',
        );
      else {
        expect(lines).toEqual(['› Message from @DeepSeek (ctrl+o to expand)']);
        // The host's own text, which names the server and the tool, is not drawn.
        expect(shown.length).toBe(before);
      }
    }
});

test("an accept call still being written draws nothing of the host's, and its group unfolds", async ($, on) => {
  const f = setup($, on);
  f.state.work = () => ({ result: 'unused' });
  on('ui.render', { component: 'ToolUse' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['plugin:tenjin:router - subagent (MCP)'] }),
  );
  let unfolded: boolean | undefined;
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    unfolded = e.props.isExpanded;
    return $.ui.resolve(e).Text({ children: ['Calling plugin:tenjin:router…'] });
  });
  const row = async (input: unknown, more: Record<string, unknown> = {}) => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...toolRow('writing_accept', ACCEPT, input), isRunning: true, ...more },
    });
    const lines = (await shownLines(ui)).join('');
    await ui.unmount();
    return lines;
  };
  // No offer id yet: the host's own row would name the server for that moment.
  expect(await row({})).toBe('');
  expect(await row(undefined)).toBe('');
  // Part of the id, as the host draws the input while it streams (live on alpha.64).
  expect(await row({ offer_id: OFFER.slice(0, 13) })).toBe('');
  expect(await row({ offer_id: '' })).toBe('');
  // Whole: the DeepSeek row, from the first frame it can be told from a cancel. The
  // accept hook has not run yet, so the offer's own record names the task.
  await remember($);
  expect(await row({ offer_id: OFFER })).toBe('⏺DeepSeek(Read selected source) · starting');
  // A cancel, and a call that already has its answer, keep the host's row.
  expect(await row({ cancel: OFFER })).toBe('plugin:tenjin:router - subagent (MCP)');
  expect(await row({}, { isRunning: false, output: 'Invalid input' })).toBe(
    'plugin:tenjin:router - subagent (MCP)',
  );
  // A row of a folded run the mod unfolds reads as expanded too: it draws nothing either
  // (live on alpha.66 the host's `plugin:` row showed for a split second from there).
  expect(await row({}, { isExpanded: true })).toBe('');
  expect(await row({ offer_id: OFFER.slice(0, 8) }, { isExpanded: true })).toBe('');
  const group = async (input: unknown) => {
    unfolded = undefined;
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolGroup',
      props: {
        calls: [{ tool_use_id: 'writing_accept', tool: ACCEPT, input } as never],
        isActive: true,
        isExpanded: false,
      },
    });
    await ui.unmount();
    return unfolded;
  };
  expect(await group({})).toBe(true);
  expect(await group({ offer_id: OFFER.slice(0, 13) })).toBe(true);
  expect(await group({ offer_id: OFFER })).toBe(true);
  expect(await group({ cancel: OFFER })).toBe(false);
});

test("the parent model cannot poll a worker with the viewer's own activity read, and the viewer still can", async ($, on) => {
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
  const reads = f.state.inspections + f.state.follows;
  const polled = await $.tool.call({
    tool: 'mcp__plugin_tenjin_router__subagent_activity',
    offer_id: OFFER,
    tool_use_id: 'parent_poll',
  });
  // Refused before it reaches the CLI, with what to do in its place.
  expect(polled.deny).toContain('arrives by itself');
  expect(f.state.inspections + f.state.follows).toBe(reads);
  f.state.phase = 'completed';
  release();
  await running;
  // The viewer's own reads still pass: its transcript gets the run.
  expect((await firstStep).answer).toContain('Done (');
  await f.clock.settle();
});

// THE HOST RAISES A PLUGIN'S OWN `$.mcp.call` AS A `tool.call` OF THAT TOOL TOO. This kit
// does not: here the call goes straight to the test's `mcp.call` hook. Seen on Claude Code
// 2.1.326 with a probe plugin: the hook got `next.origin` `{ plugin: <the plugin>, tier:
// 'user' }` for the plugin's own call and `{ plugin: 'engine', tier: 'core' }` for the
// model's. Refusing both ended the viewer agent within a second of every accept, so a
// running worker had no entry in the agent list.
test("the plugin's own activity read is told from the model's by who raised it, so the viewer keeps reading", () => {
  expect(raisedByThisPlugin({ plugin: 'tenjin', tier: 'user' } as never)).toBe(true);
  expect(raisedByThisPlugin({ plugin: 'engine', tier: 'core' } as never)).toBe(false);
  expect(raisedByThisPlugin({ plugin: 'another-plugin', tier: 'user' } as never)).toBe(false);
  expect(raisedByThisPlugin(undefined)).toBe(false);
});

for (const settled of ['kept native', 'cancelled', 'expired'] as const)
  test(
    'an offer that is ' + settled + ' draws no row of its own, so the task has one row',
    async ($, on) => {
      const f = setup($, on);
      const held = await remember($);
      const offerRow = async () => {
        const ui = await $.ui.mount({
          plugin: 'tenjin',
          surface: 'terminal',
          component: 'ToolUse',
          props: {
            ...toolRow('held_agent', 'Agent', INPUT),
            isRunning: false,
            output: held.result,
          },
        });
        const lines = (await shownLines(ui)).join('');
        await ui.unmount();
        return lines;
      };
      // Open: the held call reads as the offer it is.
      expect(await offerRow()).toBe('⏺Agent(Read selected source) · Tenjin offered DeepSeek');
      if (settled === 'kept native') {
        // The veto is the same call again, with nothing said: the CLI lets it run native.
        f.state.keepNative = true;
        await remember($);
        expect(f.state.nativeCalls).toHaveLength(1);
      } else if (settled === 'cancelled') {
        await $.tool.call({ tool: ACCEPT, cancel: OFFER, tool_use_id: 'parent_cancel' });
      } else await f.clock.advance(15 * 60_000 + 1000);
      // Settled with no worker: only the native call's own row is left for the task.
      expect(await offerRow()).toBe('');
      await f.clock.settle();
    },
  );

/** What the host answers the parent after two minutes, in place of the worker's envelope. */
const MOVED =
  'MCP tool "plugin:tenjin:router/subagent" is still running after 120s. It was moved to the background as task k2vf9xspk and keeps running; you\'ll receive a notification with the result when it completes.';
/** The job's own end, as its record keeps it: offer cbe81427 of the alpha.52 run. */
const JOB_END = {
  status: 'completed',
  elapsedMs: 882_695,
  toolUses: 89,
  tokens: 215_822,
  spend: { reservedAtomic: '226437', actualAtomic: '226437', uncertain: [] },
};
async function acceptRow($: Engine, toolUseId: string, offerId: string, output?: string) {
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: toolRow(toolUseId, ACCEPT, { offer_id: offerId }, output),
  });
  const lines = (await shownLines(ui)).join('');
  const [dot] = await ui.findAll({ type: 'Text', text: '⏺' });
  await ui.unmount();
  return [lines, dot?.props.color] as const;
}
test('one accept batch binds both viewers to the nested caller and draws one independent result per offer', async ($, on) => {
  const f = setup($, on);
  on('ui.render', { component: 'ToolResult' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['engine result'] }),
  );
  f.state.agents.push({
    id: 'lead-agent',
    type: 'general-purpose',
    status: 'running',
    description: 'Review the fixtures',
  });
  await remember($);
  f.state.offer = SECOND_OFFER;
  await remember($, { ...INPUT, prompt: 'Read the other fixture.' });
  const input = { offer_ids: [OFFER, SECOND_OFFER] };
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const answer = JSON.stringify({
    results: [
      {
        offer_id: OFFER,
        outcome: { status: 'completed', elapsedMs: 5000, toolUses: 3, result: 'a'.repeat(160_000) },
      },
      {
        offer_id: SECOND_OFFER,
        outcome: {
          status: 'cancelled',
          elapsedMs: 2000,
          endedBy: 'agent_stopped',
          partial: 'b'.repeat(160_000),
        },
      },
    ],
  });
  f.state.work = async (call) => {
    expect(call.offer_ids).toEqual(input.offer_ids);
    await finished;
    return { result: answer, text: answer };
  };
  const run = $.tool.call({
    tool: ACCEPT,
    tool_use_id: 'nested_batch',
    agentId: 'lead-agent',
    ...input,
  });
  await f.clock.settle();
  expect(f.state.accepted).toBe(1);
  const pending = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: toolRow('nested_batch', ACCEPT, input),
  });
  const starting = (await shownLines(pending)).join('');
  await pending.unmount();
  expect(starting).toContain('Running 2 DeepSeek agents…');
  expect(starting).toContain('├ Read selected source');
  expect(starting).toContain('└ Read selected source');
  expect(starting.match(/Initializing…/g)).toHaveLength(2);
  const viewers = f.state.agents.slice(1);
  expect(viewers.map(({ description }) => description)).toEqual([
    'Read selected source',
    'Read selected source (2)',
  ]);
  // Older Claude builds display plugin-owned viewers under the main loop.
  expect([
    ['lead-agent', 'lead-agent'],
    [undefined, undefined],
  ]).toContainEqual(viewers.map(({ parentId }) => parentId));
  for (const child of f.state.agents.slice(1)) {
    await $.classic.SubagentStart({ agent_id: child.id, agent_type: TYPE });
  }
  expect(
    f.state.snapshot?.records.map(({ offerId, nativeId, parentId }) => [
      offerId,
      nativeId,
      parentId,
    ]),
  ).toEqual([
    [OFFER, 'native-viewer-1', 'lead-agent'],
    [SECOND_OFFER, 'native-viewer-2', 'lead-agent'],
  ]);
  f.state.agents[2]!.status = 'killed';
  await complete($, 'native-viewer-2');
  expect(f.state.cancellations).toEqual([{ cancel: SECOND_OFFER, reason: 'agent_stopped' }]);
  finish();
  expect((await run).text).toBe(answer);
  await f.clock.settle();
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: toolRow('nested_batch', ACCEPT, input, answer),
  });
  const lines = (await shownLines(ui)).join('');
  await ui.unmount();
  expect(lines).toContain('1 of 2 DeepSeek agents finished');
  expect(lines).toContain('├ Read selected source · 3 tool uses · 5s');
  expect(lines).toContain('⎿  Done');
  expect(lines).toContain('Stopped by you');
  const expanded = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...toolRow('nested_batch', ACCEPT, input, answer), isExpanded: true },
  });
  const full = (await shownLines(expanded)).join('');
  await expanded.unmount();
  expect(full).toContain('DeepSeek(Read selected source)  ⎿  Done (3 tool uses · 5s)');
  expect(full).not.toContain('DeepSeek agents finished');
  // Both full reports can reach the caller even when their combined length exceeds
  // the usual single-response reader. Only the compact transcript hides them.
  for (const isExpanded of [false, true]) {
    const result = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolResult',
      props: {
        tool_use_id: 'nested_batch',
        tool: ACCEPT,
        output: answer,
        isErrored: false,
        isExpanded,
      },
    });
    expect(await shownLines(result)).toEqual(isExpanded ? ['engine result'] : []);
    await result.unmount();
  }
});

test('a background batch reports each confirmed outcome and leaves another worker unconfirmed', async ($, on) => {
  const f = setup($, on);
  const shown: string[] = [];
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    shown.push(e.props.text);
    return $.ui.resolve(e).Text({ children: [e.props.text] });
  });
  await remember($);
  f.state.offer = SECOND_OFFER;
  await remember($, { ...INPUT, description: 'Read another file' });
  f.state.per[OFFER] = { phase: 'completed' };
  f.state.work = () => ({ result: MOVED, text: MOVED });
  const input = { offer_ids: [OFFER, SECOND_OFFER] };
  const move = await $.tool.call({ tool: ACCEPT, tool_use_id: 'background_batch', ...input });
  expect(move.text).toBe(MOVED);
  await f.clock.advance(1000);
  await f.clock.settle();
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: toolRow('background_batch', ACCEPT, input, MOVED),
  });
  const lines = (await shownLines(ui)).join('');
  await ui.unmount();
  expect(lines).toContain('Running 2 DeepSeek agents…');
  expect(lines).toContain('├ Read selected source');
  expect(lines).toContain('⎿  Done');
  expect(lines).toContain('└ Read another file · 1 tool use');
  for (const task of [{ id: 'k2vf9xspk' }, { toolUseId: 'background_batch' }]) {
    const message = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'UserMessage',
      props: {
        text: 'MCP task k2vf9xspk (plugin:tenjin:router/subagent) completed.',
        origin: { kind: 'task-notification' },
        isExpanded: true,
        task: { ...task, status: 'completed' },
      },
    });
    await message.unmount();
    expect(shown.at(-1)).toBe('DeepSeek workers · 1 finished · 1 unconfirmed');
  }
  f.state.phase = 'cancelled';
  await f.clock.advance(1000);
  await f.clock.settle();
});

/** Accepts the offer; the host moves the call to the background at two minutes. */
async function acceptMoved($: Engine, f: ReturnType<typeof setup>) {
  let move: () => void = () => undefined;
  const moving = new Promise<void>((resolve) => {
    move = resolve;
  });
  f.state.work = async () => {
    await moving;
    return { result: MOVED, text: MOVED };
  };
  await remember($);
  const running = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
  await f.clock.settle();
  await f.clock.advance(120_000);
  move();
  expect((await running).text).toBe(MOVED);
}

test('a worker moved to the background ends when its job does, with the job’s own status and time', async ($, on) => {
  const f = setup($, on);
  const shown: string[] = [];
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    shown.push(e.props.text);
    return $.ui.resolve(e).Text({ children: [e.props.text] });
  });
  await acceptMoved($, f);
  f.state.toolUses = 89;
  f.state.tokens = 215_822;
  f.state.actualAtomic = '226437';
  await f.clock.advance(600_000);
  expect((await acceptRow($, 'parent_accept', OFFER, MOVED))[0]).toBe(
    '⏺DeepSeek(Read selected source) · 89 tool uses · 215.8k tokens · 12m 0s · $0.226437 so far  ⎿  Read(src/example.ts)',
  );
  // The job completes 14m 42s after its worker started: its display file goes, and the
  // CLI reads how it ended from the job's record.
  await f.clock.advance(164_000);
  f.state.liveFile = false;
  f.state.phase = 'completed';
  f.state.ended = JOB_END;
  await f.clock.advance(1000);
  await f.clock.settle();
  const done = [
    '⏺DeepSeek(Read selected source)  ⎿  Done (89 tool uses · 215.8k tokens · 14m 42s · $0.226437)',
    'success',
  ];
  expect(await acceptRow($, 'parent_accept', OFFER, MOVED)).toEqual(done);
  // Nothing later rewrites it: no limit closes it as a stop.
  await f.clock.advance(31 * 60_000);
  expect(await acceptRow($, 'parent_accept', OFFER, MOVED)).toEqual(done);
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'UserMessage',
    props: {
      text: 'MCP task k2vf9xspk (plugin:tenjin:router/subagent) completed.',
      origin: { kind: 'task-notification' },
      isExpanded: true,
      task: { id: 'k2vf9xspk', status: 'completed' },
    },
  });
  await ui.unmount();
  expect(shown.at(-1)).toBe(
    'DeepSeek "Read selected source" finished · Done (89 tool uses · 215.8k tokens · 14m 42s · $0.226437)',
  );
});

// Forty-five minutes of one-second ticks: longer than the kit's default time for a test.
test(
  'a row that cannot learn how its job ended says so at the job’s limit, never as a stop or with a time past its end',
  { timeoutMs: 120_000 },
  async ($, on) => {
    const f = setup($, on);
    await acceptMoved($, f);
    f.state.toolUses = 89;
    f.state.tokens = 215_822;
    f.state.actualAtomic = '226437';
    await f.clock.advance(763_000);
    // The job ends, and every read the row makes is refused.
    f.state.liveFile = false;
    f.state.readsRefused = true;
    await f.clock.advance(45 * 60_000 - 883_000 + 2000);
    await f.clock.settle();
    const [line, color] = await acceptRow($, 'parent_accept', OFFER, MOVED);
    expect(line).toBe(
      '⏺DeepSeek(Read selected source)  ⎿  Outcome not shown here (89 tool uses · 215.8k tokens · $0.226437 so far)',
    );
    expect(color).toBeUndefined();
  },
);

test('a row drawn after a resume, with no record and no live view, follows the running job and ends with it', async ($, on) => {
  const f = setup($, on);
  // A resumed session: this module never saw the accept, and the CLI process holds no view.
  f.state.liveView = false;
  const background = ['⏺DeepSeek(subagent) · running in the background', undefined];
  expect(await acceptRow($, 'parent_accept', OFFER, MOVED)).toEqual(background);
  await f.clock.settle();
  // The worker still runs, so its display file is there: the row goes on.
  await f.clock.advance(300_000);
  expect(await acceptRow($, 'parent_accept', OFFER, MOVED)).toEqual(background);
  f.state.liveFile = false;
  f.state.ended = JOB_END;
  await f.clock.advance(1000);
  await f.clock.settle();
  expect(await acceptRow($, 'parent_accept', OFFER, MOVED)).toEqual([
    '⏺DeepSeek(subagent)  ⎿  Done (89 tool uses · 215.8k tokens · 14m 42s · $0.226437)',
    'success',
  ]);
});

test('a row drawn after a resume of a job that already ended settles at once from its record', async ($, on) => {
  const f = setup($, on);
  f.state.liveView = false;
  f.state.liveFile = false;
  f.state.ended = { status: 'cancelled', elapsedMs: 61_000, toolUses: 3, tokens: 900 };
  await acceptRow($, 'parent_accept', OFFER, MOVED);
  await f.clock.settle();
  expect(await acceptRow($, 'parent_accept', OFFER, MOVED)).toEqual([
    '⏺DeepSeek(subagent)  ⎿  Interrupted (3 tool uses · 900 tokens · 1m 1s)',
    'error',
  ]);
});

const OFFER2 = 'c4a1f0de-7b2e-4c11-9a3d-5e6f7a8b9c0d';
const INPUT2 = {
  prompt: 'Check the cancel path in src/router/model-mcp.ts. Final line: DONE.',
  description: 'Check the cancel path',
  subagent_type: 'general-purpose',
};
async function heldRow(
  $: Engine,
  toolUseId: string,
  input: Record<string, unknown>,
  output: unknown,
) {
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: { ...toolRow(toolUseId, 'Agent', input), isRunning: false, output },
  });
  const lines = (await shownLines(ui)).join('');
  await ui.unmount();
  return lines;
}

test('two offers and two workers at once each keep their own row, viewer entry and end line', async ($, on) => {
  const f = setup($, on);
  const spinners: unknown[] = [];
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    spinners.push(e.props);
    return $.ui.resolve(e).Text({ children: ['engine spinner'] });
  });
  f.state.offer = OFFER;
  const first = (await remember($, INPUT)).result;
  f.state.offer = OFFER2;
  const second = (await remember($, INPUT2)).result;
  f.state.offer = OFFER;
  expect(await heldRow($, 'held_a', INPUT, first)).toBe(
    '⏺Agent(Read selected source) · Tenjin offered DeepSeek',
  );
  expect(await heldRow($, 'held_b', INPUT2, second)).toBe(
    '⏺Agent(Check the cancel path) · Tenjin offered DeepSeek',
  );
  f.state.per[OFFER2] = { toolUses: 7, tokens: 9000, actualAtomic: '1200' };
  const release: Record<string, () => void> = {};
  const blocked = Object.fromEntries(
    [OFFER, OFFER2].map((id) => [id, new Promise<void>((resolve) => (release[id] = resolve))]),
  );
  const handback = (toolUses: number, elapsedMs: number) =>
    JSON.stringify({
      status: 'completed',
      elapsedMs,
      toolUses,
      tokens: 41_234,
      spend: { reservedAtomic: '50000', actualAtomic: '39000', uncertain: [] },
      result: 'worker report',
    });
  f.state.work = async (e) => {
    await blocked[String(e.offer_id)];
    const text = e.offer_id === OFFER ? handback(12, 9000) : handback(7, 6000);
    return { result: text, text };
  };
  const a = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'accept_a' });
  await f.clock.settle();
  await f.clock.advance(5000);
  const b = $.tool.call({ tool: ACCEPT, offer_id: OFFER2, tool_use_id: 'accept_b' });
  await f.clock.settle();
  await f.clock.advance(3000);
  // Each worker's live row stands where its call was held; its accept call draws nothing.
  const liveA = (s: number) =>
    `⏺DeepSeek(Read selected source) · 1 tool use · 41.2k tokens · ${s}s · $0.0043 so far  ⎿  Read(src/example.ts)`;
  const liveB = (s: number) =>
    `⏺DeepSeek(Check the cancel path) · 7 tool uses · 9k tokens · ${s}s · $0.0012 so far  ⎿  Read(src/example.ts)`;
  expect(await heldRow($, 'held_a', INPUT, first)).toBe(liveA(8));
  expect(await heldRow($, 'held_b', INPUT2, second)).toBe(liveB(3));
  expect((await acceptRow($, 'accept_a', OFFER))[0]).toBe('');
  expect((await acceptRow($, 'accept_b', OFFER2))[0]).toBe('');
  // Each has its own entry in the agent list.
  expect(f.state.agents.map((agent) => [agent.type, agent.description])).toEqual([
    [TYPE, 'Read selected source'],
    [TYPE, 'Check the cancel path'],
  ]);
  // The parent's spinner is the host's, whichever workers run.
  const props = { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' as const };
  await (
    await $.ui.mount({ plugin: 'tenjin', surface: 'terminal', component: 'Spinner', props })
  ).unmount();
  expect(spinners.at(-1)).toEqual(props);
  // The first ends: its own end line; the second is still live, its clock its own.
  release[OFFER]!();
  const endedA = (await a).text;
  await f.clock.settle();
  expect((await acceptRow($, 'accept_a', OFFER, endedA))[0]).toBe('');
  expect(await heldRow($, 'held_a', INPUT, first)).toBe(
    '⏺DeepSeek(Read selected source)  ⎿  Done (12 tool uses · 41.2k tokens · 9s · $0.039)',
  );
  await f.clock.advance(1000);
  expect(await heldRow($, 'held_b', INPUT2, second)).toBe(liveB(4));
  release[OFFER2]!();
  const endedB = (await b).text;
  await f.clock.settle();
  expect((await acceptRow($, 'accept_b', OFFER2, endedB))[0]).toBe('');
  expect(await heldRow($, 'held_b', INPUT2, second)).toBe(
    '⏺DeepSeek(Check the cancel path)  ⎿  Done (7 tool uses · 41.2k tokens · 6s · $0.039)',
  );
});

test('a repeat that keeps one of two identical offers native clears that offer’s row alone', async ($, on) => {
  const f = setup($, on);
  f.state.offer = OFFER;
  const first = (await remember($)).result;
  f.state.offer = OFFER2;
  const second = (await remember($)).result;
  const open = '⏺Agent(Read selected source) · Tenjin offered DeepSeek';
  expect(await heldRow($, 'held_a', INPUT, first)).toBe(open);
  expect(await heldRow($, 'held_b', INPUT, second)).toBe(open);
  // The CLI keeps the repeat native and names the offer it settled: the older one.
  f.state.keepNative = true;
  f.state.offer = OFFER;
  await remember($);
  expect(f.state.nativeCalls).toHaveLength(1);
  expect(await heldRow($, 'held_a', INPUT, first)).toBe('');
  expect(await heldRow($, 'held_b', INPUT, second)).toBe(open);
});

test('an offer for a custom agent type draws its row and its viewer entry as a built-in one does', async ($, on) => {
  const f = setup($, on);
  f.state.nativeProfile = 'loop-worker-high';
  const custom = { ...INPUT, subagent_type: 'loop-worker-high' };
  const held = (await remember($, custom)).result;
  expect(await heldRow($, 'held_agent', custom, held)).toBe(
    '⏺Agent(Read selected source) · Tenjin offered DeepSeek',
  );
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'handback', text: 'handback' };
  };
  const running = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
  await f.clock.settle();
  await f.clock.advance(1000);
  expect(await heldRow($, 'held_agent', custom, held)).toBe(
    '⏺DeepSeek(Read selected source) · 1 tool use · 41.2k tokens · 1s · $0.0043 so far  ⎿  Read(src/example.ts)',
  );
  expect(f.state.agents.map((agent) => [agent.type, agent.description])).toEqual([
    [TYPE, 'Read selected source'],
  ]);
  expect(f.state.snapshot?.records.map((r) => r.profile)).toEqual(['loop-worker-high']);
  release();
  await running;
  await f.clock.settle();
});

// P: the agent list showed `tenjin:deepseek-viewer` and `DeepSeek #1 · …`. Its entry is
// the task's description, ` (2)` on a second of the same, and its row reads `DeepSeek`.
test('the viewer is listed by the task’s description and its row reads DeepSeek with the worker’s counts', async ($, on) => {
  const f = setup($, on);
  const bodies: (string | undefined)[] = [];
  on('ui.render', { component: 'AgentRow' }, ($, e) => {
    bodies.push(e.props.body);
    return $.ui.resolve(e).Text({ children: ['engine row'] });
  });
  await remember($, INPUT);
  f.state.offer = OFFER2;
  await remember($, INPUT);
  f.state.offer = OFFER;
  expect(f.state.snapshot?.records.map((r) => r.description)).toEqual([
    'Read selected source',
    'Read selected source (2)',
  ]);
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'handback' };
  };
  const { running, firstStep } = await startWithViewer($, f);
  await f.clock.advance(1000);
  expect(f.state.agents.map((agent) => agent.description)).toEqual(['Read selected source']);
  const row = async (props: Record<string, unknown>) => {
    const agent = { id: 'native-viewer-1', type: TYPE, description: 'Read selected source' };
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'AgentRow',
      props: {
        ...agent,
        label: agent.description,
        status: 'running',
        rowIds: [],
        isHidden: false,
        ...props,
      } as never,
    });
    await ui.unmount();
    return bodies.at(-1);
  };
  // Claude Code before 2.1.326 has no agent-list row a plugin draws: its own row stands.
  const drawn = await row({}).catch((error: unknown) => {
    if (/is not a component/.test(String(error))) return null;
    throw error;
  });
  if (drawn !== null) {
    expect(drawn).toBe('DeepSeek Read selected source · 1 tool use · 41.2k tokens · 1s');
    // The host's own summary of the task, when it has one, stands in the description's place.
    expect(await row({ label: 'Reading the cancel path\nmore' })).toBe(
      'DeepSeek Reading the cancel path · 1 tool use · 41.2k tokens · 1s',
    );
    // Any other agent's row is the host's own.
    expect(await row({ id: 'native-agent', type: 'general-purpose' })).toBeUndefined();
  }
  release();
  await running;
  await firstStep;
  await f.clock.settle();
});

// Greptile thread on register.tsx (item X): a native subagent's accept passed this hook
// untouched, so its worker ran with no row, no agent-list entry and no viewer to stop it.
test("a native subagent's accept draws the worker's row and its viewer under that subagent, whose stop cancels the worker", async ($, on) => {
  const f = setup($, on);
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'handback' };
  };
  f.state.followWait = blocked;
  await remember($);
  f.state.offer = OFFER2;
  const second = (await remember($, INPUT2)).result;
  f.state.offer = OFFER;
  const accept = { tool: ACCEPT, offer_id: OFFER, tool_use_id: 'child_accept' };
  const running = $.tool.call({ ...accept, agentId: 'native-child' });
  await f.clock.settle();
  await f.clock.advance(1000);
  expect((await acceptRow($, 'child_accept', OFFER))[0]).toBe(
    '⏺DeepSeek(Read selected source) · 1 tool use · 41.2k tokens · 1s · $0.0043 so far  ⎿  Read(src/example.ts)',
  );
  // Listed under the subagent that accepted (2.1.326); an older host lists it under main.
  expect(f.state.agents.map((a) => [a.type, a.description])).toEqual([
    [TYPE, 'Read selected source'],
  ]);
  expect([undefined, 'native-child']).toContain(f.state.agents[0]?.parentId);
  await $.classic.SubagentStart({ agent_id: 'native-viewer-1', agent_type: TYPE });
  const viewing = step($, 'native-viewer-1');
  await f.clock.settle();
  expect(f.state.snapshot?.records[0]).toMatchObject({
    nativeId: 'native-viewer-1',
    parentId: 'native-child',
    active: true,
  });
  // The subagent's cancel of the other offer it got settles that offer's row too.
  await $.tool.call({ tool: ACCEPT, cancel: OFFER2, agentId: 'native-child' });
  expect(await heldRow($, 'held_b', INPUT2, second)).toBe('');
  // Stopping the viewer from the agent list cancels its worker.
  f.state.agents[0]!.status = 'killed';
  await complete($, 'native-viewer-1');
  expect(f.state.cancellations).toContainEqual({ cancel: OFFER, reason: 'agent_stopped' });
  release();
  await running;
  await viewing;
  await f.clock.settle();
});

// A worker's own calls never get an offer (it has no Agent or subagent tool); should one
// reach this hook in its process, it starts nothing of the viewer's.
test("a DeepSeek worker's own accept passes through with no row or viewer", async ($, on) => {
  const f = setup($, on, { TENJIN_MODEL_WORKER: '1' });
  on('ui.render', { component: 'ToolUse' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['engine row'] }),
  );
  const call = { tool: ACCEPT, offer_id: OFFER, tool_use_id: 'worker_accept' };
  expect((await $.tool.call({ ...call, agentId: 'native-child' })).result).toBe(
    'actual worker result',
  );
  expect(f.state.calls).toBe(0);
  expect((await acceptRow($, 'worker_accept', OFFER, 'actual worker result'))[0]).toBe(
    'engine row',
  );
});

// Live on alpha.64 (offer 6b457847): the viewer showed a `ToolSearch` line, WebSearch and
// WebFetch as text lines (one with Markdown bold), and `DeepSeek activity observation
// finished` three times after the answer, once for each hand-back reminder the host sent.
// The worker's real calls: ToolSearch and two Bash greps in one reply, then WebSearch,
// WebFetch, a Bash grep, and the answer.
test('the live sequence draws each call as Claude Code does, in the worker’s order, and nothing after the answer', async ($, on) => {
  const f = setup($, on);
  on('ui.render', { component: 'ToolUse' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['engine row'] }),
  );
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'handback' };
  };
  const row = (id: string, message: string, rest: Record<string, unknown>) => ({
    id: 'tool:' + id,
    sequence: 1,
    kind: 'tool',
    state: 'completed',
    message,
    ...rest,
  });
  const grep = 'grep -rn "pnpm" /repo/.github/workflows/ | head -60; ls /repo/.github/workflows/';
  f.state.rows = [
    row('search', 'm1', { name: 'ToolSearch', inputSummary: '{"query":"[text: 23 chars]"}' }),
    row('grep', 'm1', { name: 'Bash', command: grep, outputPreview: 'ci.yml:35: pnpm' }),
    row('pkg', 'm1', { name: 'Bash', command: 'grep -n packageManager package.json' }),
    row('web', 'm2', {
      name: 'WebSearch',
      target: 'pnpm newest stable release',
      via: 'Exa search',
      figures: { durationSeconds: 4.4 },
      outputPreview: 'Web search results for query: "pnpm newest stable release"',
    }),
    row('fetch', 'm3', {
      name: 'WebFetch',
      target: 'https://pnpm.io/blog/tags/release',
      via: 'Exa page read',
      inputSummary: '{"url":"[text: 33 chars]","prompt":"[text: 40 chars]"}',
      figures: { bytes: 48_213, code: 200, codeText: 'OK', durationMs: 5100 },
      outputPreview: 'The latest release is **"pnpm 12.21.0"**.',
    }),
    row('setup', 'm4', { name: 'Bash', command: 'grep -rn -A4 "pnpm/action-setup" .github' }),
  ];
  await remember($);
  const running = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
  await f.clock.settle();
  await $.classic.SubagentStart({ agent_id: 'native-viewer-1', agent_type: TYPE });
  const steps: TurnStepChunk[][] = [];
  const next = async () => {
    const chunks: TurnStepChunk[] = [];
    const stream = $.turn.step({
      agentId: 'native-viewer-1',
      index: steps.length,
      turnId: 'viewer-turn',
      model: 'inherit',
      messageCount: 0,
    });
    for (let item = await stream.next(); !item.done; item = await stream.next())
      chunks.push(item.value);
    steps.push(chunks);
    return chunks;
  };
  const shown = (chunks: TurnStepChunk[]) =>
    chunks.flatMap((c) => (c.kind === 'tool' ? [c.name] : c.kind === 'text' ? [c.text] : []));
  const answers: unknown[] = [];
  const answer = async (chunks: TurnStepChunk[]) => {
    for (const c of chunks)
      if (c.kind === 'input') {
        const tool = chunks.find((t) => t.kind === 'tool' && t.index === c.index);
        if (tool?.kind !== 'tool') continue;
        const call = { tool: tool.name, ...JSON.parse(c.json), tool_use_id: tool.id };
        answers.push((await $.tool.call({ ...call, agentId: 'native-viewer-1' } as never)).result);
      }
  };
  // The first reply: its two Bash calls as Claude Code's own rows, and no tool search row.
  expect(shown(await next())).toEqual(['Bash', 'Bash']);
  await answer(steps[0]!);
  expect(shown(await next())).toEqual(['WebSearch']);
  await answer(steps[1]!);
  expect(shown(await next())).toEqual(['WebFetch']);
  await answer(steps[2]!);
  expect(answers.slice(2)).toEqual([
    { query: 'pnpm newest stable release', results: [], durationSeconds: 4.4 },
    {
      url: 'https://pnpm.io/blog/tags/release',
      bytes: 48_213,
      code: 200,
      codeText: 'OK',
      result: '',
      durationMs: 5100,
    },
  ]);
  // A call a router tool served names it, as the router's rows do; the host's own line
  // stays under it. Any other call's row is the host's.
  const drawn = async (chunks: TurnStepChunk[], input: unknown) => {
    const call = chunks.find((c) => c.kind === 'tool');
    if (call?.kind !== 'tool') return undefined;
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolUse',
      props: { ...toolRow(call.id, call.name, input, 'done'), isRunning: false },
    });
    const lines = (await shownLines(ui)).join('');
    await ui.unmount();
    return lines;
  };
  expect(await drawn(steps[1]!, { query: 'pnpm newest stable release' })).toBe(
    '⏺Exa search("pnpm newest stable release")',
  );
  expect(await drawn(steps[2]!, { url: 'https://pnpm.io/blog/tags/release' })).toBe(
    '⏺Exa page read(https://pnpm.io/blog/tags/release)',
  );
  expect(await drawn(steps[0]!, { command: grep })).toBe('engine row');
  expect(shown(await next())).toEqual(['Bash']);
  f.state.rows = [];
  f.state.sequence = 9;
  f.state.phase = 'completed';
  f.state.result = 'pnpm 12.21.0 is the newest release.';
  release();
  await running;
  expect(shown(await next())).toEqual([
    'pnpm 12.21.0 is the newest release.\n\nDone (1 tool use · 41.2k tokens · 0s · $0.0043)',
  ]);
  // The host asks again (its hand-back reminder, three times live): nothing is drawn.
  for (let ask = 0; ask < 3; ask++) expect(shown(await next())).toEqual([]);
  expect(JSON.stringify(steps)).not.toContain('ToolSearch');
  expect(JSON.stringify(steps)).not.toContain('**');
  expect(JSON.stringify(steps)).not.toContain('observation');
  expect(f.state.nativeSteps).toBe(0);
});

// The accept was allowed by a PreToolUse command leg in the hooks file, whose run Claude
// Code draws as a row of its own beside the accept's. The mod's `tool.check` allows it.
test("the accept and cancel of an offer are allowed by the mod, and every other input gets the host's verdict", async ($, on) => {
  setup($, on);
  on('tool.check', () => ({ decision: 'ask', reason: 'engine verdict' }));
  const check = (input: unknown) =>
    $.tool.check({ tool: ACCEPT, input } as never).then((verdict) => verdict.decision);
  expect(await check({ offer_id: OFFER })).toBe('allow');
  expect(await check({ offer_ids: [OFFER, SECOND_OFFER] })).toBe('allow');
  expect(await check({ cancel: OFFER })).toBe('allow');
  for (const input of [
    { offer_id: 'not-an-offer' },
    { offer_ids: [OFFER] },
    { offer_ids: [OFFER, 'not-an-offer'] },
    { offer_ids: [OFFER, OFFER.toUpperCase()] },
    { offer_ids: [OFFER, SECOND_OFFER], offer_id: OFFER },
    { offer_ids: [OFFER, SECOND_OFFER], cancel: OFFER },
    { offer_id: OFFER, reason: 'agent_stopped' },
    { capture: { tool: 'Agent' } },
    { delegation_id: OFFER, task: 'do it' },
    {},
  ])
    expect(await check(input)).toBe('ask');
  // Another tool is never answered here.
  expect(
    (await $.tool.check({ tool: 'mcp__plugin_tenjin_router__request', input: {} } as never))
      .decision,
  ).toBe('ask');
});

// Live on alpha.68: for a split second the held Agent row and the DeepSeek row both drew,
// between the accept row's first frame and the accept hook writing the worker's record.
/** A held Agent row as a surface draws it: its lines, and whether its name is struck through. */
async function heldDrawing(
  $: Engine,
  toolUseId: string,
  input: Record<string, unknown>,
  output: unknown,
  surface: (typeof SURFACES)[number] = 'terminal',
  isExpanded = false,
) {
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface,
    component: 'ToolUse',
    props: {
      ...toolRow(toolUseId, 'Agent', input),
      isRunning: false,
      output,
      ...(isExpanded ? { isExpanded } : {}),
    },
  });
  const lines = (await shownLines(ui)).join('');
  const [name] = await ui.findAll({ type: 'Text', text: 'Agent' });
  const [dot] = await ui.findAll({ type: 'Text', text: '⏺' });
  await ui.unmount();
  return { lines, struck: name?.props.strikethrough === true, dot: dot?.props.color };
}

// Operator ruling 2026-11-18, after the alpha.73 run: the worker's row replaces the held
// call's row in place, as the tool router's lookup replaces a held `Web Search` row, and
// the accept adds no row of its own.
test("an accepted offer's worker draws where its Agent call was held, live and to its end, and the accept call draws nothing", async ($, on) => {
  const f = setup($, on);
  on('ui.render', { component: 'ToolUse' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['engine row'] }),
  );
  const held = (await remember($)).result;
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handback = JSON.stringify({
    status: 'completed',
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
  for (const surface of SURFACES) {
    // Open: the native name struck through and what Tenjin offered, as a held Web Search reads.
    expect(await heldDrawing($, 'held_a', INPUT, held, surface)).toEqual({
      lines: '⏺Agent(Read selected source) · Tenjin offered DeepSeek',
      struck: true,
      dot: undefined,
    });
  }
  f.state.liveFile = false;
  const running = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'parent_accept' });
  await f.clock.settle();
  const accept = async (surface: (typeof SURFACES)[number], output?: string, full = false) => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: {
        ...toolRow('parent_accept', ACCEPT, { offer_id: OFFER }, output),
        ...(full ? { isExpanded: true } : {}),
      },
    });
    const lines = (await shownLines(ui)).join('');
    await ui.unmount();
    return lines;
  };
  for (const surface of SURFACES) {
    expect(await accept(surface)).toBe('');
    expect(await heldDrawing($, 'held_a', INPUT, held, surface)).toEqual({
      lines: '⏺DeepSeek(Read selected source) · starting · 0s',
      struck: false,
      dot: undefined,
    });
  }
  f.state.liveFile = true;
  await f.clock.advance(13_000);
  const live =
    '⏺DeepSeek(Read selected source) · 1 tool use · 41.2k tokens · 13s · $0.0043 so far  ⎿  Read(src/example.ts)';
  for (const surface of SURFACES) {
    expect((await heldDrawing($, 'held_a', INPUT, held, surface)).lines).toBe(live);
    expect(await accept(surface)).toBe('');
  }
  // SHOWN IN FULL (ctrl+o) on one surface: the held call is the engine's row there and
  // the accept call's row is the worker's. The other surface keeps the row in place.
  expect((await heldDrawing($, 'held_a', INPUT, held, 'terminal', true)).lines).toBe('engine row');
  expect(await accept('terminal', undefined, true)).toBe(live);
  expect(await accept('desktop')).toBe('');
  expect((await heldDrawing($, 'held_a', INPUT, held, 'terminal')).lines).toBe(live);
  expect(await accept('terminal')).toBe('');
  release();
  expect((await running).text).toBe(handback);
  await f.clock.settle();
  for (const surface of SURFACES) {
    expect(await accept(surface, handback)).toBe('');
    expect(await heldDrawing($, 'held_a', INPUT, held, surface)).toEqual({
      lines:
        '⏺DeepSeek(Read selected source)  ⎿  Done (12 tool uses · 41.2k tokens · 2m 13s · $0.039)',
      struck: false,
      dot: 'success',
    });
  }
});

test("a held Agent row drawn after a resume ends from the accept call's own answer, and a repeated accept never replaces it", async ($, on) => {
  setup($, on);
  const held = {
    status: 'completed',
    agentId: 'tenjin-offer-' + OFFER,
    prompt: INPUT.prompt,
    content: [{ type: 'text', text: JSON.stringify({ action: 'offer', offer_id: OFFER }) }],
    totalToolUseCount: 0,
    totalDurationMs: 0,
    totalTokens: 0,
  };
  const handback = JSON.stringify({
    status: 'cancelled',
    endedBy: 'budget',
    elapsedMs: 61_000,
    toolUses: 4,
    tokens: 9000,
    spend: { reservedAtomic: '50000', actualAtomic: '50000', uncertain: [] },
  });
  const refused = JSON.stringify({ action: 'native', reason: 'its worker is still running' });
  // Nothing of the session's state is left: only the two calls and their answers.
  expect((await heldDrawing($, 'held_a', INPUT, held)).lines).toBe(
    '⏺Agent(Read selected source) · Tenjin offered DeepSeek',
  );
  // A call sent again while the worker ran is drawn first: it started nothing.
  expect((await acceptRow($, 'parent_again', OFFER, refused))[0]).toBe('');
  expect((await acceptRow($, 'parent_accept', OFFER, handback))[0]).toBe('');
  expect((await acceptRow($, 'parent_again', OFFER, refused))[0]).toBe('');
  expect(await heldDrawing($, 'held_a', INPUT, held)).toEqual({
    lines:
      '⏺DeepSeek(Read selected source)  ⎿  Budget reached (4 tool uses · 9k tokens · 1m 1s · $0.05)',
    struck: false,
    dot: 'error',
  });
});

// Operator ruling 2026-11-18: "background calls should get an offer". An Agent call with
// `run_in_background` was never offered; now its worker runs in the background, the accept
// answers at once, and the result reaches the parent when the worker ends.
test("a background worker's row reads as a native background agent's, and its result is handed to the parent once when it ends", async ($, on) => {
  const f = setup($, on);
  const submitted: string[] = [];
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text);
    return { text: e.text };
  });
  on('ui.render', { component: 'UserMessage' }, ($, e) =>
    $.ui.resolve(e).Text({ children: [e.props.text] }),
  );
  // As Claude Code 2.1.327 handed it to the hook live: the string, not the boolean.
  const call = { ...INPUT, run_in_background: 'true' };
  const held = (await remember($, call)).result;
  expect((await heldDrawing($, 'held_bg', call, held)).lines).toBe(
    '⏺Agent(Read selected source) · Tenjin offered DeepSeek',
  );
  // The CLI answers a background call's accept at once: the worker has started and runs on.
  const started = JSON.stringify({
    status: 'started',
    background: true,
    offer_id: OFFER,
    worker_handle: WORKER,
    instruction: 'The DeepSeek worker is running in the background.',
  });
  f.state.work = () => ({ result: started, text: started });
  expect(
    (await $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'bg_accept' })).text,
  ).toBe(started);
  await f.clock.settle();
  const still = '⏺DeepSeek(Read selected source)  ⎿  Backgrounded agent (↓ to manage)';
  expect((await acceptRow($, 'bg_accept', OFFER, started))[0]).toBe('');
  expect((await heldDrawing($, 'held_bg', call, held)).lines).toBe(still);
  // Its answer draws no result block either.
  const result = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'bg_accept', tool: ACCEPT, output: started, isErrored: false },
  });
  expect(await shownLines(result)).toEqual([]);
  await result.unmount();
  // While it runs: the same still line, its progress in the agent list, and nothing sent.
  await f.clock.advance(30_000);
  expect((await heldDrawing($, 'held_bg', call, held)).lines).toBe(still);
  expect(f.state.agents.map((agent) => agent.description)).toEqual(['Read selected source']);
  expect(submitted).toEqual([]);
  // The worker ends: its end line, and its stored handback goes to the parent as a prompt.
  const handback = JSON.stringify({
    status: 'completed',
    elapsedMs: 61_000,
    toolUses: 12,
    tokens: 41_234,
    spend: { reservedAtomic: '50000', actualAtomic: '39000', uncertain: [] },
    result: 'the background report',
    worker_handle: WORKER,
  });
  f.state.phase = 'completed';
  f.state.ended = JSON.parse(handback);
  f.state.handback = handback;
  await f.clock.advance(1000);
  await f.clock.settle();
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toContain(
    `DeepSeek background worker "Read selected source" ended (offer ${OFFER}).`,
  );
  expect(submitted[0]!.endsWith(handback)).toBe(true);
  expect(await heldDrawing($, 'held_bg', call, held)).toMatchObject({
    lines:
      '⏺DeepSeek(Read selected source)  ⎿  Done (12 tool uses · 41.2k tokens · 1m 1s · $0.039)',
    dot: 'success',
  });
  // Once: nothing more is sent however long the session goes on.
  await f.clock.advance(60_000);
  await f.clock.settle();
  expect(submitted).toHaveLength(1);
  // That prompt's row names its sender in one dim line, as a moved call's notice does.
  for (const text of [submitted[0]!, 'The tenjin plugin sent a message:\n' + submitted[0]]) {
    const row = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'UserMessage',
      props: { text },
    });
    expect(await shownLines(row)).toEqual(['› Message from @DeepSeek (ctrl+o to expand)']);
    await row.unmount();
  }
});

// Greptile on 7c1d9550: a batch call holds until its foreground workers end, so a background
// worker of the batch that ended first was stopped with nothing sent, and the batch's late
// `started` answer for it sent nothing either.
test('a background worker of a mixed batch that ends before the batch call returns still hands its result to the parent, once', async ($, on) => {
  const f = setup($, on);
  const submitted: string[] = [];
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text);
    return { text: e.text };
  });
  f.state.offer = OFFER;
  await remember($, INPUT);
  f.state.offer = OFFER2;
  await remember($, { ...INPUT2, run_in_background: true });
  f.state.offer = OFFER;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = JSON.stringify({
    results: [
      { offer_id: OFFER, outcome: { status: 'completed', elapsedMs: 9000, result: 'foreground' } },
      { offer_id: OFFER2, outcome: { status: 'started', background: true, offer_id: OFFER2 } },
    ],
  });
  f.state.work = async () => {
    await held;
    return { result: answer, text: answer };
  };
  const batch = $.tool.call({
    tool: ACCEPT,
    offer_ids: [OFFER, OFFER2],
    tool_use_id: 'mixed_batch',
  });
  await f.clock.settle();
  await f.clock.advance(2000);
  // The background worker ends while the batch call still waits for the foreground one.
  const handback = JSON.stringify({ status: 'completed', elapsedMs: 2000, result: 'background' });
  f.state.per[OFFER2] = { phase: 'completed' };
  f.state.ended = JSON.parse(handback);
  f.state.handback = handback;
  await f.clock.advance(1000);
  await f.clock.settle();
  // Its stored result is read at its end. The host takes no prompt while this plugin's
  // hook holds the batch call, so it goes out when that call has returned.
  expect(f.state.handbackReads).toBe(1);
  expect(submitted).toEqual([]);
  // The batch's own answer, which names that worker as started, sends nothing more.
  f.state.ended = undefined;
  release();
  expect((await batch).text).toBe(answer);
  await f.clock.settle();
  await f.clock.advance(5000);
  await f.clock.settle();
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toContain(`ended (offer ${OFFER2}).`);
  expect(submitted[0]!.endsWith(handback)).toBe(true);
});

test("a foreground worker's result is its accept call's own answer, and nothing is sent to the parent besides", async ($, on) => {
  const f = setup($, on);
  const submitted: string[] = [];
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text);
    return { text: e.text };
  });
  await remember($);
  const handback = JSON.stringify({ status: 'completed', elapsedMs: 9000, result: 'report' });
  f.state.work = () => ({ result: handback, text: handback });
  f.state.handback = handback;
  await $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'fg_accept' });
  await f.clock.settle();
  await f.clock.advance(5000);
  await f.clock.settle();
  expect(submitted).toEqual([]);
  expect(f.state.handbackReads).toBe(0);
});

// Two or more Agent calls of one response are Claude Code's own summary block, which no
// render hook draws: their held rows never draw, so their workers draw at the accept call.
test('an accept batch draws only the workers whose held call has no row of its own', async ($, on) => {
  const f = setup($, on);
  f.state.offer = OFFER;
  await remember($, INPUT);
  f.state.offer = OFFER2;
  await remember($, INPUT2);
  f.state.offer = THIRD_OFFER;
  const alone = { ...INPUT, description: 'Sent again alone' };
  const third = (await remember($, alone)).result;
  f.state.offer = OFFER;
  // The third call was the only Agent call of its response: its row is drawn.
  expect((await heldDrawing($, 'held_c', alone, third)).lines).toContain('Tenjin offered DeepSeek');
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.work = async () => {
    await blocked;
    return { result: 'handback', text: 'handback' };
  };
  const batch = async (ids: string[]) => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolUse',
      props: toolRow('accept_' + ids.length, ACCEPT, { offer_ids: ids }),
    });
    const lines = (await shownLines(ui)).join('');
    await ui.unmount();
    return lines;
  };
  const all = [OFFER, OFFER2, THIRD_OFFER];
  const running = $.tool.call({ tool: ACCEPT, offer_ids: all, tool_use_id: 'accept_3' });
  await f.clock.settle();
  const group = await batch(all);
  expect(group).toContain('Running 2 DeepSeek agents…');
  expect(group).toContain('├ Read selected source');
  expect(group).toContain('└ Check the cancel path');
  expect(group).not.toContain('Sent again alone');
  expect((await heldDrawing($, 'held_c', alone, third)).lines).toContain(
    'DeepSeek(Sent again alone)',
  );
  release();
  await running;
  await f.clock.settle();
});

// Live on alpha.70: two held Explore calls were accepted together, and the line stayed as a
// row of its own between Claude Code's `2 Explore agents finished` and the DeepSeek group.
test('the held notice of a parallel Agent summary is dropped by an accept and written for any other answer', async ($, on) => {
  const f = setup($, on);
  const notices: string[] = [];
  on('ui.log', (_$, e) => {
    notices.push(e.text);
    return { value: undefined };
  });
  on('classic.PostToolBatch', () => ({}));
  const batch = (...ids: string[]) =>
    $.classic.PostToolBatch({
      tool_calls: ids.map((id) => ({
        tool_name: 'Agent',
        tool_input: INPUT,
        tool_use_id: id,
      })),
    });
  const hold = async (first: string, second: string) => {
    f.state.offer = OFFER;
    await remember($, { ...INPUT, tool_use_id: first });
    f.state.offer = SECOND_OFFER;
    await remember($, { ...INPUT, tool_use_id: second });
    f.state.offer = OFFER;
    await batch(first, second);
  };
  const HELD = 'Held 2 of 2 Agent calls before native execution.';
  // Accepted together: the DeepSeek group is the batch's display, and no line is written,
  // then or when the turn ends.
  await hold('held_a', 'held_b');
  expect(notices).toEqual([]);
  await $.tool.call({ tool: ACCEPT, offer_ids: [OFFER, SECOND_OFFER] });
  await $.turn.complete({
    reason: 'answer',
    turnId: 'parent-turn',
    isAborted: false,
    answer: '',
    durationMs: 1,
  } as never);
  expect(notices).toEqual([]);
  // Live on alpha.73: auto mode refused one call of the response, the parent sent it again
  // (held again, with a new offer), then accepted both offers: no line.
  await remember($, { ...INPUT, tool_use_id: 'held_r1' });
  await batch('held_r1', 'refused_r2');
  f.state.offer = THIRD_OFFER;
  await remember($, { ...INPUT, tool_use_id: 'repeat_r2' });
  f.state.offer = OFFER;
  expect(notices).toEqual([]);
  await $.tool.call({ tool: ACCEPT, offer_ids: [OFFER, THIRD_OFFER] });
  await $.turn.complete({
    reason: 'answer',
    turnId: 'parent-turn',
    isAborted: false,
    answer: '',
    durationMs: 1,
  } as never);
  expect(notices).toEqual([]);
  // A subagent's turn that ends while the pair waits, such as an earlier worker's viewer,
  // and a subagent's own accept, are not the parent's answer: the pair is then accepted.
  await hold('held_s', 'held_t');
  await complete($, 'earlier-viewer', 'answer');
  await $.tool.call({ tool: ACCEPT, cancel: THIRD_OFFER, agentId: 'a-subagent' });
  expect(notices).toEqual([]);
  await $.tool.call({ tool: ACCEPT, offer_ids: [OFFER, SECOND_OFFER] });
  expect(notices).toEqual([]);
  // Kept native: the line is written before the repeated call runs.
  await hold('held_c', 'held_d');
  f.state.keepNative = true;
  await remember($, { ...INPUT, tool_use_id: 'native_c' });
  expect(notices).toEqual([HELD]);
  f.state.keepNative = false;
  // Cancelled: the line is written.
  await hold('held_e', 'held_f');
  await $.tool.call({ tool: ACCEPT, cancel: OFFER });
  expect(notices).toEqual([HELD, HELD]);
  // Neither: the line is written when the turn ends.
  await hold('held_g', 'held_h');
  expect(notices).toEqual([HELD, HELD]);
  await $.turn.complete({
    reason: 'answer',
    turnId: 'parent-turn',
    isAborted: false,
    answer: '',
    durationMs: 1,
  } as never);
  expect(notices).toEqual([HELD, HELD, HELD]);
});

test('the held notice counts only held Agent calls in the batch', async ($, on) => {
  const f = setup($, on);
  const notices: string[] = [];
  on('ui.log', (_$, e) => {
    notices.push(e.text);
    return { value: undefined };
  });
  on('classic.PostToolBatch', () => ({}));
  const batch = (...ids: string[]) =>
    $.classic.PostToolBatch({
      tool_calls: ids.map((id) => ({
        tool_name: 'Agent',
        tool_input: INPUT,
        tool_use_id: id,
      })),
    });
  // Each line is written when a later Agent call runs natively: the offers were not accepted.
  const native = async (id: string) => {
    f.state.keepNative = true;
    await remember($, { ...INPUT, tool_use_id: id });
    f.state.keepNative = false;
  };
  await remember($, { ...INPUT, tool_use_id: 'held_a' });
  await remember($, { ...INPUT, tool_use_id: 'held_b' });
  await batch('held_a', 'held_b');
  await native('native_0');
  expect(notices).toEqual(['Held 2 of 2 Agent calls before native execution.']);

  await remember($, { ...INPUT, tool_use_id: 'held_c' });
  await native('native_a');
  await batch('held_c', 'native_a');
  await batch('native_a', 'native_b');
  await remember($, { ...INPUT, tool_use_id: 'held_d' });
  await batch('held_d');
  await batch('held_d', 'native_a');
  await native('native_e');
  expect(notices).toEqual([
    'Held 2 of 2 Agent calls before native execution.',
    'Held 1 of 2 Agent calls before native execution.',
  ]);
});
