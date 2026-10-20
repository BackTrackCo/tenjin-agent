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

test('a held search is one row: struck, then the request call running and done, in place', async ($, on) => {
  const { files, clock } = machine(on);
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
  let release = (): void => undefined;
  const paying = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Beneath the mod: the request tool, which pays once released and marks
  // the hold routed by this call (the CLI's `markRouted`).
  on('tool.call', { tool: TOOL }, async (_$, e) => {
    if (e.input === undefined) {
      const spec = JSON.stringify({ status: 'spec', cost: ['no charge'] });
      return { result: spec, text: spec };
    }
    // Marked only after the gate, so the takeover while it runs is the mod's own.
    await paying;
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
  const hidden = async (ui: Awaited<ReturnType<typeof mount>>) => {
    expect(await shownLines(ui)).toEqual([]);
    // No room at all: the engine leaves no line where this row was.
    const [box] = await ui.findAll({ type: 'Box' });
    expect(box?.props.display).toBe('none');
  };
  for (const surface of SURFACES) {
    const ui = await mount(surface, heldSearch('toolu_held'));
    expect(await rowText(ui)).toBe(
      '⏺ Web Search("rust async runtimes") · Tenjin offered Exa search',
    );
    const [name] = await ui.findAll({ type: 'Text', text: 'Web Search' });
    expect(name?.props).toMatchObject({ bold: true, strikethrough: true });
    // The reason, in the engine's dim secondary text.
    const [tail] = await ui.findAll({ type: 'Text', text: ' · Tenjin offered Exa search' });
    expect(tail?.props.dimColor).toBe(true);
    expect(await dotOf(ui)).toEqual({ color: undefined, dimColor: true });
    expect(await rowText(ui)).not.toContain('Tenjin router');
    await ui.unmount();
  }
  // The provider's query is longer than the model's search: the held row keeps
  // the model's, so the line does not change width between states.
  const request = { id: OFFER, input: { query: 'rust async runtimes tokio smol comparison 2026' } };
  const running = $.tool.call({ tool: TOOL, tool_use_id: 'toolu_request', ...request });
  await clock.settle();
  for (const surface of SURFACES) {
    const ui = await mount(surface, heldSearch('toolu_held'));
    expect(await rowText(ui)).toBe('⏺ Exa search("rust async runtimes") · $0.007');
    expect(await dotOf(ui)).toEqual({ color: undefined, dimColor: true });
    // A replacement never reads `Calling`, and has nothing under it.
    expect(await rowText(ui)).not.toMatch(/Calling|⎿/);
    await ui.unmount();
    // FROM ITS FIRST FRAME the request's own row takes no room.
    await hidden(await mount(surface, toolRow('toolu_request', TOOL, request)));
  }
  release();
  await running;
  const done = (id: string, args: Record<string, unknown>, output: string) => ({
    ...toolRow(id, TOOL, args),
    isRunning: false,
    output,
  });
  for (const surface of SURFACES) {
    const ui = await mount(surface, heldSearch('toolu_held'));
    const line = await rowText(ui);
    expect(line).toBe('⏺ Exa search("rust async runtimes") · $0.007');
    expect(line).not.toMatch(MODEL_TEXT);
    expect(await ui.findAll({ type: 'Text', text: 'Web Search' })).toEqual([]);
    // A replacement ends as a built-in row would: the same text, the dot done.
    expect(await dotOf(ui)).toEqual({ color: 'success', dimColor: undefined });
    await ui.unmount();
    await hidden(await mount(surface, done('toolu_request', request, resultText('fulfilled'))));
  }
  // A LATER CALL FOR THE SAME OFFER does not replace the paid call on the
  // held row.
  const spec = JSON.stringify({ status: 'spec', cost: ['no charge'] });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_spec', id: OFFER });
  for (const surface of SURFACES) {
    const held = await mount(surface, heldSearch('toolu_held'));
    expect(await rowText(held)).toBe('⏺ Exa search("rust async runtimes") · $0.007');
    await held.unmount();
    // A spec fetch, the router's own free call, is not drawn.
    const fetch = await mount(surface, done('toolu_spec', { id: OFFER }, spec));
    expect(await shownLines(fetch)).toEqual([]);
    await fetch.unmount();
  }
});

test('a row has one blank line above and none below, as the engine draws a tool row', async ($, on) => {
  const { files } = machine(on);
  await holdRow(files, 'toolu_held');
  await keepSpec(files, OFFER, {
    label: 'Exa search',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  for (const surface of SURFACES) {
    for (const props of [
      heldSearch('toolu_held'),
      {
        ...toolRow('toolu_direct', TOOL, { id: OFFER, input: { query: 'q' } }),
        isRunning: false,
        output: resultText('fulfilled'),
      },
    ]) {
      const ui = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props });
      const [row] = await ui.findAll({ type: 'Box' });
      expect(row?.props).toMatchObject({ flexDirection: 'row', marginTop: 1 });
      expect(row?.props).not.toHaveProperty('marginBottom');
      expect(row?.props).not.toHaveProperty('marginY');
      expect(row?.props).not.toHaveProperty('paddingBottom');
      await ui.unmount();
    }
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
    expect((await ui.findAll({ type: 'Box' }))[0]?.props.display).toBe('none');
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

test('a run with ours draws the engine count for the other calls, and each paid lookup as its row', async ($, on) => {
  const { files } = machine(on);
  // An image service: the CLI keeps no input for its row to show.
  await keepSpec(
    files,
    OFFER,
    {
      capabilityId: 'ideogram',
      label: 'Ideogram V4',
      priceAtomic: '30000',
      maxAmountAtomic: '30000',
    },
    null,
  );
  on('tool.call', { tool: TOOL }, async (_$, e) => {
    if (e.input === undefined) {
      const spec = JSON.stringify({ status: 'spec', cost: ['no charge'] });
      return { result: spec, text: spec };
    }
    await recordPayment(files, OFFER, {
      capabilityId: 'ideogram',
      amountAtomic: '30000',
      txHash: '0xc9fc',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  on('ui.render', { component: 'ToolGroup' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [e.props.isExpanded ? 'rows' : 'engine count line'] });
  });
  const paid = { id: OFFER, input: { prompt: 'a clean wide repository banner' } };
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_spec', id: OFFER });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_paid', ...paid });
  const call = (tool: string, id: string, input: unknown = { file_path: '/a' }) => ({
    tool_use_id: id,
    tool,
    input,
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output: 'ok',
  });
  const group = (surface: (typeof SURFACES)[number], calls: unknown[], isExpanded = false) =>
    $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: { calls: calls as never, isActive: false, isExpanded },
    });
  for (const surface of SURFACES) {
    // Reads, the free spec fetch and the paid call: the count names the reads
    // alone, and the paid lookup draws beneath it.
    const mixed = await group(surface, [
      call('Read', 'r1'),
      call('Read', 'r2'),
      call(TOOL, 'toolu_spec', { id: OFFER }),
      call(TOOL, 'toolu_paid', paid),
    ]);
    expect((await shownLines(mixed)).join('')).toBe(
      'Read 2 files (ctrl+o to expand)Called Ideogram V4 · $0.03 (ctrl+o to expand)',
    );
    const [count] = await mixed.findAll({ type: 'Text', text: '2' });
    expect(count?.props).toMatchObject({ bold: true, dimColor: true });
    expect((await shownLines(mixed)).join('')).not.toContain('plugin:tenjin:router');
    await mixed.unmount();
    // Only a free call of ours beside a read: the read's count, no mention of us.
    const free = await group(surface, [
      call('Read', 'r1'),
      call(TOOL, 'toolu_spec', { id: OFFER }),
    ]);
    expect((await shownLines(free)).join('')).toBe('Read 1 file (ctrl+o to expand)');
    await free.unmount();
    // A free call of ours alone: nothing.
    const alone = await group(surface, [call(TOOL, 'toolu_spec', { id: OFFER })]);
    expect(await shownLines(alone)).toEqual([]);
    await alone.unmount();
    // A run without ours, and any unfolded run, are the engine's.
    const theirs = await group(surface, [call('Read', 'r1'), call('Grep', 'g1')]);
    expect(await shownLines(theirs)).toEqual(['engine count line']);
    await theirs.unmount();
    const open = await group(surface, [call('Read', 'r1'), call(TOOL, 'toolu_paid', paid)], true);
    expect(await shownLines(open)).toEqual(['rows']);
    await open.unmount();
  }
});

test('a run of a held call and its request unfolds into the switch row', async ($, on) => {
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
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolGroup',
      props: {
        calls: [call('WebSearch', 'held_search'), call(TOOL, 'a')],
        isActive: false,
        isExpanded: false,
      },
    });
    expect(await shownLines(ui)).toEqual(['rows']);
    await ui.unmount();
  }
  expect(seen).toEqual([true, true]);
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

test('a request row for a held offer draws nothing on its first frame, before any claim', async ($, on) => {
  const { files } = machine(on);
  await holdRow(files, 'toolu_held');
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: toolRow('toolu_first', TOOL, { id: OFFER, input: { query: 'q' } }),
    });
    expect(await shownLines(ui)).toEqual([]);
    expect((await ui.findAll({ type: 'Box' }))[0]?.props.display).toBe('none');
    await ui.unmount();
  }
});

