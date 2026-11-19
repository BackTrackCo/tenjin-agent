import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it } from 'vitest';
import { FakeRouter, payerDeps, BASE, TEST_POLICY } from './fee-test-utils';
import { completedMessageSse } from './model-messages';
import { ModelTransport } from './model-transport';
import { readMessagesStream, StreamCut, type StreamEvent } from './model-stream';
import { ModelCallFailed, retryableModelCall } from './model-worker-control';
import type { ModelCallTiming } from './model-worker-diagnostics';
import type { ModelJob } from './model-job';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const reply = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'deepseek-flash',
  content: [{ type: 'text', text: 'Done' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 20, cache_read_input_tokens: 4, output_tokens: 5 },
};
const eventsOf = (message: Record<string, unknown>) =>
  completedMessageSse(message)
    .trim()
    .split('\n\n')
    .map((frame) => JSON.parse(frame.split('\ndata: ')[1]!) as StreamEvent);
const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const say = (content: string) => ({ messages: [{ role: 'user', content }] });

type Drive = (io: {
  events: (message?: Record<string, unknown>) => StreamEvent[];
  push: (text: string) => void;
  /** The last event: the response the whole answer would have been. */
  finish: (status?: number, body?: unknown) => void;
  /** The connection ends with no last event. */
  cut: () => void;
  signed: Request;
}) => Promise<void> | void;

async function fixture(
  options: {
    decision?: Record<string, unknown>;
    drive?: Drive;
    quote?: string;
    charge?: string;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'model-stream-'));
  made.push(dir);
  const repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: '1000000',
      router: {
        subagents: true,
        subagentConsent: {
          version: 2,
          instructions: 'applicable',
          reads: 'claude-home',
          recipients: ['Tenjin', 'DeepSeek', 'Exa'],
          repositories: [repo],
          maxJobAtomic: '1000000',
          routerOrigin: BASE,
        },
      },
    }),
  );
  const job: ModelJob = {
    id: randomUUID(),
    sessionId: 'root',
    turnId: '1',
    callId: 'call',
    root: repo,
    task: 'Read the fixture',
    native: {},
    decision: {
      jobId: randomUUID(),
      routingFeeAtomic: '3000',
      routingAuthorizedAtomic: '3000',
      messagesStream: 1,
      callIdleLimitMs: 300_000,
      ...options.decision,
    },
    capAtomic: '1000000',
    state: 'running',
    expiresAt: Date.now() + 60_000,
  };
  const router = new FakeRouter({
    path: '/api/model-proxy/messages',
    amount: options.quote ?? '500000',
    charge: options.charge ?? '1000',
    minDeposit: '50000',
  });
  const bodies: Record<string, unknown>[] = [];
  let signedSends = 0;
  let record = {
    state: 'completed',
    voucherState: 'accepted',
    actualAtomic: options.charge ?? '1000',
  };
  let lastResult: unknown;
  let lastId: unknown;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET')
      return Response.json({
        invocationId: lastId,
        ...record,
        result: lastResult,
      });
    const body = (await request.clone().json()) as Record<string, unknown>;
    bodies.push(body);
    lastId = body.invocationId;
    lastResult = {
      message: reply,
      receipt: {
        invocationId: body.invocationId,
        quoteAtomic: options.quote ?? '500000',
        actualAtomic: options.charge ?? '1000',
      },
    };
    const own = lastResult;
    const signed = request.headers.has('payment-signature');
    const answered = await router.fetch(request);
    if (answered.status !== 200) return answered;
    await answered.body?.cancel();
    if (signed) signedSends++;
    if (!signed || body.stream !== true || !options.drive)
      return Response.json(own, { headers: answered.headers });
    const headers: Record<string, string> = {};
    for (const name of ['payment-response', 'payment-required', 'retry-after']) {
      const value = answered.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    let control!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        control = c;
      },
    });
    void Promise.resolve(
      options.drive({
        events: (message = reply) => eventsOf(message),
        push: (text) => control.enqueue(encoder.encode(text)),
        finish: (status = 200, outcome = own) => {
          control.enqueue(
            encoder.encode(
              frame(status === 200 ? 'tenjin_result' : 'tenjin_error', {
                status,
                headers,
                body: outcome,
              }),
            ),
          );
          control.close();
        },
        // After what was pushed has been read: an errored stream drops its queue.
        cut: () => void setTimeout(() => control.error(new TypeError('terminated')), 20),
        signed: request,
      }),
    );
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'tenjin-model-stream': '1' },
    });
  };
  const deps = payerDeps(router, dir, privateKeyToAccount(generatePrivateKey()), {
    fetchImpl,
    policy: async () => ({ ...TEST_POLICY, maxAutoSpendAtomic: 1000000n }),
  });
  const make = () => new ModelTransport({ dataDir: dir, baseUrl: BASE, payerDeps: deps });
  return {
    job,
    make,
    bodies,
    signed: () => signedSends,
    setRecord: (next: Partial<typeof record>) => (record = { ...record, ...next }),
  };
}

