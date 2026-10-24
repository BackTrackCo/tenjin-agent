import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPay } from '../commands/pay';
import { directoryCachePath } from '../lib/paths';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import { readQuote } from '../lib/spend-quotes';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import { normalizeForWire, type SavedPolicy } from './access';
import { policyAtBoundary } from './admit';
import {
  acceptsFor,
  buildToolBody,
  type Choices,
  type DirectoryListing,
  type Identity,
  type OfferSpec,
} from './decision';
import { claimSpecPayment, readSpec, storeChoices, storeSpecs } from './specs';
import { runApproveTool, runRequestTool } from './tool';

// Pass-through, so a test can say no payment was even attempted.
vi.mock('../commands/pay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/pay')>();
  return { ...actual, runPay: vi.fn(actual.runPay) };
});
// Pass-through, so a test can save a block at the moment a take is claimed.
vi.mock('./specs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./specs')>();
  return { ...actual, claimSpecPayment: vi.fn(actual.claimSpecPayment) };
});
// Pass-through, so a test can save a block just after a boundary passed.
vi.mock('./admit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./admit')>();
  return { ...actual, policyAtBoundary: vi.fn(actual.policyAtBoundary) };
});

/**
 * EVERY EXECUTION, HELD TO THE USER'S SETTINGS BEFORE IT RUNS. The rules are
 * `router.policy` in the global config, written here the way another process
 * (`tenjin config block ...` in a second terminal) writes them: straight to
 * the file, between one call and the next. Nothing in the request tool caches
 * them, so the next call sees them.
 *
 * The router here answers three kinds of call: the free directory (the
 * catalog's identities, `wire-directory.json` unless a test says otherwise),
 * a decision (whatever a test scripts), and outcome reports. The provider is
 * a 402, then its paid answer. Every request is recorded, so a test can say
 * exactly what left the machine: provider HTTP, signatures, directory calls.
 */

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));

const DIRECTORY = fixture('wire-directory.json') as {
  schemaVersion: 1;
  routerVersion: string;
  directory: DirectoryListing;
};
const LISTING = DIRECTORY.directory;
const identityOf = (service: string): Identity =>
  LISTING.services.find(({ id }) => id === service)!.identity;
const CMC = identityOf('cmc-quotes');

const ROUTER = 'https://tenjin.sh';
const PROVIDER = 'https://pro-api.example.test/x402/v3/quotes';
const PAYEE = '0x1111111111111111111111111111111111111111';
const SPEC_ID = '0195f3a1-6c4d-7a2b-9e10-5f6a7b8c9d01';
const LIMITS = { maxAutoSpend: '250000', sessionBudget: '5000000' };
const INPUT = { symbol: 'BTC' };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-admit-'));
  // Its own git root: `router.*` resolves from here, never from the suite's cwd.
  await mkdir(join(dir, '.git'));
  await writeFile(join(dir, 'config.json'), JSON.stringify(LIMITS));
  vi.mocked(runPay).mockClear();
  vi.mocked(claimSpecPayment).mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** What another process's `tenjin config` leaves in the global file. */
function configWith(rules: Omit<SavedPolicy, 'version'> | null, limits = LIMITS): string {
  return JSON.stringify({
    ...limits,
    ...(rules !== null ? { router: { policy: { version: 1, ...rules } } } : {}),
  });
}
const saveRules = (rules: Omit<SavedPolicy, 'version'> | null, limits = LIMITS) =>
  writeFile(join(dir, 'config.json'), configWith(rules, limits));

const provider = (id: string) => ({ kind: 'provider' as const, id });

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

function cmcSpec(over: Partial<OfferSpec> = {}): OfferSpec {
  return {
    id: SPEC_ID,
    capabilityId: 'cmc-quotes',
    provider: 'CoinMarketCap',
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
    identity: CMC,
    ...over,
  };
}

