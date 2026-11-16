import type { On, TurnStepChunk, TurnStepResult } from 'claude-code';
import { expect, test, type TestBody } from 'claude-code/testing';
import { nativeRetryReference, rewriteNativeInputChunks } from '../hooks/model-native-retry';
import { DATA, OFFER, SESSION, machine } from './fixtures';

type Engine = Parameters<TestBody>[0];
const MCP = 'mcp__plugin_tenjin_router__subagent';
const ORIGINAL = {
  description: 'Read the selected source exactly',
  prompt: `Read src/example.ts.\n${'Keep this assignment intact. '.repeat(320)}\nRun exactly: rg --files src\nFinal output line: DONE.`,
  subagent_type: 'Explore',
  model: 'sonnet',
  max_turns: 500,
  run_in_background: false,
};
const ALIAS = {
  description: 'Keep native',
  prompt: `tenjin-native:${OFFER}`,
  subagent_type: `tenjin-native-${OFFER}`,
};
function setup(on: On, enabled = true) {
  const state = machine(on);
  state.files.set(`${DATA}/config.json`, JSON.stringify({ router: { subagents: enabled } }));
  return state;
}
function response(on: On, input: Record<string, unknown>, id: string, tool = 'Agent') {
  const json = JSON.stringify(input);
  const chunks: TurnStepChunk[] = [
    { kind: 'text', index: 0, text: 'Choosing the native path.\n' },
    { kind: 'thinking', index: 1, text: 'A visible thought is unchanged.' },
    { kind: 'tool', index: 2, id, name: tool },
    { kind: 'input', index: 2, json: json.slice(0, Math.floor(json.length / 2)) },
    { kind: 'input', index: 2, json: json.slice(Math.floor(json.length / 2)) },
    { kind: 'stop', stopReason: 'tool_use', usage: null },
  ];
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    for (const chunk of chunks) yield chunk;
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'Choosing the native path.\n',
      toolUses: [{ name: tool, input }],
      stopReason: 'tool_use',
      usage: null,
    };
  });
  return chunks;
}
async function collect($: Engine, agentId?: string) {
  const chunks: TurnStepChunk[] = [];
  const stream = $.turn.step({
    turnId: 'retry-turn',
    index: 0,
    model: 'inherit',
    messageCount: 0,
    ...(agentId ? { agentId } : {}),
  });
  while (true) {
    const value = await stream.next();
    if (value.done) return { chunks, result: value.value };
    chunks.push(value.value);
  }
}
const inputOf = (chunks: TurnStepChunk[]) =>
  JSON.parse(
    chunks
      .filter((c): c is Extract<TurnStepChunk, { kind: 'input' }> => c.kind === 'input')
      .map((c) => c.json)
      .join(''),
  ) as Record<string, unknown>;
const reply = (input = ORIGINAL, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ action: 'native_retry', offer_id: OFFER, tool: 'Agent', input, ...extra });

