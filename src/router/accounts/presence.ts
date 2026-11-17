import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { sourceVaultPath } from '../../lib/paths';
import type { AccountCall } from '../decision';
import { isAccountId } from './ids';

/**
 * WHICH SAVED ACCOUNTS ARE CONNECTED ON THIS MACHINE: a descriptor in
 * `router.sources` AND a vault here. Safe in a hook: one stat per saved
 * account (at most 16), no OS-store read, no decrypt and no network.
 *
 * A descriptor alone is a setting, which can travel with the rest of the
 * file; the vault is this machine's sign-in. Only both together make an
 * account eligible, so a copied config never names an account this machine
 * cannot call. An expired sign-in stays connected: the router still picks the
 * account, and the call itself refuses and offers Tenjin's own tool.
 */
export function connectedSourceIds(dataDir: string, descriptorIds: readonly string[]): string[] {
  return descriptorIds.filter((id) => isAccountId(id) && existsSync(sourceVaultPath(id, dataDir)));
}

/** Every tool a call makes: the call, its poll and its follow-up. */
export function toolsOf(call: AccountCall): string[] {
  return [call.tool, call.next?.poll?.tool, call.next?.tool].filter(
    (tool): tool is string => tool !== undefined,
  );
}

/**
 * WHETHER A SERVICE ON A CONNECTED ACCOUNT CANNOT RUN HERE: the connect-time
 * check found this account lacks a tool its call makes (a higher plan, say),
 * or there is no sign-in here whose header can be read. Either way it is left
 * out of what is offered, rather than leading its task and failing when
 * called. The vault's plaintext header alone: no key, no OS store, no
 * network, so a hook may ask.
 */
export async function accountLacks(
  dataDir: string,
  spec: { source: string; mcp: AccountCall },
): Promise<boolean> {
  if (!isAccountId(spec.source)) return true;
  try {
    const file = JSON.parse(await readFile(sourceVaultPath(spec.source, dataDir), 'utf8')) as {
      header?: { id?: unknown; missingTools?: unknown };
    };
    const missing = file.header?.missingTools;
    if (file.header?.id !== spec.source || !Array.isArray(missing)) return true;
    return toolsOf(spec.mcp).some((tool) => missing.includes(tool));
  } catch {
    return true;
  }
}
