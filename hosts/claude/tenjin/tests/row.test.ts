import { expect, test } from 'claude-code/testing';

import {
  MODEL_TEXT,
  OFFER,
  SURFACES,
  TOOL,
  dotOf,
  envelope,
  keepSpec,
  machine,
  rowText,
  shownLines,
  toolRow,
} from './fixtures';

const INPUT = { query: 'rust async runtimes', numResults: 5 };
const EXA = { label: 'Exa search', priceAtomic: '40000', maxAmountAtomic: '40000' };
const PAID = envelope('fulfilled', {
  label: 'Exa search',
  cost: ['provider price 0.04 USD'],
  result: '{"answer":"Tokio","results":[{"title":"Tokio"},{"title":"smol"}]}',
  fullResultPath: '/home/test/.tenjin/downloads/exa.json',
});

/** A lookup alone, as the engine folds one MCP call into a group of one. */
const groupOf = (calls: unknown[]) => ({
  calls: calls as never,
  isActive: true,
  isExpanded: false,
});

test('a lookup alone: Calling with its query while it runs, then the dim folded line', async ($, on) => {
  const { files, clock } = machine(on);
  await keepSpec(files, OFFER, EXA);
  let release = (): void => undefined;
  const paying = new Promise<void>((resolve) => {
    release = resolve;
  });
  on('tool.call', { tool: TOOL }, async () => {
    await paying;
    return { result: PAID, text: PAID };
  });
  const call = toolRow('toolu_paid', TOOL, { id: OFFER, input: INPUT });
  for (const surface of SURFACES) {
    // Before its tool.call starts the label is not known: nothing is drawn.
    const before = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: groupOf([call]),
    });
    expect(await shownLines(before)).toEqual([]);
    await before.unmount();
  }
  const running = $.tool.call({ tool: TOOL, tool_use_id: 'toolu_paid', id: OFFER, input: INPUT });
  await clock.settle();
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: groupOf([call]),
    });
    expect(await rowText(ui)).toBe('⏺ Calling Exa search… · $0.04  ⎿  "rust async runtimes"');
    expect(await dotOf(ui)).toEqual({ color: undefined, dimColor: true });
    await ui.unmount();
  }
  release();
  await running;
  const ended = toolRow('toolu_paid', TOOL, { id: OFFER, input: INPUT }, PAID);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: groupOf([ended]),
    });
    expect(await rowText(ui)).toBe('Called Exa search · $0.04 (ctrl+o to expand)');
    expect(await dotOf(ui)).toBeUndefined();
    expect((await shownLines(ui)).join('')).not.toMatch(MODEL_TEXT);
    await ui.unmount();
    // Expanded (ctrl+o): the whole row, what came back under it.
    const open = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: ended,
    });
    expect(await shownLines(open)).toEqual([
      '⏺',
      'Exa search',
      '(rust async runtimes)',
      ' · $0.04',
      '  ⎿  ',
      'answer: Tokio',
      '     ',
      'results: 2 items',
      '     ',
      '  Tokio',
      '     ',
      '  smol',
    ]);
    expect(await dotOf(open)).toEqual({ color: 'success', dimColor: undefined });
    await open.unmount();
  }
});

test('three takes show what the three paid, and the count of them while running', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, { label: 'Ideogram V4', priceAtomic: '30000' }, null);
  const result = envelope('fulfilled', {
    results: [1, 2, 3].map((take) => ({
      take,
      status: 'fulfilled',
      cost: ['provider price 0.03 USD'],
    })),
    cost: ['provider price 0.09 USD'],
  });
  let seen: string[] = [];
  on('tool.call', { tool: TOOL }, async () => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolUse',
      props: toolRow('toolu_takes', TOOL, { id: OFFER, input: { prompt: 'a banner' }, count: 3 }),
    });
    seen = await shownLines(ui);
    await ui.unmount();
    return { result, text: result };
  });
  await $.tool.call({
    tool: TOOL,
    tool_use_id: 'toolu_takes',
    id: OFFER,
    input: { prompt: 'a banner' },
    count: 3,
  });
  expect(seen.join('')).toBe('⏺Calling Ideogram V4… · $0.09');
  const ended = toolRow('toolu_takes', TOOL, { id: OFFER, input: {}, count: 3 }, result);
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolGroup',
    props: groupOf([ended]),
  });
  expect(await rowText(ui)).toBe('Called Ideogram V4 · $0.09 (ctrl+o to expand)');
  await ui.unmount();
});

test('a charged failure draws the error dot, the amount and the state, never a success', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, EXA);
  const failed = envelope('failed', {
    reason: 'The provider answered 500 after the payment was sent.',
    cost: ['provider price 0.04 USD'],
  });
  on('tool.call', { tool: TOOL }, async () => ({ result: failed, text: failed }));
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_failed', id: OFFER, input: INPUT });
  const row = toolRow('toolu_failed', TOOL, { id: OFFER, input: INPUT }, failed);
  for (const surface of SURFACES) {
    const folded = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: groupOf([row]),
    });
    expect(await rowText(folded)).toBe('⏺ Exa search(rust async runtimes) · $0.04 · failed');
    expect(await dotOf(folded)).toEqual({ color: 'error', dimColor: undefined });
    await folded.unmount();
    const open = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props: row });
    expect((await shownLines(open)).slice(-1)).toEqual([
      'The provider answered 500 after the payment was sent.',
    ]);
    await open.unmount();
  }
});

test("draws nothing for a needs_input answer, a free call, or the router's own calls", async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, EXA);
  const needsInput = envelope('needs_input', {
    reason: 'numResults is required',
    cost: ['provider price 0 USD'],
  });
  const free = envelope('fulfilled', { label: 'Context7 docs', cost: ['provider price 0 USD'] });
  const spec = envelope('spec', { cost: ['provider price 0 USD'] });
  on('tool.call', { tool: TOOL }, async (_$, e) => {
    const text =
      e.tool_use_id === 'toolu_input' ? needsInput : e.tool_use_id === 'toolu_free' ? free : spec;
    return { result: text, text };
  });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_input', id: OFFER, input: INPUT });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_free', query: 'react docs' });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_spec', id: OFFER });
  const rows = [
    toolRow('toolu_input', TOOL, { id: OFFER, input: INPUT }, needsInput),
    toolRow('toolu_free', TOOL, { query: 'react docs' }, free),
    toolRow('toolu_spec', TOOL, { id: OFFER }, spec),
  ];
  for (const surface of SURFACES) {
    for (const props of rows) {
      const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props });
      expect(await shownLines(ui)).toEqual([]);
      await ui.unmount();
    }
    const group = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: groupOf(rows),
    });
    expect(await shownLines(group)).toEqual([]);
    await group.unmount();
  }
});

test('a run mixing a lookup with other calls unfolds for the engine to draw', async ($, on) => {
  machine(on);
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [e.props.isExpanded ? 'rows' : 'engine count line'] });
  });
  const read = toolRow('r1', 'Read', { file_path: '/a' }, 'ok');
  const lookup = toolRow('toolu_paid', TOOL, { id: OFFER, input: INPUT }, PAID);
  for (const surface of SURFACES) {
    const mixed = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: groupOf([read, lookup]),
    });
    expect(await shownLines(mixed)).toEqual(['rows']);
    await mixed.unmount();
    const plain = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: groupOf([read]),
    });
    expect(await shownLines(plain)).toEqual(['engine count line']);
    await plain.unmount();
  }
});
