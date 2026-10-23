import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../context';
import { buildPaymentRequired, testWalletProvider } from '../../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../../lib/wallet';
import { MAX_CALL_WAIT_MS } from '../jobs';
import { readPaidRecords, type MediaTransport } from '../paid';
import type { AccountOfferSpec, OfferSpec } from '../decision';
import { storeAccountOffer } from '../specs';
import { runRequestTool, type RequestToolDeps } from '../tool';
import { AccountRefused, AccountLimited, type AccountCallResult } from './client';
import { fakeAccountServer, fakeKeychain } from './test-support';
import { clearVaultKeyCache, writeVault } from './vault';

/**
 * A MAPPED JOB, RUN ON THE USER'S OWN ACCOUNT through the request tool, end to
 * end: the kept spec, the user's settings, the claim, the credential in the
 * headers (refreshed and retried once on a 401), the map's follow-up, the
 * result checked, cut and saved, the ledger row and the receipt; and when the
 * account refuses, the stop, the reason and Tenjin's own tool with its price.
 * The account is a scripted MCP session, the keychain a fake, and the only
 * fetch is the router's outcome report and, where a test refreshes, the
 * scripted sign-in server.
 */

const fixtures = new URL('../fixtures/', import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8')) as T;

const APIFY = read<{
  decision: { id: string; specs: AccountOfferSpec[]; fallback: OfferSpec };
}>('wire-hook-execute-account.json').decision;
const FAL = read<{
  decision: { id: string; spec: Omit<AccountOfferSpec, 'id'>; fallback: OfferSpec };
}>('wire-lookup-spec-account.json').decision;

/** The Apify lead, promising only each place's name and address: the agent
 *  gets those, and the whole answer is saved. */
const LEAD: AccountOfferSpec = {
  ...APIFY.specs[0]!,
  outputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'object', properties: { title: { type: 'string' }, address: {} } },
      },
    },
  },
};
const FAL_LEAD: AccountOfferSpec = { ...FAL.spec, id: FAL.id };

const ROUTER = 'https://router.example.test';
const ISSUER = 'https://auth.example.test';
const NOW = Date.parse('2026-10-23T12:00:00.000Z');

let dir: string;
let keychain: ReturnType<typeof fakeKeychain>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-account-run-'));
  await mkdir(join(dir, '.git'));
  keychain = fakeKeychain();
  clearVaultKeyCache();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: ROUTER },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

interface Saved {
  id: string;
  label: string;
  mcpUrl: string;
  onRefusal?: 'tenjin';
}
const APIFY_ACCOUNT: Saved = { id: 'apify', label: 'Apify', mcpUrl: 'https://mcp.apify.com' };
const FAL_ACCOUNT: Saved = { id: 'fal', label: 'fal', mcpUrl: 'https://mcp.fal.ai/mcp-relay' };

/** The settings file: these accounts saved, and any rules. */
async function settings(accounts: Saved[], policy?: unknown): Promise<void> {
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      maxAutoSpend: '250000',
      sessionBudget: '5000000',
      router: {
        sources: accounts.map((a) => ({ ...a, signIn: 'oauth' })),
        ...(policy !== undefined ? { policy } : {}),
      },
    }),
  );
}

/** A sign-in on this machine, sealed under the fake keychain. */
async function signedIn(
  account: Saved,
  over: { expiresAt?: string; state?: 'ok' | 'expired'; missing?: string[] } = {},
): Promise<void> {
  await writeVault(
    account.id,
    account.label,
    {
      kind: 'oauth',
      mcpUrl: account.mcpUrl,
      connectedAt: new Date(NOW - 60_000).toISOString(),
      expiresAt: over.expiresAt ?? new Date(NOW + 3_600_000).toISOString(),
      state: over.state ?? 'ok',
      ready: [],
      missing: over.missing ?? [],
    },
    {
      tokens: { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer' },
      obtainedAt: NOW - 60_000,
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

type Answer = AccountCallResult | Error;

/** A scripted account: each tool's answers in order (the last repeats). */
function account(script: Record<string, Answer[]>) {
  const opened: Record<string, string>[] = [];
  const called: { tool: string; args: Record<string, unknown> }[] = [];
  const left = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const openSession: NonNullable<RequestToolDeps['accounts']>['openSession'] = async (
    _url,
    headers,
  ) => {
    opened.push(headers);
    return {
      listTools: async () => [],
      callTool: async (tool, args) => {
        called.push({ tool, args });
        const queue = left[tool];
        if (queue === undefined || queue.length === 0) throw new Error(`unscripted tool ${tool}`);
        const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      close: async () => undefined,
    };
  };
  return { openSession, opened, called, tools: () => called.map(({ tool }) => tool) };
}

const structured = (value: Record<string, unknown>): AccountCallResult => ({
  structuredContent: value,
  content: [],
});
const text = (value: unknown): AccountCallResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
});

/** The router (outcome reports only), and the sign-in server when asked. */
function network(signIn?: ReturnType<typeof fakeAccountServer>) {
  const outcomes: Record<string, unknown>[] = [];
  const other: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(ROUTER)) {
      outcomes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }
    other.push(url);
    if (signIn !== undefined) return signIn.fetchImpl(input, init);
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
  return { fetchImpl, outcomes, other };
}

/** The router's free directory too, for a rule that reads identity. */
function withDirectory(fetchImpl: typeof fetch): typeof fetch {
  const directory = read<unknown>('wire-directory-mcp.json');
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { directory?: unknown };
    if (body.directory !== undefined)
      return new Response(JSON.stringify(directory), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    return fetchImpl(input, init);
  }) as typeof fetch;
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

const PUBLIC = { resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }] };
const noMedia: MediaTransport = async (target) => {
  throw new Error(`no network in tests: ${target.url.toString()}`);
};

