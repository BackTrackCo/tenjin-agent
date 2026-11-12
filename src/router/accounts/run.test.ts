import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../../context';
import { buildPaymentRequired, testWalletProvider } from '../../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../../lib/wallet';
import { sourceVaultPath } from '../../lib/paths';
import { MAX_CALL_WAIT_MS } from '../jobs';
import { readPaidRecords, type MediaTransport } from '../paid';
import { acceptsFor, type AccountOfferSpec, type OfferSpec } from '../decision';
import { personalSettingsAt } from '../settings';
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
 * account refuses, the stop, the reason, and the re-ask's offer with its
 * price. The account is a scripted MCP session, the keychain a fake, and the
 * only fetches are the router's (outcome reports, and the re-ask, answered
 * from the shared fixtures) and, where a test refreshes, the scripted sign-in
 * server.
 */

const fixtures = new URL('../fixtures/', import.meta.url);
const read = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8')) as T;

const APIFY = read<{
  decision: { id: string; specs: AccountOfferSpec[] };
}>('wire-hook-execute-account.json').decision;
const FAL = read<{
  decision: { id: string; spec: Omit<AccountOfferSpec, 'id'> };
}>('wire-lookup-spec-account-by-id.json').decision;

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
// The clock the sign-ins are dated from: a fixed day would expire them an
// hour after it, and every later run would refresh instead of calling.
const NOW = Date.now();

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
        // Each listed as connectable by the identities read when connected.
        sources: accounts.map((a) => ({ ...a, signIn: 'oauth', mapped: true })),
        ...(policy !== undefined ? { policy } : {}),
      },
    }),
  );
}

/** The hash of the settings saved now: what an answer decided under them echoes. */
async function hashNow(): Promise<string> {
  const now = await personalSettingsAt(dir);
  if (now.wire.status !== 'ok') throw new Error('settings unreadable');
  return now.wire.settings.hash;
}

/** An offer kept as the hook keeps one, under the settings saved now. */
async function offered(lead: AccountOfferSpec, opts: { named?: true } = {}): Promise<void> {
  await storeAccountOffer(dir, lead, await hashNow(), opts);
}

/** The re-ask's answers, from the server's real route. */
const REASK_OFFER = read<{ decision: { id: string; spec: Omit<OfferSpec, 'id'> } }>(
  'wire-refused-offer.json',
);
const REASK_NATIVE = read<Record<string, unknown>>('wire-refused-native.json');
/** The offer the re-ask makes in the account's place. */
const REPLACEMENT: OfferSpec = { ...REASK_OFFER.decision.spec, id: REASK_OFFER.decision.id };

/** Tenjin's offer for the job, taking the Apify map's own inputs, so an
 *  automatic switch can run it as it stands. */
const FITTING: OfferSpec = {
  ...REPLACEMENT,
  request: { ...REPLACEMENT.request, fields: { query: 'body', limit: 'body' } },
  input: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'integer' } },
    required: ['query'],
  },
  pinned: {},
  output: 'json',
};

/** The re-ask's answer naming `offer`, under the settings saved now. */
async function reaskOffering(offer: OfferSpec = REPLACEMENT): Promise<Record<string, unknown>> {
  const { id, ...spec } = offer;
  return {
    ...REASK_OFFER,
    decision: { ...REASK_OFFER.decision, id, spec },
    settingsHash: await hashNow(),
  };
}

