import type { On } from 'claude-code';
import { expect, test } from 'claude-code/testing';
import { DATA, OFFER, SESSION, machine } from './fixtures';

const SUBAGENT = 'mcp__plugin_tenjin_router__subagent';
const WORKER = 'tenjin-worker-f30fcbad-15d3-4515-86d5-5856048032bf';
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
  on('tool.call', { tool: ['Agent', 'Task', 'SendMessage'] }, async (_$, e) => {
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
      tool: 'Agent',
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
  expect(result.context?.join(' ')).toContain('verified saved consent');
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
  expect(held.context?.join(' ')).toContain('verified saved consent');
  expect(held.context?.join(' ')).toContain('additional approvals still apply');
  expect(held.context?.join(' ')).not.toMatch(/opt[ -]?in/i);
  expect(held.context?.join(' ')).toContain('local Tenjin guidance');
  expect(held.context?.join(' ')).not.toContain(hostile.reason);
  for (const [id, value] of [
    ['missing_consent', { ...hostile, consent: undefined }],
    ['old_consent', { ...hostile, consent: { ...hostile.consent, version: 1 } }],
    ['missing_repository', { ...hostile, consent: { ...hostile.consent, repository: '' } }],
    ['invalid_origin', { ...hostile, consent: { ...hostile.consent, routerOrigin: 'invalid' } }],
    ['wrong_recipients', { ...hostile, consent: { ...hostile.consent, recipients: ['Other'] } }],
    ['zero_cap', { ...hostile, capAtomic: '0' }],
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

test('SendMessage to an owned worker holds the complete continuation without claiming delivery', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  const asked: unknown[] = [];
  on('tool.call', { tool: SUBAGENT }, async (_$, e) => {
    asked.push(e.capture);
    return { result: offered, text: offered };
  });
  const ran = native(on);
  const input = { to: WORKER, message: 'Continue with exactly this follow-up. Final line: DONE.' };
  const result = await $.tool.call({ tool: 'SendMessage', tool_use_id: 'resume_send', ...input });
  expect(asked).toEqual([
    { session_id: SESSION, tool_use_id: 'resume_send', input, tool: 'SendMessage' },
  ]);
  expect(ran).toEqual([]);
  expect(result.result).toEqual({ success: false, message: offered });
  expect(result.context?.join(' ')).toContain('no continuation started');
  expect(result.context?.join(' ')).toContain('verified saved consent');
});

test('Agent resume compatibility holds the owned handle through the same captured offer path', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  const asked: unknown[] = [];
  on('tool.call', { tool: SUBAGENT }, async (_$, e) => {
    asked.push(e.capture);
    return { result: offered, text: offered };
  });
  const ran = native(on);
  const input = { ...ASSIGNMENT, resume: WORKER };
  const result = await $.tool.call({ tool: 'Agent', tool_use_id: 'resume_agent', ...input });
  expect(asked).toEqual([
    { session_id: SESSION, tool_use_id: 'resume_agent', input, tool: 'Agent' },
  ]);
  expect(ran).toEqual([]);
  expect(result.result).toMatchObject({
    status: 'completed',
    agentId: `tenjin-offer-${OFFER}`,
    canContinueAgent: false,
  });
});

test('disabled routing refuses reserved worker and unstarted-offer addresses before native fallback', async ($, on) => {
  machine(on);
  let asked = false;
  on('tool.call', { tool: SUBAGENT }, async () => {
    asked = true;
    return { result: offered, text: offered };
  });
  const ran = native(on);
  const agent = await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'off_owned_agent',
    ...ASSIGNMENT,
    resume: '  TENJIN-WORKER-malformed  ',
  });
  expect(agent.result).toMatchObject({ status: 'completed', canContinueAgent: false });
  expect(JSON.stringify(agent.result)).toContain('No continuation started');
  const send = await $.tool.call({
    tool: 'SendMessage',
    tool_use_id: 'off_owned_send',
    to: `tenjin-offer-${OFFER}`,
    message: 'Continue',
  });
  expect(send.result).toMatchObject({ success: false });
  expect(JSON.stringify(send.result)).toContain('unavailable');
  expect(asked).toBe(false);
  expect(ran).toEqual([]);
});

