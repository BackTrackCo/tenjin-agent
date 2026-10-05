import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';
import { runRouterDoctor } from './doctor';
import { laneFiles, lanesDir, writeJson, writePool } from './lanes';
import { runPaymentsFees } from './payments';
import { runRouterStatus } from './status';

/**
 * Where the routing fee is read back: `tenjin doctor`'s check with each paused
 * reason and its fix, and the fees in `tenjin status` and `tenjin payments fees`.
 */

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'doctor-fee-'));
  await mkdir(join(root, 'data'), { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000 },
    dataDir: join(root, 'data'),
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

async function feeCheck(): Promise<{ status: string; detail: string; fix?: string }> {
  const out = await runRouterDoctor(ctx(), {
    homeDir: join(root, 'home'),
    cwd: root,
    env: {},
    which: () => true,
    readMcp: async () => false,
    fetchImpl: (async () => new Response('{}', { status: 400 })) as typeof fetch,
  }).catch((e: unknown) => e);
  const data =
    out instanceof CliError
      ? (out.details as { checks: { name: string; status: string; detail: string }[] })
      : (out as { data: { checks: { name: string; status: string; detail: string }[] } }).data;
  return data.checks.find((c) => c.name === 'routing fee')!;
}

describe('doctor: routing fee', () => {
  it('passes, on the free path, while the server has no paid path', async () => {
    expect(await feeCheck()).toMatchObject({ status: 'ok' });
  });

  it('names a missing approval and the approval command', async () => {
    await writePool(join(root, 'data'), { paidPath: 'available', checkedAtMs: Date.now() });
    const check = await feeCheck();
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('routing is paused');
    expect(check.detail).toContain('not approved');
    expect(check.fix).toBe('Run `tenjin config set routingFee approved`.');
  });

  it('names a wallet that cannot fund a lane, and tenjin wallet fund with the amount', async () => {
    await writeFile(join(root, 'data', 'config.json'), JSON.stringify({ routingFee: 'approved' }));
    await writePool(join(root, 'data'), {
      paidPath: 'available',
      checkedAtMs: Date.now(),
      fundingBlocked: 'wallet_low',
      walletBalanceAtomic: '0',
    });
    const check = await feeCheck();
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('cannot fund');
    expect(check.fix).toBe('Run `tenjin wallet fund 0.25`.');
  });

  it('names allowlistCreators when it stopped a lane deposit', async () => {
    await writeFile(join(root, 'data', 'config.json'), JSON.stringify({ routingFee: 'approved' }));
    await writePool(join(root, 'data'), {
      paidPath: 'available',
      checkedAtMs: Date.now(),
      fundingBlocked: 'not_allowlisted',
    });
    const check = await feeCheck();
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('allowlistCreators stopped the last $0.25 lane deposit');
    expect(check.fix).toMatch(/^Add \S+ to allowlistCreators, or clear the allowlist\.$/);
  });
});

describe('fees in status and payments', () => {
  beforeEach(async () => {
    await writeFile(join(root, 'data', 'config.json'), JSON.stringify({ routingFee: 'approved' }));
    const dir = lanesDir(join(root, 'data'));
    await writeJson(laneFiles.state(dir, 0), {
      version: 1,
      index: 0,
      salt: `0x${'0'.repeat(64)}`,
      channelId: '0xchannel0',
      balanceAtomic: '250000',
      chargedAtomic: '9000',
      status: 'ready',
      ladder: [],
      updatedAtMs: Date.now(),
    });
    await writeFile(
      laneFiles.fees(dir, 0),
      [3000, 3000, 3000]
        .map((fee) => JSON.stringify({ atMs: Date.now(), feeAtomic: String(fee) }))
        .join('\n'),
    );
  });

  it('tenjin status shows the 24h fees against the allowance and what the lanes hold', async () => {
    const result = await runRouterStatus(ctx());
    expect((result.data as { routingFee: unknown }).routingFee).toMatchObject({
      approved: true,
      last24h: { atomic: '9000' },
      allowance: { atomic: '500000' },
      laneCredit: { atomic: '241000' },
      lanes: 1,
    });
    expect(result.humanLines?.join('\n')).toContain('routing fees 0.009 USD of 0.5 USD');
  });

  it('tenjin payments fees lists each lane beside the totals', async () => {
    const result = await runPaymentsFees(ctx());
    expect(result.data).toMatchObject({
      charged: { atomic: '9000' },
      lanes: [{ index: 0, deposited: { atomic: '250000' }, charged: { atomic: '9000' } }],
    });
    expect(result.humanLines?.[0]).toContain('0.009 USD charged in all');
  });
});
