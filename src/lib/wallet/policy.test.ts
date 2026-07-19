import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateSpend, ledgerPath, releaseSpend, reserveSpend, spentInWindow } from './policy';
import type { SpendRequest } from './provider';
import type { Config } from '../config';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-policy-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Policy = Pick<Config, 'maxAutoSpend' | 'sessionBudget' | 'confirm' | 'allowlistCreators'>;

const DEFAULT_POLICY: Policy = {
  maxAutoSpend: '0',
  sessionBudget: '0',
  confirm: 'always',
  allowlistCreators: [],
};

function req(overrides: Partial<SpendRequest> = {}): SpendRequest {
  return { amountAtomic: '1', explicitApproval: false, ...overrides };
}

describe('evaluateSpend', () => {
  it.each([
    [
      'defaults: any nonzero price confirms (maxAutoSpend 0, confirm always)',
      DEFAULT_POLICY,
      req({ amountAtomic: '1' }),
      0n,
      'confirm' as const,
      ['exceeds maxAutoSpend', 'confirm policy is "always"'],
    ],
    [
      'explicitApproval allows when sessionBudget is unlimited (0)',
      DEFAULT_POLICY,
      req({ amountAtomic: '5000000', explicitApproval: true }),
      0n,
      'allow' as const,
      ['explicit approval (--yes)'],
    ],
    [
      'explicitApproval is refused when it would exceed sessionBudget (refuse wins over --yes)',
      { ...DEFAULT_POLICY, sessionBudget: '1000000' },
      req({ amountAtomic: '600000', explicitApproval: true }),
      600000n,
      'refuse' as const,
      ['sessionBudget exhausted'],
    ],
    [
      'explicitApproval allows when within a set sessionBudget',
      { ...DEFAULT_POLICY, sessionBudget: '1000000' },
      req({ amountAtomic: '400000', explicitApproval: true }),
      400000n,
      'allow' as const,
      ['explicit approval (--yes)'],
    ],
    [
      'within maxAutoSpend + below confirm threshold + allowlisted creator (case-insensitive): quiet allow',
      {
        maxAutoSpend: '1000000',
        sessionBudget: '0',
        confirm: 'above:2000000',
        allowlistCreators: ['Alice'],
      },
      req({ amountAtomic: '500000', creatorHandle: 'ALICE' }),
      0n,
      'allow' as const,
      ['within policy'],
    ],
    [
      'above the confirm threshold: confirm',
      {
        maxAutoSpend: '5000000',
        sessionBudget: '0',
        confirm: 'above:2000000',
        allowlistCreators: ['Alice'],
      },
      req({ amountAtomic: '3000000', creatorHandle: 'Alice' }),
      0n,
      'confirm' as const,
      ['is above the confirm threshold'],
    ],
    [
      'creator not in a non-empty allowlist: confirm',
      {
        maxAutoSpend: '5000000',
        sessionBudget: '0',
        confirm: 'above:5000000',
        allowlistCreators: ['alice'],
      },
      req({ amountAtomic: '1000000', creatorHandle: 'bob' }),
      0n,
      'confirm' as const,
      ['is not in allowlistCreators'],
    ],
    [
      'no creatorHandle at all against a non-empty allowlist: confirm, reports "(unknown)"',
      {
        maxAutoSpend: '5000000',
        sessionBudget: '0',
        confirm: 'above:5000000',
        allowlistCreators: ['alice'],
      },
      req({ amountAtomic: '1000000' }),
      0n,
      'confirm' as const,
      ['(unknown) is not in allowlistCreators'],
    ],
    [
      'every violated gate names itself in reasons',
      {
        maxAutoSpend: '100000',
        sessionBudget: '0',
        confirm: 'above:200000',
        allowlistCreators: ['alice'],
      },
      req({ amountAtomic: '900000', creatorHandle: 'bob' }),
      0n,
      'confirm' as const,
      ['exceeds maxAutoSpend', 'is above the confirm threshold', 'is not in allowlistCreators'],
    ],
  ])('%s', (_name, policy, request, alreadySpent, expectedDecision, reasonSubstrings) => {
    const result = evaluateSpend(policy, request, alreadySpent);
    expect(result.decision).toBe(expectedDecision);
    expect(result.reasons).toHaveLength(reasonSubstrings.length);
    for (const substring of reasonSubstrings) {
      expect(result.reasons.some((r) => r.includes(substring))).toBe(true);
    }
  });

  it('sessionBudget 0 means unlimited: a huge already-spent total never refuses', () => {
    const result = evaluateSpend(
      DEFAULT_POLICY,
      req({ amountAtomic: '999999999999', explicitApproval: true }),
      999999999999n,
    );
    expect(result.decision).toBe('allow');
  });
});

