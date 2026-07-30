import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { CliError } from './errors';
import { hasCode } from './errno';
import { sessionPath } from './paths';

/**
 * The PRESENT half of the session-key layer: load a delegation that already
 * exists on disk and sign one request with it. Nothing here can MINT one — every
 * function that needs a wallet signer lives in `session-key.ts`, which imports
 * this module and re-exports it.
 *
 * The split exists so `tenjin read` can present an owner's session key on a cold
 * 402 while its import graph stays test-pinned clear of the wallet. What that
 * pin establishes is exactly two things: read cannot mint a session, and read
 * cannot pay (a P-256 key cannot produce the secp256k1/EIP-712 signature an
 * EIP-3009 transfer authorization needs). It says nothing about what an
 * already-minted delegation is worth to whoever holds it — see `origin` below,
 * and the tier note in `permissions.ts`.
 *
 * Byte-exact against the "Auth — session keys" contract in
 * https://tenjin.blog/llms-full.txt (D35). P-256 signing is node:crypto webcrypto.
 */

/** The delegation scopes the server recognizes. */
export type SessionScope = 'read' | 'read+write';

/**
 * Does a cached session's scope cover what this run needs? Wider covers narrower,
 * so a cached `read+write` serves a `read` run with no new wallet signature; the
 * reverse must not hold.
 */
export function scopeSatisfies(cached: string, required: SessionScope): boolean {
  if (cached === required) return true;
  return required === 'read' && cached === 'read+write';
}

/** Re-establish this long before `exp` so a signed request cannot expire in flight. */
const EXP_SKEW_MS = 60_000;

/**
 * The P-256 private key, validated as one. A loose record let `{}` or a garbage
 * `d` past the load boundary and into `subtle.importKey`, which throws a raw
 * DOMException — surfacing as an exit-1 INTERNAL with no fix, from a command
 * whose contract is that a bad session file degrades into the ordinary refusal.
 * Validating the shape here keeps that promise: a malformed key is an unusable
 * cache, which is already a handled state.
 */
const P256JwkSchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    d: z.string().min(1),
    x: z.string().min(1),
    y: z.string().min(1),
  })
  .passthrough();

/** The persisted session: the wallet-signed delegation plus the P-256 key material. */
const SessionFileSchema = z.object({
  /** Lowercased wallet address this delegation is bound to. */
  address: z.string(),
  /**
   * The `scheme://host[:port]` this delegation was minted against.
   *
   * Load-bearing, not bookkeeping. The delegation is a wallet-derived credential
   * and `--base-url` rides every leaf command, including the always-safe `read`.
   * Without this field one auto-allowed `tenjin read <url> --base-url <attacker>`
   * hands the credential to a host the agent chose, with the origin guard
   * satisfied because the same flag set both sides of it. Binding the file to its
   * origin closes that however the base URL arrived — flag, environment, or a
   * rewritten config. It also makes a stale file after a prod/localhost/preview
   * switch fail closed rather than present a delegation that cannot verify.
   */
  origin: z.string(),
  /** The constant base64 SIWX `Tenjin-Session-Delegation` header value. */
  delegation: z.string(),
  /** Delegation expiry (ISO 8601); a request is never signed at/after this. */
  exp: z.string(),
  scope: z.string(),
  /** base64url raw 65-byte uncompressed P-256 point (0x04||X||Y). */
  publicKeyRaw: z.string(),
  privateKeyJwk: P256JwkSchema,
});
export type SessionFile = z.infer<typeof SessionFileSchema>;

/**
 * A request to sign. The body is part of the METHOD: a bodied request must carry
 * the exact bytes Content-Digest covers, and a GET has no body to cover at all,
 * so content-digest drops out of the covered set. As a union, "GET with a body"
 * and "PUT without one" are both unrepresentable.
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
 * `tenjin=` label), verbatim per llms-full.txt. `content-digest` is covered ONLY
 * on a bodied request.
 */
export function signatureParams(input: SignatureParamsInput): string {
  const covered =
    input.contentDigest !== undefined
      ? '"@method" "@target-uri" "content-digest"'
      : '"@method" "@target-uri"';
  return `(${covered});created=${input.created};nonce="${input.nonce}";keyid="${input.keyid}";alg="ecdsa-p256-sha256"`;
}

/** The UTF-8 signing base: the LF-joined canonical block, with NO trailing newline. */
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
// Key import + per-request signing (generation lives with the mint half).
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

