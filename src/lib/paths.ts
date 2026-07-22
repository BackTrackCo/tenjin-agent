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
 * Where the Windows DPAPI-protected wallet passphrase blob lives. The file holds
 * a DPAPI CurrentUser ciphertext, not the passphrase in plaintext, and is only
 * ever written on win32; other platforms use their own OS store.
 */
export function passphraseBlobPath(dir: string = dataDir()): string {
  return join(dir, 'passphrase.dpapi');
}
