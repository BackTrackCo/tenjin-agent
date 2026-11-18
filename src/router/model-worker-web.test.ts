import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testSigner, testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import { completedMessageSse } from './model-messages';
import { FakeRouter, payerDeps } from './fee-test-utils';
import type { ModelJob } from './model-job';
import { ModelTransport } from './model-transport';
import {
  answerWorkerWebSearch,
  workerFetchFallback,
  workerWebSearch,
  type WorkerRequest,
  type WorkerWebDeps,
} from './model-worker-web';
import type { Identities } from './identities';
import { runRequestTool } from './tool';

/**
 * A worker's WebSearch, answered by the bridge with Exa search through the person's own
 * request executor (the real one here, over a scripted network), and counted in the job's
 * budget by the real transport. No test signs a real payment or opens a socket.
 */

const ROUTER = 'https://router.test';
const EXA_SEARCH = 'https://api.exa.ai/search';
const EXA_CONTENTS = 'https://api.exa.ai/contents';
const ROUTING_FEE = 3000n;
/** The catalog's Exa search spec, as the router serves it. */
const SEARCH_SPEC = (() => {
  const wired = JSON.parse(
    readFileSync(new URL('./fixtures/wire-hook-execute-headers.json', import.meta.url), 'utf8'),
  ) as { decision: { specs: Record<string, unknown>[] } };
  const spec = { ...wired.decision.specs[0]! };
  delete spec.id;
  return spec;
})();
const CONTENTS_SPEC = {
  ...SEARCH_SPEC,
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
  options: { cap?: string; maxAutoSpend?: string; policy?: Record<string, unknown> } = {},
) {
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: options.maxAutoSpend ?? '250000',
      sessionBudget: '5000000',
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
 * The network: the router serves a spec for a `{tool}` read (or `routerAnswer`) and takes
 * outcome reports; each Exa service answers its unpaid probe with a 402 at `price` and
 * its paid call with `paid`.
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
          spec: body.tool === 'exa-contents' ? CONTENTS_SPEC : SEARCH_SPEC,
          hint: `Call request({id: "${id}", input: {...}}).`,
        },
      });
    }
    if (url === EXA_SEARCH || url === EXA_CONTENTS) {
      if (!paid)
        return Response.json(
          {},
          {
            status: 402,
            headers: {
              'PAYMENT-REQUIRED': buildPaymentRequired({
                amount: options.price ?? (url === EXA_SEARCH ? '4000' : '1000'),
                payTo: String(SEARCH_SPEC.payTo),
              }).header,
            },
          },
        );
      const answer = options.paid ?? {
        status: 200,
        body:
          url === EXA_SEARCH
            ? {
                results: [
                  {
                    title: 'x402 specification',
                    url: 'https://x402.org/spec',
                    publishedDate: '2026-10-01',
                    highlights: ['A payment is an HTTP 402 answered with a signature.'],
                  },
                  {
                    title: 'Blocked page',
                    url: 'https://www.blocked.example/page',
                    highlights: ['NOT FOR THE WORKER'],
                  },
                  { title: 'Router', url: 'https://tenjin.sh/router', highlights: [] },
                ],
              }
            : {
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
    decision: { jobId: randomUUID(), routingFeeAtomic: '3000', routerOrigin: ROUTER },
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

/** What Claude Code's WebSearch takes from an answer: each search's links, and the text. */
function asWebSearchReads(message: Record<string, unknown>) {
  const links: { title: unknown; url: unknown }[][] = [];
  const errors: unknown[] = [];
  let text = '';
  for (const block of message.content as Record<string, unknown>[]) {
    if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content))
        links.push(
          (block.content as Record<string, unknown>[]).map(({ title, url }) => ({ title, url })),
        );
      else errors.push((block.content as Record<string, unknown>).error_code);
    }
    if (block.type === 'text') text += String(block.text);
  }
  return { links, errors, text };
}

const SEARCH = { query: 'x402 payments', allowedDomains: [], blockedDomains: ['blocked.example'] };

