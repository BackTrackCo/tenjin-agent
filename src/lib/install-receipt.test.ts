import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acknowledgeInstallReceipt,
  readInstallReceipt,
  writeInstallReceipt,
} from './install-receipt';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-install-receipt-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const input = () => ({
  harnesses: ['hermes'],
  execution: {
    surface: 'machine' as const,
    harnessApprovalMode: 'unknown' as const,
    humanPresenceProven: false as const,
    sameUserUnrestrictedAgentContained: false as const,
  },
  policy: {
    publishMode: { value: 'auto', source: 'profile:hermes' },
    spend: {
      source: 'clawrouter' as const,
      externalPolicyPath: '/tmp/.openclaw/blockrun/spending.json',
      externalPolicyMutationByTenjin: 'none' as const,
      ledger: 'separate-tenjin' as const,
      aggregateWithClawRouter: false as const,
      perRequestAtomic: '250000',
      dailyAtomic: '5000000',
    },
  },
  changedPaths: ['/tmp/config.yaml'],
  warnings: [
    'human presence was not proven',
    `bad key 0x${'ab'.repeat(32)} BLOCKRUN_WALLET_KEY=super-secret`,
  ],
  undoCommands: ['tenjin config set maxAutoSpend 0 --profile hermes'],
});

describe('install receipt', () => {
  it('writes an atomic owner-only secret-free pending receipt', async () => {
    const stored = await writeInstallReceipt(dir, input(), () => new Date('2026-08-10T00:00:00Z'));
    const raw = await readFile(stored.path, 'utf8');

    expect((await stat(stored.path)).mode & 0o777).toBe(0o600);
    expect(stored.receipt.notice).toEqual({
      status: 'unacknowledged',
      acknowledgementProven: false,
    });
    expect(raw).not.toContain(`0x${'ab'.repeat(32)}`);
    expect(raw).not.toContain('super-secret');
    expect(raw).toContain('[REDACTED_PRIVATE_KEY]');
    expect(raw).toContain('BLOCKRUN_WALLET_KEY=[REDACTED]');
    expect(stored.receipt.policy.spend).toMatchObject({
      source: 'clawrouter',
      externalPolicyMutationByTenjin: 'none',
      ledger: 'separate-tenjin',
      aggregateWithClawRouter: false,
    });
    await expect(readInstallReceipt(dir)).resolves.toEqual(stored);
  });

  it('acknowledges only the current id without claiming human proof', async () => {
    const stored = await writeInstallReceipt(dir, input());
    const acknowledged = await acknowledgeInstallReceipt(
      dir,
      stored.receipt.id,
      () => new Date('2026-08-10T01:00:00Z'),
    );
    expect(acknowledged.receipt.notice).toEqual({
      status: 'acknowledged',
      acknowledgedAt: '2026-08-10T01:00:00.000Z',
      acknowledgementProven: false,
    });
  });
});
