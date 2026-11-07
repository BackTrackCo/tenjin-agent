import { expect, test, type TestBody } from 'claude-code/testing';

import {
  DATA,
  sha256Hex,
  MODEL_TEXT,
  OFFER,
  SURFACES,
  TOOL,
  dotOf,
  envelope,
  keepLabel,
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

test("draws nothing for a needs_input answer, a free call nobody named, or the router's own calls", async ($, on) => {
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

/**
 * A FREE LOOKUP THE CLI NAMED (its line kept the label, `storeLabel`) draws as
 * every lookup does, with `free` where the price goes: after a search's note,
 * or at the start of a turn. A bare `{query}` the router answered for free has
 * no name before it runs, and stays hidden (above).
 */
test('a free lookup the CLI named: Calling with its query, then the folded line, free', async ($, on) => {
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['rows'] });
  });
  const engine = engineRows(on);
  const { files, clock } = machine(on);
  await keepLabel(files, OFFER);
  const args = { query: 'zod v4 discriminatedUnion', id: OFFER };
  const free = envelope('fulfilled', {
    label: 'Context7 docs',
    cost: ['provider price 0 USD'],
    result: 'docs',
  });
  let release = (): void => undefined;
  const looking = new Promise<void>((resolve) => {
    release = resolve;
  });
  on('tool.call', { tool: TOOL }, async () => {
    await looking;
    return { result: free, text: free };
  });
  const running = $.tool.call({ tool: TOOL, tool_use_id: 'toolu_docs', ...args });
  await clock.settle();
  const call = toolRow('toolu_docs', TOOL, args);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: groupOf([call]),
    });
    expect(await rowText(ui)).toBe(
      '⏺ Calling Context7 docs… · free  ⎿  "zod v4 discriminatedUnion"',
    );
    expect(await dotOf(ui)).toEqual({ color: undefined, dimColor: true });
    await ui.unmount();
  }
  release();
  await running;
  const ended = toolRow('toolu_docs', TOOL, args, free);
  for (const surface of SURFACES) {
    for (const props of [groupOf([ended]), ended]) {
      const ui = await $.ui.mount({
        plugin: 'tenjin',
        surface,
        component: 'calls' in props ? 'ToolGroup' : 'ToolUse',
        props: props as never,
      });
      expect(await rowText(ui)).toBe('Called Context7 docs · free (ctrl+o to expand)');
      expect(await dotOf(ui)).toBeUndefined();
      await ui.unmount();
    }
    await expandRun($, [ended]);
    const open = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: ended,
    });
    expect(await shownLines(open)).toEqual(['engine row']);
    expect(engine.seen.at(-1)).toMatchObject({ input: args, output: free });
    await open.unmount();
  }
});

test('a selected free lookup without an offer id draws its named result', async ($, on) => {
  machine(on);
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['rows'] });
  });
  const engine = engineRows(on);
  const args = { tool: 'context7-docs', query: 'Zod v4 email validation' };
  const free = envelope('fulfilled', {
    label: 'Context7 docs',
    cost: ['provider price 0 USD'],
    result: 'Use z.email().',
  });
  const ended = toolRow('toolu_selected_docs', TOOL, args, free);
  for (const surface of SURFACES) {
    for (const props of [groupOf([ended]), ended]) {
      const ui = await $.ui.mount({
        plugin: 'tenjin',
        surface,
        component: 'calls' in props ? 'ToolGroup' : 'ToolUse',
        props: props as never,
      });
      expect(await rowText(ui)).toBe('Called Context7 docs · free (ctrl+o to expand)');
      expect(await dotOf(ui)).toBeUndefined();
      expect((await shownLines(ui)).join('')).not.toMatch(MODEL_TEXT);
      await ui.unmount();
    }
    await expandRun($, [ended]);
    const open = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: ended,
    });
    expect(await shownLines(open)).toEqual(['engine row']);
    expect(engine.seen.at(-1)).toMatchObject({ input: args, output: free });
    await open.unmount();
  }
});