/** A sign-in on this machine, sealed under the fake keychain. */
async function signedIn(
  account: Saved,
  over: { expiresAt?: string; state?: 'ok' | 'expired'; missingTools?: string[] } = {},
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
      missingTools: over.missingTools ?? [],
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

/**
 * The router (outcome reports, the re-ask after a refusal, answered with
 * `reask`: the ordinary native unless a test says otherwise, and a query,
 * answered with `routed`), and the sign-in server when asked.
 */
function network(
  signIn?: ReturnType<typeof fakeAccountServer>,
  reask: Record<string, unknown> = REASK_NATIVE,
  routed?: Record<string, unknown>,
) {
  const outcomes: Record<string, unknown>[] = [];
  const reasked: Record<string, unknown>[] = [];
  const other: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(ROUTER)) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url === `${ROUTER}/api/x402-router/route` && ('refused' in body || routed)) {
        if ('refused' in body) reasked.push(body);
        return new Response(JSON.stringify('refused' in body ? reask : routed), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      outcomes.push(body);
      return new Response(null, { status: 204 });
    }
    other.push(url);
    if (signIn !== undefined) return signIn.fetchImpl(input, init);
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
  return { fetchImpl, outcomes, reasked, other };
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
    'call-actor': [
      structured({
        runId: 'run-1',
        storages: { datasets: { default: { id: 'ds-1' } } },
        status: 'RUNNING',
      }),
    ],
    'get-actor-run': [structured({ status: 'RUNNING' }), structured({ status: 'SUCCEEDED' })],
    'get-dataset-items': [structured(PLACES)],
    ...over,
  });
}

async function apifyConnected(over: Partial<Saved> = {}, policy?: unknown): Promise<void> {
  await settings([{ ...APIFY_ACCOUNT, ...over }], policy);
  await signedIn(APIFY_ACCOUNT);
  await offered(LEAD);
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
    expect(again.summary).toContain('already sent to your Apify account');
    expect(session.tools().filter((t) => t === 'call-actor')).toHaveLength(1);
  });

  it('polls a processing job and never sends the call that bills again', async () => {
    await settings([FAL_ACCOUNT]);
    await signedIn(FAL_ACCOUNT);
    await offered(FAL_LEAD, { named: true });
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

  it('hands back a job it cannot wait out, on the ledger at once, and request({job}) finishes it without sending it again', async () => {
    await settings([FAL_ACCOUNT]);
    await signedIn(FAL_ACCOUNT);
    await offered(FAL_LEAD, { named: true });
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
    // Review: nothing shows yet that it billed, so the receipt never says so.
    expect(first.envelope.cost).toEqual([
      'your fal plan may have charged for this, not the Tenjin balance',
    ]);
    expect(session.tools()).toEqual(['run_model', 'check_job']);
    // Review: an accepted job may already be billing the account, so it is
    // on the ledger while it runs, and its finish is that same row.
    // Its charge is unknown until it delivers: usage and payments say it may
    // have charged, never that it billed.
    expect(await readPaidRecords(dir)).toMatchObject([
      { source: 'fal', settlement: 'account', charge: 'unknown' },
    ]);
    // The same offer again sends nothing.
    const again = await runRequestTool(
      { id: FAL_LEAD.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl, session),
    );
    expect(again.summary).toContain('its job is kept on this machine');
    expect(session.tools()).toEqual(['run_model', 'check_job']);
    // Picked up: only the follow-up runs.
    const done = await runRequestTool({ job: FAL_LEAD.id }, deps(fetchImpl, session));
    expect(done.envelope).toMatchObject({ status: 'fulfilled' });
    expect(session.tools()).toEqual(['run_model', 'check_job', 'check_job', 'get_job_result']);
    // Delivered: the same row, now a plain charge to the account.
    const rows = await readPaidRecords(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'fal', settlement: 'account' });
    expect(rows[0]).not.toHaveProperty('charge');
    // And it is gone once delivered.
    const gone = await runRequestTool({ job: FAL_LEAD.id }, deps(fetchImpl, session));
    expect(gone.summary).toContain('No job is kept on this machine under that id');
  });
});

