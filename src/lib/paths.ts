import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where the CLI keeps its config and wallet. Defaults to ~/.tenjin, overridable
 * via TENJIN_DATA_DIR (CI, ephemeral agents, and every test — which point it at
 * a temp dir so the real home is never touched).
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.TENJIN_DATA_DIR;
  // Absolute, always: the daemon compares this string against its own
  // `data_dir` and is spawned with it as `cwd`, so a relative override must
  // mean the same directory from every process.
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
 * Which searchIds the Stop hook has already nagged about, so each open loop is
 * raised once per turn-end rather than every turn.
 *
 * Not atomic, deliberately: two sessions ending at the same instant can both read
 * this file before either writes, and one loop is then named twice. The cost is a
 * duplicate line, and serializing it would put a cross-process wait at the end of
 * every turn to buy nothing but tidiness.
 *
 * STILL A FILE, and the last of the hook state that is. The searches it nags
 * about moved into `state.db` (tenjin-agent#209); this did not, because the plan
 * scopes it to a follow-up along with `hook-health.json`. Nothing but the Stop
 * hook writes it, and losing it costs one repeated nag.
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

/**
 * The loop daemon's own state, all under the data dir (tenjin-notes
 * loop-redesign/02-redesign.md §4, §10). `loop.db` is a NEW file beside
 * `state.db`, never a rename: the old hook scripts keep writing `state.db`
 * until PR E deletes them, and a rename would strand their WAL frames.
 */
export function loopDbPath(dir: string = dataDir()): string {
  return join(dir, 'loop.db');
}

/** 32 random bytes, hex, 0600. Minted by `tenjin daemon start`, rotated only by
 *  reinstall, NEVER deleted by the daemon: every transport reads it, and an idle
 *  exit that removed it would strand them all. */
export function daemonTokenPath(dir: string = dataDir()): string {
  return join(dir, 'daemon.token');
}

/** `{ pid, port, started_at, data_dir }`, advisory: written after the bind,
 *  removed at exit only by the process whose pid it names. Liveness is
 *  `GET /health`, never this file alone. */
export function daemonPidPath(dir: string = dataDir()): string {
  return join(dir, 'daemon.pid');
}

/** Where a detached daemon's stdout and stderr go, and where the shim writes its
 *  one `daemon-down` line when it cannot reach one. */
export function daemonLogPath(dir: string = dataDir()): string {
  return join(dir, 'daemon.log');
}

/** An empty file whose mtime is the last spawn attempt; the shim's backoff. */
export function daemonSpawnPath(dir: string = dataDir()): string {
  return join(dir, 'daemon.spawn');
}

/** The single-file daemon bundle `tenjin daemon start` copies from `dist`. */
export function daemonBundlePath(dir: string = dataDir()): string {
  return join(hooksDir(dir), 'tenjin-daemon.mjs');
}

/** The ensure-and-forward shim the two `command` hook entries run. */
export function shimBundlePath(dir: string = dataDir()): string {
  return join(hooksDir(dir), 'tenjin-shim.mjs');
}