function deps(
  fetchImpl: typeof fetch,
  session: ReturnType<typeof account>,
  over: Partial<RequestToolDeps> = {},
): RequestToolDeps {
  const auth = authorizer();
  return {
    ctx: ctx(),
    cwd: dir,
    authorizer: auth,
    fetchImpl,
    mediaTransport: noMedia,
    sleep: async () => undefined,
    payDeps: {
      readBalance: async () => 100_000_000n,
      fetchImpl,
      provider: testWalletProvider(),
      authorizer: auth,
      destination: PUBLIC,
    },
    accounts: { exec: keychain.exec, platform: 'darwin', openSession: session.openSession },
    ...over,
  };
}

const PLACES = {
  items: [
    { title: 'Cafe One', address: '1 Main St', phone: '555-0101', website: 'https://one.test' },
    { title: 'Cafe Two', address: '2 Main St', phone: '555-0102', website: 'https://two.test' },
  ],
};

/** The Apify map's three calls: the run, its status (running, then done),
 *  and its places. */
function apifyScript(over: Record<string, Answer[]> = {}) {
  return account({
    'call-actor': [structured({ runId: 'run-1', datasetId: 'ds-1', status: 'RUNNING' })],
    'get-actor-run': [structured({ status: 'RUNNING' }), structured({ status: 'SUCCEEDED' })],
    'get-dataset-items': [structured(PLACES)],
    ...over,
  });
}

async function apifyConnected(over: Partial<Saved> = {}, policy?: unknown): Promise<void> {
  await settings([{ ...APIFY_ACCOUNT, ...over }], policy);
  await signedIn(APIFY_ACCOUNT);
  await storeAccountOffer(dir, LEAD, APIFY.fallback);
}

const INPUT = { query: 'coffee shops', limit: 2 };

