import { expect, test } from 'claude-code/testing';

import {
  DATA,
  MODEL_TEXT,
  NOW,
  SURFACES,
  TOOL,
  keepSpec,
  machine,
  dotOf,
  recordPayment,
  resultText,
  rowText,
  sha256Hex,
  shownLines,
  toolRow,
} from './fixtures';

const OFFER = 'b920ff14-5aed-4a50-8c25-240e871602f3';
const SEARCH = { query: 'rust async runtimes' };
/** The reason the model read on the deny: never drawn. */
const REASON =
  'Tenjin router (installed by the user): Exa search, $0.007: call ' +
  `mcp__plugin_tenjin_router__request({id: "${OFFER}", input: {...}}).`;
const SPIN = { word: 'Sauteing', message: null, suffix: '…', mode: 'tool-use' } as const;

/** The row the CLI's pre-call hook writes for a native call it held (`src/router/held.ts`). */
async function holdRow(
  files: Map<string, string>,
  toolUseId: string,
  outcome: 'held' | 'routed' | 'native' = 'held',
  routedToolUseId?: string,
): Promise<void> {
  files.set(
    `${DATA}/progress/held/${await sha256Hex(toolUseId)}.json`,
    JSON.stringify({
      version: 1,
      at: NOW,
      outcome,
      label: 'Exa search',
      priceAtomic: '7000',
      offerId: OFFER,
      ...(routedToolUseId !== undefined ? { routedToolUseId } : {}),
    }),
  );
  // The CLI's index of the calls it held for the offer.
  files.set(
    `${DATA}/progress/held/${await sha256Hex(OFFER)}.offer.json`,
    JSON.stringify({ version: 1, at: NOW, toolUseIds: [toolUseId] }),
  );
}

/** A held WebSearch's row as the engine hands it over: refused, the reason as output. */
function heldSearch(toolUseId: string) {
  return {
    ...toolRow(toolUseId, 'WebSearch', SEARCH),
    isRunning: false,
    isErrored: true,
    output: REASON,
  };
}

test('a held search is struck through, then becomes the request call in place', async ($, on) => {
  const { files } = machine(on);
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['blocked by hook'] });
  });
  await keepSpec(files, OFFER, {
    capabilityId: 'exa-search',
    label: 'Exa search',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  // Beneath the mod: the request tool, which pays and marks the hold as taken
  // up by this call (the CLI's `markRouted`, from the client's tool id).
  on('tool.call', { tool: TOOL }, async (_$, e) => {
    if (e.input === undefined) {
      const spec = JSON.stringify({ status: 'spec', cost: ['no charge'] });
      return { result: spec, text: spec };
    }
    await holdRow(files, 'toolu_held', 'routed', e.tool_use_id);
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      amountAtomic: '7000',
      txHash: '0xc9fc',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  await holdRow(files, 'toolu_held');
  const mount = (surface: (typeof SURFACES)[number], props: Record<string, unknown>) =>
    $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props: props as never });
  for (const surface of SURFACES) {
    const ui = await mount(surface, heldSearch('toolu_held'));
    expect(await rowText(ui)).toBe('⏺ WebSearch(rust async runtimes)');
    const [name] = await ui.findAll({ type: 'Text', text: 'WebSearch' });
    expect(name?.props.strikethrough).toBe(true);
    expect(await dotOf(ui)).toEqual({ color: undefined, dimColor: true });
    expect(await rowText(ui)).not.toContain('Tenjin router');
    await ui.unmount();
  }
  const request = { id: OFFER, input: { query: 'rust async runtimes' } };
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_request', ...request });
  const done = (id: string, args: Record<string, unknown>, output: string) => ({
    ...toolRow(id, TOOL, args),
    isRunning: false,
    output,
  });
  for (const surface of SURFACES) {
    const ui = await mount(surface, heldSearch('toolu_held'));
    const line = await rowText(ui);
    // A full replace: the request call's row, with no struck name left.
    expect(line).toBe('⏺ Exa search(rust async runtimes) · $0.007');
    expect(line).not.toMatch(MODEL_TEXT);
    expect(await ui.findAll({ type: 'Text', text: 'WebSearch' })).toEqual([]);
    expect(await dotOf(ui)).toEqual({ color: 'success', dimColor: undefined });
    await ui.unmount();
    // The request's own row is then empty: one line for the lookup.
    const row = await mount(surface, done('toolu_request', request, resultText('fulfilled')));
    expect(await shownLines(row)).toEqual([]);
    await row.unmount();
  }
  // A LATER CALL FOR THE SAME OFFER is its own row, and the held row still
  // shows the call that paid.
  const spec = JSON.stringify({ status: 'spec', cost: ['no charge'] });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_spec', id: OFFER });
  for (const surface of SURFACES) {
    const held = await mount(surface, heldSearch('toolu_held'));
    expect(await rowText(held)).toBe('⏺ Exa search(rust async runtimes) · $0.007');
    await held.unmount();
    const fetch = await mount(surface, done('toolu_spec', { id: OFFER }, spec));
    expect(await rowText(fetch)).toBe('⏺ Tenjin · no charge');
    await fetch.unmount();
  }
});

