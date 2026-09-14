import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSettingsOverrides,
  getAccount,
  listSettingsVersions,
  PLAN_DEFAULTS,
  resolveSettings,
  updateSettings,
} from '../../src/accounts.ts';
import { readAuditLogFor } from '../../src/audit.ts';
import { handleRequest } from '../../src/http/handlers.ts';
import { resetWorld, seedAccount } from '../../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
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


describe('clearSettingsOverrides', () => {
  it('puts the field back on the plan default', () => {
    const account = seedAccount('standard');
    updateSettings(account.id, { spendingLimitCents: 1_000 });
    expect(resolveSettings(account.id).spendingLimitCents).toBe(1_000);

    const settings = clearSettingsOverrides(account.id, ['spendingLimitCents']);
    expect(settings.spendingLimitCents).toBe(PLAN_DEFAULTS.standard.spendingLimitCents);
    expect(resolveSettings(account.id).spendingLimitCents).toBe(
      PLAN_DEFAULTS.standard.spendingLimitCents,
    );
  });

  it('takes the override off the account', () => {
    const account = seedAccount('standard');
    updateSettings(account.id, { spendingLimitCents: 1_000, autoSettle: false });
    clearSettingsOverrides(account.id, ['spendingLimitCents']);
    expect(getAccount(account.id).overrides).toEqual({ autoSettle: false });
  });

  it('writes exactly one new version, holding the overrides that are left', () => {
    const account = seedAccount('standard');
    updateSettings(account.id, { spendingLimitCents: 1_000, autoSettle: false });
    expect(getAccount(account.id).version).toBe(2);

    clearSettingsOverrides(account.id, ['spendingLimitCents']);
    expect(getAccount(account.id).version).toBe(3);

    const versions = listSettingsVersions(account.id);
    expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
    expect(versions.at(-1)?.overrides).toEqual({ autoSettle: false });
  });

  it('clears several fields in one write', () => {
    const account = seedAccount('scale');
    updateSettings(account.id, {
      spendingLimitCents: 1_000,
      autoSettle: false,
      statementDay: 9,
    });
    const settings = clearSettingsOverrides(account.id, ['autoSettle', 'statementDay']);
    expect(getAccount(account.id).overrides).toEqual({ spendingLimitCents: 1_000 });
    expect(getAccount(account.id).version).toBe(3);
    expect(settings.autoSettle).toBe(PLAN_DEFAULTS.scale.autoSettle);
    expect(settings.statementDay).toBe(5);
  });

  it('is fine with a field that was never overridden', () => {
    const account = seedAccount('standard');
    expect(() => clearSettingsOverrides(account.id, ['notifyEmail'])).not.toThrow();
    expect(getAccount(account.id).overrides).toEqual({});
  });

  it('refuses a field that is not a setting', () => {
    const account = seedAccount('standard');
    expect(codeOf(() => clearSettingsOverrides(account.id, ['spendingLimitCent']))).toBe(
      'invalid_field',
    );
  });

  it('refuses an unknown account', () => {
    expect(codeOf(() => clearSettingsOverrides('acc_nope', ['autoSettle']))).toBe(
      'account_not_found',
    );
  });
});

describe('PATCH /accounts/:accountId/settings', () => {
  it('resets what the reset list names', () => {
    const account = seedAccount('standard');
    updateSettings(account.id, { spendingLimitCents: 1_000 });

    const response = handleRequest({
      method: 'PATCH',
      path: `/accounts/${account.id}/settings`,
      body: { reset: ['spendingLimitCents'] },
    });

    expect(response.status).toBe(200);
    expect(response.body.cleared).toEqual(['spendingLimitCents']);
    expect(response.body.settings).toMatchObject({
      spendingLimitCents: PLAN_DEFAULTS.standard.spendingLimitCents,
    });
    expect(response.body.version).toBe(3);
  });

  it('sets and resets in one call, for one version bump', () => {
    const account = seedAccount('standard');
    updateSettings(account.id, { spendingLimitCents: 1_000 });

    const response = handleRequest({
      method: 'PATCH',
      path: `/accounts/${account.id}/settings`,
      body: { set: { statementDay: 9 }, reset: ['spendingLimitCents'] },
    });

    expect(response.status).toBe(200);
    expect(response.body.version).toBe(3);
    expect(response.body.settings).toMatchObject({
      statementDay: 9,
      spendingLimitCents: PLAN_DEFAULTS.standard.spendingLimitCents,
    });
    expect(getAccount(account.id).overrides).toEqual({ statementDay: 9 });
  });

  it('reports an empty cleared list when nothing was overridden', () => {
    const account = seedAccount('standard');
    const response = handleRequest({
      method: 'PATCH',
      path: `/accounts/${account.id}/settings`,
      body: { reset: ['notifyEmail'] },
    });
    expect(response.status).toBe(200);
    expect(response.body.cleared).toEqual([]);
  });

  it('records what it cleared', () => {
    const account = seedAccount('standard');
    updateSettings(account.id, { spendingLimitCents: 1_000, autoSettle: false });
    handleRequest({
      method: 'PATCH',
      path: `/accounts/${account.id}/settings`,
      body: { reset: ['autoSettle', 'spendingLimitCents'] },
    });
    const records = readAuditLogFor('settings.cleared');
    expect(records).toHaveLength(1);
    expect(records[0]?.detail).toMatchObject({
      version: 3,
      fields: 'autoSettle,spendingLimitCents',
    });
  });

  it('still takes a plain override body', () => {
    const account = seedAccount('standard');
    const response = handleRequest({
      method: 'PATCH',
      path: `/accounts/${account.id}/settings`,
      body: { spendingLimitCents: 4_000 },
    });
    expect(response.status).toBe(200);
    expect(response.body.settings).toMatchObject({ spendingLimitCents: 4_000 });
    expect(response.body.version).toBe(2);
  });
});
