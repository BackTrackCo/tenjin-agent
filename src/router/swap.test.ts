import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPay } from '../commands/pay';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import type { SavedPolicy } from './access';
import type { AccountOfferSpec, DirectoryListing, Identity, OfferSpec } from './decision';
import { runNativeHook, type HookDeps } from './hooks';
import { readPaidRecords } from './paid';
import { redirectClaimed, renderProgress, sessionDir } from './progress';
import { claimSpecPayment } from './specs';
import { runSwap } from './swap';
import type { RequestToolDeps } from './tool';
import { AccountLimited, type AccountCallResult } from './accounts/client';
import { fakeKeychain } from './accounts/test-support';
import { clearVaultKeyCache, writeVault } from './accounts/vault';

// Pass-through, so a test can say no payment was even attempted.
vi.mock('../commands/pay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/pay')>();
  return { ...actual, runPay: vi.fn(actual.runPay) };
});

/**
 * THE SWAP, FROM THE MCP PROCESS'S SIDE: one native search the plugin's mod
 * asks about before it runs. It runs Tenjin's pick in the search's place only
 * when every condition holds, through the ordinary executor, and is tagged
 * `via: "swap"` on the ledger and the outcome report; anything else hands the
 * search back, and the pre-call hook then offers from the decision already
 * made, never a second one.
 */

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
const LISTING = (fixture('wire-directory.json') as { directory: DirectoryListing }).directory;
const identityOf = (service: string): Identity =>
  LISTING.services.find(({ id }) => id === service)!.identity;

const ROUTER = 'https://tenjin.sh';
const PROVIDER = 'https://pro-api.example.test/x402/v3/quotes';
const PAYEE = '0x1111111111111111111111111111111111111111';
const SPEC_ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d01';
const SESSION = 'sess-swap';
const TOOL_USE = 'toolu_swap';
const QUERY = 'bitcoin price now';
const LIMITS = { maxAutoSpend: '250000', sessionBudget: '5000000' };

let dir: string;
let transcript: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-swap-'));
  await mkdir(join(dir, '.git'));
  transcript = join(dir, `${SESSION}.jsonl`);
  await writeFile(
    transcript,
    JSON.stringify({ type: 'user', sessionId: SESSION, message: { content: `look up ${QUERY}` } }),
  );
  await saveConfig({ nativeReplacement: 'when-routed' });
  vi.mocked(runPay).mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The global file as `tenjin config` leaves it: limits and the router block. */
function saveConfig(router: Record<string, unknown>, limits: Record<string, string> = LIMITS) {
  return writeFile(join(dir, 'config.json'), JSON.stringify({ ...limits, router }));
}
const policy = (rules: Omit<SavedPolicy, 'version'>) => ({ policy: { version: 1, ...rules } });
const provider = (id: string) => ({ kind: 'provider' as const, id });

function spec(over: Partial<OfferSpec> = {}): OfferSpec {
  return {
    id: SPEC_ID,
    capabilityId: 'cmc-quotes',
    provider: 'CoinMarketCap',
    label: 'CMC quotes',
    description: 'latest market quotes for one or more cryptocurrencies',
    priceAtomic: '10000',
    priceVaries: false,
    maxAmountAtomic: '10000',
    payTo: PAYEE,
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    request: { method: 'GET', url: PROVIDER, fields: { symbol: 'query' }, location: 'query' },
    input: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
      additionalProperties: false,
    },
    pinned: {},
    identity: identityOf('cmc-quotes'),
    ...over,
  };
}

/** The router's answer to the hook body: its pick, its spec and `bound`. */
function decision(over: Record<string, unknown> = {}, lead: Partial<OfferSpec> = {}) {
  return {
    schemaVersion: 1,
    routerVersion: 'v',
    decision: {
      action: 'execute',
      id: SPEC_ID,
      capabilityId: 'cmc-quotes',
      category: 'crypto price quote',
      provider: 'CoinMarketCap',
      label: 'CMC quotes',
      capabilityDescription: 'latest market quotes',
      providerPriceAtomic: '10000',
      identity: identityOf('cmc-quotes'),
      endpoint: PROVIDER,
      usage: 'the coin symbol',
      hint: `CMC quotes, $0.01: call request({id: "${SPEC_ID}", input: {"symbol": "<coin>"}}) instead.`,
      specs: [spec(lead)],
      bound: { symbol: 'BTC' },
      ...over,
    },
  };
}

