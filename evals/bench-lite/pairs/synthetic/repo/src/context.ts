import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { nowStamp } from './time.ts';
import type { AuditEvent } from './types.ts';

/**
 * The request scope.
 *
 * Every unit of work this service does belongs to one: an HTTP request, a
 * job, a CLI invocation. The scope carries the request id that ties log lines
 * and audit rows together, and buffers the audit events the work produced so
 * they are written once, at the end, rather than one row at a time.
 */
export interface RequestScope {
  requestId: string;
  accountId: string | null;
  source: 'http' | 'job' | 'cli';
  startedAtStamp: number;
  events: AuditEvent[];
}

export interface ScopeInit {
  requestId?: string;
  accountId?: string | null;
  source: 'http' | 'job' | 'cli';
}

const storage = new AsyncLocalStorage<RequestScope>();

type ScopeEndHandler = (scope: RequestScope) => void;

let onEnd: ScopeEndHandler = () => {};

/** Register what happens to a scope's buffered events when it closes. */
export function onScopeEnd(handler: ScopeEndHandler): void {
  onEnd = handler;
}

function newScope(init: ScopeInit): RequestScope {
  return {
    requestId: init.requestId ?? `req_${randomUUID().slice(0, 12)}`,
    accountId: init.accountId ?? null,
    source: init.source,
    startedAtStamp: nowStamp(),
    events: [],
  };
}

/**
 * Run `fn` inside a fresh request scope and close the scope afterwards,
 * whether `fn` returned or threw.
 */
export function beginRequest<T>(init: ScopeInit, fn: (scope: RequestScope) => T): T {
  const scope = newScope(init);
  return storage.run(scope, () => {
    let result: T;
    try {
      result = fn(scope);
    } catch (error) {
      onEnd(scope);
      throw error;
    }
    if (result instanceof Promise) {
      return result.then(
        (value: unknown) => {
          onEnd(scope);
          return value;
        },
        (error: unknown) => {
          onEnd(scope);
          throw error;
        },
      ) as T;
    }
    onEnd(scope);
    return result;
  });
}

/** The scope this call is running under, if there is one. */
export function currentScope(): RequestScope | undefined {
  return storage.getStore();
}

/** The scope this call is running under. Throws if there is none. */
export function requireScope(): RequestScope {
  const scope = storage.getStore();
  if (!scope) {
    throw new Error('no request scope');
  }
  return scope;
}

/**
 * Run `fn` with the request scope, for code that wants to read or add to it.
 *
 * ```ts
 * withRequestScope((scope) => {
 *   scope.events.push({ action: 'entry.posted', accountId: scope.accountId, detail: {} });
 * });
 * ```
 */
export function withRequestScope<T>(fn: (scope: RequestScope) => T): T | undefined {
  const scope = storage.getStore();
  if (!scope) {
    return undefined;
  }
  return fn(scope);
}

/** The current request id, or `'-'` for work that is not in a scope. */
export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? '-';
}