it("answers a worker's WebSearch with Exa lite search in the shape WebSearch reads, and counts it in the job's spend", async () => {
  // The failure: a worker's WebSearch reached the bridge as a server tool it refused, and
  // that refusal ended the whole job.
  await configure();
  const { fetchImpl, seen } = network();
  const { job, transport, deps, auth } = setup(fetchImpl);
  const answer = await answerWorkerWebSearch(SEARCH, deps);
  const reads = asWebSearchReads(answer);
  expect(reads.links).toEqual([
    [
      { title: 'x402 specification', url: 'https://x402.org/spec' },
      { title: 'Router', url: 'https://tenjin.sh/router' },
    ],
  ]);
  expect(reads.errors).toEqual([]);
  expect(reads.text).toContain('A payment is an HTTP 402 answered with a signature.');
  expect(reads.text).not.toContain('NOT FOR THE WORKER');
  // The streamed form carries the same blocks.
  expect(completedMessageSse(answer)).toContain('"type":"web_search_tool_result"');
  // Lite tier, ten pages, the catalog's pinned highlights; paid once, to Exa.
  const paid = seen.filter((call) => call.url === EXA_SEARCH && call.paid);
  expect(paid).toHaveLength(1);
  expect(paid[0]!.body).toMatchObject({ query: 'x402 payments', type: 'lite', numResults: 10 });
  expect(paid[0]!.body).toHaveProperty('contents');
  expect(auth.commit).toHaveBeenCalledWith('rsv', 4000n, expect.anything());
  // The job's spend: its routing fee and the search's $0.004, nothing left uncertain.
  expect(await transport.summary(job)).toEqual({
    reservedAtomic: (ROUTING_FEE + 4000n).toString(),
    actualAtomic: (ROUTING_FEE + 4000n).toString(),
    uncertain: [],
  });
});

it('passes allowed domains to Exa and keeps only pages under them', async () => {
  await configure();
  const { fetchImpl, seen } = network();
  const { deps } = setup(fetchImpl);
  const answer = await answerWorkerWebSearch(
    { query: 'x402', allowedDomains: ['x402.org'], blockedDomains: [] },
    deps,
  );
  expect(seen.find((call) => call.url === EXA_SEARCH && call.paid)?.body).toMatchObject({
    includeDomains: ['x402.org'],
  });
  expect(asWebSearchReads(answer).links).toEqual([
    [{ title: 'x402 specification', url: 'https://x402.org/spec' }],
  ]);
});

it("refuses a search the job's budget cannot cover at the spec's ceiling, before anything reaches Exa", async () => {
  // The failure: a search paid past the job's cap, which the person approved as the job's
  // whole spend. $0.007 is the spec's ceiling; $0.009 less the $0.003 routing fee leaves $0.006.
  await configure({ cap: '9000' });
  const { fetchImpl, seen } = network();
  const { job, transport, deps, auth } = setup(fetchImpl);
  const reads = asWebSearchReads(await answerWorkerWebSearch(SEARCH, deps));
  expect(reads.errors).toEqual(['unavailable']);
  expect(reads.text).toContain(
    "Web search is not available to this worker right now: this job's budget has no room for another search.",
  );
  expect(seen.some((call) => call.url === EXA_SEARCH)).toBe(false);
  expect(auth.authorize).not.toHaveBeenCalled();
  expect((await transport.summary(job)).actualAtomic).toBe(ROUTING_FEE.toString());
});

it("refuses a search over the person's per-call limit with the native error, and releases its reservation", async () => {
  // The failure: a worker search kept as a quote or paid past the person's own limit.
  await configure({ maxAutoSpend: '3000' });
  const { fetchImpl, seen } = network();
  const { job, transport, deps, auth } = setup(fetchImpl);
  const reads = asWebSearchReads(await answerWorkerWebSearch(SEARCH, deps));
  expect(reads.errors).toEqual(['unavailable']);
  expect(reads.text).toContain("it would pass the person's spending limits");
  expect(seen.some((call) => call.url === EXA_SEARCH && call.paid)).toBe(false);
  expect(auth.commit).not.toHaveBeenCalled();
  expect(await transport.summary(job)).toEqual({
    reservedAtomic: ROUTING_FEE.toString(),
    actualAtomic: ROUTING_FEE.toString(),
    uncertain: [],
  });
});

it('answers the native error when the router declines the search, and pays nothing', async () => {
  await configure();
  const { fetchImpl, seen } = network({ routerAnswer: { status: 503, body: {} } });
  const { job, transport, deps } = setup(fetchImpl);
  const reads = asWebSearchReads(await answerWorkerWebSearch(SEARCH, deps));
  expect(reads.errors).toEqual(['unavailable']);
  expect(reads.text).toMatch(
    /^Web search is not available to this worker right now: Tenjin's router did not offer it/,
  );
  expect(seen.some((call) => call.url === EXA_SEARCH)).toBe(false);
  expect((await transport.summary(job)).actualAtomic).toBe(ROUTING_FEE.toString());
});

