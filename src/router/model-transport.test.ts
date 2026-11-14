import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, expect, it } from 'vitest';
import { SIWX_HEADER } from '../lib/siwx';
import { FakeRouter, payerDeps, BASE, TEST_POLICY, testSigner } from './fee-test-utils';
import { ModelTransport } from './model-transport';
import type { ModelJob } from './model-job';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture(
  options: {
    drop?: boolean;
    cap?: string;
    protocol?: 'messages' | 'responses';
    wire?: string;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'model-transport-'));
  made.push(dir);
  const repo = join(dir, 'repo');
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
  const config = {
    router: {
      subagents: true,
      subagentConsent: {
        version: 2,
        instructions: 'applicable',
        recipients: ['Tenjin', 'DeepSeek'],
        repositories: [repo],
        maxJobAtomic: options.cap ?? '1000000',
        routerOrigin: BASE,
      },
    },
  };
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  const job: ModelJob = {
    id: randomUUID(),
    sessionId: 'root',
    turnId: '1',
    callId: 'call',
    root: repo,
    task: 'Read the fixture',
    native: {},
    decision: { jobId: randomUUID(), routingFeeAtomic: '3000' },
    capAtomic: '1000000',
    state: 'running',
    expiresAt: Date.now() + 60_000,
  };
  const router = new FakeRouter({
    path: `/api/model-proxy/${options.protocol ?? 'messages'}`,
    amount: '500000',
    charge: '1000',
    minDeposit: '50000',
  });
  router.abortAfterSettle = options.drop ?? false;
  let last: Record<string, unknown> | undefined;
  let result: unknown;
  let gets = 0;
  let signedGets = 0;
  let voucherState = 'accepted';
  const message = {
    id: 'msg',
    type: 'message',
    role: 'assistant',
    model: 'deepseek-flash',
    content: [{ type: 'text', text: 'Done' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 5 },
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET') {
      gets++;
      if (request.headers.has(SIWX_HEADER)) signedGets++;
      return Response.json({
        invocationId: last?.invocationId,
        state: 'completed',
        voucherState,
        actualAtomic: '1000',
        result,
      });
    }
    last = (await request.clone().json()) as Record<string, unknown>;
    result = {
      ...(options.protocol === 'responses'
        ? { wire: options.wire ?? 'event: response.completed\ndata: {"owned":"native wire"}\n\n' }
        : { message }),
      receipt: { invocationId: last.invocationId, quoteAtomic: '500000', actualAtomic: '1000' },
    };
    router.body = result;
    return router.fetch(request);
  };
  const deps = payerDeps(router, dir, privateKeyToAccount(generatePrivateKey()), {
    fetchImpl,
    policy: async () => ({ ...TEST_POLICY, maxAutoSpendAtomic: 1000000n }),
  });
  const make = () =>
    new ModelTransport({
      dataDir: dir,
      baseUrl: BASE,
      payerDeps: deps,
    });
  return {
    dir,
    repo,
    job,
    router,
    make,
    message,
    last: () => last,
    gets: () => gets,
    signedGets: () => signedGets,
    setVoucher: (value: string) => {
      voucherState = value;
    },
  };
}

it('uses the real SDK inference lane for multiple turns, reusing credit and replaying locally', async () => {
  const f = await fixture();
  const transport = f.make();
  const first = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'first' }] };
  expect(await transport.messages(f.job, first, new AbortController().signal)).toEqual(f.message);
  expect(await f.make().messages(f.job, first, new AbortController().signal)).toEqual(f.message);
  await transport.messages(f.job, { ...first, max_tokens: 200 }, new AbortController().signal);
  expect(f.router.paidRequests()).toBe(2);
  expect(f.router.deposits).toBe(1);
  expect(f.router.channels.size).toBe(1);
  expect(await transport.summary(f.job)).toEqual({
    actualAtomic: '5000',
    reservedAtomic: '5000',
    uncertain: [],
  });
});

it('recovers a dropped paid response through signed owner lookup without another model authorization', async () => {
  const f = await fixture({ drop: true });
  const request = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'once' }] };
  await expect(f.make().messages(f.job, request, new AbortController().signal)).rejects.toThrow(
    /uncertain/,
  );
  const transport = f.make();
  expect((await transport.summary(f.job)).reservedAtomic).toBe('503000');
  expect(await transport.messages(f.job, request, new AbortController().signal)).toEqual(f.message);
  expect(f.router.paidRequests()).toBe(1);
  expect(f.gets()).toBe(1);
  expect(f.signedGets()).toBe(1);
  expect(await transport.summary(f.job)).toEqual({
    actualAtomic: '4000',
    reservedAtomic: '4000',
    uncertain: [],
  });
});

it('retains uncertain exposure until voucher acceptance and refuses a lowered or corrupt ceiling before payment', async () => {
  const f = await fixture({ drop: true });
  const request = { model: 'deepseek-flash', messages: [{ role: 'user', content: 'once' }] };
  await expect(f.make().messages(f.job, request, new AbortController().signal)).rejects.toThrow();
  f.setVoucher('unknown');
  await expect(f.make().messages(f.job, request, new AbortController().signal)).rejects.toThrow(
    /no new authorization/,
  );
  expect(f.router.paidRequests()).toBe(1);
  expect((await f.make().summary(f.job)).reservedAtomic).toBe('503000');
  const budget = join(f.dir, 'model-jobs', `${f.job.id}.budget.json`);
  expect(JSON.parse(await readFile(budget, 'utf8')).charged).toBe('503000');
  await writeFile(budget, '{broken');
  await expect(f.make().messages(f.job, request, new AbortController().signal)).rejects.toThrow(
    /Unreadable model budget/,
  );
  expect(f.router.paidRequests()).toBe(1);
  const small = await fixture({ cap: '400000' });
  await expect(
    small.make().messages(small.job, request, new AbortController().signal),
  ).rejects.toThrow(/remaining job ceiling/);
  expect(small.router.paidRequests()).toBe(0);
});