test('short veto arguments are restored before tool dispatch with the new call id and exact full input', async ($, on) => {
  setup(on);
  const originalChunks = response(on, ALIAS, 'native_retry_exact');
  const captures: unknown[] = [];
  on('tool.call', { tool: MCP }, async (_$, e) => {
    captures.push(e.capture);
    const text =
      (e.capture as { input: { prompt: string } }).input.prompt === ALIAS.prompt
        ? reply()
        : '{"action":"native"}';
    return { result: text, text };
  });
  const native: unknown[] = [];
  on('tool.call', { tool: 'Agent' }, (_$, e) => {
    native.push(e);
    return { result: 'native result' as never };
  });
  const stream = $.turn.step({ turnId: 'retry-turn', index: 0, model: 'inherit', messageCount: 0 });
  const first = await stream.next();
  expect(first.value).toEqual(originalChunks[0]);
  expect(captures).toEqual([]);
  const second = await stream.next();
  expect(second.value).toEqual(originalChunks[1]);
  expect(captures).toEqual([]);
  const chunks = [first.value, second.value] as TurnStepChunk[];
  let done: TurnStepResult | undefined;
  while (true) {
    const value = await stream.next();
    if (value.done) {
      done = value.value;
      break;
    }
    chunks.push(value.value);
  }
  expect(inputOf(chunks)).toEqual(ORIGINAL);
  expect(done?.toolUses).toEqual([{ name: 'Agent', input: ORIGINAL }]);
  expect(captures).toEqual([
    {
      session_id: SESSION,
      tool_use_id: 'native_retry_exact',
      input: ALIAS,
      tool: 'Agent',
      native_replay: true,
    },
  ]);
  const actual = await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'native_retry_exact',
    ...inputOf(chunks),
  });
  expect(actual.result).toBe('native result');
  expect(captures).toEqual([
    {
      session_id: SESSION,
      tool_use_id: 'native_retry_exact',
      input: ALIAS,
      tool: 'Agent',
      native_replay: true,
    },
    {
      session_id: SESSION,
      tool_use_id: 'native_retry_exact',
      input: ORIGINAL,
      tool: 'Agent',
      native_replay: true,
    },
  ]);
  expect(native).toEqual([{ tool: 'Agent', tool_use_id: 'native_retry_exact', ...ORIGINAL }]);
});

test('argument rewriting leaves opaque engine references and other tool blocks in their original order', () => {
  const chunks: TurnStepChunk[] = [
    { kind: 'engine', ref: 11 },
    { kind: 'tool', index: 1, id: 'opaque_retry', name: 'Agent' },
    { kind: 'input', index: 1, json: '{"prompt":' },
    { kind: 'engine', ref: 12 },
    { kind: 'input', index: 1, json: '"short"}' },
    { kind: 'engine', ref: 13 },
    { kind: 'tool', index: 2, id: 'other', name: 'Read' },
    { kind: 'input', index: 2, json: '{"file_path":"unchanged"}' },
  ];
  const rewritten = rewriteNativeInputChunks(chunks, new Map([[1, JSON.stringify(ORIGINAL)]]));
  expect(rewritten).toEqual([
    chunks[0],
    chunks[1],
    { ...chunks[2], json: JSON.stringify(ORIGINAL) },
    chunks[3],
    chunks[5],
    chunks[6],
    chunks[7],
  ]);
  for (const chunk of chunks.filter((c) => c.kind === 'engine')) expect(rewritten).toContain(chunk);
  expect(chunks[2]).toEqual({ kind: 'input', index: 1, json: '{"prompt":' });
});

test('a reserved subtype never expands through Task or becomes a native Task assignment', async ($, on) => {
  setup(on);
  response(on, ALIAS, 'native_retry_task', 'Task');
  on('tool.call', { tool: MCP }, async (_$, e) => ({
    result:
      (e.capture as { input: { prompt: string } }).input.prompt === ALIAS.prompt
        ? reply(ORIGINAL, { tool: 'Task' })
        : '{"action":"native"}',
  }));
  let dispatched: unknown;
  on('tool.call', { tool: 'Task' }, (_$, e) => {
    dispatched = e;
    return { result: 'native Task' as never };
  });
  const { chunks } = await collect($);
  expect(inputOf(chunks)).toEqual(ALIAS);
  expect(
    JSON.stringify(
      (await $.tool.call({ tool: 'Task', tool_use_id: 'native_retry_task', ...inputOf(chunks) }))
        .result,
    ),
  ).toContain('No native child started');
  expect(dispatched).toBeUndefined();
});

test('the original general-purpose profile comes only from the private saved-input reply', async ($, on) => {
  setup(on);
  response(on, ALIAS, 'native_retry_general_profile');
  const saved = { ...ORIGINAL, subagent_type: 'general-purpose' };
  on('tool.call', { tool: MCP }, () => ({ result: reply(saved) }));
  const { chunks } = await collect($);
  expect(inputOf(chunks)).toEqual(saved);
  expect(inputOf(chunks).subagent_type).toBe('general-purpose');
});

