import { createHash } from 'node:crypto';
import type {
  Directory,
  Identity,
  OnlyRule,
  PreferRule,
  Scope,
  Target,
  WireOverride,
  WirePolicy,
} from './decision';

/**
 * WHAT THE USER'S ROUTING RULES ALLOW, ONE MEANING ON BOTH SIDES OF THE WIRE.
 * tenjin's `lib/x402-router/access.ts` gives {@link allowed} the same meaning,
 * and both suites run `fixtures/wire-policy-cases.json`, so a rule the server
 * enforces when it picks a service is the rule this client rechecks before it
 * pays, and the rule readback describes.
 *
 * HOOK-SAFE ON PURPOSE: it imports `node:crypto` and nothing else at run time
 * (the rest are type imports), so the hooks, the request tool and `tenjin
 * config` all load it without the wallet, the x402 SDK or the MCP SDK
 * (dist-chunks.test.ts). `decision.ts` builds its policy schemas from the
 * problem checks below, so the schema and the checks cannot drift apart.
 */

export const POLICY_VERSION = 1;
/** The serialized wire policy's bound, the server's to the byte. */
export const POLICY_MAX_BYTES = 16 * 1024;
/** The execution source of every catalog service and every open-Bazaar
 *  listing, paid from the Tenjin balance: always available, so never listed. */
export const BUILT_IN_SOURCE = 'tenjin';
export const TARGET_KINDS = [
  'category',
  'task',
  'provider',
  'seller',
  'service',
  'source',
] as const;
export const ONLY_DIMENSIONS = ['capability', 'provider', 'seller', 'service'] as const;

export type TargetKind = (typeof TARGET_KINDS)[number];
export type OnlyDimension = (typeof ONLY_DIMENSIONS)[number];

/** The target kinds an only rule on each dimension names. */
export const ONLY_KINDS: Record<OnlyDimension, readonly TargetKind[]> = {
  capability: ['category', 'task'],
  provider: ['provider'],
  seller: ['seller'],
  service: ['service'],
};
/** A task's preference, and a request's, ranks by one of these. */
export const PREFER_KINDS: readonly TargetKind[] = ['provider', 'service', 'source'];

/** One thing wrong with a policy or an override, where it is. */
export interface Problem {
  message: string;
  path: (string | number)[];
}

const duplicated = (keys: readonly string[]) => new Set(keys).size !== keys.length;
export const targetKey = ({ kind, id }: Target) => `${kind}:${id}`;
export const scopeKey = (scope: Scope) => (scope.kind === 'global' ? 'global' : `task:${scope.id}`);

function onlyProblem(dimension: OnlyDimension, targets: readonly Target[]): string | undefined {
  if (!targets.every(({ kind }) => ONLY_KINDS[dimension].includes(kind)))
    return `an only rule on ${dimension} names ${ONLY_KINDS[dimension].join(' or ')} targets`;
  return duplicated(targets.map(targetKey)) ? 'a target is named twice' : undefined;
}

function preferProblem(
  targets: readonly Target[],
  kinds: readonly TargetKind[],
): string | undefined {
  const [first] = targets;
  if (first && targets.some(({ kind }) => kind !== first.kind))
    return 'a preference names targets of one kind';
  if (first && !kinds.includes(first.kind))
    return `this preference names ${kinds.join(', ')} targets`;
  return duplicated(targets.map(targetKey)) ? 'a target is named twice' : undefined;
}

/**
 * Rules 1 to 5 of the contract, the checks the server's `policySchema` runs:
 * a capability only is global and names categories or tasks; one only per
 * scope and dimension; a preference is one kind, `source` when global; no
 * target or source twice and no `tenjin` among the sources; and the whole
 * policy fits {@link POLICY_MAX_BYTES} serialized. They run on a value that
 * may have failed only a bound, so an empty list never throws.
 */
export function policyProblems(policy: {
  sources?: readonly string[] | undefined;
  block?: readonly Target[] | undefined;
  only?: readonly OnlyRule[] | undefined;
  prefer?: readonly PreferRule[] | undefined;
}): Problem[] {
  const problems: Problem[] = [];
  const problem = (message: string | undefined, path: (string | number)[] = []) => {
    if (message) problems.push({ message, path });
  };
  if (Buffer.byteLength(JSON.stringify(policy), 'utf8') > POLICY_MAX_BYTES)
    problem(`policy must serialize to at most ${POLICY_MAX_BYTES} bytes`);
  const sources = policy.sources ?? [];
  if (sources.includes(BUILT_IN_SOURCE)) problem(`${BUILT_IN_SOURCE} is never listed`, ['sources']);
  if (duplicated(sources)) problem('a source is listed twice', ['sources']);
  if (duplicated((policy.block ?? []).map(targetKey)))
    problem('a target is blocked twice', ['block']);
  const only = policy.only ?? [];
  only.forEach(({ scope, dimension, targets }, index) => {
    if (dimension === 'capability' && scope.kind !== 'global')
      problem('a capability rule is global', ['only', index, 'scope']);
    problem(onlyProblem(dimension, targets), ['only', index, 'targets']);
  });
  if (duplicated(only.map(({ scope, dimension }) => `${scopeKey(scope)}|${dimension}`)))
    problem('one only rule per scope and dimension', ['only']);
  const prefer = policy.prefer ?? [];
  prefer.forEach(({ scope, targets }, index) =>
    problem(preferProblem(targets, scope.kind === 'global' ? ['source'] : PREFER_KINDS), [
      'prefer',
      index,
      'targets',
    ]),
  );
  if (duplicated(prefer.map(({ scope }) => scopeKey(scope))))
    problem('one preference per scope', ['prefer']);
  return problems;
}

