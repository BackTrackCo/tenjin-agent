import type { AgentInfo, On, ToolCallResult, TurnStepChunk, TurnStepResult } from 'claude-code';
import { expect, mock, test, type TestBody } from 'claude-code/testing';
import { raisedByThisPlugin } from '../hooks/model-viewer';
import type { TenjinModelViewerState } from '../types';
import { DATA, NOW, OFFER, SESSION, SURFACES, sha256Hex, shownLines, toolRow } from './fixtures';

const ACCEPT = 'mcp__plugin_tenjin_router__subagent';
const TYPE = 'tenjin:deepseek-viewer';
const SECOND_OFFER = 'b446d2eb-1bf8-4cf0-aa19-bc5df4aa668f';
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
    /** Set: the CLI's answer to a held call, in place of an offer. */
    captureAnswer: undefined as string | undefined,
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
      if (state.captureAnswer) return { result: state.captureAnswer, text: state.captureAnswer };
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

test('mixed accept operations pass through without spawning an observer', async ($, on) => {
  const f = setup($, on);
  let work = 0;
  f.state.work = () => {
    work++;
    return { result: 'original operation' };
  };
  await remember($);
  for (const operation of [{ cancel: OFFER }, { task: 'capture' }])
    expect((await $.tool.call({ tool: ACCEPT, offer_id: OFFER, ...operation })).result).toBe(
      'original operation',
    );
  expect(work).toBe(2);
  expect(f.state.calls).toBe(0);
});

// The CLI's `endedBy` codes, each in a native-sounding word.
// A stop with a known cause reads `stopped`, the CLI's word since a failed model call
// read `unknown` (live case).
for (const [endedBy, word, status] of [
  ['agent_stopped', 'Stopped by you', 'cancelled'],
  ['parent_cancel', 'Cancelled by the parent', 'cancelled'],
  ['host_aborted', 'Interrupted', 'cancelled'],
  ['session_ended', 'Session ended', 'cancelled'],
  ['budget', 'Budget reached', 'stopped'],
  ['model_call_failed', 'Model call failed', 'stopped'],
  ['model_call_timeout', 'Model call timed out', 'stopped'],
  ['payment_refused', 'Payment refused', 'stopped'],
  ['provider', 'DeepSeek unavailable', 'stopped'],
  ['refused', 'DeepSeek refused', 'stopped'],
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

// An image or document the text-only route could not send is a fact the parent needs on
// the end line, with the counts it already reads.
test('a worker that did not see image or document content says how many on its row', async ($, on) => {
  const f = setup($, on);
  const answer = JSON.stringify({
    status: 'completed',
    elapsedMs: 61_000,
    toolUses: 3,
    tokens: 900,
    omitted: { blocks: 2, note: 'The worker did not see 2 image or document blocks.' },
  });
  const line =
    '⏺DeepSeek(subagent)  ⎿  Done (3 tool uses · 900 tokens · 1m 1s · 2 image or document blocks omitted)';
  expect((await acceptRow($, 'parent_accept', OFFER, answer))[0]).toBe(line);
  f.state.liveView = false;
  f.state.liveFile = false;
  // What the CLI sends for an ended job (`endedDisplay`): the counts and the blocks, never the
  // whole handback.
  f.state.ended = {
    status: 'completed',
    elapsedMs: 61_000,
    toolUses: 3,
    tokens: 900,
    omitted: { blocks: 2 },
  };
  await acceptRow($, 'accept_after_resume', OFFER, MOVED);
  await f.clock.settle();
  expect((await acceptRow($, 'accept_after_resume', OFFER, MOVED))[0]).toBe(line);
});

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
    // A cancel draws nothing of its own either, so its run unfolds too.
    [[toolRow('parent_cancel', ACCEPT, { cancel: OFFER })], true],
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

// The operator: a native subagent's transcript shows a result line under each call and the
// worker's text between calls, and no plugin-drawn spinner. Each step is one worker reply.
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

// P: the agent list showed `tenjin:deepseek-viewer` and `DeepSeek #1 · …`. Its entry is
// the task's description, ` (2)` on a second of the same, and its row reads `DeepSeek`.
// Greptile thread on register.tsx (item X): a native subagent's accept passed this hook
// untouched, so its worker ran with no row, no agent-list entry and no viewer to stop it.
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
    { task: 'do it' },
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
test("a held Agent row drawn after a resume ends from the accept call's own answer, and a repeated accept never replaces it", async ($, on) => {
  setup($, on);
  // As the transcript keeps a held call: the refusal's text, which names the offer.
  const held =
    'Error: Tenjin offered DeepSeek for this call and held it (offer ' +
    OFFER +
    '). It has not run.\n' +
    JSON.stringify({ action: 'offer', offer_id: OFFER });
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

// Failure caught: a foreground accept the host ended after its idle limit (the job has no
// wall time) lost the worker's result, though the worker went on and kept it with the job.
// Failure caught (live, two workers accepted together): one finished at 191 s, the other hung
// until the host ended the call, and the finished worker's report never reached the parent
// until its offer was accepted again by hand.
// Failure caught (vraspar): a worker of a batch that ended `not_started` before the host gave
// up on the call was never handed over, because the row's end was matched against a list that
// left out `not_started`.
// Operator ruling 2026-11-18: "background calls should get an offer". An Agent call with
// `run_in_background` was never offered; now its worker runs in the background, the accept
// answers at once, and the result reaches the parent when the worker ends.
// Live on alpha.80 (019f0a42): two Explore calls of one response, one of them a background
// call, accepted in one batch. Only the background worker had a DeepSeek row. The first
// call had drawn as a row of its own for a moment before the second joined it in Claude
// Code's summary block, and so counted as drawn in place.
// Live on alpha.80: under the worker's `Cancelled by the parent` row stood the host's own
// `plugin:tenjin:router - DeepSeek subagent (MCP)(cancel: "…")` with `{"status":"cancelled"}`.
test('a cancel draws nothing of its own: not its call, not its answer, not its id as it streams', async ($, on) => {
  setup($, on);
  on('ui.render', { component: 'ToolUse' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['engine row'] }),
  );
  on('ui.render', { component: 'ToolResult' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['engine result'] }),
  );
  on('ui.render', { component: 'ToolGroup' }, ($, e) =>
    $.ui.resolve(e).Text({ children: [e.props.isExpanded ? 'rows' : 'count line'] }),
  );
  const drawn = async (component: 'ToolUse' | 'ToolResult', props: Record<string, unknown>) => {
    const ui = await $.ui.mount({ plugin: 'tenjin', surface: 'terminal', component, props });
    const lines = await shownLines(ui);
    await ui.unmount();
    return lines;
  };
  const cancelled = '{"status":"cancelled"}';
  const cancel = (input: unknown, output?: string) => toolRow('a_cancel', ACCEPT, input, output);
  // As its id streams, while it runs, and once it took: nothing.
  expect(await drawn('ToolUse', cancel({ cancel: OFFER.slice(0, 9) }))).toEqual([]);
  expect(await drawn('ToolUse', cancel({ cancel: OFFER }))).toEqual([]);
  expect(await drawn('ToolUse', cancel({ cancel: OFFER }, cancelled))).toEqual([]);
  expect(
    await drawn('ToolResult', {
      tool_use_id: 'a_cancel',
      tool: ACCEPT,
      output: cancelled,
      isErrored: false,
    }),
  ).toEqual([]);
  // A folded run that holds it unfolds, so no count line names the server.
  const group = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [{ ...cancel({ cancel: OFFER }, cancelled), isRunning: false }],
      isActive: false,
      isExpanded: false,
      isCallsOnly: true,
    },
  });
  expect(await shownLines(group)).toEqual(['rows']);
  await group.unmount();
  // A cancel that did not take keeps the host's row and answer.
  const refused = '{"status":"not_owned"}';
  expect(await drawn('ToolUse', cancel({ cancel: OFFER }, refused))).toEqual(['engine row']);
  expect(
    await drawn('ToolResult', {
      tool_use_id: 'a_cancel',
      tool: ACCEPT,
      output: refused,
      isErrored: false,
    }),
  ).toEqual(['engine result']);
  expect(
    await drawn('ToolUse', { ...cancel({ cancel: OFFER }, 'cut'), isInterrupted: true }),
  ).toEqual(['engine row']);
});

