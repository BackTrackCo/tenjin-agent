import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeConfig, getConfig, isFlagEnabled, reloadConfig } from '../../src/config.ts';
import { handleRequest } from '../../src/http/handlers.ts';
import { balanceFor, postEntries } from '../../src/ledger.ts';
import { resetWorld, seedAccount } from '../../src/testing/harness.ts';

const KEYS = [
  'LEDGER_MAX_BATCH',
  'LEDGER_CURRENCY',
  'LEDGER_FLAGS',
  'LEDGER_RETENTION_DAYS',
  'LEDGER_STRICT_AMOUNTS',
];

beforeEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }
  reloadConfig();
  resetWorld();
});

afterEach(() => {
  for (const key of KEYS) {
    delete process.env[key];
  }
  reloadConfig();
});

/** The `code` of the LedgerError `fn` throws. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  return 'no-throw';
}

describe('getConfig', () => {
  it('is the production defaults when nothing is set', () => {
    expect(getConfig()).toMatchObject({
      currency: 'USD',
      maxBatchSize: 50,
      retentionDays: 90,
      strictAmounts: false,
    });
    expect([...getConfig().flags]).toEqual([]);
  });
});

describe('reloadConfig', () => {
  it('picks up a value set after the module was loaded', () => {
    process.env.LEDGER_MAX_BATCH = '3';
    const reloaded = reloadConfig();

    expect(reloaded.maxBatchSize).toBe(3);
    expect(getConfig().maxBatchSize).toBe(3);
  });

  it('picks up the currency', () => {
    process.env.LEDGER_CURRENCY = 'EUR';
    reloadConfig();
    expect(getConfig().currency).toBe('EUR');
    expect(describeConfig()).toMatchObject({ currency: 'EUR' });
  });

  it('picks up the flags', () => {
    process.env.LEDGER_FLAGS = 'alpha, beta';
    reloadConfig();

    expect([...getConfig().flags]).toEqual(['alpha', 'beta']);
    expect(isFlagEnabled('alpha')).toBe(true);
    expect(isFlagEnabled('gamma')).toBe(false);
    expect(describeConfig()).toMatchObject({ flags: 'alpha,beta' });
  });

  it('goes back to the defaults when the variable goes away', () => {
    process.env.LEDGER_MAX_BATCH = '3';
    reloadConfig();
    delete process.env.LEDGER_MAX_BATCH;
    reloadConfig();
    expect(getConfig().maxBatchSize).toBe(50);
  });

  it('keeps a bad value from taking the default with it', () => {
    process.env.LEDGER_RETENTION_DAYS = 'soon';
    reloadConfig();
    expect(getConfig().retentionDays).toBe(90);
  });
});

describe('what the reloaded config reaches', () => {
  it('caps a batch at the new size', () => {
    const account = seedAccount('standard');
    process.env.LEDGER_MAX_BATCH = '3';
    reloadConfig();

    const batch = Array.from({ length: 4 }, () => ({
      accountId: account.id,
      amountCents: 100,
      kind: 'debit' as const,
    }));
    expect(codeOf(() => postEntries(batch))).toBe('batch_too_large');
  });

  it('caps a batch on the endpoint too, and says what the cap is', () => {
    const account = seedAccount('standard');
    process.env.LEDGER_MAX_BATCH = '3';
    reloadConfig();

    const response = handleRequest({
      method: 'POST',
      path: '/entries/batch',
      body: {
        entries: Array.from({ length: 4 }, () => ({
          accountId: account.id,
          amountCents: 100,
          kind: 'debit',
        })),
      },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: 'batch_too_large',
      detail: { maxBatchSize: 3 },
    });
  });

  it('still takes a batch that fits', () => {
    const account = seedAccount('standard');
    process.env.LEDGER_MAX_BATCH = '3';
    reloadConfig();

    const entries = postEntries([
      { accountId: account.id, amountCents: 100, kind: 'debit' },
      { accountId: account.id, amountCents: 200, kind: 'credit' },
    ]);
    expect(entries).toHaveLength(2);
  });

  it('denominates the balance in the new currency', () => {
    const account = seedAccount('standard');
    process.env.LEDGER_CURRENCY = 'EUR';
    reloadConfig();
    expect(balanceFor(account.id).currency).toBe('EUR');
  });

  it('serves the new config on the health endpoint', () => {
    process.env.LEDGER_CURRENCY = 'EUR';
    process.env.LEDGER_MAX_BATCH = '7';
    reloadConfig();

    const response = handleRequest({ method: 'GET', path: '/healthz' });
    expect(response.body.config).toMatchObject({ currency: 'EUR', maxBatchSize: 7 });
  });
});
