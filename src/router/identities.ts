import { join } from 'node:path';
import type { CommandContext } from '../context';
import { parseIdentities, requestIdentities, type IdentitiesResponse } from './decision';
import { BUILT_IN_SOURCE, type Target, type TargetKind } from './settings-wire';
import { readJsonFile, writePrivate } from './store-files';

/**
 * EVERY ID A SETTING CAN NAME, for `tenjin config` (plan 36). A typed name
 * ("Exa", "images", "web research") resolves against the router's free
 * identities read before anything is written, and readback names saved rules
 * by the labels in it. It never decides anything: the server applies the
 * rules, and this only turns the user's words into canonical ids.
 *
 * KEPT FOR OFFLINE USE. Each read is saved under the data dir, so showing,
 * unblocking and resetting saved rules work with no network, naming what they
 * can and falling back to the saved id where nothing is known. A copy here is
 * never proof the catalog is current; only a write resolves against a fresh
 * read.
 */

const CACHE_FILE = 'router-identities.json';
const MAX_CACHE_BYTES = 4 * 1024 * 1024;

export type Identities = IdentitiesResponse;

/** One id with its label, of any kind. */
export interface Named {
  id: string;
  label: string;
}

/** What a person calls each kind. A source is one of "your accounts". */
export const KIND_NOUN: Record<TargetKind, string> = {
  category: 'category',
  task: 'task',
  provider: 'provider',
  seller: 'seller',
  service: 'service',
  source: 'account',
};

/** Tenjin's own catalog, by the one name a person sees. */
const BUILT_IN_LABEL = "Tenjin's tools";

/** The router's identities now, kept for offline use, or why not. */
export async function fetchIdentities(
  ctx: CommandContext,
  deps: { baseUrl: string; fetchImpl?: typeof fetch },
): Promise<
  { ok: true; identities: Identities } | { ok: false; reason: string; unreachable?: true }