interface Sent {
  url: string;
  paid: boolean;
  body?: Record<string, unknown>;
}
interface Answer {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * THE NETWORK: the router's directory, decisions and outcome reports, and the
 * provider. `directory` and `decide` answer from the body sent; `onProbe` runs
 * as the provider receives an unpaid request, and `probe` is its 402 for a URL.
 */
function network(
  opts: {
    directory?: (body: Record<string, unknown>) => Answer;
    decide?: (body: Record<string, unknown>) => Answer;
    onProbe?: () => void;
    probe?: (url: string) => Answer;
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
    const answer = (a: Answer) =>
      new Response(a.body === undefined ? null : JSON.stringify(a.body), {
        status: a.status,
        headers: { 'content-type': 'application/json', ...a.headers },
      });
    if (url.startsWith(ROUTER)) {
      if (body !== undefined && 'directory' in body) {
        return answer(opts.directory?.(body) ?? { status: 200, body: DIRECTORY });
      }
      if (body !== undefined && 'status' in body) return answer({ status: 200, body: {} });
      if (opts.decide !== undefined && body !== undefined) return answer(opts.decide(body));
      throw new Error(`unscripted router call: ${JSON.stringify(body)}`);
    }
    if (!paid) {
      opts.onProbe?.();
      return answer(
        opts.probe?.(url) ?? {
          status: 402,
          body: {},
          headers: { 'PAYMENT-REQUIRED': buildPaymentRequired({ amount: '10000' }).header },
        },
      );
    }
    return answer({ status: 200, body: { data: { BTC: 1 } } });
  }) as typeof fetch;
  const isDirectory = (call: Sent) => call.body !== undefined && 'directory' in call.body;
  const isReport = (call: Sent) => call.body !== undefined && 'status' in call.body;
  return {
    fetchImpl,
    calls,
    providerCalls: () => calls.filter((call) => !call.url.startsWith(ROUTER)),
    signed: () => calls.filter((call) => call.paid),
    directoryCalls: () => calls.filter(isDirectory),
    decisionCalls: () =>
      calls.filter((call) => call.url.startsWith(ROUTER) && !isDirectory(call) && !isReport(call)),
  };
}

