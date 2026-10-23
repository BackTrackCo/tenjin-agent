import { mkdir, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-json';
import { CliError } from './errors';
import { passphraseRecordPath } from './paths';
import type { DurableStore } from './wallet-unlock';

/**
 * WHERE EACH WALLET'S PASSPHRASE WAS SAVED, beside the wallet:
 * `<dataDir>/passphrase-store.json`, keyed by lowercase address.
 *
 * Why not a field in wallet.json: that file holds a funded key, and rewriting
 * it to record a storage choice risks the key for no gain. An older CLI also
 * reads wallet.json strictly, and must keep reading it after this one has
 * saved a passphrase somewhere new. So wallet.json is never touched, and the
 * choice lives here, where losing the file costs nothing: an absent,
 * unreadable, unparseable or newer-schema sidecar, or an unknown store value,
 * all read as "no record", which means today's lookup order.
 *
 * Hook-safe: `alive` and the hooks read it, so it imports only node, zod and
 * the lib modules the chunk graph allows. Reads never write (no lazy
 * migration): the router's read path stays free of side effects.
 *
 * Only `wallet create`, `wallet create --replace` and `wallet repair` write it,
 * and they hold `wallet.create.lock` while they do, so the read-modify-write
 * below never races another writer. An entry is never deleted in PR 1: a
 * restored archive (`mv wallet.<addr>.json.bak wallet.json`) finds its own
 * entry again by address.
 */

export const PASSPHRASE_RECORD_SCHEMA_VERSION = 1;

export interface PassphraseRecordEntry {
  store: DurableStore;
  recordedAt: string;
  by: 'create' | 'repair' | 'replace';
}

const EntrySchema = z
  .object({
    store: z.enum(['keychain', 'secret-service', 'dpapi', 'file']),
    recordedAt: z.string(),
    by: z.enum(['create', 'repair', 'replace']),
  })
  .strict();

/**
 * The envelope. Entries are checked one at a time ({@link EntrySchema}) so one
 * malformed entry hides only itself, and a write keeps every other address's
 * entry exactly as it found it.
 */
const RecordSchema = z
  .object({
    schemaVersion: z.literal(PASSPHRASE_RECORD_SCHEMA_VERSION),
    wallets: z.record(z.string(), z.unknown()),
  })
  .strict();

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** The parsed sidecar's wallets, or null when there is none worth keeping. */
async function readWallets(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = RecordSchema.safeParse(
      JSON.parse(await readFile(passphraseRecordPath(dir), 'utf8')),
    );
    return parsed.success ? parsed.data.wallets : null;
  } catch {
    return null;
  }
}

/**
 * This address's entry, or null for an absent file, unparseable JSON, a
 * `schemaVersion` other than 1, an unknown store value, or no entry for it.
 * Never throws: a sidecar Tenjin cannot read is the same as none.
 */
export async function readPassphraseRecord(
  dir: string,
  address: string,
): Promise<PassphraseRecordEntry | null> {
  const key = address.toLowerCase();
  if (!ADDRESS_RE.test(key)) return null;
  const wallets = await readWallets(dir);
  if (wallets === null) return null;
  // Keys are written lowercase; a hand-edited mixed-case key still matches.
  const raw = Object.entries(wallets).find(([k]) => k.toLowerCase() === key)?.[1];
  const entry = EntrySchema.safeParse(raw);
  return entry.success ? entry.data : null;
}

/**
 * Record where `address`'s passphrase was saved, keeping every other entry.
 * The caller holds `wallet.create.lock`.
 *
 * A sidecar that does not parse is replaced by a fresh one holding only this
 * entry. That loses nothing a reader could use: a corrupt sidecar already
 * meant "no record, today's behaviour" for every address in it.
 */
export async function writePassphraseRecord(
  dir: string,
  address: string,
  entry: { store: DurableStore; by: PassphraseRecordEntry['by'] },
  now: Date = new Date(),
): Promise<void> {
  const key = address.toLowerCase();
  if (!ADDRESS_RE.test(key)) {
    throw new CliError('INTERNAL', `Not a wallet address: ${address}`);
  }
  const wallets = { ...((await readWallets(dir)) ?? {}) };
  // One entry per address, however it was cased before.
  for (const k of Object.keys(wallets)) if (k.toLowerCase() === key) delete wallets[k];
  const record: PassphraseRecordEntry = {
    store: entry.store,
    recordedAt: now.toISOString(),
    by: entry.by,
  };
  wallets[key] = record;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    passphraseRecordPath(dir),
    JSON.stringify({ schemaVersion: PASSPHRASE_RECORD_SCHEMA_VERSION, wallets }, null, 2) + '\n',
    { mode: 0o600, dirMode: 0o700 },
  );
}