interface Sent {
  url: string;
  paid: boolean;
  body?: Record<string, unknown>;
}

/** The router (decisions and outcome reports) and the provider, every call kept. */
function network(
  opts: {
    decide?: () => unknown;
    paidStatus?: number;
    paidBody?: unknown;
    payTo?: string;
  } = {},
) {
  const calls: Sent[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const paid = new Headers(init?.headers ?? {}).get('payment-signature') !== null;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    calls.push({ url, paid, ...(body !== undefined ? { body } : {}) });
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
    if (url.startsWith(ROUTER)) {
      if (body !== undefined && 'status' in body) return json(200, {});
      return json(200, opts.decide?.() ?? decision());
    }
    if (!paid) {
      return json(
        402,
        {},
        {
          'PAYMENT-REQUIRED': buildPaymentRequired({
            amount: '10000',
            ...(opts.payTo !== undefined ? { payTo: opts.payTo } : {}),
          }).header,
        },
      );
    }
    return json(opts.paidStatus ?? 200, opts.paidBody ?? { data: { BTC: 1 } });
  }) as typeof fetch;
  const isReport = (call: Sent) => call.body !== undefined && 'status' in call.body;
  return {
    fetchImpl,
    decisions: () => calls.filter((call) => call.url.startsWith(ROUTER) && !isReport(call)),
    reports: () => calls.filter(isReport).map(({ body }) => body),
    providerCalls: () => calls.filter((call) => !call.url.startsWith(ROUTER)),
    signed: () => calls.filter((call) => call.paid),
  };
}

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: ROUTER },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

function authorizer(): SpendAuthorizer {
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

function hookDeps(fetchImpl: typeof fetch): HookDeps {
  return {
    dataDir: dir,
    baseUrl: ROUTER,
    fetchImpl,
    warn: () => undefined,
    // Inside `tenjin mcp` the payer's verdict: this wallet can sign.
    signer: () => ({ status: 'ready' }),
  };
}

function requestDeps(fetchImpl: typeof fetch): RequestToolDeps {
  const auth = authorizer();
  return {
    ctx: ctx(),
    cwd: dir,
    authorizer: auth,
    fetchImpl,
    mediaTransport: async () => {
      throw new Error('no media download expected');
    },
    payDeps: {
      readBalance: async () => 100_000_000n,
      fetchImpl,
      provider: testWalletProvider(),
      authorizer: auth,
      destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
    },
  };
}

/** The native search as the MCP process admits it from the mod's `decide`. */
function search(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: SESSION,
    transcript_path: transcript,
    cwd: dir,
    tool_name: 'WebSearch',
    tool_input: { query: QUERY },
    tool_use_id: TOOL_USE,
    ...over,
  };
}

const swap = (net: ReturnType<typeof network>, event = search()) =>
  runSwap(event, hookDeps(net.fetchImpl), requestDeps(net.fetchImpl));

/** The one offer record the session holds, as the mod reads it. */
async function offerRecord(): Promise<Record<string, unknown>> {
  const names = await readdir(sessionDir(dir, SESSION));
  const offer = names.find((name) => name.startsWith('offer-'))!;
  return JSON.parse(readFileSync(join(sessionDir(dir, SESSION), offer), 'utf8'));
}

/** The global file, rewritten while the router decides: another process saving. */
const savedWhileDeciding = (router: Record<string, unknown>) => () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...LIMITS, router }));
  return decision();
};