test('a request sent back for a missing field draws nothing; its claim lapses and the paid retry draws once', async ($, on) => {
  const { files, toasts, clock } = machine(on);
  await keepSpec(files, OFFER, {
    capabilityId: 'exa-search',
    label: 'Exa search',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  const refused = JSON.stringify({
    status: 'needs_input',
    reason: 'Missing required field: query',
  });
  let release = (): void => undefined;
  const answering = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Beneath the mod: the first call is sent back before the CLI marks
  // anything; the retry runs the offer, is named on the held row, and pays.
  on('tool.call', { tool: TOOL }, async (_$, e) => {
    if (e.tool_use_id === 'toolu_first') {
      await answering;
      return { result: refused, text: refused, isError: true };
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
  const done = (id: string, args: Record<string, unknown>, output: string, isErrored = false) => ({
    ...toolRow(id, TOOL, args),
    isRunning: false,
    isErrored,
    output,
  });
  const first = { id: OFFER, input: { q: 'rust async runtimes' } };
  const retry = { id: OFFER, input: { query: 'rust async runtimes' } };
  // While the first attempt runs it holds the claim: the held row draws it.
  const running = $.tool.call({ tool: TOOL, tool_use_id: 'toolu_first', ...first });
  await clock.settle();
  for (const surface of SURFACES) {
    const held = await mount(surface, heldSearch('toolu_held'));
    expect(await rowText(held)).toBe('⏺ Exa search("rust async runtimes") · $0.007');
    await held.unmount();
  }
  release();
  await running;
  for (const surface of SURFACES) {
    // It took nothing: the claim lapsed and the held row is struck again.
    const held = await mount(surface, heldSearch('toolu_held'));
    expect(await rowText(held)).toBe(
      '⏺ Web Search("rust async runtimes") · Tenjin offered Exa search',
    );
    await held.unmount();
    // The attempt itself draws nothing, folded or expanded.
    for (const isExpanded of [false, true]) {
      const own = await mount(surface, {
        ...done('toolu_first', first, refused, true),
        isExpanded,
      });
      expect(await shownLines(own)).toEqual([]);
      expect((await own.findAll({ type: 'Box' }))[0]?.props.display).toBe('none');
      await own.unmount();
    }
  }
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_retry', ...retry });
  for (const surface of SURFACES) {
    // The retry took the claim and is the one line.
    const held = await mount(surface, heldSearch('toolu_held'));
    expect(await rowText(held)).toBe('⏺ Exa search("rust async runtimes") · $0.007');
    expect(await dotOf(held)).toEqual({ color: 'success', dimColor: undefined });
    await held.unmount();
    const paid = await mount(surface, done('toolu_retry', retry, resultText('fulfilled')));
    expect(await shownLines(paid)).toEqual([]);
    await paid.unmount();
    const own = await mount(surface, done('toolu_first', first, refused, true));
    expect(await shownLines(own)).toEqual([]);
    await own.unmount();
  }
  // Only the retry paid.
  expect(toasts).toEqual(['Exa search · $0.007']);
});

test('a request row is not drawn before it runs, while its input may still be arriving', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, {
    label: 'Exa search',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  for (const surface of SURFACES) {
    // Queued or streaming: not in progress yet, no output, a partial id.
    for (const input of [{}, { id: OFFER.slice(0, 6) }, { id: OFFER, input: { query: 'q' } }]) {
      const ui = await $.ui.mount({
        plugin: 'tenjin',
        surface,
        component: 'ToolUse',
        props: { ...toolRow('toolu_queued', TOOL, input), isRunning: false },
      });
      expect(await shownLines(ui)).toEqual([]);
      await ui.unmount();
    }
  }
});

test("a held WebFetch is struck under the engine's own name for it", async ($, on) => {
  const { files } = machine(on);
  await holdRow(files, 'toolu_fetch');
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: {
        ...toolRow('toolu_fetch', 'WebFetch', { url: 'https://example.test/a', prompt: 'p' }),
        isRunning: false,
        isErrored: true,
        output: REASON,
      },
    });
    expect((await shownLines(ui)).join('')).toBe(
      '⏺Fetch(https://example.test/a) · Tenjin offered Exa search',
    );
    expect((await ui.findAll({ type: 'Text', text: 'Fetch' }))[0]?.props.strikethrough).toBe(true);
    await ui.unmount();
  }
});

test('a long input is cut to the row as the engine cuts a tool input, keeping the price', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, {
    label: 'Exa search',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  // Short enough to be shown (80 characters at most), too long for the row.
  const query = 'best local LLM for a 16 GB Mac that runs well in ollama this autumn';
  on('tool.call', { tool: TOOL }, async () => {
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      amountAtomic: '7000',
      txHash: '0xc9fc',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_long', id: OFFER, input: { query } });
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      viewport: { columns: 40, rows: 40 },
      // The ctrl+o transcript: the whole row, input and all.
      props: {
        ...toolRow('toolu_long', TOOL, { id: OFFER, input: { query } }),
        isRunning: false,
        isExpanded: true,
      } as never,
    });
    const line = await rowText(ui);
    // 40 columns less 2 for the dot, 10 for the name, 2 for the parentheses
    // and 9 for the tail leave 17, under the engine's floor of 20 for the
    // input, its last one the `…`.
    expect(line).toBe(`⏺ Exa search(${query.slice(0, 19)}…) · $0.007`);
    await ui.unmount();
  }
});

test('a long input is a prompt, not a key: the row shows none', async ($, on) => {
  const { files } = machine(on);
  await keepSpec(files, OFFER, {
    label: 'Exa search',
    priceAtomic: '7000',
    maxAmountAtomic: '7000',
  });
  const question = 'x'.repeat(81);
  on('tool.call', { tool: TOOL }, async () => {
    await recordPayment(files, OFFER, {
      capabilityId: 'exa-search',
      amountAtomic: '7000',
      txHash: '0x1',
    });
    return { result: resultText('fulfilled'), text: resultText('fulfilled') };
  });
  await $.tool.call({ tool: TOOL, tool_use_id: 'toolu_q', id: OFFER, input: { query: question } });
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: {
        ...toolRow('toolu_q', TOOL, { id: OFFER, input: { query: question } }),
        isRunning: false,
      },
    });
    expect(await rowText(ui)).toBe('Called Exa search · $0.007 (ctrl+o to expand)');
    await ui.unmount();
  }
});