/** Rule 6: an override narrows or prefers something, one only per dimension
 *  under the same kind rules, and its preference is one kind out of provider,
 *  service or source. */
export function overrideProblems(override: {
  only?: readonly { dimension: OnlyDimension; targets: readonly Target[] }[] | undefined;
  prefer?: readonly Target[] | undefined;
}): Problem[] {
  const problems: Problem[] = [];
  const problem = (message: string | undefined, path: (string | number)[] = []) => {
    if (message) problems.push({ message, path });
  };
  if (!override.only && !override.prefer) problem('an override narrows or prefers something');
  const only = override.only ?? [];
  only.forEach(({ dimension, targets }, index) =>
    problem(onlyProblem(dimension, targets), ['only', index, 'targets']),
  );
  if (duplicated(only.map(({ dimension }) => dimension)))
    problem('one only rule per dimension', ['only']);
  problem(override.prefer && preferProblem(override.prefer, PREFER_KINDS), ['prefer']);
  return problems;
}

/**
 * The server's `contractHash` serialization: keys sorted at every level, no
 * whitespace, and an undefined value written as `null`. Both revisions (a
 * policy's and an identity's) are its sha256, so the two sides compute one
 * value from one input.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The first 16 hex of sha256 over {@link stableJson}. */
export function revisionOf(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 16);
}

/** What a saved `router.policy` holds: the wire's rule collections, where an
 *  empty one means no rules (a reset can leave one), and no revision or
 *  sources, which this client computes. */
export interface SavedPolicy {
  version: number;
  block?: Target[] | undefined;
  only?: OnlyRule[] | undefined;
  prefer?: PreferRule[] | undefined;
}

/**
 * THE POLICY THIS CLIENT SENDS, or nothing. The saved rules exactly as stored,
 * the connected sources beside them, each empty collection left out, and the
 * revision over the rest. A user with no rules sends no `policy` at all, so
 * their bodies stay byte for byte what they were before settings existed.
 */
export function normalizeForWire(
  saved: SavedPolicy | undefined,
  sources: readonly string[] = [],
): WirePolicy | undefined {
  if (saved === undefined) return undefined;
  const rest = {
    ...(sources.length > 0 ? { sources: [...sources] } : {}),
    ...(saved.block !== undefined && saved.block.length > 0 ? { block: saved.block } : {}),
    ...(saved.only !== undefined && saved.only.length > 0 ? { only: saved.only } : {}),
    ...(saved.prefer !== undefined && saved.prefer.length > 0 ? { prefer: saved.prefer } : {}),
  };
  if (Object.keys(rest).length === 0) return undefined;
  const body = { version: POLICY_VERSION, ...rest };
  return { version: POLICY_VERSION, revision: revisionOf(body), ...rest };
}

/** The fields a rule reads; `revision` only tracks them. */
export type RouteIdentity = Omit<Identity, 'revision'>;

/** The rule a refusal names: the first one the route failed. */
export interface AccessRule {
  from: 'saved' | 'request';
  kind: 'block' | 'only' | 'unavailable';
  target?: Target;
  scope?: Scope;
  dimension?: OnlyDimension;
}

export type Access = { ok: true } | { ok: false; rule: AccessRule };

/** Whether a block target covers a route. A provider or seller block covers a
 *  route of unknown upstream (no providers, no seller): nothing shows it is
 *  not that party. */
export function blocks(target: Target, identity: RouteIdentity): boolean {
  switch (target.kind) {
    case 'category':
      return identity.categories.includes(target.id);
    case 'task':
      return target.id === identity.task;
    case 'provider':
      return identity.providers.length === 0 || identity.providers.includes(target.id);
    case 'seller':
      return identity.seller === undefined || target.id === identity.seller;
    case 'service':
      return target.id === identity.service;
    case 'source':
      return target.id === identity.source;
  }
}

/** Whether an only rule admits a route. Unknown identity satisfies no only
 *  rule, and a route through several providers needs every one named. */
export function admits(
  dimension: OnlyDimension,
  targets: readonly Target[],
  identity: RouteIdentity,
): boolean {
  const named = (kind: TargetKind, id: string | undefined) =>
    targets.some((target) => target.kind === kind && target.id === id);
  switch (dimension) {
    case 'capability':
      return (
        identity.categories.some((id) => named('category', id)) ||
        (identity.task !== undefined && named('task', identity.task))
      );
    case 'provider':
      return (
        identity.providers.length > 0 && identity.providers.every((id) => named('provider', id))
      );
    case 'seller':
      return identity.seller !== undefined && named('seller', identity.seller);
    case 'service':
      return named('service', identity.service);
  }
}

