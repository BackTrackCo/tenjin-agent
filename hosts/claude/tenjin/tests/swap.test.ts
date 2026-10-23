import type { On } from 'claude-code';
import { expect, test } from 'claude-code/testing';

import {
  DATA,
  MODEL_TEXT,
  OFFER,
  SESSION,
  SURFACES,
  TOOL,
  dotOf,
  envelope,
  machine,
  sha256Hex,
  shownLines,
  toolRow,
} from './fixtures';

/**
 * THE SWAP, FROM THE MOD'S SIDE: with "Run Tenjin's picks automatically" on,
 * a WebSearch or WebFetch asks the request tool's `decide` form first. The
 * CLI decides, checks and runs; the mod only answers the native call with
 * what came back, or passes it on untouched. The request tool is answered
 * here by a hook beneath the mod, as the engine would run it.
 */

const SEARCH = { query: 'rust async runtimes', mode: 'standard' as const };
const FETCH = { url: 'https://example.test/spec', prompt: 'summarize' };
const RAN = envelope('fulfilled', {
  label: 'Exa search',
  cost: ['provider price 0.007 USD'],
  result: '{"answer":"Tokio"}',
  via: 'swap',
});
const FAILED = envelope('failed', {
  label: 'Exa search',
  reason: 'the provider answered 500',
  cost: ['provider price 0.007 USD'],
  via: 'swap',
});
const HANDED_BACK = envelope('native', { reason: 'automatic use is off', swap: 'handback' });

/** The global config the CLI writes, with automatic use as given. */
function switchOn(files: Map<string, string>, router: Record<string, unknown> = {}) {
  files.set(
    `${DATA}/config.json`,
    JSON.stringify({ router: { nativeReplacement: 'when-routed', ...router } }),
  );
}

/** The offer record the CLI writes when it claims the call for the swap. */
async function keepSwap(files: Map<string, string>, toolUseId: string) {
  files.set(
    `${DATA}/progress/${await sha256Hex(SESSION)}/offer-${await sha256Hex(toolUseId)}.json`,
    JSON.stringify({
      version: 1,
      at: 1,
      offerId: OFFER,
      label: 'Exa search',
      priceAtomic: '7000',
      swap: true,
    }),
  );
}

/** What the CLI leaves when it claimed the call and then handed it back
 *  (`markHandedBack`): the stamp alone, with no pick and no swap mark. */
async function keepHandedBack(files: Map<string, string>, toolUseId: string) {
  files.set(
    `${DATA}/progress/${await sha256Hex(SESSION)}/offer-${await sha256Hex(toolUseId)}.json`,
    JSON.stringify({ version: 1, at: 1 }),
  );
}

/** The request tool beneath the mod: what `decide` asked, and its answer. */
function requestTool(on: On, answer: string, onDecide?: () => Promise<void>) {
  const asked: Record<string, unknown>[] = [];
  on('tool.call', { tool: TOOL }, async (_$, e) => {
    asked.push(e as Record<string, unknown>);
    await onDecide?.();
    return { result: answer, text: answer };
  });
  return asked;
}

/** The native tool itself, beneath the mod: whether it ran. */
function nativeTool(on: On) {
  const ran: string[] = [];
  on('tool.call', { tool: ['WebSearch', 'WebFetch'] }, async (_$, e) => {
    ran.push(e.tool_use_id ?? '');
    return { result: { query: 'q', results: [], durationSeconds: 1 } as never };
  });
  return ran;
}

test('off, the default, the search runs with no decision asked', async ($, on) => {
  machine(on);
  const asked = requestTool(on, RAN);
  const ran = nativeTool(on);
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_off', ...SEARCH });
  expect(asked).toEqual([]);
  expect(ran).toEqual(['toolu_off']);
});

test('paused, in a subagent, or limited to some domains, it asks nothing either', async ($, on) => {
  const { files } = machine(on);
  const asked = requestTool(on, RAN);
  const ran = nativeTool(on);
  switchOn(files, { enabled: false });
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_paused', ...SEARCH });
  switchOn(files);
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_sub', agentId: 'a1', ...SEARCH });
  await $.tool.call({
    tool: 'WebSearch',
    tool_use_id: 'toolu_domains',
    ...SEARCH,
    allowed_domains: ['docs.rs'],
  });
  expect(asked).toEqual([]);
  expect(ran).toEqual(['toolu_paused', 'toolu_sub', 'toolu_domains']);
});