test('a non-text MCP block cannot supply the native retry envelope through a text property', async ($, on) => {
  setup(on);
  response(on, ALIAS, 'native_retry_nontext_block');
  on('tool.call', { tool: MCP }, () => ({
    result: { content: [{ type: 'image', text: reply() }] } as never,
    text: 'No text contract was returned.',
  }));
  const { chunks } = await collect($);
  expect(inputOf(chunks)).toEqual(ALIAS);
});

test('empty MCP text content retains the native response text fallback', async ($, on) => {
  setup(on);
  response(on, ALIAS, 'native_retry_empty_content');
  on('tool.call', { tool: MCP }, () => ({
    result: { content: [{ type: 'text', text: '' }] } as never,
    text: reply(),
  }));
  expect(inputOf((await collect($)).chunks)).toEqual(ORIGINAL);
});

test('retired and mixed shortcuts stay held without a lookup or native child', async ($, on) => {
  setup(on);
  const variants: Record<string, unknown>[] = [
    {
      description: 'Keep native',
      prompt: ALIAS.prompt,
      subagent_type: 'Explore',
      resume: `tenjin-offer-${OFFER}`,
    },
    { description: 'Keep native', prompt: ALIAS.prompt, subagent_type: 'Explore' },
    { description: 'Keep native', prompt: ALIAS.prompt, subagent_type: 'general-purpose' },
    { ...ALIAS, resume: `tenjin-offer-${OFFER}` },
    { ...ALIAS, model: 'sonnet' },
    { ...ALIAS, subagent_type: 'tenjin-native-foreign' },
    { ...ALIAS, prompt: 'A changed assignment' },
  ];
  let current = variants[0]!;
  let id = '';
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    yield { kind: 'tool', index: 0, id, name: 'Agent' };
    yield { kind: 'input', index: 0, json: JSON.stringify(current) };
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ name: 'Agent', input: current }],
      stopReason: 'tool_use',
      usage: null,
    };
  });
  let captures = 0;
  on('tool.call', { tool: MCP }, () => {
    captures++;
    return { result: reply() };
  });
  let ran = false;
  on('tool.call', { tool: 'Agent' }, () => {
    ran = true;
    return { result: 'unsafe' as never };
  });
  for (const [index, value] of variants.entries()) {
    current = value;
    id = `native_retry_retired_${index}`;
    expect(inputOf((await collect($)).chunks)).toEqual(value);
    expect(
      JSON.stringify((await $.tool.call({ tool: 'Agent', tool_use_id: id, ...value })).result),
    ).toContain('No native child started');
  }
  expect(captures).toBe(0);
  expect(ran).toBe(false);
});

test('expanded call ids still require the local ticket after routing is disabled or the transport fails', async ($, on) => {
  const { files } = setup(on);
  response(on, ALIAS, 'native_retry_config_change');
  let phase = 'normalize';
  let captures = 0;
  on('tool.call', { tool: MCP }, async () => {
    captures++;
    if (phase === 'error') throw Error('local transport unavailable');
    return { result: phase === 'normalize' ? reply() : '{"action":"refused","started":false}' };
  });
  let ran = false;
  on('tool.call', { tool: 'Agent' }, () => {
    ran = true;
    return { result: 'unsafe' as never };
  });
  const { chunks } = await collect($);
  expect(inputOf(chunks)).toEqual(ORIGINAL);
  files.set(`${DATA}/config.json`, JSON.stringify({ router: { subagents: false } }));
  phase = 'refused';
  const refused = await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'native_retry_config_change',
    ...inputOf(chunks),
  });
  expect(JSON.stringify(refused.result)).toContain('No native child started');
  phase = 'error';
  const failed = await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'native_retry_config_change',
    ...inputOf(chunks),
  });
  expect(JSON.stringify(failed.result)).toContain('No native child started');
  expect(captures).toBe(3);
  expect(ran).toBe(false);
});

