import { LockTimeoutError, withFileLock } from '../../lib/lock';
import { sourceVaultPath } from '../../lib/paths';
import {
  readVault,
  rewriteVault,
  type VaultDeps,
  type VaultHeader,
  type VaultSecret,
} from './vault';

/**
 * THE CREDENTIAL A CALL ON A CONNECTED ACCOUNT SENDS, fresh (decided37 #16).
 * A pasted key is sent as its scheme says (`Bearer <key>`, fal's
 * `Key <id>:<secret>`); a sign-in's access token as `Bearer`, refreshed first
 * when it is within {@link REFRESH_SKEW_MS} of expiring, or when the account
 * just refused it.
 *
 * A REFRESH IS ONE AT A TIME, ACROSS PROCESSES. Firecrawl's refresh tokens
 * work once, and every `tenjin mcp` a session starts can call the same
 * account, so a refresh runs under a lock beside the vault (`<id>.json.lock`,
 * the mkdir lock the config writer uses) and reads the vault again inside it:
 * a token another process, or another call in this one, already rotated is
 * used as it is, never refreshed a second time. Waiting for the lock and the
 * token request are both bounded, and a refusal never leaves the lock behind.
 *
 * A REFRESH THE AUTHORIZATION SERVER REFUSES marks the vault `expired`, so
 * every later call refuses at once with the reconnect step and sends nothing;
 * one that could not reach it changes nothing. Nothing here opens a browser:
 * only `tenjin connect` signs in.
 */

/** Why a call on an account did not run, or did not finish. */
export type RefusalReason =
  /** No sign-in for this account on this machine. */
  | 'not_connected'
  /** The sign-in or key was refused, or can no longer be read: reconnect. */
  | 'signin_expired'
  /** The OS store that holds the vault's key did not answer. */
  | 'store_locked'
  /** The account's plan or credit ran out. */
  | 'credit'
  /** The account's rate limit. */
  | 'rate_limited'
  /** Another process held the refresh past the wait. */
  | 'busy'
  /** The account's server, or its sign-in server, could not be reached. */
  | 'unreachable';

export class AccountRefusal extends Error {
  constructor(
    readonly reason: RefusalReason,
    /** A bounded line of what the other side said, or a path to act on. */
    readonly detail?: string,
  ) {
    super(`the account refused the call (${reason})`);
    this.name = 'AccountRefusal';
  }
}

export interface CredentialDeps extends VaultDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long a refresh waits for another process's. */
  lockTimeoutMs?: number;
  /** The token request's own deadline. */
  requestTimeoutMs?: number;
}

export interface AccountCredential {
  kind: 'oauth' | 'key';
  /** The request headers that carry it: `authorization` alone. */
  headers: Record<string, string>;
  /** What was sent, so a refusal can name the one it refused. */
  sent: string;
}

/** A token this close to its expiry is refreshed before it is sent. */
export const REFRESH_SKEW_MS = 60_000;
const LOCK_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** What the authorization server says when a refresh can never work again. */
const DEAD_GRANT = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

