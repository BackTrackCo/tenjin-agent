import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

/**
 * WHETHER A SERVICE ON A CONNECTED ACCOUNT CANNOT RUN HERE: the connect-time
 * check found this account lacks its tool (a higher plan, say), or there is no
 * sign-in here whose header can be read. Either way it is left out of what is
 * offered, rather than leading its task and failing when called. The vault's
 * plaintext header alone: no key, no OS store, no network, so a hook may ask.
 */
export async function accountLacks(
  dataDir: string,
  identity: { source: string; service: string },
): Promise<boolean> {
  if (!isAccountId(identity.source)) return true;
  try {
    const file = JSON.parse(await readFile(sourceVaultPath(identity.source, dataDir), 'utf8')) as {
      header?: { id?: unknown; missing?: unknown };
    };
    const missing = file.header?.missing;
    if (file.header?.id !== identity.source || !Array.isArray(missing)) return true;
    return missing.includes(identity.service);
  } catch {
    return true;
  }
}