// Review of b7974566: a background worker is tied to the Tenjin process alone, which the
// host may keep across `/clear`, so it ran on and spent for a session that could no longer
// be handed its result.
test("the session's end leaves a foreground worker and a delivered background result alone", async ($, on) => {
  const f = setup($, on);
  on('prompt.submit', (_$, e) => ({ text: e.text }));
  on('session.end', () => ({ sessionId: SESSION }));
  // A foreground worker, still running: it ends with its accept call, as before.
  let release: () => void = () => undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await remember($);
  f.state.work = async () => {
    await blocked;
    return { result: 'handback' };
  };
  const running = $.tool.call({ tool: ACCEPT, offer_id: OFFER, tool_use_id: 'fg_accept' });
  await f.clock.settle();
  await $.session.end({ reason: 'clear' });
  expect(f.state.cancellations).toEqual([{ end_session: SESSION }]);
  // The model cannot say a session closed: that word is the host's, relayed by the plugin.
  expect((await $.tool.call({ tool: ACCEPT, end_session: SESSION })).deny).toContain(
    'when the session closes',
  );
  release();
  await running;
  await f.clock.settle();
});

// Greptile on 7c1d9550: a batch call holds until its foreground workers end, so a background
// worker of the batch that ended first was stopped with nothing sent, and the batch's late
// `started` answer for it sent nothing either.
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
// Live on alpha.70: two held Explore calls were accepted together, and the line stayed as a
// row of its own between Claude Code's `2 Explore agents finished` and the DeepSeek group.
// Live on alpha.83: of two held calls of one response, one was accepted and one sent again
// and run natively, and the transcript read "tenjin: Held 2 of 2 Agent calls before native
// execution." under the DeepSeek row. Operator ruling 2026-11-18: the line should not be
// there. Claude Code's block reads `Not run` for a held call, and the DeepSeek row or the
// native Agent row says what became of it.
