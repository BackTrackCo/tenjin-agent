import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAccount,
  listSettingsVersions,
  PLAN_DEFAULTS,
  resolveSettings,
  revertSettings,
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


function accountAtVersionThree() {
  const account = seedAccount('standard');
  updateSettings(account.id, { spendingLimitCents: 1_000 });
  updateSettings(account.id, { notifyEmail: 'ops@example.com' });
  return account;
}

describe('revertSettings', () => {
  it('restores the override set the target version held', () => {
    const account = accountAtVersionThree();
    expect(getAccount(account.id).overrides).toEqual({
      spendingLimitCents: 1_000,
      notifyEmail: 'ops@example.com',
    });

    const settings = revertSettings(account.id, 2);

    expect(getAccount(account.id).overrides).toEqual({ spendingLimitCents: 1_000 });
    expect(settings.notifyEmail).toBe(PLAN_DEFAULTS.standard.notifyEmail);
    expect(settings.spendingLimitCents).toBe(1_000);
    expect(resolveSettings(account.id).notifyEmail).toBe(PLAN_DEFAULTS.standard.notifyEmail);
  });

  it('goes all the way back to an account that overrode nothing', () => {
    const account = accountAtVersionThree();
    const settings = revertSettings(account.id, 1);
    expect(getAccount(account.id).overrides).toEqual({});
    expect(settings).toEqual({ ...PLAN_DEFAULTS.standard, statementDay: 5 });
  });

  it('is itself a new version', () => {
    const account = accountAtVersionThree();
    revertSettings(account.id, 2);

    expect(getAccount(account.id).version).toBe(4);
    const versions = listSettingsVersions(account.id);
    expect(versions.map((version) => version.version)).toEqual([1, 2, 3, 4]);
    expect(versions.at(-1)?.overrides).toEqual({ spendingLimitCents: 1_000 });
  });

  it('leaves the versions it reverted past in place', () => {
    const account = accountAtVersionThree();
    revertSettings(account.id, 1);
    const versions = listSettingsVersions(account.id);
    expect(versions[2]?.overrides).toEqual({
      spendingLimitCents: 1_000,
      notifyEmail: 'ops@example.com',
    });
  });

  it('can be reverted again, forwards', () => {
    const account = accountAtVersionThree();
    revertSettings(account.id, 1);
    const settings = revertSettings(account.id, 3);
    expect(settings.notifyEmail).toBe('ops@example.com');
    expect(getAccount(account.id).overrides).toEqual({
      spendingLimitCents: 1_000,
      notifyEmail: 'ops@example.com',
    });
    expect(getAccount(account.id).version).toBe(5);
  });

  it('refuses a version the account never had', () => {
    const account = accountAtVersionThree();
    expect(codeOf(() => revertSettings(account.id, 9))).toBe('version_not_found');
  });

  it('refuses an unknown account', () => {
    expect(codeOf(() => revertSettings('acc_nope', 1))).toBe('account_not_found');
  });
});

describe('POST /accounts/:accountId/settings/revert', () => {
  it('reverts and reports the version it restored from', () => {
    const account = accountAtVersionThree();
    const response = handleRequest({
      method: 'POST',
      path: `/accounts/${account.id}/settings/revert`,
      body: { toVersion: 2 },
    });

    expect(response.status).toBe(200);
    expect(response.body.restoredFrom).toBe(2);
    expect(response.body.version).toBe(4);
    expect(response.body.settings).toMatchObject({
      spendingLimitCents: 1_000,
      notifyEmail: PLAN_DEFAULTS.standard.notifyEmail,
    });
  });

  it('records the revert', () => {
    const account = accountAtVersionThree();
    handleRequest({
      method: 'POST',
      path: `/accounts/${account.id}/settings/revert`,
      body: { toVersion: 2 },
    });
    const records = readAuditLogFor('settings.reverted');
    expect(records).toHaveLength(1);
    expect(records[0]?.detail).toMatchObject({ from: 3, to: 2, version: 4 });
  });

  it('404s a version that is not there', () => {
    const account = accountAtVersionThree();
    const response = handleRequest({
      method: 'POST',
      path: `/accounts/${account.id}/settings/revert`,
      body: { toVersion: 42 },
    });
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'version_not_found' });
  });

  it('400s a body with no version in it', () => {
    const account = accountAtVersionThree();
    const response = handleRequest({
      method: 'POST',
      path: `/accounts/${account.id}/settings/revert`,
      body: {},
    });
    expect(response.status).toBe(400);
  });
});
