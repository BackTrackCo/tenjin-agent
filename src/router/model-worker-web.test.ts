import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// No setting turns an offer on any more; this test drives the offer path with its own saved consent.
vi.mock('./model-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./model-settings')>()),
  modelSettings: (await import('./saved-consent-test-utils')).savedModelSettings,
}));
import { buildPaymentRequired, testSigner, testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import {
  completedMessageSse,
  searchRefusedMessage,
  SEARCH_MAX_TOKENS,
  WEB_SEARCH_MAX_USES,
  WEB_SEARCH_TOOL,
  workerSearchMessages,
} from './model-messages';
import { FakeRouter, payerDeps } from './fee-test-utils';
import type { ModelJob } from './model-job';
import { ModelTransport } from './model-transport';
import {
  workerFetchFallback,
  workerWebSearch,
  type WorkerRequest,
  type WorkerWebDeps,
} from './model-worker-web';
import type { Identities } from './identities';
import { runRequestTool } from './tool';

/**
 * A worker's WebSearch becomes one Messages call with DeepSeek's own search tool, and a
 * page its WebFetch could not fetch is read through Exa page read as a paid Tenjin tool
 * call counted in the job's budget by the real transport. No test signs a real payment or
 * opens a socket.
 */

const ROUTER = 'https://router.test';
const EXA_CONTENTS = 'https://api.exa.ai/contents';
const ROUTING_FEE = 3000n;
/** The catalog's Exa tool spec, as the router serves it: the page read's shape. */
const EXA_SPEC = (() => {
  const wired = JSON.parse(
    readFileSync(new URL('./fixtures/wire-hook-execute-headers.json', import.meta.url), 'utf8'),
  ) as { decision: { specs: Record<string, unknown>[] } };
  const spec = { ...wired.decision.specs[0]! };
  delete spec.id;
  return spec;
})();
const CONTENTS_SPEC = {
  ...EXA_SPEC,
  capabilityId: 'exa-contents',
  label: 'Exa page read',
  holds: { WebFetch: 'urls' },
  description: 'returns the complete text of one public page',
  priceAtomic: '1000',
  maxAmountAtomic: '1000',
  request: {
    method: 'POST',
    url: EXA_CONTENTS,
    fields: { urls: 'body', text: 'body' },
    location: 'body',
  },
  input: {
    type: 'object',
    properties: {
      urls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1 },
      text: { type: 'boolean', const: true },
    },
    required: ['urls'],
    additionalProperties: false,
  },
  pinned: {},
};

let dir: string;
let repo: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'worker-web-'));
  repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The router's identities read, as the rules are checked against it. */
const IDENTITIES = JSON.parse(
  readFileSync(new URL('./fixtures/wire-identities.json', import.meta.url), 'utf8'),
) as Identities;

async function configure(
  options: {
    cap?: string;
    maxAutoSpend?: string;
    sessionBudget?: string;
    policy?: Record<string, unknown>;
  } = {},
) {
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: options.maxAutoSpend ?? '250000',
      sessionBudget: options.sessionBudget ?? '5000000',
      router: {
        subagents: true,
        subagentConsent: {
          version: 2,
          instructions: 'applicable',
          reads: 'claude-home',
          recipients: ['Tenjin', 'DeepSeek', 'Exa'],
          repositories: [repo],
          maxJobAtomic: options.cap ?? '1000000',
          routerOrigin: ROUTER,
        },
        ...(options.policy ? { policy: { version: 1, ...options.policy } } : {}),
      },
    }),
  );
}

