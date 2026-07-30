import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { CliError } from './errors';
import { hasCode } from './errno';
import { sessionPath } from './paths';

/**
 * The PRESENT half of the session-key layer: load a delegation that already
 * exists on disk and sign one request with it. Nothing here can MINT one.
 *
 * The split is structural, not stylistic. `tenjin read` must be able to present
 * an owner's session key on a cold 402 (that is how an owned-but-uncached piece
 * comes back without paying), while its import graph stays test-pinned clear of
 * the wallet: a read that could open the keystore is a read that could pay. So
 * every function that needs `buildSiwxHeader`/`TenjinSigner` — minting a
 * delegation, writing one to disk, the WriteAuth implementations — lives in
 * `session-key.ts`, which imports THIS module and re-exports it for the write
 * clients. Read imports this half and can reach nothing else.
 *
 * What read therefore holds is a P-256 (ECDSA/SHA-256) private key. It cannot
 * produce the secp256k1/EIP-712 signature an EIP-3009 transfer authorization
 * needs — wrong curve, wrong scheme — so no arrangement of this code pays for
 * anything. The delegation's authority is bounded on the server side too: a
 * `read`-scoped session is refused (`insufficient_scope`) on any write method.
 *
 * Never hand-rolls crypto: P-256 sign is node:crypto webcrypto (subtle) and
 * SHA-256 is node:crypto. Byte-exact against the "Auth — session keys" contract
 * in https://tenjin.blog/llms-full.txt (D35).
 */

/**
 * The delegation scopes the server recognizes. A session is minted at the scope
 * the run needs: a `read`-scoped session cannot write (the server refuses the
 * write with `insufficient_scope`), so an owner-scoped READ never leaves a
 * write-capable delegation on disk that the run did not need.
 */
export type SessionScope = 'read' | 'read+write';

/**
 * Does a cached session's scope cover what this run needs? Wider covers narrower,
 * so a cached `read+write` serves a `read` run with no new wallet signature; the
 * reverse must NOT hold, or a read-scoped session would be used for a write the
 * server then rejects.
 */
export function scopeSatisfies(cached: string, required: SessionScope): boolean {
  if (cached === required) return true;
  return required === 'read' && cached === 'read+write';
}

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

/**
 * A request to sign. The body is part of the METHOD, not an optional extra: a
 * bodied request must carry the exact bytes Content-Digest covers, and a GET has
 * no body to cover at all, so content-digest drops out of the covered set. As a
 * union, "GET with a body" and "PUT without one" are both unrepresentable rather
 * than merely wrong.
 */
export type SignableRequest =
  { method: 'GET'; url: string } | { method: 'POST' | 'PUT'; url: string; body: string };

export interface SessionKeyDeps {
  /** Clock seam (ms since epoch). */
  now?: () => number;
  /** Per-request nonce (≥16-byte CSPRNG hex). */
  nonce?: () => string;
}

const subtle = webcrypto.subtle;

// ---------------------------------------------------------------------------
// Byte-exact RFC 9421 primitives (the wire contract; unit-tested against fixtures).
// ---------------------------------------------------------------------------

/** Standard base64 of raw bytes. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
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
// Key material (import + sign only — generation lives with the mint half).
// ---------------------------------------------------------------------------

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
export function keyidFor(publicKeyRaw: string): string {
  return `p256:${publicKeyRaw}`;
}

// ---------------------------------------------------------------------------
// Per-request signing.
// ---------------------------------------------------------------------------

/** Produce the RFC 9421 headers for `req`, signed by the loaded session key. */
export async function signWithSession(
  file: SessionFile,
  req: SignableRequest,
  deps: SessionKeyDeps = {},
): Promise<Record<string, string>> {
  const now = deps.now ?? Date.now;
  const nonce = deps.nonce ?? (() => randomBytes(16).toString('hex'));
  // A bodiless request carries no Content-Digest, and content-digest leaves the
  // covered component set with it — signing a digest of "" would cover bytes the
  // request never sends.
  const digest = req.method === 'GET' ? undefined : contentDigest(req.body);
  const created = Math.floor(now() / 1000);
  const params: SignatureParamsInput = {
    method: req.method,
    url: req.url,
    ...(digest !== undefined ? { contentDigest: digest } : {}),
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
    ...(digest !== undefined ? { 'Content-Digest': digest } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cache reads (the writer lives with the mint half).
// ---------------------------------------------------------------------------

export async function loadSessionFile(dir: string): Promise<SessionFile | null> {
  const path = sessionPath(dir);
  // Fail closed on a loosened cache (ssh's posture for a private key): the key is
  // written 0600, so if it is now group- or world-readable it was tampered with
  // out of band — refuse it and re-establish rather than sign with a key others
  // can read. No-op on win32, which has no unix mode.
  if (process.platform !== 'win32') {
    try {
      const mode = (await stat(path)).mode & 0o077;
      if (mode !== 0) return null;
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return null;
      throw sessionReadError(path, err);
    }
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return null;
    throw sessionReadError(path, err);
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

function sessionReadError(path: string, cause: unknown): CliError {
  return new CliError('INTERNAL', `Could not read the session cache at ${path}`, {
    fix: `Check file permissions on ${path}, or delete it to re-establish.`,
    cause,
  });
}

/**
 * Is this cached session wide enough and fresh enough to PRESENT — scope and
 * expiry only, no address comparison.
 *
 * The address half is deliberately separable, because `read` has no wallet and
 * so has nothing to compare against. That costs nothing: the delegation is
 * self-authenticating server-side (it carries the wallet's own SIWX signature),
 * so presenting a file from some other address just yields the same refusal a
 * missing file yields. Callers that DO hold a signer use `isSessionUsable`,
 * which adds the binding check so a wallet change invalidates the cache.
 */
export function isSessionPresentable(
  file: SessionFile,
  now: number,
  required: SessionScope,
): boolean {
  if (!scopeSatisfies(file.scope, required)) return false;
  const expMs = Date.parse(file.exp);
  if (!Number.isFinite(expMs)) return false;
  return now < expMs - EXP_SKEW_MS;
}

/**
 * A cached session usable now: bound to this address, wide enough for what the run
 * needs, and not near expiry. A read-scoped cache does NOT serve a write run — it
 * re-establishes instead, because the server would refuse that write.
 */
export function isSessionUsable(
  file: SessionFile,
  address: string,
  now: number,
  required: SessionScope,
): boolean {
  if (file.address !== address.toLowerCase()) return false;
  return isSessionPresentable(file, now, required);
}
