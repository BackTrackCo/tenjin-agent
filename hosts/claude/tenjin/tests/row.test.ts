import { expect, test, type TestBody } from 'claude-code/testing';

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

/** The engine's own ToolUse drawing beneath the plugin: what it was handed. */
function engineRows(on: Parameters<TestBody>[1]): { seen: unknown[] } {
  const seen: unknown[] = [];
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    seen.push(e.props);
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine row'] });
  });
  return { seen };
}

/** The engine delivering a run expanded, as ctrl+o and --verbose do. */
async function expandRun($: Parameters<TestBody>[0], calls: unknown[]): Promise<void> {
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolGroup',
    props: { calls: calls as never, isActive: false, isExpanded: true },
  });
  await ui.unmount();
}

/** A lookup alone, as the engine folds one MCP call into a group of one. */
const groupOf = (calls: unknown[]) => ({
  calls: calls as never,
  isActive: true,
  isExpanded: false,
});

test('a lookup alone: Calling with its query while it runs, then the dim folded line', async ($, on) => {
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['rows'] });
  });
  const engine = engineRows(on);
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
    // ENDED, AS A STANDALONE ROW: once a one-call run ends the engine may draw
    // the call as its own row. It keeps the folded line, never the bare row.
    const alone = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: ended,
    });
    expect(await rowText(alone)).toBe('Called Exa search · $0.04 (ctrl+o to expand)');
    expect(await dotOf(alone)).toBeUndefined();
    await alone.unmount();
    // EXPANDED BY THE ENGINE (ctrl+o, --verbose): the engine's own native row,
    // input and result, handed exactly what it would draw for any MCP call.
    await expandRun($, [ended]);
    const open = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: ended,
    });
    expect(await shownLines(open)).toEqual(['engine row']);
    expect(engine.seen.at(-1)).toMatchObject({ input: ended.input, output: PAID });
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
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['rows'] });
  });
  engineRows(on);
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
    await expandRun($, [row]);
    const open = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props: row });
    // Expanded, the engine's own row carries the reason the model read.
    expect(await shownLines(open)).toEqual(['engine row']);
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

test("a run this mod unfolds draws the folded row; the engine-expanded run is the engine's own row", async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, EXA);
  engineRows(on);
  on('tool.call', { tool: TOOL }, async () => ({ result: PAID, text: PAID }));
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [e.props.isExpanded ? 'rows' : 'engine count line'] });
  });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_paid', id: OFFER, input: INPUT });
  const read = toolRow('r1', 'Read', { file_path: '/a' }, 'ok');
  const lookup = toolRow('toolu_paid', TOOL, { id: OFFER, input: INPUT }, PAID);
  const paidRow = async () => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolUse',
      props: lookup,
    });
    const lines = await shownLines(ui);
    await ui.unmount();
    return lines;
  };
  const group = async (isExpanded: boolean) => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolGroup',
      props: { calls: [read, lookup] as never, isActive: false, isExpanded },
    });
    await ui.unmount();
  };
  await group(false);
  expect(await paidRow()).toEqual(['Called Exa search · $0.04 (ctrl+o to expand)']);
  // ctrl+o after the fact: the engine delivers the same run expanded.
  await group(true);
  expect(await paidRow()).toEqual(['engine row']);
});

test("a job poll draws nothing: it repeats the starting call's result and cost", async ($, on) => {
  machine(on);
  const done = envelope('fulfilled', { label: 'Exa search', cost: ['provider price 0.42 USD'] });
  on('tool.call', { tool: TOOL }, async () => ({ result: done, text: done }));
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_poll', job: OFFER });
  const poll = toolRow('toolu_poll', TOOL, { job: OFFER }, done);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props: poll });
    expect(await shownLines(ui)).toEqual([]);
    await ui.unmount();
  }
});

test('an empty job is not a poll: the paid call draws its row', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, EXA);
  on('tool.call', { tool: TOOL }, async () => ({ result: PAID, text: PAID }));
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_empty', id: OFFER, input: INPUT, job: '' });
  const ended = toolRow('toolu_empty', TOOL, { id: OFFER, input: INPUT, job: '' }, PAID);
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolGroup',
    props: groupOf([ended]),
  });
  expect(await rowText(ui)).toBe('Called Exa search · $0.04 (ctrl+o to expand)');
  await ui.unmount();
});