function deps(fetchImpl: typeof fetch, auth = authorizer()) {
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

/** A directory answer with one listing's changes. */
const listing = (change: (copy: DirectoryListing) => void): Answer => {
  const copy = structuredClone(LISTING);
  change(copy);
  return { status: 200, body: { ...DIRECTORY, directory: copy } };
};

describe('a saved offer another process blocks', () => {
  it('runs nothing: no provider HTTP, no signature, and the offer stays free to run', async () => {
    await storeSpecs(dir, [cmcSpec()]);
    // The second terminal: `tenjin config block --provider coinmarketcap`.
    await saveRules({ block: [provider('coinmarketcap')] });
    const net = network();
    const auth = authorizer();
    const result = await runRequestTool({ id: SPEC_ID, input: INPUT }, deps(net.fetchImpl, auth));

    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'native',
      reasonCode: 'policy_refused',
      stage: 'policy',
      rule: { from: 'saved', kind: 'block', target: provider('coinmarketcap') },
      reason:
        "Tenjin didn't run this: your settings block CoinMarketCap. Nothing was sent or paid. You can change this with `tenjin config`.",
      nextStep:
        "Tell the user which setting stopped it; they can change it with `tenjin config`. Do not change Tenjin's settings yourself.",
      cost: ['provider price 0 USD'],
    });
    expect(net.providerCalls()).toEqual([]);
    expect(net.signed()).toEqual([]);
    expect(runPay).not.toHaveBeenCalled();
    expect(auth.authorize).not.toHaveBeenCalled();
    // One free directory call checked the stored identity first.
    expect(net.directoryCalls()).toHaveLength(1);
    expect(net.directoryCalls()[0]!.body).toEqual({ schemaVersion: 1, directory: {} });

    // Unblocked again, the same offer runs: the refusal never claimed it.
    await saveRules(null);
    const again = network();
    const ran = await runRequestTool({ id: SPEC_ID, input: INPUT }, deps(again.fetchImpl));
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(again.signed()).toHaveLength(1);
  });

  it('counts a block saved while the directory was answering', async () => {
    await storeSpecs(dir, [cmcSpec()]);
    await saveRules({ block: [provider('firecrawl')] });
    const net = network({
      directory: () => {
        // The other process saves its block mid-call.
        writeFileSync(
          join(dir, 'config.json'),
          configWith({ block: [provider('firecrawl'), provider('coinmarketcap')] }),
        );
        return { status: 200, body: DIRECTORY };
      },
    });
    const result = await runRequestTool({ id: SPEC_ID, input: INPUT }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({ reasonCode: 'policy_refused' });
    expect(net.providerCalls()).toEqual([]);
    // Refused at admission, read again after the directory answered: never claimed.
    expect(claimSpecPayment).not.toHaveBeenCalled();
  });

  it('runs exactly as before for a user with no rules: no directory call at all', async () => {
    await storeSpecs(dir, [cmcSpec()]);
    const net = network();
    const result = await runRequestTool({ id: SPEC_ID, input: INPUT }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(net.directoryCalls()).toEqual([]);
    expect(net.signed()).toHaveLength(1);
  });

  it('runs one the catalog still stands behind, and a fresh unchanged answer validates the copy', async () => {
    await saveRules({ block: [provider('firecrawl')] });
    await storeSpecs(dir, [cmcSpec(), cmcSpec({ id: `${SPEC_ID.slice(0, -2)}02` })]);
    const net = network({
      directory: (body) =>
        (body.directory as { ifRevision?: string }).ifRevision === LISTING.revision
          ? {
              status: 200,
              body: { ...DIRECTORY, directory: { revision: LISTING.revision, unchanged: true } },
            }
          : { status: 200, body: DIRECTORY },
    });
    const first = await runRequestTool({ id: SPEC_ID, input: INPUT }, deps(net.fetchImpl));
    expect(first.envelope).toMatchObject({ status: 'fulfilled' });
    const second = await runRequestTool(
      { id: `${SPEC_ID.slice(0, -2)}02`, input: INPUT },
      deps(net.fetchImpl),
    );
    expect(second.envelope).toMatchObject({ status: 'fulfilled' });
    expect(net.directoryCalls().map(({ body }) => body)).toEqual([
      { schemaVersion: 1, directory: {} },
      { schemaVersion: 1, directory: { ifRevision: LISTING.revision } },
    ]);
    expect(net.signed()).toHaveLength(2);
  });

  it('refuses an offer whose identity changed in the catalog since, as stale', async () => {
    await storeSpecs(dir, [cmcSpec()]);
    await saveRules({ block: [provider('firecrawl')] });
    const net = network({
      directory: () =>
        listing((copy) => {
          copy.services.find(({ id }) => id === 'cmc-quotes')!.identity.revision =
            '0000000000000000';
        }),
    });
    const result = await runRequestTool({ id: SPEC_ID, input: INPUT }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({
      status: 'needs_input',
      reasonCode: 'offer_stale',
      reason:
        "This offer changed since Tenjin made it, so it didn't run. Nothing was sent or paid. Ask again for a fresh offer.",
    });
    expect(net.providerCalls()).toEqual([]);
  });

  it('refuses an offer for a service the catalog retired', async () => {
    await storeSpecs(dir, [cmcSpec()]);
    await saveRules({ block: [provider('firecrawl')] });
    const net = network({
      directory: () =>
        listing((copy) => {
          copy.services = copy.services.filter(({ id }) => id !== 'cmc-quotes');
          copy.retired = [{ kind: 'service', id: 'cmc-quotes', label: 'CoinMarketCap quotes' }];
        }),
    });
    const result = await runRequestTool({ id: SPEC_ID, input: INPUT }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({
      reasonCode: 'offer_stale',
      reason: 'That service is no longer available through Tenjin. Nothing was sent or paid.',
    });
    expect(net.providerCalls()).toEqual([]);
  });

  it('refuses as unverified when the directory does not answer, a copy on disk notwithstanding', async () => {
    await storeSpecs(dir, [cmcSpec()]);
    await saveRules({ block: [provider('firecrawl')] });
    await writeFile(directoryCachePath(dir), JSON.stringify(LISTING));
    const net = network({ directory: () => ({ status: 503, body: {} }) });
    const result = await runRequestTool({ id: SPEC_ID, input: INPUT }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({
      status: 'failed',
      reasonCode: 'policy_unverified',
      reason:
        "Tenjin couldn't check this service against your settings, so it didn't run it. Nothing was sent or paid. Try again in a moment, or ask again for a fresh offer.",
    });
    expect(net.directoryCalls()).toHaveLength(1);
    expect(net.providerCalls()).toEqual([]);
  });

  it('refuses a spec kept from before identity under a rule that reads it, asking nobody', async () => {
    const old = cmcSpec();
    delete old.identity;
    await storeSpecs(dir, [old]);
    await saveRules({
      only: [{ scope: { kind: 'global' }, dimension: 'provider', targets: [provider('exa')] }],
    });
    const net = network();
    const result = await runRequestTool({ id: SPEC_ID, input: INPUT }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({ reasonCode: 'policy_unverified' });
    expect(net.calls).toEqual([]);
  });

  it('runs a spec kept from before identity for a user whose rules are only preferences', async () => {
    const old = cmcSpec();
    delete old.identity;
    await storeSpecs(dir, [old]);
    await saveRules({
      prefer: [{ scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'tenjin-alt' }] }],
    });
    const net = network();
    const result = await runRequestTool({ id: SPEC_ID, input: INPUT }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'fulfilled' });
    expect(net.directoryCalls()).toEqual([]);
  });

  it('holds an open-Bazaar listing to the rules as unreviewed, with no directory call', async () => {
    const bazaar: Identity = {
      service: 'discovered:bazaar:3f310f8c',
      source: 'tenjin',
      providers: [],
      categories: [],
      revision: 'aaaaaaaaaaaaaaaa',
    };
    await storeSpecs(dir, [
      cmcSpec({ capabilityId: 'discovered:bazaar:3f310f8c', identity: bazaar }),
    ]);
    // Nothing shows this listing is not Exa: a provider block covers it.
    await saveRules({ block: [provider('exa')] });
    const net = network();
    const result = await runRequestTool({ id: SPEC_ID, input: INPUT }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({
      reasonCode: 'policy_refused',
      rule: { kind: 'block', target: provider('exa') },
    });
    expect(net.calls).toEqual([]);
  });
});

describe("the router's answers, held to the rules before anything is kept or run", () => {
  const SPEC_ANSWER = fixture('wire-lookup-spec-identity.json') as {
    decision: { id: string };
  };

  it('keeps no spec the rules refuse, and sends the rules with the query', async () => {
    await saveRules({ block: [provider('coinmarketcap')] });
    const net = network({ decide: () => ({ status: 200, body: SPEC_ANSWER }) });
    const result = await runRequestTool({ query: 'BTC price' }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({ reasonCode: 'policy_refused' });
    expect(await readSpec(dir, SPEC_ANSWER.decision.id)).toBeNull();
    const [sent] = net.decisionCalls();
    expect(sent!.body!.policy).toEqual(
      normalizeForWire({ version: 1, block: [provider('coinmarketcap')] }),
    );
  });

  it('keeps no discovered service the rules refuse, nor any of its line', async () => {
    const answer = fixture('wire-hook-discovered-bound.json') as {
      decision: { specs: { id: string }[] };
    };
    await saveRules({ block: [provider('arxiv')] });
    const net = network({ decide: () => ({ status: 200, body: answer }) });
    const result = await runRequestTool({ query: 'papers on diffusion' }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({
      reasonCode: 'policy_refused',
      rule: { target: provider('arxiv') },
    });
    for (const spec of answer.decision.specs) expect(await readSpec(dir, spec.id)).toBeNull();
  });

  it('keeps no spec without identity under a rule that reads it, and keeps it with none', async () => {
    const old = fixture('wire-lookup-spec.json') as { decision: { id: string } };
    await saveRules({ block: [provider('firecrawl')] });
    const net = network({ decide: () => ({ status: 200, body: old }) });
    const refused = await runRequestTool({ query: '2+2' }, deps(net.fetchImpl));
    expect(refused.envelope).toMatchObject({ reasonCode: 'policy_unverified' });
    expect(await readSpec(dir, old.decision.id)).toBeNull();

    await saveRules(null);
    const shown = await runRequestTool({ query: '2+2' }, deps(net.fetchImpl));
    expect(shown.envelope).toMatchObject({ status: 'spec' });
    expect(await readSpec(dir, old.decision.id)).not.toBeNull();
  });

  it('runs no fresh docs call whose identity the rules refuse', async () => {
    await saveRules({ block: [provider('coinmarketcap')] });
    const execute = {
      schemaVersion: 1,
      routerVersion: 'v',
      decision: {
        action: 'execute',
        capabilityId: 'cmc-quotes',
        category: 'crypto price quote',
        provider: 'CoinMarketCap',
        capabilityDescription: 'latest market quotes',
        providerPriceAtomic: '10000',
        identity: CMC,
        contract: {
          request: { url: `${PROVIDER}?symbol=BTC`, method: 'GET', headers: {} },
        },
      },
    };
    const net = network({ decide: () => ({ status: 200, body: execute }) });
    const result = await runRequestTool(
      { query: 'BTC price', id: 'k3f9-abcd' },
      deps(net.fetchImpl),
    );
    expect(result.envelope).toMatchObject({ reasonCode: 'policy_refused' });
    expect(net.providerCalls()).toEqual([]);
  });
});

describe("the router's own refusal", () => {
  it('reaches the agent with the rule it named and its next step', async () => {
    const refused = fixture('wire-lookup-policy-refused.json') as {
      decision: { reason: string; diagnostics: { nextAction: string; rule: unknown } };
    };
    await saveRules({ block: [{ kind: 'source', id: 'tenjin' }] });
    const net = network({ decide: () => ({ status: 200, body: refused }) });
    const result = await runRequestTool({ query: 'BTC price' }, deps(net.fetchImpl));
    expect(result.isError).toBe(false);
    expect(result.envelope).toMatchObject({
      status: 'native',
      reasonCode: 'policy_refused',
      stage: 'policy',
      reason: refused.decision.reason,
      rule: refused.decision.diagnostics.rule,
      nextStep: refused.decision.diagnostics.nextAction,
    });
  });
});

describe('a router that cannot apply the settings', () => {
  /** A router from before settings: its strict schema refuses `policy`. */
  const oldRouter = (body: Record<string, unknown>): Answer =>
    'policy' in body || 'override' in body
      ? {
          status: 400,
          body: { error: { code: 'validation_failed', message: 'Unrecognized key: "policy"' } },
        }
      : { status: 200, body: fixture('wire-lookup-spec.json') };

  it('refuses a restricted user, never asking again without the rules', async () => {
    await saveRules({ block: [provider('firecrawl')] });
    const net = network({ decide: oldRouter });
    const result = await runRequestTool({ query: '2+2' }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({
      status: 'failed',
      reasonCode: 'policy_unverified',
      reason:
        "Tenjin couldn't apply your settings right now, so it didn't look this up. Nothing was sent or paid.",
    });
    expect(net.decisionCalls()).toHaveLength(1);
  });

  it('leaves a user with no rules exactly where they were', async () => {
    const net = network({ decide: oldRouter });
    const result = await runRequestTool({ query: '2+2' }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({ status: 'spec' });
  });

  it('refuses a browse that carried the rules too', async () => {
    await saveRules({ block: [provider('firecrawl')] });
    const net = network({ decide: oldRouter });
    const result = await runRequestTool({ browse: 'images' }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({ reasonCode: 'policy_unverified' });
  });
});

describe('what the request tool sends', () => {
  const native = {
    schemaVersion: 1,
    routerVersion: 'v',
    decision: {
      action: 'native',
      reason: 'Your own tools cover this.',
      diagnostics: {
        reasonCode: 'native_sufficient',
        stage: 'capability',
        missing: [],
        nextAction: '',
      },
    },
  };

  it('sends a user with no rules the body it always sent, byte for byte', async () => {
    const net = network({ decide: () => ({ status: 200, body: native }) });
    await runRequestTool({ query: 'weather' }, deps(net.fetchImpl));
    const [sent] = net.decisionCalls();
    expect(JSON.stringify(sent!.body)).toBe(
      JSON.stringify(
        buildToolBody({ query: 'weather', accepts: acceptsFor(false), harness: 'claude' }),
      ),
    );
  });

  it('sends the saved rules beside a query, a browse and a tool id, and preferences alone too', async () => {
    const saved: SavedPolicy = {
      version: 1,
      prefer: [{ scope: { kind: 'task', id: 'web research' }, targets: [provider('exa')] }],
    };
    await saveRules({ prefer: saved.prefer! });
    const net = network({ decide: () => ({ status: 200, body: native }) });
    await runRequestTool({ query: 'weather' }, deps(net.fetchImpl));
    await runRequestTool({ browse: '' }, deps(net.fetchImpl));
    await runRequestTool({ tool: 'exa-search' }, deps(net.fetchImpl));
    const wire = normalizeForWire(saved);
    expect(wire).toBeDefined();
    expect(net.decisionCalls().map(({ body }) => body!.policy)).toEqual([wire, wire, wire]);
  });

  it("sends this request's override beside its query, and holds the answer to it", async () => {
    const spec = fixture('wire-lookup-spec-identity.json');
    const net = network({ decide: () => ({ status: 200, body: spec }) });
    const override = { only: [{ dimension: 'provider', targets: [provider('exa')] }] };
    const result = await runRequestTool({ query: 'BTC price', override }, deps(net.fetchImpl));
    expect(net.decisionCalls()[0]!.body!.override).toEqual(override);
    // The pick is CoinMarketCap, outside what this request allows.
    expect(result.envelope).toMatchObject({
      reasonCode: 'policy_refused',
      rule: { from: 'request', kind: 'only', dimension: 'provider' },
      reason:
        "Tenjin didn't run this: this request allows only exa. Nothing was sent or paid. Send the request without that limit if the user agrees.",
    });
  });

  it('takes an override only beside a query, and only one the router takes', async () => {
    await storeSpecs(dir, [cmcSpec()]);
    const net = network();
    const beside = await runRequestTool(
      { id: SPEC_ID, input: INPUT, override: { prefer: [provider('exa')] } },
      deps(net.fetchImpl),
    );
    expect(beside.envelope).toMatchObject({ status: 'needs_input' });
    const mixed = await runRequestTool(
      {
        query: 'BTC',
        override: { prefer: [provider('exa'), { kind: 'service', id: 'exa-search' }] },
      },
      deps(net.fetchImpl),
    );
    expect(mixed.envelope).toMatchObject({ status: 'needs_input' });
    expect(String(mixed.envelope.reason)).toContain('a preference names targets of one kind');
    expect(net.calls).toEqual([]);
  });
});

describe('rules this build cannot read', () => {
  it('run nothing and send nothing, for any form', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ ...LIMITS, router: { policy: { version: 2, block: [] } } }),
    );
    await storeSpecs(dir, [cmcSpec()]);
    const net = network();
    for (const args of [
      { query: 'BTC price' },
      { id: SPEC_ID, input: INPUT },
      { browse: '' },
      { tool: 'cmc-quotes' },
    ]) {
      const result = await runRequestTool(args, deps(net.fetchImpl));
      expect(result.envelope).toMatchObject({
        status: 'failed',
        reasonCode: 'policy_invalid',
        reason:
          "Your Tenjin settings can't be read, so Tenjin won't run services until they're fixed. Nothing was sent or paid. Run `tenjin config` to see the problem.",
      });
    }
    expect(net.calls).toEqual([]);
  });
});

describe('a tool id the rules already rule out', () => {
  it('is refused with no network call when its service is blocked by name', async () => {
    await saveRules({ block: [{ kind: 'service', id: 'cmc-quotes' }] });
    const net = network();
    const result = await runRequestTool({ tool: 'cmc-quotes' }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({
      reasonCode: 'policy_refused',
      reason: expect.stringContaining('your settings block cmc-quotes'),
    });
    expect(net.calls).toEqual([]);
  });

  it('is refused with no network call when the copy on disk shows its provider blocked', async () => {
    await writeFile(directoryCachePath(dir), JSON.stringify(LISTING));
    await saveRules({ block: [provider('coinmarketcap')] });
    const net = network();
    const result = await runRequestTool({ tool: 'cmc-quotes' }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({
      reasonCode: 'policy_refused',
      reason: expect.stringContaining('your settings block CoinMarketCap'),
    });
    expect(net.calls).toEqual([]);
  });

  it('keeps no spec the router hands back for it when the rules refuse it', async () => {
    const spec = fixture('wire-lookup-spec-identity.json') as { decision: { id: string } };
    await saveRules({ block: [provider('coinmarketcap')] });
    const net = network({ decide: () => ({ status: 200, body: spec }) });
    const result = await runRequestTool({ tool: 'cmc-quotes' }, deps(net.fetchImpl));
    expect(result.envelope).toMatchObject({ reasonCode: 'policy_refused' });
    expect(await readSpec(dir, spec.decision.id)).toBeNull();
  });
});

describe('a call boundary after the execution was admitted', () => {
  it('stops every take a block reaches mid-flight: probed, but nothing signed', async () => {
    await saveRules({ block: [provider('firecrawl')] });
    await storeSpecs(dir, [cmcSpec({ takes: { max: 3 } })]);
    const net = network({
      // The unpaid probe is the moment the other process saves its block.
      onProbe: () =>
        writeFileSync(
          join(dir, 'config.json'),
          configWith({ block: [provider('firecrawl'), provider('coinmarketcap')] }),
        ),
    });
    const result = await runRequestTool(
      { id: SPEC_ID, input: INPUT, count: 2 },
      deps(net.fetchImpl),
    );
    expect(net.providerCalls()).toHaveLength(1);
    expect(net.signed()).toEqual([]);
    expect(runPay).not.toHaveBeenCalled();
    const results = result.envelope.results as Record<string, unknown>[];
    expect(results).toHaveLength(2);
    for (const take of results) expect(take).toMatchObject({ reasonCode: 'policy_refused' });
  });

  it('stops a count before its probe when a rule starts reading identity once it was admitted', async () => {
    // No rules when the count is admitted, so nothing was checked against the
    // catalog; the block lands as the first take is claimed.
    await storeSpecs(dir, [cmcSpec({ takes: { max: 3 } })]);
    const claim = vi.mocked(claimSpecPayment);
    const real = claim.getMockImplementation()!;
    claim.mockImplementationOnce(async (...args) => {
      writeFileSync(join(dir, 'config.json'), configWith({ block: [provider('firecrawl')] }));
      return real(...args);
    });
    const net = network();
    const result = await runRequestTool(
      { id: SPEC_ID, input: INPUT, count: 2 },
      deps(net.fetchImpl),
    );
    expect(result.envelope).toMatchObject({ reasonCode: 'policy_unverified' });
    expect(net.providerCalls()).toEqual([]);
    // Every claim was released: the count may run again.
    await saveRules(null);
    const again = network();
    const ran = await runRequestTool(
      { id: SPEC_ID, input: INPUT, count: 2 },
      deps(again.fetchImpl),
    );
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
  });

  it('refuses a count before any take is claimed or probed', async () => {
    await saveRules({ block: [provider('coinmarketcap')] });
    await storeSpecs(dir, [cmcSpec({ takes: { max: 3 } })]);
    const net = network();
    const result = await runRequestTool(
      { id: SPEC_ID, input: INPUT, count: 2 },
      deps(net.fetchImpl),
    );
    expect(result.envelope).toMatchObject({ reasonCode: 'policy_refused' });
    expect(net.providerCalls()).toEqual([]);
    // The stored spec was checked against the catalog, before any claim.
    expect(net.directoryCalls()).toHaveLength(1);
    expect(claimSpecPayment).not.toHaveBeenCalled();
  });
});

describe('a compare group', () => {
  const choices = fixture('wire-hook-discovered-choices.json') as {
    decision: { id: string; hint: string; specs: OfferSpec[]; choices: Choices };
  };
  const { id: ID, hint: HINT, choices: CHOICES } = choices.decision;
  const GPT_IDENTITY: Identity = {
    service: 'gondola-gpt-image-2.5',
    source: 'tenjin',
    providers: ['openai'],
    seller: 'gondola',
    task: 'photoreal image',
    categories: ['images'],
    revision: 'bbbbbbbbbbbbbbbb',
  };
  const BANANA_IDENTITY = identityOf('aispace-nano-banana-2.1');
  const SPECS = [
    { ...choices.decision.specs[0]!, identity: GPT_IDENTITY },
    { ...choices.decision.specs[1]!, identity: BANANA_IDENTITY },
  ];
  const withGpt = () =>
    listing((copy) => {
      copy.services.push({
        id: GPT_IDENTITY.service,
        label: 'GPT Image 2.5',
        identity: GPT_IDENTITY,
      });
    });

  it('is refused whole when one member is blocked, naming what could run alone', async () => {
    await storeSpecs(dir, SPECS);
    await storeChoices(dir, ID, { choices: CHOICES, hint: HINT });
    await saveRules({ block: [provider('google')] });
    const net = network({ directory: withGpt });
    const result = await runRequestTool(
      { id: ID, choice: 'all', input: { prompt: 'a lighthouse' } },
      deps(net.fetchImpl),
    );
    expect(result.envelope).toMatchObject({
      status: 'native',
      reasonCode: 'policy_refused',
      rule: { kind: 'block', target: provider('google') },
      allowedChoices: [
        { key: 'gpt-image-2.5', label: 'GPT Image 2.5 Sunburst', id: CHOICES.options[0]!.id },
      ],
      reason:
        "Tenjin didn't run this set: your settings block Google, used by Nano Banana 2.1. Nothing was sent or paid. You can run GPT Image 2.5 Sunburst on its own, or change your settings with `tenjin config`.",
    });
    // One directory call for the whole set; no member probed, claimed or paid.
    expect(net.directoryCalls()).toHaveLength(1);
    expect(net.providerCalls()).toEqual([]);
    expect(claimSpecPayment).not.toHaveBeenCalled();
  });

  /** Each seller quotes its own terms, so every member is planned. */
  const sellerTerms = (url: string): Answer => {
    const { priceAtomic, payTo } = SPECS.find(({ request }) => request.url === url)!;
    return {
      status: 402,
      body: {},
      headers: { 'PAYMENT-REQUIRED': buildPaymentRequired({ amount: priceAtomic, payTo }).header },
    };
  };
  /** What another process's `tenjin config block --provider google` saves. */
  const blockGoogle = () =>
    writeFileSync(
      join(dir, 'config.json'),
      configWith({ block: [provider('firecrawl'), provider('google')] }),
    );

  it('is refused whole when a block lands while its members are probed: nothing signed', async () => {
    await storeSpecs(dir, SPECS);
    await storeChoices(dir, ID, { choices: CHOICES, hint: HINT });
    // An unrelated block, so the set is admitted against the catalog.
    await saveRules({ block: [provider('firecrawl')] });
    const net = network({
      directory: withGpt,
      probe: sellerTerms,
      // The probes are the moment another process saves a Google block.
      onProbe: blockGoogle,
    });
    const result = await runRequestTool(
      { id: ID, choice: 'all', input: { prompt: 'a lighthouse' } },
      deps(net.fetchImpl),
    );
    expect(net.signed()).toEqual([]);
    // The two probes, and nothing after them.
    expect(net.providerCalls()).toHaveLength(2);
    expect(result.envelope).toMatchObject({
      reasonCode: 'policy_refused',
      rule: { kind: 'block', target: provider('google') },
      allowedChoices: [
        { key: 'gpt-image-2.5', label: 'GPT Image 2.5 Sunburst', id: CHOICES.options[0]!.id },
      ],
    });
  });

  it("holds each member's own payment to the whole set, for a block saved after the last check", async () => {
    await storeSpecs(dir, SPECS);
    await storeChoices(dir, ID, { choices: CHOICES, hint: HINT });
    await saveRules({ block: [provider('firecrawl')] });
    // The set's checks before and after its probes pass; the block lands
    // as the second one returns, before either member's payment boundary.
    const boundary = vi.mocked(policyAtBoundary);
    const real = boundary.getMockImplementation()!;
    boundary.mockImplementationOnce(real).mockImplementationOnce(async (...args) => {
      const verdict = await real(...args);
      blockGoogle();
      return verdict;
    });
    const net = network({ directory: withGpt, probe: sellerTerms });
    const result = await runRequestTool(
      { id: ID, choice: 'all', input: { prompt: 'a lighthouse' } },
      deps(net.fetchImpl),
    );
    expect(net.signed()).toEqual([]);
    const results = result.envelope.results as Record<string, unknown>[];
    expect(results).toHaveLength(2);
    for (const member of results) expect(member).toMatchObject({ reasonCode: 'policy_refused' });
  });
});

describe('an approved quote the rules now refuse', () => {
  it('is refused before the quote is used or the wallet opened, and still runs once unblocked', async () => {
    await saveRules(null, { maxAutoSpend: '5000', sessionBudget: '5000000' });
    await storeSpecs(dir, [cmcSpec()]);
    const net = network();
    const asked = await runRequestTool(
      { id: SPEC_ID, input: INPUT },
      { ...deps(net.fetchImpl), approves: true },
    );
    expect(asked.envelope).toMatchObject({ status: 'needs_approval' });
    const quote = asked.envelope.quote as { id: string; total: string; what: string };

    await saveRules(
      { block: [provider('coinmarketcap')] },
      { maxAutoSpend: '5000', sessionBudget: '5000000' },
    );
    const before = net.calls.length;
    const refused = await runApproveTool(
      { quote: quote.id, total: quote.total, what: quote.what },
      deps(net.fetchImpl),
    );
    expect(refused.envelope).toMatchObject({ reasonCode: 'policy_refused' });
    expect((await readQuote(dir, quote.id))!.usedAt).toBeUndefined();
    expect(net.calls.slice(before).filter((call) => !call.url.startsWith(ROUTER))).toEqual([]);
    expect(net.signed()).toEqual([]);

    await saveRules(null, { maxAutoSpend: '5000', sessionBudget: '5000000' });
    const ran = await runApproveTool(
      { quote: quote.id, total: quote.total, what: quote.what },
      deps(net.fetchImpl),
    );
    expect(ran.envelope).toMatchObject({ status: 'fulfilled' });
    expect(net.signed()).toHaveLength(1);
  });
});
