import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context';
import { CliError } from '../lib/errors';
import type { runPay } from '../commands/pay';
import type { ModelJob } from './model-job';
import { modelSettings, neonConsent, modelConsent } from './model-settings';
import {
  ModelCallFailed,
  retryableModelCall,
  withModelRetry,
  workerEndText,
} from './model-worker-control';
import { messagesRequest, NEON_TURN_MAX_TOKENS, neonRoute } from './neon-chat';
import { NeonTransport, readNeonRecord } from './neon-transport';
import { ModelHandoff, NEON_CONSENT_REFUSAL } from './model-handoff';
import type { ModelTransport } from './model-transport';

let dir: string;
// The tests below the Messages section drive the chat completions route, which the env keeps.
beforeEach(() => {
  vi.stubEnv('TENJIN_NEON_ROUTE', 'chat');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function fixture(router: Record<string, unknown>, limits: Record<string, unknown> = {}) {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'neon-')));
  const data = join(dir, 'data');
  const repo = join(dir, 'repo');
  await mkdir(data);
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(join(data, 'config.json'), JSON.stringify({ ...limits, router }));
  const ctx: CommandContext = {
    flags: { json: true, timeout: 30_000 } as CommandContext['flags'],
    dataDir: data,
    io: { stdout: process.stdout, stderr: process.stderr, isTTY: false },
  };
  return { data, repo, ctx };
}

const job = (repo: string, capAtomic = '1000000'): ModelJob => ({
  id: '6f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a11',
  sessionId: 's',
  turnId: 't',
  callId: 'c',
  root: repo,
  task: 'Write the release notes',
  native: { prompt: 'Write the release notes', subagent_type: 'general-purpose' },
  decision: { provider: 'neon', maxOutputTokens: NEON_TURN_MAX_TOKENS },
  capAtomic,
  state: 'running',
  expiresAt: Date.now() + 60_000,
});

const MESSAGES = {
  model: 'deepseek-flash',
  max_tokens: 65_536,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Write it.' }] }],
};

const REPLY = {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Release notes.' } }],
  usage: { prompt_tokens: 40, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 8 } },
};

/** A payer that answers like the CLI's: a result, or the failure it would throw. */
function payer(answer: (args: Parameters<typeof runPay>[0]) => unknown | Promise<unknown>) {
  return vi.fn(async (args: Parameters<typeof runPay>[0]) => {
    const value = await answer(args);
    if (value instanceof Error) throw value;
    return { data: value } as Awaited<ReturnType<typeof runPay>>;
  });
}
const streamed = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Release notes.' }, finish_reason: 'stop' }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: REPLY.usage })}\n\ndata: [DONE]\n\n`;
const paidAnswer = (amount = '9000', tx: string | undefined = '0xabc') => ({
  status: 200,
  body: REPLY,
  amountPaid: { atomic: amount },
  ...(tx ? { settlementTxHash: tx } : {}),
});

function transport(
  ctx: CommandContext,
  pay: ReturnType<typeof payer>,
  now: () => number = Date.now,
) {
  return new NeonTransport({
    dataDir: ctx.dataDir,
    ctx,
    provider: {} as never,
    authorizer: {} as never,
    pay: pay as unknown as typeof runPay,
    now,
  });
}

const consented = { neon: true, neonConsent: neonConsent({}) };