function spyAuthorizer(): SpendAuthorizer {
  return {
    policyEnforcement: 'client-only',
    authorize: vi.fn(async (req): Promise<SpendAuthorization> => ({
      decision: 'allow',
      reason: 'within_policy',
      message: 'test',
      amountAtomic: req.amountAtomic,
      sessionSpentAtomic: 0n,
      sessionBudgetAtomic: 0n,
      policyEnforcement: 'client-only',
      reservationId: 'rsv',
    })),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

interface Seen {
  url: string;
  paid: boolean;
  body?: Record<string, unknown>;
}

/**
 * The network: the router serves the page read's spec for a `{tool}` read (or
 * `routerAnswer`), and Exa answers its unpaid probe with a 402 at `price` and its paid
 * call with `paid`.
 */
function network(
  options: {
    price?: string;
    paid?: { status: number; body: unknown };
    routerAnswer?: { status: number; body: unknown };
  } = {},
) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const paid = new Headers(init?.headers ?? {}).has('payment-signature');
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    seen.push({ url, paid, ...(body ? { body } : {}) });
    if (url.startsWith(ROUTER)) {
      if (typeof body?.tool !== 'string') return Response.json({});
      if (options.routerAnswer)
        return Response.json(options.routerAnswer.body, { status: options.routerAnswer.status });
      const id = randomUUID();
      const settings = body.settings as { hash?: unknown } | undefined;
      return Response.json({
        schemaVersion: 1,
        routerVersion: 'test',
        // Decided under the rules the request carried, as the router echoes them.
        ...(typeof settings?.hash === 'string' ? { settingsHash: settings.hash } : {}),
        decision: {
          action: 'spec',
          id,
          spec: CONTENTS_SPEC,
          hint: `Call request({id: "${id}", input: {...}}).`,
        },
      });
    }
    if (url === EXA_CONTENTS) {
      if (!paid)
        return Response.json(
          {},
          {
            status: 402,
            headers: {
              'PAYMENT-REQUIRED': buildPaymentRequired({
                amount: options.price ?? '1000',
                payTo: String(EXA_SPEC.payTo),
              }).header,
            },
          },
        );
      const answer = options.paid ?? {
        status: 200,
        body: {
          results: [{ title: 'Read page', url: 'https://x402.org', text: 'The whole page.' }],
        },
      };
      return Response.json(answer.body, { status: answer.status });
    }
    throw new Error(`no network in tests: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: ROUTER },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

/** The executor `tenjin mcp` hands a worker, over the scripted network. */
function executor(
  fetchImpl: typeof fetch,
  auth: SpendAuthorizer,
  provider = testWalletProvider(),
): WorkerRequest {
  return (args, { cwd, watch, signal }) => {
    const authorizer = watch(auth);
    return runRequestTool(args, {
      ctx: ctx(),
      cwd,
      authorizer,
      ...(signal === undefined ? {} : { paymentSignal: signal }),
      approves: false,
      fetchImpl,
      payDeps: {
        readBalance: async () => 100_000_000n,
        fetchImpl,
        provider,
        authorizer,
        destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
      },
    });
  };
}

function setup(fetchImpl: typeof fetch, auth = spyAuthorizer()) {
  const job: ModelJob = {
    id: randomUUID(),
    sessionId: 'session',
    turnId: 'turn',
    callId: 'call',
    root: repo,
    task: 'Look it up',
    native: {},
    decision: {
      jobId: randomUUID(),
      routingFeeAtomic: '3000',
      routingAuthorizedAtomic: '3000',
      routerOrigin: ROUTER,
    },
    capAtomic: '1000000',
    state: 'running',
    expiresAt: Date.now() + 60_000,
  };
  const transport = new ModelTransport({
    dataDir: dir,
    baseUrl: ROUTER,
    payerDeps: payerDeps(
      new FakeRouter({ path: '/api/model-proxy/messages', amount: '1', charge: '1' }),
      dir,
      privateKeyToAccount(generatePrivateKey()),
    ),
  });
  return {
    job,
    transport,
    auth,
    deps: {
      job,
      transport,
      dataDir: dir,
      request: executor(fetchImpl, auth),
      // A fallback page's host resolves to a public address unless a test says otherwise.
      resolve: async () => [{ address: '93.184.216.34' }],
    } as WorkerWebDeps,
  };
}

const FAILED_FETCH = {
  input: { url: 'https://x402.org', prompt: 'Summarize' },
  error: 'getaddrinfo ENOTFOUND x402.org',
};

/** The nested request Claude Code 2.1.326's WebSearch sends its model (probed). */
const NESTED = {
  model: 'deepseek-flash',
  stream: true,
  tool_choice: { type: 'auto' },
  tools: [
    {
      type: 'web_search_20250305',
      name: 'web_search',
      allowed_domains: ['https://Docs.Example.org/guide', '*.x402.org'],
      max_uses: 8,
    },
  ],
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Perform a web search for the query: x402 receipts' }],
    },
  ],
};

it("recognises only WebSearch's own nested request, keeps its query, and clamps its bound", () => {
  expect(workerWebSearch(NESTED)).toEqual({
    query: 'x402 receipts',
    maxUses: WEB_SEARCH_MAX_USES,
    refused: 'allowed_domains',
  });
  const plain = {
    ...NESTED,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  };
  expect(workerWebSearch(plain)).toEqual({
    query: 'x402 receipts',
    maxUses: WEB_SEARCH_MAX_USES,
    refused: null,
  });
  for (const max_uses of [1, 3, 5, 8, 0, 1.5, '3', null])
    expect(workerWebSearch({ ...plain, tools: [{ ...plain.tools[0], max_uses }] })?.maxUses).toBe(
      typeof max_uses === 'number' && Number.isInteger(max_uses)
        ? Math.min(Math.max(max_uses, 1), WEB_SEARCH_MAX_USES)
        : WEB_SEARCH_MAX_USES,
    );
  // Any other server tool field is one the router's strict schema refuses.
  for (const field of [
    { blocked_domains: ['x.example'] },
    { user_location: { type: 'approximate' } },
    { allowed_domains: ['x.example'], blocked_domains: ['y.example'] },
  ])
    expect(workerWebSearch({ ...plain, tools: [{ ...plain.tools[0], ...field }] })?.refused).toBe(
      Object.keys(field)[0],
    );
  // A request that also holds another tool is not WebSearch's: the bridge refuses it.
  expect(
    workerWebSearch({
      ...NESTED,
      tools: [...NESTED.tools, { name: 'Read', input_schema: { type: 'object' } }],
    }),
  ).toBeNull();
  expect(
    workerWebSearch({ ...NESTED, tools: [{ name: 'Read', input_schema: { type: 'object' } }] }),
  ).toBeNull();
});

it('sends one search as one Messages call with the one server tool, and a small output cap', () => {
  const body = workerSearchMessages({ query: 'x402 receipts', maxUses: 5, refused: null });
  expect(body).toEqual({
    model: 'deepseek-flash',
    max_tokens: SEARCH_MAX_TOKENS,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'x402 receipts' }],
    tools: [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: 5 }],
  });
  // The cap is small: the search's results come back as input tokens, not output.
  expect(SEARCH_MAX_TOKENS).toBeLessThan(65_536);
});

it('answers a refused search in the shape WebSearch reads, streamed or whole', () => {
  const message = searchRefusedMessage(
    { query: 'x402 receipts', maxUses: 5, refused: 'allowed_domains' },
    "the request's allowed_domains filter is not supported",
  );
  expect(message).toMatchObject({
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'server_tool_use', name: 'web_search', input: { query: 'x402 receipts' } },
      { type: 'web_search_tool_result', content: { error_code: 'unavailable' } },
      {
        type: 'text',
        text: "Web search is not available to this worker right now: the request's allowed_domains filter is not supported. Continue without it.",
      },
    ],
  });
  // The streamed form carries the same blocks, as the completed whole answer does.
  const sse = completedMessageSse(message);
  expect(sse).toContain('event: message_start');
  expect(sse).toContain('"type":"server_tool_use"');
  expect(sse).toContain('"type":"web_search_tool_result"');
  expect(sse).toContain('"error_code":"unavailable"');
  expect(sse).toContain('event: message_stop');
});

it('reads a page through Exa when the local WebFetch failed on the network, and counts it', async () => {
  // The failure: a worker whose WebFetch could not reach a public page had no way to read it.
  await configure();
  const { fetchImpl, seen } = network();
  const { job, transport, deps } = setup(fetchImpl);
  const read: number[] = [];
  const context = await workerFetchFallback(FAILED_FETCH, {
    ...deps,
    redact: (text) => text,
    onRead: (bytes) => read.push(bytes),
  });
  expect(context).toContain('The whole page.');
  // The worker's viewer is told the page Exa read stood in, and its size.
  expect(read).toEqual([Buffer.byteLength('The whole page.')]);
  expect(seen.find((call) => call.url === EXA_CONTENTS && call.paid)?.body).toMatchObject({
    urls: ['https://x402.org'],
  });
  expect((await transport.summary(job)).actualAtomic).toBe((ROUTING_FEE + 1000n).toString());
});

it.each([
  [
    'a refusal that is not a network failure',
    { error: 'Claude Code is unable to fetch from x402.org' },
  ],
  ['a fetch that worked', { response: { code: 200, codeText: 'OK', bytes: 12, result: 'ok' } }],
])('reads nothing through Exa after %s', async (_label, outcome) => {
  await configure();
  const { fetchImpl, seen } = network();
  const { deps } = setup(fetchImpl);
  expect(
    await workerFetchFallback(
      { input: { url: 'https://x402.org', prompt: 'Summarize' }, ...outcome },
      { ...deps, redact: (text) => text },
    ),
  ).toBeNull();
  expect(seen).toEqual([]);
});

it('never names a page on this machine, or an address holding a secret value, to Exa', async () => {
  // The failure: a local address, or a token in a URL, sent to a third party.
  await configure();
  const { fetchImpl, seen } = network();
  const { deps } = setup(fetchImpl);
  const failed = { response: { code: 404, codeText: 'Not Found', bytes: 0, result: 'gone' } };
  expect(
    await workerFetchFallback(
      { input: { url: 'http://127.0.0.1:8080/admin', prompt: 'x' }, ...failed },
      { ...deps, redact: (text) => text },
    ),
  ).toBeNull();
  const secret = await workerFetchFallback(
    { input: { url: 'https://x402.org/?key=Zq8v3rys3cretvalue', prompt: 'x' }, ...failed },
    { ...deps, redact: (text) => text.replace('Zq8v3rys3cretvalue', '[redacted job secret]') },
  );
  expect(secret).toContain('its address holds a secret value');
  expect(seen).toEqual([]);
});

// Review finding: a name that resolves to a private address passed on its spelling alone.
it.each([
  ['a name that resolves to a private address', async () => [{ address: '10.0.0.5' }]],
  [
    'a name that also resolves to loopback',
    async () => [{ address: '93.184.216.34' }, { address: '127.0.0.1' }],
  ],
  [
    'a name that does not resolve here',
    async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    },
  ],
] as const)('never names %s to Exa', async (_label, resolve) => {
  await configure();
  const { fetchImpl, seen } = network();
  const { deps } = setup(fetchImpl);
  expect(
    await workerFetchFallback(
      {
        input: { url: 'https://build.corp.example.com/private-report', prompt: 'x' },
        response: { code: 404, codeText: 'Not Found', bytes: 0, result: 'gone' },
      },
      { ...deps, resolve, redact: (text) => text },
    ),
  ).toBeNull();
  expect(seen).toEqual([]);
});

const EXA = { kind: 'provider', id: 'exa' } as const;
it("reads no page through Exa, and pays nothing, when the person's rules block Exa", async () => {
  // The failure: a worker's failed WebFetch was read through Exa, and paid, against a block.
  await configure({ policy: { block: [EXA] } });
  const { fetchImpl, seen } = network();
  const { deps, auth } = setup(fetchImpl);
  const read = await workerFetchFallback(FAILED_FETCH, {
    ...deps,
    identities: async () => IDENTITIES,
    redact: (text) => text,
  });
  expect(read).toContain('keep Tenjin from using Exa contents on its own');
  expect(read).not.toContain('The whole page.');
  expect(seen).toEqual([]);
  expect(auth.authorize).not.toHaveBeenCalled();
});

it.each([
  ['provider block', { block: [{ kind: 'provider', id: 'coinmarketcap' }] }],
  [
    'only rule for another task',
    {
      only: [
        {
          scope: { kind: 'task', id: 'web research' },
          dimension: 'provider',
          targets: [{ kind: 'provider', id: 'exa' }],
        },
      ],
    },
  ],
])(
  "still reads the page through Exa when the person's rules leave it in: %s",
  async (_r, policy) => {
    await configure({ policy });
    const { fetchImpl, seen } = network();
    const { deps } = setup(fetchImpl);
    const read = await workerFetchFallback(FAILED_FETCH, {
      ...deps,
      identities: async () => IDENTITIES,
      redact: (text) => text,
    });
    expect(read).toContain('The whole page.');
    expect(seen.filter((call) => call.url === EXA_CONTENTS && call.paid)).toHaveLength(1);
  },
);

it('refuses a page read, unpaid, when a block rule cannot be checked because no identities read is known', async () => {
  // The failure: with the router unreachable and no kept copy, a provider block was taken
  // to leave Exa in.
  await configure({ policy: { block: [{ kind: 'provider', id: 'coinmarketcap' }] } });
  const { fetchImpl, seen } = network();
  const { deps } = setup(fetchImpl);
  const read = await workerFetchFallback(FAILED_FETCH, {
    ...deps,
    identities: async () => undefined,
    redact: (text) => text,
  });
  expect(read).toContain('keep Tenjin from using exa-contents on its own');
  expect(seen).toEqual([]);
});

it("refuses a page read the job's budget cannot cover at the spec's ceiling, before anything reaches Exa", async () => {
  // The failure: a page read paid past the job's cap, which the person approved as the
  // job's whole spend. The spec's ceiling is $0.001.
  await configure({ cap: '3900' });
  const { fetchImpl, seen } = network();
  const { job, transport, deps, auth } = setup(fetchImpl);
  const read = await workerFetchFallback(FAILED_FETCH, { ...deps, redact: (text) => text });
  expect(read).toContain("this job's budget has no room for another page read");
  expect(seen.some((call) => call.url === EXA_CONTENTS)).toBe(false);
  expect(auth.authorize).not.toHaveBeenCalled();
  expect((await transport.summary(job)).actualAtomic).toBe(ROUTING_FEE.toString());
});

it.each([
  ['daily budget', { sessionBudget: '500' }, "it would pass the person's spending limits"],
] as const)(
  "refuses a page read over the person's %s with its plain refusal, and releases its reservation",
  async (_limit, limits, why) => {
    // The failure: a worker page read kept as a quote or paid past the person's own limit.
    await configure(limits);
    const { fetchImpl, seen } = network();
    const { job, transport, deps, auth } = setup(fetchImpl);
    const read = await workerFetchFallback(FAILED_FETCH, { ...deps, redact: (text) => text });
    expect(read).toContain(why);
    expect(seen.some((call) => call.url === EXA_CONTENTS && call.paid)).toBe(false);
    expect(auth.commit).not.toHaveBeenCalled();
    expect(await transport.summary(job)).toEqual({
      reservedAtomic: ROUTING_FEE.toString(),
      actualAtomic: ROUTING_FEE.toString(),
      uncertain: [],
    });
  },
);

it('says so when the router declines the page read, and pays nothing', async () => {
  await configure();
  const { fetchImpl, seen } = network({ routerAnswer: { status: 503, body: {} } });
  const { job, transport, deps } = setup(fetchImpl);
  const read = await workerFetchFallback(FAILED_FETCH, { ...deps, redact: (text) => text });
  expect(read).toMatch(/Tenjin's router did not offer it/);
  expect(seen.some((call) => call.url === EXA_CONTENTS)).toBe(false);
  expect((await transport.summary(job)).actualAtomic).toBe(ROUTING_FEE.toString());
});

it('keeps a page read Exa failed after the payment was signed counted', async () => {
  // The failure: a signed payment that came back with an error dropped out of the job's spend.
  await configure();
  const { fetchImpl } = network({ paid: { status: 500, body: { error: 'down' } } });
  const { job, transport, deps } = setup(fetchImpl);
  const read = await workerFetchFallback(FAILED_FETCH, { ...deps, redact: (text) => text });
  expect(read).toMatch(/it did not run/);
  expect((await transport.summary(job)).actualAtomic).toBe((ROUTING_FEE + 1000n).toString());
});

it('buys nothing for a worker stopped while its page read waited, and releases what it reserved', async () => {
  await configure();
  const { fetchImpl, seen } = network();
  const { job, transport, deps } = setup(fetchImpl);
  const stop = new AbortController();
  const request: WorkerRequest = async (args, call) => {
    const answer = await deps.request!(args, call);
    // The person stops the worker while the spec read is answered.
    if ('tool' in args) stop.abort();
    return answer;
  };
  await workerFetchFallback(FAILED_FETCH, {
    ...deps,
    request,
    signal: stop.signal,
    redact: (text) => text,
  });
  expect(seen.filter((call) => call.paid)).toEqual([]);
  expect(await transport.summary(job)).toMatchObject({
    reservedAtomic: ROUTING_FEE.toString(),
    uncertain: [],
  });
  // A worker already stopped makes no request at all, not even the free one.
  const before = seen.length;
  await workerFetchFallback(FAILED_FETCH, {
    ...deps,
    signal: stop.signal,
    redact: (text) => text,
  });
  expect(seen.length).toBe(before);
});

it('refuses to authorize a page read stopped during its unsigned Exa probe', async () => {
  await configure();
  const stop = new AbortController();
  const { fetchImpl, seen } = network();
  let probeSignal: AbortSignal | null | undefined;
  const stoppedProbe: typeof fetch = (input, init) => {
    if (String(input) === EXA_CONTENTS && !new Headers(init?.headers).has('payment-signature')) {
      probeSignal = init?.signal;
      stop.abort();
    }
    // The provider still answers 402 even if the request was cancelled.
    return fetchImpl(input, init);
  };
  const { job, transport, deps, auth } = setup(stoppedProbe);
  await workerFetchFallback(FAILED_FETCH, {
    ...deps,
    signal: stop.signal,
    redact: (text) => text,
  });
  expect(probeSignal?.aborted).toBe(true);
  expect(seen.filter((call) => call.url === EXA_CONTENTS)).toMatchObject([{ paid: false }]);
  expect(auth.authorize).not.toHaveBeenCalled();
  expect(auth.commit).not.toHaveBeenCalled();
  expect(await transport.summary(job)).toEqual({
    reservedAtomic: ROUTING_FEE.toString(),
    actualAtomic: ROUTING_FEE.toString(),
    uncertain: [],
  });
});

it('releases the reservation and skips signing when a worker stops during spend authorization', async () => {
  await configure();
  const stop = new AbortController();
  const { fetchImpl, seen } = network();
  const { job, transport, deps, auth } = setup(fetchImpl);
  const stoppedAuthorizer: SpendAuthorizer = {
    ...auth,
    authorize: async (input) => {
      const grant = await auth.authorize(input);
      stop.abort();
      return grant;
    },
  };
  const signer = testSigner();
  const signTypedData = vi.fn(signer.signTypedData);
  const request = executor(
    fetchImpl,
    stoppedAuthorizer,
    testWalletProvider({ ...signer, signTypedData }),
  );
  await workerFetchFallback(FAILED_FETCH, {
    ...deps,
    signal: stop.signal,
    request,
    redact: (text) => text,
  });
  expect(auth.authorize).toHaveBeenCalledOnce();
  expect(signTypedData).not.toHaveBeenCalled();
  expect(seen.filter((call) => call.url === EXA_CONTENTS)).toMatchObject([{ paid: false }]);
  expect(auth.release).toHaveBeenCalledWith('rsv');
  expect(auth.commit).not.toHaveBeenCalled();
  expect(await transport.summary(job)).toMatchObject({
    reservedAtomic: ROUTING_FEE.toString(),
    uncertain: [],
  });
});

it('releases an Exa payment that was signed locally when the worker stopped before transmission', async () => {
  await configure();
  const stop = new AbortController();
  const { fetchImpl, seen } = network();
  const { job, transport, deps, auth } = setup(fetchImpl);
  const signer = testSigner();
  const signTypedData = vi.fn<typeof signer.signTypedData>(async (args) => {
    const signature = await signer.signTypedData(args);
    stop.abort();
    return signature;
  });
  const request = executor(fetchImpl, auth, testWalletProvider({ ...signer, signTypedData }));
  const read = await workerFetchFallback(FAILED_FETCH, {
    ...deps,
    signal: stop.signal,
    request,
    redact: (text) => text,
  });
  expect(read).toContain('The request was stopped before payment was sent');
  expect(signTypedData).toHaveBeenCalledOnce();
  expect(seen.filter((call) => call.url === EXA_CONTENTS)).toMatchObject([{ paid: false }]);
  expect(auth.release).toHaveBeenCalledWith('rsv');
  expect(auth.commit).not.toHaveBeenCalled();
  expect(await transport.summary(job)).toEqual({
    reservedAtomic: ROUTING_FEE.toString(),
    actualAtomic: ROUTING_FEE.toString(),
    uncertain: [],
  });
});

it('settles an already transmitted Exa payment when the worker stops while it waits', async () => {
  await configure();
  const stop = new AbortController();
  const { fetchImpl } = network();
  let paidSignal: AbortSignal | null | undefined;
  const stoppedResponse: typeof fetch = (input, init) => {
    if (String(input) === EXA_CONTENTS && new Headers(init?.headers).has('payment-signature')) {
      paidSignal = init?.signal;
      stop.abort();
    }
    return fetchImpl(input, init);
  };
  const { job, transport, deps, auth } = setup(stoppedResponse);
  const read = await workerFetchFallback(FAILED_FETCH, {
    ...deps,
    signal: stop.signal,
    redact: (text) => text,
  });
  expect(read).toContain('The whole page.');
  expect(paidSignal?.aborted).toBe(false);
  expect(auth.commit).toHaveBeenCalledWith('rsv', 1000n, expect.anything());
  expect(auth.release).not.toHaveBeenCalled();
  expect(await transport.summary(job)).toEqual({
    reservedAtomic: (ROUTING_FEE + 1000n).toString(),
    actualAtomic: (ROUTING_FEE + 1000n).toString(),
    uncertain: [],
  });
});

/** The hash of the routing rules saved now, as a spec read under them keeps it. */
async function savedHash(): Promise<string> {
  const { rulesNow } = await import('./settings-check');
  const now = await rulesNow(dir);
  if (!('wire' in now)) throw new Error(now.problem);
  return now.wire.settings.hash;
}

// Review finding: a block of Exa saved after the rules were checked but before the spec
// was read passed, since a named read skips blocks, and the page was bought.
it('buys nothing when a block of Exa is saved between the rules check and the spec read', async () => {
  // An unrelated block is saved, so the rules are checked against the router's identities.
  await configure({ policy: { block: [{ kind: 'provider', id: 'coinmarketcap' }] } });
  const { fetchImpl, seen } = network();
  const { deps, transport, job } = setup(fetchImpl);
  const { storeSpecs } = await import('./specs');
  const request: WorkerRequest = async (args, call) => {
    if (args.tool === undefined) return deps.request!(args, call);
    // The person blocks Exa while the spec is read; a named read skips blocks, and the
    // spec is kept under the new rules, so the paid request would find them unchanged.
    await configure({ policy: { block: [EXA] } });
    const id = randomUUID();
    await storeSpecs(dir, [{ ...CONTENTS_SPEC, id } as never], await savedHash());
    return { isError: false, summary: '', envelope: { status: 'spec', id } };
  };
  const read = await workerFetchFallback(FAILED_FETCH, {
    ...deps,
    request,
    identities: async () => IDENTITIES,
    redact: (text) => text,
  });
  expect(read).toContain('settings changed during the call');
  expect(seen.filter((call) => call.paid)).toEqual([]);
  expect((await transport.summary(job)).reservedAtomic).toBe(ROUTING_FEE.toString());
});

it('keeps the whole ceiling reserved for a page read whose payment the spend gate never settled, and reconcile leaves it', async () => {
  // The failure: a payment that may have left was released from the job's budget, or its
  // local id was sent to the model proxy as if it named a model call.
  await configure();
  const { job, transport, auth } = setup(network().fetchImpl);
  const { storeSpecs } = await import('./specs');
  const request: WorkerRequest = async (args, { watch }) => {
    if (args.tool !== undefined) {
      const id = randomUUID();
      // Kept under the rules saved now, as the request tool keeps a spec it read.
      await storeSpecs(dir, [{ ...CONTENTS_SPEC, id } as never], await savedHash());
      return { isError: false, summary: '', envelope: { status: 'spec', id } };
    }
    // Reserved at the gate, then neither committed nor released: it may have been signed.
    await watch(auth).authorize({ amountAtomic: 1000n, creator: 'api.exa.ai' });
    return { isError: true, summary: '', envelope: { status: 'failed', reason: 'cut off' } };
  };
  const read = await workerFetchFallback(FAILED_FETCH, {
    job,
    transport,
    dataDir: dir,
    request,
    resolve: async () => [{ address: '93.184.216.34' }],
    redact: (text) => text,
  });
  expect(read).toContain('cut off');
  const before = await transport.summary(job);
  expect(before).toMatchObject({
    reservedAtomic: (ROUTING_FEE + 1000n).toString(),
    actualAtomic: ROUTING_FEE.toString(),
  });
  expect(before.uncertain).toHaveLength(1);
  const proxy = vi.fn(async () => Response.json({}));
  const reconciling = new ModelTransport({
    dataDir: dir,
    baseUrl: ROUTER,
    payerDeps: payerDeps(
      new FakeRouter({ path: '/api/model-proxy/messages', amount: '1', charge: '1' }),
      dir,
      privateKeyToAccount(generatePrivateKey()),
      { fetchImpl: proxy as unknown as typeof fetch },
    ),
  });
  await reconciling.reconcile(job, new AbortController().signal);
  expect(proxy).not.toHaveBeenCalled();
  expect(await transport.summary(job)).toEqual(before);
});
