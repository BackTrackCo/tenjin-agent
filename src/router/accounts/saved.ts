import { loadRawConfig, readPersonalRouter } from '../../lib/config';
import { isAccountUrl, type KeyScheme } from '../decision';
import { isAccountId } from './ids';

/**
 * THE ACCOUNTS SAVED IN `router.sources`, as this client reads them: a
 * descriptor names an account, where its server is and how it signs in, and
 * never holds a credential. Read leniently, one entry at a time: an entry
 * this build cannot use is skipped, never guessed at. Safe in a hook: the
 * config file alone, no OS store and no network.
 */

/** What a saved account descriptor holds. */
export interface SavedAccount {
  id: string;
  /** The account's name as the user reads it. */
  label: string;
  mcpUrl: string;
  signIn: 'oauth' | 'key';
  keyScheme?: KeyScheme;
  /** `tenjin`: when this account refuses a call, Tenjin's own tool for the
   *  same job runs in its place, and the receipt says so. Absent: the call
   *  stops and offers it. */
  onRefusal?: 'tenjin';
  /** The router's directory listed it as connectable when it was connected:
   *  Tenjin has jobs mapped to it. Only such an account is named to the
   *  router; one connected by an address alone stays on this machine. */
  mapped?: true;
}

/** Whether a saved descriptor, as the config holds it, is a mapped account. */
export const isMappedDescriptor = (entry: unknown): boolean =>
  entry !== null && typeof entry === 'object' && (entry as { mapped?: unknown }).mapped === true;

/** One saved descriptor, or undefined when this build cannot use it. */
export function savedAccountOf(entry: unknown): SavedAccount | undefined {
  if (entry === null || typeof entry !== 'object') return undefined;
  const { id, label, mcpUrl, signIn, keyScheme, onRefusal, mapped } = entry as Record<
    string,
    unknown
  >;
  if (typeof id !== 'string' || !isAccountId(id)) return undefined;
  if (typeof mcpUrl !== 'string' || !isAccountUrl(mcpUrl)) return undefined;
  return {
    id,
    label: typeof label === 'string' && label.length > 0 ? label : id,
    mcpUrl,
    signIn: signIn === 'key' ? 'key' : 'oauth',
    ...(keyScheme === 'Bearer' || keyScheme === 'Key' ? { keyScheme } : {}),
    ...(onRefusal === 'tenjin' ? { onRefusal } : {}),
    ...(mapped === true ? { mapped } : {}),
  };
}

/** Every usable saved account in a router block; none when the list itself
 *  cannot be read. */
export function savedAccountsIn(router: unknown): SavedAccount[] {
  const sources = readPersonalRouter(router).sources;
  return sources.status === 'ok' ? sources.saved.flatMap((e) => savedAccountOf(e) ?? []) : [];
}

/** The saved accounts in this data dir's global config. */
export async function savedAccounts(dataDir: string): Promise<SavedAccount[]> {
  try {
    return savedAccountsIn((await loadRawConfig(dataDir)).router);
  } catch {
    return [];
  }
}

/** One saved account by id, or undefined. */
export async function savedAccount(dataDir: string, id: string): Promise<SavedAccount | undefined> {
  return (await savedAccounts(dataDir)).find((account) => account.id === id);
}