describe('a search run in place', () => {
  it('runs the bound input once through the executor, tagged on the ledger and the report', async () => {
    const net = network();
    const result = await swap(net);
    expect(result.envelope).toMatchObject({ status: 'fulfilled', via: 'swap' });
    // One decision, through the hook body: the gate's floor applies to it.
    expect(net.decisions()).toHaveLength(1);
    expect(net.decisions()[0]!.body).toMatchObject({
      packet: { pendingCall: { tool: 'WebSearch', query: QUERY } },
    });
    // The bound input, exactly: the provider got `symbol=BTC` and nothing built here.
    expect(net.signed()).toHaveLength(1);
    expect(new URL(net.signed()[0]!.url).searchParams.get('symbol')).toBe('BTC');
    const [row] = await readPaidRecords(dir);
    expect(row).toMatchObject({ capabilityId: 'cmc-quotes', via: 'swap' });
    await vi.waitFor(() =>
      expect(net.reports()).toEqual([
        expect.objectContaining({ status: 'fulfilled', via: 'swap' }),
      ]),
    );
    // Claimed like a redirect: the model's own retry of this search runs natively.
    expect(await redirectClaimed(dir, SESSION, undefined, `WebSearch ${QUERY}`)).toBe(true);
    const again = network();
    const retry = await swap(again, search({ tool_use_id: 'toolu_retry' }));
    expect(retry.envelope).toMatchObject({ status: 'native', swap: 'handback' });
    expect(again.decisions()).toEqual([]);
  });

  it('runs one of two parallel copies of the same search, and hands the other back', async () => {
    // Each copy gets its own decision, under its own id.
    let n = 0;
    const net = network({
      decide: () => {
        n += 1;
        const id = `${SPEC_ID.slice(0, -2)}0${String(n)}`;
        return decision(
          { id, hint: `CMC quotes: call request({id: "${id}", input: {}}) instead.` },
          { id },
        );
      },
    });
    const [a, b] = await Promise.all([
      swap(net),
      swap(net, search({ tool_use_id: 'toolu_parallel' })),
    ]);
    const swapped = [a, b].filter((r) => r.envelope.via === 'swap');
    expect(swapped).toHaveLength(1);
    expect([a, b].filter((r) => r.envelope.swap === 'handback')).toHaveLength(1);
    expect(net.signed()).toHaveLength(1);
  });

  it('marks the call as answered in place for the mod, never as held', async () => {
    await swap(network());
    expect(await offerRecord()).toMatchObject({
      offerId: SPEC_ID,
      label: 'CMC quotes',
      swap: true,
    });
  });

  it('returns a failure after the provider call started, with what was paid, never a hand-back', async () => {
    const net = network({ paidStatus: 500 });
    const result = await swap(net);
    expect(result.envelope).toMatchObject({ status: 'failed', via: 'swap' });
    expect(result.envelope.swap).toBeUndefined();
    expect(net.signed()).toHaveLength(1);
  });
});

