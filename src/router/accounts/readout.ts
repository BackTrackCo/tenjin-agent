import { readPersonalRouter } from '../../lib/config';
import { scopeKey } from '../access';
import type { Connectable, DirectoryListing } from '../decision';
import { readVaultHeader } from './vault';
import { savedAccountsIn } from './saved';

/**
 * THE USER'S CONNECTED ACCOUNTS AS `tenjin status` SHOWS THEM: their names,
 * whether each comes first for its jobs, which jobs those are, whether its
 * sign-in on this machine still works, and what happens when it refuses. Read
 * from the config file, each vault's plaintext header and the directory's copy
 * on disk: no key, no OS store, no network.
 */

/**
 * WHAT A CONNECTED ACCOUNT DOES, BY JOB, as `tenjin connect` and `tenjin
 * status` both name it. A job sits in the first group one of its services
 * reaches:
 * - `first`: checked, and the account-wide preference puts it first (the
 *   account is in it, and the catalog marks the service `useFirst`);
 * - `available`: checked, and runs without coming first;
 * - `unchecked`: no real call has checked it yet, so it runs only when named;
 * - `missing`: this account lacks its tool, so it is left out here.
 */
export interface AccountJobs {
  first: string[];
  available: string[];
  unchecked: string[];
  missing: string[];
}

const GROUPS = ['first', 'available', 'unchecked', 'missing'] as const;

export function accountJobs(
  services: Connectable['services'],
  checked: { ready: readonly string[]; missing: readonly string[] },
  listing: Pick<DirectoryListing, 'services'>,
  preferred: boolean,
): AccountJobs {
  const task = new Map(listing.services.map(({ id, identity }) => [id, identity.task]));
  const ready = new Set(checked.ready);
  const lacking = new Set(checked.missing);
  const placed = new Map<string, (typeof GROUPS)[number]>();
  for (const service of services) {
    const job = task.get(service.id);
    const group = ready.has(service.id)
      ? !service.verified
        ? 'unchecked'
        : preferred && service.useFirst
          ? 'first'
          : 'available'
      : lacking.has(service.id)
        ? 'missing'
        : undefined;
    if (job === undefined || group === undefined) continue;
    const before = placed.get(job);
    if (before === undefined || GROUPS.indexOf(group) < GROUPS.indexOf(before))
      placed.set(job, group);
  }
  const jobs: AccountJobs = { first: [], available: [], unchecked: [], missing: [] };
  for (const [job, group] of placed) jobs[group].push(job);
  return jobs;
}

export interface AccountStatus {
  id: string;
  label: string;
  /** In the account-wide preference: used first for the jobs it can do. */
  preferred: boolean;
  /** `ok`; `expired`: a refresh was refused; `signed_out`: no sign-in here. */
  signIn: 'ok' | 'expired' | 'signed_out';
  onRefusal: 'tenjin' | 'ask';
  /** Its jobs, for a mapped account signed in here while the directory's
   *  copy lists it. */
  jobs?: AccountJobs;
}

const list = new Intl.ListFormat('en', { type: 'conjunction' });

/** Every saved account, as status reads it. */
export async function accountStatuses(
  dataDir: string,
  router: unknown,
  listing?: DirectoryListing,
): Promise<AccountStatus[]> {
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
      const listed = listing?.connectable?.find(({ id }) => id === account.id);
      return {
        id: account.id,
        label: account.label,
        preferred: preferred.has(account.id),
        signIn: header === null ? 'signed_out' : header.state === 'expired' ? 'expired' : 'ok',
        onRefusal: account.onRefusal ?? 'ask',
        ...(account.mapped === true &&
        header !== null &&
        listing !== undefined &&
        listed !== undefined
          ? { jobs: accountJobs(listed.services, header, listing, preferred.has(account.id)) }
          : {}),
      };
    }),
  );
}

/** An account's jobs in full, one line per group: the connect readback names
 *  a few and points here. */
function jobLines(label: string, jobs: AccountJobs): string[] {
  const { first, available, unchecked, missing } = jobs;
  return [
    ...(first.length > 0 ? [`  ${label} is used first for ${list.format(first)}.`] : []),
    ...(available.length > 0
      ? [
          `  ${label} is ${first.length > 0 ? 'also ' : ''}available for ${list.format(available)}, without coming first.`,
        ]
      : []),
    ...(unchecked.length > 0
      ? [
          `  ${label} runs for ${list.format(unchecked)} only when you ask for it by name: Tenjin hasn't checked ${unchecked.length === 1 ? 'that job' : 'those jobs'} yet.`,
        ]
      : []),
    ...(missing.length > 0 ? [`  This ${label} account can't do ${list.format(missing)}.`] : []),
  ];
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
    ...accounts.flatMap(({ id, label, signIn, onRefusal, jobs }) => [
      ...(jobs !== undefined ? jobLines(label, jobs) : []),
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
