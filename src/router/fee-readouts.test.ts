import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';
import { runRouterDoctor } from './doctor';
import { FileClientChannelStorage } from '@x402/evm/batch-settlement/client/file-storage';
import { appendFee, payerDir, writeFeeState } from './fee-state';
import { runPaymentsFees } from './payments';
import { runRouterStatus } from './status';

/**
 * Where the routing fee is read back: `tenjin doctor`'s check with each paused
 * reason and its fix, and the fees in `tenjin status` and `tenjin payments fees`.
 */

const PAYER = '0x0000000000000000000000000000000000000001';
const CHANNEL = `0x${'ab'.repeat(32)}`;

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

  it('passes without approval while the free path still routes, with the paid path known', async () => {
    await writeFeeState(join(root, 'data'), { paidPath: 'available', checkedAtMs: Date.now() });
    const check = await feeCheck();
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('not approved');
    expect(check.detail).toContain('routing uses the free path');
  });

  it('names the approval command once the free path answered fee_required', async () => {
    await writeFeeState(join(root, 'data'), { feeRequiredAtMs: Date.now() });
    const check = await feeCheck();
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('routing is paused');
    expect(check.detail).toContain('not approved');
    expect(check.fix).toBe('Run `tenjin config set routingFee approved`.');
  });

  it('names a wallet that cannot fund a channel deposit, and tenjin wallet fund with the amount', async () => {
    await writeFile(join(root, 'data', 'config.json'), JSON.stringify({ routingFee: 'approved' }));
    await writeFeeState(join(root, 'data'), { paidPath: 'available', checkedAtMs: Date.now() });
    await writeFeeState(join(root, 'data'), { blocked: 'wallet_low', walletBalanceAtomic: '0' });
    const check = await feeCheck();
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('cannot fund');
    expect(check.fix).toBe('Run `tenjin wallet fund 0.25`.');
  });

  it('names the passphrase variable when tenjin mcp cannot unlock the wallet', async () => {
    await writeFile(join(root, 'data', 'config.json'), JSON.stringify({ routingFee: 'approved' }));
    await writeFeeState(join(root, 'data'), { paidPath: 'available', checkedAtMs: Date.now() });
    await writeFeeState(join(root, 'data'), { blocked: 'wallet_locked' });
    const check = await feeCheck();
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('cannot unlock the wallet');
    expect(check.fix).toContain('TENJIN_WALLET_PASSPHRASE');
  });

  it('names allowlistCreators when it stopped a channel deposit', async () => {
    await writeFile(join(root, 'data', 'config.json'), JSON.stringify({ routingFee: 'approved' }));
    await writeFeeState(join(root, 'data'), { paidPath: 'available', checkedAtMs: Date.now() });
    await writeFeeState(join(root, 'data'), { blocked: 'not_allowlisted' });
    const check = await feeCheck();
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('allowlistCreators stopped the last $0.25 channel deposit');
    expect(check.fix).toMatch(/^Add \S+ to allowlistCreators, or clear the allowlist\.$/);
  });
});

describe('fees in status and payments', () => {
  beforeEach(async () => {
    const data = join(root, 'data');
    await writeFile(join(data, 'config.json'), JSON.stringify({ routingFee: 'approved' }));
    await writeFeeState(data, { payer: PAYER });
    // The channel as the SDK's own file storage keeps it.
    await new FileClientChannelStorage({ directory: payerDir(data, PAYER) }).set(CHANNEL, {
      balance: '250000',
      chargedCumulativeAmount: '9000',
    });
    for (let i = 0; i < 3; i++) {
      await appendFee(payerDir(data, PAYER), { atMs: Date.now(), feeAtomic: 3000n }, Date.now());
    }
  });

  it('tenjin status shows the 24h fees against the allowance and what the channels hold', async () => {
    const result = await runRouterStatus(ctx());
    expect((result.data as { routingFee: unknown }).routingFee).toMatchObject({
      approved: true,
      last24h: { atomic: '9000' },
      allowance: { atomic: '500000' },
      channelCredit: { atomic: '241000' },
      channels: 1,
    });
    expect(result.humanLines?.join('\n')).toContain('routing fees 0.009 USD of 0.5 USD');
  });

  it('tenjin payments fees lists each channel beside the totals', async () => {
    const result = await runPaymentsFees(ctx());
    expect(result.data).toMatchObject({
      charged: { atomic: '9000' },
      channels: [
        { channelId: CHANNEL, deposited: { atomic: '250000' }, charged: { atomic: '9000' } },
      ],
    });
    expect(result.humanLines?.[0]).toContain('0.009 USD charged in all');
  });
});
