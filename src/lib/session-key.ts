import { webcrypto } from 'node:crypto';
import { sessionPath } from './paths';
import { writeFileAtomic } from './atomic-json';
import { buildSiwxHeader } from './siwx';
import { originOf } from './url';
import {
  isSessionUsable,
  loadSessionFile,
  signWithSession,
  type SessionFile,
  type SessionKeyDeps,
  type SessionScope,
  type SignableRequest,
} from './session-present';
import type { TenjinSigner } from './wallet/provider';

/**
 * Session-key delegation (RFC 9421 signed HTTP, RFC 9530-shaped Content-Digest),
 * verified byte-for-byte against the live "Auth — session keys" contract in
 * https://tenjin.blog/llms-full.txt (D35).
 *
 * The point: a plain SIWX write burns a single-use nonce, so every write needs a
 * fresh WALLET signature. A session key trades that for ONE wallet signature per
 * session: generate a P-256 keypair, wallet-sign a SIWX message binding its
 * pubkey/exp/scope, then sign each subsequent write with the P-256 key (no wallet
 * popup) until the delegation expires. The delegated key is short-lived (≤24h,
 * server-clamped) and cached 0600, address-bound so a wallet change invalidates it.
 *
 * This module is the MINT half — everything that needs a wallet signer, i.e.
 * `establishSession`, the cache writer, and the two `WriteAuth` implementations.
 * The present-only half (load a file, sign one request with it) lives in
 * `session-present.ts` and is re-exported below, so `posts-api`/`publish`/`edit`
 * keep importing one module while `read` can import the present half ALONE and
 * stay structurally unable to open a keystore. Do not move a signer-touching
 * function down into `session-present.ts`: read's import-graph pin is what makes
 * "read cannot mint and cannot pay" a property of the code rather than a promise.
 *
 * A minted delegation is a wallet-derived credential, so it is bound to the
 * ORIGIN it was minted against and every presenter re-checks that binding.
 *
 * Never hand-rolls crypto: P-256 keygen is node:crypto webcrypto (subtle) and the
 * wallet delegation reuses the siwx.ts seam.
 */

export {
  contentDigest,
  isSessionPresentable,
  readSessionFile,
  isSessionUsable,
  keyidFor,
  loadSessionFile,
  scopeSatisfies,
  signatureBase,
  signatureParams,
  signWithSession,
  targetUri,
} from './session-present';
export type {
  SessionFile,
  SessionFileState,
  SessionKeyDeps,
  SessionScope,
  SignableRequest,
  SignatureParamsInput,
} from './session-present';

/**
 * The chain a session delegation is signed over. Writes require Base mainnet per
 * the server's SIWX chain constraint, and a session covers reads and writes
 * alike, so there is exactly ONE session chain id rather than a per-caller
 * choice: `session start` and the write path must mint against the same chain or
 * the file they share would flip between two delegations.
 */
export const SESSION_CHAIN_ID = 'eip155:8453';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h; the server clamps to ≤24h.

/**
 * The write-auth seam a posts client signs through. `headersFor` attaches the
 * signature headers (establishing the session lazily on first use); `recover`
 * reacts to a 401 by returning whether a retry is worthwhile.
 */
export interface WriteAuth {
  headersFor(req: SignableRequest): Promise<Record<string, string>>;
  /** React to a write's 401 `code`; true ⇒ the next headersFor retry may succeed. */
  recover(code: string | undefined): Promise<boolean>;
}

export interface SessionKeyConfig {
  signer: TenjinSigner;
  baseUrl: string;
  chainId: string;
  dataDir: string;
  /**
   * The scope this session is minted at, and the scope a cached session must
   * cover to be reused. Required, not defaulted: over-granting silently is the
   * failure mode worth making impossible, so every caller states what it needs.
   */
  scope: SessionScope;
}

const subtle = webcrypto.subtle;

function generateP256KeyPair(): Promise<webcrypto.CryptoKeyPair> {
  return subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]) as Promise<webcrypto.CryptoKeyPair>;
}

/** base64url (no padding) of raw bytes — the pubkey/keyid encoding. */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** The three URNs bound into the delegation's SIWX `resources` array (D35). */
export function delegationResources(
  publicKeyRaw: string,
  expIso: string,
  scope: SessionScope,
): string[] {
  return [
    `urn:tenjin:session:pubkey:p256:${publicKeyRaw}`,
    `urn:tenjin:session:exp:${expIso}`,
    `urn:tenjin:session:scope:${scope}`,
  ];
}

/**
 * Establish a session with ONE wallet signature: generate a P-256 keypair, bind
 * its pubkey/exp/scope into a SIWX message, wallet-sign it, and cache the result
 * 0600 address-bound. The returned file's `delegation` is the constant
 * `Tenjin-Session-Delegation` header for the session's life.
 */
