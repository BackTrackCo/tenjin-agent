import { loadRawConfig } from '../lib/config';
import { configPath } from '../lib/paths';
import {
  admitRoutes,
  POLICY_VERSION,
  readsIdentity,
  scopeKey,
  type AccessRule,
  type RoutesVerdict,
} from './access';
import type {
  DecisionDeps,
  DirectoryListing,
  Identity,
  Target,
  WireOverride,
  WirePolicy,
} from './decision';
import { cachedDirectory, fetchDirectory, labelOf } from './directory';
import { personalSettings } from './settings';
import { savedAccounts } from './accounts/saved';
import type { FailStatus } from './tool';

/**
 * THE ONE PREDICATE EVERY EXECUTION PASSES before provider HTTP, credential
 * attachment, a payment reservation or a signature: what the user's saved
 * settings (and this request's own narrowing) say about the routes it would
 * take. Imported by `tool.ts` and `choices.ts` alone, so it stays in the
 * request tool's chunk; the hooks hold offers to the same rules through
 * `access.ts` directly, with no network.
 *
 * TWO STEPS. {@link admitByPolicy} runs once per execution: one offer, one
 * quote, or a whole compare or count group. When a rule reads identity and
 * what runs is a STORED spec, quote or group (made minutes ago, by another
 * catalog), it asks the router's free directory once, sending the revision of
 * the copy on disk, and holds each route to the catalog's current identity:
 * the same revision runs, a changed one or a service no longer listed is
 * `offer_stale`, and no answer is `policy_unverified`. The copy on disk is
 * never proof alone. Then the local rules are read again and every route is
 * held to them; one refused route refuses the whole execution, so a group is
 * never shrunk into a set nobody approved. {@link policyAtBoundary} runs at
 * every call boundary after that: the local file read again, with no network,
 * so a block another process saves mid-execution stops each call not yet sent.
 *
 * GLOBAL FILE ONLY, REREAD EVERY TIME, never cached: a project file cannot add
 * a rule, and a change made by `tenjin config` in another process applies to
 * the next call of a long-running `tenjin mcp`.
 */

/** Why an execution did not run, said to the user and the agent. */
export type PolicyCode = 'policy_invalid' | 'policy_unverified' | 'offer_stale' | 'policy_refused';

export interface PolicyRefusal {
  code: PolicyCode;
  status: FailStatus;
  reason: string;
  nextStep: string;
  /** The rule that refused it, on `policy_refused`. */
  rule?: AccessRule;
  /** A group refused whole: the members the rules would let run on their own. */
  allowed?: GroupMember[];
}

/** A member of a compare group, as the agent names it to run it alone. */
export interface GroupMember {
  key: string;
  label: string;
  id: string;
}

/** One route an execution would take: the identity its spec, quote or
 *  answer carries, and in a group the choice it is. */
export interface Route {
  identity?: Identity;
  member?: GroupMember;
}

/**
 * What one execution's admission established, carried to each of its call
 * boundaries. `current`: the identities in hand were current when it was
 * admitted (fresh from the router in this very call, or confirmed by the
 * directory now). A rule that starts reading identity mid-execution finds a
 * run that is not current and refuses its calls rather than trust an
 * identity nobody checked. `override` is this request's own narrowing.
 */
export interface PolicyRun {
  current: boolean;
  override?: WireOverride;
}

export type AdmitDeps = Pick<DecisionDeps, 'ctx' | 'baseUrl' | 'fetchImpl' | 'timeoutMs'>;

/** The saved rules as this client sends them, or why they cannot be read. */
export type LocalPolicy =
  { status: 'invalid'; problem: string } | { status: 'ok'; wire?: WirePolicy };

/** `router.policy` from the global file, read now. A file this build cannot
 *  read at all is as unreadable as a bad rule: nothing runs on a guess. */
export async function readLocalPolicy(dataDir: string): Promise<LocalPolicy> {
  try {
    const config = await loadRawConfig(dataDir);
    const { policy } = personalSettings(config.router, configPath(dataDir));
    if (policy.status === 'invalid') return { status: 'invalid', problem: policy.problem };
    return policy.status === 'ok' && policy.wire !== undefined
      ? { status: 'ok', wire: policy.wire }
      : { status: 'ok' };
  } catch (err) {
    return { status: 'invalid', problem: err instanceof Error ? err.message : String(err) };
  }
}