describe('a long job on the account', () => {
  const falJob = (polls: AccountCallResult[]) =>
    account({
      run_model: [text({ status: 'processing', request_id: 'req-1' })],
      check_job: polls,
      get_job_result: [text({ images: [] })],
    });

  async function falOffered(): Promise<void> {
    await settings([FAL_ACCOUNT]);
    await signedIn(FAL_ACCOUNT);
    await offered(FAL_LEAD, { named: true });
  }

  it('keeps the job and its ledger row once the billing call answers, so a process that exits mid-poll loses nothing', async () => {
    // A1igator review: the job was kept only after polling ended, so a
    // process that exited mid-poll left a paid result nobody could reach.
    await falOffered();
    const session = falJob([text({ status: 'COMPLETED' })]);
    const { fetchImpl } = network();
    const exits = runRequestTool(
      { id: FAL_LEAD.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl, session, {
        onPoll: () => {
          throw new Error('the process exited');
        },
      }),
    );
    await expect(exits).rejects.toThrow('the process exited');
    expect(session.tools()).toEqual(['run_model']);
    expect(await readPaidRecords(dir)).toMatchObject([
      { source: 'fal', settlement: 'account', charge: 'unknown' },
    ]);
    // A later process picks it up: only the follow-up runs.
    const done = await runRequestTool({ job: FAL_LEAD.id }, deps(fetchImpl, session));
    expect(done.envelope).toMatchObject({ status: 'fulfilled' });
    expect(session.tools()).toEqual(['run_model', 'check_job', 'get_job_result']);
    expect(await readPaidRecords(dir)).toHaveLength(1);
  });

  it('keeps the job when the account errors on the fetch of its result, and request({job}) fetches it later', async () => {
    // Greptile review: an error fetching a finished job's result ended it
    // failed and deleted it, though the account may already have billed.
    await falOffered();
    const session = account({
      run_model: [text({ status: 'processing', request_id: 'req-1' })],
      check_job: [text({ status: 'COMPLETED' }), text({ status: 'COMPLETED' })],
      get_job_result: [
        { isError: true, content: [{ type: 'text', text: 'Rate limit exceeded' }] },
        text({ images: [] }),
      ],
    });
    const { fetchImpl } = network();
    const first = await runRequestTool(
      { id: FAL_LEAD.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl, session),
    );
    expect(first.envelope).toMatchObject({
      status: 'running',
      job: FAL_LEAD.id,
      providerError: 'Rate limit exceeded',
    });
    expect(first.summary).toBe(
      `Your fal job finished, but its result didn't come back. Your fal account is over its rate limit right now. In a minute, call request({job: "${FAL_LEAD.id}"}) for its result; nothing is sent to the account again.`,
    );
    const done = await runRequestTool({ job: FAL_LEAD.id }, deps(fetchImpl, session));
    expect(done.envelope).toMatchObject({ status: 'fulfilled' });
    expect(session.tools().filter((t) => t === 'run_model')).toHaveLength(1);
  });

  it("says Tenjin couldn't check on a job when a status call errors, never that it is still running", async () => {
    await falOffered();
    const session = falJob([{ isError: true, content: [{ type: 'text', text: 'Upstream 502' }] }]);
    const { fetchImpl } = network();
    const result = await runRequestTool(
      { id: FAL_LEAD.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl, session),
    );
    expect(result.envelope).toMatchObject({ status: 'running', providerError: 'Upstream 502' });
    expect(result.summary).toBe(
      `Tenjin couldn't check on your fal job. Your fal account answered with an error; it's in providerError. Call request({job: "${FAL_LEAD.id}"}) for its result; nothing is sent to the account again.`,
    );
  });

  it('sends no status call once the account is disconnected mid-job, and keeps the job for a reconnect', async () => {
    // A1igator review: the session this process opened kept polling with the
    // old credential after a disconnect in another terminal.
    await falOffered();
    const session = falJob([text({ status: 'COMPLETED' })]);
    const { fetchImpl } = network();
    const result = await runRequestTool(
      { id: FAL_LEAD.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl, session, {
        // Another terminal disconnects fal while this call starts polling.
        onPoll: () => rm(sourceVaultPath('fal', dir), { force: true }),
      }),
    );
    expect(result.envelope).toMatchObject({ status: 'running', job: FAL_LEAD.id });
    expect(result.summary).toContain("fal isn't connected on this machine");
    expect(session.tools()).toEqual(['run_model']);
  });

  it("hands back a job past its map's own bound as running, never failed", async () => {
    // A1igator review: past maxWaitS the follow-up returned failed and the
    // job was deleted, though it may still finish and is paid for.
    await falOffered();
    const session = falJob([text({ status: 'IN_QUEUE' })]);
    const { fetchImpl } = network();
    let clock = NOW;
    const result = await runRequestTool(
      { id: FAL_LEAD.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl, session, {
        waitsForJobs: true,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      }),
    );
    expect(result.envelope).toMatchObject({ status: 'running', job: FAL_LEAD.id });
    expect(String(result.envelope.nextStep)).toContain(`request({job: "${FAL_LEAD.id}"})`);
    expect(session.tools().filter((tool) => tool === 'run_model')).toHaveLength(1);
    const later = falJob([text({ status: 'COMPLETED' })]);
    const done = await runRequestTool({ job: FAL_LEAD.id }, deps(fetchImpl, later));
    expect(done.envelope).toMatchObject({ status: 'fulfilled' });
    expect(later.tools()).toEqual(['check_job', 'get_job_result']);
  });
});

