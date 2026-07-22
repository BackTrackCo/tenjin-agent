import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CliError } from './errors';
import { sessionPath } from './paths';
import { writeFileAtomic } from './atomic-json';
import { buildSiwxHeader } from './siwx';
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
 * Never hand-rolls crypto: P-256 keygen/sign is node:crypto webcrypto (subtle),
 * SHA-256 is node:crypto, and the wallet delegation reuses the siwx.ts seam.
 */

const SESSION_SCOPE = 'read+write';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h; the server clamps to ≤24h.
/** Re-establish this long before `exp` so a signed request cannot expire in flight. */
const EXP_SKEW_MS = 60_000;

/** The persisted session: the wallet-signed delegation plus the P-256 key material. */
const SessionFileSchema = z.object({
  /** Lowercased wallet address this delegation is bound to. */
  address: z.string(),
  /** The constant base64 SIWX `Tenjin-Session-Delegation` header value. */
  delegation: z.string(),
  /** Delegation expiry (ISO 8601); a request is never signed at/after this. */
  exp: z.string(),
  scope: z.string(),
  /** base64url raw 65-byte uncompressed P-256 point (0x04||X||Y). */
  publicKeyRaw: z.string(),
  /** The P-256 private key as a JWK, re-imported to sign each request. */
  privateKeyJwk: z.record(z.string(), z.unknown()),
});
export type SessionFile = z.infer<typeof SessionFileSchema>;

export interface SignableRequest {
  method: 'POST' | 'PUT';
  url: string;
  /** The exact request body bytes (JSON string); covered by Content-Digest. */
  body: string;
}

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

export interface SessionKeyDeps {
  /** Clock seam (ms since epoch). */
  now?: () => number;
  /** Per-request nonce (≥16-byte CSPRNG hex). */
  nonce?: () => string;
  /** P-256 keypair generator seam (tests pin a fixed key). */
  generateKeyPair?: () => Promise<webcrypto.CryptoKeyPair>;
  /** File reader/writer seams default to the 0600-cached session.json. */
  loadFile?: () => Promise<SessionFile | null>;
  saveFile?: (file: SessionFile) => Promise<void>;
}

export interface SessionKeyConfig {
  signer: TenjinSigner;
  baseUrl: string;
  chainId: string;
  dataDir: string;
}

const subtle = webcrypto.subtle;

// ---------------------------------------------------------------------------
// Byte-exact RFC 9421 primitives (the wire contract; unit-tested against fixtures).
// ---------------------------------------------------------------------------

/** Standard base64 of raw bytes. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** base64url (no padding) of raw bytes — the pubkey/keyid encoding. */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** `sha-256=:<base64 SHA-256(body)>:` — RFC 9530 Content-Digest over the body. */
export function contentDigest(body: string): string {
  const hash = createHash('sha256').update(body, 'utf8').digest();
  return `sha-256=:${hash.toString('base64')}:`;
}

/** The `@target-uri` derivation: scheme://host[:port]path[?query], nothing more. */
export function targetUri(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
}

export interface SignatureParamsInput {
  method: 'POST' | 'PUT' | 'GET' | 'DELETE';
  url: string;
  /** Present ⇒ the request has a body and content-digest joins the covered set. */
  contentDigest?: string;
  created: number;
  nonce: string;
  keyid: string;
}

/**
 * The `@signature-params` value (also the `Signature-Input` value after the
 * `tenjin=` label): the ordered covered-component list plus the signature
 * parameters, verbatim per llms-full.txt. `content-digest` is covered ONLY on a
 * bodied request.
 */
export function signatureParams(input: SignatureParamsInput): string {
  const covered =
    input.contentDigest !== undefined
      ? '"@method" "@target-uri" "content-digest"'
      : '"@method" "@target-uri"';
  return `(${covered});created=${input.created};nonce="${input.nonce}";keyid="${input.keyid}";alg="ecdsa-p256-sha256"`;
}

/**
 * The UTF-8 signing base: the LF-joined canonical block over `@method`,
 * `@target-uri`, `content-digest` (bodied requests only), and
 * `@signature-params`, with NO trailing newline.
 */
export function signatureBase(input: SignatureParamsInput): string {
  const params = signatureParams(input);
  const lines = [
    `"@method": ${input.method.toUpperCase()}`,
    `"@target-uri": ${targetUri(input.url)}`,
    ...(input.contentDigest !== undefined ? [`"content-digest": ${input.contentDigest}`] : []),
    `"@signature-params": ${params}`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Key material.
// ---------------------------------------------------------------------------

function defaultGenerateKeyPair(): Promise<webcrypto.CryptoKeyPair> {
  return subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]) as Promise<webcrypto.CryptoKeyPair>;
}

