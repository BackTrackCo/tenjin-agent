import type { On, TurnStepChunk, TurnStepResult } from 'claude-code';
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
    recipients: ['Tenjin', 'DeepSeek', 'Exa'],
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

test('an explicit native decision or invalid offer passes the original Agent call through', async ($, on) => {
  machine(on);
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
  machine(on);
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
  // The host shows a held call as a refusal, so the text says first what happened.
  expect(result.result).toMatchObject({ success: false });
  const said = (result.result as { message: string }).message;
  expect(said).toMatch(/^Not delivered yet: /);
  expect(said).toContain(offered);
  expect(result.context?.join(' ')).toContain('no continuation started');
  expect(result.context?.join(' ')).toContain('turned DeepSeek subagents on');
  // A native SendMessage resumes its subagent with no confirmation: run it or cancel it.
  expect(result.context?.join(' ')).toContain('subagent tool and this offer_id');
  expect(result.context?.join(' ')).not.toMatch(/veto|risk rules/);
  // What binds an assignment binds a follow-up: it goes to another model.
  expect(result.context?.join(' ')).toContain('binding model, privacy and planning restrictions');
});

// Failure caught: a message the worker took read to the parent as `{success: false}`, a
// failure. The host lets a hook answer the call, so it answers as a native send does.
for (const [action, message] of [
  [
    'delivered',
    `Delivered to the DeepSeek worker ${WORKER}: it reads your message at its next turn.`,
  ],
  ['continued', `The DeepSeek worker ${WORKER} continues with your message.`],
] as const)
  test(`SendMessage to a worker that took the message (${action}) answers as a native send does`, async ($, on) => {
    machine(on);
    const text = JSON.stringify({
      action,
      worker_handle: WORKER,
      message,
      ...(action === 'continued' ? { offer_id: OFFER } : {}),
    });
    on('tool.call', { tool: SUBAGENT }, async () => ({ result: text, text }));
    const ran = native(on);
    const input = { to: WORKER, message: 'The head moved to abc123. Final line: DONE.' };
    const result = await $.tool.call({
      tool: 'SendMessage',
      tool_use_id: `send_${action}`,
      ...input,
    });
    expect(ran).toEqual([]);
    expect(result.result).toEqual({ success: true, message });
    expect(result.deny).toBeUndefined();
  });

test('Agent resume compatibility holds the owned handle through the same captured offer path', async ($, on) => {
  machine(on);
  const asked: unknown[] = [];
  // As the handoff answers a follow-up to an owned worker: the same offer, marked.
  const followUp = JSON.stringify({ ...JSON.parse(offered), continuation: true });
  on('tool.call', { tool: SUBAGENT }, async (_$, e) => {
    asked.push(e.capture);
    return { result: followUp, text: followUp };
  });
  const ran = native(on);
  const input = { ...ASSIGNMENT, resume: WORKER };
  const result = await $.tool.call({ tool: 'Agent', tool_use_id: 'resume_agent', ...input });
  expect(asked).toEqual([
    { session_id: SESSION, tool_use_id: 'resume_agent', input, tool: 'Agent' },
  ]);
  expect(ran).toEqual([]);
  expect(result.deny).toContain(`held it (offer ${OFFER})`);
  // A worker handle never runs natively, so the repeat is no way out: run it or cancel it.
  expect(result.deny).not.toContain('which runs it natively');
  expect(result.deny).toContain('subagent({cancel: offer_id})');
  expect(result.deny).toContain('no continuation started');
  expect(result.deny).not.toMatch(/final veto|risk rules/);
});

// Failure caught: a person who turned DeepSeek subagents on with an earlier build still has the
// saved setting, and an Agent call held for an offer that no consent can back.
test('a saved subagent setting holds no Agent or Task call: both run natively and the CLI is never asked', async ($, on) => {
  const { files } = machine(on);
  enabled(files);
  let asked = false;
  on('tool.call', { tool: SUBAGENT }, async () => {
    asked = true;
    return { result: offered, text: offered };
  });
  const ran = native(on);
  await $.tool.call({ tool: 'Agent', tool_use_id: 'saved_agent', ...ASSIGNMENT });
  await $.tool.call({ tool: 'Task', tool_use_id: 'saved_task', ...ASSIGNMENT });
  expect(asked).toBe(false);
  expect(ran).toEqual(['saved_agent', 'saved_task']);
});

test('reserved worker and unstarted-offer addresses never reach a native tool', async ($, on) => {
  machine(on);
  const refusal = {
    action: 'refused',
    started: false,
    reason: 'DeepSeek continuation is unavailable',
    instruction: 'No continuation started. Do not retry this owned handle through native tools.',
  };
  on('tool.call', { tool: SUBAGENT }, async () => ({ result: JSON.stringify(refusal) }));
  const ran = native(on);
  const agent = await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'off_owned_agent',
    ...ASSIGNMENT,
    resume: '  TENJIN-WORKER-malformed  ',
  });
  expect(agent.deny).toContain('Tenjin held this call and started nothing');
  expect(agent.deny).toContain('No continuation started');
  const send = await $.tool.call({
    tool: 'SendMessage',
    tool_use_id: 'off_owned_send',
    to: `tenjin-offer-${OFFER}`,
    message: 'Continue',
  });
  expect(send.result).toMatchObject({ success: false });
  expect(JSON.stringify(send.result)).toContain('No continuation started');
  expect(ran).toEqual([]);
});

test('owned continuations never fall through after a transport error or invalid response', async ($, on) => {
  machine(on);
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
    expect(agent.deny).toContain('Tenjin held this call and started nothing');
  }
  expect(ran).toEqual([]);
});

test('mixed owned and native addresses are held before capture or native delivery', async ($, on) => {
  machine(on);
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
  machine(on);
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

test('the main loop step reaches the engine unrewritten, so auto mode reviews the call that runs', async ($, on) => {
  machine(on);
  const asked: unknown[] = [];
  on('tool.call', { tool: SUBAGENT }, async (_$, e) => {
    asked.push(e.capture);
    return { result: '{"action":"native"}' };
  });
  // A keep-native marker from an older offer is now an ordinary call: nothing expands it.
  const marker = {
    description: 'Keep native',
    prompt: `tenjin-native:${OFFER}`,
    subagent_type: `tenjin-native-${OFFER}`,
  };
  const json = JSON.stringify(marker);
  const chunks: TurnStepChunk[] = [
    { kind: 'tool', index: 0, id: 'marker_call', name: 'Agent' },
    { kind: 'input', index: 0, json: json.slice(0, 20) },
    { kind: 'input', index: 0, json: json.slice(20) },
    { kind: 'stop', stopReason: 'tool_use', usage: null },
  ];
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    for (const chunk of chunks) yield chunk;
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ name: 'Agent', input: marker }],
      stopReason: 'tool_use',
      usage: null,
    };
  });
  const stream = $.turn.step({ turnId: 'main-turn', index: 0, model: 'inherit', messageCount: 0 });
  const seen: TurnStepChunk[] = [];
  let item = await stream.next();
  for (; !item.done; item = await stream.next()) seen.push(item.value);
  expect(seen).toEqual(chunks);
  expect(item.value.toolUses).toEqual([{ name: 'Agent', input: marker }]);
  expect(asked).toEqual([]);
});