const tokenOf = (secret: VaultSecret, field: 'access_token' | 'refresh_token') => {
  const value = secret.tokens?.[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

function expiring(header: VaultHeader, now: number): boolean {
  if (header.expiresAt === undefined) return false;
  const at = Date.parse(header.expiresAt);
  return !Number.isFinite(at) || at - now <= REFRESH_SKEW_MS;
}

function bearer(token: string): AccountCredential {
  return { kind: 'oauth', headers: { authorization: `Bearer ${token}` }, sent: token };
}

/** One line of what the other side said, bounded. */
function said(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function read(id: string, label: string, deps: CredentialDeps) {
  try {
    return await readVault(id, label, deps);
  } catch (err) {
    throw new AccountRefusal('store_locked', said(err));
  }
}

/**
 * The credential for account `id`, refreshed where it must be. `refused` is
 * the credential the account just answered 401 to: it is never sent again.
 */
export async function accountCredential(
  id: string,
  label: string,
  deps: CredentialDeps,
  opts: { refused?: string } = {},
): Promise<AccountCredential> {
  const now = deps.now?.() ?? Date.now();
  const vault = await read(id, label, deps);
  if (vault.status === 'absent') throw new AccountRefusal('not_connected');
  if (vault.status === 'unreadable' || vault.header.state === 'expired')
    throw new AccountRefusal('signin_expired');
  const { header, secret } = vault;
  if (header.kind === 'key') {
    const key = secret.apiKey;
    // A key the account refused stays refused: only the user has a new one.
    if (key === undefined || key === opts.refused) throw new AccountRefusal('signin_expired');
    return {
      kind: 'key',
      headers: { authorization: `${secret.keyScheme ?? 'Bearer'} ${key}` },
      sent: key,
    };
  }
  const token = tokenOf(secret, 'access_token');
  if (token !== undefined && token !== opts.refused && !expiring(header, now)) return bearer(token);
  return refreshUnderLock(id, label, deps, token, opts.refused);
}

/**
 * THE REFRESH ITSELF, under the cross-process lock. `stale` is the token this
 * process meant to replace: a vault that holds another, still fresh, was
 * rotated by someone else while this one waited.
 */
async function refreshUnderLock(
  id: string,
  label: string,
  deps: CredentialDeps,
  stale: string | undefined,
  refused: string | undefined,
): Promise<AccountCredential> {
  const lock = `${sourceVaultPath(id, deps.dataDir)}.lock`;
  try {
    return await withFileLock(
      lock,
      async () => {
        const now = deps.now?.() ?? Date.now();
        const vault = await read(id, label, deps);
        if (vault.status === 'absent') throw new AccountRefusal('not_connected');
        if (vault.status === 'unreadable' || vault.header.state === 'expired')
          throw new AccountRefusal('signin_expired');
        const { header, secret } = vault;
        const current = tokenOf(secret, 'access_token');
        if (
          current !== undefined &&
          current !== stale &&
          current !== refused &&
          !expiring(header, now)
        )
          return bearer(current);
        return refreshed(id, label, header, secret, deps, now);
      },
      { timeoutMs: deps.lockTimeoutMs ?? LOCK_TIMEOUT_MS },
    );
  } catch (err) {
    if (err instanceof LockTimeoutError) throw new AccountRefusal('busy', err.lockPath);
    throw err;
  }
}

async function refreshed(
  id: string,
  label: string,
  header: VaultHeader,
  secret: VaultSecret,
  deps: CredentialDeps,
  now: number,
): Promise<AccountCredential> {
  const expire = async (): Promise<never> => {
    // Best effort: the refusal stands whether or not the mark is written.
    await rewriteVault(id, label, { ...header, state: 'expired' }, secret, deps).catch(
      () => undefined,
    );
    throw new AccountRefusal('signin_expired');
  };
  const refreshToken = tokenOf(secret, 'refresh_token');
  const discovery = secret.discoveryState ?? {};
  const serverUrl = discovery.authorizationServerUrl;
  const client = secret.clientInformation;
  if (refreshToken === undefined || typeof serverUrl !== 'string' || client === undefined)
    return expire();
  const resource = (discovery.resourceMetadata as { resource?: unknown } | undefined)?.resource;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeout = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const sdk = await import('@modelcontextprotocol/sdk/client/auth.js');
  let tokens: Record<string, unknown>;
  try {
    tokens = (await sdk.refreshAuthorization(serverUrl, {
      ...(discovery.authorizationServerMetadata !== undefined
        ? {
            metadata: discovery.authorizationServerMetadata as Parameters<
              typeof sdk.refreshAuthorization
            >[1]['metadata'],
          }
        : {}),
      clientInformation: client as Parameters<
        typeof sdk.refreshAuthorization
      >[1]['clientInformation'],
      refreshToken,
      ...(typeof resource === 'string' ? { resource } : {}),
      fetchFn: (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeout) }),
    })) as Record<string, unknown>;
  } catch (err) {
    const code = (err as { errorCode?: unknown } | null)?.errorCode;
    if (typeof code === 'string' && DEAD_GRANT.has(code)) return expire();
    throw new AccountRefusal('unreachable', said(err));
  }
  const access = typeof tokens.access_token === 'string' ? tokens.access_token : undefined;
  if (access === undefined || access.length === 0) return expire();
  const expiresIn = tokens.expires_in;
  const expiresAt =
    typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(now + expiresIn * 1_000).toISOString()
      : undefined;
  // The issuer the sign-in recorded stays with the tokens: a later refresh
  // goes back to the server that issued them, and only there.
  const issuer = secret.tokens?.issuer;
  const rest: Omit<VaultHeader, 'expiresAt'> & { expiresAt?: string } = { ...header };
  delete rest.expiresAt;
  await rewriteVault(
    id,
    label,
    { ...rest, ...(expiresAt !== undefined ? { expiresAt } : {}), state: 'ok' },
    {
      ...secret,
      tokens: { ...tokens, ...(issuer !== undefined ? { issuer } : {}) },
      obtainedAt: now,
    },
    deps,
  );
  return bearer(access);
}
