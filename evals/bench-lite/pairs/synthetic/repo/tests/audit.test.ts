import { beforeEach, describe, expect, it } from 'vitest';
import { readAuditLog, readAuditLogFor, recordAudit } from '../src/audit.ts';
import { beginRequest } from '../src/context.ts';
import { handleRequest } from '../src/http/handlers.ts';
import { auditActions, resetWorld, seedAccount } from '../src/testing/harness.ts';

beforeEach(() => {
  resetWorld();
});

describe('the audit trail', () => {
  it('holds what a request did, under that request id', () => {
    const response = handleRequest({
      method: 'POST',
      path: '/accounts',
      body: { name: 'Acme', plan: 'starter' },
    });
    const records = readAuditLogFor('account.created');
    expect(records).toHaveLength(1);
    expect(records[0]?.requestId).toBe(response.body.requestId);
    expect(records[0]?.detail).toMatchObject({ plan: 'starter', name: 'Acme' });
  });

  it('holds one row per event, in order', () => {
    const created = handleRequest({
      method: 'POST',
      path: '/accounts',
      body: { name: 'Acme', plan: 'standard' },
    });
    const account = created.body.account as { id: string };
    handleRequest({
      method: 'POST',
      path: '/entries',
      body: { accountId: account.id, amountCents: 100, kind: 'debit' },
    });
    expect(auditActions()).toEqual(['account.created', 'entry.posted']);
  });

  it('writes the events a job scope buffered', () => {
    beginRequest({ source: 'job', accountId: 'acc_1' }, () => {
      recordAudit({ action: 'job.ran', accountId: 'acc_1', detail: { ok: true } });
    });
    expect(auditActions()).toEqual(['job.ran']);
  });

  it('carries one request id across every event in the scope', () => {
    beginRequest({ source: 'cli', accountId: null }, () => {
      recordAudit({ action: 'one', accountId: null, detail: {} });
      recordAudit({ action: 'two', accountId: null, detail: {} });
    });
    const records = readAuditLog();
    expect(records).toHaveLength(2);
    expect(records[0]?.requestId).toBe(records[1]?.requestId);
  });

  it('writes nothing for a request that never got that far', () => {
    handleRequest({ method: 'GET', path: '/accounts/acc_nope' });
    expect(readAuditLog()).toHaveLength(0);
  });
});