test('a search the CLI noted a free lookup on stays the engine row, its result too', async ($, on) => {
  const engine = engineRows(on);
  const { files } = machine(on);
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine result'] });
  });
  await keepLabel(files, OFFER);
  files.set(
    `${DATA}/progress/${await sha256Hex('sess-test')}/note-${await sha256Hex('toolu_search')}.json`,
    JSON.stringify({ version: 1, at: 0, offerId: OFFER, line: `call request({id: "${OFFER}"})` }),
  );
  const search = { query: 'zod v4 discriminatedUnion' };
  for (const surface of SURFACES) {
    for (const output of [undefined, 'Did 1 search in 4s']) {
      const props = toolRow('toolu_search', 'WebSearch', search, output);
      const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props });
      expect(await shownLines(ui)).toEqual(['engine row']);
      expect(engine.seen.at(-1)).toMatchObject({ tool: 'WebSearch', input: search });
      await ui.unmount();
    }
    const result = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'toolu_search', tool: 'WebSearch', output: {}, isErrored: false },
    });
    expect(await shownLines(result)).toEqual(['engine result']);
    await result.unmount();
  }
});

test('a free lookup that failed or was cut keeps the error dot and its state word', async ($, on) => {
  const { files } = machine(on);
  await keepLabel(files, OFFER);
  const failed = envelope('failed', {
    reason: 'No indexed library matched this question. Use your own tools.',
    cost: ['provider price 0 USD'],
  });
  on('tool.call', { tool: TOOL }, async (_$, e) =>
    e.tool_use_id === 'toolu_failed' ? { result: failed, text: failed } : { deny: 'Interrupted' },
  );
  const args = { query: 'acme billing sdk', id: OFFER };
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_failed', ...args });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_cut', ...args }).catch(() => undefined);
  const cases = [
    [toolRow('toolu_failed', TOOL, args, failed), 'failed'],
    [{ ...toolRow('toolu_cut', TOOL, args, 'Interrupted'), isInterrupted: true }, 'interrupted'],
  ] as const;
  for (const surface of SURFACES) {
    for (const [props, word] of cases) {
      const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props });
      expect(await rowText(ui)).toBe(`⏺ Context7 docs(acme billing sdk) · free · ${word}`);
      expect(await dotOf(ui)).toEqual({ color: 'error', dimColor: undefined });
      await ui.unmount();
    }
  }
});

test('a free lookup sent back for input draws nothing, and its retry draws', async ($, on) => {
  const { files } = machine(on);
  await keepLabel(files, OFFER);
  const needsInput = envelope('needs_input', { reason: 'query is required' });
  const free = envelope('fulfilled', { label: 'Context7 docs', cost: ['provider price 0 USD'] });
  on('tool.call', { tool: TOOL }, async (_$, e) =>
    e.tool_use_id === 'toolu_first'
      ? { result: needsInput, text: needsInput }
      : { result: free, text: free },
  );
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_first', id: OFFER, query: '' });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_retry', id: OFFER, query: 'zod' });
  const first = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: toolRow('toolu_first', TOOL, { id: OFFER, query: '' }, needsInput),
  });
  expect(await shownLines(first)).toEqual([]);
  await first.unmount();
  const retry = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'ToolUse',
    props: toolRow('toolu_retry', TOOL, { id: OFFER, query: 'zod' }, free),
  });
  expect(await rowText(retry)).toBe('Called Context7 docs · free (ctrl+o to expand)');
  await retry.unmount();
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
      // The engine marks the rows of a run a hook unfolded as expanded.
      props: { ...lookup, isExpanded: true },
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