it('pays BlockRun at most the output cap per turn and records the job for the expected-spend prior', async () => {
  const { ctx, repo, data } = await fixture(consented);
  const pay = payer(() => paidAnswer());
  let clock = 1_000;
  const neon = transport(ctx, pay, () => (clock += 500));
  const sent = job(repo);
  const message = await neon.withInferenceRun(sent.id, new AbortController().signal, (t) =>
    t.messages(sent, MESSAGES, new AbortController().signal),
  );
  expect(message).toMatchObject({ stop_reason: 'end_turn', content: [{ text: 'Release notes.' }] });
  // The worker asked for 65,536 output tokens; the paid request carries the cap.
  const request = JSON.parse(pay.mock.calls[0]![0].rawBody!);
  expect(request.max_tokens).toBe(NEON_TURN_MAX_TOKENS);
  expect(request.model).toBe('google/gemini-4-neon');
  // Streamed, so a long turn is not cut by a gateway's idle limit.
  expect(request.stream).toBe(true);
  expect(request.reasoning_effort).toBe('low');
  expect(pay.mock.calls[0]![0]).toMatchObject({
    url: 'https://blockrun.ai/api/v1/chat/completions',
    execution: 'router',
    terms: { network: 'eip155:8453', maxAmountAtomic: '1000000' },
  });
  const record = await readNeonRecord(data, sent.id);
  expect(record).toMatchObject({
    taskClass: 'writing',
    spentAtomic: '9000',
    settledAtomic: '9000',
    calls: [
      {
        n: 1,
        inputTokens: 40,
        cachedInputTokens: 8,
        outputTokens: 12,
        maxTokens: NEON_TURN_MAX_TOKENS,
        quotedAtomic: '9000',
        settledAtomic: '9000',
        settlement: 'settled',
      },
    ],
  });
  expect(record!.wallMs).toBeGreaterThan(0);
  expect(await neon.summary(sent)).toEqual({
    reservedAtomic: '9000',
    actualAtomic: '9000',
    uncertain: [],
  });
});

it('meets the job ceiling and the daily budget through the same plan the other paid calls meet', async () => {
  const { ctx, repo } = await fixture(consented, { maxAutoSpend: '20000' });
  // The payer asks the call's plan for a slot at the live price, before anything is signed.
  const pay = payer(async (args) => {
    try {
      await args.admit!(50_000n);
    } catch (error) {
      return error;
    }
    return paidAnswer();
  });
  const neon = transport(ctx, pay);
  const sent = job(repo, '10000');
  const failure = await neon
    .messages(sent, MESSAGES, new AbortController().signal)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ModelCallFailed);
  // Over the person's limit: nothing was signed, so it is proven unpaid and ends the job.
  expect((failure as ModelCallFailed).detail).toMatchObject({ cause: 'budget', uncharged: true });
});

it('never sends a turn the job ceiling cannot hold', async () => {
  const { ctx, repo } = await fixture(consented);
  const pay = payer(() => paidAnswer());
  const neon = transport(ctx, pay);
  // Room for less than the least call.
  const failure = await neon
    .messages(job(repo, '500'), MESSAGES, new AbortController().signal)
    .catch((error: unknown) => error);
  expect((failure as ModelCallFailed).detail).toMatchObject({ cause: 'budget', uncharged: true });
  expect(pay).not.toHaveBeenCalled();
});

it('does not try a paid call again: a failure after the authorization left ends the job and stays counted', async () => {
  const { ctx, repo, data } = await fixture(consented);
  const pay = payer(
    () =>
      new CliError('PAYMENT_FAILED', 'The endpoint answered 502 on the paid request.', {
        details: { status: 502, amountAtomic: '12345', settlement: 'unknown' },
      }),
  );
  const neon = transport(ctx, pay);
  const sent = job(repo);
  const waits: number[] = [];
  const failure = await withModelRetry(
    () => neon.messages(sent, MESSAGES, new AbortController().signal),
    new AbortController().signal,
    () => undefined,
    async (ms) => void waits.push(ms),
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ModelCallFailed);
  const detail = (failure as ModelCallFailed).detail;
  expect(detail.uncharged).toBeUndefined();
  expect(retryableModelCall(failure)).toBe(false);
  // One payment, no retry.
  expect(pay).toHaveBeenCalledTimes(1);
  expect(waits).toEqual([]);
  // The amount at risk counts against the job, as uncertain.
  const summary = await neon.summary(sent);
  expect(summary).toMatchObject({ reservedAtomic: '12345', actualAtomic: '0' });
  expect(summary.uncertain).toEqual(['call-1']);
  expect((await readNeonRecord(data, sent.id))!.calls[0]).toMatchObject({
    ok: false,
    settlement: 'unknown',
    quotedAtomic: '12345',
  });
});

