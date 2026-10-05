import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAnswerHook, runPromptHook } from './hooks';
import {
  claimLane,
  laneFiles,
  lanesDir,
  readLaneResult,
  writeJson,
  writePool,
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
const NATIVE = {
  schemaVersion: 1,
  routerVersion: 'v',
  decision: {
    action: 'native',
    diagnostics: { reasonCode: 'native', stage: 'gate', missing: [], nextAction: 'native' },
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
    salt: `0x${'0'.repeat(64)}`,
    channelId: `0xchannel${index}`,
    balanceAtomic: '250000',
    chargedAtomic: '0',
    status: 'ready',
    ladder: [{ maxClaimableAtomic: '3000', header: `rung-${index}` }],
    updatedAtMs: NOW - 1_000,
  };
  await writeJson(laneFiles.state(lanesDir(dir), index), state);
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

  it('says once per session when the wallet cannot fund a lane, with the amount', async () => {
    await config({ routingFee: 'approved' });
    await writePool(dir, {
      paidPath: 'available',
      checkedAtMs: NOW,
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

  it('sends the lane rung to the paid path and writes the charged total back', async () => {
    await config({ routingFee: 'approved' });
    await writePool(dir, { paidPath: 'available', checkedAtMs: NOW });
    await readyLane();
    const { fetchImpl, calls } = router();
    await runPromptHook(prompt(), deps(fetchImpl));
    expect(calls).toEqual([{ url: `${BASE}/api/x402-router/route`, signature: 'rung-0' }]);
    expect(await readLaneResult(lanesDir(dir), 0)).toMatchObject({
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
