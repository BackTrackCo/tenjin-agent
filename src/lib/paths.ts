import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where the CLI keeps its config and wallet. Defaults to ~/.tenjin, overridable
 * via TENJIN_DATA_DIR (CI, ephemeral agents, and every test — which point it at
 * a temp dir so the real home is never touched).
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TENJIN_DATA_DIR;
  // Absolute, always: a relative override must mean the same directory from
  // every process, whatever its working directory.
  if (override !== undefined && override.length > 0) return resolve(override);
  return defaultDataDir();
}

/**
 * The data dir a run with no override resolves. Split out of {@link dataDir} so
 * a caller holding a home directory can ask whether some other profile IS the
 * default one, without a second copy of the `.tenjin` literal.
 */
export function defaultDataDir(home: string = homedir()): string {
  return join(home, '.tenjin');
}

/**
 * Tenjin's own runtime: copies of the CLI, the Node that runs them and the
 * plugin folder Claude Code loads, so neither an npm folder nor the `node` on
 * PATH has to outlive an upgrade. Only the default data dir has one; see
 * `src/lib/runtime.ts`.
 */
export function runtimeDir(dir: string = dataDir()): string {
  return join(dir, 'runtime');
}

/**
 * Where the `tenjin` launcher goes: `~/.local/bin`, the folder the XDG layout
 * and most shells' defaults already put on PATH, and none of a Node version
 * manager's.
 */
export function launcherDir(home: string = homedir()): string {
  return join(home, '.local', 'bin');
}

export function configPath(dir: string = dataDir()): string {
  return join(dir, 'config.json');
}

export function walletPath(dir: string = dataDir()): string {
  return join(dir, 'wallet.json');
}

/**
 * The anonymous install id sent to Tenjin as `tenjin-install-id` (lib/install-identity).
 * Under the data dir so it survives upgrades and reinstalls of the CLI itself.
 */
export function installIdPath(dir: string = dataDir()): string {
  return join(dir, 'install-id');
}

/**
 * Where the client-side rolling spend ledger lives (lib/wallet/spend.ts).
 *
 * Its own file, NOT `session.json`, which an earlier release cached a session
 * key in: the two schemas were incompatible and both readers treated a parse
 * failure as "absent", so a shared path meant each writer silently destroyed
 * the other's file.
 */
export function spendLedgerPath(dir: string = dataDir()): string {
  return join(dir, 'spend.json');
}

/**
 * The wallet's last USDC balance read (lib/usdc-balance). A pure cache, a
 * minute long: an unreadable file is simply read again from the chain.
 */
export function balanceCachePath(dir: string = dataDir()): string {
  return join(dir, 'balance.json');
}

/**
 * Where the once-a-day "a newer tenjin-cli exists" check caches the registry
 * answer. A pure cache: nothing here is authoritative, so an unreadable file is
 * simply re-fetched.
 */
export function updateCheckPath(dir: string = dataDir()): string {
  return join(dir, 'update-check.json');
}

/**
 * Where the LEGACY (pre-per-wallet) Windows DPAPI passphrase blob lives. The
 * file holds a DPAPI CurrentUser ciphertext, not the passphrase in plaintext.
 * New writes go to the per-wallet path below; this one is only read as a
 * migration fallback and removed after a verified per-wallet copy exists.
 */
export function passphraseBlobPath(dir: string = dataDir()): string {
  return join(dir, 'passphrase.dpapi');
}

/**
 * The per-wallet Windows DPAPI passphrase blob: one file per wallet address
 * (lowercase), so creating a new wallet never clobbers an old wallet's blob.
 * Only ever written on win32; other platforms use their own OS store.
 */
export function passphraseBlobPathFor(account: string, dir: string = dataDir()): string {
  return join(dir, `passphrase.${account}.dpapi`);
}

/**
 * The sidecar that records WHERE each wallet's passphrase was saved
 * (`src/lib/passphrase-record.ts`), keyed by lowercase address. A separate
 * file rather than a field in wallet.json, so the funded key file is never
 * rewritten and an older CLI still reads it. No sidecar means today's lookup
 * order, unchanged.
 */
export function passphraseRecordPath(dir: string = dataDir()): string {
  return join(dir, 'passphrase-store.json');
}

/**
 * The per-wallet passphrase FILE store: the plaintext passphrase, mode 0600 in
 * a 0700 directory, no trailing newline. Not encrypted; the same trade-off the
 * GitHub CLI makes with its `hosts.yml` token. Used only where no OS credential
 * store exists (headless Linux, WSL, a sandbox) or when the user chose
 * `--insecure-storage`; never as the fallback for a keychain that is merely
 * locked. One file per wallet address (lowercase), like the DPAPI blob above.
 */
export function passphraseFilePathFor(account: string, dir: string = dataDir()): string {
  return join(dir, `passphrase.${account}.plain`);
}

/**
 * Where `wallet create --replace` parks the outgoing wallet's keystore, keyed by
 * its lowercase address so successive replaces can never collide. Together with
 * the wallet's per-address passphrase entry in the OS store, this file keeps the
 * replaced wallet's funds recoverable; it is never read by the active-wallet
 * path.
 */
export function archivedWalletPath(account: string, dir: string = dataDir()): string {
  return join(dir, `wallet.${account}.json.bak`);
}

/**
 * Where a router lookup that bought a file (a sound, an image) saves it. The
 * bytes cannot ride in the tool result, so the result names this file instead.
 */
export function downloadsDir(dir: string = dataDir()): string {
  return join(dir, 'downloads');
}

/**
 * One JSON line per paid router call: what was bought, from whom, for how much,
 * the settlement it carried and the files it saved. The user's own record; only
 * reconcile reads it back (`tenjin payments reconcile`, and the `request` tool's
 * pass beside each lookup), to settle what was left unknown.
 */
export function paidLedgerPath(dir: string = dataDir()): string {
  return join(dir, 'paid', 'ledger.jsonl');
}

/**
 * One file per take of a paid router call whose seller was still working when
 * the call ended: where to poll, until when, and what it saved. `request({job})`
 * resumes from it in any later process.
 */
export function jobsDir(dir: string = dataDir()): string {
  return join(dir, 'jobs');
}

/**
 * One file per quote: a router call over the automatic limits, kept with its
 * exact plan until the user approves it, it runs once, or it expires.
 */
export function quotesDir(dir: string = dataDir()): string {
  return join(dir, 'quotes');
}