describe('when the job fails after it started', () => {
  it('says the plan may have charged for it, keeps its row, and never reads as billed', async () => {
    // Review: a job that ended as FAILED read "billed to your Apify account",
    // though nothing shows whether the account charged for it.
    await apifyConnected();
    const session = apifyScript({ 'get-actor-run': [structured({ status: 'FAILED' })] });
    const { fetchImpl } = network();
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(session.tools()).toEqual(['call-actor', 'get-actor-run']);
    expect(result.envelope).toMatchObject({ status: 'failed' });
    // Owner wording (A1igator round 2): it says what may have billed, and
    // nothing about the Tenjin balance, which the re-ask's routing may draw on.
    expect(result.summary).toMatch(/It may have billed your Apify plan\.$/);
    expect(result.envelope.cost).toEqual(['your Apify plan may have charged for this']);
    expect(await readPaidRecords(dir)).toMatchObject([
      { source: 'apify', settlement: 'account', charge: 'unknown' },
    ]);
  });

  it('names the re-ask’s offer for the user to pick, and never runs it in its place', async () => {
    // Opted in, with an offer that fits: the account may already have billed
    // for the job, so nothing runs on its own.
    await apifyConnected({ onRefusal: 'tenjin' });
    const session = apifyScript({ 'get-actor-run': [structured({ status: 'FAILED' })] });
    const { fetchImpl, reasked } = network(undefined, await reaskOffering(FITTING));
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(reasked).toMatchObject([{ refused: LEAD.id }]);
    expect(result.envelope).toMatchObject({
      status: 'failed',
      offer: { id: FITTING.id, label: 'Firecrawl page read', price: '$0.015' },
    });
    expect(result.envelope).not.toHaveProperty('switched');
    expect(result.summary).toContain(
      `Tenjin has Firecrawl page read for $0.015: request({id: "${FITTING.id}", input}) to run it.`,
    );
    expect(String(result.envelope.nextStep)).toContain("don't call it again for this");
  });
});