test('failed local resolution cannot become a native call when a prior hook strips the marker', async ($, on) => {
  setup(on);
  response(on, ALIAS, 'native_retry_failed');
  let captures = 0;
  on('tool.call', { tool: MCP }, async () => {
    captures++;
    throw Error('Local lookup failed');
  });
  let ran = false;
  on('tool.call', { tool: 'Agent' }, () => {
    ran = true;
    return { result: 'unsafe native' as never };
  });
  const { chunks } = await collect($);
  expect(inputOf(chunks)).toEqual(ALIAS);
  const held = await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'native_retry_failed',
    ...ALIAS,
    prompt: 'A prior mod changed this prompt',
    subagent_type: 'Explore',
  });
  expect(JSON.stringify(held.result)).toContain('No native child started');
  expect(ran).toBe(false);
  expect(captures).toBe(1);
});

test('an incomplete model response never claims a native retry ticket', async ($, on) => {
  setup(on);
  on('turn.step', async function* () {
    yield { kind: 'tool', index: 0, id: 'native_retry_incomplete', name: 'Agent' };
    yield { kind: 'input', index: 0, json: JSON.stringify(ALIAS) };
    throw Error('provider stream closed');
  });
  let captures = 0;
  on('tool.call', { tool: MCP }, () => {
    captures++;
    return { result: reply() };
  });
  await expect(collect($)).rejects.toThrow();
  expect(captures).toBe(0);
});

test('foreign, mixed, malformed or changed local envelopes never restore a held assignment', async ($, on) => {
  setup(on);
  let text = '';
  let captures = 0;
  on('tool.call', { tool: MCP }, async () => {
    captures++;
    return { result: text, text };
  });
  let ran = false;
  on('tool.call', { tool: 'Agent' }, () => {
    ran = true;
    return { result: 'unsafe' as never };
  });
  const variants = [
    reply(ORIGINAL, { offer_id: 'f30fcbad-15d3-4515-86d5-5856048032bf' }),
    reply(ORIGINAL, { tool: 'Task' }),
    reply(ORIGINAL, { extra: 'not a local replay contract' }),
    reply({ ...ORIGINAL, tool_use_id: 'old-call' } as typeof ORIGINAL),
    reply({ ...ORIGINAL, agentId: 'other-agent' } as typeof ORIGINAL),
    reply({
      ...ORIGINAL,
      resume: 'tenjin-worker-f30fcbad-15d3-4515-86d5-5856048032bf',
    } as typeof ORIGINAL),
    reply({ ...ORIGINAL, subagent_type: `tenjin-native-${OFFER}` }),
    reply({ ...ORIGINAL, subagent_type: 'Plan' }),
    reply({ ...ORIGINAL, subagent_type: ['Explore'] } as unknown as typeof ORIGINAL),
    '{invalid',
    '{"action":"native"}',
  ];
  let current = ALIAS as Record<string, unknown>;
  let id = 'native_retry_envelope_0';
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    yield { kind: 'tool', index: 0, id, name: 'Agent' };
    yield { kind: 'input', index: 0, json: JSON.stringify(current) };
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [{ name: 'Agent', input: current }],
      stopReason: 'tool_use',
      usage: null,
    };
  });
  for (const [index, value] of variants.entries()) {
    text = value;
    id = `native_retry_envelope_${index}`;
    current = ALIAS;
    const { chunks } = await collect($);
    expect(inputOf(chunks)).toEqual(ALIAS);
    const held = await $.tool.call({ tool: 'Agent', tool_use_id: id, ...ALIAS });
    expect(JSON.stringify(held.result)).toContain('No native child started');
  }
  expect(captures).toBe(variants.length);
  expect(ran).toBe(false);
});