test('on, a search is answered in place with the lookup the CLI ran, and never runs natively', async ($, on) => {
  const { files } = machine(on);
  switchOn(files);
  const asked = requestTool(on, RAN, () => keepSwap(files, 'toolu_swap'));
  const ran = nativeTool(on);
  const answered = await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_swap', ...SEARCH });
  // The call the CLI got: the native call as it stood, nothing built here.
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({
    decide: {
      tool: 'WebSearch',
      input: { query: 'rust async runtimes' },
      tool_use_id: 'toolu_swap',
      session_id: SESSION,
    },
  });
  expect(asked[0]?.id).toBeUndefined();
  expect(asked[0]?.query).toBeUndefined();
  expect(ran).toEqual([]);
  // The native tool's own result shape, carrying the request tool's whole text.
  expect(answered.result).toMatchObject({ query: 'rust async runtimes', results: [RAN] });
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_swap', 'WebSearch', SEARCH, 'done'),
    });
    expect(await shownLines(ui)).toEqual([
      '⏺',
      'Exa search',
      '("rust async runtimes")',
      ' · $0.007',
      '  ⎿  ',
      'in place of Web Search',
    ]);
    expect(await dotOf(ui)).toEqual({ color: 'success', dimColor: undefined });
    for (const text of await shownLines(ui)) expect(text).not.toMatch(MODEL_TEXT);
    await ui.unmount();
  }
});

test('on, while the lookup runs, the row names the pick and its price', async ($, on) => {
  const { files, clock } = machine(on);
  switchOn(files);
  let release = (): void => undefined;
  const paying = new Promise<void>((resolve) => {
    release = resolve;
  });
  requestTool(on, RAN, async () => {
    await keepSwap(files, 'toolu_live');
    await paying;
  });
  nativeTool(on);
  const running = $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_live', ...SEARCH });
  await clock.settle();
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: toolRow('toolu_live', 'WebSearch', SEARCH),
  });
  expect(await shownLines(ui)).toEqual([
    '⏺',
    'Calling Exa search…',
    '("rust async runtimes")',
    ' · $0.007',
    '  ⎿  ',
    'in place of Web Search',
  ]);
  expect(await dotOf(ui)).toEqual({ color: undefined, dimColor: true });
  await ui.unmount();
  release();
  await running;
});

test('on, a handed-back search runs natively, as it would have', async ($, on) => {
  const { files } = machine(on);
  switchOn(files);
  const asked = requestTool(on, HANDED_BACK);
  const ran = nativeTool(on);
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine row'] });
  });
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_back', ...SEARCH });
  expect(asked).toHaveLength(1);
  expect(ran).toEqual(['toolu_back']);
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: toolRow('toolu_back', 'WebSearch', SEARCH, 'done'),
  });
  // The engine's own row: nothing of ours on it.
  expect(await shownLines(ui)).toEqual(['engine row']);
  await ui.unmount();
});

test('on, a search handed back after the CLI claimed it is the engine row and result', async ($, on) => {
  const { files } = machine(on);
  switchOn(files);
  requestTool(on, HANDED_BACK, async () => {
    await keepSwap(files, 'toolu_late');
    await keepHandedBack(files, 'toolu_late');
  });
  const ran = nativeTool(on);
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine row'] });
  });
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine result'] });
  });
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_late', ...SEARCH });
  expect(ran).toEqual(['toolu_late']);
  const row = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: toolRow('toolu_late', 'WebSearch', SEARCH, 'done'),
  });
  // Nothing says Tenjin ran, or charged, in the search's place.
  expect(await shownLines(row)).toEqual(['engine row']);
  await row.unmount();
  const result = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'toolu_late', tool: 'WebSearch', output: 'results', isErrored: false },
  });
  expect(await shownLines(result)).toEqual(['engine result']);
  await result.unmount();
});

test('on, a lookup that failed after it started is the call refused with what it cost, never a search that worked', async ($, on) => {
  const { files } = machine(on);
  switchOn(files);
  requestTool(on, FAILED, () => keepSwap(files, 'toolu_failed'));
  const ran = nativeTool(on);
  const answered = await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_failed', ...SEARCH });
  expect(ran).toEqual([]);
  expect(answered.result).toBeUndefined();
  expect(answered.isError === true || answered.deny !== undefined).toBe(true);
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: toolRow('toolu_failed', 'WebSearch', SEARCH, 'done'),
  });
  expect((await shownLines(ui)).join('')).toBe(
    '⏺Exa search("rust async runtimes") · $0.007 · failed  ⎿  in place of Web Search',
  );
  expect(await dotOf(ui)).toEqual({ color: 'error', dimColor: undefined });
  await ui.unmount();
});

test('on, a fetch is answered in place in the fetch result shape', async ($, on) => {
  const { files } = machine(on);
  switchOn(files);
  const asked = requestTool(on, RAN, () => keepSwap(files, 'toolu_fetch'));
  const ran = nativeTool(on);
  const answered = await $.tool.call({ tool: 'WebFetch', tool_use_id: 'toolu_fetch', ...FETCH });
  expect(asked[0]).toMatchObject({
    decide: { tool: 'WebFetch', input: { url: 'https://example.test/spec' } },
  });
  expect(ran).toEqual([]);
  expect(answered.result).toMatchObject({
    url: 'https://example.test/spec',
    code: 200,
    codeText: 'OK',
    result: RAN,
    bytes: new TextEncoder().encode(RAN).length,
  });
});