describe('when the account refuses', () => {
  /** A fetch that pays `offer`'s provider: its 402, then its answer. */
  function paying(offer: OfferSpec, router: typeof fetch) {
    const paid: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input) !== offer.request.url) return router(input, init);
      paid.push(new Headers(init?.headers).get('payment-signature') !== null ? 'paid' : 'probe');
      return paid.length % 2 === 1
        ? new Response('{}', {
            status: 402,
            headers: {
              'PAYMENT-REQUIRED': buildPaymentRequired({
                amount: offer.priceAtomic,
                payTo: offer.payTo,
              }).header,
            },
          })
        : new Response(JSON.stringify({ markdown: '# Cafe One' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
    }) as typeof fetch;
    return { fetchImpl, paid };
  }

  it('stops an expired sign-in with nothing sent, asks Tenjin again, and names its offer with its price', async () => {
    // A sign-in whose refresh was refused: its token still reads fresh.
    await settings([APIFY_ACCOUNT]);
    await signedIn(APIFY_ACCOUNT, { state: 'expired' });
    await offered(LEAD);
    const session = apifyScript();
    const { fetchImpl, outcomes, reasked, other } = network(undefined, await reaskOffering());
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.isError).toBe(false);
    expect(result.summary).toMatch(
      new RegExp(
        `^Your Apify sign-in has expired\\. Nothing was sent to your Apify account\\. Reconnect with \`tenjin connect apify\`\\. Tenjin has Firecrawl page read for \\$0\\.015: request\\(\\{id: "${REPLACEMENT.id}", input\\}\\) to run it\\.\\n`,
      ),
    );
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      // The re-ask went to the paid route: its cost line is any routing
      // answer's, never "nothing charged".
      cost: ['provider price 0 USD'],
      refused: { account: 'Apify', reason: 'signin_expired', reconnect: 'tenjin connect apify' },
      offer: { id: REPLACEMENT.id, label: 'Firecrawl page read', price: '$0.015' },
    });
    expect(String(result.envelope.nextStep)).toContain(
      `request({id: "${REPLACEMENT.id}", input: {...}})`,
    );
    // THE RE-ASK: the refused offer's id and the usual envelope, no query,
    // under the settings saved now.
    const now = await personalSettingsAt(dir);
    expect(reasked).toEqual([
      {
        schemaVersion: 1,
        refused: LEAD.id,
        accepts: acceptsFor(false, true),
        harness: 'claude',
        settings: now.wire.status === 'ok' ? now.wire.settings : undefined,
      },
    ]);
    // NOTHING WENT TO THE ACCOUNT: no session, no sign-in server, and the
    // only outcome is the router's unpaid one.
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

  it('never sends the refused offer once the user ran the offer made in its place', async () => {
    // Greptile G1, adapted: the refusal frees the account offer's id for a
    // retry after the fix, so the replacement's run must close it, or a
    // reconnect and a replay would bill the account for a job already paid.
    await settings([APIFY_ACCOUNT]);
    await signedIn(APIFY_ACCOUNT, { state: 'expired' });
    await offered(LEAD);
    const session = apifyScript();
    const { fetchImpl: router } = network(undefined, await reaskOffering());
    const { fetchImpl, paid } = paying(REPLACEMENT, router);
    const refused = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(refused.envelope).toMatchObject({ offer: { id: REPLACEMENT.id } });
    const picked = await runRequestTool(
      { id: REPLACEMENT.id, input: { url: 'https://cafe.example.test/' } },
      deps(fetchImpl, session),
    );
    expect(picked.envelope).toMatchObject({ status: 'fulfilled' });
    expect(paid).toEqual(['probe', 'paid']);
    await signedIn(APIFY_ACCOUNT);
    clearVaultKeyCache();
    const replay = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(replay.summary).toContain("Tenjin's own tool already ran this job");
    expect(session.opened).toEqual([]);
  });

  it('refreshes once on a 401 and sends the new token, and stops on a second', async () => {
    await apifyConnected();
    const signIn = fakeAccountServer({ mcpUrl: APIFY_ACCOUNT.mcpUrl, issuer: ISSUER });
    const session = apifyScript({
      'call-actor': [
        new AccountRefused(401),
        structured({
          runId: 'run-1',
          storages: { datasets: { default: { id: 'ds-1' } } },
          status: 'SUCCEEDED',
        }),
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
    await offered({ ...LEAD, id: `${LEAD.id.slice(0, -2)}99` });
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
      /^Your Apify account's plan or credit has run out\. Add credit or change the plan at Apify\./,
    );
    expect(result.summary).not.toMatch(/charged/);
    expect(result.envelope).toMatchObject({ refused: { reason: 'credit' } });
    expect(session.tools()).toEqual(['call-actor']);
  });

  it("passes the account's own error back without guessing, and names the re-ask's offer", async () => {
    await apifyConnected();
    const session = apifyScript({
      'call-actor': [{ isError: true, content: [{ type: 'text', text: 'Actor not found' }] }],
    });
    const { fetchImpl } = network(undefined, await reaskOffering());
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.envelope).toMatchObject({
      refused: { reason: 'declined' },
      providerError: 'Actor not found',
      offer: { id: REPLACEMENT.id },
    });
    // Review: an answer reached the account, so its charge is unknown, never
    // "nothing charged", and the call is on the ledger.
    expect(result.envelope.cost).toEqual(['your Apify plan may have charged for this']);
    expect(await readPaidRecords(dir)).toMatchObject([
      { source: 'apify', settlement: 'account', charge: 'unknown' },
    ]);
  });

  it('keeps the offer claimed after an error answer, and never switches on one', async () => {
    // The account's own words read as its plan running out, and the user
    // opted in to Tenjin's tool: an error answer may still have started the
    // job, so the call is not sent again and nothing runs in its place.
    await apifyConnected({ onRefusal: 'tenjin' });
    const session = apifyScript({
      'call-actor': [
        { isError: true, content: [{ type: 'text', text: 'Monthly usage limit exceeded' }] },
      ],
    });
    const { fetchImpl, other } = network(undefined, await reaskOffering(FITTING));
    const first = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(first.envelope).toMatchObject({
      refused: { reason: 'credit' },
      providerError: 'Monthly usage limit exceeded',
      offer: { id: FITTING.id },
    });
    expect(first.envelope).not.toHaveProperty('switched');
    expect(first.envelope).not.toHaveProperty('switching');
    const again = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(again.summary).toContain('already sent to your Apify account');
    expect(session.tools()).toEqual(['call-actor']);
    expect(other).toEqual([]);
  });

  it('with the opt-in, runs the re-ask’s offer in its place and says so on the receipt', async () => {
    await settings([{ ...APIFY_ACCOUNT, onRefusal: 'tenjin' }]);
    await signedIn(APIFY_ACCOUNT, { state: 'expired' });
    await offered(LEAD);
    const session = apifyScript();
    const { fetchImpl: router } = network(undefined, await reaskOffering(FITTING));
    const { fetchImpl, paid } = paying(FITTING, router);
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(session.opened).toEqual([]);
    expect(paid).toEqual(['probe', 'paid']);
    expect(result.envelope).toMatchObject({
      status: 'fulfilled',
      cost: ['provider price 0.015 USD'],
      switched: { from: 'Apify', to: 'Firecrawl page read', reason: 'signin_expired' },
    });
    expect(result.summary).toMatch(
      /^Your Apify sign-in has expired\. Tenjin ran its own tool for this job instead, as you set for Apify\.\n/,
    );
  });

  it('keeps the offer claimed once the re-ask’s offer ran in its place: a replay never reaches the account', async () => {
    // Review: a 429 freed the account offer's id before Tenjin's tool paid
    // under its own, so the same request after the limit cleared ran the
    // account's billing tool for a job already done and paid.
    await settings([{ ...APIFY_ACCOUNT, onRefusal: 'tenjin' }]);
    await signedIn(APIFY_ACCOUNT);
    await offered(LEAD);
    const session = apifyScript({
      'call-actor': [
        new AccountLimited(429),
        structured({
          runId: 'run-1',
          storages: { datasets: { default: { id: 'ds-1' } } },
          status: 'SUCCEEDED',
        }),
      ],
      'get-actor-run': [structured({ status: 'SUCCEEDED' })],
    });
    const { fetchImpl: router } = network(undefined, await reaskOffering(FITTING));
    const { fetchImpl } = paying(FITTING, router);
    const first = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(first.envelope).toMatchObject({
      status: 'fulfilled',
      switched: { reason: 'rate_limited' },
    });
    const again = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(again.envelope).toMatchObject({ status: 'needs_input', cost: ['nothing charged'] });
    expect(again.summary).toContain("Tenjin's own tool already ran this job");
    expect(String(again.envelope.nextStep)).toContain(`request({job: "${FITTING.id}"})`);
    expect(session.tools()).toEqual(['call-actor']);
  });

  it('with the opt-in and other inputs, hands the agent the offer’s spec to run now', async () => {
    await apifyConnected({ onRefusal: 'tenjin' });
    const session = apifyScript({ 'call-actor': [new AccountLimited(429)] });
    const { fetchImpl } = network(undefined, await reaskOffering());
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.envelope).toMatchObject({ switching: true, refused: { reason: 'rate_limited' } });
    expect(result.summary).toContain('Page to scrape.');
    expect(String(result.envelope.nextStep)).toContain('without asking');
  });

  it('names no offer when the re-ask finds nothing, and says only what the account said', async () => {
    await settings([APIFY_ACCOUNT]);
    await signedIn(APIFY_ACCOUNT, { state: 'expired' });
    await offered(LEAD);
    const { fetchImpl, reasked } = network();
    const result = await runRequestTool(
      { id: LEAD.id, input: INPUT },
      deps(fetchImpl, apifyScript()),
    );
    expect(reasked).toHaveLength(1);
    expect(result.envelope).toMatchObject({ refused: { reason: 'signin_expired' } });
    expect(result.envelope).not.toHaveProperty('offer');
    expect(result.summary).toBe(
      'Your Apify sign-in has expired. Nothing was sent to your Apify account. Reconnect with `tenjin connect apify`.',
    );
  });

  it('refuses a job this account was found to lack, with nothing sent', async () => {
    await settings([APIFY_ACCOUNT]);
    await signedIn(APIFY_ACCOUNT, { missingTools: ['get-dataset-items'] });
    await offered(LEAD);
    const session = apifyScript();
    const { fetchImpl } = network();
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.envelope).toMatchObject({ refused: { reason: 'missing' } });
    expect(session.opened).toEqual([]);
  });
});

