import { beforeEach, describe, expect, it } from 'vitest';
import {
  createAccount,
  getAccount,
  listSettingsVersions,
  PLAN_DEFAULTS,
  resolveSettings,
  updateSettings,
} from '../src/accounts.ts';
import { resetWorld, seedAccount } from '../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
});

describe('createAccount', () => {
  it('starts at version 1 with no overrides', () => {
    const account = createAccount({ name: 'Acme', plan: 'starter' });
    expect(account.version).toBe(1);
    expect(account.overrides).toEqual({});
    expect(account.id).toMatch(/^acc_[0-9a-f]{10}$/);
  });

  it('refuses an empty name', () => {
    expect(() => createAccount({ name: '  ', plan: 'starter' })).toThrow(/name/);
  });
});

describe('resolveSettings', () => {
  it('is the plan default under the org layer', () => {
    const account = seedAccount('standard');
    expect(resolveSettings(account.id)).toEqual({
      ...PLAN_DEFAULTS.standard,
      statementDay: 5,
    });
  });

  it('lets the account override the org layer', () => {
    const account = createAccount({ name: 'Acme', plan: 'scale', overrides: { statementDay: 20 } });
    expect(resolveSettings(account.id).statementDay).toBe(20);
  });

  it('is unknown-account-safe', () => {
    expect(() => resolveSettings('acc_nope')).toThrow(/no such account/);
  });
});

describe('updateSettings', () => {
  it('sets an override and bumps the version', () => {
    const account = seedAccount('standard');
    const settings = updateSettings(account.id, { spendingLimitCents: 1000 });
    expect(settings.spendingLimitCents).toBe(1000);
    expect(getAccount(account.id).version).toBe(2);
  });

  it('keeps the untouched fields', () => {
    const account = seedAccount('standard');
    updateSettings(account.id, { spendingLimitCents: 1000 });
    const settings = updateSettings(account.id, { autoSettle: false });
    expect(settings).toEqual({
      spendingLimitCents: 1000,
      autoSettle: false,
      notifyEmail: null,
      statementDay: 5,
    });
  });

  it('writes one settings version per accepted write', () => {
    const account = seedAccount('standard');
    updateSettings(account.id, { spendingLimitCents: 1000 });
    updateSettings(account.id, { notifyEmail: 'ops@example.com' });
    const versions = listSettingsVersions(account.id);
    expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
    expect(versions.at(-1)?.overrides).toEqual({
      spendingLimitCents: 1000,
      notifyEmail: 'ops@example.com',
    });
  });

  it('refuses a statement day outside the month', () => {
    const account = seedAccount('standard');
    expect(() => updateSettings(account.id, { statementDay: 31 })).toThrow(/statementDay/);
  });

  it('refuses a limit that is not a whole number of cents', () => {
    const account = seedAccount('standard');
    expect(() => updateSettings(account.id, { spendingLimitCents: 12.5 })).toThrow(/integer/);
  });
});