it('does not transmit a routing authorization after cancellation while the signer is unlocking', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-route-abort-'));
  made.push(dir);
  const router = new FakeRouter({ path: '/api/model-router/route' });
  const wallet = privateKeyToAccount(generatePrivateKey());
  let entered!: () => void;
  const unlocking = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let resume!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const deps = payerDeps(router, dir, wallet, {
    getSigner: async () => {
      entered();
      await held;
      return testSigner(wallet);
    },
  });
  const transport = new ModelTransport({
    dataDir: dir,
    baseUrl: BASE,
    payerDeps: deps,
  });
  const abort = new AbortController();
  const pending = transport.route({ schemaVersion: 1 }, abort.signal);
  const rejected = expect(pending).rejects.toThrow();
  await unlocking;
  abort.abort();
  resume();
  await rejected;
  expect(router.paidRequests()).toBe(0);
  expect(router.settledFees).toBe(0);
});

it('keeps native Responses opaque fields intact and budgets worker plus Guardian in the same job', async () => {
  const wire = 'event: response.completed\ndata: {"response":{"opaque":"unchanged"}}\n\n';
  const f = await fixture({ protocol: 'responses', wire });
  const transport = f.make();
  const worker = {
    model: 'deepseek-flash',
    reasoning: { effort: 'high' },
    stream: true,
    input: [{ type: 'reasoning', encrypted_content: 'OPAQUE-native-signature-1234567890' }],
    tools: [{ type: 'namespace', name: 'fixture', tools: [{ type: 'function', name: 'read' }] }],
  };
  expect(await transport.responses(f.job, worker, new AbortController().signal)).toBe(wire);
  expect(f.last()).toMatchObject({
    protocol: 'responses',
    responses: worker,
    jobId: f.job.decision.jobId,
  });
  expect(await f.make().responses(f.job, worker, new AbortController().signal)).toBe(wire);
  await transport.responses(
    f.job,
    { ...worker, reasoning: { effort: 'low' } },
    new AbortController().signal,
  );
  expect(f.router.paidRequests()).toBe(2);
  expect(f.router.channels.size).toBe(1);
  expect(await transport.summary(f.job)).toEqual({
    actualAtomic: '5000',
    reservedAtomic: '5000',
    uncertain: [],
  });
});

it('recovers the exact Responses wire through owner lookup without buying a replacement request', async () => {
  const wire = 'event: response.completed\ndata: {"opaque":"native-result"}\n\n';
  const f = await fixture({ protocol: 'responses', wire, drop: true });
  const input = { model: 'deepseek-flash', reasoning: { effort: 'high' }, input: 'Once' };
  await expect(f.make().responses(f.job, input, new AbortController().signal)).rejects.toThrow(
    /uncertain/,
  );
  expect(await f.make().responses(f.job, input, new AbortController().signal)).toBe(wire);
  expect(f.router.paidRequests()).toBe(1);
  expect(f.gets()).toBe(1);
  expect(f.signedGets()).toBe(1);
  expect(await f.make().summary(f.job)).toEqual({
    actualAtomic: '4000',
    reservedAtomic: '4000',
    uncertain: [],
  });
});

it('accepts bounded native Responses receipts beyond the old Messages response size', async () => {
  const wire = 'event: response.completed\ndata: ' + 'x'.repeat(2_200_000) + '\n\n';
  const f = await fixture({ protocol: 'responses', wire });
  expect(
    await f
      .make()
      .responses(
        f.job,
        { model: 'deepseek-flash', input: 'Long native stream' },
        new AbortController().signal,
      ),
  ).toBe(wire);
  expect(f.router.paidRequests()).toBe(1);
});

it('masks known secrets in native instructions/text/tool outputs while preserving opaque pairings and schemas', async () => {
  const f = await fixture({ protocol: 'responses' });
  const secret = 'sk-proj-abc123DEF456ghi789JKL012_mno';
  const native = {
    model: 'deepseek-flash',
    instructions: `base ${secret}`,
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: `context ${secret}` }] },
      { type: 'function_call', id: secret, call_id: secret, name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: secret, output: `tool ${secret}` },
      { type: 'reasoning', encrypted_content: secret, signature: secret },
    ],
    tools: [
      {
        type: 'function',
        name: 'read',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^sk-proj-abc123$' } },
        },
      },
    ],
  };
  await f.make().responses(f.job, native, new AbortController().signal);
  const sent = f.last()!.responses as typeof native;
  expect(sent.instructions).not.toContain(secret);
  expect((sent.input[0]!.content![0] as { text: string }).text).not.toContain(secret);
  expect(sent.input[2]!.output).not.toContain(secret);
  expect(sent.input[1]!.id).toBe(secret);
  expect(sent.input[2]!.call_id).toBe(secret);
  expect(sent.input[3]!.encrypted_content).toBe(secret);
  expect(sent.input[3]!.signature).toBe(secret);
  expect(sent.tools).toEqual(native.tools);
});