const call = async (
  f: Awaited<ReturnType<typeof fixture>>,
  signal = new AbortController().signal,
  content = 'Read it',
) => {
  const got: StreamEvent[] = [];
  const timings: ModelCallTiming[] = [];
  const result = await f
    .make()
    .messages(
      f.job,
      say(content),
      signal,
      undefined,
      (t) => timings.push({ ...t }),
      (e) => got.push(e),
    )
    .then(
      (value): { value?: Record<string, unknown>; error?: ModelCallFailed } => ({ value }),
      (error: unknown): { value?: Record<string, unknown>; error?: ModelCallFailed } => ({
        error: error as ModelCallFailed,
      }),
    );
  return { got, timings, ...result };
};

it('states no stream, and gives no event, when the offer carries no field, or one it does not know', async () => {
  for (const decision of [
    { messagesStream: undefined },
    { messagesStream: 2 },
    { messagesStream: '1' },
    { messagesStream: true },
    { messagesStream: null },
  ]) {
    const f = await fixture({ decision, drive: () => expect.unreachable('no stream asked') });
    const { got, value } = await call(f);
    expect(value).toEqual(reply);
    expect(got).toEqual([]);
    // The request is today's, byte for byte: no `stream`, and the keys it always had.
    expect(f.bodies.every((body) => !('stream' in body))).toBe(true);
    expect(Object.keys(f.bodies[0]!)).toEqual([
      'schemaVersion',
      'consent',
      'jobId',
      'invocationId',
      'messages',
    ]);
  }
});

it('hands the events on as they arrive, before the stream ends, and settles as a whole answer does', async () => {
  const barrier = deferred();
  const first = deferred();
  const f = await fixture({
    drive: async ({ events, push, finish }) => {
      const all = events();
      push(frame(all[0]!.type, all[0]));
      push(': keep\n\n');
      push(frame(all[1]!.type, all[1]));
      await barrier.promise;
      for (const event of all.slice(2)) push(frame(event.type, event));
      finish();
    },
  });
  const got: StreamEvent[] = [];
  const timings: ModelCallTiming[] = [];
  const running = f.make().messages(
    f.job,
    say('Read it'),
    new AbortController().signal,
    undefined,
    (t) => timings.push({ ...t }),
    (event) => {
      got.push(event);
      if (got.length === 2) first.resolve();
    },
  );
  // Two events are with the caller while the call has neither its last event nor a result.
  await first.promise;
  expect(got.map((e) => e.type)).toEqual(['message_start', 'content_block_start']);
  barrier.resolve();
  await expect(running).resolves.toEqual(reply);
  expect(got.map((e) => e.type)).toEqual(eventsOf(reply).map((e) => e.type));
  expect(timings[0]!.ttfbMs).toBeDefined();
  expect(timings[0]!.ttfbMs!).toBeLessThanOrEqual(timings[0]!.answerMs!);
  expect(f.bodies.every((body) => body.stream === true)).toBe(true);
  // The same reply whole: the same charge and the same local state.
  const whole = await fixture({ decision: { messagesStream: undefined } });
  await call(whole);
  expect(await f.make().summary(f.job)).toEqual(await whole.make().summary(whole.job));
});

