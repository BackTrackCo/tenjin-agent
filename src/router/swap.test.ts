import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPaymentRequired, testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { CommandContext } from '../context';
import { paidLedgerPath } from '../lib/paths';
import { runSwap } from './swap';
import { runNativeHook } from './hooks';
import { personalSettingsAt } from './settings';
import { ROUTER_PATH } from './decision';

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

async function hashNow(): Promise<string> {
  const { wire } = await personalSettingsAt(dir);
  if (wire.status !== 'ok') throw new Error('unreadable');
  return wire.settings.hash;
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

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: BASE },
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

/** The router answers `answer` (and records reports apart); Exa answers 402 then 200. */
function network(answer: unknown, onDecide?: () => Promise<void>) {
  const decisions: Record<string, unknown>[] = [];
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
    decisions.push(parsed);
    await onDecide?.();
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, decisions, reports, provider };
}

function depsFor(fetchImpl: typeof fetch) {
  const auth = authorizer();
  return {
    hook: { dataDir: dir, baseUrl: BASE, fetchImpl, warn: () => undefined },
    request: {
      ctx: ctx(),
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
  settingsHash: await hashNow(),
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
    const net = network({ ...ANSWER, settingsHash: await hashNow(), decision: plain });
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
