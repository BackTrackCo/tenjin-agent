import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATE_TIMEOUT_MS } from './gate';
import { runAnswerHook, runPromptHook } from './hooks';
import {
  claimLane,
  laneFiles,
  pausedReason,
  payerLanesDir,
  readLaneResult,
  useLanesOf,
  writeJson,
  writePool,
  writeWalletPool,
  type LaneState,
} from './lanes';

/**
 * The hook on each side of the routing fee: the free path until the fee is
 * approved and the server answers the paid path, a pre-signed rung on the paid
 * path, no call at all when no lane can pay, and one paused-routing line per
 * session.
 */

const BASE = 'https://tenjin.sh';
const NOW = 1_800_000_000_000;
const PAYER = '0x0000000000000000000000000000000000000001';
const NATIVE = {
  schemaVersion: 1,
  routerVersion: 'v',
  decision: {
    action: 'native',
    diagnostics: { reasonCode: 'native', stage: 'gate', missing: [], nextAction: 'native' },
  },
};
/** The free path's answer once the server routes only paid calls. */
const FEE_REQUIRED_ANSWER = {
  schemaVersion: 1,
  routerVersion: 'v',
  decision: {
    action: 'native',
    reason:
      'Tenjin routing needs a newer tenjin-cli. Tell the user to run `npm i -g tenjin-cli@latest`.',
    diagnostics: {
      reasonCode: 'fee_required',
      stage: 'capability',
      missing: [],
      nextAction: 'Update tenjin-cli (run `npm i -g tenjin-cli@latest`).',
    },
  },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-hooks-fee-'));
  await mkdir(join(dir, '.git'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function config(value: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, 'config.json'), JSON.stringify(value));
}

async function readyLane(index = 0): Promise<void> {
  const state: LaneState = {
    version: 1,
    index,
    payer: PAYER,
    salt: `0x${'0'.repeat(64)}`,
    channelId: `0xchannel${index}`,
    balanceAtomic: '250000',
    chargedAtomic: '0',
    status: 'ready',
    ladder: [{ maxClaimableAtomic: '3000', header: `rung-${index}` }],
    updatedAtMs: NOW - 1_000,
  };
  await writeJson(laneFiles.state(await useLanesOf(dir, PAYER), index), state);
}

function router(): {
  fetchImpl: typeof fetch;
  calls: { url: string; signature: string | null }[];
} {
  const calls: { url: string; signature: string | null }[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: String(input),
      signature: new Headers(init?.headers).get('payment-signature'),
    });
    const settle = Buffer.from(
      JSON.stringify({
        success: true,
        extra: { channelState: { chargedCumulativeAmount: '3000' } },
      }),
    ).toString('base64');
    return new Response(JSON.stringify(NATIVE), {
      status: 200,
      headers: { 'content-type': 'application/json', 'PAYMENT-RESPONSE': settle },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function prompt(session = 'sess-1'): unknown {
  return {
    hook_event_name: 'UserPromptSubmit',
    session_id: session,
    cwd: dir,
    prompt: 'what is the current price of ETH in USD',
  };
}

const deps = (fetchImpl: typeof fetch) => ({
  dataDir: dir,
  baseUrl: BASE,
  fetchImpl,
  now: () => NOW,
  warn: () => undefined,
});

function contextOf(response: unknown): string | undefined {
  return (response as { hookSpecificOutput?: { additionalContext?: string } } | null)
    ?.hookSpecificOutput?.additionalContext;
}

describe('the prompt hook and the routing fee', () => {
  it('uses the free path, unpaid, while the server has no paid path', async () => {
    await config({ routingFee: 'approved' });
    await readyLane();
    const { fetchImpl, calls } = router();
    const outcome = await runPromptHook(prompt(), deps(fetchImpl));
    expect(calls).toEqual([{ url: `${BASE}/api/x402-router`, signature: null }]);
    expect(outcome.response).toBeNull();
  });

  it('uses the free path without approval, and says once per session that paid routing is paused', async () => {
    await writePool(dir, { paidPath: 'available', checkedAtMs: NOW });
    const { fetchImpl, calls } = router();
    const first = await runPromptHook(prompt(), deps(fetchImpl));
    expect(calls[0]).toEqual({ url: `${BASE}/api/x402-router`, signature: null });
    expect(contextOf(first.response)).toContain('the routing fee');
    expect(contextOf(first.response)).toContain('`tenjin config set routingFee approved`');
    const second = await runPromptHook(prompt(), deps(fetchImpl));
    expect(second.response).toBeNull();
    const otherSession = await runPromptHook(prompt('sess-2'), deps(fetchImpl));
    expect(contextOf(otherSession.response)).toContain('`tenjin config set routingFee approved`');
  });

  it('names the approval command from the first fee_required answer, with no paid path known', async () => {
    // Nothing probed the paid path: before approval no owner runs.
    const calls: string[] = [];
    let required = true;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(JSON.stringify(required ? FEE_REQUIRED_ANSWER : NATIVE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const first = await runPromptHook(prompt(), deps(fetchImpl));
    expect(calls).toEqual([`${BASE}/api/x402-router`]);
    expect(contextOf(first.response)).toContain('`tenjin config set routingFee approved`');
    expect(contextOf(first.response)).not.toContain('npm i -g');
    expect((await runPromptHook(prompt(), deps(fetchImpl))).response).toBeNull();
    // The free path routing again lifts the pause.
    required = false;
    await runPromptHook(prompt(), deps(fetchImpl));
    expect(await pausedReason(dir, false)).toBeNull();
  });

  it('says once per session when the wallet cannot fund a lane, with the amount', async () => {
    await config({ routingFee: 'approved' });
    await writePool(dir, { paidPath: 'available', checkedAtMs: NOW });
    await writeWalletPool(await useLanesOf(dir, PAYER), {
      fundingBlocked: 'wallet_low',
      walletBalanceAtomic: '50000',
    });
    const { fetchImpl, calls } = router();
    const first = await runPromptHook(prompt(), deps(fetchImpl));
    expect(contextOf(first.response)).toContain('`tenjin wallet fund 0.20`');
    // No lane can pay, so the router is not asked at all.
    expect(calls).toEqual([]);
    expect((await runPromptHook(prompt(), deps(fetchImpl))).response).toBeNull();
  });

  it('says once per session when tenjin mcp cannot unlock the wallet, naming the variable', async () => {
    await config({ routingFee: 'approved' });
    await writePool(dir, { paidPath: 'available', checkedAtMs: NOW });
    await writeWalletPool(await useLanesOf(dir, PAYER), { ownerBlocked: 'wallet_locked' });
    const { fetchImpl } = router();
    const first = await runPromptHook(prompt(), deps(fetchImpl));
    expect(contextOf(first.response)).toContain('TENJIN_WALLET_PASSPHRASE');
    expect((await runPromptHook(prompt(), deps(fetchImpl))).response).toBeNull();
  });

  it('sends the lane rung to the paid path and writes the charged total back', async () => {
    await config({ routingFee: 'approved' });
    await writePool(dir, { paidPath: 'available', checkedAtMs: NOW });
    await readyLane();
    const { fetchImpl, calls } = router();
    await runPromptHook(prompt(), deps(fetchImpl));
    expect(calls).toEqual([{ url: `${BASE}/api/x402-router/route`, signature: 'rung-0' }]);
    expect(await readLaneResult(payerLanesDir(dir, PAYER), 0)).toMatchObject({
      chargedAtomic: '3000',
      outcome: 'charged',
    });
  });

  it('skips routing when no lane is free: the router is not asked and the native tool runs', async () => {
    await config({ routingFee: 'approved' });
    await writePool(dir, { paidPath: 'available', checkedAtMs: NOW });
    await readyLane();
    const held = await claimLane(dir, { now: NOW, allowanceAtomic: 500_000n });
    expect(held.lane).not.toBeNull();
    const { fetchImpl, calls } = router();
    const outcome = await runPromptHook(prompt(), deps(fetchImpl));
    expect(calls).toEqual([]);
    expect(outcome.response).toBeNull();
  });

  it('keeps a paid call that gets no answer inside the gate budget', async () => {
    await config({ routingFee: 'approved' });
    await writePool(dir, { paidPath: 'available', checkedAtMs: NOW });
    await readyLane();
    // A router that never answers: the call ends only when its timeout aborts it.
    let calls = 0;
    const silent = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    const started = Date.now();
    await runPromptHook(prompt(), deps(silent));
    expect(Date.now() - started).toBeLessThan(GATE_TIMEOUT_MS + 300);
    expect(calls).toBe(1);
    expect(await readLaneResult(payerLanesDir(dir, PAYER), 0)).toMatchObject({
      outcome: 'unknown',
    });
  }, 10_000);

  it('keeps the paused-routing line off the answer hook', async () => {
    await writePool(dir, { paidPath: 'available', checkedAtMs: NOW });
    const { fetchImpl, calls } = router();
    const answered = await runAnswerHook(
      {
        hook_event_name: 'PostToolUse',
        session_id: 'sess-answer',
        cwd: dir,
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which coin?', options: [] }] },
        tool_response: { answers: { 'Which coin?': 'ETH, price in USD now' } },
      },
      deps(fetchImpl),
    );
    // It did route the answer, and said nothing about the pause.
    expect(calls).toHaveLength(1);
    expect(answered).toEqual({ response: null, action: 'native' });
    // The session's prompt hook still carries it, once.
    const prompted = await runPromptHook(prompt('sess-answer'), deps(fetchImpl));
    expect(contextOf(prompted.response)).toContain('routing is paused');
  });
});