test('owned continuations never fall through after a transport error or invalid response', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  let reply: string | undefined;
  on('tool.call', { tool: SUBAGENT }, async () => {
    if (reply === undefined) throw Error('Local transport unavailable');
    return { result: reply, text: reply };
  });
  const ran = native(on);
  for (const [id, value] of [
    ['unavailable', undefined],
    ['native', JSON.stringify({ action: 'native' })],
    ['refused', JSON.stringify({ action: 'refused', started: false })],
    ['malformed', '{invalid'],
    ['started', JSON.stringify({ action: 'offer', started: true, offer_id: OFFER })],
  ]) {
    reply = value;
    const send = await $.tool.call({
      tool: 'SendMessage',
      tool_use_id: `send_${id}`,
      to: WORKER,
      message: 'Continue',
    });
    expect(send.result).toMatchObject({ success: false });
    expect(JSON.stringify(send.result)).toContain('No continuation started');
    const agent = await $.tool.call({
      tool: 'Task',
      tool_use_id: `agent_${id}`,
      ...ASSIGNMENT,
      resume: WORKER,
    });
    expect(agent.result).toMatchObject({ status: 'completed', canContinueAgent: false });
  }
  expect(ran).toEqual([]);
});

test('mixed owned and native addresses stay held when the backend refuses them', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  const asked: unknown[] = [];
  on('tool.call', { tool: SUBAGENT }, async (_$, e) => {
    asked.push(e.capture);
    return { result: '{"action":"refused","started":false}' };
  });
  const ran = native(on);
  const input = {
    to: 'native-agent',
    recipient: WORKER,
    message: 'Do not redirect either address',
  };
  const result = await $.tool.call({ tool: 'SendMessage', tool_use_id: 'mixed', ...input });
  expect(asked).toEqual([
    { session_id: SESSION, tool_use_id: 'mixed', input, tool: 'SendMessage' },
  ]);
  expect(result.result).toMatchObject({ success: false });
  expect(ran).toEqual([]);
});

test('a validated local refusal preserves its actionable reason without native fallback', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  const refusal = {
    action: 'refused',
    started: false,
    reason: 'Original accounting is missing; restore its existing records before continuing.',
    instruction: 'No continuation started. Do not buy an uncertain invocation again.',
  };
  on('tool.call', { tool: SUBAGENT }, async () => ({
    result: JSON.stringify({ ...refusal, extra: 'UNVALIDATED_EXTRA' }),
  }));
  const ran = native(on);
  const result = await $.tool.call({
    tool: 'SendMessage',
    tool_use_id: 'local_refusal',
    to: WORKER,
    message: 'Continue',
  });
  expect(result.result).toEqual({ success: false, message: JSON.stringify(refusal) });
  expect(ran).toEqual([]);
});

test('ordinary native addresses and mentions in message text retain native behavior', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  const asked: unknown[] = [];
  on('tool.call', { tool: SUBAGENT }, async (_$, e) => {
    asked.push(e.capture);
    return { result: '{"action":"native"}' };
  });
  const ran = native(on);
  const input = { ...ASSIGNMENT, resume: 'native-agent-id' };
  await $.tool.call({ tool: 'Agent', tool_use_id: 'native_resume', ...input });
  await $.tool.call({
    tool: 'SendMessage',
    tool_use_id: 'native_message',
    to: 'native-agent-id',
    message: `The text mentions ${WORKER}; this is not its address.`,
  });
  expect(ran).toEqual(['native_resume', 'native_message']);
  expect(asked).toEqual([
    { session_id: SESSION, tool_use_id: 'native_resume', input, tool: 'Agent' },
  ]);
});