/** P-256/SHA-256, IEEE-P1363 64-byte r||s. */
async function signBase(jwk: Record<string, unknown>, base: string): Promise<string> {
  const key = await importSigningKey(jwk);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(base, 'utf8'));
  return toBase64(new Uint8Array(sig));
}

/** keyid = `p256:<base64url pubkey>`, the delegation-bound identifier. */
export function keyidFor(publicKeyRaw: string): string {
  return `p256:${publicKeyRaw}`;
}

/** Produce the RFC 9421 headers for `req`, signed by the loaded session key. */
export async function signWithSession(
  file: SessionFile,
  req: SignableRequest,
  deps: SessionKeyDeps = {},
): Promise<Record<string, string>> {
  const now = deps.now ?? Date.now;
  const nonce = deps.nonce ?? (() => randomBytes(16).toString('hex'));
  // Signing a digest of "" would cover bytes the request never sends.
  const digest = req.method === 'GET' ? undefined : contentDigest(req.body);
  const params: SignatureParamsInput = {
    method: req.method,
    url: req.url,
    ...(digest !== undefined ? { contentDigest: digest } : {}),
    created: Math.floor(now() / 1000),
    nonce: nonce(),
    keyid: keyidFor(file.publicKeyRaw),
  };
  const signature = await signBase(file.privateKeyJwk, signatureBase(params));
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

/**
 * Why a session file is not usable, kept distinguishable for `doctor`.
 * `loadSessionFile` collapses these to null — to a caller that can re-establish
 * they are all the same instruction — but `loosened` and `corrupt` are TAMPER
 * signals, and a diagnostic verb that reports them as "no session key" hides the
 * signal at the one moment someone is looking for it.
 */
export type SessionFileState =
  | { kind: 'absent' }
  | { kind: 'loosened'; mode: number }
  | { kind: 'corrupt'; reason: string }
  | { kind: 'unreadable'; message: string }
  | { kind: 'ok'; file: SessionFile };

export async function readSessionFile(dir: string): Promise<SessionFileState> {
  const path = sessionPath(dir);
  // Fail closed on a loosened cache (ssh's posture for a private key): the file is
  // written 0600, so a now group- or world-readable one was touched out of band.
  // No-op on win32, which has no unix mode.
  if (process.platform !== 'win32') {
    try {
      const mode = (await stat(path)).mode & 0o077;
      if (mode !== 0) return { kind: 'loosened', mode };
    } catch (err) {
      if (hasCode(err, 'ENOENT')) return { kind: 'absent' };
      return { kind: 'unreadable', message: messageOf(err) };
    }
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return { kind: 'absent' };
    return { kind: 'unreadable', message: messageOf(err) };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt', reason: 'not valid JSON' };
  }
  const parsed = SessionFileSchema.safeParse(json);
  if (!parsed.success) {
    return { kind: 'corrupt', reason: parsed.error.issues[0]?.message ?? 'schema mismatch' };
  }
  return { kind: 'ok', file: parsed.data };
}

/** The session to present, or null for every reason there is not one. */
export async function loadSessionFile(dir: string): Promise<SessionFile | null> {
  const state = await readSessionFile(dir);
  if (state.kind === 'ok') return state.file;
  // An I/O failure is the one state a caller must not silently re-establish
  // through: the path exists and could not be read, so treating it as "no
  // session" would re-mint over a file that may be perfectly good.
  if (state.kind === 'unreadable') {
    throw new CliError('INTERNAL', `Could not read the session cache at ${sessionPath(dir)}`, {
      fix: `Check file permissions on ${sessionPath(dir)}, or delete it to re-establish.`,
    });
  }
  return null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Is this cached session usable for a run against `origin` — scope, expiry, and
 * the deployment it was minted for. No address comparison: `read` holds no
 * wallet, so it has nothing to compare against, and that costs nothing because a
 * foreign-wallet file simply does not entitle. Callers that DO hold a signer use
 * `isSessionUsable`, which adds the binding check.
 */
export function isSessionPresentable(
  file: SessionFile,
  now: number,
  required: SessionScope,
  origin: string,
): boolean {
  if (file.origin !== origin) return false;
  if (!scopeSatisfies(file.scope, required)) return false;
  const expMs = Date.parse(file.exp);
  if (!Number.isFinite(expMs)) return false;
  return now < expMs - EXP_SKEW_MS;
}

/** `isSessionPresentable` plus the wallet binding, so a wallet swap invalidates. */
export function isSessionUsable(
  file: SessionFile,
  address: string,
  now: number,
  required: SessionScope,
  origin: string,
): boolean {
  if (file.address !== address.toLowerCase()) return false;
  return isSessionPresentable(file, now, required, origin);
}
