import type { On } from 'claude-code';
import { expect, test } from 'claude-code/testing';
import { DATA, OFFER, SESSION, SURFACES, machine, shownLines } from './fixtures';

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
      native_replay: true,
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
  expect(result.context?.join(' ')).toContain('enabled DeepSeek routing');
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
  expect(held.context?.join(' ')).toContain('enabled DeepSeek routing');
  expect(held.context?.join(' ')).toContain('binding model/privacy restrictions');
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
  expect(result.context?.join(' ')).toContain('enabled DeepSeek routing');
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

test('mixed owned and native addresses are held before capture or native delivery', async ($, on) => {
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
  expect(asked).toEqual([]);
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

test('a durable replay refusal holds a full native call even without a local observation of its id', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  // A fresh mod has no marker or expanded-ID observation. Only the local backend's
  // durable replay index knows this complete call ID was already consumed.
  const refusal = {
    action: 'refused',
    started: false,
    reason: 'Native replay changed, expired, foreign, interrupted or already used',
    instruction: 'No native retry started. Use the complete original native call if appropriate.',
  };
  const captured: unknown[] = [];
  on('tool.call', { tool: SUBAGENT }, async (_$, e) => {
    captured.push(e.capture);
    return { result: JSON.stringify(refusal) };
  });
  const ran = native(on);
  const result = await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'persisted_replay_after_mod_reload',
    ...ASSIGNMENT,
  });
  expect(captured).toEqual([
    {
      session_id: SESSION,
      tool_use_id: 'persisted_replay_after_mod_reload',
      input: ASSIGNMENT,
      tool: 'Agent',
      native_replay: true,
    },
  ]);
  expect(result.result).toMatchObject({
    status: 'completed',
    content: [{ type: 'text', text: JSON.stringify(refusal) }],
    canContinueAgent: false,
  });
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

test('a held Agent call draws as the offer it is, never as a finished subagent with zero counts', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  let answer: unknown = offered;
  on('tool.call', { tool: SUBAGENT }, async () => ({ result: answer as string }));
  native(on);
  on('ui.render', { component: 'ToolUse' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['engine row'] }),
  );
  on('ui.render', { component: 'ToolResult' }, ($, e) =>
    $.ui.resolve(e).Text({ children: ['engine result'] }),
  );
  const offer = (await $.tool.call({ tool: 'Agent', tool_use_id: 'agent_offer', ...ASSIGNMENT }))
    .result;
  answer = JSON.stringify({
    action: 'refused',
    started: false,
    reason: 'Original accounting is missing.',
    instruction: 'No worker started.',
  });
  const refused = (await $.tool.call({ tool: 'Agent', tool_use_id: 'agent_held', ...ASSIGNMENT }))
    .result;
  const row = (id: string, output: unknown) => ({
    tool_use_id: id,
    tool: 'Agent',
    input: ASSIGNMENT,
    isRunning: false,
    isErrored: false,
    isInterrupted: false,
    output,
  });
  for (const surface of SURFACES) {
    for (const [props, shown] of [
      [
        row('agent_offer', offer),
        '⏺Agent(Read the selected file) · Tenjin offered DeepSeek · cap $1.00',
      ],
      [row('agent_held', refused), '⏺Agent(Read the selected file) · Tenjin held it · not started'],
    ] as const) {
      const drawn = await $.ui.mount({ plugin: 'tenjin', surface, component: 'ToolUse', props });
      const lines = (await shownLines(drawn)).join('');
      expect(lines).toBe(shown);
      expect(lines).not.toMatch(/Done|tool uses|tokens/);
      await drawn.unmount();
      const result = {
        tool_use_id: props.tool_use_id,
        tool: 'Agent',
        output: props.output,
        isErrored: false,
      };
      const compact = await $.ui.mount({
        plugin: 'tenjin',
        surface,
        component: 'ToolResult',
        props: result,
      });
      expect(await shownLines(compact)).toEqual([]);
      await compact.unmount();
      const full = await $.ui.mount({
        plugin: 'tenjin',
        surface,
        component: 'ToolResult',
        props: { ...result, isExpanded: true },
      });
      expect(await shownLines(full)).toEqual(['engine result']);
      await full.unmount();
    }
    // A subagent that really ran keeps the engine's own row and result.
    const ran = row('native_agent', {
      ...(offer as Record<string, unknown>),
      agentId: 'a1b2c3',
      totalToolUseCount: 4,
    });
    const nativeRow = await $.ui.mount({
      plugin: 'tenjin',
      surface,
      component: 'ToolUse',
      props: ran,
    });
    expect(await shownLines(nativeRow)).toEqual(['engine row']);
    await nativeRow.unmount();
  }
});
