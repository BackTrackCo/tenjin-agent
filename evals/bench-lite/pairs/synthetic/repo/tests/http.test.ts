import { beforeEach, describe, expect, it } from 'vitest';
import { handleRequest } from '../src/http/handlers.ts';
import { matchRoute } from '../src/http/router.ts';
import { resetWorld, seedAccount } from '../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return handleRequest({ method: 'POST', path, body, headers });
}

describe('matchRoute', () => {
  it('pulls the account id out of the path', () => {
    const match = matchRoute('GET', '/accounts/acc_123/balance');
    expect(match?.route.name).toBe('balance.get');
    expect(match?.params.accountId).toBe('acc_123');
  });

  it('does not match a different method', () => {
    expect(matchRoute('DELETE', '/accounts')).toBeUndefined();
  });
});

describe('handleRequest', () => {
  it('creates an account', () => {
    const response = post('/accounts', { name: 'Acme', plan: 'scale' });
    expect(response.status).toBe(201);
    expect(response.body.account).toMatchObject({ name: 'Acme', plan: 'scale', version: 1 });
    expect(String(response.body.requestId)).toMatch(/^req_/);
  });

  it('404s an unknown path', () => {
    const response = handleRequest({ method: 'GET', path: '/nope' });
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'no_route' });
  });

  it('maps a domain error onto its status', () => {
    const response = handleRequest({ method: 'GET', path: '/accounts/acc_nope' });
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'account_not_found' });
  });

  it('posts an entry and reads the balance back', () => {
    const account = seedAccount('starter');
    const posted = post('/entries', {
      accountId: account.id,
      amountCents: 2_000,
      kind: 'credit',
      memo: 'top up',
    });
    expect(posted.status).toBe(201);
    expect(posted.body.entry).toMatchObject({ amountCents: 2_000, feeCents: 10 });

    const balance = handleRequest({ method: 'GET', path: `/accounts/${account.id}/balance` });
    expect(balance.body.balance).toMatchObject({ balanceCents: 1_990, entryCount: 1 });
  });

  it('honours an Idempotency-Key header', () => {
    const account = seedAccount('standard');
    const body = { accountId: account.id, amountCents: 700, kind: 'debit' };
    const first = post('/entries', body, { 'idempotency-key': 'abc' });
    const second = post('/entries', body, { 'idempotency-key': 'abc' });
    expect(second.body.entry).toMatchObject({
      id: (first.body.entry as { id: string }).id,
    });
  });

  it('patches settings and reports the new version', () => {
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

  it('reports the batch limit in the error detail', () => {
    const account = seedAccount('standard');
    const entries = Array.from({ length: 60 }, () => ({
      accountId: account.id,
      amountCents: 1,
      kind: 'debit',
    }));
    const response = post('/entries/batch', { entries });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'batch_too_large' });
  });

  it('serves health with the effective config', () => {
    const response = handleRequest({ method: 'GET', path: '/healthz' });
    expect(response.status).toBe(200);
    expect(response.body.config).toMatchObject({ currency: 'USD' });
  });
});