/** Whether a rule's scope reaches a route: global, or its own task. */
export const applies = (scope: Scope, identity: RouteIdentity) =>
  scope.kind === 'global' || scope.id === identity.task;

/**
 * Whether the rules let this route run, and if not, the first rule it failed:
 * its source, then the saved blocks, the saved only rules and the request's,
 * each in order. A preference never changes the answer.
 */
export function allowed(
  identity: RouteIdentity,
  policy?: Pick<WirePolicy, 'sources' | 'block' | 'only'>,
  override?: Pick<WireOverride, 'only'>,
): Access {
  if (identity.source !== BUILT_IN_SOURCE && !policy?.sources?.includes(identity.source))
    return {
      ok: false,
      rule: { from: 'saved', kind: 'unavailable', target: { kind: 'source', id: identity.source } },
    };
  const blocked = policy?.block?.find((target) => blocks(target, identity));
  if (blocked) return { ok: false, rule: { from: 'saved', kind: 'block', target: blocked } };
  const saved = policy?.only?.find(
    ({ scope, dimension, targets }) =>
      applies(scope, identity) && !admits(dimension, targets, identity),
  );
  if (saved)
    return {
      ok: false,
      rule: { from: 'saved', kind: 'only', scope: saved.scope, dimension: saved.dimension },
    };
  const narrowed = override?.only?.find(
    ({ dimension, targets }) => !admits(dimension, targets, identity),
  );
  if (narrowed)
    return {
      ok: false,
      rule: {
        from: 'request',
        kind: 'only',
        scope: { kind: 'global' },
        dimension: narrowed.dimension,
      },
    };
  return { ok: true };
}

/**
 * WHETHER AUTOMATIC REPLACEMENT MAY TAKE THIS ROUTE. No saved provider scope
 * means every allowed provider. A saved one needs every upstream party of the
 * route in it, and a route of unknown upstream never fits. It narrows only
 * automatic acceptance: it is never an access rule and never a ranking.
 */
export function replacementFits(
  identity: Pick<RouteIdentity, 'providers'>,
  providers: readonly Target[] | undefined,
): boolean {
  if (providers === undefined) return true;
  const ids = new Set(providers.filter(({ kind }) => kind === 'provider').map(({ id }) => id));
  return identity.providers.length > 0 && identity.providers.every((id) => ids.has(id));
}

/** One service the directory lists, as readback names it. */
export interface CoveredService {
  id: string;
  label: string;
}

/** What a target or rule reaches in the catalog, for readback. */
export interface Coverage {
  /** Task ids, in directory order. */
  tasks: string[];
  services: CoveredService[];
}

type Listing = Extract<Directory, { categories: unknown }>;

function coverageOf(listing: Listing, matched: (identity: RouteIdentity) => boolean): Coverage {
  const services = listing.services.filter(({ identity }) => matched(identity));
  const touched = new Set(services.flatMap(({ identity }) => identity.task ?? []));
  return {
    tasks: listing.tasks.filter(({ id }) => touched.has(id)).map(({ id }) => id),
    services: services.map(({ id, label }) => ({ id, label })),
  };
}

/**
 * THE CATALOG A BLOCK COVERS, computed with {@link blocks} itself, so readback
 * and enforcement cannot disagree: a category's tasks follow its reviewed
 * membership (a task with no service yet still shows), and a provider block
 * names every reseller route through that provider.
 */
export function blockCoverage(target: Target, listing: Listing): Coverage {
  const covered = coverageOf(listing, (identity) => blocks(target, identity));
  if (target.kind === 'category') {
    const tasks = listing.categories.find(({ id }) => id === target.id)?.tasks ?? [];
    return { ...covered, tasks: [...tasks] };
  }
  return target.kind === 'task' ? { ...covered, tasks: [target.id] } : covered;
}

/** The catalog an only rule still admits, among the routes its scope reaches,
 *  computed with {@link admits}. */
export function onlyCoverage(rule: OnlyRule, listing: Listing): Coverage {
  const covered = coverageOf(
    listing,
    (identity) => applies(rule.scope, identity) && admits(rule.dimension, rule.targets, identity),
  );
  if (rule.dimension !== 'capability') return covered;
  // A capability rule admits a category's every task, served yet or not.
  const tasks = new Set(covered.tasks);
  for (const target of rule.targets) {
    if (target.kind === 'task') tasks.add(target.id);
    if (target.kind === 'category')
      for (const id of listing.categories.find(({ id }) => id === target.id)?.tasks ?? [])
        tasks.add(id);
  }
  const order = listing.tasks.map(({ id }) => id);
  return {
    ...covered,
    tasks: [...tasks].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
  };
}