> {
  const read = await requestIdentities({
    ctx,
    baseUrl: deps.baseUrl,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (read.status === 'skipped') return { ok: false, reason: read.why };
  if (read.status === 'failed') {
    return {
      ok: false,
      reason: read.reason,
      ...(read.unreachable === true ? { unreachable: true as const } : {}),
    };
  }
  try {
    await writePrivate(join(ctx.dataDir, CACHE_FILE), JSON.stringify(read.decision));
  } catch {
    // Offline labels are a convenience: a lost copy names saved rules by id.
  }
  return { ok: true, identities: read.decision };
}

/** The identities last fetched, or undefined: none kept, damaged or unreadable. */
export async function cachedIdentities(dataDir: string): Promise<Identities | undefined> {
  return parseIdentities(await readJsonFile(join(dataDir, CACHE_FILE), MAX_CACHE_BYTES));
}

/** Every entry of one kind, labelled. */
export function entriesOf(identities: Identities | undefined, kind: TargetKind): Named[] {
  if (identities === undefined) {
    return kind === 'source' ? [{ id: BUILT_IN_SOURCE, label: BUILT_IN_LABEL }] : [];
  }
  switch (kind) {
    case 'category':
      return identities.categories;
    case 'task':
      return identities.tasks;
    case 'provider':
      return identities.providers;
    case 'seller':
      return identities.sellers;
    case 'service':
      return identities.services;
    case 'source':
      return identities.sources.some(({ id }) => id === BUILT_IN_SOURCE)
        ? identities.sources
        : [{ id: BUILT_IN_SOURCE, label: BUILT_IN_LABEL }, ...identities.sources];
  }
}

/** A target as a person reads it: its label, else its id. */
export function labelOf(target: Target, identities: Identities | undefined): string {
  if (target.kind === 'source' && target.id === BUILT_IN_SOURCE) return BUILT_IN_LABEL;
  return entriesOf(identities, target.kind).find(({ id }) => id === target.id)?.label ?? target.id;
}

/** A typed name or label as names compare: trimmed, in one case. */
export const folded = (text: string): string => text.trim().toLowerCase();

export type Resolved =
  | { status: 'match'; target: Target; label: string }
  | { status: 'ambiguous'; candidates: Named[] }
  | { status: 'unknown'; candidates: Named[] };

/** At most this many names come back as candidates. */
const MAX_CANDIDATES = 8;

/**
 * A TYPED NAME, RESOLVED OR NOT: the exact id first; then an id or label equal
 * to it ignoring case, which must be unique. Two that match are ambiguous and
 * one that matches nothing is unknown: both come back with candidates and
 * nothing is written. No fuzzy match ever writes a rule.
 */
export function resolveName(identities: Identities, kind: TargetKind, name: string): Resolved {
  const entries = entriesOf(identities, kind);
  const exact = entries.find(({ id }) => id === name);
  if (exact !== undefined) return matched(kind, exact);
  const wanted = folded(name);
  const same = entries.filter(({ id, label }) => folded(id) === wanted || folded(label) === wanted);
  const unique = [...new Map(same.map((entry) => [entry.id, entry])).values()];
  if (unique.length === 1) return matched(kind, unique[0]!);
  if (unique.length > 1)
    return { status: 'ambiguous', candidates: unique.slice(0, MAX_CANDIDATES) };
  const near = entries.filter(
    ({ id, label }) =>
      wanted.length > 0 &&
      (folded(id).includes(wanted) ||
        folded(label).includes(wanted) ||
        wanted.includes(folded(label))),
  );
  return { status: 'unknown', candidates: near.slice(0, MAX_CANDIDATES) };
}

function matched(kind: TargetKind, entry: Named): Resolved {
  return { status: 'match', target: { kind, id: entry.id }, label: entry.label };
}

/** The tasks the speed preference changes, by label: those the identities
 *  read marks `speed`. Undefined when no identities are known. */
export function speedTasks(identities: Identities | undefined): string[] | undefined {
  return identities?.tasks.filter(({ speed }) => speed === true).map(({ label }) => label);
}

/** The tasks a category holds, by label, from the identities read. */
export function tasksOf(category: string, identities: Identities | undefined): string[] {
  const tasks = identities?.categories.find(({ id }) => id === category)?.tasks ?? [];
  return tasks.map((id) => labelOf({ kind: 'task', id }, identities));
}

/**
 * THE CATALOG SERVICES A TARGET NAMES, for readback only: a provider's routes
 * (resellers included), a seller's, a task's, a category's and a service
 * itself. Display, never enforcement: the server decides what a rule covers,
 * every time it decides.
 */
export function servicesNaming(target: Target, identities: Identities | undefined): Named[] {
  if (identities === undefined) return [];
  const { services } = identities;
  switch (target.kind) {
    case 'provider':
      return services.filter(({ providers }) => providers.includes(target.id));
    case 'seller':
      return services.filter(({ seller }) => seller === target.id);
    case 'service':
      return services.filter(({ id }) => id === target.id);
    case 'task':
      return services.filter(({ task }) => task === target.id);
    case 'category': {
      const tasks = new Set(identities.categories.find(({ id }) => id === target.id)?.tasks ?? []);
      return services.filter(({ task }) => task !== undefined && tasks.has(task));
    }
    case 'source':
      return [];
  }
}

/** Whether the identities read still lists a saved id; unknown when none is kept. */
export function isListed(target: Target, identities: Identities | undefined): boolean | undefined {
  if (identities === undefined) return undefined;
  return entriesOf(identities, target.kind).some(({ id }) => id === target.id);
}

/** The services Tenjin maps on a connected account, in the identities read:
 *  `<account>.<key>`, sold by the account. */
export function accountServices(
  id: string,
  identities: Identities | undefined,
): Identities['services'] {
  return (identities?.services ?? []).filter(
    (service) => service.seller === id && service.id.startsWith(`${id}.`),
  );
}

/** The jobs Tenjin maps on a connected account, by their task's label
 *  ({@link accountServices}). Display only: the server decides what runs
 *  where. */
export function accountJobs(id: string, identities: Identities | undefined): string[] {
  const tasks = new Map((identities?.tasks ?? []).map((task) => [task.id, task.label]));
  const jobs = accountServices(id, identities).flatMap(({ task }) =>
    task !== undefined ? [tasks.get(task) ?? task] : [],
  );
  return [...new Set(jobs)].map((job) => job.charAt(0).toLowerCase() + job.slice(1));
}
