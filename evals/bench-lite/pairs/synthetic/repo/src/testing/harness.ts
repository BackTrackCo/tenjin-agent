import { createAccount } from '../accounts.ts';
import { clearAuditLog, readAuditLog } from '../audit.ts';
import { resetDb } from '../db/queries.ts';
import type { Account, Plan } from '../types.ts';

/**
 * Test helpers.
 *
 * Nothing in here is imported by the service itself; it exists so a test file
 * is three lines of setup rather than fifteen.
 */

/** Run `fn` with the request scope this test is under. */
export { withRequestScope } from '../context.ts';

/** Empty every table and drop the audit trail. */
export function resetWorld(): void {
  resetDb();
  clearAuditLog();
}

/** An account with a name nothing else uses. */
export function seedAccount(plan: Plan = 'standard', name = 'Test Account'): Account {
  return createAccount({ name, plan });
}

/** Just the action names from the audit trail, oldest first. */
export function auditActions(): string[] {
  return readAuditLog().map((record) => record.action);
}

/** Audit records for one account, oldest first. */
export function auditFor(accountId: string) {
  return readAuditLog().filter((record) => record.accountId === accountId);
}