test('a held search the model then ran natively draws nothing', async ($, on) => {
  const { files } = machine(on);
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine row'] });
  });
  await holdRow(files, 'toolu_held', 'native');
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: heldSearch('toolu_held'),
    });
    expect(await shownLines(ui)).toEqual([]);
    await ui.unmount();
    // The call that ran natively has no held row: the engine draws it.
    const ran = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: { ...toolRow('toolu_ran', 'WebSearch', SEARCH), isRunning: false },
    });
    expect(await shownLines(ran)).toEqual(['engine row']);
    await ran.unmount();
  }
});

test('a run of request calls and held native calls unfolds; any other run stays folded', async ($, on) => {
  const { files } = machine(on);
  await holdRow(files, 'held_search');
  const seen: boolean[] = [];
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    seen.push(e.props.isExpanded);
    const { Text } = $.ui.resolve(e);
    return Text({ children: [e.props.isExpanded ? 'rows' : 'count line'] });
  });
  const call = (tool: string, id: string) => ({
    tool_use_id: id,
    tool,
    input: { query: 'q' },
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
  });
  for (const surface of SURFACES) {
    const ours = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: { calls: [call(TOOL, 'a'), call(TOOL, 'b')], isActive: false, isExpanded: false },
    });
    expect(await shownLines(ours)).toEqual(['rows']);
    await ours.unmount();
    const mixed = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: { calls: [call(TOOL, 'a'), call('Read', 'c')], isActive: false, isExpanded: false },
    });
    expect(await shownLines(mixed)).toEqual(['count line']);
    await mixed.unmount();
    const switched = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: {
        calls: [call('WebSearch', 'held_search'), call(TOOL, 'a')],
        isActive: false,
        isExpanded: false,
      },
    });
    expect(await shownLines(switched)).toEqual(['rows']);
    await switched.unmount();
    // A search the CLI did not hold is the engine's, beside ours or not.
    const free = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: {
        calls: [call('WebSearch', 'free_search'), call(TOOL, 'a')],
        isActive: false,
        isExpanded: false,
      },
    });
    expect(await shownLines(free)).toEqual(['count line']);
    await free.unmount();
  }
  expect(seen).toEqual([true, false, true, false, true, false, true, false]);
});

test("a held call's result draws nothing, whatever became of it", async ($, on) => {
  const { files } = machine(on);
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine result'] });
  });
  for (const outcome of ['held', 'routed', 'native'] as const) {
    await holdRow(files, 'toolu_fetch', outcome);
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'tenjin',
        surface,
        component: 'ToolResult',
        props: { tool_use_id: 'toolu_fetch', tool: 'WebFetch', output: REASON, isErrored: true },
      });
      expect(await shownLines(ui)).toEqual([]);
      await ui.unmount();
    }
  }
});

test('a search the CLI did not hold, and an interrupted held one, are the engine rows', async ($, on) => {
  const { files } = machine(on);
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine row'] });
  });
  on('ui.render', { component: 'ToolResult' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: ['engine result'] });
  });
  await holdRow(files, 'toolu_cut');
  for (const surface of SURFACES) {
    const free = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: { ...toolRow('toolu_free', 'WebSearch', SEARCH), isRunning: false },
    });
    expect(await shownLines(free)).toEqual(['engine row']);
    await free.unmount();
    const result = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolResult',
      props: { tool_use_id: 'toolu_free', tool: 'WebSearch', output: 'results', isErrored: false },
    });
    expect(await shownLines(result)).toEqual(['engine result']);
    await result.unmount();
    const cut = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: { ...heldSearch('toolu_cut'), isInterrupted: true },
    });
    expect(await shownLines(cut)).toEqual(['engine row']);
    await cut.unmount();
  }
});

test('the spinner says Routing to Tenjin between the hold and the request call', async ($, on) => {
  const { files, clock } = machine(on);
  await keepSpec(files, OFFER, {
    capabilityId: 'exa-search',
    label: 'Exa search',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  // Beneath the mod, the engine: the CLI's pre-call hook holds the search.
  on('tool.call', { tool: 'WebSearch' }, async (_$, e) => {
    await holdRow(files, e.tool_use_id);
    return { deny: REASON };
  });
  let release = (): void => undefined;
  const paying = new Promise<void>((resolve) => {
    release = resolve;
  });
  on('tool.call', { tool: TOOL }, async () => {
    await paying;
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      amountAtomic: '7000',
      txHash: '0xc9fc',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [`${e.props.message ?? e.props.word}${e.props.suffix}`] });
  });
  const spinner = async (): Promise<string[]> => {
    const shown: string[] = [];
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'Spinner', props: SPIN });
      shown.push(...(await shownLines(ui)));
      await ui.unmount();
    }
    return shown;
  };

  await $.tool.call({ tool: 'WebSearch', tool_use_id: 'toolu_held', ...SEARCH, mode: 'standard' });
  expect(await spinner()).toEqual([
    'Routing to Tenjin… · Exa search',
    'Routing to Tenjin… · Exa search',
  ]);

  const running = $.tool.call({
    tool: TOOL,
    tool_use_id: 'toolu_request',
    id: OFFER,
    input: { query: 'rust async runtimes' },
  });
  await clock.settle();
  expect(await spinner()).toEqual(['Calling Exa search… · $0.007', 'Calling Exa search… · $0.007']);
  release();
  await running;
  expect(await spinner()).toEqual(['Sauteing…', 'Sauteing…']);
});
