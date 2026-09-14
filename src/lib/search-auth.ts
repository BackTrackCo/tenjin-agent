import { existsSync } from 'node:fs';
import { CliError } from './errors';
import { walletPath } from './paths';
import {
  isSessionPresentable,
  loadSessionFile,
  signWithSession,
  type SignableRequest,
} from './session-present';
import type { WriteAuth } from './session-key';
import { tryOriginOf } from './url';

/**
 * One signing path for every search the CLI and the daemon make.
 *
 * A SHELF SEARCH IS A SIGNED READ. The shelf routes accept the same delegated
 * session key the writes already use, so there is nothing new to log in with
 * and nothing new on disk: `scopeSatisfies` lets a `read+write` delegation
 * serve a `read`, which is why `publish` and `search` share one session file.
 *
 * A CREDENTIAL FAILURE NEVER SILENCES A PUBLIC ANSWER (00-principles.md,
 * principle 4). That is why this returns a verdict rather than throwing: the
 * caller routes on it. `no-wallet` is an ordinary configuration, `signed` goes
 * to the shelf route, and `unauthenticated` falls back to the unsigned public
 * route and writes the reason on the row.
 */

export type SearchAuthResult =
  /** A cached delegation signed it, or a fresh mint did. */
  | { kind: 'signed'; headers: Record<string, string> }
  /** No wallet on this machine at all. Public only, and not an error. */
  | { kind: 'no-wallet' }
  /** A wallet exists and nothing local could sign with it right now. */
  | { kind: 'unauthenticated'; detail: string };

export interface SearchAuthOptions {
  now: () => number;
  env: NodeJS.ProcessEnv;
  /**
   * How to establish a delegation when none is cached, or null for a caller
   * that must never mint (nothing today, but doctor's rule is the same one and
   * this is the seam it would use). A daemon's mint is prompt-free by
   * construction; the CLI's may open the keystore at a TTY, exactly as `read`
   * does.
   */
  mint: null | (() => Promise<WriteAuth>);
}

/** Is there a wallet on this machine at all? The env key counts: it is a
 *  credential `createLocalProvider` will sign with and no file exists for it. */
export function walletFileExists(dataDir: string, env: NodeJS.ProcessEnv): boolean {
  if (typeof env.TENJIN_WALLET_KEY === 'string' && env.TENJIN_WALLET_KEY.length > 0) return true;
  return existsSync(walletPath(dataDir));
}

/**
 * Headers for one signable search request, or the reason there are none.
 *
 * ORDER IS COST: a presentable cached delegation signs with no keystore
 * decryption, so `mint` is not called while one exists. Only then does the
 * wallet question get asked at all.
 */
export async function searchHeaders(
  dataDir: string,
  req: SignableRequest,
  opts: SearchAuthOptions,
): Promise<SearchAuthResult> {
  const origin = tryOriginOf(req.url);
  if (origin === null) {
    return { kind: 'unauthenticated', detail: 'the request URL has no origin to bind to' };
  }
  let cached;
  try {
    cached = await loadSessionFile(dataDir);
  } catch (err) {
    // An unreadable session file is not "no session": re-minting over it would
    // replace a credential that may be perfectly good.
    return { kind: 'unauthenticated', detail: classOf(err) };
  }
  if (cached !== null && isSessionPresentable(cached, opts.now(), 'read', origin)) {
    try {
      return { kind: 'signed', headers: await signWithSession(cached, req, { now: opts.now }) };
    } catch (err) {
      return { kind: 'unauthenticated', detail: classOf(err) };
    }
  }
  if (!walletFileExists(dataDir, opts.env)) return { kind: 'no-wallet' };
  if (opts.mint === null) {
    return { kind: 'unauthenticated', detail: 'no session is cached and this caller cannot mint' };
  }
  try {
    const auth = await opts.mint();
    return { kind: 'signed', headers: await auth.headersFor(req) };
  } catch (err) {
    return { kind: 'unauthenticated', detail: classOf(err) };
  }
}

/** The error CLASS, never its message: this string lands in a ledger column and
 *  in a doctor line, and a keystore error's message can carry a path. */
function classOf(err: unknown): string {
  if (err instanceof CliError) return err.code;
  if (err instanceof Error) return err.name;
  return 'Error';
}