test('ctrl+o shows every request call in full: a standalone row, the hidden ones too', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, EXA);
  const spec = envelope('spec', { id: OFFER, cost: ['provider price 0 USD'] });
  on('tool.call', { tool: TOOL }, async (_$, e) =>
    e.tool_use_id === 'toolu_spec' ? { result: spec, text: spec } : { result: PAID, text: PAID },
  );
  engineRows(on);
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine result'] });
  });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_alone', id: OFFER, input: INPUT });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_spec', id: OFFER });
  const alone = toolRow('toolu_alone', TOOL, { id: OFFER, input: INPUT }, PAID);
  const hidden = toolRow('toolu_spec', TOOL, { id: OFFER }, spec);
  const mount = async (component: 'ToolUse' | 'ToolResult', props: unknown) => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component,
      props: props as never,
    });
    const lines = await shownLines(ui);
    await ui.unmount();
    return lines;
  };
  // Normal view: the standalone row folds with the hint, the spec answer draws nothing.
  expect((await mount('ToolUse', alone)).join('')).toBe(
    'Called Exa search · $0.04 (ctrl+o to expand)',
  );
  expect(await mount('ToolUse', hidden)).toEqual([]);
  // ctrl+o (`isExpanded`): both are the engine's own row and result.
  expect(await mount('ToolUse', { ...alone, isExpanded: true })).toEqual(['engine row']);
  expect(await mount('ToolUse', { ...hidden, isExpanded: true })).toEqual(['engine row']);
  const result = { tool_use_id: 'toolu_spec', tool: TOOL, output: spec, isErrored: false };
  expect(await mount('ToolResult', result)).toEqual([]);
  expect(await mount('ToolResult', { ...result, isExpanded: true })).toEqual(['engine result']);
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
    [
      'b920ff14-0000-4a50-8c25-250000000020',
      'GlianaAI (Recraft V4.1 Vector (SVG))',
      'Recraft V4.1 Vector (SVG)',
    ],
    [
      'b920ff14-0000-4a50-8c25-250000000021',
      'AiSpace (Venice) (OpenAI GPT Image 2.5 Sunburst (edit))',
      'OpenAI GPT Image 2.5 Sunburst (…',
    ],
    [
      'b920ff14-0000-4a50-8c25-250000000022',
      'AiSpace (Venice) (MiniMax Hailuo 3 Max (image to video))',
      'MiniMax Hailuo 3 Max (image to…',
    ],
    ['b920ff14-0000-4a50-8c25-250000000023', 'Foo (beta', 'Foo (beta'],
    [
      'b920ff14-0000-4a50-8c25-240000000010',
      'AiSpace (Venice) (Meta Muse Image)',
      'Meta Muse Image',
    ],
    ['b920ff14-0000-4a50-8c25-240000000011', 'AiSpace (Venice) (Ideogram V4)', 'Ideogram V4'],
    ['b920ff14-0000-4a50-8c25-240000000012', 'Treza (Recraft V4.1)', 'Recraft V4.1'],
    [
      'b920ff14-0000-4a50-8c25-240000000013',
      'Orthogonal (Scrape Creators LinkedIn profile)',
      'Scrape Creators LinkedIn profile',
    ],
    [
      'b920ff14-0000-4a50-8c25-240000000014',
      'StableEnrich (Google Maps Places)',
      'Google Maps Places',
    ],
    ['b920ff14-0000-4a50-8c25-240000000015', 'glim', 'glim'],
    ['b920ff14-0000-4a50-8c25-240000000016', 'CoinMarketCap', 'CoinMarketCap'],
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

