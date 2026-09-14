import { randomUUID } from 'node:crypto';
import { onScopeEnd, withRequestScope } from './context.ts';
import { fromStamp } from './time.ts';
import type { AuditEvent, AuditRecord } from './types.ts';

/**
 * The audit trail.
 *
 * Events are buffered on the request scope and written here in one go when the
 * scope closes, so a request that fails halfway does not leave a half-written
 * trail behind.
 */

const records: AuditRecord[] = [];

onScopeEnd((scope) => {
  for (const event of scope.events) {
    records.push({
      id: `aud_${randomUUID().slice(0, 12)}`,
      requestId: scope.requestId,
      createdAt: fromStamp(scope.startedAtStamp),
      action: event.action,
      accountId: event.accountId,
      detail: event.detail,
    });
  }
  scope.events.length = 0;
});

/** Add one event to the audit trail. */
export function recordAudit(event: AuditEvent): void {
  withRequestScope((scope) => {
    scope.events.push(event);
  });
}

/** Every audit record written so far, oldest first. */
export function readAuditLog(): AuditRecord[] {
  return records.map((record) => ({ ...record, detail: { ...record.detail } }));
}

/** The audit records for one action, oldest first. */
export function readAuditLogFor(action: string): AuditRecord[] {
  return readAuditLog().filter((record) => record.action === action);
}

/** Drop the trail. Tests call this between cases. */
export function clearAuditLog(): void {
  records.length = 0;
}