it('answers the native error when Exa fails after the payment was signed, and keeps that payment counted', async () => {
  // The failure: a signed payment that came back with an error dropped out of the job's spend.
  await configure();
  const { fetchImpl } = network({ paid: { status: 500, body: { error: 'down' } } });
  const { job, transport, deps } = setup(fetchImpl);
  const reads = asWebSearchReads(await answerWorkerWebSearch(SEARCH, deps));
  expect(reads.errors).toEqual(['unavailable']);
  expect(reads.text).toMatch(/it did not run/);
  expect((await transport.summary(job)).actualAtomic).toBe((ROUTING_FEE + 4000n).toString());
});

const EXA = { kind: 'provider', id: 'exa' } as const;
it.each([
  ['blocks Exa', { block: [EXA] }],
  ["turns off Tenjin's own tools", { block: [{ kind: 'source', id: 'tenjin' }] }],
  ['blocks the lookups category', { block: [{ kind: 'category', id: 'lookups' }] }],
  [
    'lets Tenjin offer only images on its own',
    {
      only: [
        {
          scope: { kind: 'global' },
          dimension: 'capability',
          targets: [{ kind: 'category', id: 'images' }],
        },
      ],
    },
  ],
  [
    'names another provider as the only one for web research',
    {
      only: [
        {
          scope: { kind: 'task', id: 'web research' },
          dimension: 'provider',
          targets: [{ kind: 'provider', id: 'coinmarketcap' }],
        },
      ],
    },
  ],
])(
  "refuses a worker's search, unpaid, when the person's rules leave Exa out: %s",
  async (_rule, policy) => {
    // The failure: a worker's searches went to Exa and were paid while the person had told
    // Tenjin not to use Exa, or anything for web research, on its own.
    await configure({ policy });
    const { fetchImpl, seen } = network();
    const { job, transport, deps, auth } = setup(fetchImpl);
    const reads = asWebSearchReads(
      await answerWorkerWebSearch(SEARCH, { ...deps, identities: async () => IDENTITIES }),
    );
    expect(reads.errors).toEqual(['unavailable']);
    expect(reads.text).toMatch(
      /^Web search is not available to this worker right now: the person's Tenjin settings keep Tenjin from using Exa search on its own/,
    );
    // Nothing asked of the router, nothing sent to Exa, nothing authorized or counted.
    expect(seen).toEqual([]);
    expect(auth.authorize).not.toHaveBeenCalled();
    expect((await transport.summary(job)).actualAtomic).toBe(ROUTING_FEE.toString());
  },
);

it("reads no page through Exa, and pays nothing, when the person's rules block Exa", async () => {
  // The failure: a worker's failed WebFetch was read through Exa, and paid, against a block.
  await configure({ policy: { block: [EXA] } });
  const { fetchImpl, seen } = network();
  const { deps, auth } = setup(fetchImpl);
  const read = await workerFetchFallback(
    {
      input: { url: 'https://x402.org', prompt: 'Summarize' },
      error: 'getaddrinfo ENOTFOUND x402.org',
    },
    { ...deps, identities: async () => IDENTITIES, redact: (text) => text },
  );
  expect(read).toContain('keep Tenjin from using Exa contents on its own');
  expect(read).not.toContain('The whole page.');
  expect(seen).toEqual([]);
  expect(auth.authorize).not.toHaveBeenCalled();
});

it.each([
  ['blocks another provider', { block: [{ kind: 'provider', id: 'coinmarketcap' }] }],
  [
    'lets Tenjin offer only lookups on its own',
    {
      only: [
        {
          scope: { kind: 'global' },
          dimension: 'capability',
          targets: [{ kind: 'category', id: 'lookups' }],
        },
      ],
    },
  ],
  [
    'names Exa as the only provider for web research',
    {
      only: [
        { scope: { kind: 'task', id: 'web research' }, dimension: 'provider', targets: [EXA] },
      ],
    },
  ],
  [
    'prefers another provider for web research',
    {
      prefer: [
        {
          scope: { kind: 'task', id: 'web research' },
          targets: [{ kind: 'provider', id: 'coinmarketcap' }],
        },
      ],
    },
  ],
])("still searches with Exa when the person's rules leave it in: %s", async (_rule, policy) => {
  // The failure: a rule about something else, or a preference, which never forbids a
  // service, cost the worker its searches.
  await configure({ policy });
  const { fetchImpl, seen } = network();
  const { deps } = setup(fetchImpl);
  const reads = asWebSearchReads(
    await answerWorkerWebSearch(SEARCH, { ...deps, identities: async () => IDENTITIES }),
  );
  expect(reads.errors).toEqual([]);
  expect(seen.filter((call) => call.url === EXA_SEARCH && call.paid)).toHaveLength(1);
});