async function importSigningKey(jwk: Record<string, unknown>): Promise<webcrypto.CryptoKey> {
  return subtle.importKey(
    'jwk',
    jwk as webcrypto.JsonWebKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** Sign the base bytes with the P-256 key: P-256/SHA-256, IEEE-P1363 64-byte r||s. */
async function signBase(jwk: Record<string, unknown>, base: string): Promise<string> {
  const key = await importSigningKey(jwk);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(base, 'utf8'));
  return toBase64(new Uint8Array(sig));
}

/** keyid = `p256:<base64url pubkey>`, the delegation-bound identifier. */
function keyidFor(publicKeyRaw: string): string {
  return `p256:${publicKeyRaw}`;
}

// ---------------------------------------------------------------------------
// Establish + per-request signing.
// ---------------------------------------------------------------------------

/** The three URNs bound into the delegation's SIWX `resources` array (D35). */
export function delegationResources(publicKeyRaw: string, expIso: string): string[] {
  return [
    `urn:tenjin:session:pubkey:p256:${publicKeyRaw}`,
    `urn:tenjin:session:exp:${expIso}`,
    `urn:tenjin:session:scope:${SESSION_SCOPE}`,
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
  const generate = deps.generateKeyPair ?? defaultGenerateKeyPair;
  const pair = await generate();
  const rawPub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const publicKeyRaw = toBase64Url(rawPub);
  const jwk = (await subtle.exportKey('jwk', pair.privateKey)) as Record<string, unknown>;

  const expIso = new Date(now() + SESSION_TTL_MS).toISOString();
  const delegation = await buildSiwxHeader(config.signer, {
    baseUrl: config.baseUrl,
    chainId: config.chainId,
    ttlMs: SESSION_TTL_MS,
    statement: 'Delegate a Tenjin session key.',
    resources: delegationResources(publicKeyRaw, expIso),
  });

  const file: SessionFile = {
    address: config.signer.address.toLowerCase(),
    delegation,
    exp: expIso,
    scope: SESSION_SCOPE,
    publicKeyRaw,
    privateKeyJwk: jwk,
  };
  const save = deps.saveFile ?? ((f) => saveSessionFile(config.dataDir, f));
  await save(file);
  return file;
}

/** Produce the RFC 9421 write headers for `req`, signed by the session key. */
export async function signWithSession(
  file: SessionFile,
  req: SignableRequest,
  deps: SessionKeyDeps = {},
): Promise<Record<string, string>> {
  const now = deps.now ?? Date.now;
  const nonce = deps.nonce ?? (() => randomBytes(16).toString('hex'));
  const digest = contentDigest(req.body);
  const created = Math.floor(now() / 1000);
  const params: SignatureParamsInput = {
    method: req.method,
    url: req.url,
    contentDigest: digest,
    created,
    nonce: nonce(),
    keyid: keyidFor(file.publicKeyRaw),
  };
  const base = signatureBase(params);
  const signature = await signBase(file.privateKeyJwk, base);
  return {
    'Tenjin-Session-Delegation': file.delegation,
    'Signature-Input': `tenjin=${signatureParams(params)}`,
    Signature: `tenjin=:${signature}:`,
    'Content-Digest': digest,
  };
}

// ---------------------------------------------------------------------------
// Cache I/O (0600, address-bound).
// ---------------------------------------------------------------------------

export async function loadSessionFile(dir: string): Promise<SessionFile | null> {
  let raw: string;
  try {
    raw = await readFile(sessionPath(dir), 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new CliError('INTERNAL', `Could not read the session cache at ${sessionPath(dir)}`, {
      fix: `Check file permissions on ${sessionPath(dir)}, or delete it to re-establish.`,
      cause: err,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null; // a corrupt cache is not fatal: re-establish silently.
  }
  const parsed = SessionFileSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export async function saveSessionFile(dir: string, file: SessionFile): Promise<void> {
  await writeFileAtomic(sessionPath(dir), `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
}

/** A cached session usable now: bound to this address and not near expiry. */
export function isSessionUsable(file: SessionFile, address: string, now: number): boolean {
  if (file.address !== address.toLowerCase()) return false;
  if (file.scope !== SESSION_SCOPE) return false;
  const expMs = Date.parse(file.exp);
  if (!Number.isFinite(expMs)) return false;
  return now < expMs - EXP_SKEW_MS;
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
  const loadFile = deps.loadFile ?? (() => loadSessionFile(config.dataDir));
  let cached: SessionFile | null = null;
  let forceReestablish = false;

  const ensure = async (): Promise<SessionFile> => {
    if (
      !forceReestablish &&
      cached !== null &&
      isSessionUsable(cached, config.signer.address, now())
    ) {
      return cached;
    }
    if (!forceReestablish) {
      const onDisk = await loadFile();
      if (onDisk !== null && isSessionUsable(onDisk, config.signer.address, now())) {
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

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