const NOTHING = 'Nothing was sent or paid.';
const HANDS_OFF = "Do not change Tenjin's settings yourself.";

export const POLICY_INVALID_REASON = `Your Tenjin settings can't be read, so Tenjin won't run services until they're fixed. ${NOTHING} Run \`tenjin config\` to see the problem.`;

export function policyInvalid(): PolicyRefusal {
  return {
    code: 'policy_invalid',
    status: 'failed',
    reason: POLICY_INVALID_REASON,
    nextStep: `Tell the user their Tenjin settings can't be read; \`tenjin config\` shows the problem. ${HANDS_OFF}`,
  };
}

/** No identity to hold to the rules, or no directory to confirm it. */
export function policyUnverified(): PolicyRefusal {
  return {
    code: 'policy_unverified',
    status: 'failed',
    reason: `Tenjin couldn't check this service against your settings, so it didn't run it. ${NOTHING} Try again in a moment, or ask again for a fresh offer.`,
    nextStep: 'Try again in a moment, or call request({query}) with the task for a fresh offer.',
  };
}

/** A router that answered a body carrying the user's settings with a 400:
 *  it cannot apply them, so it was not asked to route without them. */
export function settingsNotApplied(): PolicyRefusal {
  return {
    code: 'policy_unverified',
    status: 'failed',
    reason: `Tenjin couldn't apply your settings right now, so it didn't look this up. ${NOTHING}`,
    nextStep: 'Continue with your own tools for this step, or try again in a moment.',
  };
}

function offerStale(retired: boolean): PolicyRefusal {
  return retired
    ? {
        code: 'offer_stale',
        status: 'needs_input',
        reason: `That service is no longer available through Tenjin. ${NOTHING}`,
        nextStep:
          'Call request({query}) with the task for another service, or continue with your own tools.',
      }
    : {
        code: 'offer_stale',
        status: 'needs_input',
        reason: `This offer changed since Tenjin made it, so it didn't run. ${NOTHING} Ask again for a fresh offer.`,
        nextStep: 'Call request({query}) with the task for a fresh offer.',
      };
}

/** An open-Bazaar listing: never in the directory, so never revalidated, and
 *  held to the rules as the unreviewed route it is. */
const isBazaar = (identity: Identity) => identity.service.startsWith('discovered:');

const list = new Intl.ListFormat('en', { type: 'conjunction' });
const either = new Intl.ListFormat('en', { type: 'disjunction' });

/** Saved accounts' names by id, for an account the directory does not name
 *  (one connected by its address): readback never shows an id. */
type AccountNames = ReadonlyMap<string, string>;

async function accountNames(dataDir: string): Promise<AccountNames> {
  return new Map((await savedAccounts(dataDir)).map(({ id, label }) => [id, label]));
}

/** A target's name: the directory's, else a saved account's. */
function nameOf(target: Target, listing: DirectoryListing | undefined, names: AccountNames) {
  const label = labelOf(target, listing);
  return target.kind === 'source' && label === target.id ? (names.get(target.id) ?? label) : label;
}

/** The rule, as the user reads it: "your settings block Firecrawl". */
function ruleWords(
  rule: AccessRule,
  policy: WirePolicy | undefined,
  override: WireOverride | undefined,
  listing: DirectoryListing | undefined,
  names: AccountNames,
): string {
  const labelOf = (target: Target, from: DirectoryListing | undefined) =>
    nameOf(target, from, names);
  const named = (targets: readonly Target[]) =>
    list.format(targets.map((target) => labelOf(target, listing)));
  if (rule.kind === 'block' && rule.target !== undefined)
    return `your settings block ${labelOf(rule.target, listing)}`;
  if (rule.kind === 'unavailable' && rule.target !== undefined)
    return `${labelOf(rule.target, listing)} isn't connected on this machine`;
  if (rule.from === 'request') {
    const only = override?.only?.find(({ dimension }) => dimension === rule.dimension);
    return `this request allows only ${only !== undefined ? named(only.targets) : `some ${rule.dimension}s`}`;
  }
  const only =
    rule.scope !== undefined
      ? policy?.only?.find(
          ({ scope, dimension }) =>
            scopeKey(scope) === scopeKey(rule.scope!) && dimension === rule.dimension,
        )
      : undefined;
  if (only === undefined) return 'your settings rule it out';
  if (only.dimension === 'capability')
    return `your settings allow Tenjin only for ${named(only.targets)}`;
  return only.scope.kind === 'task'
    ? `your settings allow only ${named(only.targets)} for ${labelOf({ kind: 'task', id: only.scope.id }, listing)}`
    : `your settings allow only ${named(only.targets)}`;
}

