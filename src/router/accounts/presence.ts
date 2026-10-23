import { existsSync } from 'node:fs';
import { sourceVaultPath } from '../../lib/paths';
import { isAccountId } from './ids';

/**
 * WHICH SAVED ACCOUNTS ARE CONNECTED ON THIS MACHINE: a descriptor in
 * `router.sources` AND a vault here (decided37 #15). Safe in a hook: one stat
 * per saved account (at most 16), no OS-store read, no decrypt and no network.
 *
 * A descriptor alone is a setting, which can travel with the rest of the
 * file; the vault is this machine's sign-in. Only both together make an
 * account eligible, so a copied config never advertises an account this
 * machine cannot call. An expired sign-in stays connected: the router still
 * picks the account, and the call itself refuses and offers Tenjin's own tool.
 */
export function connectedSourceIds(dataDir: string, descriptorIds: readonly string[]): string[] {
  return descriptorIds.filter((id) => isAccountId(id) && existsSync(sourceVaultPath(id, dataDir)));
}
