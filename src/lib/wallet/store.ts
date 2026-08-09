import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import * as Keystore from 'ox/Keystore';
import { CliError } from '../errors';
import { writeFileAtomicExclusive } from '../atomic-json';
import { hasCode } from '../errno';
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

/** The wallet-record schema this build writes. It also reads encrypted local v2
 * records; anything higher on disk was written by a newer CLI. */
export const WALLET_SCHEMA_VERSION = 3;

/**
 * The persisted local-wallet arm. The private key is NEVER stored in
 * cleartext: `keystore` is a Keystore v3 document (scrypt + AES-128-CTR) and the
 * key is recovered only by decrypting it with the wallet passphrase. `address`
 * stays top-level in cleartext ON PURPOSE so `show`/`balance` keep working
 * without a passphrase; signing decrypts, and so does `doctor` when it can reach
 * a passphrase without prompting. The `provider`
 * discriminator keeps the schema from implying every future wallet embeds a
 * keystore. Validated on read (a corrupt file is WALLET_INVALID_KEY, never a
 * silent partial parse).
 */
const LocalWalletRecordV2Schema = z.object({
  schemaVersion: z.literal(2),
  provider: z.literal('local'),
  address: z.string().regex(ADDRESS_RE, 'expected a 0x-prefixed 20-byte address'),
  keystore: KeystoreV3Schema,
  createdAt: z.string(),
});

/** Schema v3 makes the provider discriminator real while retaining v2 reads. */
const LocalWalletRecordV3Schema = LocalWalletRecordV2Schema.extend({
  schemaVersion: z.literal(WALLET_SCHEMA_VERSION),
});
const ClawRouterWalletRecordSchema = z.object({
  schemaVersion: z.literal(WALLET_SCHEMA_VERSION),
  provider: z.literal('clawrouter'),
  address: z.string().regex(ADDRESS_RE, 'expected a 0x-prefixed 20-byte address'),
  connectedAt: z.string(),
});

export const WalletRecordSchema = z.union([
  LocalWalletRecordV2Schema,
  LocalWalletRecordV3Schema,
  ClawRouterWalletRecordSchema,
]);
export type LocalWalletRecord = Omit<
  z.infer<typeof LocalWalletRecordV2Schema> | z.infer<typeof LocalWalletRecordV3Schema>,
  'keystore'
> & {
  keystore: Keystore.Keystore;
};
export type ClawRouterWalletRecord = z.infer<typeof ClawRouterWalletRecordSchema>;
export type WalletRecord = LocalWalletRecord | ClawRouterWalletRecord;

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
  // A NEWER CLI's record is a downgrade, not a corruption, and must be caught
  // BEFORE the generic parse failure below: that failure says to move the file
  // aside and run `wallet create`, which on a downgrade abandons a funded wallet.
  // CONTRACT_MISMATCH is the API layer's code for a schema version skew.
  const newer = newerSchemaVersion(json);
  if (newer !== null) {
    throw new CliError(
      'CONTRACT_MISMATCH',
      `The wallet file at ${path} was written by a newer tenjin-cli (wallet schema v${newer}; this build reads through v${WALLET_SCHEMA_VERSION}).`,
      {
        fix: 'Upgrade with `npm i -g tenjin-cli`. Do not delete or recreate the wallet: the newer CLI still reads this one, and the funds are on the address it holds.',
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
 * The one WALLET_EXISTS error, shared by the create pre-check and the exclusive
 * write's race loser so the two surfaces can never drift apart.
 */
export function walletExistsError(dir: string, cause?: unknown): CliError {
  const path = walletPath(dir);
  return new CliError('WALLET_EXISTS', `A wallet already exists at ${path}.`, {
    fix: `Run \`tenjin wallet create --replace\` to archive it and create a new one: its keystore is parked beside the new wallet and its passphrase stays preserved in the OS credential store (service tenjin-cli, account = its address), so its funds remain reachable. That passphrase is unrecoverable — never delete the credential-store entry, or the wallet's funds are stranded.`,
    ...(cause !== undefined ? { cause } : {}),
  });
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
    if (hasCode(err, 'EEXIST')) throw walletExistsError(dir, err);
    throw err;
  }
}

/** The schema version of a record from a future CLI, or null when this build reads it. */
function newerSchemaVersion(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) return null;
  const v = (json as Record<string, unknown>).schemaVersion;
  // Integral only: `2.5` is not a schema we will ship, and calling it "from the
  // future" would send the operator into an upgrade loop. Integrality rather than
  // SAFE integrality, because an absurd-but-whole version is still a version, and
  // the alternative branch tells them to move the wallet aside and recreate it.
  return typeof v === 'number' && Number.isInteger(v) && v > WALLET_SCHEMA_VERSION ? v : null;
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