function refused(
  verdict: Extract<RoutesVerdict, { rule: AccessRule }>,
  routes: readonly Route[],
  identities: readonly (Identity | undefined)[],
  policy: WirePolicy | undefined,
  override: WireOverride | undefined,
  listing: DirectoryListing | undefined,
  names: AccountNames,
): PolicyRefusal {
  const words = ruleWords(verdict.rule, policy, override, listing, names);
  const change =
    verdict.rule.from === 'request'
      ? 'Send the request without that limit if the user agrees.'
      : 'You can change this with `tenjin config`.';
  const step =
    verdict.rule.from === 'request'
      ? "Tell the user which limit stopped it, or send the request without it if they agree. Do not change Tenjin's settings."
      : `Tell the user which setting stopped it; they can change it with \`tenjin config\`. ${HANDS_OFF}`;
  const member = routes[verdict.index]?.member;
  if (member === undefined) {
    return {
      code: 'policy_refused',
      status: 'native',
      reason: `Tenjin didn't run this: ${words}. ${NOTHING} ${change}`,
      nextStep: step,
      rule: verdict.rule,
    };
  }
  // A GROUP IS REFUSED WHOLE, never shrunk: the user approved this set, and a
  // smaller one is a different purchase. What could run alone is named.
  const allowed = routes.flatMap((route, index) => {
    if (route.member === undefined) return [];
    return admitRoutes([identities[index]], policy, override).ok ? [route.member] : [];
  });
  const why =
    verdict.rule.kind === 'block' ? `used by ${member.label}` : `which rules out ${member.label}`;
  const alone =
    allowed.length > 0
      ? `You can run ${either.format(allowed.map(({ label }) => label))} on its own, or ${verdict.rule.from === 'request' ? 'send the request without that limit' : 'change your settings with `tenjin config`'}.`
      : change;
  return {
    code: 'policy_refused',
    status: 'native',
    reason: `Tenjin didn't run this set: ${words}, ${why}. ${NOTHING} ${alone}`,
    nextStep: step,
    rule: verdict.rule,
    allowed,
  };
}

/** The verdict as the refusal it is, named with the directory in hand or
 *  the copy on disk (names only: the copy decides nothing). */
async function refusalOf(
  verdict: Exclude<RoutesVerdict, { ok: true }>,
  routes: readonly Route[],
  identities: readonly (Identity | undefined)[],
  policy: WirePolicy | undefined,
  override: WireOverride | undefined,
  dataDir: string,
  listing?: DirectoryListing,
): Promise<PolicyRefusal> {
  if ('unverified' in verdict) return policyUnverified();
  return refused(
    verdict,
    routes,
    identities,
    policy,
    override,
    listing ?? (await cachedDirectory(dataDir)),
    await accountNames(dataDir),
  );
}

/** The rules with one more source available: an account the user named,
 *  which the caller found connected on this machine. The router is never told
 *  of an account it has no jobs for, so the rules it is sent leave it out. */
function withAccount(wire: WirePolicy | undefined, account: string | undefined) {
  if (account === undefined) return wire;
  const sources = [...new Set([...(wire?.sources ?? []), account])];
  return { ...(wire ?? { version: POLICY_VERSION }), sources } as WirePolicy;
}

/**
 * ONE EXECUTION, ADMITTED OR REFUSED, before anything is claimed, probed,
 * reserved or signed. `stored`: what runs was kept from an earlier answer (a
 * spec, a quote, a group), so a rule that reads identity needs the catalog's
 * word that the identity still holds. A fresh answer from this same call
 * needs none. `account`: an account the user named, connected here, which
 * counts as available whether or not the rules sent to the router name it.
 */