test('a choice call is named as the line named the option, after a free spec check', async ($, on) => {
  const { files, clock } = machine(on);
  const clockSettle = () => clock.settle();
  const line = '7b7223f8-699e-426b-ac14-9452e615f106';
  const other = '6bed572c-e392-4300-a0cc-7b7cee9fdb39';
  // A discovered option's spec: no label, a reseller's provider name.
  await keepSpec(
    files,
    line,
    { provider: 'Gondola (OpenAI GPT Image 2.5 Sunburst)', priceAtomic: '35000' },
    null,
  );
  await keepSpec(
    files,
    other,
    { provider: 'AiSpace (Venice) (Nano Banana 2.1)', priceAtomic: '50000' },
    null,
  );
  files.set(
    `${DATA}/progress/specs/${await sha256Hex(line)}.choices.json`,
    JSON.stringify({
      choices: {
        group: 'image-frontier',
        default: 'gpt-image-2.5',
        input: ['prompt'],
        options: [
          { key: 'gpt-image-2.5', label: 'GPT Image 2.5 Sunburst', strength: 'text', id: line },
          { key: 'nano-banana-2.1', label: 'Nano Banana 2.1', strength: 'photo', id: other },
        ],
        all: { totalAtomic: '85000' },
      },
      hint: 'pick one',
    }),
  );
  const spec = `summary${JSON.stringify({ status: 'spec', id: line, cost: ['provider price 0 USD'] })}`;
  const paid = `summary${JSON.stringify({
    status: 'fulfilled',
    supplier: 'api.gondola-ai.com',
    cost: ['provider price 0.021254 USD'],
  })}`;
  let release = (): void => undefined;
  on('tool.call', { tool: TOOL }, async (_$, e) => {
    if (e.tool_use_id === 'toolu_check') return { result: spec, text: spec };
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { result: paid, text: paid };
  });
  const input = { prompt: 'an editorial brand illustration' };
  const mount = async (calls: unknown[]) => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolGroup',
      props: groupOf(calls),
    });
    const text = await rowText(ui);
    await ui.unmount();
    return text;
  };
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_check', id: line, choice: 'gpt-image-2.5' });
  const check = toolRow('toolu_check', TOOL, { id: line, choice: 'gpt-image-2.5' }, spec);
  for (const [useId, picked, running, ended] of [
    [
      'toolu_paid',
      'gpt-image-2.5',
      '⏺ Calling GPT Image 2.5 Sunburst… · $0.035',
      'Called GPT Image 2.5 Sunburst · $0.021254 (ctrl+o to expand)',
    ],
    [
      'toolu_all',
      'all',
      '⏺ Calling 2 services… · $0.085',
      'Called 2 services · $0.021254 (ctrl+o to expand)',
    ],
  ] as const) {
    const args = { id: line, choice: picked, input };
    const call = $.tool.call({ tool: TOOL, tool_use_id: useId, ...args });
    await clockSettle();
    // IN FLIGHT: the row is stored when the call starts, under the option's name.
    expect(await mount([check, toolRow(useId, TOOL, args)])).toBe(running);
    release();
    await call;
    expect(await mount([check, toolRow(useId, TOOL, args, paid)])).toBe(ended);
  }
});

test('an over-limit lookup is one row: the needs_approval answer draws nothing, approve draws the lookup', async ($, on) => {
  const { files, clock } = machine(on);
  await keepSpec(files, OFFER, { label: 'Exa search', priceAtomic: '775000' });
  const APPROVE = 'mcp__plugin_tenjin_router__approve';
  const quote = 'q_abcdefghijkl';
  const over = envelope('needs_approval', {
    reason: 'One call to Exa costs $0.775.',
    quote: { id: quote, what: 'one call to Exa', total: '$0.775' },
    cost: ['provider price 0 USD'],
  });
  const paid = envelope('fulfilled', { cost: ['provider price 0.775 USD'] });
  on('tool.call', { tool: TOOL }, async () => ({ result: over, text: over }));
  let release = (): void => undefined;
  on('tool.call', { tool: APPROVE }, async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { result: paid, text: paid };
  });
  const mount = async (props: unknown) => {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface: 'terminal',
      component: 'ToolGroup',
      props: groupOf([props]),
    });
    const text = await rowText(ui);
    await ui.unmount();
    return text;
  };
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_over', id: OFFER, input: INPUT });
  expect(await mount(toolRow('toolu_over', TOOL, { id: OFFER, input: INPUT }, over))).toBe('');
  const args = { quote, total: '$0.775', what: 'one call to Exa' };
  const running = $.tool.call({ tool: APPROVE, tool_use_id: 'toolu_approve', ...args } as never);
  await clock.settle();
  expect(await mount(toolRow('toolu_approve', APPROVE, args))).toBe(
    '⏺ Calling Exa search… · $0.775  ⎿  "rust async runtimes"',
  );
  release();
  await running;
  expect(await mount(toolRow('toolu_approve', APPROVE, args, paid))).toBe(
    'Called Exa search · $0.775 (ctrl+o to expand)',
  );
});
