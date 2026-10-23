import { CliError } from '../lib/errors';
import {
  loadRawConfig,
  readPersonalRouter,
  resolveSettings,
  SavedPolicySchema,
  SavedPolicyShapeSchema,
  type PartialConfig,
  type SettingScope,
} from '../lib/config';
import { configPath } from '../lib/paths';
import type { CommandContext, CommandResult } from '../context';
import {
  normalizeForWire,
  ONLY_DIMENSIONS,
  POLICY_VERSION,
  scopeKey,
  targetKey,
  type OnlyDimension,
  type SavedPolicy,
} from '../router/access';
import {
  WirePolicySchema,
  type DirectoryListing,
  type OnlyRule,
  type PreferRule,
  type Scope,
  type Target,
  type TargetKind,
} from '../router/decision';
import {
  cachedDirectory,
  entriesOf,
  fetchDirectory,
  labelOf,
  resolveName,
  type Named,
} from '../router/directory';
import { routerSettings, type RouterSettings } from '../router/settings';
import { savedAccountsIn } from '../router/accounts/saved';
import { persist } from './config';
import {
  POLICY_INVALID_TEXT,
  REPLACEMENT_NAME,
  SAVED_HERE,
  SAVED_PREFIX,
  blockedBy,
  describeBlock,
  describeLimits,
  describeOnly,
  describePrefer,
  describeReplacement,
  describeRules,
  flagFor,
  onlyResetCommand,
  preferResetCommand,
  replacementSupport,
  settingsReadback,
  shellWord,
  unblockCommand,
  type RuleReadback,
} from './config-readback';

/**
 * `tenjin config prefer|only|block|unblock|reset|replacement`: THE OPERATIONS
 * AN AGENT RUNS WHEN A USER ASKS TO CHANGE WHAT TENJIN MAY USE. Each one is
 * deterministic and answers with what it actually wrote, in the user's words,
 * with the one command that undoes it; no model call configures anything.
 *
 * NAMES FIRST, THEN THE LOCK. An operation that takes a name ("Exa",
 * "Images") resolves it against the router's directory before it takes the
 * config lock, and only an exact or unique match is ever written: an
 * ambiguous, unknown or retired name, a failed lookup or a conflict writes
 * nothing. Inside the lock the file is reread, the change is merged into what
 * is there now and checked as the server checks it, then written atomically,
 * so two agents changing unrelated rules at once both land.
 *
 * OFFLINE WHERE IT MATTERS. Unblock, reset and `replacement off` never ask
 * the network: removing a rule or stopping automatic use must work when the
 * router does not answer. They match a saved id directly, or through the
 * names in the directory last fetched.
 */

/** The typed names a command line carries, one list per kind. */
export interface TargetFlags {
  category?: string[];
  task?: string[];
  provider?: string[];
  seller?: string[];
  service?: string[];
  source?: string[];
}

export interface ScopeFlags extends TargetFlags {
  global?: boolean;
}

export interface ResetFlags extends ScopeFlags {
  all?: boolean;
  preference?: boolean;
  restriction?: boolean;
  capabilities?: boolean;
  dimension?: string;
}

/** Test seams: the directory call's transport, and where the command runs. */
export interface ConfigRulesDeps {
  fetchImpl?: typeof fetch;
  cwd?: string;
}

const KINDS: readonly TargetKind[] = [
  'category',
  'task',
  'provider',
  'seller',
  'service',
  'source',
];

/** What a person calls each kind. A source is one of "your accounts". */
const KIND_NOUN: Record<TargetKind, string> = {
  category: 'category',
  task: 'task',
  provider: 'provider',
  seller: 'seller',
  service: 'service',
  source: 'account',
};

interface Wanted {
  kind: TargetKind;
  name: string;
}

function wantedOf(flags: TargetFlags, kinds: readonly TargetKind[] = KINDS): Wanted[] {
  return kinds.flatMap((kind) =>
    (flags[kind] ?? []).map((name: string) => ({ kind, name: name.trim() })),
  );
}

function usage(message: string, fix?: string, details?: unknown): never {
  throw new CliError('USAGE', message, {
    ...(fix !== undefined ? { fix } : {}),
    ...(details !== undefined ? { details } : {}),
  });
}

const HELP = 'See `tenjin config --help` for every operation with an example.';