describe('a mapped job on the user’s own account', () => {
  it('runs the map with the credential in its headers, and hands back the cut result with a receipt', async () => {
    await apifyConnected();
    const session = apifyScript();
    const { fetchImpl, outcomes, other } = network();
    const result = await runRequestTool(
      { id: LEAD.id, input: INPUT },
      deps(fetchImpl, session, { now: () => NOW }),
    );
    expect(result.isError).toBe(false);
    expect(result.summary).toBe('Apify · your account · 2 places');
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      cost: ['billed to your Apify account, not the Tenjin balance'],
      receipt: 'Apify · your account · 2 places',
    });
    // THE TEMPLATE: the absent location dropped, the limit kept as a number,
    // the pins sent as written, and the follow-up filled from the run.
    expect(session.called).toStrictEqual([
      {
        tool: 'call-actor',
        args: {
          actor: 'compass/crawler-google-places',
          input: {
            searchStringsArray: ['coffee shops'],
            maxCrawledPlacesPerSearch: 2,
            language: 'en',
          },
          callOptions: { maxTotalChargeUsd: 0.5 },
        },
      },
      { tool: 'get-actor-run', args: { runId: 'run-1' } },
      { tool: 'get-actor-run', args: { runId: 'run-1' } },
      {
        tool: 'get-dataset-items',
        args: {
          datasetId: 'ds-1',
          limit: 2,
          fields: 'title,address,phone,website,totalScore',
          clean: true,
        },
      },
    ]);
    // THE CREDENTIAL IN THE HEADERS, and nothing else.
    expect(session.opened).toEqual([{ authorization: 'Bearer access-1' }]);
    expect(other).toEqual([]);
    // THE CUT: the promised fields to the agent, the whole answer on disk.
    expect(JSON.parse(String(result.envelope.result))).toEqual({
      items: [
        { title: 'Cafe One', address: '1 Main St' },
        { title: 'Cafe Two', address: '2 Main St' },
      ],
    });
    const full = JSON.parse(await readFile(String(result.envelope.fullResultPath), 'utf8'));
    expect(full).toEqual(PLACES);
    // THE LEDGER: the account's row, nothing from the balance.
    const [row, ...more] = await readPaidRecords(dir);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      source: 'apify',
      settlement: 'account',
      amountAtomic: '0',
      label: 'Apify Google Maps',
      identity: { source: 'apify' },
    });
    expect(outcomes).toEqual([expect.objectContaining({ id: LEAD.id, status: 'fulfilled' })]);
    expect(JSON.stringify(result)).not.toMatch(/x402|USDC|wallet/i);
  });

  it('runs once per offer: the same id is never sent to the account again', async () => {
    await apifyConnected();
    const session = apifyScript();
    const { fetchImpl } = network();
    await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    const again = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(again.envelope).toMatchObject({ status: 'needs_input' });
    expect(again.summary).toContain('already ran on your Apify account');
    expect(session.tools().filter((t) => t === 'call-actor')).toHaveLength(1);
  });

  it('polls a processing job and never sends the call that bills again', async () => {
    await settings([FAL_ACCOUNT]);
    await signedIn(FAL_ACCOUNT);
    await storeAccountOffer(dir, FAL_LEAD, FAL.fallback);
    const session = account({
      run_model: [text({ status: 'processing', request_id: 'req-1' })],
      check_job: [text({ status: 'IN_PROGRESS' }), text({ status: 'COMPLETED' })],
      get_job_result: [text({ images: [{ url: 'https://fal.media/files/a.jpg' }] })],
    });
    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const mediaTransport: MediaTransport = async () => ({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      body: (async function* () {
        yield image;
      })(),
      discard: () => undefined,
    });
    const { fetchImpl } = network();
    const result = await runRequestTool(
      { id: FAL_LEAD.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl, session, { mediaTransport }),
    );
    expect(session.tools()).toEqual(['run_model', 'check_job', 'check_job', 'get_job_result']);
    expect(session.called[0]!.args).toEqual({
      endpoint_id: 'fal-ai/flux-pro/v1.1-ultra',
      input: { prompt: 'a lighthouse at dusk', num_images: 1, output_format: 'jpeg' },
    });
    expect(session.called[1]!.args).toEqual({
      endpoint_id: 'fal-ai/flux-pro/v1.1-ultra',
      request_id: 'req-1',
    });
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    const saved = result.envelope.savedFiles as string[];
    expect(saved).toHaveLength(1);
    expect(new Uint8Array(await readFile(saved[0]!))).toEqual(image);
    // Named, never suggested: it says Tenjin hasn't checked it.
    expect(result.summary).toBe(
      "fal · your account · 1 file saved\nTenjin hasn't checked this service yet. Results may vary, and your fal account pays.",
    );
  });

  it('hands back a job it cannot wait out, and request({job}) finishes it without sending it again', async () => {
    await settings([FAL_ACCOUNT]);
    await signedIn(FAL_ACCOUNT);
    await storeAccountOffer(dir, FAL_LEAD, FAL.fallback);
    const session = account({
      run_model: [text({ status: 'processing', request_id: 'req-1' })],
      check_job: [text({ status: 'IN_QUEUE' }), text({ status: 'COMPLETED' })],
      get_job_result: [text({ images: [] })],
    });
    const { fetchImpl } = network();
    // This call's own wait is already over after its first status call.
    const first = await runRequestTool(
      { id: FAL_LEAD.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl, session, { startedAt: Date.now() - MAX_CALL_WAIT_MS }),
    );
    expect(first.envelope).toMatchObject({ status: 'running', job: FAL_LEAD.id });
    expect(session.tools()).toEqual(['run_model', 'check_job']);
    // The same offer again sends nothing.
    const again = await runRequestTool(
      { id: FAL_LEAD.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl, session),
    );
    expect(again.summary).toContain('still running on your fal account');
    expect(session.tools()).toEqual(['run_model', 'check_job']);
    // Picked up: only the follow-up runs.
    const done = await runRequestTool({ job: FAL_LEAD.id }, deps(fetchImpl, session));
    expect(done.envelope).toMatchObject({ status: 'fulfilled' });
    expect(session.tools()).toEqual(['run_model', 'check_job', 'check_job', 'get_job_result']);
    // And it is gone once delivered.
    const gone = await runRequestTool({ job: FAL_LEAD.id }, deps(fetchImpl, session));
    expect(gone.summary).toContain('No job is kept on this machine under that id');
  });
});

