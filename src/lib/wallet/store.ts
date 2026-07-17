import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { CliError } from '../errors';
import { writeFileAtomicExclusive } from '../atomic-json';
import { walletPath } from '../paths';

/** A 0x-prefixed 32-byte hex private key (case-insensitive). */
export const PRIVATE_KEY_RE = /^0x[0-9a-f]{64}$/i;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The persisted wallet record. The `provider` discriminator keeps the schema
 * from implying every future wallet embeds a raw key; `address` is stored EIP-55
 * checksummed so `show`/`doctor` never derive it from the key. Validated on read
 * (a corrupt file is WALLET_INVALID_KEY, never a silent partial parse).
 */
export const WalletRecordSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.literal('local'),
  address: z.string().regex(ADDRESS_RE, 'expected a 0x-prefixed 20-byte address'),
  privateKey: z.string().regex(PRIVATE_KEY_RE, 'expected a 0x-prefixed 32-byte hex key'),
  createdAt: z.string(),
});
export type WalletRecord = z.infer<typeof WalletRecordSchema>;

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
  return parsed.data;
}

/**
 * Persist a validated record at 0600 in a 0700 dir, NO-CLOBBER. The exclusive
 * write — not an earlier existence check — is the authority: two concurrent
 * `create`/`import` runs can both pass a pre-check, but only one can win the
 * atomic commit; the loser surfaces as WALLET_EXISTS instead of silently
 * overwriting (and losing) a non-recoverable key.
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