/** The router's directory now, or an error that saved nothing. */
async function liveDirectory(
  ctx: CommandContext,
  deps: ConfigRulesDeps,
): Promise<DirectoryListing> {
  const config = await loadRawConfig(ctx.dataDir);
  const { baseUrl } = resolveSettings({
    config,
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
  });
  const result = await fetchDirectory(ctx.dataDir, {
    ctx,
    baseUrl: baseUrl.value,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (!result.ok) {
    throw new CliError(
      result.unreachable === true ? 'API_UNREACHABLE' : 'NETWORK_ERROR',
      `Tenjin couldn't look up those names right now, so nothing was saved. (${result.reason})`,
      {
        fix: 'Try again in a moment. Showing your settings, pausing Tenjin, unblocking and resetting all work without the network.',
      },
    );
  }
  return result.listing;
}

/** The saved account ids a source name may also mean (#37). */
async function savedSourceIds(ctx: CommandContext): Promise<string[]> {
  const config = await loadRawConfig(ctx.dataDir);
  const sources = readPersonalRouter(config.router).sources;
  return sources.status === 'ok' ? sources.saved.map(({ id }) => id) : [];
}

const shown = (entries: readonly Named[]) =>
  entries.map(({ id, label }) => (label === id ? label : `${label} (${id})`)).join(', ');

/** Every name resolved, or a USAGE error naming the one that was not. */
function resolveAll(
  listing: DirectoryListing,
  wanted: readonly Wanted[],
  localSources: readonly string[],
): { target: Target; label: string }[] {
  const resolved: { target: Target; label: string }[] = [];
  for (const { kind, name } of wanted) {
    const noun = KIND_NOUN[kind];
    const found = resolveName(listing, kind, name, localSources);
    if (found.status === 'ambiguous') {
      usage(
        `"${name}" matches more than one ${noun}: ${shown(found.candidates)}. Nothing was saved.`,
        `Run it again with the id in parentheses of the one meant.`,
        { kind, name, candidates: found.candidates },
      );
    }
    if (found.status === 'retired') {
      usage(
        `${found.entry.label} is no longer available through Tenjin, so nothing was saved.`,
        undefined,
        { kind, name, retired: found.entry },
      );
    }
    if (found.status === 'unknown') {
      usage(
        `Tenjin has no ${noun} named "${name}". Nothing was saved.`,
        found.candidates.length > 0
          ? `Did you mean: ${shown(found.candidates)}?`
          : `\`tenjin config\` shows what is saved; ${HELP}`,
        { kind, name, candidates: found.candidates },
      );
    }
    if (
      found.status === 'match' &&
      !resolved.some(({ target }) => targetKey(target) === targetKey(found.target))
    ) {
      resolved.push({ target: found.target, label: found.label });
    }
  }
  return resolved;
}

/**
 * The saved policy as the change finds it, read inside the lock. A change
 * that adds or replaces a preference or an only rule needs a policy this
 * build fully reads. One that removes a rule or adds a block needs only its
 * shape at this version, so a user can still take a rule out of, or block
 * something in, a policy whose other rules break a check.
 */
function savedPolicyOf(
  existing: PartialConfig,
  narrowing: boolean,
): { policy: SavedPolicy; valid: boolean } {
  const raw = (existing.router as Record<string, unknown> | undefined)?.policy;
  if (raw === undefined) return { policy: { version: POLICY_VERSION }, valid: true };
  const strict = SavedPolicySchema.safeParse(raw);
  if (strict.success) return { policy: strict.data, valid: true };
  if (narrowing) {
    const shape = SavedPolicyShapeSchema.safeParse(raw);
    if (shape.success && shape.data.version === POLICY_VERSION)
      return { policy: shape.data, valid: false };
  }
  const read = readPersonalRouter(existing.router).policy;
  const problem = read.status === 'invalid' ? read.problem : 'router.policy is not readable';
  throw new CliError('CONFIG_INVALID', `${POLICY_INVALID_TEXT} ${problem}. Nothing was changed.`, {
    fix: 'Clear the saved rules with `tenjin config reset --all`, then set them again.',
    details: { problem },
  });
}

/** The policy with every emptied collection dropped, or nothing at all. */
function tidy(policy: SavedPolicy): SavedPolicy | undefined {
  const next: SavedPolicy = {
    version: policy.version,
    ...(policy.block?.length ? { block: policy.block } : {}),
    ...(policy.only?.length ? { only: policy.only } : {}),
    ...(policy.prefer?.length ? { prefer: policy.prefer } : {}),
  };
  return Object.keys(next).length === 1 ? undefined : next;
}

function withPolicy(existing: PartialConfig, policy: SavedPolicy): PartialConfig {
  const router = { ...((existing.router ?? {}) as Record<string, unknown>) };
  delete router.policy;
  const kept = tidy(policy);
  return { ...existing, router: { ...router, ...(kept !== undefined ? { policy: kept } : {}) } };
}

/** The same checks the server runs, on the saved rules and the form sent. */
function checkSendable(policy: SavedPolicy): void {
  const saved = SavedPolicySchema.safeParse(policy);
  const wire = saved.success ? WirePolicySchema.safeParse(normalizeForWire(policy)) : saved;
  if (wire.success) return;
  const [issue] = wire.error.issues;
  throw new CliError(
    'REFUSED',
    `That change would leave settings Tenjin can't use (${issue?.message ?? 'invalid'}). Nothing was saved.`,
    { fix: `Remove a rule you no longer need first. ${HELP}`, details: wire.error.issues },
  );
}

function conflict(target: Target, block: Target, listing: DirectoryListing | undefined): never {
  const named = labelOf(target, listing);
  const blocked = labelOf(block, listing);
  const why =
    targetKey(target) === targetKey(block)
      ? `${named} is blocked in your settings`
      : `${named} is covered by your block on ${blocked}`;
  throw new CliError('REFUSED', `${why}, so it can't be chosen here. Nothing was saved.`, {
    fix: `Blocks win over every other rule. To use it again, the user can run \`${unblockCommand(block)}\` first.`,
    details: { target, block },
  });
}

/** Where the readback is resolved: the directory the command runs in. */
async function readBack(ctx: CommandContext, deps: ConfigRulesDeps): Promise<RouterSettings> {
  return routerSettings({ cwd: deps.cwd ?? process.cwd(), dataDir: ctx.dataDir });
}

async function limitsOf(ctx: CommandContext) {
  const config = await loadRawConfig(ctx.dataDir);
  const settings = resolveSettings({ config, flags: {}, env: process.env });
  return describeLimits(settings.maxAutoSpend.value, settings.sessionBudget.value);
}

/** The line every saved rule change adds about automatic replacement. */
async function replacementNote(router: RouterSettings, ctx: CommandContext): Promise<string> {
  if (router.nativeReplacement.mode === 'off')
    return `${REPLACEMENT_NAME} is off, and this doesn't turn it on.`;
  const support = await replacementSupport(ctx.dataDir);
  return support.supported
    ? `${REPLACEMENT_NAME} is on, so this also holds for the searches and fetches Tenjin runs in place.`
    : `${REPLACEMENT_NAME} is on. ${support.why}`;
}

export interface Outcome {
  operation:
    | 'prefer'
    | 'only'
    | 'block'
    | 'unblock'
    | 'reset'
    | 'replacement'
    | 'fallback'
    | 'connect'
    | 'disconnect';
  changed: boolean;
  scope: SettingScope;
  /** The sentences a person reads first. */
  explanation: string[];
  rules?: RuleReadback[];
  removed?: unknown[];
  reset?: string;
  extra?: Record<string, unknown>;
}

/**
 * THE ONE ENVELOPE EVERY OPERATION ANSWERS WITH: what changed, its scope,
 * what is now in effect, why, and how to undo it, from the file as it reads
 * back after the write rather than from what the operation meant to write.
 */
export async function answer(
  outcome: Outcome,
  ctx: CommandContext,
  deps: ConfigRulesDeps,
  listing: DirectoryListing | undefined,
): Promise<CommandResult> {
  const router = await readBack(ctx, deps);
  const limits = await limitsOf(ctx);
  const settings = settingsReadback(router, listing, limits, await replacementSupport(ctx.dataDir));
  const unreadable =
    router.policy.status === 'invalid' ? [`${POLICY_INVALID_TEXT} ${router.policy.problem}.`] : [];
  const humanLines = [
    ...outcome.explanation,
    ...unreadable,
    ...(outcome.reset !== undefined ? [`To undo: \`${outcome.reset}\``] : []),
  ];
  return {
    data: {
      operation: outcome.operation,
      changed: outcome.changed,
      saved: SAVED_HERE,
      scope: outcome.scope,
      ...(outcome.rules !== undefined ? { effective: outcome.rules } : {}),
      ...(outcome.removed !== undefined ? { removed: outcome.removed } : {}),
      explanation: outcome.explanation.join(' '),
      ...(outcome.reset !== undefined ? { reset: outcome.reset } : {}),
      ...outcome.extra,
      settings: settings.data,
    },
    humanLines,
  };
}

const said = (rule: RuleReadback) =>
  rule.inactive !== undefined ? `${rule.text} (${rule.inactive})` : rule.text;

const one = <T>(values: readonly T[]): T => values[0] as T;

/* ------------------------------------------------------------------ prefer */

/**
 * `tenjin config prefer`: the order Tenjin tries allowed services in. With
 * `--task`, that task's ordered providers, services or accounts; without, the
 * account-wide order of your accounts. Repeating it replaces the list at that
 * scope and leaves every other rule alone. A preference never forbids
 * anything: other allowed services remain the fallback.
 */
export async function runConfigPrefer(
  flags: ScopeFlags,
  ctx: CommandContext,
  deps: ConfigRulesDeps = {},
): Promise<CommandResult> {
  if (flags.category?.length || flags.seller?.length) {
    usage(
      'A preference names providers, services or your accounts: use --provider, --service or --source.',
      HELP,
    );
  }
  const kinds = (['provider', 'service', 'source'] as const).filter((kind) => flags[kind]?.length);
  if (kinds.length === 0)
    usage('Name what to prefer with --provider, --service or --source.', HELP);
  if (kinds.length > 1)
    usage(
      'One preference is one kind: providers, services or accounts. Run prefer once for the kind you mean.',
    );
  const kind = one(kinds);
  const tasks = flags.task ?? [];
  if (tasks.length > 1) usage('A preference is for one task: name it once with --task.');
  if (flags.global === true && tasks.length > 0)
    usage('--global and --task name different scopes: use one.');
  if (tasks.length === 0 && kind !== 'source') {
    usage(
      `A ${kind} preference is for one task: add --task "<task>".`,
      'Only your accounts can be preferred across every task (--source without --task).',
    );
  }
  const listing = await liveDirectory(ctx, deps);
  const local = await savedSourceIds(ctx);
  const task =
    tasks.length > 0
      ? one(resolveAll(listing, [{ kind: 'task', name: one(tasks) }], local))
      : undefined;
  const targets = resolveAll(listing, wantedOf(flags, [kind]), local).map(({ target }) => target);
  const scope: Scope =
    task !== undefined ? { kind: 'task', id: task.target.id } : { kind: 'global' };
  const rule: PreferRule = { scope, targets };
  let after: SavedPolicy = { version: POLICY_VERSION };
  let replaced: PreferRule | undefined;
  await persist(ctx.dataDir, (existing) => {
    const { policy } = savedPolicyOf(existing, false);
    for (const target of targets) {
      const block = blockedBy(target, policy, listing);
      if (block !== undefined) conflict(target, block, listing);
    }
    const prefer = policy.prefer ?? [];
    replaced = prefer.find((entry) => scopeKey(entry.scope) === scopeKey(scope));
    after = {
      ...policy,
      prefer:
        replaced !== undefined
          ? prefer.map((entry) => (entry === replaced ? rule : entry))
          : [...prefer, rule],
    };
    checkSendable(after);
    return withPolicy(existing, after);
  });
  const effective = describePrefer(rule, after, listing);
  const router = await readBack(ctx, deps);
  return answer(
    {
      operation: 'prefer',
      changed: true,
      scope: 'user',
      explanation: [`${SAVED_PREFIX} ${said(effective)}`, await replacementNote(router, ctx)],
      rules: [effective],
      ...(replaced !== undefined ? { removed: [replaced] } : {}),
      reset: preferResetCommand(scope),
    },
    ctx,
    deps,
    listing,
  );
}

/* -------------------------------------------------------------------- only */

/**
 * `tenjin config only`: a nonempty allowed set. `--global` with categories or
 * tasks limits which tasks Tenjin does anywhere; `--task` with providers,
 * sellers or services limits who does that one task and leaves every other
 * task alone. Repeating it replaces the set for that scope and dimension;
 * other dimensions and blocks stay.
 */
export async function runConfigOnly(
  flags: ScopeFlags,
  ctx: CommandContext,
  deps: ConfigRulesDeps = {},
): Promise<CommandResult> {
  if (flags.source?.length) {
    usage(
      "There is no only for accounts. To stop Tenjin's own tools and use only your accounts, block them: `tenjin config block --source tenjin`.",
    );
  }
  const people = (['provider', 'seller', 'service'] as const).filter((kind) => flags[kind]?.length);
  if (people.length > 1) {
    usage(
      'One only rule limits one thing: providers, sellers or services. Run only once for each.',
      HELP,
    );
  }
  let scope: Scope | undefined;
  let dimension: OnlyDimension;
  let wanted: Wanted[];
  if (flags.global === true) {
    const capability = wantedOf(flags, ['category', 'task']);
    if (capability.length > 0 && people.length > 0) {
      usage(
        'Tasks and categories are one rule, providers, sellers or services another: run only once for each.',
        HELP,
      );
    }
    if (capability.length === 0 && people.length === 0)
      usage(
        'Name what to allow: --category or --task, or --provider, --seller or --service.',
        HELP,
      );
    scope = { kind: 'global' };
    dimension = people.length > 0 ? one(people) : 'capability';
    wanted = people.length > 0 ? wantedOf(flags, people) : capability;
  } else {
    if (flags.category?.length) {
      usage(
        'A category rule limits which tasks Tenjin does anywhere: add --global.',
        'tenjin config only --global --category images',
      );
    }
    const tasks = flags.task ?? [];
    if (tasks.length === 0 || people.length === 0) {
      usage(
        'Say where the rule applies: --task "<task>" with --provider, --seller or --service limits who does that task; --global with --category or --task limits which tasks Tenjin does.',
        HELP,
      );
    }
    if (tasks.length > 1) {
      usage(
        'A provider, seller or service rule is for one task: name it once, or use --global to limit which tasks Tenjin does.',
      );
    }
    dimension = one(people);
    wanted = wantedOf(flags, people);
  }
  const listing = await liveDirectory(ctx, deps);
  const local = await savedSourceIds(ctx);
  if (scope === undefined) {
    const task = one(resolveAll(listing, [{ kind: 'task', name: one(flags.task ?? []) }], local));
    scope = { kind: 'task', id: task.target.id };
  }
  const targets = resolveAll(listing, wanted, local).map(({ target }) => target);
  const rule: OnlyRule = { scope, dimension, targets };
  let after: SavedPolicy = { version: POLICY_VERSION };
  let replaced: OnlyRule | undefined;
  await persist(ctx.dataDir, (existing) => {
    const { policy } = savedPolicyOf(existing, false);
    for (const target of targets) {
      const block = blockedBy(target, policy, listing);
      if (block !== undefined) conflict(target, block, listing);
    }
    const only = policy.only ?? [];
    const key = `${scopeKey(rule.scope)}|${dimension}`;
    replaced = only.find((entry) => `${scopeKey(entry.scope)}|${entry.dimension}` === key);
    after = {
      ...policy,
      only:
        replaced !== undefined
          ? only.map((entry) => (entry === replaced ? rule : entry))
          : [...only, rule],
    };
    checkSendable(after);
    return withPolicy(existing, after);
  });
  const effective = describeOnly(rule, after, listing);
  const router = await readBack(ctx, deps);
  return answer(
    {
      operation: 'only',
      changed: true,
      scope: 'user',
      explanation: [`${SAVED_PREFIX} ${said(effective)}`, await replacementNote(router, ctx)],
      rules: [effective],
      ...(replaced !== undefined ? { removed: [replaced] } : {}),
      reset: onlyResetCommand(rule),
    },
    ctx,
    deps,
    listing,
  );
}

/* ------------------------------------------------------------------- block */

/**
 * `tenjin config block`: a hard restriction, any kind of target. It always
 * lands, even when it leaves a saved preference or only rule unusable: the
 * block wins, and readback marks the rule it made inactive rather than
 * deleting it.
 */
export async function runConfigBlock(
  flags: TargetFlags,
  ctx: CommandContext,
  deps: ConfigRulesDeps = {},
): Promise<CommandResult> {
  const wanted = wantedOf(flags);
  if (wanted.length === 0) {
    usage(
      'Name what to block: --provider, --seller, --service, --task, --category or --source.',
      HELP,
    );
  }
  const listing = await liveDirectory(ctx, deps);
  const targets = resolveAll(listing, wanted, await savedSourceIds(ctx)).map(
    ({ target }) => target,
  );
  let before: SavedPolicy = { version: POLICY_VERSION };
  let after: SavedPolicy = { version: POLICY_VERSION };
  const added: Target[] = [];
  await persist(ctx.dataDir, (existing) => {
    const { policy, valid } = savedPolicyOf(existing, true);
    before = policy;
    const saved = new Set((policy.block ?? []).map(targetKey));
    added.splice(0, added.length, ...targets.filter((target) => !saved.has(targetKey(target))));
    after = { ...policy, block: [...(policy.block ?? []), ...added] };
    if (valid) checkSendable(after);
    return withPolicy(existing, after);
  });
  const rules = targets.map((target) => describeBlock(target, listing));
  const wasActive = new Set(
    describeRules(before, listing)
      .filter(({ inactive }) => inactive === undefined)
      .map(({ rule }) => JSON.stringify(rule)),
  );
  const nowInactive = describeRules(after, listing).filter(
    ({ kind, inactive, rule }) =>
      kind !== 'block' && inactive !== undefined && wasActive.has(JSON.stringify(rule)),
  );
  const already = targets.filter((target) => !added.includes(target));
  const explanation = [
    ...rules
      .filter(({ rule }) => added.includes(rule as Target))
      .map(({ text }, index) => (index === 0 ? `${SAVED_PREFIX} ${text}` : text)),
    ...already.map((target) => `${labelOf(target, listing)} was already blocked.`),
    ...nowInactive.map(
      (rule) => `This leaves a saved rule unusable, kept as it is: ${rule.text} (${rule.inactive})`,
    ),
  ];
  return answer(
    {
      operation: 'block',
      changed: added.length > 0,
      scope: 'user',
      explanation,
      rules,
      ...(added.length > 0
        ? { reset: added.map((target) => unblockCommand(target)).join(' && ') }
        : {}),
      extra: { added, inactive: nowInactive },
    },
    ctx,
    deps,
    listing,
  );
}

/* ----------------------------------------------------------------- unblock */

const folded = (text: string) => text.trim().toLowerCase();

/**
 * A saved target a typed name means, with no network: the id itself, the id
 * in another case, or a name the directory last fetched gives that id.
 */
function savedMatch(
  wanted: Wanted,
  saved: readonly Target[],
  listing: DirectoryListing | undefined,
): Target | undefined {
  const ofKind = saved.filter(({ kind }) => kind === wanted.kind);
  const direct =
    ofKind.find(({ id }) => id === wanted.name) ??
    ofKind.find(({ id }) => folded(id) === folded(wanted.name));
  if (direct !== undefined || listing === undefined) return direct;
  const ids = new Set(
    entriesOf(listing, wanted.kind)
      .filter(({ label }) => folded(label) === folded(wanted.name))
      .map(({ id }) => id),
  );
  const byLabel = ofKind.filter(({ id }) => ids.has(id));
  return byLabel.length === 1 ? byLabel[0] : undefined;
}

/** `tenjin config unblock`: removes the named blocks and nothing else. */
export async function runConfigUnblock(
  flags: TargetFlags,
  ctx: CommandContext,
  deps: ConfigRulesDeps = {},
): Promise<CommandResult> {
  const wanted = wantedOf(flags);
  if (wanted.length === 0) {
    usage(
      'Name what to unblock: --provider, --seller, --service, --task, --category or --source.',
      HELP,
    );
  }
  const listing = await cachedDirectory(ctx.dataDir);
  const removed: Target[] = [];
  const missing: Wanted[] = [];
  let remaining: Target[] = [];
  await persist(ctx.dataDir, (existing) => {
    const { policy } = savedPolicyOf(existing, true);
    const saved = policy.block ?? [];
    removed.length = 0;
    missing.length = 0;
    for (const name of wanted) {
      const match = savedMatch(name, saved, listing);
      if (match === undefined) missing.push(name);
      else if (!removed.includes(match)) removed.push(match);
    }
    remaining = saved.filter((target) => !removed.includes(target));
    return removed.length === 0 ? existing : withPolicy(existing, { ...policy, block: remaining });
  });
  const names = removed.map((target) => labelOf(target, listing));
  const explanation = [
    ...(removed.length > 0
      ? [
          `${SAVED_PREFIX} ${new Intl.ListFormat('en').format(names)} ${removed.length === 1 ? 'is' : 'are'} no longer blocked. Your other rules stay as they are.`,
        ]
      : []),
    ...missing.map(
      ({ kind, name }) =>
        `Nothing saved blocks a ${KIND_NOUN[kind]} named "${name}", so nothing changed for it.`,
    ),
    ...(missing.length > 0 && remaining.length > 0
      ? [`Saved blocks: ${remaining.map((target) => labelOf(target, listing)).join(', ')}.`]
      : []),
  ];
  return answer(
    {
      operation: 'unblock',
      changed: removed.length > 0,
      scope: 'user',
      explanation,
      removed,
      ...(removed.length > 0
        ? {
            reset: `tenjin config block ${removed.map((target) => flagFor(target)).join(' ')}`,
          }
        : {}),
      extra: { missing },
    },
    ctx,
    deps,
    listing,
  );
}

/* ------------------------------------------------------------------- reset */

function savedScope(
  name: string,
  scopes: readonly Scope[],
  listing: DirectoryListing | undefined,
): Scope | undefined {
  const tasks = scopes.flatMap((scope) =>
    scope.kind === 'task' ? [{ kind: 'task' as const, id: scope.id }] : [],
  );
  const match = savedMatch({ kind: 'task', name }, tasks, listing);
  return match === undefined ? undefined : { kind: 'task', id: match.id };
}

/**
 * `tenjin config reset`: removes exactly the rule it names, offline.
 * `--preference` a task's preference (or with --source, one account from the
 * account-wide order); `--restriction` a scope's only rules, or with
 * `--dimension` just one of them; `--capabilities` the global task allowlist;
 * `--all` every saved routing rule. Blocks go with unblock; replacement with
 * `replacement off`; spending limits and saved accounts are never touched.
 */
export async function runConfigReset(
  flags: ResetFlags,
  ctx: CommandContext,
  deps: ConfigRulesDeps = {},
): Promise<CommandResult> {
  const modes = (['all', 'preference', 'restriction', 'capabilities'] as const).filter(
    (mode) => flags[mode] === true,
  );
  if (modes.length !== 1) {
    usage(
      'Say what to reset: --preference, --restriction, --capabilities or --all.',
      'tenjin config reset --task "web research" --preference',
    );
  }
  const mode = one(modes);
  const tasks = flags.task ?? [];
  const targets = wantedOf(flags, ['category', 'provider', 'seller', 'service', 'source']);
  if (tasks.length > 1) usage('Reset one task at a time: name it once with --task.');
  if (flags.global === true && tasks.length > 0)
    usage('--global and --task name different scopes: use one.');
  if (flags.dimension !== undefined && mode !== 'restriction')
    usage('--dimension goes with --restriction.');
  const dimension = flags.dimension as OnlyDimension | undefined;
  if (dimension !== undefined && !ONLY_DIMENSIONS.includes(dimension)) {
    usage(
      `--dimension is one of ${ONLY_DIMENSIONS.join(', ')}; got "${flags.dimension}".`,
      'tenjin config reset --task "web research" --restriction --dimension provider',
    );
  }
  if (mode === 'all' && (tasks.length > 0 || targets.length > 0 || flags.global === true))
    usage('--all resets every saved routing rule and takes nothing else.');
  if (mode === 'capabilities' && (tasks.length > 0 || targets.length > 0))
    usage('--capabilities resets the global task allowlist and takes nothing else.');
  if (mode === 'restriction' && targets.length > 0)
    usage('--restriction resets a whole rule: name its scope and, optionally, --dimension.');
  if (mode === 'restriction' && tasks.length === 0 && flags.global !== true)
    usage('Say which restriction: --task "<task>" or --global.', HELP);
  if (mode === 'preference') {
    if (targets.some(({ kind }) => !['provider', 'service', 'source'].includes(kind)))
      usage('A preference holds providers, services or accounts.');
    if (tasks.length === 0 && flags.global !== true && targets.length === 0)
      usage('Say which preference: --task "<task>", --global, or --source "<account>".', HELP);
  }

  const listing = await cachedDirectory(ctx.dataDir);
  const removed: unknown[] = [];
  /** The rules as they were before this reset touched them, to undo it. */
  const touched: (OnlyRule | PreferRule)[] = [];
  let missing: string | undefined;
  await persist(ctx.dataDir, (existing) => {
    removed.length = 0;
    touched.length = 0;
    missing = undefined;
    if (mode === 'all') {
      const { policy: gone, ...router } = (existing.router ?? {}) as Record<string, unknown>;
      if (gone === undefined) {
        missing = 'There are no saved routing rules to reset.';
        return existing;
      }
      removed.push(gone);
      return { ...existing, router };
    }
    const { policy } = savedPolicyOf(existing, true);
    const only = policy.only ?? [];
    const prefer = policy.prefer ?? [];
    if (mode === 'capabilities' || mode === 'restriction') {
      const scope: Scope | undefined =
        mode === 'capabilities' || flags.global === true
          ? { kind: 'global' }
          : savedScope(
              one(tasks),
              only.map(({ scope }) => scope),
              listing,
            );
      const wantDimension = mode === 'capabilities' ? 'capability' : dimension;
      const drop = only.filter(
        (entry) =>
          scope !== undefined &&
          scopeKey(entry.scope) === scopeKey(scope) &&
          (wantDimension === undefined || entry.dimension === wantDimension),
      );
      if (drop.length === 0) {
        const where = scope?.kind === 'task' ? scope.id : (tasks[0] ?? 'every task');
        missing =
          mode === 'capabilities'
            ? 'There is no saved task allowlist to reset.'
            : `There is no saved ${wantDimension !== undefined ? `${wantDimension} ` : ''}restriction for ${where} to reset.`;
        return existing;
      }
      removed.push(...drop);
      touched.push(...drop);
      return withPolicy(existing, {
        ...policy,
        only: only.filter((entry) => !drop.includes(entry)),
      });
    }
    // --preference
    const scope: Scope | undefined =
      tasks.length > 0
        ? savedScope(
            one(tasks),
            prefer.map(({ scope }) => scope),
            listing,
          )
        : { kind: 'global' };
    const entry =
      scope === undefined
        ? undefined
        : prefer.find((candidate) => scopeKey(candidate.scope) === scopeKey(scope));
    if (entry === undefined) {
      missing =
        tasks.length > 0
          ? `There is no saved preference for ${one(tasks)} to reset.`
          : 'There is no saved account-wide preference to reset.';
      return existing;
    }
    touched.push(entry);
    if (targets.length === 0) {
      removed.push(entry);
      return withPolicy(existing, { ...policy, prefer: prefer.filter((rule) => rule !== entry) });
    }
    const drop = targets.flatMap((name) => savedMatch(name, entry.targets, listing) ?? []);
    if (drop.length === 0) {
      touched.length = 0;
      missing = `${targets.map(({ name }) => name).join(', ')} ${targets.length === 1 ? 'is' : 'are'} not in that preference.`;
      return existing;
    }
    removed.push(...drop);
    const kept = entry.targets.filter((target) => !drop.includes(target));
    return withPolicy(existing, {
      ...policy,
      prefer:
        kept.length === 0
          ? prefer.filter((rule) => rule !== entry)
          : prefer.map((rule) => (rule === entry ? { ...entry, targets: kept } : rule)),
    });
  });
  const explanation =
    missing !== undefined
      ? [`${missing} Nothing changed.`]
      : [
          `${SAVED_PREFIX} removed ${describeRemoved(mode, removed, listing)}. Your blocks, limits and other rules stay as they are.`,
        ];
  return answer(
    {
      operation: 'reset',
      changed: missing === undefined,
      scope: 'user',
      explanation,
      removed,
      ...(missing === undefined && touched.length > 0
        ? { reset: touched.map((rule) => recreate(rule)).join(' && ') }
        : {}),
    },
    ctx,
    deps,
    listing,
  );
}

/** The command that saves a rule again exactly as it was. */
function recreate(rule: OnlyRule | PreferRule): string {
  const where = rule.scope.kind === 'task' ? `--task ${shellWord(rule.scope.id)}` : '';
  const targets = rule.targets.map((target) => flagFor(target)).join(' ');
  if ('dimension' in rule) {
    return `tenjin config only ${rule.scope.kind === 'global' ? '--global' : where} ${targets}`;
  }
  return ['tenjin config prefer', where, targets].filter((part) => part.length > 0).join(' ');
}

function describeRemoved(
  mode: 'all' | 'preference' | 'restriction' | 'capabilities',
  removed: readonly unknown[],
  listing: DirectoryListing | undefined,
): string {
  if (mode === 'all') return 'every saved routing rule';
  const list = new Intl.ListFormat('en');
  if (mode === 'preference') {
    const [first] = removed;
    if (first !== undefined && first !== null && typeof first === 'object' && 'scope' in first) {
      const rule = first as PreferRule;
      return rule.scope.kind === 'task'
        ? `your preference for ${labelOf({ kind: 'task', id: rule.scope.id }, listing)}`
        : 'your account-wide preference';
    }
    return `${list.format((removed as Target[]).map((target) => labelOf(target, listing)))} from that preference`;
  }
  return list.format(
    (removed as OnlyRule[]).map((rule) => {
      const where =
        rule.scope.kind === 'task'
          ? ` for ${labelOf({ kind: 'task', id: rule.scope.id }, listing)}`
          : '';
      return rule.dimension === 'capability'
        ? 'the limit on which tasks Tenjin does'
        : `the ${rule.dimension} restriction${where}`;
    }),
  );
}

/* ------------------------------------------------------------- replacement */

/**
 * `tenjin config replacement on|off`: whether a host that supports it may
 * run Tenjin's pick in place of a native search or fetch. `on` needs either
 * `--provider` (a nonempty scope) or `--all-providers` (which removes any
 * saved scope), and writes mode and scope in one write; `off` keeps a saved
 * scope for inspection. The scope narrows only automatic acceptance: it never
 * changes what is allowed or which service is picked first.
 */
export async function runConfigReplacement(
  args: { state: string; provider?: string[]; allProviders?: boolean },
  ctx: CommandContext,
  deps: ConfigRulesDeps = {},
): Promise<CommandResult> {
  const providers = args.provider ?? [];
  if (args.state !== 'on' && args.state !== 'off')
    usage(`replacement takes on or off; got "${args.state}".`, 'tenjin config replacement off');
  if (args.state === 'off' && (providers.length > 0 || args.allProviders === true))
    usage('replacement off takes nothing else; a saved provider choice is kept.');
  if (args.state === 'on' && providers.length > 0 === (args.allProviders === true)) {
    usage(
      'Say which providers: --provider "<provider>" (repeatable), or --all-providers for any allowed provider.',
      'tenjin config replacement on --provider exa',
    );
  }
  const listing =
    args.state === 'on' && providers.length > 0
      ? await liveDirectory(ctx, deps)
      : await cachedDirectory(ctx.dataDir);
  const scope =
    args.state === 'on' && providers.length > 0 && listing !== undefined
      ? resolveAll(
          listing,
          providers.map((name) => ({ kind: 'provider' as const, name: name.trim() })),
          [],
        ).map(({ target }) => target)
      : undefined;
  await persist(ctx.dataDir, (existing) => {
    const router = { ...((existing.router ?? {}) as Record<string, unknown>) };
    if (args.state === 'off') {
      router.nativeReplacement = 'off';
      return { ...existing, router };
    }
    if (scope !== undefined) {
      // A blocked provider never runs, so naming it here is a conflict.
      const policy = readPersonalRouter(existing.router).policy;
      const saved = policy.status === 'ok' ? policy.saved : { version: POLICY_VERSION };
      for (const target of scope) {
        const block = blockedBy(target, saved, listing);
        if (block !== undefined) conflict(target, block, listing);
      }
      router.nativeReplacementProviders = scope;
    } else {
      delete router.nativeReplacementProviders;
    }
    router.nativeReplacement = 'when-routed';
    return { ...existing, router };
  });
  const router = await readBack(ctx, deps);
  const support = await replacementSupport(ctx.dataDir);
  const effective = describeReplacement(router.nativeReplacement, listing, support);
  const limits = await limitsOf(ctx);
  const explanation =
    args.state === 'off'
      ? [
          `${SAVED_PREFIX} ${effective.text} Tenjin's offers and the requests you make stay available; to stop Tenjin altogether, run \`tenjin config set router.enabled false\`.`,
        ]
      : [
          `${SAVED_PREFIX} ${REPLACEMENT_NAME} is on${scope !== undefined ? ` for ${new Intl.ListFormat('en', { type: 'disjunction' }).format(scope.map((target) => labelOf(target, listing)))}` : ' for any allowed provider'}.`,
          'When Tenjin picks a service for a web search or page fetch your agent is about to make, it runs that pick in place of the search or fetch instead of offering it first, so each one is a charge you are not asked about separately.',
          `Your limits still apply (${limits.perCall} a call, ${limits.daily === null ? 'no daily limit' : `${limits.daily} a day`}, Tenjin balance): a call over them is not run in place, it is offered as usual and asks first.`,
          'This picks no provider ahead of another and changes nothing about what is allowed: add a preference or a rule for that.',
          support.why,
        ];
  return answer(
    {
      operation: 'replacement',
      changed: true,
      scope: 'machine',
      explanation,
      ...(args.state === 'on' ? { reset: 'tenjin config replacement off' } : {}),
      extra: { replacement: effective, path: configPath(ctx.dataDir) },
    },
    ctx,
    deps,
    listing,
  );
}

/* ---------------------------------------------------------------- fallback */

/**
 * `tenjin config fallback on|off --source <account>`: what happens when one
 * of the user's connected accounts refuses a call (its sign-in expired, or its
 * plan or rate limit ran out). Off, the default: the call stops and offers
 * Tenjin's own tool for the job with its price, which runs only when the user
 * picks it. On: that tool runs in its place, from the Tenjin balance within
 * its limits, and the receipt says so. Saved on the account's own entry, so it
 * stays across a reconnect and goes with a disconnect. Works offline.
 */
export async function runConfigFallback(
  args: { state: string; source?: string[] },
  ctx: CommandContext,
  deps: ConfigRulesDeps = {},
): Promise<CommandResult> {
  if (args.state !== 'on' && args.state !== 'off')
    usage(
      `fallback takes on or off; got "${args.state}".`,
      'tenjin config fallback on --source apify',
    );
  const names = (args.source ?? []).map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length !== 1)
    usage('Name one connected account with --source.', 'tenjin config fallback on --source apify');
  const wanted = names[0]!.toLowerCase();
  const find = (router: unknown) =>
    savedAccountsIn(router).find(
      (account) => account.id === wanted || account.label.toLowerCase() === wanted,
    );
  const before = find((await loadRawConfig(ctx.dataDir)).router);
  if (before === undefined) {
    usage(
      `"${names[0]}" isn't one of your connected accounts, so nothing was saved.`,
      'Connect it first with `tenjin connect <name>`.',
    );
  }
  const on = args.state === 'on';
  await persist(ctx.dataDir, (existing) => {
    const router = { ...((existing.router ?? {}) as Record<string, unknown>) };
    const saved = Array.isArray(router.sources)
      ? (router.sources as Record<string, unknown>[])
      : [];
    router.sources = saved.map((entry) => {
      if (entry.id !== before.id) return entry;
      const next = { ...entry };
      if (on) next.onRefusal = 'tenjin';
      else delete next.onRefusal;
      return next;
    });
    return { ...existing, router };
  });
  const after = find((await loadRawConfig(ctx.dataDir)).router) ?? before;
  const { label, id } = after;
  const explanation = on
    ? [
        `${SAVED_PREFIX} when your ${label} account refuses a call (its sign-in expired, or its plan or rate limit ran out), Tenjin runs its own tool for the same job instead. It is paid from your Tenjin balance within your limits, and the receipt says so.`,
        `A call your ${label} account ran and then failed is never run again on Tenjin's tool: your ${label} plan may already have paid for it.`,
      ]
    : [
        `${SAVED_PREFIX} when your ${label} account refuses a call, Tenjin stops and offers its own tool for the job with its price, and runs it only when you say so.`,
      ];
  return answer(
    {
      operation: 'fallback',
      changed: (before.onRefusal === 'tenjin') !== on,
      scope: 'user',
      explanation,
      ...(on ? { reset: `tenjin config fallback off --source ${id}` } : {}),
      extra: { account: { id, label, onRefusal: on ? 'tenjin' : 'ask' } },
    },
    ctx,
    deps,
    await cachedDirectory(ctx.dataDir),
  );
}
