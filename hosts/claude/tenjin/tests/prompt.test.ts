import type { On } from 'claude-code';
import { expect, test, type TestBody } from 'claude-code/testing';

import {
  MODEL_TEXT,
  SESSION,
  SURFACES,
  keepOffer,
  keepPromptOffer,
  machine,
  shownLines,
} from './fixtures';

const PROMPT = 'find the fastest rust async runtime';
const LINE = '  ⎿  Tenjin offered Exa search';

/** The engine beneath the mod: the prompt's events, and the `> ` row it draws. */
function enginePrompt(on: On): void {
  on('prompt.submit', (_$, e) => ({ text: e.text }));
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return Text({ children: [`> ${e.props.text}`] });
  });
}

/** A prompt sent, its settings hooks run (the CLI's record written), its turn started. */
async function send($: Parameters<TestBody>[0], text: string, hook?: () => Promise<void>) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } });
  await hook?.();
  await $.turn.start({ text, turnId: `turn-${text}` });
}

async function promptRow($: Parameters<TestBody>[0], text: string, isExpanded = false) {
  const lines: string[][] = [];
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'UserMessage',
      props: { text, origin: { kind: 'composer' }, isExpanded },
    });
    lines.push(await shownLines(ui));
    await ui.unmount();
  }
  return lines;
}

test('a prompt-time offer is one dim line under the prompt, in the normal and the full view', async ($, on) => {
  enginePrompt(on);
  const { files } = machine(on);
  await send($, PROMPT, () => keepPromptOffer(files, PROMPT));
  for (const isExpanded of [false, true]) {
    for (const lines of await promptRow($, PROMPT, isExpanded)) {
      expect(lines).toEqual([`> ${PROMPT}`, LINE]);
      expect(lines.join('\n')).not.toMatch(MODEL_TEXT);
    }
  }
  const ui = await $.ui.mount({
    plugin: 'tenjin',
    surface: 'terminal',
    component: 'UserMessage',
    props: { text: PROMPT, origin: { kind: 'composer' }, isExpanded: false },
  });
  const [line] = await ui.findAll({ type: 'Text', text: LINE });
  expect(line?.props.dimColor).toBe(true);
  await ui.unmount();
});

test('a held native call draws no line under the prompt: its own row names the offer', async ($, on) => {
  enginePrompt(on);
  const { files } = machine(on);
  on('tool.call', { tool: 'WebSearch' }, () => ({ deny: 'Tenjin router: call request.' }));
  await send($, PROMPT);
  await keepOffer(files, SESSION, 'toolu_held');
  await $.tool.call({
    tool: 'WebSearch',
    tool_use_id: 'toolu_held',
    query: PROMPT,
    mode: 'standard',
  });
  for (const lines of await promptRow($, PROMPT)) expect(lines).toEqual([`> ${PROMPT}`]);
});

test('a free offer, an unlabelled one or a fallback name draws nothing', async ($, on) => {
  enginePrompt(on);
  const { files } = machine(on);
  const cases: [string, Record<string, unknown>][] = [
    ['free docs for tokio', { priceAtomic: '0' }],
    ['no label for tokio', { label: undefined }],
    ['the fallback for tokio', { label: 'Tenjin lookup' }],
    ['the plain fallback for tokio', { label: 'Tenjin' }],
  ];
  for (const [text, record] of cases) {
    await send($, text, () => keepPromptOffer(files, text, record));
    for (const lines of await promptRow($, text)) expect(lines).toEqual([`> ${text}`]);
  }
});

test('a later prompt with no offer draws nothing, the same words again included', async ($, on) => {
  enginePrompt(on);
  const { files, clock } = machine(on);
  await send($, PROMPT, () => keepPromptOffer(files, PROMPT));
  await send($, 'now explain it');
  for (const lines of await promptRow($, 'now explain it'))
    expect(lines).toEqual(['> now explain it']);
  for (const lines of await promptRow($, PROMPT)) expect(lines).toEqual([`> ${PROMPT}`, LINE]);
  // The same words sent again, and no offer made: the earlier record is older than it.
  await clock.advance(60_000);
  await send($, PROMPT);
  for (const lines of await promptRow($, PROMPT)) expect(lines).toEqual([`> ${PROMPT}`]);
});

test("a subagent's run with the same words leaves the prompt's line alone", async ($, on) => {
  enginePrompt(on);
  const { files, clock } = machine(on);
  await send($, PROMPT, () => keepPromptOffer(files, PROMPT));
  await clock.advance(60_000);
  await send($, 'delegate it');
  await $.turn.start({ text: PROMPT, turnId: 'turn-agent', agentId: 'agent-1' });
  for (const lines of await promptRow($, PROMPT)) expect(lines).toEqual([`> ${PROMPT}`, LINE]);
});
