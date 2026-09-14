import {
  createAccount,
  getAccount,
  isPlan,
  listAccounts,
  resolveSettings,
  updateSettings,
} from '../accounts.ts';
import { config, describeConfig } from '../config.ts';
import { beginRequest } from '../context.ts';
import { badRequest, isLedgerError, notFound } from '../errors.ts';
import { balanceFor, listEntries, postEntries, postEntry } from '../ledger.ts';
import { matchRoute } from './router.ts';
import type { Account, Entry, EntryKind } from '../types.ts';

/** Largest batch this process will take, read once at boot. */
const MAX_BATCH = config.maxBatchSize;

export interface LedgerRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface LedgerResponse {
  status: number;
  body: Record<string, unknown>;
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('invalid_body', 'body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest('invalid_field', `${field} must be a non-empty string`);
  }
  return value;
}

function requireNumber(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== 'number') {
    throw badRequest('invalid_field', `${field} must be a number`);
  }
  return value;
}

function requireKind(body: Record<string, unknown>): EntryKind {
  const value = body.kind;
  if (value !== 'debit' && value !== 'credit') {
    throw badRequest('invalid_field', 'kind must be "debit" or "credit"');
  }
  return value;
}

export function serialiseAccount(account: Account): Record<string, unknown> {
  return {
    id: account.id,
    name: account.name,
    plan: account.plan,
    version: account.version,
    overrides: account.overrides,
    createdAt: account.createdAt.toISOString(),
  };
}

export function serialiseEntry(entry: Entry): Record<string, unknown> {
  return {
    id: entry.id,
    accountId: entry.accountId,
    amountCents: entry.amountCents,
    kind: entry.kind,
    memo: entry.memo,
    feeCents: entry.feeCents,
    idempotencyKey: entry.idempotencyKey,
    createdAt: entry.createdAt.toISOString(),
  };
}

function handleMatched(
  name: string,
  params: Record<string, string>,
  request: LedgerRequest,
): LedgerResponse {
  switch (name) {
    case 'health.get': {
      return { status: 200, body: { ok: true, config: describeConfig() } };
    }

    case 'accounts.create': {
      const body = asObject(request.body);
      const plan = requireString(body, 'plan');
      if (!isPlan(plan)) {
        throw badRequest('invalid_plan', `unknown plan: ${plan}`);
      }
      const account = createAccount({
        name: requireString(body, 'name'),
        plan,
        overrides: (body.overrides as Account['overrides'] | undefined) ?? {},
      });
      return { status: 201, body: { account: serialiseAccount(account) } };
    }

    case 'accounts.list': {
      return { status: 200, body: { accounts: listAccounts().map(serialiseAccount) } };
    }

    case 'accounts.get': {
      return {
        status: 200,
        body: { account: serialiseAccount(getAccount(params.accountId ?? '')) },
      };
    }

    case 'settings.get': {
      const accountId = params.accountId ?? '';
      const account = getAccount(accountId);
      return {
        status: 200,
        body: {
          settings: resolveSettings(accountId),
          overrides: account.overrides,
          version: account.version,
        },
      };
    }

    case 'settings.patch': {
      const accountId = params.accountId ?? '';
      const body = asObject(request.body);
      const settings = updateSettings(accountId, body);
      return {
        status: 200,
        body: { settings, version: getAccount(accountId).version },
      };
    }

    case 'entries.create': {
      const body = asObject(request.body);
      const headerKey = request.headers?.['idempotency-key'] ?? null;
      const entry = postEntry({
        accountId: requireString(body, 'accountId'),
        amountCents: requireNumber(body, 'amountCents'),
        kind: requireKind(body),
        memo: typeof body.memo === 'string' ? body.memo : '',
        idempotencyKey: headerKey,
      });
      return { status: 201, body: { entry: serialiseEntry(entry) } };
    }

    case 'entries.batch': {
      const body = asObject(request.body);
      const entries = body.entries;
      if (!Array.isArray(entries)) {
        throw badRequest('invalid_field', 'entries must be an array');
      }
      if (entries.length > MAX_BATCH) {
        throw badRequest('batch_too_large', `a batch may hold at most ${MAX_BATCH} entries`, {
          maxBatchSize: MAX_BATCH,
        });
      }
      const posted = postEntries(
        entries.map((raw) => {
          const item = asObject(raw);
          return {
            accountId: requireString(item, 'accountId'),
            amountCents: requireNumber(item, 'amountCents'),
            kind: requireKind(item),
            memo: typeof item.memo === 'string' ? item.memo : '',
          };
        }),
      );
      return { status: 201, body: { entries: posted.map(serialiseEntry), count: posted.length } };
    }

    case 'entries.list': {
      const accountId = params.accountId ?? '';
      return {
        status: 200,
        body: { entries: listEntries(accountId).map(serialiseEntry) },
      };
    }

    case 'balance.get': {
      return { status: 200, body: { balance: balanceFor(params.accountId ?? '') } };
    }

    default: {
      throw notFound('no_route', `no handler for ${name}`);
    }
  }
}

/** Take one request, return one response. Every request gets its own scope. */
export function handleRequest(request: LedgerRequest): LedgerResponse {
  const match = matchRoute(request.method, request.path);
  if (!match) {
    return {
      status: 404,
      body: { error: { code: 'no_route', message: `${request.method} ${request.path}` } },
    };
  }

  return beginRequest(
    { source: 'http', accountId: match.params.accountId ?? null },
    (scope): LedgerResponse => {
      try {
        const response = handleMatched(match.route.name, match.params, request);
        return {
          status: response.status,
          body: { ...response.body, requestId: scope.requestId },
        };
      } catch (error) {
        if (isLedgerError(error)) {
          return {
            status: error.status,
            body: {
              error: { code: error.code, message: error.message, detail: error.detail ?? null },
              requestId: scope.requestId,
            },
          };
        }
        throw error;
      }
    },
  );
}