it('refuses a search, unpaid, when a block rule cannot be checked because no identities read is known', async () => {
  // The failure: with the router unreachable and no kept copy, a provider block was taken
  // to leave Exa in.
  await configure({ policy: { block: [{ kind: 'provider', id: 'coinmarketcap' }] } });
  const { fetchImpl, seen } = network();
  const { deps } = setup(fetchImpl);
  const reads = asWebSearchReads(
    await answerWorkerWebSearch(SEARCH, { ...deps, identities: async () => undefined }),
  );
  expect(reads.errors).toEqual(['unavailable']);
  expect(seen).toEqual([]);
});

it('answers that search is not available when no request executor runs for the worker', async () => {
  await configure();
  const { job, transport } = setup(network().fetchImpl);
  const reads = asWebSearchReads(
    await answerWorkerWebSearch(SEARCH, { job, transport, dataDir: dir }),
  );
  expect(reads.errors).toEqual(['unavailable']);
});

it("recognises only WebSearch's own nested request, with its query and domain filters", () => {
  // The shape Claude Code 2.1.326 sends (probed): one server tool and one user message.
  const nested = {
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
  expect(workerWebSearch(nested)).toEqual({
    query: 'x402 receipts',
    allowedDomains: ['docs.example.org', 'x402.org'],
    blockedDomains: [],
  });
  // A request that also holds another tool is not WebSearch's: the bridge refuses it.
  expect(
    workerWebSearch({
      ...nested,
      tools: [...nested.tools, { name: 'Read', input_schema: { type: 'object' } }],
    }),
  ).toBeNull();
  expect(
    workerWebSearch({ ...nested, tools: [{ name: 'Read', input_schema: { type: 'object' } }] }),
  ).toBeNull();
});

it('reads a page through Exa when the local WebFetch failed on the network, and counts it', async () => {
  // The failure: a worker whose WebFetch could not reach a public page had no way to read it.
  await configure();
  const { fetchImpl, seen } = network();
  const { job, transport, deps } = setup(fetchImpl);
  const read: number[] = [];
  const context = await workerFetchFallback(
    {
      input: { url: 'https://x402.org', prompt: 'Summarize' },
      error: 'getaddrinfo ENOTFOUND x402.org',
    },
    { ...deps, redact: (text) => text, onRead: (bytes) => read.push(bytes) },
  );
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
    { ...deps, redact: (text) => text.replace('Zq8v3rys3cretvalue', '[env:KEY]') },
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

// Review finding: a worker stopped while its search waited for the free spec read still
// reserved the job's budget and paid for the search.
it('buys nothing for a worker stopped while its search waited, and releases what it reserved', async () => {
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
  const answer = await answerWorkerWebSearch(SEARCH, { ...deps, request, signal: stop.signal });
  expect(asWebSearchReads(answer).errors).toEqual(['unavailable']);
  expect(seen.filter((call) => call.paid)).toEqual([]);
  expect(await transport.summary(job)).toMatchObject({
    reservedAtomic: ROUTING_FEE.toString(),
    uncertain: [],
  });
  // A worker already stopped makes no request at all, not even the free one.
  const before = seen.length;
  await answerWorkerWebSearch(SEARCH, { ...deps, signal: stop.signal });
  expect(seen.length).toBe(before);
});

it.each([
  {
    service: 'search',
    url: EXA_SEARCH,
    run: (deps: WorkerWebDeps) => answerWorkerWebSearch(SEARCH, deps),
  },
  {
    service: 'page read',
    url: EXA_CONTENTS,
    run: (deps: WorkerWebDeps) =>
      workerFetchFallback(
        { input: { url: 'https://x402.org' }, error: 'getaddrinfo ENOTFOUND x402.org' },
        { ...deps, redact: (text) => text },
      ),
  },
])(
  'refuses to authorize a $service stopped during its unsigned Exa probe',
  async ({ url, run }) => {
    await configure();
    const stop = new AbortController();
    const { fetchImpl, seen } = network();
    let probeSignal: AbortSignal | null | undefined;
    const stoppedProbe: typeof fetch = (input, init) => {
      if (String(input) === url && !new Headers(init?.headers).has('payment-signature')) {
        probeSignal = init?.signal;
        stop.abort();
      }
      // The provider still answers 402 even if the request was cancelled.
      return fetchImpl(input, init);
    };
    const { job, transport, deps, auth } = setup(stoppedProbe);
    await run({ ...deps, signal: stop.signal });
    expect(probeSignal?.aborted).toBe(true);
    expect(seen.filter((call) => call.url === url)).toMatchObject([{ paid: false }]);
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(auth.commit).not.toHaveBeenCalled();
    expect(await transport.summary(job)).toEqual({
      reservedAtomic: ROUTING_FEE.toString(),
      actualAtomic: ROUTING_FEE.toString(),
      uncertain: [],
    });
  },
);

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
  await answerWorkerWebSearch(SEARCH, { ...deps, signal: stop.signal, request });
  expect(auth.authorize).toHaveBeenCalledOnce();
  expect(signTypedData).not.toHaveBeenCalled();
  expect(seen.filter((call) => call.url === EXA_SEARCH)).toMatchObject([{ paid: false }]);
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
  const result = await answerWorkerWebSearch(SEARCH, { ...deps, signal: stop.signal, request });
  expect(asWebSearchReads(result).errors).toEqual(['unavailable']);
  expect(signTypedData).toHaveBeenCalledOnce();
  expect(seen.filter((call) => call.url === EXA_SEARCH)).toMatchObject([{ paid: false }]);
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
  const { fetchImpl, seen } = network();
  let paidSignal: AbortSignal | null | undefined;
  const stoppedResponse: typeof fetch = (input, init) => {
    if (String(input) === EXA_SEARCH && new Headers(init?.headers).has('payment-signature')) {
      paidSignal = init?.signal;
      stop.abort();
    }
    return fetchImpl(input, init);
  };
  const { job, transport, deps, auth } = setup(stoppedResponse);
  await answerWorkerWebSearch(SEARCH, { ...deps, signal: stop.signal });
  expect(seen.filter((call) => call.url === EXA_SEARCH)).toMatchObject([
    { paid: false },
    { paid: true },
  ]);
  expect(paidSignal?.aborted).toBe(false);
  expect(auth.commit).toHaveBeenCalledWith('rsv', 4000n, expect.anything());
  expect(auth.release).not.toHaveBeenCalled();
  expect(await transport.summary(job)).toEqual({
    reservedAtomic: (ROUTING_FEE + 4000n).toString(),
    actualAtomic: (ROUTING_FEE + 4000n).toString(),
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
// was read passed, since a named read skips blocks, and the search was bought.
it('buys nothing when a block of Exa is saved between the rules check and the spec read', async () => {
  // An unrelated block is saved, so the rules are checked against the router's identities.
  await configure({ policy: { block: [{ kind: 'provider', id: 'coinmarketcap' }] } });
  const { fetchImpl, seen } = network();
  const { job, transport, deps } = setup(fetchImpl);
  const { storeSpecs } = await import('./specs');
  const request: WorkerRequest = async (args, call) => {
    if (args.tool === undefined) return deps.request!(args, call);
    // The person blocks Exa while the spec is read; a named read skips blocks, and the
    // spec is kept under the new rules, so the paid request would find them unchanged.
    await configure({ policy: { block: [EXA] } });
    const id = randomUUID();
    await storeSpecs(dir, [{ ...SEARCH_SPEC, id } as never], await savedHash());
    return { isError: false, summary: '', envelope: { status: 'spec', id } };
  };
  const answer = await answerWorkerWebSearch(SEARCH, {
    ...deps,
    request,
    identities: async () => IDENTITIES,
  });
  expect(asWebSearchReads(answer).text).toContain('settings changed during the call');
  expect(seen.filter((call) => call.paid)).toEqual([]);
  expect(await transport.summary(job)).toMatchObject({
    reservedAtomic: ROUTING_FEE.toString(),
    uncertain: [],
  });
});

it('keeps the whole ceiling reserved for a search whose payment the spend gate never settled, and reconcile leaves it', async () => {
  // The failure: a payment that may have left was released from the job's budget, or its
  // local id was sent to the model proxy as if it named a model call.
  await configure();
  const { job, transport, auth } = setup(network().fetchImpl);
  const { storeSpecs } = await import('./specs');
  const request: WorkerRequest = async (args, { watch }) => {
    if (args.tool !== undefined) {
      const id = randomUUID();
      // Kept under the rules saved now, as the request tool keeps a spec it read.
      await storeSpecs(dir, [{ ...SEARCH_SPEC, id } as never], await savedHash());
      return { isError: false, summary: '', envelope: { status: 'spec', id } };
    }
    // Reserved at the gate, then neither committed nor released: it may have been signed.
    await watch(auth).authorize({ amountAtomic: 4000n, creator: 'api.exa.ai' });
    return { isError: true, summary: '', envelope: { status: 'failed', reason: 'cut off' } };
  };
  await answerWorkerWebSearch(SEARCH, { job, transport, dataDir: dir, request });
  const before = await transport.summary(job);
  expect(before).toMatchObject({
    reservedAtomic: (ROUTING_FEE + 7000n).toString(),
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