export async function admitByPolicy(
  routes: readonly Route[],
  deps: AdmitDeps,
  opts: { stored: boolean; override?: WireOverride; account?: string },
): Promise<{ run: PolicyRun } | { refused: PolicyRefusal }> {
  const { dataDir } = deps.ctx;
  const { override } = opts;
  const withOverride = override !== undefined ? { override } : {};
  const read = async (): Promise<LocalPolicy> => {
    const local = await readLocalPolicy(dataDir);
    return local.status === 'ok'
      ? { ...local, wire: withAccount(local.wire, opts.account) }
      : local;
  };
  const before = await read();
  if (before.status === 'invalid') return { refused: policyInvalid() };
  const identities = routes.map(({ identity }) => identity);
  if (!readsIdentity(before.wire, override)) {
    // No rule reads identity: only a route's own source can stop it.
    const verdict = admitRoutes(identities, before.wire, override);
    if (!verdict.ok)
      return {
        refused: await refusalOf(verdict, routes, identities, before.wire, override, dataDir),
      };
    return { run: { current: !opts.stored, ...withOverride } };
  }
  // A route with no identity cannot be held to a rule that reads one, and no
  // directory call changes that.
  if (identities.some((identity) => identity === undefined)) {
    return { refused: policyUnverified() };
  }
  let listing: DirectoryListing | undefined;
  const current = [...(identities as Identity[])];
  if (opts.stored && current.some((identity) => !isBazaar(identity))) {
    // ONE CALL FOR THE WHOLE EXECUTION, every member of a group checked
    // against the same answer. Free: no gate, no model, no payment.
    const fetched = await fetchDirectory(dataDir, deps);
    if (!fetched.ok) return { refused: policyUnverified() };
    listing = fetched.listing;
    for (const [index, identity] of current.entries()) {
      if (isBazaar(identity)) continue;
      const retired = listing.retired.some(
        ({ kind, id }) => kind === 'service' && id === identity.service,
      );
      const live = listing.services.find(({ id }) => id === identity.service);
      if (retired || live === undefined) return { refused: offerStale(true) };
      if (live.identity.revision !== identity.revision) return { refused: offerStale(false) };
      current[index] = live.identity;
    }
  }
  // The rules as they are NOW, after the network call: a block saved while
  // the directory answered is the one that counts.
  const after = await read();
  if (after.status === 'invalid') return { refused: policyInvalid() };
  const verdict = admitRoutes(current, after.wire, override);
  if (!verdict.ok)
    return {
      refused: await refusalOf(verdict, routes, current, after.wire, override, dataDir, listing),
    };
  return { run: { current: true, ...withOverride } };
}

/**
 * ONE CALL BOUNDARY: the rules reread from the file, no network, right before
 * the call is sent and its payment signed, or before a group's members are
 * probed for their live prices, which is provider HTTP too. A run admitted
 * with no rule reading identity that now meets one holds an identity nobody
 * checked against the catalog: it stops rather than trust it. Null: the call
 * may go.
 */
export async function policyAtBoundary(
  routes: readonly Route[],
  run: PolicyRun | undefined,
  dataDir: string,
): Promise<PolicyRefusal | null> {
  const local = await readLocalPolicy(dataDir);
  if (local.status === 'invalid') return policyInvalid();
  const override = run?.override;
  const identities = routes.map(({ identity }) => identity);
  const verdict = admitRoutes(identities, local.wire, override);
  if (!verdict.ok) return refusalOf(verdict, routes, identities, local.wire, override, dataDir);
  if (readsIdentity(local.wire, override) && run?.current !== true) return policyUnverified();
  return null;
}

/**
 * A `{tool}` id the saved rules already refuse, known with no network: a block
 * on that very service, or the identity the copy on disk lists for it. The
 * copy only ever refuses here; it never lets anything run.
 */
export async function knownRefused(
  service: string,
  dataDir: string,
): Promise<PolicyRefusal | null> {
  const local = await readLocalPolicy(dataDir);
  if (local.status === 'invalid') return policyInvalid();
  if (!readsIdentity(local.wire)) return null;
  const listing = await cachedDirectory(dataDir);
  const known = listing?.services.find(({ id }) => id === service)?.identity;
  const blocked = local.wire?.block?.find(({ kind, id }) => kind === 'service' && id === service);
  const verdict: RoutesVerdict =
    known !== undefined
      ? admitRoutes([known], local.wire)
      : blocked !== undefined
        ? { ok: false, index: 0, rule: { from: 'saved', kind: 'block', target: blocked } }
        : { ok: true };
  if (verdict.ok || 'unverified' in verdict) return null;
  return refused(
    verdict,
    [{}],
    [known],
    local.wire,
    undefined,
    listing,
    await accountNames(dataDir),
  );
}