it('tries a call again only when nothing was signed, as for any request that cost nothing', async () => {
  const { ctx, repo } = await fixture(consented);
  let attempts = 0;
  const pay = payer(() =>
    ++attempts === 1
      ? new CliError('API_UNREACHABLE', 'blockrun answered 503.', { details: { status: 503 } })
      : paidAnswer(),
  );
  const neon = transport(ctx, pay);
  const message = await withModelRetry(
    () => neon.messages(job(repo), MESSAGES, new AbortController().signal),
    new AbortController().signal,
    () => undefined,
    async () => undefined,
  );
  expect(message).toMatchObject({ stop_reason: 'end_turn' });
  expect(pay).toHaveBeenCalledTimes(2);
});

it('treats an error it cannot place as possibly charged', async () => {
  const { ctx, repo } = await fixture(consented);
  const pay = payer(() => new Error('socket hang up'));
  const failure = await transport(ctx, pay)
    .messages(job(repo), MESSAGES, new AbortController().signal)
    .catch((error: unknown) => error);
  expect(retryableModelCall(failure)).toBe(false);
  expect((failure as ModelCallFailed).detail.uncharged).toBeUndefined();
});

it('keeps Neon consent apart from the DeepSeek consent', async () => {
  const deepseek = {
    subagents: true,
    subagentConsent: modelConsent({ routerOrigin: 'https://tenjin.sh' }),
  };
  const only = await fixture(deepseek);
  // DeepSeek subagents on grants nothing to Neon.
  expect(await modelSettings(only.data, only.repo, 'neon')).toBeNull();
  expect(await modelSettings(only.data, only.repo)).not.toBeNull();
  await writeFile(
    join(only.data, 'config.json'),
    JSON.stringify({ router: { neon: true, neonConsent: neonConsent({}) } }),
  );
  // And Neon on grants nothing to DeepSeek.
  expect(await modelSettings(only.data, only.repo, 'neon')).toMatchObject({
    routerOrigin: 'https://blockrun.ai',
  });
  expect(await modelSettings(only.data, only.repo)).toBeNull();
  expect(neonConsent({}).recipients).toEqual(['BlockRun', 'Google']);
});

it('refuses the explicit door without Neon consent, naming the consent step, and holds nothing', async () => {
  const { data, repo } = await fixture({
    subagents: true,
    subagentConsent: modelConsent({ routerOrigin: 'https://tenjin.sh' }),
  });
  const handoff = new ModelHandoff({
    dataDir: data,
    transport: { origin: 'https://tenjin.sh' } as unknown as ModelTransport,
  });
  const answer = await handoff.neon(
    { sessionId: 's', turnId: 't', cwd: repo, transcript: '', claudePermissionMode: 'default' },
    { prompt: 'Write the changelog' },
  );
  expect(answer).toEqual({ action: 'refused', reason: NEON_CONSENT_REFUSAL, charged: false });
  expect(NEON_CONSENT_REFUSAL).toContain('tenjin config neon on');
  expect(await handoff.store.owned('00000000-0000-4000-8000-000000000000', 's')).toBeNull();
  // No held call and no routing: the store has no job for the session at all.
  expect(await handoff.store.unfinished()).toEqual([]);
});

it('reads a streamed reply that arrives as text, and words an end for BlockRun, not Tenjin', async () => {
  const { ctx, repo } = await fixture(consented);
  const pay = payer(() => ({
    status: 200,
    bodyText: streamed,
    amountPaid: { atomic: '9000' },
    settlementTxHash: '0xabc',
  }));
  const message = await transport(ctx, pay).messages(
    job(repo),
    MESSAGES,
    new AbortController().signal,
  );
  expect(message).toMatchObject({
    content: [{ text: 'Release notes.' }],
    usage: { output_tokens: 12 },
  });
  expect(workerEndText('model_call_failed', 'neon')).toBe(
    'Its model call to BlockRun returned no result; that call stays reserved until its receipt is read.',
  );
  expect(workerEndText('model_call_failed', 'deepseek')).toContain('through Tenjin');
});

it('records a streamed call with no receipt as charged at its quote, never as nothing spent', async () => {
  const { ctx, repo, data } = await fixture(consented);
  const pay = payer(() => ({ status: 200, bodyText: streamed, amountPaid: { atomic: '9000' } }));
  const neon = transport(ctx, pay);
  const sent = job(repo);
  await neon.messages(sent, MESSAGES, new AbortController().signal);
  expect((await readNeonRecord(data, sent.id))!.calls[0]).toMatchObject({
    settlement: 'settled',
    settledAtomic: '9000',
  });
  expect(await neon.summary(sent)).toMatchObject({ reservedAtomic: '9000', actualAtomic: '9000' });
});

