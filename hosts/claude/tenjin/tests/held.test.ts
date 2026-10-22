import type { On } from 'claude-code';
import { expect, test } from 'claude-code/testing';

import {
  OFFER,
  SESSION,
  SURFACES,
  TOOL,
  dotOf,
  envelope,
  keepOffer,
  keepSpec,
  machine,
  rowText,
  shownLines,
  toolRow,
} from './fixtures';

const SEARCH = { query: 'rust async runtimes', mode: 'standard' as const };
/** The reason the model read on the deny: never drawn. */
const REASON = 'Tenjin router (installed by the user): Exa search, $0.007: call request.';
const PAID = envelope('fulfilled', {
  label: 'Exa search',
  cost: ['provider price 0.007 USD'],
  result: '{"answer":"Tokio"}',
  fullResultPath: '/home/test/.tenjin/downloads/exa.json',
});
const INPUT = { id: OFFER, input: { query: 'rust async runtimes' } };

/** A WebSearch the pre-call hook holds: it writes the offer record, then denies. */
function holding(on: On, files: Map<string, string>) {
  on('tool.call', { tool: 'WebSearch' }, async (_$, e) => {
    if (e.tool_use_id === 'toolu_held') await keepOffer(files, SESSION, e.tool_use_id);
    return e.tool_use_id === 'toolu_held' ? { deny: REASON } : { result: { results: [] } as never };
  });
}

const heldRow = (output = REASON) => ({
  ...toolRow('toolu_held', 'WebSearch', SEARCH, output),
  isErrored: true,
});

test('a held search is struck with the offer named, then replaced in place by the lookup', async ($, on) => {
  const { files, clock } = machine(on);
  await keepSpec(files, OFFER, { label: 'Exa search', priceAtomic: '7000' });
  holding(on, files);
  let release = (): void => undefined;
  const paying = new Promise<void>((resolve) => {
    release = resolve;
  });
  on('tool.call', { tool: TOOL }, async () => {
    await paying;
    return { result: PAID, text: PAID };
  });
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_held', ...SEARCH });
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: heldRow(),
    });
    expect(await rowText(ui)).toBe(
      '⏺ Web Search("rust async runtimes") · Tenjin offered Exa search',
    );
    const [name] = await ui.findAll({ type: 'Text', text: 'Web Search' });
    expect(name?.props.strikethrough).toBe(true);
    await ui.unmount();
    const result = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'toolu_held', tool: 'WebSearch', output: REASON, isErrored: true },
    });
    expect(await shownLines(result)).toEqual([]);
    await result.unmount();
  }
  const running = $.tool.call({ tool: TOOL, tool_use_id: 'toolu_take', ...INPUT });
  await clock.settle();
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: heldRow(),
    });
    expect(await rowText(ui)).toBe('⏺ Exa search("rust async runtimes") · $0.007');
    expect(await dotOf(ui)).toEqual({ color: undefined, dimColor: true });
    await ui.unmount();
    // The request's own row is empty: the held row draws it.
    const own = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_take', TOOL, INPUT),
    });
    expect(await shownLines(own)).toEqual([]);
    await own.unmount();
  }
  release();
  await running;
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: heldRow(),
    });
    // Standalone and ended, it carries what came back, as a lookup row does.
    expect(await rowText(ui)).toBe('⏺ Exa search("rust async runtimes") · $0.007');
    expect(await dotOf(ui)).toEqual({ color: 'success', dimColor: undefined });
    await ui.unmount();
    const own = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_take', TOOL, INPUT, PAID),
    });
    expect(await shownLines(own)).toEqual([]);
    await own.unmount();
  }
});

test('a take that came back needs_input lets the hold go, for the retry to take', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, { label: 'Exa search', priceAtomic: '7000' });
  holding(on, files);
  const needsInput = envelope('needs_input', {
    reason: 'query is required',
    cost: ['provider price 0 USD'],
  });
  on('tool.call', { tool: TOOL }, async (_$, e) =>
    e.tool_use_id === 'toolu_first'
      ? { result: needsInput, text: needsInput }
      : { result: PAID, text: PAID },
  );
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_held', ...SEARCH });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_first', ...INPUT });
  const struck = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: heldRow(),
  });
  expect(await rowText(struck)).toBe(
    '⏺ Web Search("rust async runtimes") · Tenjin offered Exa search',
  );
  await struck.unmount();
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_retry', ...INPUT });
  const taken = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: heldRow(),
  });
  expect(await rowText(taken)).toBe('⏺ Exa search("rust async runtimes") · $0.007');
  await taken.unmount();
});

test('a held search the model then ran natively gives way to the engine row', async ($, on) => {
  const { files } = machine(on);
  holding(on, files);
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_held', ...SEARCH });
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_native', ...SEARCH });
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: heldRow(),
  });
  expect(await shownLines(ui)).toEqual([]);
  await ui.unmount();
});

test('a form A row in a run this mod unfolded draws nothing beneath', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, { label: 'Exa search', priceAtomic: '7000' });
  holding(on, files);
  on('tool.call', { tool: TOOL }, async () => ({ result: PAID, text: PAID }));
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [e.props.isExpanded ? 'rows' : 'engine count line'] });
  });
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_held', ...SEARCH });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_take', ...INPUT });
  const run = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      calls: [heldRow(), toolRow('toolu_take', TOOL, INPUT, PAID)] as never,
      isActive: false,
      isExpanded: false,
    },
  });
  expect(await shownLines(run)).toEqual(['rows']);
  await run.unmount();
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: heldRow(),
  });
  expect(await rowText(ui)).toBe('⏺ Exa search("rust async runtimes") · $0.007');
  await ui.unmount();
});

test('a paid replacement stays when the model then runs the same search natively', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, { label: 'Exa search', priceAtomic: '7000' });
  holding(on, files);
  on('tool.call', { tool: TOOL }, async () => ({ result: PAID, text: PAID }));
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_held', ...SEARCH });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_take', ...INPUT });
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_native', ...SEARCH });
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: heldRow(),
  });
  expect(await rowText(ui)).toBe('⏺ Exa search("rust async runtimes") · $0.007');
  await ui.unmount();
});

test("expanded by the engine, the lookup that replaced a held search is the engine's own row", async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, { label: 'Exa search', priceAtomic: '7000' });
  holding(on, files);
  on('tool.call', { tool: TOOL }, async () => ({ result: PAID, text: PAID }));
  const seen: unknown[] = [];
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    seen.push(e.props);
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine row'] });
  });
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['rows'] });
  });
  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_held', ...SEARCH });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_take', ...INPUT });
  const take = toolRow('toolu_take', TOOL, INPUT, PAID);
  const mount = (component: 'ToolGroup' | 'ToolUse', props: unknown) =>
    $.ui.mount({ plugin: 'tenjin', surface: 'terminal', component, props: props as never });
  // Folded: the request's own row stays empty; the held row is the line.
  const own = await mount('ToolUse', take);
  expect(await shownLines(own)).toEqual([]);
  await own.unmount();
  // ctrl+o: the engine expands the run, and draws the request with its result.
  const run = await mount('ToolGroup', {
    calls: [heldRow(), take],
    isActive: false,
    isExpanded: true,
  });
  await run.unmount();
  const open = await mount('ToolUse', take);
  expect(await shownLines(open)).toEqual(['engine row']);
  expect(seen.at(-1)).toMatchObject({ input: INPUT, output: PAID });
  await open.unmount();
  const held = await mount('ToolUse', heldRow());
  expect(await rowText(held)).toBe('⏺ Exa search("rust async runtimes") · $0.007');
  await held.unmount();
});
