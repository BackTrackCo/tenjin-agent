import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import * as Keystore from 'ox/Keystore';
import { CliError } from '../errors';
import { writeFileAtomicExclusive } from '../atomic-json';
import { walletPath } from '../paths';

/** A 0x-prefixed 32-byte hex private key (case-insensitive). */
export const PRIVATE_KEY_RE = /^0x[0-9a-f]{64}$/i;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The at-rest shape of a Keystore v3 document (Web3 Secret Storage). Validated
 * structurally on read so an obviously-corrupt keystore fails as
 * WALLET_INVALID_KEY before we ever ask for a passphrase; the real integrity
 * check is the keystore's own MAC, verified by ox at decrypt time. `kdfparams`
 * stays an open object because scrypt and pbkdf2 carry different fields and only
 * ox needs to interpret them.
 */
const KeystoreV3Schema = z.object({
  crypto: z.object({
    cipher: z.literal('aes-128-ctr'),
    ciphertext: z.string(),
    cipherparams: z.object({ iv: z.string() }),
    kdf: z.enum(['scrypt', 'pbkdf2']),
    kdfparams: z.record(z.string(), z.unknown()),
    mac: z.string(),
  }),
  id: z.string(),
  version: z.literal(3),
});

/**
 * The persisted wallet record (schema v2). The private key is NEVER stored in
 * cleartext: `keystore` is a Keystore v3 document (scrypt + AES-128-CTR) and the
 * key is recovered only by decrypting it with the wallet passphrase. `address`
 * stays top-level in cleartext ON PURPOSE so `show`/`balance`/`doctor` keep
 * working without a passphrase; only signing decrypts. The `provider`
 * discriminator keeps the schema from implying every future wallet embeds a
 * keystore. Validated on read (a corrupt file is WALLET_INVALID_KEY, never a
 * silent partial parse).
 */
export const WalletRecordSchema = z.object({
  schemaVersion: z.literal(2),
  provider: z.literal('local'),
  address: z.string().regex(ADDRESS_RE, 'expected a 0x-prefixed 20-byte address'),
  keystore: KeystoreV3Schema,
  createdAt: z.string(),
});
export type WalletRecord = Omit<z.infer<typeof WalletRecordSchema>, 'keystore'> & {
  keystore: Keystore.Keystore;
};

export async function walletFileExists(dir: string): Promise<boolean> {
  return (await walletFileMode(dir)) !== null;
}

/** File permission bits (`mode & 0o777`), or null when the wallet file is absent. */
export async function walletFileMode(dir: string): Promise<number | null> {
  try {
    return (await stat(walletPath(dir))).mode & 0o777;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Read + validate the wallet record; null when absent, WALLET_INVALID_KEY when corrupt. */
export async function readWalletRecord(dir: string): Promise<WalletRecord | null> {
  const path = walletPath(dir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw new CliError('WALLET_INVALID_KEY', `Could not read the wallet file at ${path}.`, {
      fix: `Check file permissions on ${path}.`,
      cause: err,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new CliError('WALLET_INVALID_KEY', `The wallet file at ${path} is not valid JSON.`, {
      fix: `Move ${path} aside, then run \`tenjin wallet create\`.`,
      cause: err,
    });
  }
  // A pre-encryption record (schema v1 stored the raw key). There is no in-place
  // migration: the old key must be swept and a fresh encrypted wallet created.
  if (isPreEncryptionRecord(json)) {
    throw new CliError(
      'WALLET_INVALID_KEY',
      `The wallet file at ${path} predates encrypted storage.`,
      {
        fix: `Move ${path} aside and run \`tenjin wallet create\`; sweep any funds from the old address first.`,
      },
    );
  }
  const parsed = WalletRecordSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      'WALLET_INVALID_KEY',
      `The wallet file at ${path} is not a valid wallet record.`,
      {
        fix: `Move ${path} aside, then run \`tenjin wallet create\`.`,
        details: parsed.error.issues,
      },
    );
  }
  return parsed.data as WalletRecord;
}

/**
 * Persist a validated record at 0600 in a 0700 dir, NO-CLOBBER. The exclusive
 * write — not an earlier existence check — is the authority: two concurrent
 * `create` runs can both pass a pre-check, but only one can win the atomic
 * commit; the loser surfaces as WALLET_EXISTS instead of silently overwriting
 * (and losing) a non-recoverable key.
 */
export async function writeWalletRecord(dir: string, record: WalletRecord): Promise<void> {
  const validated = WalletRecordSchema.parse(record);
  const path = walletPath(dir);
  try {
    await writeFileAtomicExclusive(path, `${JSON.stringify(validated, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    });
  } catch (err) {
    if (hasCode(err, 'EEXIST')) {
      throw new CliError('WALLET_EXISTS', `A wallet already exists at ${path}.`, {
        fix: `Keys are non-recoverable; move it aside first (e.g. \`mv ${path} ${path}.bak\`) to create a new one.`,
        cause: err,
      });
    }
    throw err;
  }
}

/** A cleartext-key record from before encrypted storage: schema v1 or a bare `privateKey`. */
function isPreEncryptionRecord(json: unknown): boolean {
  if (typeof json !== 'object' || json === null) return false;
  const rec = json as Record<string, unknown>;
  return rec.schemaVersion === 1 || 'privateKey' in rec;
}

function isNotFound(err: unknown): boolean {
  return hasCode(err, 'ENOENT');
}

function hasCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}