export async function establishSession(
  config: SessionKeyConfig,
  deps: SessionKeyDeps = {},
): Promise<SessionFile> {
  const now = deps.now ?? Date.now;
  const pair = await generateP256KeyPair();
  const rawPub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const publicKeyRaw = toBase64Url(rawPub);
  const jwk = (await subtle.exportKey('jwk', pair.privateKey)) as SessionFile['privateKeyJwk'];

  const expIso = new Date(now() + SESSION_TTL_MS).toISOString();
  const delegation = await buildSiwxHeader(config.signer, {
    baseUrl: config.baseUrl,
    chainId: config.chainId,
    ttlMs: SESSION_TTL_MS,
    statement: 'Delegate a Tenjin session key.',
    resources: delegationResources(publicKeyRaw, expIso, config.scope),
  });

  const file: SessionFile = {
    address: config.signer.address.toLowerCase(),
    origin: originOf(config.baseUrl),
    delegation,
    exp: expIso,
    scope: config.scope,
    publicKeyRaw,
    privateKeyJwk: jwk,
  };
  await saveSessionFile(config.dataDir, file);
  return file;
}

// ---------------------------------------------------------------------------
// Cache writes (0600, address-bound). The reader lives in session-present.
// ---------------------------------------------------------------------------

export async function saveSessionFile(dir: string, file: SessionFile): Promise<void> {
  await writeFileAtomic(sessionPath(dir), `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

// ---------------------------------------------------------------------------
// The WriteAuth implementation: lazy establish, cache reuse, 401 recovery.
// ---------------------------------------------------------------------------

/** How each 401 `code` maps to recovery (per the llms-full.txt policy section). */
type Recovery = 'resign' | 'reestablish' | 'fatal';

export function recoveryFor(code: string | undefined): Recovery {
  switch (code) {
    case 'proof_expired':
      // The per-request signature is too old; just re-sign (no wallet).
      return 'resign';
    case 'session_expired':
    case 'proof_revoked':
    case 'insufficient_scope':
      // The delegation itself is gone/insufficient; re-establish (one wallet sig).
      return 'reestablish';
    case 'session_key_unbound':
      // keyid ≠ the delegation-bound key: retrying cannot fix it.
      return 'fatal';
    default:
      return 'fatal';
  }
}

/**
 * A session-key WriteAuth: mints (or loads) the delegation on first use and signs
 * every write with the P-256 key — so a returning agent never wallet-signs again
 * until the session expires. On a 401 it re-signs or re-establishes per the code.
 */
export function createSessionKeyAuth(
  config: SessionKeyConfig,
  deps: SessionKeyDeps = {},
): WriteAuth {
  const now = deps.now ?? Date.now;
  let cached: SessionFile | null = null;
  let forceReestablish = false;

  const ensure = async (): Promise<SessionFile> => {
    if (
      !forceReestablish &&
      cached !== null &&
      isSessionUsable(cached, config.signer.address, now(), config.scope, originOf(config.baseUrl))
    ) {
      return cached;
    }
    if (!forceReestablish) {
      const onDisk = await loadSessionFile(config.dataDir);
      const origin = originOf(config.baseUrl);
      if (
        onDisk !== null &&
        isSessionUsable(onDisk, config.signer.address, now(), config.scope, origin)
      ) {
        cached = onDisk;
        return cached;
      }
    }
    cached = await establishSession(config, deps);
    forceReestablish = false;
    return cached;
  };

  return {
    async headersFor(req) {
      const file = await ensure();
      return signWithSession(file, req, deps);
    },
    async recover(code) {
      const recovery = recoveryFor(code);
      if (recovery === 'fatal') return false;
      if (recovery === 'reestablish') {
        cached = null;
        forceReestablish = true;
      }
      // 'resign' needs no state change: the next headersFor mints a fresh
      // created/nonce over the same (still-valid) delegation.
      return true;
    },
  };
}

/**
 * The plain-SIWX fallback (no session): every write carries its own fresh
 * wallet-signed `SIGN-IN-WITH-X` header. Used when session establishment is
 * disabled; a burned/stale nonce (401) is recovered by re-signing.
 */
export function createSiwxAuth(config: SessionKeyConfig): WriteAuth {
  return {
    async headersFor() {
      const header = await buildSiwxHeader(config.signer, {
        baseUrl: config.baseUrl,
        chainId: config.chainId,
      });
      return { 'SIGN-IN-WITH-X': header };
    },
    async recover(code) {
      // A single-use nonce burns on every write; a stale/burned nonce (or an
      // expired proof) is recovered by re-signing with a fresh nonce + issuedAt.
      return code === 'nonce_already_used' || code === 'invalid_proof' || code === 'proof_expired';
    },
  };
}