describe('a query answered with a map this account lacks', () => {
  it('asks Tenjin again and shows its offer in the map’s place, with nothing sent to the account', async () => {
    await settings([FAL_ACCOUNT]);
    await signedIn(FAL_ACCOUNT, { missingTools: ['run_model'] });
    const answer = read<{ decision: { id: string } }>('wire-lookup-spec-account.json');
    const { fetchImpl, reasked } = network(undefined, await reaskOffering(), {
      ...answer,
      settingsHash: await hashNow(),
    });
    const session = account({});
    const result = await runRequestTool(
      { query: 'a photo of a lighthouse at dusk' },
      deps(fetchImpl, session),
    );
    expect(reasked).toMatchObject([{ refused: answer.decision.id }]);
    expect(result.envelope).toMatchObject({ status: 'spec', id: REPLACEMENT.id });
    expect(result.summary).toMatch(/^This fal account doesn't have what this job needs/);
    expect(session.opened).toEqual([]);
  });
});

describe("the user's settings, before the account", () => {
  it('stops an offer decided before a rule was saved, before anything is claimed or sent', async () => {
    await apifyConnected();
    await settings([APIFY_ACCOUNT], { version: 1, block: [{ kind: 'source', id: 'apify' }] });
    const session = apifyScript();
    const { fetchImpl, other } = network();
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      reasonCode: 'settings_changed',
    });
    expect(session.opened).toEqual([]);
    expect(other).toEqual([]);
    // Nothing was claimed: an offer under the rules saved now runs.
  });

  it('stops an offer once the account is disconnected, even with its hash unchanged', async () => {
    // A copied config names Apify, but this machine never signed in to it: the
    // router is never told of it, so its offer can only be a stale one.
    await settings([APIFY_ACCOUNT]);
    await offered(LEAD);
    const session = apifyScript();
    const { fetchImpl, outcomes, reasked } = network();
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.envelope).toMatchObject({ refused: { reason: 'not_connected' } });
    expect(result.summary).toContain("Apify isn't connected on this machine");
    expect(session.opened).toEqual([]);
    // The router answers a re-ask for an account not connected with nothing,
    // so none is paid for.
    expect(reasked).toEqual([]);
    expect(outcomes).toEqual([
      expect.objectContaining({ id: LEAD.id, status: 'unpaid', reason: 'provider' }),
    ]);
  });

  it('runs an offer only from an answer that echoed the settings it was decided under', async () => {
    await settings([APIFY_ACCOUNT]);
    await signedIn(APIFY_ACCOUNT);
    await storeAccountOffer(dir, LEAD, undefined);
    const session = apifyScript();
    const { fetchImpl } = network();
    const result = await runRequestTool({ id: LEAD.id, input: INPUT }, deps(fetchImpl, session));
    expect(result.envelope).toMatchObject({ reasonCode: 'settings_unconfirmed' });
    expect(session.opened).toEqual([]);
  });

  it('runs a map Tenjin has not checked only when the user named it', async () => {
    await settings([FAL_ACCOUNT]);
    await signedIn(FAL_ACCOUNT);
    await offered(FAL_LEAD);
    const session = account({ run_model: [text({ images: [] })] });
    const { fetchImpl } = network();
    const result = await runRequestTool(
      { id: FAL_LEAD.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl, session),
    );
    expect(result.envelope).toMatchObject({ status: 'needs_input' });
    expect(String(result.envelope.nextStep)).toContain('request({tool: "fal.flux-pro-ultra"})');
    expect(session.opened).toEqual([]);
  });

  /** A fal job this call could not wait out: its billing call sent, its
   *  follow-up kept for `request({job})`. */
  async function falJobRunning(session: ReturnType<typeof account>) {
    await settings([FAL_ACCOUNT]);
    await signedIn(FAL_ACCOUNT);
    await offered(FAL_LEAD, { named: true });
    const { fetchImpl } = network();
    const first = await runRequestTool(
      { id: FAL_LEAD.id, input: { prompt: 'a lighthouse at dusk' } },
      deps(fetchImpl, session, { startedAt: Date.now() - MAX_CALL_WAIT_MS }),
    );
    expect(first.envelope).toMatchObject({ status: 'running', job: FAL_LEAD.id });
    expect(session.tools()).toEqual(['run_model', 'check_job']);
    return fetchImpl;
  }

  const falScript = () =>
    account({
      run_model: [text({ status: 'processing', request_id: 'req-1' })],
      check_job: [text({ status: 'IN_QUEUE' }), text({ status: 'COMPLETED' })],
      get_job_result: [text({ images: [] })],
    });

  it('resumes a job after a rule saved since: its billing call already went out', async () => {
    // Plan 36: a call already sent can't be unsent, and the user's plan may
    // already have paid; refusing the free reads that fetch the result would
    // only lose it. The billing call is still never sent again.
    const session = falScript();
    const fetchImpl = await falJobRunning(session);
    await settings([FAL_ACCOUNT], { version: 1, block: [{ kind: 'source', id: 'fal' }] });
    const resumed = await runRequestTool({ job: FAL_LEAD.id }, deps(fetchImpl, session));
    expect(resumed.envelope).toMatchObject({ status: 'fulfilled' });
    expect(session.tools()).toEqual(['run_model', 'check_job', 'check_job', 'get_job_result']);
  });

  it('sends nothing for a job once its account is disconnected, and keeps it for a reconnect', async () => {
    // tenjin-agent#507 review: a resumed job sent its follow-up with the
    // account's credential after the account was gone.
    const session = falScript();
    const fetchImpl = await falJobRunning(session);
    await settings([]);
    const resumed = await runRequestTool({ job: FAL_LEAD.id }, deps(fetchImpl, session));
    expect(resumed.envelope).toMatchObject({ status: 'running', job: FAL_LEAD.id });
    expect(resumed.summary).toContain("fal isn't connected on this machine");
    expect(session.tools()).toEqual(['run_model', 'check_job']);
  });

  it('sends nothing for a job while the settings cannot be read', async () => {
    const session = falScript();
    const fetchImpl = await falJobRunning(session);
    await settings([FAL_ACCOUNT], { version: 99 });
    const resumed = await runRequestTool({ job: FAL_LEAD.id }, deps(fetchImpl, session));
    expect(resumed.summary).toContain("Your saved Tenjin rules can't be read");
    expect(String(resumed.envelope.nextStep)).toContain(`request({job: "${FAL_LEAD.id}"})`);
    expect(session.tools()).toEqual(['run_model', 'check_job']);
  });
});
