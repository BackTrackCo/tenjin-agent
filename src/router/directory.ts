import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../lib/atomic-json';
import { directoryCachePath } from '../lib/paths';
import { BUILT_IN_SOURCE, type TargetKind } from './access';
import {
  parseDirectoryListing,
  requestDirectory,
  type DecisionDeps,
  type DirectoryListing,
  type Target,
} from './decision';

/**
 * THE CATALOG'S NAMES, FOR SETTINGS. `tenjin config` turns what a person typed
 * ("Exa", "Images", "web research") into the typed id a rule stores, and
 * readback turns a stored id back into the name a person reads. Both read the
 * router's free directory: no gate, no model, no payment.
 *
 * A copy is kept on disk so show, unblock and reset can name saved rules with
 * no network at all, and so a fresh fetch can send its revision and get
 * `unchanged` back. The copy is for names only. A name is resolved only
 * against a directory fetched in this same call (an `unchanged` answer counts),
 * never against the copy alone: an id the catalog retired since must not be
 * written as though it were live.
 */

/** The copy on disk, or nothing when there is none or it is unreadable. */
export async function cachedDirectory(dataDir: string): Promise<DirectoryListing | undefined> {
  try {
    return parseDirectoryListing(JSON.parse(await readFile(directoryCachePath(dataDir), 'utf8')));
  } catch {
    return undefined;
  }
}

export type DirectoryFetch =
  { ok: true; listing: DirectoryListing } | { ok: false; reason: string; unreachable?: true };

/**
 * The directory as the router has it now: one free call, sending the copy's
 * revision. `unchanged` makes the copy current for this call; a full answer
 * replaces the copy. A failure is never answered from the copy.
 */
export async function fetchDirectory(
  dataDir: string,
  deps: Pick<DecisionDeps, 'ctx' | 'baseUrl' | 'fetchImpl' | 'timeoutMs'>,
): Promise<DirectoryFetch> {
  const cached = await cachedDirectory(dataDir);
  const answer = await requestDirectory(cached?.revision, deps);
  if (answer.status !== 'decided') {
    return {
      ok: false,
      reason: answer.status === 'failed' ? answer.reason : answer.why,
      ...(answer.status === 'failed' && answer.unreachable === true
        ? { unreachable: true as const }
        : {}),
    };
  }
  const { directory } = answer.decision;
  if ('unchanged' in directory) {
    // An answer for a revision this client does not hold is not an answer.
    if (cached?.revision !== directory.revision)
      return { ok: false, reason: 'The router answered unchanged for a directory not held here.' };
    return { ok: true, listing: cached };
  }
  // A copy that cannot be written costs the next call a full answer, nothing more.
  await writeFileAtomic(directoryCachePath(dataDir), `${JSON.stringify(directory)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  }).catch(() => undefined);
  return { ok: true, listing: directory };
}

/** A typed id and the name a person reads for it. */
export interface Named {
  id: string;
  label: string;
}

/** What Tenjin's own catalog is called where no directory says so. */
export const BUILT_IN_SOURCE_LABEL = "Tenjin's tools";

/** The live entries of one kind. Saved account descriptors (#37) add their
 *  sources, named by their id until #37 gives them labels. */
export function entriesOf(
  listing: DirectoryListing,
  kind: TargetKind,
  localSources: readonly string[] = [],
): Named[] {
  switch (kind) {
    case 'category':
      return listing.categories.map(({ id, label }) => ({ id, label }));
    case 'task':
      return listing.tasks;
    case 'provider':
      return listing.providers;
    case 'seller':
      return listing.sellers;
    case 'service':
      return listing.services.map(({ id, label }) => ({ id, label }));
    case 'source': {
      const known = new Set(listing.sources.map(({ id }) => id));
      return [
        ...listing.sources,
        ...localSources.filter((id) => !known.has(id)).map((id) => ({ id, label: id })),
      ];
    }
  }
}

export type Resolution =
  | { status: 'match'; target: Target; label: string }
  | { status: 'ambiguous'; candidates: Named[] }
  | { status: 'retired'; entry: Named }
  | { status: 'unknown'; candidates: Named[] };

const folded = (text: string) => text.trim().toLowerCase();

/**
 * NAME RESOLUTION, as the contract fixes it. A live id of the kind is the
 * match; else one live entry whose label equals the name (case and outer
 * spaces aside); several such are ambiguous. Else a retired id or label of
 * the kind is `retired`; else `unknown`, with up to ten live entries whose id
 * or label contains the name. Only a match is ever written. Nothing here
 * guesses: no fuzzy match, no other kind.
 */
export function resolveName(
  listing: DirectoryListing,
  kind: TargetKind,
  name: string,
  localSources: readonly string[] = [],
): Resolution {
  const live = entriesOf(listing, kind, localSources);
  const exact = live.find(({ id }) => id === name);
  if (exact) return { status: 'match', target: { kind, id: exact.id }, label: exact.label };
  const wanted = folded(name);
  const labelled = live.filter(({ label }) => folded(label) === wanted);
  if (labelled.length === 1) {
    const [only] = labelled as [Named];
    return { status: 'match', target: { kind, id: only.id }, label: only.label };
  }
  if (labelled.length > 1) return { status: 'ambiguous', candidates: labelled };
  const retired = listing.retired.find(
    (entry) => entry.kind === kind && (entry.id === name || folded(entry.label) === wanted),
  );
  if (retired) return { status: 'retired', entry: { id: retired.id, label: retired.label } };
  return {
    status: 'unknown',
    candidates: live
      .filter(({ id, label }) => folded(id).includes(wanted) || folded(label).includes(wanted))
      .slice(0, 10),
  };
}

/** The name a person reads for a typed id: the directory's label, a retired
 *  one's, Tenjin's own source by name, else the id itself. */
export function labelOf(target: Target, listing: DirectoryListing | undefined): string {
  if (listing !== undefined) {
    const live = entriesOf(listing, target.kind).find(({ id }) => id === target.id);
    if (live) return live.label;
    const retired = listing.retired.find(
      ({ kind, id }) => kind === target.kind && id === target.id,
    );
    if (retired) return retired.label;
  }
  if (target.kind === 'source' && target.id === BUILT_IN_SOURCE) return BUILT_IN_SOURCE_LABEL;
  return target.id;
}

/** Whether a saved id is one the directory no longer lists as live. */
export function isRetired(target: Target, listing: DirectoryListing | undefined): boolean {
  if (listing === undefined) return false;
  if (target.kind === 'source' && target.id === BUILT_IN_SOURCE) return false;
  return !entriesOf(listing, target.kind).some(({ id }) => id === target.id);
}