test('a paid lookup with no label still draws: the provider names it, else the engine row stays', async ($, on) => {
  const { files } = machine(on);
  // A Bazaar spec: no label, the provider's own name.
  await keepSpec(files, OFFER, { provider: 'Exa', priceAtomic: '40000' });
  const bare = (rest: Record<string, unknown>) =>
    `summary${JSON.stringify({ status: 'fulfilled', cost: ['provider price 0.04 USD'], ...rest })}`;
  const noLabel = bare({ supplier: 'api.exa.ai' });
  const nothing = bare({});
  on('tool.call', { tool: TOOL }, async (_$, e) => {
    const text = e.tool_use_id === 'toolu_bazaar' ? noLabel : nothing;
    return { result: text, text };
  });
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine row'] });
  });
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine result'] });
  });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_bazaar', id: OFFER, input: INPUT });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_unnamed', query: 'something' });
  const mount = (component: 'ToolGroup' | 'ToolUse' | 'ToolResult', props: unknown) =>
    $.ui.mount({ plugin: 'tenjin', surface: 'terminal', component, props: props as never });
  const bazaar = toolRow('toolu_bazaar', TOOL, { id: OFFER, input: INPUT }, noLabel);
  const named = await mount('ToolGroup', groupOf([bazaar]));
  expect(await rowText(named)).toBe('Called Exa · $0.04 (ctrl+o to expand)');
  await named.unmount();
  // Nothing names it: the engine's own row and result, never hidden.
  const unnamed = toolRow('toolu_unnamed', TOOL, { query: 'something' }, nothing);
  const own = await mount('ToolUse', unnamed);
  expect(await shownLines(own)).toEqual(['engine row']);
  await own.unmount();
  const result = await mount('ToolResult', {
    tool_use_id: 'toolu_unnamed',
    tool: TOOL,
    output: nothing,
    isErrored: false,
  });
  expect(await shownLines(result)).toEqual(['engine result']);
  await result.unmount();
});

test('a standalone finished lookup that was never in a run shows no ctrl+o hint', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, EXA);
  on('tool.call', { tool: TOOL }, async () => ({ result: PAID, text: PAID }));
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_alone', id: OFFER, input: INPUT });
  // As the fullscreen transcript draws it: a ToolUse row, no run around it.
  const alone = toolRow('toolu_alone', TOOL, { id: OFFER, input: INPUT }, PAID);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props: alone });
    expect(await rowText(ui)).toBe('Called Exa search · $0.04');
    await ui.unmount();
  }
  // Drawn in its one-call run, it carries the hint there and after.
  const run = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolGroup',
    props: groupOf([alone]),
  });
  expect(await rowText(run)).toBe('Called Exa search · $0.04 (ctrl+o to expand)');
  await run.unmount();
  const after = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: alone,
  });
  expect(await rowText(after)).toBe('Called Exa search · $0.04 (ctrl+o to expand)');
  await after.unmount();
});

test('a long service name is shortened, never dropped: the model in a trailing group, else an ellipsis', async ($, on) => {
  const { files } = machine(on);
  const cases = [
    [
      'b920ff14-0000-4a50-8c25-240e871602f1',
      'Gondola (OpenAI GPT Image 2.5 Sunburst)',
      'OpenAI GPT Image 2.5 Sunburst',
    ],
    [
      'b920ff14-0000-4a50-8c25-240e871602f2',
      'A very long reseller name with no model at all',
      'A very long reseller name with…',
    ],
    ['b920ff14-0000-4a50-8c25-240e871602f3', 'Exa', 'Exa'],
  ] as const;
  const paid = `summary${JSON.stringify({
    status: 'fulfilled',
    supplier: 'api.gondola-ai.com',
    cost: ['provider price 0.030701 USD'],
  })}`;
  on('tool.call', { tool: TOOL }, async () => ({ result: paid, text: paid }));
  for (const [id, provider, shown] of cases) {
    // A discovered service's spec: no label, only its provider's name.
    await keepSpec(files, id, { provider, priceAtomic: '30701' }, null);
    await $.tool.call({
      tool: TOOL,
      tool_use_id: `toolu_${id}`,
      id,
      input: { prompt: 'a banner' },
    });
    const row = toolRow(`toolu_${id}`, TOOL, { id, input: { prompt: 'a banner' } }, paid);
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolGroup',
      props: groupOf([row]),
    });
    expect(await rowText(ui)).toBe(`Called ${shown} · $0.030701 (ctrl+o to expand)`);
    await ui.unmount();
  }
});
