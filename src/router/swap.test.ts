import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testAuthorizer, testWalletProvider } from '../lib/read-test-utils';
import { testCtx } from '../context-test-utils';
import { paidLedgerPath } from '../lib/paths';
import { runSwap } from './swap';
import { runNativeHook } from './hooks';
import { hashNow } from './settings-test-utils';
import { acceptsFor, ROUTER_PATH } from './decision';

/**
 * THE SWAP (plan 36): with "Run Tenjin's picks automatically" on, a native
 * search the router answers with `bound` runs that input unchanged through
 * the ordinary executor and its check before every call, marked `via: swap`.
 * Anything else hands the call back, and the pre-call hook offers from the
 * answer already got.
 */

const ANSWER = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./fixtures/wire-hook-execute-bound.json', import.meta.url)),
    'utf8',
  ),
) as {
  settingsHash?: string;
  decision: Record<string, unknown> & {
    id: string;
    bound?: unknown;
    specs: Record<string, unknown>[];
  };
};
const ID = ANSWER.decision.id;
const QUERY = 'btc eth price today';
const EXA = 'https://api.exa.ai/search';
const BASE = 'https://tenjin.sh';
const PAYEE = String(ANSWER.decision.specs[0]!.payTo);

let dir: string;
let transcript: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-swap-'));
  await mkdir(join(dir, '.git'));
  await save({ nativeReplacement: 'when-routed' });
  await writeFile(
    join(dir, 'wallet.json'),
    JSON.stringify({ schemaVersion: 2, address: '0x1234567890AbcdEF1234567890aBcdef12345678' }),
  );
  transcript = join(dir, 'sess-1.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({ type: 'user', sessionId: 'sess-1', message: { content: `look up ${QUERY}` } }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function save(router: Record<string, unknown>, maxAutoSpend = '250000'): Promise<void> {
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend, sessionBudget: '5000000', router }),
  );
}

const event = () => ({
  hook_event_name: 'PreToolUse',
  session_id: 'sess-1',
  transcript_path: transcript,
  cwd: dir,
  tool_name: 'WebSearch',
  tool_input: { query: QUERY },
  tool_use_id: 'toolu_swap',
});

/** The router answers `answer` (and records reports apart); Exa answers 402 then 200. */
/** The router: `answer` for a routing call, `reask` for the re-ask after an
 *  account refused, outcome reports kept, and Exa's paid search. */
