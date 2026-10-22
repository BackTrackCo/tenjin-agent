import { readFile, stat } from 'node:fs/promises';
import { hasCode } from './errno';
import { readPassphraseRecord } from './passphrase-record';
import { passphraseFilePathFor, passphraseRecordPath, walletPath } from './paths';
import { PRIVATE_KEY_RE, type DurableStore } from './wallet-unlock';

/**
 * WHAT THE FILES SAY ABOUT THE WALLET, without unlocking it. The hooks, `alive`
 * and the routing payer's memo need to know "is there a wallet, is it readable,
 * where was its passphrase saved, and did any of that change" on every prompt,
 * and none of them may load the wallet layer (`src/router/dist-chunks.test.ts`)
 * or pay for a keychain read or an scrypt to find out.
 *
 * So this reads only: wallet.json's cleartext address, the sidecar, two or three
 * `stat`s, and the environment. It never execs and never throws; anything it
 * cannot read is reported as the fact it is (`unparsable`, null), and deciding
 * what that means is `src/router/eligibility.ts`'s job.
 */
export interface WalletFacts {
  /** TENJIN_WALLET_KEY trimmed vs PRIVATE_KEY_RE (S12); whitespace-only = absent. */
  envKey: 'absent' | 'valid' | 'malformed';
  /** unparsable = unreadable, bad JSON, or no valid address. */
  walletFile: 'present' | 'absent' | 'unparsable';
  /** Cleartext top-level address of wallet.json. */
  address: string | null;
  envPassphraseSet: boolean;
  /** Sidecar entry for `address`. */
  passphraseStore: DurableStore | null;
  /** Sidecar says 'file' and the .plain file is absent. */
  passphraseFileMissing: boolean;
  walletMtimeMs: number | null;
  sidecarMtimeMs: number | null;
}

/** The same address test `hooks.ts` applies to wallet.json's cleartext field. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Read {@link WalletFacts} for `dataDir` under `env`. Never rejects.
 *
 * `envKey` runs the exact test `loadCredential` (src/lib/wallet/local.ts)
 * runs, through the one shared {@link PRIVATE_KEY_RE}, so a key these facts
 * call valid is one the signer accepts. The env passphrase counts as set only
 * when non-empty, as the passphrase resolver treats it.
 */
export async function readWalletFacts(
  dataDir: string,
  env: NodeJS.ProcessEnv,
): Promise<WalletFacts> {
  const key = env.TENJIN_WALLET_KEY?.trim() ?? '';
  const envKey: WalletFacts['envKey'] =
    key.length === 0 ? 'absent' : PRIVATE_KEY_RE.test(key) ? 'valid' : 'malformed';
  const passphrase = env.TENJIN_WALLET_PASSPHRASE;
  const envPassphraseSet = passphrase !== undefined && passphrase.length > 0;

  const { walletFile, address } = await readWalletAddress(dataDir);
  const [walletMtimeMs, sidecarMtimeMs] = await Promise.all([
    mtimeOf(walletPath(dataDir)),
    mtimeOf(passphraseRecordPath(dataDir)),
  ]);

  let passphraseStore: DurableStore | null = null;
  let passphraseFileMissing = false;
  if (address !== null) {
    passphraseStore =
      (await readPassphraseRecord(dataDir, address).catch(() => null))?.store ?? null;
    if (passphraseStore === 'file') {
      // Only a definite ENOENT is "missing". Any other stat failure says
      // nothing about whether the file is there, so it claims nothing.
      passphraseFileMissing = await stat(passphraseFilePathFor(address.toLowerCase(), dataDir))
        .then(() => false)
        .catch((err: unknown) => hasCode(err, 'ENOENT'));
    }
  }

  return {
    envKey,
    walletFile,
    address,
    envPassphraseSet,
    passphraseStore,
    passphraseFileMissing,
    walletMtimeMs,
    sidecarMtimeMs,
  };
}

/** `${walletMtimeMs}:${sidecarMtimeMs}`, the stamp the payer memo compares. */
export function unlockStamp(f: Pick<WalletFacts, 'walletMtimeMs' | 'sidecarMtimeMs'>): string {
  return `${f.walletMtimeMs}:${f.sidecarMtimeMs}`;
}

/** wallet.json's state and cleartext address. ENOENT is absent; any other
 *  failure to read or understand it is unparsable. */
async function readWalletAddress(
  dataDir: string,
): Promise<Pick<WalletFacts, 'walletFile' | 'address'>> {
  let text: string;
  try {
    text = await readFile(walletPath(dataDir), 'utf8');
  } catch (err) {
    return { walletFile: hasCode(err, 'ENOENT') ? 'absent' : 'unparsable', address: null };
  }
  try {
    const record: unknown = JSON.parse(text);
    const address = (record as { address?: unknown } | null)?.address;
    return typeof address === 'string' && ADDRESS_RE.test(address)
      ? { walletFile: 'present', address }
      : { walletFile: 'unparsable', address: null };
  } catch {
    return { walletFile: 'unparsable', address: null };
  }
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}
