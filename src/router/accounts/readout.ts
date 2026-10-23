import { readPersonalRouter } from '../../lib/config';
import { scopeKey } from '../access';
import { readVaultHeader } from './vault';
import { savedAccountsIn } from './saved';

/**
 * THE USER'S CONNECTED ACCOUNTS AS `tenjin status` SHOWS THEM: their names,
 * whether each comes first for its jobs, whether its sign-in on this machine
 * still works, and what happens when it refuses. Read from the config file and
 * each vault's plaintext header: no key, no OS store, no network.
 */

export interface AccountStatus {
  id: string;
  label: string;
  /** In the account-wide preference: used first for the jobs it can do. */
  preferred: boolean;
  /** `ok`; `expired`: a refresh was refused; `signed_out`: no sign-in here. */
  signIn: 'ok' | 'expired' | 'signed_out';
  onRefusal: 'tenjin' | 'ask';
}

const list = new Intl.ListFormat('en', { type: 'conjunction' });

/** Every saved account, as status reads it. */
export async function accountStatuses(dataDir: string, router: unknown): Promise<AccountStatus[]> {
  const policy = readPersonalRouter(router).policy;
  const global =
    policy.status === 'ok'
      ? policy.saved.prefer?.find(({ scope }) => scopeKey(scope) === 'global')
      : undefined;
  const preferred = new Set(
    global?.targets.filter(({ kind }) => kind === 'source').map(({ id }) => id) ?? [],
  );
  return Promise.all(
    savedAccountsIn(router).map(async (account) => {
      const header = await readVaultHeader(dataDir, account.id).catch(() => null);
      return {
        id: account.id,
        label: account.label,
        preferred: preferred.has(account.id),
        signIn: header === null ? 'signed_out' : header.state === 'expired' ? 'expired' : 'ok',
        onRefusal: account.onRefusal ?? 'ask',
      };
    }),
  );
}

/** The accounts as lines a person reads: who pays, and what needs doing. */
export function accountLines(accounts: readonly AccountStatus[]): string[] {
  if (accounts.length === 0)
    return ['Your accounts: none connected (`tenjin connect <name>` adds one)'];
  const first = accounts.filter(({ preferred }) => preferred).map(({ label }) => label);
  const rest = accounts.filter(({ preferred }) => !preferred).map(({ label }) => label);
  const named = [
    ...(first.length > 0 ? [`${list.format(first)} (used first for jobs they can do)`] : []),
    ...(rest.length > 0 ? [`${list.format(rest)} (not put first)`] : []),
  ];
  return [
    `Your accounts: ${named.join('; ')}. Billed to your own plans, not counted in the limit.`,
    ...accounts.flatMap(({ id, label, signIn, onRefusal }) => [
      ...(signIn === 'expired'
        ? [`  ${label}'s sign-in has expired: \`tenjin connect ${id}\` reconnects it.`]
        : signIn === 'signed_out'
          ? [`  ${label} isn't signed in on this machine: \`tenjin connect ${id}\`.`]
          : []),
      ...(onRefusal === 'tenjin'
        ? [`  When ${label} refuses a call, Tenjin's own tool runs in its place.`]
        : []),
    ]),
  ];
}
