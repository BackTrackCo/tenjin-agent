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
 * Where the Windows DPAPI-protected wallet passphrase blob lives. The file holds
 * a DPAPI CurrentUser ciphertext, not the passphrase in plaintext, and is only
 * ever written on win32; other platforms use their own OS store.
 */
export function passphraseBlobPath(dir: string = dataDir()): string {
  return join(dir, 'passphrase.dpapi');
}