it.each([
  [
    'a tool use',
    {
      ...reply,
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } }],
      stop_reason: 'tool_use',
    },
  ],
  [
    'a thinking-only turn',
    {
      ...reply,
      content: [{ type: 'thinking', thinking: 'Considering.', signature: 'sig' }],
      stop_reason: 'max_tokens',
    },
  ],
])('relays %s in the provider order and returns the same message', async (_name, message) => {
  const f = await fixture({
    drive: ({ events, push, finish }) => {
      for (const event of events(message)) push(frame(event.type, event));
      finish(200, undefined);
    },
  });
  // The last event states the answer's body; here the reply is the fixture's own.
  const { got, value } = await call(f);
  expect(got.map((e) => e.type)).toEqual(eventsOf(message).map((e) => e.type));
  expect(got).toEqual(eventsOf(message));
  expect(value).toBeDefined();
});

it('treats a request that ended before any event as a whole answer, tried again only on proof of no charge', async () => {
  const f = await fixture({
    drive: ({ finish }) =>
      finish(504, { error: { code: 'model_stream_idle', message: 'stalled' } }),
  });
  f.setRecord({ state: 'unknown', voucherState: 'cancelled', actualAtomic: '0' });
  const { got, error } = await call(f);
  // No event left, so nothing says this was streamed: today's rules, today's retry.
  expect(got).toEqual([]);
  expect(error!.detail).toMatchObject({ uncharged: true, code: 'model_stream_idle' });
  expect(error!.detail.relayed).toBeUndefined();
  expect(retryableModelCall(error)).toBe(true);
});

it('does not try again a call cut after events, whatever the record says, and keeps the money right', async () => {
  const cutAfterEvents: Drive = ({ events, push, finish }) => {
    push(frame('message_start', events()[0]));
    finish(504, { error: { code: 'model_stream_idle', message: 'stalled' } });
  };
  // Proven uncharged by a cancelled voucher and a zero charge: released, never retried.
  const free = await fixture({ drive: cutAfterEvents });
  free.setRecord({ state: 'unknown', voucherState: 'cancelled', actualAtomic: '0' });
  const released = await call(free);
  expect(released.got.map((e) => e.type)).toEqual(['message_start']);
  expect(released.error!.detail).toMatchObject({ uncharged: true, relayed: true });
  expect(retryableModelCall(released.error)).toBe(false);
  expect(await free.make().summary(free.job)).toMatchObject({
    reservedAtomic: '3000',
    uncertain: [],
  });
  expect(free.signed()).toBe(1);
  // Charged or unreadable: uncertain, the reservation stays, nothing signed again.
  for (const record of [
    { state: 'unknown', voucherState: 'cancelled', actualAtomic: '1000' },
    { state: 'completed', voucherState: 'accepted', actualAtomic: '1000' },
  ]) {
    const f = await fixture({ drive: cutAfterEvents });
    f.setRecord(record);
    const { error } = await call(f);
    expect(error!.detail.uncharged).toBeUndefined();
    expect(error!.detail.relayed).toBe(true);
    expect(retryableModelCall(error)).toBe(false);
    expect(await f.make().summary(f.job)).toMatchObject({ uncertain: [expect.any(String)] });
    expect(f.signed()).toBe(1);
  }
});

it('keeps a stream that ends with no last event uncertain and never signs again', async () => {
  const f = await fixture({
    drive: ({ events, push, cut }) => {
      push(frame('message_start', events()[0]));
      cut();
    },
  });
  const { got, error } = await call(f);
  expect(got).toHaveLength(1);
  expect(error).toBeInstanceOf(ModelCallFailed);
  expect(error!.detail.relayed).toBe(true);
  expect(retryableModelCall(error)).toBe(false);
  expect(await f.make().summary(f.job)).toMatchObject({ uncertain: [expect.any(String)] });
  expect(f.signed()).toBe(1);
  // The same request again is the same call: it reads the receipt, and pays nothing new.
  f.setRecord({});
  await expect(
    f.make().messages(f.job, say('Read it'), new AbortController().signal),
  ).resolves.toEqual(reply);
  expect(f.signed()).toBe(1);
});

it('leaves a call the client cancelled mid-stream uncertain, to be reconciled, with nothing signed again', async () => {
  const stop = new AbortController();
  const f = await fixture({
    drive: ({ events, push }) => push(frame('message_start', events()[0])),
  });
  const got: StreamEvent[] = [];
  const running = f
    .make()
    .messages(f.job, say('Read it'), stop.signal, undefined, undefined, (e) => {
      got.push(e);
      stop.abort(new Error('session ended'));
    });
  await expect(running).rejects.toThrow('session ended');
  expect(got).toHaveLength(1);
  expect(await f.make().summary(f.job)).toMatchObject({ uncertain: [expect.any(String)] });
  expect(f.signed()).toBe(1);
});

