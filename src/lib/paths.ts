import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the CLI keeps its config and wallet. Defaults to ~/.tenjin, overridable
 * via TENJIN_DATA_DIR (CI, ephemeral agents, and every test — which point it at
 * a temp dir so the real home is never touched).
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TENJIN_DATA_DIR;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), '.tenjin');
}

export function configPath(dir: string = dataDir()): string {
  return join(dir, 'config.json');
}

export function walletPath(dir: string = dataDir()): string {
  return join(dir, 'wallet.json');
}

/**
 * Where the delegated P-256 session key + its wallet-signed SIWX delegation are
 * cached (B3, D35). A short-lived (≤24h) hot key: lower stakes than wallet.json,
 * but still written 0600 and address-bound so a wallet change invalidates it.
 */
export function sessionPath(dir: string = dataDir()): string {
  return join(dir, 'session.json');
}

/**
 * Where the client-side rolling spend ledger lives (lib/wallet/spend.ts).
 *
 * Its own file, NOT session.json: the two schemas are incompatible and both
 * readers treat a parse failure as "absent", so a shared path meant each writer
 * silently destroyed the other's file — a session key wiped the spend window, and
 * the next spend wiped the session key.
 */
export function spendLedgerPath(dir: string = dataDir()): string {
  return join(dir, 'spend.json');
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
 * Where `install` writes the standalone harness hook scripts. Under the data dir
 * rather than the harness's own config directory: the scripts are ours, a harness
 * only ever holds the path to them, and one location serves every harness.
 */
export function hooksDir(dir: string = dataDir()): string {
  return join(dir, 'hooks');
}

/**
 * THE ONE PLACE each of these two names is written.
 *
 * They used to be literals here AND in lib/push-scripts.ts — the split justified
 * by keeping this foundational module clear of the generator-heavy
 * push-scripts/hook-scripts chain. The dependency only ever needed to point the
 * other way: this module imports nothing but `node:os` and `node:path`, so the
 * generators can import IT. Every reader of these paths fails closed to empty on
 * a rename, which is a sidecar that has quietly stopped seeing anything rather
 * than an error anybody notices.
 */
export const PUSH_LEDGER_FILE = 'push-ledger.jsonl';
export const PUSH_DIR_NAME = 'push';

/**
 * How long anything under the push dir survives: per-session working state, the
 * candidate cache, and the Stop hook's capture markers. ONE definition because
 * two writers prune that directory, and they split it by prefix — the push core
 * on every state save, which skips `capture-` entirely, and the Stop hook on its
 * own pass, which touches nothing else and is the only pruner a machine running
 * `hooks.capture` with `hooks.push` off ever gets. A day is short enough that the
 * inodes do not build up on a machine that never turns push on. It is NOT long
 * enough to guarantee a live session outlives it: a marker's mtime is pinned at
 * first ask, so the Stop pruner spares the running session's marker by id rather
 * than by age, and the push core stays off the prefix because it has no id.
 */
export const PUSH_STATE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The push experiment's decision ledger (docs/command-reference.md#push-experimental):
 *  one JSON line per push arm's decision, append-only. */
export function pushLedgerPath(dir: string = dataDir()): string {
  return join(dir, PUSH_LEDGER_FILE);
}

/** The push experiment's per-session working state and candidate cache: edits
 *  seen, packages seen, error signatures seen. */
export function pushDir(dir: string = dataDir()): string {
  return join(dir, PUSH_DIR_NAME);
}

/**
 * Which searchIds the Stop hook has already nagged about, so each open loop is
 * raised once per turn-end rather than every turn.
 *
 * Not atomic, deliberately: two sessions ending at the same instant can both read
 * this file before either writes, and one loop is then named twice. The cost is a
 * duplicate line, and taking the search store's lock here would put a
 * cross-process wait at the end of every turn to buy nothing but tidiness.
 *
 * Its own file, NOT a field in searches.json, and that separation is the whole
 * point: the hook runs outside the CLI with no access to the lock `recordSearch`
 * takes, so a hook writing searches.json could erase a search landing at the same
 * moment. Nothing but the hook writes this file, and losing it costs one repeated
 * nag rather than a lost search.
 */
export function nagStatePath(dir: string = dataDir()): string {
  return join(dir, 'hook-nags.json');
}

/**
 * How the marketplace has been answering the dispatch hook lately, so a run of
 * failures stops the arm instead of paying the fetch budget per subagent through
 * an outage. Same conventions as {@link nagStatePath}: hook-written, unlocked,
 * and cheap to lose, since a missing file reads as "healthy". Its own file
 * because two hooks writing one unlocked file would erase each other.
 */
export function hookHealthPath(dir: string = dataDir()): string {
  return join(dir, 'hook-health.json');
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
 * Where `wallet create --replace` parks the outgoing wallet's keystore, keyed by
 * its lowercase address so successive replaces can never collide. Together with
 * the wallet's per-address passphrase entry in the OS store, this file keeps the
 * replaced wallet's funds recoverable; it is never read by the active-wallet
 * path.
 */
export function archivedWalletPath(account: string, dir: string = dataDir()): string {
  return join(dir, `wallet.${account}.json.bak`);
}