function network(answer: unknown, onDecide?: () => Promise<void>, reask?: unknown) {
  const decisions: Record<string, unknown>[] = [];
  const reasked: Record<string, unknown>[] = [];
  const reports: Record<string, unknown>[] = [];
  const provider: { url: string; body?: string }[] = [];
  let exa = 0;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    if (url.startsWith(EXA)) {
      provider.push({ url, ...(body !== undefined ? { body } : {}) });
      exa += 1;
      return exa === 1
        ? new Response('{}', {
            status: 402,
            headers: {
              'PAYMENT-REQUIRED': buildPaymentRequired({ amount: '7000', payTo: PAYEE }).header,
            },
          })
        : new Response(JSON.stringify({ results: [{ title: 'BTC', url: 'https://x.test' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    }
    const parsed = JSON.parse(body ?? 'null') as Record<string, unknown>;
    if (url.endsWith(ROUTER_PATH) && typeof parsed.status === 'string') {
      reports.push(parsed);
      return new Response(null, { status: 204 });
    }
    if (reask !== undefined && 'refused' in parsed) {
      reasked.push(parsed);
      return new Response(JSON.stringify(reask), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    decisions.push(parsed);
    await onDecide?.();
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, decisions, reasked, reports, provider };
}

function depsFor(fetchImpl: typeof fetch) {
  const auth = testAuthorizer();
  return {
    hook: { dataDir: dir, baseUrl: BASE, fetchImpl, warn: () => undefined },
    request: {
      ctx: testCtx(dir, { baseUrl: BASE }),
      cwd: dir,
      authorizer: auth,
      fetchImpl,
      payDeps: {
        readBalance: async () => 100_000_000n,
        fetchImpl,
        provider: testWalletProvider(),
        authorizer: auth,
        destination: { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] },
      },
    },
  };
}

const answered = async (over: Record<string, unknown> = {}) => ({
  ...ANSWER,
  settingsHash: await hashNow(dir),
  decision: { ...ANSWER.decision, ...over },
});

describe('the swap', () => {
  it("runs the router's bound input in the native call's place, marked as a swap", async () => {
    const net = network(await answered());
    const { hook, request } = depsFor(net.fetchImpl);
    const ran = await runSwap(event(), hook, request);
    expect(ran.envelope).toMatchObject({
      status: 'fulfilled',
      via: 'swap',
      inPlaceOf: 'WebSearch',
    });
    expect(ran.summary).toContain(
      'Tenjin ran Exa search ($0.007) in place of this web search, because the user turned on "Run Tenjin\'s picks automatically".',
    );
    // One routing decision, the hook's own body, with the settings beside it.
    expect(net.decisions).toHaveLength(1);
    expect(net.decisions[0]).toMatchObject({ accepts: expect.arrayContaining(['settings']) });
    // The bound input, unchanged, with the spec's pins.
    expect(JSON.parse(net.provider.at(-1)!.body!)).toMatchObject({ query: QUERY });
    await vi.waitFor(() => expect(net.reports).toHaveLength(1));
    expect(net.reports[0]).toMatchObject({ id: ID, status: 'fulfilled', via: 'swap' });
    const ledger = (await readFile(paidLedgerPath(dir), 'utf8')).trim().split('\n');
    expect(JSON.parse(ledger.at(-1)!)).toMatchObject({ via: 'swap', label: 'Exa search' });
  });

  it('hands back with nothing asked while automatic use is off', async () => {
    await save({});
    const net = network(await answered());
    const { hook, request } = depsFor(net.fetchImpl);
    const ran = await runSwap(event(), hook, request);
    expect(ran.envelope).toMatchObject({ status: 'native', swap: 'handback' });
    expect(net.decisions).toEqual([]);
  });

  it('hands back an answer without bound, and the pre-call hook offers from it without asking again', async () => {
    const plain: Record<string, unknown> = { ...ANSWER.decision };
    delete plain.bound;
    const net = network({ ...ANSWER, settingsHash: await hashNow(dir), decision: plain });
    const { hook, request } = depsFor(net.fetchImpl);
    const ran = await runSwap(event(), hook, request);
    expect(ran.envelope).toMatchObject({ swap: 'handback', reason: 'no input to run in place' });
    const offered = await runNativeHook(event(), hook);
    expect(offered).toMatchObject({ action: 'execute', id: ID });
    expect(net.decisions).toHaveLength(1);
    expect(net.provider).toEqual([]);
  });

  it('hands back a price over the per-call limit, so its offer asks as usual', async () => {
    await save({ nativeReplacement: 'when-routed' }, '1000');
    const net = network(await answered());
    const { hook, request } = depsFor(net.fetchImpl);
    const ran = await runSwap(event(), hook, request);
    expect(ran.envelope).toMatchObject({ swap: 'handback' });
    expect(net.provider).toEqual([]);
  });

  it('runs nothing when the settings changed while the router decided', async () => {
    const net = network(await answered(), () =>
      save({
        nativeReplacement: 'when-routed',
        policy: { version: 1, block: [{ kind: 'provider', id: 'exa' }] },
      }),
    );
    const { hook, request } = depsFor(net.fetchImpl);
    const ran = await runSwap(event(), hook, request);
    expect(ran.envelope).toMatchObject({ swap: 'handback' });
    expect(String(ran.envelope.reason)).toContain('settings changed');
    expect(net.provider).toEqual([]);
  });

  it('runs a call once: a second swap of the same search hands back', async () => {
    const net = network(await answered());
    const { hook, request } = depsFor(net.fetchImpl);
    await runSwap(event(), hook, request);
    const again = await runSwap(event(), hook, request);
    expect(again.envelope).toMatchObject({ swap: 'handback', reason: 'already routed once' });
  });

  it('never runs for a subagent or a host other than Claude Code', async () => {
    const net = network(await answered());
    const { hook, request } = depsFor(net.fetchImpl);
    const sub = await runSwap({ ...event(), agent_id: 'agent-1' }, hook, request);
    expect(sub.envelope).toMatchObject({ swap: 'handback', reason: 'a subagent call' });
    const codex = await runSwap(event(), { ...hook, harness: 'codex' }, request);
    expect(codex.envelope).toMatchObject({ swap: 'handback' });
    expect(net.decisions).toEqual([]);
  });
});

/**
 * A PICK ON THE USER'S CONNECTED ACCOUNT, RUN IN PLACE (plan 37): a checked
 * map with `bound` runs on the account through the ordinary executor, its
 * plan paying, with the receipt naming the account; an account that refuses
 * before anything ran stops this one call with the reason and Tenjin's own
 * tool, never handing back silently and never running Tenjin's tool in place.
 */
describe('the swap on a connected account', () => {
  const BOUND = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('./fixtures/wire-hook-execute-account-bound.json', import.meta.url)),
      'utf8',
    ),
  ) as { decision: Record<string, unknown> & { id: string } };
  const URL_ = 'https://docs.example.com/pricing';

  const fetchEvent = () => ({
    ...event(),
    tool_name: 'WebFetch',
    tool_input: { url: URL_, prompt: 'what does it cost' },
    tool_use_id: 'toolu_swap_fetch',
  });

  async function firecrawl(state: 'ok' | 'expired' = 'ok') {
    const { fakeKeychain } = await import('./accounts/test-support');
    const { clearVaultKeyCache, writeVault } = await import('./accounts/vault');
    const keychain = fakeKeychain();
    clearVaultKeyCache();
    await writeFile(
      transcript,
      JSON.stringify({ type: 'user', sessionId: 'sess-1', message: { content: `read ${URL_}` } }),
    );
    await save({
      nativeReplacement: 'when-routed',
      policy: {
        version: 1,
        prefer: [{ scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'firecrawl' }] }],
      },
      sources: [
        {
          id: 'firecrawl',
          label: 'Firecrawl',
          mcpUrl: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
          signIn: 'key',
          keyScheme: 'Bearer',
          mapped: true,
        },
      ],
    });
    await writeVault(
      'firecrawl',
      'Firecrawl',
      {
        kind: 'key',
        mcpUrl: 'https://mcp.firecrawl.dev/v2/mcp-oauth',
        connectedAt: new Date().toISOString(),
        state,
        missingTools: [],
      },
      { apiKey: 'fc-test-key', keyScheme: 'Bearer' },
      { dataDir: dir, platform: 'darwin', exec: keychain.exec },
    );
    const called: { tool: string; args: Record<string, unknown> }[] = [];
    const accounts = {
      exec: keychain.exec,
      platform: 'darwin' as const,
      openSession: async () => ({
        listTools: async () => [],
        callTool: async (tool: string, args: Record<string, unknown>) => {
          called.push({ tool, args });
          return { structuredContent: { markdown: '# Pricing\n$10 a month', title: 'Pricing' } };
        },
        close: async () => undefined,
      }),
    };
    return { accounts, called };
  }

  it('runs a checked map on the account in the native call’s place, its plan paying', async () => {
    const { accounts, called } = await firecrawl();
    const net = network({ ...BOUND, settingsHash: await hashNow(dir) });
    const { hook, request } = depsFor(net.fetchImpl);
    const ran = await runSwap(fetchEvent(), hook, { ...request, accounts });
    expect(ran.envelope).toMatchObject({
      status: 'fulfilled',
      via: 'swap',
      inPlaceOf: 'WebFetch',
      cost: ['billed to your Firecrawl account, not the Tenjin balance'],
    });
    expect(ran.summary).toContain('Firecrawl · your account · instead of WebFetch');
    expect(called).toEqual([
      expect.objectContaining({
        tool: 'firecrawl_scrape',
        args: expect.objectContaining({ url: URL_ }),
      }),
    ]);
    // Nothing was paid from the balance, and no provider URL was asked.
    expect(net.provider).toEqual([]);
    const ledger = (await readFile(paidLedgerPath(dir), 'utf8')).trim().split('\n');
    expect(JSON.parse(ledger.at(-1)!)).toMatchObject({
      via: 'swap',
      source: 'firecrawl',
      settlement: 'account',
      amountAtomic: '0',
    });
  });

  it('stops the call once with the refusal and the re-ask’s offer when the account refuses', async () => {
    const { accounts, called } = await firecrawl('expired');
    const fixture = (name: string) =>
      JSON.parse(
        readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'),
      ) as Record<string, unknown>;
    const net = network({ ...BOUND, settingsHash: await hashNow(dir) }, undefined, {
      ...fixture('wire-refused-offer.json'),
      settingsHash: await hashNow(dir),
    });
    const { hook, request } = depsFor(net.fetchImpl);
    const ran = await runSwap(fetchEvent(), hook, { ...request, accounts });
    expect(ran.envelope).toMatchObject({
      via: 'swap',
      refused: { account: 'Firecrawl', reason: 'signin_expired' },
      offer: { label: 'Firecrawl page read', price: '$0.015' },
    });
    // THE RE-ASK: the server's fixture is this very refusal (the bound
    // Firecrawl read under these settings), field for field, with the
    // accepts this build sends.
    const sent = fixture('wire-refused-request.json');
    expect(net.reasked).toEqual([{ ...sent, accepts: acceptsFor(false, true) }]);
    expect(ran.envelope).not.toHaveProperty('switched');
    expect(ran.summary).toContain('Your Firecrawl account refused Firecrawl scrape');
    expect(called).toEqual([]);
    expect(net.provider).toEqual([]);
    // The retry runs natively: this call is routed once.
    const again = await runSwap(fetchEvent(), hook, { ...request, accounts });
    expect(again.envelope).toMatchObject({ swap: 'handback', reason: 'already routed once' });
  });
});