test('disabled and nested calls keep their original stream and refuse literal retry markers', async ($, on) => {
  const { files } = setup(on, false);
  const original = response(on, ALIAS, 'native_retry_disabled');
  let captures = 0;
  on('tool.call', { tool: MCP }, () => {
    captures++;
    return { result: reply() };
  });
  let ran = false;
  on('tool.call', { tool: ['Agent', 'Task'] }, () => {
    ran = true;
    return { result: 'unsafe' as never };
  });
  expect((await collect($)).chunks).toEqual(original);
  expect(
    JSON.stringify(
      (await $.tool.call({ tool: 'Agent', tool_use_id: 'native_retry_disabled', ...ALIAS })).result,
    ),
  ).toContain('No native child started');
  files.set(`${DATA}/config.json`, JSON.stringify({ router: { subagents: true } }));
  expect((await collect($, 'native-child')).chunks).toEqual(original);
  expect(
    JSON.stringify(
      (
        await $.tool.call({
          tool: 'Task',
          tool_use_id: 'native_retry_nested',
          agentId: 'native-child',
          ...ALIAS,
        })
      ).result,
    ),
  ).toContain('No native child started');
  expect(captures).toBe(0);
  expect(ran).toBe(false);
});

test('buffer limits pass oversized ordinary assignments through without limiting or replaying them', async ($, on) => {
  setup(on);
  const large = { ...ORIGINAL, prompt: 'An ordinary full assignment. '.repeat(25_000) };
  const original = response(on, large, 'native_retry_ordinary_large');
  let captures = 0;
  on('tool.call', { tool: MCP }, () => {
    captures++;
    return { result: reply() };
  });
  expect((await collect($)).chunks).toEqual(original);
  expect(captures).toBe(0);
});

test('an oversized recognized shortcut cannot be stripped into a native retry by an earlier guard', async ($, on) => {
  setup(on);
  const large = { ...ALIAS, description: 'Long alias description. '.repeat(25_000) };
  const original = response(on, large, 'native_retry_large_marker');
  let captures = 0;
  on('tool.call', { tool: MCP }, () => {
    captures++;
    return { result: reply() };
  });
  let ran = false;
  on('tool.call', { tool: 'Agent' }, () => {
    ran = true;
    return { result: 'unsafe' as never };
  });
  expect((await collect($)).chunks).toEqual(original);
  const held = await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'native_retry_large_marker',
    prompt: 'A guard changed this input',
  });
  expect(JSON.stringify(held.result)).toContain('No native child started');
  expect(captures).toBe(0);
  expect(ran).toBe(false);
});

test('reserved marker parsing never treats ordinary mentions as a control request', () => {
  expect(nativeRetryReference(ALIAS, 'Agent')).toEqual({ owned: true, id: OFFER });
  for (const input of [
    { ...ALIAS, prompt: `  TENJIN-NATIVE:${OFFER} ` },
    { ...ALIAS, prompt: 'tenjin-native:not-a-job' },
    { ...ALIAS, model: 'haiku' },
    { ...ALIAS, subagent_type: ['Explore'] },
    { ...ALIAS, subagent_type: 'Explore' },
    { ...ALIAS, subagent_type: 'general-purpose' },
    { ...ALIAS, subagent_type: undefined },
    { ...ALIAS, subagent_type: `tenjin-native-f30fcbad-15d3-4515-86d5-5856048032bf` },
    { ...ALIAS, run_in_background: false },
    { ...ALIAS, resume: 'native-agent' },
    { ...ALIAS, resume: `tenjin-offer-${OFFER}`, subagent_type: 'Explore' },
    { ...ALIAS, resume: `tenjin-offer-${OFFER}` },
    { prompt: 'A changed prompt', resume: `tenjin-offer-${OFFER}` },
    { prompt: 'A changed prompt', resume: 'tenjin-offer-malformed' },
    { prompt: 'A changed prompt', subagent_type: `tenjin-native-${OFFER}` },
    { prompt: 'A changed prompt', subagent_type: 'tenjin-native-malformed' },
    { ...ALIAS, agentId: 'nested-agent' },
  ])
    expect(nativeRetryReference(input, 'Agent')).toEqual({ owned: true });
  expect(nativeRetryReference(ALIAS, 'Task')).toEqual({ owned: true });
  expect(
    nativeRetryReference({ prompt: `Explain the literal marker tenjin-native:${OFFER}.` }, 'Agent'),
  ).toEqual({ owned: false });
  expect(nativeRetryReference({ prompt: ALIAS.prompt }, 'SendMessage')).toEqual({ owned: true });
});
