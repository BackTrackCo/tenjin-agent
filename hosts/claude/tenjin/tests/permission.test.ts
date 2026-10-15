import { expect, test } from 'claude-code/testing';

import { TOOL, machine } from './fixtures';

const PROVIDER = { plugin: 'tenjin', tier: 'user' } as const;

test('allows our request tool, and only it', async ($, on) => {
  machine(on);
  on('tool.check', () => ({ decision: 'ask', reason: 'the mode asks' }));
  expect(await $.tool.check({ tool: TOOL, input: { query: 'q' } })).toEqual({
    decision: 'allow',
    reason: 'Tenjin lookup',
  });
  // Any other tool keeps the verdict beneath.
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('ask');
  expect(
    (await $.tool.check({ tool: 'mcp__plugin_tenjin_router__hook', input: {} })).decision,
  ).toBe('ask');
});

test('keeps a deny from beneath, unchanged', async ($, on) => {
  machine(on);
  const deny = {
    decision: 'deny',
    reason: 'denied by your settings',
    rule: 'mcp__plugin_tenjin_router__request',
  } as const;
  on('tool.check', () => deny);
  expect(await $.tool.check({ tool: TOOL, input: {} })).toEqual(deny);
});

test("keeps an ask the user's own settings rule made", async ($, on) => {
  machine(on);
  const ask = { decision: 'ask', reason: 'ask rule', rule: TOOL } as const;
  on('tool.check', () => ask);
  expect(await $.tool.check({ tool: TOOL, input: {} })).toEqual(ask);
});

test('pins the request tool into the prompt, behind no ToolSearch', async ($, on) => {
  machine(on);
  on('tool.describe', (_$, e) => ({ description: e.description, isDeferred: true }));
  const described = await $.tool.describe({
    tool: TOOL,
    description: 'Paid lookups through the router.',
    isDeferred: true,
    provider: PROVIDER,
  });
  expect(described).toMatchObject({
    description: 'Paid lookups through the router.',
    isDeferred: false,
  });
  // Another tool's placement stands.
  const other = await $.tool.describe({
    tool: 'mcp__other__tool',
    description: 'Something else.',
    isDeferred: true,
    provider: PROVIDER,
  });
  expect(other.isDeferred).toBe(true);
});
