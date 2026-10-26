import { expect, test, type TestBody } from 'claude-code/testing';
import { machine, shownLines, SURFACES, TOOL } from './fixtures';

const PANE = {
  plugin: 'tenjin',
  component: 'Pane',
  requestId: 'tenjin-tools',
  props: {
    title: 'Tenjin tools',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const;

function engine(on: Parameters<TestBody>[1], placed = true) {
  machine(on);
  const commands: string[] = [];
  on('command.register', (_$, e) => {
    commands.push(e.name);
    return { value: { command: e.name } };
  });
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('ui.open', () => ({
    value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'no-surface' },
  }));
  on('ui.close', () => ({ value: undefined }));
  return commands;
}

function inspection(
  lines: string[],
  header = ['Current catalog', 'Preferences and automatic use are separate.'],
) {
  return JSON.stringify({ status: 'inspection', view: { header, lines } });
}

test('/tenjin-tools registers and opens a read-only inspection on terminal and Desktop', async ($, on) => {
  const commands = engine(on);
  const calls: unknown[] = [];
  on('tool.call', { tool: TOOL }, (_$, e) => {
    calls.push({ inspect: e.inspect, input: e.input, query: e.query });
    return {
      result: {},
      text: inspection([
        'web research · Exa search — disabled. Blocked by your provider setting: Exa.',
        'computation · Wolfram Alpha — enabled. Allowed by your settings.',
      ]),
    };
  });
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  expect(commands).toEqual(['tenjin-tools']);
  await $.command.run({ command: 'tenjin-tools' });
  expect(calls).toEqual([{ inspect: '', input: undefined, query: undefined }]);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface });
    const text = (await shownLines(ui)).join('\n');
    expect(text).toContain('Exa search — disabled');
    expect(text).toContain('Wolfram Alpha — enabled');
    expect(await ui.find({ key: 'tools-filter' })).toBeDefined();
    await ui.unmount();
  }
});

test('search and refresh read new state, with pages for every tool', async ($, on) => {
  engine(on);
  let changed = false;
  const filters: unknown[] = [];
  on('tool.call', { tool: TOOL }, (_$, e) => {
    filters.push(e.inspect);
    return {
      result: {},
      text: inspection(
        e.inspect
          ? [`Exa search — ${changed ? 'disabled' : 'enabled'}`]
          : Array.from({ length: 12 }, (_, i) => `tool ${i}`),
      ),
    };
  });
  await $.command.run({ command: 'tenjin-tools' });
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' });
  expect(await ui.find({ type: 'Text', text: 'tool 11' })).toBeUndefined();
  await ui.press({ key: 'tools-next' });
  expect(await ui.find({ type: 'Text', text: 'tool 11' })).toBeDefined();
  await ui.input({ key: 'tools-filter', text: 'Exa' });
  expect((await shownLines(ui)).join('\n')).toContain('Exa search — enabled');
  changed = true;
  await ui.press({ key: 'tools-refresh' });
  expect((await shownLines(ui)).join('\n')).toContain('Exa search — disabled');
  expect(filters).toEqual(['', 'Exa', 'Exa']);
  await ui.unmount();
});

test('a missing pane placement prints the inspection instead', async ($, on) => {
  engine(on, false);
  on('tool.call', { tool: TOOL }, () => ({
    result: {},
    text: inspection(['Exa search — disabled']),
  }));
  const result = await $.command.run({ command: 'tenjin-tools' });
  expect(result.text).toContain('Exa search — disabled');
});

test('an unavailable or older MCP server gives a visible recovery action', async ($, on) => {
  engine(on);
  on('tool.call', { tool: TOOL }, () => ({ result: {}, text: '{"status":"needs_input"}' }));
  await $.command.run({ command: 'tenjin-tools' });
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' });
  expect((await shownLines(ui)).join('\n')).toContain('ask your agent to run tenjin tools');
  expect(await ui.find({ key: 'tools-refresh' })).toBeDefined();
  await ui.unmount();
});
