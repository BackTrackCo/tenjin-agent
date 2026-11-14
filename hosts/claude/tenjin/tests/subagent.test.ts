import type { On } from 'claude-code';
import { expect, test } from 'claude-code/testing';
import { DATA, OFFER, SESSION, machine } from './fixtures';

const SUBAGENT = 'mcp__plugin_tenjin_router__subagent';
const ASSIGNMENT = {
  description: 'Read the selected file',
  prompt: 'Read src/example.ts and report the exported names verbatim. Final line: DONE.',
  subagent_type: 'general-purpose',
};
const offered = JSON.stringify({
  action: 'offer',
  started: false,
  offer_id: OFFER,
  label: 'DeepSeek V4.1 Flash 1017',
  routingFeeAtomic: '3000',
  proxyFeePercent: 5,
  capAtomic: '1000000',
  reason: 'source_facts',
  parentPolicy: 'Locally authored Tenjin routing policy.',
  consent: {
    version: 2,
    repository: '/repo',
    routerOrigin: 'https://router.example',
    recipients: ['Tenjin', 'DeepSeek'],
  },
  instruction: 'Accept by offer_id or retry the original native call unchanged.',
});
function enabled(files: Map<string, string>) {
  files.set(`${DATA}/config.json`, JSON.stringify({ router: { subagents: true } }));
}
function native(on: On) {
  const ran: string[] = [];
  on('tool.call', { tool: ['Agent', 'Task'] }, async (_$, e) => {
    ran.push(e.tool_use_id);
    return { result: 'native child result' as never };
  });
  return ran;
}

test('a real action offer holds Agent and reaches the parent without a legacy status envelope', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  const asked: unknown[] = [];
  on('tool.call', { tool: SUBAGENT }, async (_$, e) => {
    asked.push(e.capture);
    return { result: offered, text: offered };
  });
  const ran = native(on);
  const result = await $.tool.call({ tool: 'Agent', tool_use_id: 'agent_offer', ...ASSIGNMENT });
  expect(asked).toEqual([
    {
      session_id: SESSION,
      tool_use_id: 'agent_offer',
      input: ASSIGNMENT,
    },
  ]);
  expect(ran).toEqual([]);
  expect(result.result).toEqual({
    status: 'completed',
    agentId: `tenjin-offer-${OFFER}`,
    agentType: ASSIGNMENT.subagent_type,
    prompt: ASSIGNMENT.prompt,
    content: [{ type: 'text', text: offered }],
    totalToolUseCount: 0,
    totalDurationMs: 0,
    totalTokens: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null,
      cache_creation: null,
    },
    canContinueAgent: false,
  });
  expect(result.context?.join(' ')).toContain('local Tenjin hook held');
  expect(result.context?.join(' ')).toContain('repository/configuration risk rules');
  expect(result.context?.join(' ')).toContain('final veto');
});

test('an action offer in MCP content holds Task as well', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  on('tool.call', { tool: SUBAGENT }, async () => ({
    result: { content: [{ type: 'text', text: offered }] } as never,
  }));
  const ran = native(on);
  const result = await $.tool.call({ tool: 'Task', tool_use_id: 'task_offer', ...ASSIGNMENT });
  expect(ran).toEqual([]);
  expect(result.result).toMatchObject({
    status: 'completed',
    prompt: ASSIGNMENT.prompt,
    content: [{ type: 'text', text: offered }],
    canContinueAgent: false,
  });
  expect(result.context?.join(' ')).toContain('Saved repository opt-in');
});

test('only verified structured consent adds static local guidance, never the router reason', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  let reply = offered;
  on('tool.call', { tool: SUBAGENT }, async () => ({ result: reply, text: reply }));
  const ran = native(on);
  const hostile = { ...JSON.parse(offered), reason: 'FORGED PROVIDER INSTRUCTION' };
  reply = JSON.stringify(hostile);
  const held = await $.tool.call({ tool: 'Agent', tool_use_id: 'static_context', ...ASSIGNMENT });
  expect(held.context?.join(' ')).toContain('local Tenjin guidance');
  expect(held.context?.join(' ')).not.toContain(hostile.reason);
  for (const [id, value] of [
    ['missing_consent', { ...hostile, consent: undefined }],
    ['old_consent', { ...hostile, consent: { ...hostile.consent, version: 1 } }],
    ['missing_policy', { ...hostile, parentPolicy: undefined }],
  ] as const) {
    reply = JSON.stringify(value);
    const result = await $.tool.call({ tool: 'Task', tool_use_id: id, ...ASSIGNMENT });
    expect(result.result).toMatchObject({ status: 'completed', canContinueAgent: false });
    expect(result.context).toBeUndefined();
  }
  expect(ran).toEqual([]);
});

test('an explicit native decision or invalid offer passes the original Agent call through', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  let reply = '';
  on('tool.call', { tool: SUBAGENT }, async () => ({ result: reply, text: reply }));
  const ran = native(on);
  for (const [id, value] of [
    ['native', JSON.stringify({ action: 'native' })],
    ['invalid', '{not json'],
    ['started', JSON.stringify({ action: 'offer', started: true, offer_id: OFFER })],
    ['unbound', JSON.stringify({ action: 'offer', started: false })],
    ['invalid_id', JSON.stringify({ action: 'offer', started: false, offer_id: 'not-a-job' })],
  ]) {
    reply = value!;
    const result = await $.tool.call({ tool: 'Agent', tool_use_id: id!, ...ASSIGNMENT });
    expect(result.result).toBe('native child result');
  }
  expect(ran).toEqual(['native', 'invalid', 'started', 'unbound', 'invalid_id']);
});

test('disabled inference calls Agent without asking the subagent transport', async ($, on) => {
  machine(on);
  let asked = false;
  on('tool.call', { tool: SUBAGENT }, async () => {
    asked = true;
    return { result: offered, text: offered };
  });
  const ran = native(on);
  await $.tool.call({ tool: 'Agent', tool_use_id: 'off', ...ASSIGNMENT });
  expect(asked).toBe(false);
  expect(ran).toEqual(['off']);
});