describe('spentInWindow', () => {
  it('sums only ledger entries within the last 24h', async () => {
    const now = new Date('2026-07-19T12:00:00.000Z');
    await mkdir(dir, { recursive: true });
    await writeFile(
      ledgerPath(dir),
      JSON.stringify({
        entries: [
          // 25h before `now`: outside the 24h window, excluded.
          { atomic: '1000000', at: '2026-07-18T11:00:00.000Z' },
          // 1h before `now`: inside the window, included.
          { atomic: '250000', at: '2026-07-19T11:00:00.000Z' },
        ],
      }),
    );
    expect(await spentInWindow(dir, now)).toBe(250000n);
  });

  it('a missing ledger file sums to zero', async () => {
    expect(await spentInWindow(dir)).toBe(0n);
  });

  it('a corrupt ledger degrades to empty (spend not blocked)', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(ledgerPath(dir), '{ not json');
    expect(await spentInWindow(dir)).toBe(0n);
  });
});

describe('reserveSpend / releaseSpend', () => {
  it('prunes entries older than 24h and appends the new one', async () => {
    const now = new Date('2026-07-19T12:00:00.000Z');
    await mkdir(dir, { recursive: true });
    await writeFile(
      ledgerPath(dir),
      JSON.stringify({
        entries: [
          // 30h before `now`: pruned.
          { atomic: '1000000', at: '2026-07-18T06:00:00.000Z' },
          // 2h before `now`: kept.
          { atomic: '300000', at: '2026-07-19T10:00:00.000Z' },
        ],
      }),
    );
    await reserveSpend(dir, { amountAtomic: '500000', resourceId: 'r1' }, '0', now);
    const raw = JSON.parse(await readFile(ledgerPath(dir), 'utf8')) as {
      entries: Array<{ atomic: string; at: string; resourceId?: string }>;
    };
    expect(raw.entries).toEqual([
      { atomic: '300000', at: '2026-07-19T10:00:00.000Z' },
      { id: expect.any(String), atomic: '500000', at: now.toISOString(), resourceId: 'r1' },
    ]);
  });

  it('a corrupt ledger degrades to empty and the append still lands', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(ledgerPath(dir), '{ not json');
    await reserveSpend(dir, { amountAtomic: '100' }, '0');
    const raw = JSON.parse(await readFile(ledgerPath(dir), 'utf8')) as {
      entries: Array<{ atomic: string }>;
    };
    expect(raw.entries).toEqual([expect.objectContaining({ atomic: '100' })]);
  });

  it('omits resourceId when not given', async () => {
    await reserveSpend(dir, { amountAtomic: '100' }, '0');
    const raw = JSON.parse(await readFile(ledgerPath(dir), 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    expect(raw.entries[0]).not.toHaveProperty('resourceId');
  });

  it('refuses inside the critical section when the budget would be exceeded', async () => {
    await reserveSpend(dir, { amountAtomic: '600000' }, '1000000');
    await expect(reserveSpend(dir, { amountAtomic: '600000' }, '1000000')).rejects.toMatchObject({
      code: 'REFUSED',
      exitCode: 3,
    });
    const raw = JSON.parse(await readFile(ledgerPath(dir), 'utf8')) as { entries: unknown[] };
    expect(raw.entries).toHaveLength(1);
  });

  it('parallel reservations against one budget serialize: only one of two wins', async () => {
    const results = await Promise.allSettled([
      reserveSpend(dir, { amountAtomic: '600000' }, '1000000'),
      reserveSpend(dir, { amountAtomic: '600000' }, '1000000'),
    ]);
    const wins = results.filter((r) => r.status === 'fulfilled');
    expect(wins).toHaveLength(1);
    const raw = JSON.parse(await readFile(ledgerPath(dir), 'utf8')) as { entries: unknown[] };
    expect(raw.entries).toHaveLength(1);
  });

  it('releaseSpend removes exactly the reserved entry', async () => {
    const first = await reserveSpend(dir, { amountAtomic: '100' }, '0');
    await reserveSpend(dir, { amountAtomic: '200' }, '0');
    await releaseSpend(dir, first.id);
    const raw = JSON.parse(await readFile(ledgerPath(dir), 'utf8')) as {
      entries: Array<{ atomic: string }>;
    };
    expect(raw.entries).toEqual([expect.objectContaining({ atomic: '200' })]);
  });
});