describe('a search handed back', () => {
  it('asks nothing while automatic use is off, the default', async () => {
    await saveConfig({});
    const net = network();
    const result = await swap(net);
    expect(result).toMatchObject({
      isError: false,
      envelope: { status: 'native', swap: 'handback', reason: 'automatic use is off' },
    });
    expect(net.decisions()).toEqual([]);
  });

  it('asks nothing for a subagent, or while Tenjin is paused', async () => {
    const net = network();
    expect((await swap(net, search({ agent_id: 'agent-1' }))).envelope).toMatchObject({
      swap: 'handback',
    });
    await saveConfig({ nativeReplacement: 'when-routed', enabled: false });
    expect((await swap(net)).envelope).toMatchObject({ swap: 'handback' });
    expect(net.decisions()).toEqual([]);
  });

  it('without bound, and the pre-call hook offers from the same decision', async () => {
    const net = network({ decide: () => decision({ bound: undefined }) });
    const result = await swap(net);
    expect(result.envelope).toMatchObject({ swap: 'handback', reason: 'no input to run in place' });
    expect(net.signed()).toEqual([]);
    // The host runs its pre-call hook next: one decision for this search, not two.
    const hook = await runNativeHook(search(), hookDeps(net.fetchImpl));
    expect(hook).toMatchObject({ action: 'execute', id: SPEC_ID });
    expect(net.decisions()).toHaveLength(1);
  });

  it('with the routing fee unpaid: the pre-call footer keeps saying so', async () => {
    const net = network({
      decide: () => ({
        schemaVersion: 1,
        routerVersion: 'v',
        decision: {
          action: 'native',
          reason: 'The routing fee was not paid.',
          diagnostics: {
            reasonCode: 'fee_required',
            stage: 'capability',
            missing: [],
            nextAction: 'Answer with your own tools.',
          },
        },
      }),
    });
    expect((await swap(net)).envelope).toMatchObject({
      swap: 'handback',
      reason: 'no paid lookup fits',
    });
    expect(await renderProgress(dir, SESSION)).toBe('x402 · search: fee unpaid: fee_required');
    // The pre-call hook runs from the kept decision, a moment later: its line
    // replaces the swap's, and must not pass the unpaid fee off as a choice.
    const later = Date.now() + 1000;
    await runNativeHook(search(), { ...hookDeps(net.fetchImpl), now: () => later });
    expect(net.decisions()).toHaveLength(1);
    expect(await renderProgress(dir, SESSION, { now: later })).toBe(
      'x402 · search: fee unpaid: fee_required',
    );
  });

  it('when the pick is outside the automatic scope, which never reranks or restricts', async () => {
    await saveConfig({
      nativeReplacement: 'when-routed',
      nativeReplacementProviders: [provider('exa')],
    });
    const net = network();
    expect((await swap(net)).envelope).toMatchObject({ reason: 'outside automatic use' });
    expect(net.signed()).toEqual([]);
    // The same pick is still an ordinary offer.
    expect(await runNativeHook(search(), hookDeps(net.fetchImpl))).toMatchObject({
      action: 'execute',
    });
  });

  it('when a narrowed scope meets a route with no known provider', async () => {
    await saveConfig({
      nativeReplacement: 'when-routed',
      nativeReplacementProviders: [provider('coinmarketcap')],
    });
    const net = network({ decide: () => decision({}, { identity: undefined }) });
    expect((await swap(net)).envelope).toMatchObject({ reason: 'outside automatic use' });
    // Inside the scope, the same pick with its identity runs.
    const fits = network();
    expect((await swap(fits, search({ tool_use_id: 'toolu_2' }))).envelope).toMatchObject({
      via: 'swap',
    });
  });

  it('when the price is over the automatic limit: nothing signed, and it is offered as usual', async () => {
    await saveConfig({ nativeReplacement: 'when-routed' }, { ...LIMITS, maxAutoSpend: '5000' });
    const net = network();
    expect((await swap(net)).envelope).toMatchObject({ reason: 'offer needs approval' });
    expect(runPay).not.toHaveBeenCalled();
    expect(net.signed()).toEqual([]);
  });

  it('when a block is saved while the router decides: no provider HTTP at all', async () => {
    const net = network({
      decide: () => {
        writeFileSync(
          join(dir, 'config.json'),
          JSON.stringify({
            ...LIMITS,
            router: {
              nativeReplacement: 'when-routed',
              ...policy({ block: [provider('coinmarketcap')] }),
            },
          }),
        );
        return decision();
      },
    });
    expect((await swap(net)).envelope).toMatchObject({ reason: 'your settings rule it out' });
    expect(net.providerCalls()).toEqual([]);
    // Never claimed: the native call runs as it would have.
    expect(await redirectClaimed(dir, SESSION, undefined, `WebSearch ${QUERY}`)).toBe(false);
  });

  it('when automatic use is turned off while the router decides: nothing claimed or sent', async () => {
    const net = network({ decide: savedWhileDeciding({}) });
    expect((await swap(net)).envelope).toMatchObject({
      swap: 'handback',
      reason: 'automatic use is off',
    });
    expect(net.providerCalls()).toEqual([]);
    expect(runPay).not.toHaveBeenCalled();
    expect(await redirectClaimed(dir, SESSION, undefined, `WebSearch ${QUERY}`)).toBe(false);
  });

  it('when the scope is narrowed past the pick while the router decides', async () => {
    const net = network({
      decide: savedWhileDeciding({
        nativeReplacement: 'when-routed',
        nativeReplacementProviders: [provider('exa')],
      }),
    });
    expect((await swap(net)).envelope).toMatchObject({
      swap: 'handback',
      reason: 'outside automatic use',
    });
    expect(net.providerCalls()).toEqual([]);
    expect(await redirectClaimed(dir, SESSION, undefined, `WebSearch ${QUERY}`)).toBe(false);
  });

  it('after the claim, keeps the claim but never says the call ran in place', async () => {
    // Paused while the router decides: the executor refuses once the call is
    // claimed, before anything is sent, and the native call runs instead.
    const net = network({
      decide: savedWhileDeciding({ nativeReplacement: 'when-routed', enabled: false }),
    });
    expect((await swap(net)).envelope).toMatchObject({ status: 'native', swap: 'handback' });
    expect(net.providerCalls()).toEqual([]);
    expect(await redirectClaimed(dir, SESSION, undefined, `WebSearch ${QUERY}`)).toBe(true);
    // No pick and no swap mark for the mod to draw; the stamp stays, so the
    // after-call arm reads the one routing answer this call had.
    expect(await offerRecord()).toEqual({ version: 1, at: expect.any(Number) });
  });

  it('when the rules already refuse the pick', async () => {
    await saveConfig({
      nativeReplacement: 'when-routed',
      ...policy({ block: [{ kind: 'service', id: 'cmc-quotes' }] }),
    });
    const net = network();
    expect((await swap(net)).envelope).toMatchObject({ reason: 'settings rule it out' });
    expect(net.providerCalls()).toEqual([]);
  });
});