it('refuses a reply larger than the result it may carry, as it arrives', async () => {
  const f = await fixture({
    drive: ({ events, push }) => {
      push(frame('message_start', events()[0]));
      push(
        frame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'x'.repeat(2_100_000) },
        }),
      );
    },
  });
  const { got, error } = await call(f);
  expect(got.map((e) => e.type)).toEqual(['message_start']);
  expect(error!.detail.relayed).toBe(true);
  expect(retryableModelCall(error)).toBe(false);
});

it('asks again without a stream once, when the router refuses the field it offered', async () => {
  const f = await fixture({ drive: () => expect.unreachable('refused before payment') });
  const real = f.make;
  let refusals = 0;
  const transport = real();
  // A router whose flag is off again refuses `stream` at the unpaid quote.
  const original = (transport as unknown as { options: { payerDeps: { fetchImpl: typeof fetch } } })
    .options.payerDeps;
  const inner = original.fetchImpl;
  original.fetchImpl = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? 'null')) as { stream?: boolean } | null;
    if (body?.stream === true) {
      refusals++;
      return Response.json({ error: { code: 'invalid_model_request' } }, { status: 400 });
    }
    return inner(input, init);
  };
  const got: StreamEvent[] = [];
  await expect(
    transport.messages(f.job, say('One'), new AbortController().signal, undefined, undefined, (e) =>
      got.push(e),
    ),
  ).resolves.toEqual(reply);
  await expect(
    transport.messages(f.job, say('Two'), new AbortController().signal, undefined, undefined, (e) =>
      got.push(e),
    ),
  ).resolves.toEqual(reply);
  // The first call asked once with the stream; the second never did.
  expect(refusals).toBe(1);
  expect(got).toEqual([]);
});

// The reader alone: the idle limit, the size guard and the frame parser.
const sseBody = (chunks: string[], hang = false) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
        if (!hang) c.close();
      },
    }),
    { status: 200, headers: { 'tenjin-model-stream': '1' } },
  );
const reading = (over: Partial<Parameters<typeof readMessagesStream>[1]> = {}) => ({
  signal: new AbortController().signal,
  idleMs: 1_000,
  terminalBytes: 4_500_000,
  contentBytes: 2_000_000,
  onEvent: () => undefined,
  ...over,
});

it('reads frames split across chunks and CRLF, and answers the last event as the whole response', async () => {
  const seen: string[] = [];
  const text =
    `${frame('message_start', { type: 'message_start' })}: keep\n\n${frame('tenjin_result', { status: 200, headers: { 'payment-response': 'abc' }, body: { ok: 1 } })}`.replace(
      /\n/g,
      '\r\n',
    );
  const chunks = [text.slice(0, 7), text.slice(7, 40), text.slice(40)];
  const response = await readMessagesStream(
    sseBody(chunks),
    reading({ onEvent: (e) => seen.push(e.type) }),
  );
  expect(seen).toEqual(['message_start']);
  expect(response.status).toBe(200);
  expect(response.headers.get('payment-response')).toBe('abc');
  expect(await response.json()).toEqual({ ok: 1 });
});

it.each([
  [
    'an idle stream',
    () => sseBody([frame('message_start', { type: 'message_start' })], true),
    'idle',
  ],
  [
    'a stream that ends with no last event',
    () => sseBody([frame('message_start', { type: 'message_start' })]),
    'lost',
  ],
  [
    'an event whose name is not its type',
    () => sseBody([frame('message_start', { type: 'ping' })]),
    'protocol',
  ],
  ['an event that is not JSON', () => sseBody(['event: ping\ndata: {\n\n']), 'protocol'],
])('cuts %s as %s', async (_name, body, reason) => {
  await expect(readMessagesStream(body(), reading({ idleMs: 30 }))).rejects.toMatchObject({
    name: 'StreamCut',
    reason,
  });
  expect(StreamCut).toBeDefined();
});
