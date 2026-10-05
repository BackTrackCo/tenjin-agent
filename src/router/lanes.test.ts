import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chargedFrom,
  claimLane,
  feesInWindow,
  firstNoticeFor,
  HOOK_CLAIM_TTL_MS,
  laneFiles,
  lanesDir,
  pausedReason,
  pausedSentence,
  readLaneResult,
  readPool,
  takeClaim,
  writeJson,
  writePool,
  type LaneState,
} from './lanes';

/**
 * `on`: every file write waits a moment first, so a race window stays open.
 * `vanish`: the next read of a claim finds nothing, as when its holder let it
 * go and another payer took it between that read and the move.
 */
const slow = vi.hoisted(() => ({ on: false, vanish: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (slow.vanish && String(args[0]).endsWith('.claim')) {
        slow.vanish = false;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return fs.readFile(...args);
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (slow.on) await pause();
      return fs.writeFile(...args);
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (slow.on) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...rest: Parameters<typeof write>) => {
          await pause();
          return write(...rest);
        };
      }
      return handle;
    },
  };
});

let dir: string;
const NOW = 1_800_000_000_000;
const ALLOWANCE = 500_000n;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-lanes-unit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A lane as an owner leaves it: funded, with rungs from the charged total. */
async function lane(index: number, over: Partial<LaneState> = {}): Promise<void> {
  const charged = BigInt(over.chargedAtomic ?? '0');
  const state: LaneState = {
    version: 1,
    index,
    payer: '0x0000000000000000000000000000000000000001',
    salt: `0x${'0'.repeat(63)}${index}`,
    channelId: `0xchannel${index}`,
    balanceAtomic: '250000',
    chargedAtomic: charged.toString(),
    status: 'ready',
    ladder: [1n, 2n, 3n].map((i) => ({
      maxClaimableAtomic: (charged + i * 3_000n).toString(),
      header: `rung-${index}-${charged + i * 3_000n}`,
    })),
    updatedAtMs: NOW - 1_000,
    ...over,
  };
  await writeJson(laneFiles.state(lanesDir(dir), index), state);
}

function settle(charged: bigint): string {
  return Buffer.from(
    JSON.stringify({
      success: true,
      transaction: '0x',
      network: 'eip155:8453',
      extra: { channelState: { chargedCumulativeAmount: charged.toString() } },
    }),
  ).toString('base64');
}

