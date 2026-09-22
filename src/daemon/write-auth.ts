import type { WriteAuth } from '../lib/session-key';
import { tryOriginOf } from '../lib/url';

/**
 * The daemon's ONE delegation, and the two facts that make it stale.
 *
 * A daemon outlives every session on the machine, and minting is expensive and
 * prompt-free by construction (it decrypts the keystore with no TTY), so the
 * `WriteAuth` is built once and reused. That is right until the thing it was
 * built FOR changes. `createSessionKeyAuth` closes over the `baseUrl` it was
 * handed: the origin is baked into the delegation at mint time and no later
 * read of `config.json` reaches it. So a daemon that swapped `config` on an
 * mtime change would go on signing for the old origin for the rest of its
 * life, and the new one would answer 401 to every hook search. Re-minting at
 * the terminal does not help, because the daemon never re-reads the file into
 * the credential it already holds.
 *
 * Two triggers, and they are different:
 *
 *   - THE ORIGIN CHANGED. Checked at the point of use rather than at the
 *     reload, because this is the only place the cached credential is handed
 *     out: a config read that never reaches a fire needs no mint, and a fire
 *     that arrives before the next reload still gets the origin the file says.
 *     Origins are compared, not base URLs, because the origin is what the
 *     delegation binds to; a trailing slash is not a new credential.
 *
 *   - THE ORIGIN REFUSED IT. A 401 on a signed shelf call means the delegation
 *     was read and rejected, which a fresh one may fix (an expired session, a
 *     rotated key) or may not (this wallet is not a member). ONE re-mint per
 *     origin settles which: the first 401 drops the credential, the next fire
 *     mints, and a second 401 for the same origin is believed. Without that
 *     bound a permanently refused shelf would decrypt the keystore on every
 *     fire, forever, for an answer that never changes.
 *
 *     THE REFUSAL CARRIES ITS OWN ORIGIN, because fires overlap a reload. A
 *     request sent to the old origin can answer 401 after a later fire has
 *     already minted for the new one, and a `refused` that read the live config
 *     would drop that fresh credential and spend the NEW origin's one allowance
 *     on a refusal that said nothing about it. The next genuine 401 would then
 *     be believed, and hook searches would fail until the daemon restarted.
 */
export interface WriteAuthCacheDeps {
  /** The live config read, so a reload is visible to the next mint. */
  baseUrl: () => string;
  /** Build a delegation for this base URL. Called only when the cache is empty. */
  mint: (baseUrl: string) => Promise<WriteAuth>;
  log: (line: string) => void;
}

export interface WriteAuthCache {
  /** The `mint` seam `searchHeaders` takes: the cached delegation, or a new one. */
  get: () => Promise<WriteAuth>;
  /**
   * `Deps.authRefused`: a signed shelf call answered 401, carrying the origin
   * that request was actually SENT to. A refusal from anywhere but the origin
   * the cached credential was minted for is ignored.
   */
  refused: (origin: string | null) => void;
}

export function createWriteAuthCache(deps: WriteAuthCacheDeps): WriteAuthCache {
  let auth: WriteAuth | null = null;
  /** The origin `auth` was minted for, never re-derived from the live config. */
  let mintedFor: string | null = null;
  /** The origin whose 401 has already been paid for with one re-mint. */
  let refusedFor: string | null = null;

  return {
    async get(): Promise<WriteAuth> {
      const baseUrl = deps.baseUrl();
      const origin = tryOriginOf(baseUrl);
      if (auth !== null && mintedFor === origin) return auth;
      if (auth !== null) {
        deps.log(
          `write auth: origin changed ${String(mintedFor)} -> ${String(origin)}, re-minting`,
        );
      }
      // ASSIGNED BEFORE THE AWAIT RESOLVES IS WRONG, and assigned after it is
      // what happens: a mint that throws (a locked keystore) must leave the
      // cache empty so the next fire tries again, rather than pinning a null
      // credential to the new origin.
      const minted = await deps.mint(baseUrl);
      auth = minted;
      mintedFor = origin;
      return minted;
    },

    refused(origin: string | null): void {
      // Nothing cached is nothing to drop, and a second 401 for an origin we
      // have already re-minted against is the server's answer, not a stale
      // credential.
      if (auth === null || refusedFor === origin) return;
      // THE REFUSED REQUEST'S ORIGIN AGAINST THE CREDENTIAL'S, never against
      // the live config: an in-flight request from before a reload is the one
      // case where those differ, and believing it would drop a credential the
      // refusing origin never saw and spend an allowance it never earned.
      if (origin !== mintedFor) {
        deps.log(
          `write auth: ignoring a 401 from ${String(origin)}; the delegation held is for ${String(mintedFor)}`,
        );
        return;
      }
      refusedFor = origin;
      auth = null;
      mintedFor = null;
      deps.log(`write auth: ${String(origin)} answered 401, dropped; the next fire re-mints once`);
    },
  };
}