describe('when the account refuses', () => {
  it('stops an expired sign-in with nothing sent, and offers Tenjin’s tool with its price', async () => {
    // A sign-in whose refresh was refused: its token still reads fresh.
    await settings([APIFY_ACCOUNT]);
    await signedIn(APIFY_ACCOUNT, { state: 'expired' });
    await storeAccountOffer(dir, LEAD, APIFY.fallback);
    const session = apifyScript();
    const { fetchImpl, outcomes, other } = network();
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.isError).toBe(false);
    expect(result.summary).toBe(
      "Your Apify sign-in has expired. Nothing was sent to your Apify account, and nothing was charged. Reconnect with `tenjin connect apify`. Tenjin's own tool for this job (Google Maps Places) costs $0.02 from the Tenjin balance.",
    );
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      cost: ['nothing charged'],
      refused: { account: 'Apify', reason: 'signin_expired', reconnect: 'tenjin connect apify' },
      fallback: { id: APIFY.fallback.id, label: 'Google Maps Places', price: '$0.02' },
    });
    expect(String(result.envelope.nextStep)).toContain(
      `request({id: "${APIFY.fallback.id}", input: {...}})`,
    );
    // NOTHING WENT TO THE ACCOUNT: no session, no sign-in server, and the
    // only request is the router's unpaid outcome.
    expect(session.opened).toEqual([]);
    expect(other).toEqual([]);
    expect(outcomes).toEqual([
      expect.objectContaining({ id: LEAD.id, status: 'unpaid', reason: 'provider' }),
    ]);
    // The id stays free: once reconnected, the same offer runs.
    await signedIn(APIFY_ACCOUNT);
    clearVaultKeyCache();
    const after = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(after.envelope).toMatchObject({ status: 'fulfilled' });
  });

  it('refreshes once on a 401 and sends the new token, and stops on a second', async () => {
    await apifyConnected();
    const signIn = fakeAccountServer({ mcpUrl: APIFY_ACCOUNT.mcpUrl, issuer: ISSUER });
    const session = apifyScript({
      'call-actor': [
        new AccountRefused(401),
        structured({ runId: 'run-1', datasetId: 'ds-1', status: 'SUCCEEDED' }),
      ],
      'get-actor-run': [structured({ status: 'SUCCEEDED' })],
    });
    const { fetchImpl } = network(signIn);
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(session.opened).toEqual([
      { authorization: 'Bearer access-1' },
      { authorization: 'Bearer access-2' },
    ]);
    expect(signIn.refreshes).toEqual(['refresh-1']);

    // A second 401, after the refresh: refused, and the id stays free.
    await storeAccountOffer(dir, { ...LEAD, id: `${LEAD.id.slice(0, -2)}99` }, APIFY.fallback);
    const refusing = apifyScript({ 'call-actor': [new AccountRefused(401)] });
    const refused = await runRequestTool(
      { id: `${LEAD.id.slice(0, -2)}99`, input: INPUT },
      deps(fetchImpl, refusing),
    );
    expect(refused.envelope).toMatchObject({ refused: { reason: 'signin_expired' } });
    expect(refusing.tools()).toEqual(['call-actor', 'call-actor']);
  });

  it('reads a 402 on the billing call as the plan running out', async () => {
    await apifyConnected();
    const session = apifyScript({ 'call-actor': [new AccountLimited(402)] });
    const { fetchImpl } = network();
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.summary).toMatch(
      /^Your Apify account's plan or credit has run out\. Nothing was charged to your Tenjin balance\./,
    );
    expect(result.envelope).toMatchObject({ refused: { reason: 'credit' } });
    expect(session.tools()).toEqual(['call-actor']);
  });

  it("passes the account's own error back without guessing, and offers Tenjin's tool", async () => {
    await apifyConnected();
    const session = apifyScript({
      'call-actor': [{ isError: true, content: [{ type: 'text', text: 'Actor not found' }] }],
    });
    const { fetchImpl } = network();
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.envelope).toMatchObject({
      refused: { reason: 'declined' },
      providerError: 'Actor not found',
      fallback: { id: APIFY.fallback.id },
    });
  });

  it('with the opt-in, runs Tenjin’s tool in its place and says so on the receipt', async () => {
    // A fallback that takes the same inputs, so it can run as it stands.
    const fallback: OfferSpec = {
      ...APIFY.fallback,
      request: { ...APIFY.fallback.request, fields: { query: 'body', limit: 'body' } },
      input: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer' } },
        required: ['query'],
      },
      output: 'json',
    };
    await settings([{ ...APIFY_ACCOUNT, onRefusal: 'tenjin' }]);
    await signedIn(APIFY_ACCOUNT, { state: 'expired' });
    await storeAccountOffer(dir, LEAD, fallback);
    const session = apifyScript();
    const paid: string[] = [];
    const { fetchImpl: router } = network();
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url !== fallback.request.url) return router(input, init);
      paid.push(new Headers(init?.headers).get('payment-signature') !== null ? 'paid' : 'probe');
      return paid.length === 1
        ? new Response('{}', {
            status: 402,
            headers: {
              'PAYMENT-REQUIRED': buildPaymentRequired({ amount: '20000', payTo: fallback.payTo })
                .header,
            },
          })
        : new Response(JSON.stringify({ places: [{ name: 'Cafe One' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    }) as typeof fetch;
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(session.opened).toEqual([]);
    expect(paid).toEqual(['probe', 'paid']);
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      cost: ['provider price 0.02 USD'],
      switched: { from: 'Apify', to: 'Google Maps Places', reason: 'signin_expired' },
    });
    expect(result.summary).toMatch(
      /^Your Apify sign-in has expired\. Tenjin ran its own tool for this job instead, as you set for Apify\.\n/,
    );
  });

  it('with the opt-in and other inputs, hands the agent Tenjin’s spec to run now', async () => {
    await apifyConnected({ onRefusal: 'tenjin' });
    const session = apifyScript({ 'call-actor': [new AccountLimited(429)] });
    const { fetchImpl } = network();
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.envelope).toMatchObject({ switching: true, refused: { reason: 'rate_limited' } });
    expect(result.summary).toContain('textQuery');
    expect(String(result.envelope.nextStep)).toContain('without asking');
  });

  it("never offers Tenjin's tool when the user's settings rule it out", async () => {
    // "Only use my accounts."
    await settings([APIFY_ACCOUNT], { version: 1, block: [{ kind: 'source', id: 'tenjin' }] });
    await signedIn(APIFY_ACCOUNT, { state: 'expired' });
    await storeAccountOffer(dir, LEAD, APIFY.fallback);
    const { fetchImpl } = network();
    const result = await runRequestTool(
      { id: LEAD.id, input: INPUT },
      deps(withDirectory(fetchImpl), apifyScript()),
    );
    expect(result.envelope).toMatchObject({ refused: { reason: 'signin_expired' } });
    expect(result.envelope).not.toHaveProperty('fallback');
    expect(result.summary).not.toContain("Tenjin's own tool");
  });

  it('refuses a job this account was found to lack, with nothing sent', async () => {
    await settings([APIFY_ACCOUNT]);
    await signedIn(APIFY_ACCOUNT, { missing: [LEAD.identity.service] });
    await storeAccountOffer(dir, LEAD, APIFY.fallback);
    const session = apifyScript();
    const { fetchImpl } = network();
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.envelope).toMatchObject({ refused: { reason: 'missing' } });
    expect(session.opened).toEqual([]);
  });
});

describe("the user's settings, before the account", () => {
  it('stops a blocked account before anything is claimed or sent', async () => {
    await apifyConnected({}, { version: 1, block: [{ kind: 'source', id: 'apify' }] });
    const session = apifyScript();
    const { fetchImpl, other } = network();
    const result = await runRequestTool(
      { id: LEAD.id, input: INPUT },
      deps(withDirectory(fetchImpl), session),
    );
    expect(result.envelope).toMatchObject({ reasonCode: 'policy_refused' });
    expect(result.summary).toContain('your settings block Apify');
    expect(session.opened).toEqual([]);
    expect(other).toEqual([]);
  });

  it('runs nothing on an account with no sign-in on this machine', async () => {
    await settings([APIFY_ACCOUNT]);
    await storeAccountOffer(dir, LEAD, APIFY.fallback);
    const session = apifyScript();
    const { fetchImpl, outcomes } = network();
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.envelope).toMatchObject({ reasonCode: 'policy_refused' });
    expect(result.summary).toContain("Apify isn't connected on this machine");
    expect(session.opened).toEqual([]);
    expect(outcomes).toEqual([]);
  });
});