/**
 * A CHECKED MAP ON THE USER'S CONNECTED ACCOUNT, run in a native fetch's place
 * (vraspar, 2026-10-23: "yes, include it"). The router binds it as any lead;
 * here it meets the same rereads, rules and claim, runs on the account with
 * the map's pins, and its receipt says what it replaced. The account's plan
 * pays, so the Tenjin limits are not asked. When the account refuses before
 * anything ran, Tenjin's own tool stands in only where the user opted in, and
 * only past the same checks; otherwise the refusal and its offer answer.
 */
describe("a fetch run in place on the user's own account", () => {
  const BOUND = fixture('wire-hook-execute-account-bound.json') as {
    decision: Record<string, unknown> & {
      id: string;
      specs: AccountOfferSpec[];
      fallback: OfferSpec;
      bound: { url: string };
    };
  };
  const LEAD = BOUND.decision.specs[0]!;
  const FALLBACK = BOUND.decision.fallback;
  const URL_ASKED = BOUND.decision.bound.url;
  const FIRECRAWL = {
    id: 'firecrawl',
    label: 'Firecrawl',
    mcpUrl: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
  };
  const PAGE = { markdown: '# Pricing\nPro: $20', metadata: { title: 'Pricing' } };
  const ISSUER = 'https://auth.example.test';

  let keychain: ReturnType<typeof fakeKeychain>;
  beforeEach(() => {
    keychain = fakeKeychain();
    clearVaultKeyCache();
  });

  /** The router's answer: the checked Firecrawl scrape, `bound` from the fetch. */
  const answer = (edit: (d: typeof BOUND.decision) => Record<string, unknown> = (d) => d) => ({
    ...BOUND,
    decision: edit(BOUND.decision),
  });

  /** Firecrawl saved and signed in on this machine, with automatic use on. */
  async function connected(
    over: { onRefusal?: 'tenjin'; state?: 'ok' | 'expired' } = {},
    router: Record<string, unknown> = {},
    limits: Record<string, string> = LIMITS,
  ) {
    await saveConfig(
      {
        nativeReplacement: 'when-routed',
        sources: [
          {
            ...FIRECRAWL,
            signIn: 'oauth',
            mapped: true,
            ...(over.onRefusal !== undefined ? { onRefusal: over.onRefusal } : {}),
          },
        ],
        ...router,
      },
      limits,
    );
    const now = Date.now();
    await writeVault(
      FIRECRAWL.id,
      FIRECRAWL.label,
      {
        kind: 'oauth',
        mcpUrl: FIRECRAWL.mcpUrl,
        connectedAt: new Date(now - 60_000).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
        state: over.state ?? 'ok',
        ready: [],
        missing: [],
      },
      {
        tokens: { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer' },
        obtainedAt: now - 60_000,
        clientInformation: { client_id: 'https://tenjin.sh/oauth/client-metadata.json' },
        discoveryState: {
          authorizationServerUrl: ISSUER,
          authorizationServerMetadata: {
            issuer: ISSUER,
            authorization_endpoint: `${ISSUER}/authorize`,
            token_endpoint: `${ISSUER}/token`,
            response_types_supported: ['code'],
          },
        },
      },
      { dataDir: dir, platform: 'darwin', exec: keychain.exec },
    );
  }

  /** The account's MCP server: each call it got, and its answer. */
  function firecrawl(answers: (AccountCallResult | Error)[] = [{ structuredContent: PAGE }]) {
    const called: { tool: string; args: Record<string, unknown> }[] = [];
    const openSession: NonNullable<RequestToolDeps['accounts']>['openSession'] = async () => ({
      listTools: async () => [],
      callTool: async (tool, args) => {
        called.push({ tool, args });
        const next = answers.length > 1 ? answers.shift()! : answers[0]!;
        if (next instanceof Error) throw next;
        return next;
      },
      close: async () => undefined,
    });
    return { openSession, called };
  }

  const fetchEvent = (over: Record<string, unknown> = {}) =>
    search({ tool_name: 'WebFetch', tool_input: { url: URL_ASKED }, ...over });

  const swapOnAccount = (
    net: ReturnType<typeof network>,
    account: ReturnType<typeof firecrawl>,
    event = fetchEvent(),
    hook: Partial<HookDeps> = {},
  ) =>
    runSwap(
      event,
      { ...hookDeps(net.fetchImpl), ...hook },
      {
        ...requestDeps(net.fetchImpl),
        accounts: { exec: keychain.exec, platform: 'darwin', openSession: account.openSession },
      },
    );

  const target = `WebFetch ${new URL(URL_ASKED).toString()}`;

  it("runs the bound input on the account with the map's pins, outside the limits, and says what it replaced", async () => {
    // A per-call limit no Tenjin tool here fits: the account's plan pays.
    await connected({}, {}, { maxAutoSpend: '1', sessionBudget: '1' });
    const net = network({ decide: () => answer() });
    const account = firecrawl();
    const result = await swapOnAccount(net, account);
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      via: 'swap',
      cost: ['billed to your Firecrawl account, not the Tenjin balance'],
      receipt: 'Firecrawl · your account · instead of WebFetch',
    });
    expect(result.summary).toBe('Firecrawl · your account · instead of WebFetch');
    // The bound URL, with the map's own pins and nothing built here.
    expect(account.called).toEqual([
      {
        tool: 'firecrawl_scrape',
        args: {
          url: URL_ASKED,
          objective: "Read this page's main content.",
          formats: ['markdown'],
          onlyMainContent: true,
          parsers: ['pdf'],
          pdfOptions: { maxPages: 10 },
        },
      },
    ]);
    expect(net.decisions()).toHaveLength(1);
    expect(net.providerCalls()).toEqual([]);
    expect(runPay).not.toHaveBeenCalled();
    const [row, ...more] = await readPaidRecords(dir);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      capabilityId: 'firecrawl.scrape',
      source: 'firecrawl',
      settlement: 'account',
      amountAtomic: '0',
      via: 'swap',
    });
    await vi.waitFor(() =>
      expect(net.reports()).toEqual([
        expect.objectContaining({ id: LEAD.id, status: 'fulfilled', via: 'swap' }),
      ]),
    );
    expect(await offerRecord()).toMatchObject({ offerId: LEAD.id, swap: true });
    expect(await offerRecord()).not.toHaveProperty('priceAtomic');
    // Claimed like any swap: the model's own retry of this fetch runs natively.
    expect(await redirectClaimed(dir, SESSION, undefined, target)).toBe(true);
    const again = network({ decide: () => answer() });
    const retry = await swapOnAccount(again, account, fetchEvent({ tool_use_id: 'toolu_retry' }));
    expect(retry.envelope).toMatchObject({ status: 'native', swap: 'handback' });
    expect(account.called).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/x402|USDC|wallet|Jev/i);
  });

  it('never runs a map Tenjin has not checked: the router answer does not parse', async () => {
    await connected();
    const net = network({
      decide: () => answer((d) => ({ ...d, specs: [{ ...LEAD, verified: false }] })),
    });
    const account = firecrawl();
    const result = await swapOnAccount(net, account);
    expect(result.envelope).toMatchObject({ swap: 'handback', reason: 'no paid lookup fits' });
    expect(account.called).toEqual([]);
  });

  it("hands back when the account is outside automatic use's providers, and offers it as usual", async () => {
    await connected({}, { nativeReplacementProviders: [provider('exa')] });
    const net = network({ decide: () => answer() });
    const account = firecrawl();
    expect((await swapOnAccount(net, account)).envelope).toMatchObject({
      swap: 'handback',
      reason: 'outside automatic use',
    });
    expect(account.called).toEqual([]);
    expect(await redirectClaimed(dir, SESSION, undefined, target)).toBe(false);
    // The same pick is the pre-call hook's offer, from the one decision.
    const hook = await runNativeHook(fetchEvent(), hookDeps(net.fetchImpl));
    expect(hook).toMatchObject({ action: 'execute', id: LEAD.id });
    expect(net.decisions()).toHaveLength(1);
    // Narrowed to the account's own provider, it runs.
    const fits = network({ decide: () => answer() });
    await saveConfig({
      nativeReplacement: 'when-routed',
      nativeReplacementProviders: [provider('firecrawl')],
      sources: [{ ...FIRECRAWL, signIn: 'oauth', mapped: true }],
    });
    const ran = await swapOnAccount(
      fits,
      account,
      fetchEvent({ tool_use_id: 'toolu_scoped', tool_input: { url: `${URL_ASKED}?plans` } }),
    );
    expect(ran.envelope).toMatchObject({ status: 'fulfilled', via: 'swap' });
  });

  it('hands back, with nothing claimed or sent, when the account is removed while the router decides', async () => {
    await connected();
    const net = network({
      decide: () => {
        // Another process saving the settings without the account.
        writeFileSync(
          join(dir, 'config.json'),
          JSON.stringify({ ...LIMITS, router: { nativeReplacement: 'when-routed' } }),
        );
        return answer();
      },
    });
    const account = firecrawl();
    expect((await swapOnAccount(net, account)).envelope).toMatchObject({
      swap: 'handback',
      reason: 'your settings rule it out',
    });
    expect(account.called).toEqual([]);
    expect(await redirectClaimed(dir, SESSION, undefined, target)).toBe(false);
  });

  it('a host that cannot run a pick in place asks nothing', async () => {
    await connected();
    const net = network({ decide: () => answer() });
    const account = firecrawl();
    expect(
      (await swapOnAccount(net, account, fetchEvent(), { harness: 'codex' })).envelope,
    ).toMatchObject({ swap: 'handback', reason: 'this host cannot run a pick in place' });
    expect(net.decisions()).toEqual([]);
    expect(account.called).toEqual([]);
  });

  describe('when the account refuses before anything ran', () => {
    it("answers with the refusal and Tenjin's tool for the user to pick, and the fetch runs if called again", async () => {
      await connected({ state: 'expired' });
      const net = network({ decide: () => answer() });
      const account = firecrawl();
      const result = await swapOnAccount(net, account);
      expect(result.envelope).toMatchObject({
        status: 'needs_input',
        via: 'swap',
        cost: ['nothing charged'],
        refused: { account: 'Firecrawl', reason: 'signin_expired' },
        fallback: { id: FALLBACK.id, label: 'Firecrawl page read', price: '$0.015' },
      });
      expect(result.envelope).not.toHaveProperty('switched');
      expect(result.summary).toMatch(/^Your Firecrawl sign-in has expired\. /);
      expect(result.summary).toContain(
        'The WebFetch did not run; call it again to run it as usual.',
      );
      expect(account.called).toEqual([]);
      expect(net.providerCalls()).toEqual([]);
      // The fetch called again runs natively, with no second decision.
      const retry = await swapOnAccount(net, account, fetchEvent({ tool_use_id: 'toolu_again' }));
      expect(retry.envelope).toMatchObject({ swap: 'handback', reason: 'already routed once' });
      expect(net.decisions()).toHaveLength(1);
    });

    it("with the opt-in, runs Tenjin's tool in its place under the limits, tagged on its ledger row", async () => {
      await connected({ onRefusal: 'tenjin' });
      const net = network({ decide: () => answer(), paidBody: PAGE, payTo: FALLBACK.payTo });
      const account = firecrawl([new AccountLimited(429)]);
      const result = await swapOnAccount(net, account);
      expect(account.called).toHaveLength(1);
      expect(result.envelope).toMatchObject({
        status: 'fulfilled',
        via: 'swap',
        cost: ['provider price 0.01 USD'],
        switched: { from: 'Firecrawl', to: 'Firecrawl page read', reason: 'rate_limited' },
      });
      expect(net.signed()).toHaveLength(1);
      const [row] = await readPaidRecords(dir);
      expect(row).toMatchObject({ capabilityId: 'munition-scrape', source: 'tenjin', via: 'swap' });
    });

    it("with the opt-in, over the per-call limit: nothing paid, and the refusal and Tenjin's tool answer", async () => {
      await connected({ onRefusal: 'tenjin' }, {}, { ...LIMITS, maxAutoSpend: '5000' });
      const net = network({ decide: () => answer() });
      const account = firecrawl([new AccountLimited(402)]);
      const result = await swapOnAccount(net, account);
      expect(result.envelope).toMatchObject({
        status: 'needs_input',
        via: 'swap',
        refused: { reason: 'credit' },
        fallback: { id: FALLBACK.id },
      });
      expect(result.envelope).not.toHaveProperty('switched');
      // Not even a price probe to Tenjin's tool.
      expect(net.providerCalls()).toEqual([]);
      expect(runPay).not.toHaveBeenCalled();
    });

    it("with the opt-in, outside automatic use's providers: the refusal and Tenjin's tool answer", async () => {
      await connected(
        { onRefusal: 'tenjin' },
        { nativeReplacementProviders: [provider('firecrawl')] },
      );
      const net = network({
        decide: () =>
          answer((d) => ({
            ...d,
            fallback: { ...FALLBACK, identity: { ...FALLBACK.identity, providers: ['munition'] } },
          })),
      });
      const account = firecrawl([new AccountLimited(429)]);
      const result = await swapOnAccount(net, account);
      expect(result.envelope).toMatchObject({ refused: { reason: 'rate_limited' }, via: 'swap' });
      expect(result.envelope).not.toHaveProperty('switched');
      expect(net.providerCalls()).toEqual([]);
    });

    it("with the opt-in, when Tenjin's tool then runs nothing, the refusal and its offer answer", async () => {
      await connected({ onRefusal: 'tenjin' });
      // Tenjin's tool for this offer was already called once.
      await claimSpecPayment(dir, FALLBACK.id);
      const net = network({ decide: () => answer() });
      const account = firecrawl([new AccountLimited(429)]);
      const result = await swapOnAccount(net, account);
      expect(result.envelope).toMatchObject({ refused: { reason: 'rate_limited' }, via: 'swap' });
      expect(result.envelope).not.toHaveProperty('switched');
      expect(net.signed()).toEqual([]);
    });
  });

  it('once the account call started, never starts another provider, even with the opt-in', async () => {
    await connected({ onRefusal: 'tenjin' });
    const net = network({ decide: () => answer() });
    // The account's own error answer: its job may have started.
    const account = firecrawl([
      { isError: true, content: [{ type: 'text', text: 'Insufficient credits' }] },
    ]);
    const result = await swapOnAccount(net, account);
    expect(account.called).toHaveLength(1);
    expect(result.envelope).toMatchObject({ via: 'swap', refused: { reason: 'credit' } });
    expect(result.envelope).not.toHaveProperty('switched');
    expect(net.providerCalls()).toEqual([]);
  });

  it('once the account ran and failed, that is the answer: never a hand-back or another provider', async () => {
    await connected({ onRefusal: 'tenjin' });
    const net = network({ decide: () => answer() });
    const account = firecrawl([{ content: [] }]);
    const result = await swapOnAccount(net, account);
    expect(account.called).toHaveLength(1);
    expect(result.envelope).toMatchObject({
      status: 'failed',
      via: 'swap',
      cost: ['billed to your Firecrawl account, not the Tenjin balance'],
    });
    expect(result.envelope.swap).toBeUndefined();
    expect(net.providerCalls()).toEqual([]);
  });
});