it('ends the job, with no second try, when a turn spends its cap and writes nothing', async () => {
  const { ctx, repo } = await fixture(consented);
  const empty = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`;
  const pay = payer(() => ({ status: 200, bodyText: empty, amountPaid: { atomic: '9000' } }));
  const failure = await withModelRetry(
    () => transport(ctx, pay).messages(job(repo), MESSAGES, new AbortController().signal),
    new AbortController().signal,
    () => undefined,
    async () => undefined,
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({ stop: { kind: 'provider_limit', reason: 'output_limit' } });
  expect(pay).toHaveBeenCalledTimes(1);
});

it('does not try a quote above the job ceiling again: that is a budget end, not a transient failure', async () => {
  const { ctx, repo } = await fixture(consented);
  const pay = payer(
    () => new CliError('REGISTRY_MISMATCH', 'The live 402 exceeds the terms.', { details: {} }),
  );
  const failure = await withModelRetry(
    () => transport(ctx, pay).messages(job(repo), MESSAGES, new AbortController().signal),
    new AbortController().signal,
    () => undefined,
    async () => undefined,
  ).catch((error: unknown) => error);
  expect((failure as ModelCallFailed).detail).toMatchObject({ cause: 'budget', uncharged: true });
  expect(pay).toHaveBeenCalledTimes(1);
});

it('keeps a call raw stream and request only when asked, and never the system prompt text', async () => {
  const { ctx, repo, data } = await fixture(consented);
  const pay = payer(() => ({ status: 200, bodyText: streamed, amountPaid: { atomic: '9000' } }));
  const sent = job(repo);
  await transport(ctx, pay).messages(
    sent,
    { ...MESSAGES, system: 'SECRET-SYSTEM-PROMPT' },
    new AbortController().signal,
  );
  const folder = join(data, 'model-jobs', `${sent.id}.neon-raw`);
  await expect(readFile(join(folder, 'call-1.request.json'), 'utf8')).rejects.toThrow();
  vi.stubEnv('TENJIN_NEON_CAPTURE', '1');
  try {
    await transport(ctx, pay).messages(
      { ...sent, id: '7f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a12' },
      { ...MESSAGES, system: 'SECRET-SYSTEM-PROMPT' },
      new AbortController().signal,
    );
  } finally {
    vi.unstubAllEnvs();
  }
  const kept = join(data, 'model-jobs', '7f2f8f0e-2b64-4b4f-9a39-6d3b2f1c0a12.neon-raw');
  expect(await readFile(join(kept, 'call-1.response.sse'), 'utf8')).toBe(streamed);
  const request = await readFile(join(kept, 'call-1.request.json'), 'utf8');
  expect(request).not.toContain('SECRET-SYSTEM-PROMPT');
  expect(JSON.parse(request).messages[0]).toMatchObject({ role: 'system', content: { bytes: 22 } });
});

// ---- The Messages route, which is the default ----
const event = (type: string, body: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
const anthropicStream = (
  blocks: string[],
  stop = 'end_turn',
  usage: Record<string, unknown> = {
    input_tokens: 40,
    cache_read_input_tokens: 8,
    output_tokens: 12,
  },
) =>
  event('message_start', {
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [],
      usage: { input_tokens: 40, output_tokens: 1 },
    },
  }) +
  blocks.join('') +
  event('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage }) +
  event('message_stop', {});
const textBlock = (text: string, index = 0) =>
  event('content_block_start', { index, content_block: { type: 'text', text: '' } }) +
  event('content_block_delta', { index, delta: { type: 'text_delta', text } }) +
  event('content_block_stop', { index });

it('sends the worker request to /v1/messages with a thinking budget under the cap, and folds the reply', async () => {
  vi.unstubAllEnvs();
  const { ctx, repo, data } = await fixture(consented);
  const thinking =
    event('content_block_start', {
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }) +
    event('content_block_delta', {
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me see.' },
    }) +
    event('content_block_delta', {
      index: 0,
      delta: { type: 'signature_delta', signature: 'SIG-A' },
    }) +
    event('content_block_stop', { index: 0 });
  const tool =
    event('content_block_start', {
      index: 2,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
    }) +
    event('content_block_delta', {
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '{"file_path":' },
    }) +
    event('content_block_delta', {
      index: 2,
      delta: { type: 'input_json_delta', partial_json: '"/a.md"}' },
    }) +
    event('content_block_stop', { index: 2 });
  const pay = payer(() => ({
    status: 200,
    bodyText: anthropicStream([thinking, textBlock('Reading.', 1), tool], 'tool_use'),
    amountPaid: { atomic: '9000' },
  }));
  const sent = job(repo);
  const message = await transport(ctx, pay).messages(
    sent,
    { ...MESSAGES, thinking: { type: 'enabled' }, system: 'Write.' },
    new AbortController().signal,
  );
  const call = pay.mock.calls[0]![0];
  expect(call.url).toBe('https://blockrun.ai/api/v1/messages');
  expect(JSON.parse(call.rawBody!)).toMatchObject({
    model: 'google/gemini-4-neon',
    max_tokens: NEON_TURN_MAX_TOKENS,
    stream: true,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    system: 'Write.',
  });
  expect(message).toMatchObject({
    stop_reason: 'tool_use',
    model: 'deepseek-flash',
    content: [
      { type: 'thinking', thinking: 'Let me see.', signature: 'SIG-A' },
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.md' } },
    ],
    usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 8 },
  });
  expect((await readNeonRecord(data, sent.id))!.calls[0]).toMatchObject({
    inputTokens: 48,
    cachedInputTokens: 8,
    outputTokens: 12,
    settlement: 'settled',
  });
});

it('ends the job on a Messages turn that spent its cap on thought, and never sends it again', async () => {
  vi.unstubAllEnvs();
  const { ctx, repo } = await fixture(consented);
  const thought =
    event('content_block_start', {
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    }) + event('content_block_stop', { index: 0 });
  const pay = payer(() => ({
    status: 200,
    bodyText: anthropicStream([thought], 'max_tokens'),
    amountPaid: { atomic: '9000' },
  }));
  const failure = await withModelRetry(
    () => transport(ctx, pay).messages(job(repo), MESSAGES, new AbortController().signal),
    new AbortController().signal,
    () => undefined,
    async () => undefined,
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({ stop: { kind: 'provider_limit', reason: 'output_limit' } });
  expect(pay).toHaveBeenCalledTimes(1);
});

it('keeps the chat route only on TENJIN_NEON_ROUTE=chat, and the capture for either route', async () => {
  expect(neonRoute({})).toBe('messages');
  expect(neonRoute({ TENJIN_NEON_ROUTE: 'chat' })).toBe('chat');
  vi.unstubAllEnvs();
  vi.stubEnv('TENJIN_NEON_CAPTURE', '1');
  const { ctx, repo, data } = await fixture(consented);
  const pay = payer(() => ({
    status: 200,
    bodyText: anthropicStream([textBlock('Done.')]),
    amountPaid: { atomic: '9000' },
  }));
  const sent = job(repo);
  await transport(ctx, pay).messages(
    sent,
    {
      ...MESSAGES,
      system: 'SECRET-SYSTEM-PROMPT',
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    },
    new AbortController().signal,
  );
  const folder = join(data, 'model-jobs', `${sent.id}.neon-raw`);
  expect(await readFile(join(folder, 'call-1.response.sse'), 'utf8')).toContain('text_delta');
  const request = await readFile(join(folder, 'call-1.request.json'), 'utf8');
  expect(request).not.toContain('SECRET-SYSTEM-PROMPT');
  expect(JSON.parse(request)).toMatchObject({ tools: { count: 1 }, system: { bytes: 22 } });
});

it('steps the thinking budget down with the cap, and drops it where the cap leaves no room', () => {
  expect(messagesRequest({ messages: [] }, 8_192).thinking).toEqual({
    type: 'enabled',
    budget_tokens: 2_048,
  });
  expect(messagesRequest({ messages: [] }, 2_500).thinking).toEqual({
    type: 'enabled',
    budget_tokens: 1_476,
  });
  expect(messagesRequest({ messages: [] }, 2_000).thinking).toBeUndefined();
});