describe('claimLane', () => {
  it('gives parallel payers different lanes', async () => {
    await lane(0);
    await lane(1);
    const [a, b] = await Promise.all([
      claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE }),
      claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE }),
    ]);
    expect(a.lane).not.toBeNull();
    expect(b.lane).not.toBeNull();
    expect(a.lane!.index).not.toBe(b.lane!.index);
    const third = await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE });
    expect(third).toEqual({ lane: null, why: 'busy' });
  });

  it('sends the rung one fee above the charged total, and the same rung again after a $0 settle', async () => {
    await lane(0);
    const first = await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE });
    expect(first.lane?.header).toBe('rung-0-3000');
    await first.lane!.finish({ kind: 'answered', status: 200, paymentResponse: settle(0n) });
    expect((await readLaneResult(lanesDir(dir), 0))?.outcome).toBe('zero');
    const second = await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE });
    expect(second.lane?.header).toBe('rung-0-3000');
    await second.lane!.finish({ kind: 'answered', status: 200, paymentResponse: settle(3_000n) });
    const third = await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE });
    expect(third.lane?.header).toBe('rung-0-6000');
    expect(await feesInWindow(dir, NOW)).toBe(3_000n);
  });

  it("frees a killed payer's lane only once its claim expires", async () => {
    await lane(0);
    const killed = await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE });
    expect(killed.lane).not.toBeNull();
    const early = await claimLane(dir, {
      now: NOW + HOOK_CLAIM_TTL_MS - 1,
      allowanceAtomic: ALLOWANCE,
    });
    expect(early).toEqual({ lane: null, why: 'busy' });
    const late = await claimLane(dir, {
      now: NOW + HOOK_CLAIM_TTL_MS + 1,
      allowanceAtomic: ALLOWANCE,
    });
    expect(late.lane?.index).toBe(0);
    // The killed payer's late release cannot drop the new holder's claim.
    await killed.lane!.finish({ kind: 'no_answer' });
    const raw = JSON.parse(await readFile(laneFiles.claim(lanesDir(dir), 0), 'utf8'));
    expect(raw.expiresAtMs).toBe(NOW + HOOK_CLAIM_TTL_MS + 1 + HOOK_CLAIM_TTL_MS);
  });

  it('skips a recovering lane, a lane below one fee, and a spent allowance', async () => {
    await lane(0, { status: 'recovering' });
    expect(await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE })).toEqual({
      lane: null,
      why: 'recovering',
    });
    await lane(0, { balanceAtomic: '250000', chargedAtomic: '248000' });
    expect(await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE })).toEqual({
      lane: null,
      why: 'below_fee',
    });
    await lane(0);
    expect(await claimLane(dir, { now: NOW, allowanceAtomic: 2_000n })).toEqual({
      lane: null,
      why: 'allowance',
    });
  });

  it('marks the lane recovering after a corrective 402', async () => {
    await lane(0);
    const held = await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE });
    await held.lane!.finish({ kind: 'payment_required', paymentRequired: 'eyJ9' });
    expect((await readLaneResult(lanesDir(dir), 0))?.outcome).toBe('corrective');
    expect((await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE })).lane).toBeNull();
  });

  it('lets the allowance go over by at most one fee per lane', async () => {
    await lane(0);
    await lane(1);
    // Slow writes hold all four payers inside the race: each checks the
    // allowance before any call has written its fee.
    slow.on = true;
    const all = await Promise.all(
      [0, 1, 0, 1].map((i) => claimLane(dir, { now: NOW, allowanceAtomic: 3_000n, prefer: [i] })),
    ).finally(() => {
      slow.on = false;
    });
    const held = all.flatMap((c) => (c.lane === null ? [] : [c.lane]));
    // A lane carries one call at a time, so two lanes pay at most two fees.
    expect(held).toHaveLength(2);
    expect(new Set(held.map((l) => l.index)).size).toBe(2);
    for (const l of held) {
      await l.finish({ kind: 'answered', status: 200, paymentResponse: settle(3_000n) });
    }
    expect(await feesInWindow(dir, NOW)).toBe(6_000n);
    expect(await claimLane(dir, { now: NOW, allowanceAtomic: 3_000n })).toEqual({
      lane: null,
      why: 'allowance',
    });
  });

  it('counts the fee a payer wrote back before the owner writes it down', async () => {
    await lane(0);
    const first = await claimLane(dir, { now: NOW, allowanceAtomic: 6_000n });
    await first.lane!.finish({ kind: 'answered', status: 200, paymentResponse: settle(3_000n) });
    const second = await claimLane(dir, { now: NOW, allowanceAtomic: 6_000n });
    expect(second.lane?.header).toBe('rung-0-6000');
    await second.lane!.finish({ kind: 'answered', status: 200, paymentResponse: settle(6_000n) });
    // One lane, one payer at a time: the allowance holds exactly.
    expect(await claimLane(dir, { now: NOW, allowanceAtomic: 6_000n })).toEqual({
      lane: null,
      why: 'allowance',
    });
  });

  it('asks for a bigger pool only when every lane is held by another payer', async () => {
    await writePool(dir, { paidPath: 'available', checkedAtMs: NOW });
    // A lane below one fee: more lanes would be unfunded too.
    await lane(0, { chargedAtomic: '248000' });
    expect((await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE })).lane).toBeNull();
    expect((await readPool(dir))?.demandAtMs).toBeUndefined();
    // A held lane: another one would carry the call.
    await lane(0);
    const held = await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE });
    expect(held.lane).not.toBeNull();
    expect(await claimLane(dir, { now: NOW + 1, allowanceAtomic: ALLOWANCE })).toEqual({
      lane: null,
      why: 'busy',
    });
    expect((await readPool(dir))?.demandAtMs).toBe(NOW + 1);
  });

  it('never lets a second payer take a claim that is still being written', async () => {
    slow.on = true;
    try {
      const first = takeClaim(lanesDir(dir), 0, HOOK_CLAIM_TTL_MS, NOW);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = takeClaim(lanesDir(dir), 0, HOOK_CLAIM_TTL_MS, NOW);
      const tokens = await Promise.all([first, second]);
      expect(tokens.filter((t) => t !== null)).toHaveLength(1);
    } finally {
      slow.on = false;
    }
  });

  it('puts back a live claim it moved after reading none', async () => {
    const holder = await takeClaim(lanesDir(dir), 0, HOOK_CLAIM_TTL_MS, NOW);
    expect(holder).not.toBeNull();
    slow.vanish = true;
    expect(await takeClaim(lanesDir(dir), 0, HOOK_CLAIM_TTL_MS, NOW)).toBeNull();
    const raw = JSON.parse(await readFile(laneFiles.claim(lanesDir(dir), 0), 'utf8'));
    expect(raw.token).toBe(holder);
  });

  it('says there are no lanes when none exist', async () => {
    expect(await claimLane(dir, { now: NOW, allowanceAtomic: ALLOWANCE })).toEqual({
      lane: null,
      why: 'no_lanes',
    });
  });
});

describe('chargedFrom', () => {
  it('reads the charged total from a successful settle and nothing else', () => {
    expect(chargedFrom(settle(9_000n))).toBe(9_000n);
    expect(chargedFrom(Buffer.from('{"success":false}').toString('base64'))).toBeNull();
    expect(chargedFrom('not base64 json')).toBeNull();
  });
});

describe('pausedReason', () => {
  it('is quiet until the server answers the paid path', async () => {
    expect(await pausedReason(dir, false)).toBeNull();
    await writePool(dir, { paidPath: 'absent', checkedAtMs: NOW });
    expect(await pausedReason(dir, false)).toBeNull();
  });

  it('names a missing approval, with the approval command', async () => {
    await writePool(dir, { paidPath: 'available', checkedAtMs: NOW });
    const paused = await pausedReason(dir, false);
    expect(paused).toEqual({ reason: 'approval_missing' });
    expect(pausedSentence(paused!)).toContain('`tenjin config set routingFee approved`');
  });

  it('names a wallet that cannot fund a lane, with the amount to fund', async () => {
    await writePool(dir, {
      paidPath: 'available',
      checkedAtMs: NOW,
      fundingBlocked: 'wallet_low',
      walletBalanceAtomic: '100000',
    });
    await lane(0, { chargedAtomic: '248000' });
    const paused = await pausedReason(dir, true);
    expect(paused).toEqual({ reason: 'cannot_fund', walletAtomic: 100_000n });
    expect(pausedSentence(paused!)).toContain('`tenjin wallet fund 0.15`');
    // One lane that can still pay is not a pause.
    await lane(1);
    expect(await pausedReason(dir, true)).toBeNull();
  });
});

describe('firstNoticeFor', () => {
  it('is true once per session', async () => {
    expect(await firstNoticeFor(dir, 'session-a', NOW)).toBe(true);
    expect(await firstNoticeFor(dir, 'session-a', NOW)).toBe(false);
    expect(await firstNoticeFor(dir, 'session-b', NOW)).toBe(true);
  });
});
