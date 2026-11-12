import { CliError } from '../lib/errors';
import {
  loadRawConfig,
  resolveSettings,
  SavedPolicySchema,
  type PartialConfig,
  type SettingScope,
} from '../lib/config';
import type { CommandContext, CommandResult } from '../context';
import {
  ONLY_DIMENSIONS,
  POLICY_VERSION,
  scopeKey,
  targetKey,
  type OnlyDimension,
  type OnlyRule,
  type PreferRule,
  type SavedPolicy,
  type Scope,
  type Target,
  type TargetKind,
} from '../router/settings-wire';
import {
  cachedIdentities,
  entriesOf,
  fetchIdentities,
  KIND_NOUN,
  labelOf,
  resolveName,
  type Identities,
  type Named,
} from '../router/identities';
import { routerSettings, type RouterSettings } from '../router/settings';
import { savedAccountsIn } from '../router/accounts/saved';
import { persist } from './config';
import {
  POLICY_INVALID_TEXT,
  REPLACEMENT_NAME,
  SAVED_HERE,
  SAVED_PREFIX,
  blockedBy,
  connectedLabels,
  describeBlock,
  describeLimits,
  describeOnly,
  describePrefer,
  describeReplacement,
  describeRules,
  describeSpeed,
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
 * `tenjin config prefer|only|block|unblock|reset|speed|replacement` (plan
 * 36): THE OPERATIONS AN AGENT RUNS WHEN A USER ASKS TO CHANGE WHAT TENJIN MAY
 * USE. Each is deterministic and answers with what it actually wrote, in the
 * user's words, with the one command that undoes it; no model call configures
 * anything, and nothing here decides a call: the server applies the rules.
 *
 * NAMES FIRST, THEN THE LOCK. An operation that takes a name ("Exa",
 * "images") resolves it against the router's free identities read before it
 * takes the config lock, and only an exact or unique match is written: an
 * ambiguous or unknown name, a failed read or a conflict writes nothing.
 * Inside the lock the file is reread, the change merged into what is there
 * now and checked, then written atomically, so two agents changing unrelated
 * rules at once both land.
 *
 * OFFLINE WHERE IT MATTERS. Unblock, reset, `speed` and `replacement off`
 * never ask the network: removing a rule or stopping automatic use works when
 * the router does not answer. They match a saved id directly, or through the
 * labels last read.
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

/** Test seams: the identities read's transport, and where the command runs. */
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

const list = new Intl.ListFormat('en');

const one = <T>(values: readonly T[]): T => values[0] as T;

/** The router's identities now, or an error that saved nothing. */
async function liveIdentities(ctx: CommandContext, deps: ConfigRulesDeps): Promise<Identities> {
  const config = await loadRawConfig(ctx.dataDir);
  const { baseUrl } = resolveSettings({
    config,
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
  });
  const read = await fetchIdentities(ctx, {
    baseUrl: baseUrl.value,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (!read.ok) {
    throw new CliError(
      read.unreachable === true ? 'API_UNREACHABLE' : 'NETWORK_ERROR',
      `Tenjin couldn't look up those names right now, so nothing was saved. (${read.reason})`,
      {
        fix: 'Try again in a moment. Showing your settings, pausing Tenjin, unblocking and resetting all work without the network.',
      },
    );
  }
  return read.identities;
}

/** The router's identities now, or undefined when it does not answer: for a
 *  readback only, so a write never waits on it. */
async function freshIdentities(
  ctx: CommandContext,
  deps: ConfigRulesDeps,
): Promise<Identities | undefined> {
  try {
    return await liveIdentities(ctx, deps);
  } catch {
    return undefined;
  }
}

const shown = (entries: readonly Named[]) =>
  entries.map(({ id, label }) => (label === id ? label : `${label} (${id})`)).join(', ');

/** Every name resolved, or a USAGE error naming the one that was not. */
function resolveAll(
  identities: Identities,
  wanted: readonly Wanted[],
): { target: Target; label: string }[] {
  const resolved: { target: Target; label: string }[] = [];
  for (const { kind, name } of wanted) {
    const noun = KIND_NOUN[kind];
    const found = resolveName(identities, kind, name);
    if (found.status === 'ambiguous') {
      usage(
        `"${name}" matches more than one ${noun}: ${shown(found.candidates)}. Nothing was saved.`,
        'Run it again with the id in parentheses of the one meant.',
        { kind, name, candidates: found.candidates },
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
    if (!resolved.some(({ target }) => targetKey(target) === targetKey(found.target))) {
      resolved.push({ target: found.target, label: found.label });
    }
  }
  return resolved;
}

/** The saved policy as the change finds it, read inside the lock: a policy
 *  this build cannot read changes only through `reset --all`. */
function savedPolicyOf(existing: PartialConfig): SavedPolicy {
  const raw = (existing.router as Record<string, unknown> | undefined)?.policy;
  if (raw === undefined) return { version: POLICY_VERSION };
  const parsed = SavedPolicySchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const problem = `router.policy.${(issue?.path ?? []).join('.')}: ${issue?.message ?? 'invalid'}`;
  throw new CliError('CONFIG_INVALID', `${POLICY_INVALID_TEXT} (${problem}) Nothing was changed.`, {
    fix: 'Clear the saved rules with `tenjin config reset --all`, then set them again.',
    details: { problem },
  });
}

/** The policy with every emptied collection and a false switch dropped, or none. */
function tidy(policy: SavedPolicy): SavedPolicy | undefined {
  const next: SavedPolicy = {
    version: policy.version,
    ...(policy.block?.length ? { block: policy.block } : {}),
    ...(policy.only?.length ? { only: policy.only } : {}),
    ...(policy.prefer?.length ? { prefer: policy.prefer } : {}),
    ...(policy.preferSpeed === true ? { preferSpeed: true } : {}),
  };
  return Object.keys(next).length === 1 ? undefined : next;
}

function withPolicy(existing: PartialConfig, policy: SavedPolicy): PartialConfig {
  const router = { ...((existing.router ?? {}) as Record<string, unknown>) };
  delete router.policy;
  const kept = tidy(policy);
  return { ...existing, router: { ...router, ...(kept !== undefined ? { policy: kept } : {}) } };
}

/** The checks a saved policy meets, run on the change before it is written. */
function checkSavable(policy: SavedPolicy): void {
  const saved = SavedPolicySchema.safeParse(policy);
  if (saved.success) return;
  const [issue] = saved.error.issues;
  throw new CliError(
    'REFUSED',
    `That change would leave settings Tenjin can't use (${issue?.message ?? 'invalid'}). Nothing was saved.`,
    { fix: `Remove a rule you no longer need first. ${HELP}`, details: saved.error.issues },
  );
}

function conflict(target: Target, block: Target, identities: Identities | undefined): never {
  const name = labelOf(target, identities);
  const why =
    targetKey(target) === targetKey(block)
      ? `${name} is blocked in your settings`
      : `${name} is covered by your block on ${labelOf(block, identities)}`;
  throw new CliError('REFUSED', `${why}, so it can't be chosen here. Nothing was saved.`, {
    fix: `Blocks win over every other rule. To use it again, the user can run \`${unblockCommand(block)}\` first.`,
    details: { target, block },
  });
}

async function readBack(ctx: CommandContext, deps: ConfigRulesDeps): Promise<RouterSettings> {
  return routerSettings({ cwd: deps.cwd ?? process.cwd(), dataDir: ctx.dataDir });
}

async function limitsOf(ctx: CommandContext) {
  const config = await loadRawConfig(ctx.dataDir);
  const settings = resolveSettings({ config, flags: {}, env: process.env });
  return describeLimits(settings.maxAutoSpend.value, settings.sessionBudget.value);
}

/** The line every saved rule change adds about automatic use. */
async function replacementNote(router: RouterSettings, ctx: CommandContext): Promise<string> {
  if (router.nativeReplacement.mode === 'off')
    return `${REPLACEMENT_NAME} is off, and this doesn't turn it on.`;
  const support = await replacementSupport(ctx.dataDir);
  return support.supported
    ? `${REPLACEMENT_NAME} is on, so this also holds for the searches and fetches Tenjin runs in place.`
    : `${REPLACEMENT_NAME} is on. ${support.why}`;
}

type Operation =
  | 'prefer'
  | 'only'
  | 'block'
  | 'unblock'
  | 'reset'
  | 'speed'
  | 'replacement'
  | 'fallback'
  | 'connect'
  | 'disconnect';

export interface Outcome {
  operation: Operation;
  changed: boolean;
  scope: SettingScope;
  /** The rule this operation wrote or removed, typed ids and all. */
  rule?: unknown;
  /** The sentences a person reads first. */
  explanation: string[];
  effective?: RuleReadback[];
  removed?: unknown[];
  reset?: string;
  extra?: Record<string, unknown>;
}

/**
 * THE ONE ENVELOPE EVERY OPERATION ANSWERS WITH: the changed rule, its saved
 * scope, what is in effect now, why, and how to undo it, from the file as it
 * reads back after the write rather than from what the operation meant.
 */
export async function answer(
  outcome: Outcome,
  ctx: CommandContext,
  deps: ConfigRulesDeps,
  identities: Identities | undefined,
): Promise<CommandResult> {
  const router = await readBack(ctx, deps);
  const limits = await limitsOf(ctx);
  const settings = settingsReadback(
    router,
    identities,
    limits,
    await replacementSupport(ctx.dataDir),
  );
  const unreadable =
    router.policy.status === 'invalid' ? [`${POLICY_INVALID_TEXT} ${router.policy.problem}.`] : [];
  return {
    data: {
      operation: outcome.operation,
      changed: outcome.changed,
      saved: SAVED_HERE,
      scope: outcome.scope,
      ...(outcome.rule !== undefined ? { rule: outcome.rule } : {}),
      ...(outcome.effective !== undefined ? { effective: outcome.effective } : {}),
      ...(outcome.removed !== undefined ? { removed: outcome.removed } : {}),
      explanation: outcome.explanation.join(' '),
      ...(outcome.reset !== undefined ? { reset: outcome.reset } : {}),
      ...outcome.extra,
      settings: settings.data,
    },
    humanLines: [
      ...outcome.explanation,
      ...unreadable,
      ...(outcome.reset !== undefined ? [`To undo: \`${outcome.reset}\``] : []),
    ],
  };
}

const said = (rule: RuleReadback) =>
  rule.inactive !== undefined ? `${rule.text} (${rule.inactive})` : rule.text;

/* ------------------------------------------------------------------ prefer */

/**
 * `tenjin config prefer`: the order Tenjin tries allowed services in. With
 * `--task` or `--category`, that scope's ordered providers, services or
 * accounts; with `--source` alone (or `--global`), the account-wide order of
 * your accounts. Repeating it replaces the list at that scope and leaves every
 * other rule alone. A preference never forbids anything: other allowed
 * services remain the fallback. "Use my fal account for images" and "only use
 * my account for images" are both `prefer --category images --source fal`.
 */
export async function runConfigPrefer(
  flags: ScopeFlags,
  ctx: CommandContext,
  deps: ConfigRulesDeps = {},
): Promise<CommandResult> {
  if (flags.seller?.length) {
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
  const categories = flags.category ?? [];
  if (tasks.length + categories.length > 1)
    usage('A preference is for one task or one category: name it once.');
  if (flags.global === true && tasks.length + categories.length > 0)
    usage('--global and --task or --category name different scopes: use one.');
  if (tasks.length + categories.length === 0 && kind !== 'source') {
    usage(
      `A ${kind} preference is for one task or category: add --task "<task>" or --category <category>.`,
      'Only your accounts can be preferred across every task (--source without --task).',
    );
  }
  const identities = await liveIdentities(ctx, deps);
  const where =
    tasks.length > 0
      ? one(resolveAll(identities, [{ kind: 'task', name: one(tasks) }]))
      : categories.length > 0
        ? one(resolveAll(identities, [{ kind: 'category', name: one(categories) }]))
        : undefined;
  const targets = resolveAll(identities, wantedOf(flags, [kind])).map(({ target }) => target);
  const scope: Scope =
    where === undefined
      ? { kind: 'global' }
      : where.target.kind === 'task'
        ? { kind: 'task', id: where.target.id }
        : { kind: 'category', id: where.target.id };
  const rule: PreferRule = { scope, targets };
  let after: SavedPolicy = { version: POLICY_VERSION };
  let replaced: PreferRule | undefined;
  await persist(ctx.dataDir, (existing) => {
    const policy = savedPolicyOf(existing);
    for (const target of targets) {
      const block = blockedBy(target, policy, identities);
      if (block !== undefined) conflict(target, block, identities);
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
    checkSavable(after);
    return withPolicy(existing, after);
  });
  const effective = describePrefer(rule, after, identities);
  const router = await readBack(ctx, deps);
  return answer(
    {
      operation: 'prefer',
      changed: true,
      scope: 'user',
      rule,
      explanation: [`${SAVED_PREFIX} ${said(effective)}`, await replacementNote(router, ctx)],
      effective: [effective],
      ...(replaced !== undefined ? { removed: [replaced] } : {}),
      reset: preferResetCommand(scope),
    },
    ctx,
    deps,
    identities,
  );
}

/* -------------------------------------------------------------------- only */

/**
 * `tenjin config only`: a nonempty allowed set. `--global` with categories or
 * tasks limits which tasks Tenjin does anywhere; `--task` with providers,
 * sellers or services limits who does that one task and leaves every other
 * task alone. Repeating it replaces the set for that scope and dimension;
 * other dimensions and blocks stay. There is no only for accounts.
 */
export async function runConfigOnly(
  flags: ScopeFlags,
  ctx: CommandContext,
  deps: ConfigRulesDeps = {},
): Promise<CommandResult> {
  if (flags.source?.length) {
    usage(
      'There is no only for accounts: "only use my account for X" is a preference, `tenjin config prefer --category <X> --source <account>`. To stop Tenjin\'s own tools altogether: `tenjin config block --source tenjin`.',
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
  const identities = await liveIdentities(ctx, deps);
  if (scope === undefined) {
    const task = one(resolveAll(identities, [{ kind: 'task', name: one(flags.task ?? []) }]));
    scope = { kind: 'task', id: task.target.id };
  }
  const targets = resolveAll(identities, wanted).map(({ target }) => target);
  const rule: OnlyRule = { scope, dimension, targets };
  let after: SavedPolicy = { version: POLICY_VERSION };
  let replaced: OnlyRule | undefined;
  await persist(ctx.dataDir, (existing) => {
    const policy = savedPolicyOf(existing);
    for (const target of targets) {
      const block = blockedBy(target, policy, identities);
      if (block !== undefined) conflict(target, block, identities);
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
    checkSavable(after);
    return withPolicy(existing, after);
  });
  const effective = describeOnly(rule, after, identities);
  const router = await readBack(ctx, deps);
  return answer(
    {
      operation: 'only',
      changed: true,
      scope: 'user',
      rule,
      explanation: [`${SAVED_PREFIX} ${said(effective)}`, await replacementNote(router, ctx)],
      effective: [effective],
      ...(replaced !== undefined ? { removed: [replaced] } : {}),
      reset: onlyResetCommand(rule),
    },
    ctx,
    deps,
    identities,
  );
}

/* ------------------------------------------------------------------- block */

/**
 * `tenjin config block`: a hard restriction on any kind of target. It always
 * lands, even when it leaves a saved preference or only rule unusable: the
 * block wins, and readback marks the rule it made inactive rather than
 * deleting it. `--source tenjin` turns off Tenjin's own tools, free ones too,
 * and its readback is the warning.
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
  const identities = await liveIdentities(ctx, deps);
  const targets = resolveAll(identities, wanted).map(({ target }) => target);
  let before: SavedPolicy = { version: POLICY_VERSION };
  let after: SavedPolicy = { version: POLICY_VERSION };
  const added: Target[] = [];
  await persist(ctx.dataDir, (existing) => {
    const policy = savedPolicyOf(existing);
    before = policy;
    const saved = new Set((policy.block ?? []).map(targetKey));
    added.splice(0, added.length, ...targets.filter((target) => !saved.has(targetKey(target))));
    if (added.length === 0) return existing;
    after = { ...policy, block: [...(policy.block ?? []), ...added] };
    checkSavable(after);
    return withPolicy(existing, after);
  });
  const router = await readBack(ctx, deps);
  const effective = targets.map((target) =>
    describeBlock(target, identities, connectedLabels(router)),
  );
  const wasActive = new Set(
    describeRules(before, identities)
      .filter(({ inactive }) => inactive === undefined)
      .map(({ rule }) => JSON.stringify(rule)),
  );
  const nowInactive =
    added.length === 0
      ? []
      : describeRules(after, identities).filter(
          ({ kind, inactive, rule }) =>
            kind !== 'block' && inactive !== undefined && wasActive.has(JSON.stringify(rule)),
        );
  const fresh = new Set(added.map(targetKey));
  const explanation = [
    ...effective
      .filter(({ rule }) => fresh.has(targetKey(rule as Target)))
      .map(({ text }, index) => (index === 0 ? `${SAVED_PREFIX} ${text}` : text)),
    ...targets
      .filter((target) => !fresh.has(targetKey(target)))
      .map((target) => `${labelOf(target, identities)} was already blocked.`),
    ...nowInactive.map(
      (rule) => `This leaves a saved rule unusable, kept as it is: ${rule.text} (${rule.inactive})`,
    ),
  ];
  return answer(
    {
      operation: 'block',
      changed: added.length > 0,
      scope: 'user',
      rule: added,
      explanation,
      effective,
      ...(added.length > 0
        ? { reset: added.map((target) => unblockCommand(target)).join(' && ') }
        : {}),
      extra: { inactive: nowInactive },
    },
    ctx,
    deps,
    identities,
  );
}

/* ----------------------------------------------------------------- unblock */

const folded = (text: string) => text.trim().toLowerCase();

/**
 * A saved target a typed name means, with no network: the id itself, the id
 * in another case, or a label the identities last read give that id.
 */
function savedMatch(
  wanted: Wanted,
  saved: readonly Target[],
  identities: Identities | undefined,
): Target | undefined {
  const ofKind = saved.filter(({ kind }) => kind === wanted.kind);
  const direct =
    ofKind.find(({ id }) => id === wanted.name) ??
    ofKind.find(({ id }) => folded(id) === folded(wanted.name));
  if (direct !== undefined) return direct;
  const ids = new Set(
    entriesOf(identities, wanted.kind)
      .filter(({ label }) => folded(label) === folded(wanted.name))
      .map(({ id }) => id),
  );
  const byLabel = ofKind.filter(({ id }) => ids.has(id));
  return byLabel.length === 1 ? byLabel[0] : undefined;
}

/** `tenjin config unblock`: removes the named blocks and nothing else, offline. */
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
  const identities = await cachedIdentities(ctx.dataDir);
  const removed: Target[] = [];
  const missing: Wanted[] = [];
  let remaining: Target[] = [];
  await persist(ctx.dataDir, (existing) => {
    const policy = savedPolicyOf(existing);
    const saved = policy.block ?? [];
    removed.length = 0;
    missing.length = 0;
    for (const name of wanted) {
      const match = savedMatch(name, saved, identities);
      if (match === undefined) missing.push(name);
      else if (!removed.includes(match)) removed.push(match);
    }
    remaining = saved.filter((target) => !removed.includes(target));
    return removed.length === 0 ? existing : withPolicy(existing, { ...policy, block: remaining });
  });
  const names = removed.map((target) => labelOf(target, identities));
  const explanation = [
    ...(removed.length > 0
      ? [
          `${SAVED_PREFIX} ${list.format(names)} ${removed.length === 1 ? 'is' : 'are'} no longer blocked. Your other rules stay as they are.`,
        ]
      : []),
    ...missing.map(
      ({ kind, name }) =>
        `Nothing saved blocks a ${KIND_NOUN[kind]} named "${name}", so nothing changed for it.`,
    ),
    ...(missing.length > 0 && remaining.length > 0
      ? [`Saved blocks: ${remaining.map((target) => labelOf(target, identities)).join(', ')}.`]
      : []),
  ];
  return answer(
    {
      operation: 'unblock',
      changed: removed.length > 0,
      scope: 'user',
      rule: removed,
      explanation,
      removed,
      ...(removed.length > 0
        ? { reset: `tenjin config block ${removed.map((target) => flagFor(target)).join(' ')}` }
        : {}),
      extra: { missing },
    },
    ctx,
    deps,
    identities,
  );
}

/* ------------------------------------------------------------------- reset */

/** A saved scope a typed task or category name means, offline. */
function savedScope(
  wanted: Wanted,
  scopes: readonly Scope[],
  identities: Identities | undefined,
): Scope | undefined {
  const typed = scopes.flatMap((scope) =>
    scope.kind === wanted.kind ? [{ kind: wanted.kind, id: scope.id }] : [],
  );
  const match = savedMatch(wanted, typed, identities);
  if (match === undefined) return undefined;
  return match.kind === 'task'
    ? { kind: 'task', id: match.id }
    : { kind: 'category', id: match.id };
}

/**
 * `tenjin config reset`: removes exactly the rule it names, offline.
 * `--preference`: a task's or category's preference, or the account-wide one
 * (`--global`), or with `--source` (or `--provider`, `--service`) just those
 * targets from it. `--restriction`: a task's (or `--global`) only rules, or
 * with `--dimension` just one of them. `--capabilities`: the global task and
 * category limit. `--all`: every saved routing rule, readable or not. Blocks
 * go with unblock, automatic use with `replacement off`, speed with `speed
 * off`; spending limits are never touched.
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
  const scopes = wantedOf(flags, ['task', 'category']);
  const targets = wantedOf(flags, ['provider', 'service', 'source', 'seller']);
  if (scopes.length > 1) usage('Reset one scope at a time: name one task or one category.');
  if (flags.global === true && scopes.length > 0)
    usage('--global and --task or --category name different scopes: use one.');
  if (flags.dimension !== undefined && mode !== 'restriction')
    usage('--dimension goes with --restriction.');
  const dimension = flags.dimension as OnlyDimension | undefined;
  if (dimension !== undefined && !ONLY_DIMENSIONS.includes(dimension)) {
    usage(
      `--dimension is one of ${ONLY_DIMENSIONS.join(', ')}; got "${flags.dimension}".`,
      'tenjin config reset --task "web research" --restriction --dimension provider',
    );
  }
  if (mode === 'all' && (scopes.length > 0 || targets.length > 0 || flags.global === true))
    usage('--all resets every saved routing rule and takes nothing else.');
  if (mode === 'capabilities' && (scopes.length > 0 || targets.length > 0))
    usage('--capabilities resets the global task and category limit and takes nothing else.');
  if (mode === 'restriction') {
    if (targets.length > 0)
      usage('--restriction resets a whole rule: name its scope and, optionally, --dimension.');
    if (scopes.some(({ kind }) => kind === 'category'))
      usage('A restriction is global or for one task: use --task or --global.');
    if (scopes.length === 0 && flags.global !== true)
      usage('Say which restriction: --task "<task>" or --global.', HELP);
  }
  if (mode === 'preference') {
    if (targets.some(({ kind }) => kind === 'seller'))
      usage('A preference holds providers, services or accounts.');
    if (scopes.length === 0 && flags.global !== true && targets.length === 0)
      usage(
        'Say which preference: --task "<task>", --category <category>, --global, or --source <account>.',
        HELP,
      );
  }

  const identities = await cachedIdentities(ctx.dataDir);
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
    const policy = savedPolicyOf(existing);
    const only = policy.only ?? [];
    const prefer = policy.prefer ?? [];
    const named = scopes.length > 0 ? one(scopes) : undefined;
    if (mode === 'capabilities' || mode === 'restriction') {
      const scope: Scope | undefined =
        mode === 'capabilities' || flags.global === true
          ? { kind: 'global' }
          : savedScope(
              named!,
              only.map(({ scope: s }) => s),
              identities,
            );
      const want = mode === 'capabilities' ? 'capability' : dimension;
      const drop = only.filter(
        (entry) =>
          scope !== undefined &&
          scopeKey(entry.scope) === scopeKey(scope) &&
          (want === undefined || entry.dimension === want),
      );
      if (drop.length === 0) {
        const where =
          scope?.kind === 'task'
            ? labelOf({ kind: 'task', id: scope.id }, identities)
            : (named?.name ?? 'every task');
        missing =
          mode === 'capabilities'
            ? 'There is no saved limit on which tasks Tenjin does to reset.'
            : `There is no saved ${want !== undefined ? `${want} ` : ''}restriction for ${where} to reset.`;
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
      named !== undefined
        ? savedScope(
            named,
            prefer.map(({ scope: s }) => s),
            identities,
          )
        : { kind: 'global' };
    const entry =
      scope === undefined
        ? undefined
        : prefer.find((candidate) => scopeKey(candidate.scope) === scopeKey(scope));
    if (entry === undefined) {
      missing =
        named !== undefined
          ? `There is no saved preference for ${named.name} to reset.`
          : 'There is no saved account-wide preference to reset.';
      return existing;
    }
    touched.push(entry);
    if (targets.length === 0) {
      removed.push(entry);
      return withPolicy(existing, { ...policy, prefer: prefer.filter((rule) => rule !== entry) });
    }
    const drop = targets.flatMap((name) => savedMatch(name, entry.targets, identities) ?? []);
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
      : mode === 'all'
        ? [
            `${SAVED_PREFIX} removed every saved routing rule, including your blocks, restrictions, preferences and the speed setting, so anything you blocked can be used again. ${REPLACEMENT_NAME} and your spending limits stay as they are.`,
          ]
        : [
            `${SAVED_PREFIX} removed ${describeRemoved(mode, removed, identities)}. Your blocks, limits and other rules stay as they are.`,
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
    identities,
  );
}

/** The command that saves a rule again exactly as it was. */
function recreate(rule: OnlyRule | PreferRule): string {
  const where =
    rule.scope.kind === 'global'
      ? ''
      : `${rule.scope.kind === 'task' ? '--task' : '--category'} ${shellWord(rule.scope.id)}`;
  const targets = rule.targets.map((target) => flagFor(target)).join(' ');
  if ('dimension' in rule) {
    return `tenjin config only ${rule.scope.kind === 'global' ? '--global' : where} ${targets}`;
  }
  return ['tenjin config prefer', where, targets].filter((part) => part.length > 0).join(' ');
}

function describeRemoved(
  mode: 'preference' | 'restriction' | 'capabilities',
  removed: readonly unknown[],
  identities: Identities | undefined,
): string {
  if (mode === 'preference') {
    const [first] = removed;
    if (first !== null && typeof first === 'object' && 'scope' in first) {
      const rule = first as PreferRule;
      return rule.scope.kind === 'global'
        ? 'your account-wide preference'
        : `your preference for ${labelOf({ kind: rule.scope.kind, id: rule.scope.id }, identities)}`;
    }
    return `${list.format((removed as Target[]).map((target) => labelOf(target, identities)))} from that preference`;
  }
  return list.format(
    (removed as OnlyRule[]).map((rule) => {
      const where =
        rule.scope.kind === 'global'
          ? ''
          : ` for ${labelOf({ kind: rule.scope.kind, id: rule.scope.id }, identities)}`;
      return rule.dimension === 'capability'
        ? 'the limit on which tasks Tenjin does'
        : `the ${rule.dimension} restriction${where}`;
    }),
  );
}

/* ------------------------------------------------------------------- speed */

/**
 * `tenjin config speed on|off`: whether Tenjin also offers paid tools for
 * jobs where a measured paid tool is as accurate as the agent's own and
 * clearly faster. One switch, written offline; it changes when Tenjin offers,
 * never which service it picks, and raises no limit. `on` reads back the
 * kinds of job it changes from a fresh identities read when the router
 * answers, else from the copy last read.
 */
export async function runConfigSpeed(
  args: { state: string },
  ctx: CommandContext,
  deps: ConfigRulesDeps = {},
): Promise<CommandResult> {
  if (args.state !== 'on' && args.state !== 'off')
    usage(`speed takes on or off; got "${args.state}".`, 'tenjin config speed on');
  const on = args.state === 'on';
  let changed = false;
  await persist(ctx.dataDir, (existing) => {
    const policy = savedPolicyOf(existing);
    changed = (policy.preferSpeed === true) !== on;
    if (!changed) return existing;
    const next: SavedPolicy = { ...policy };
    if (on) next.preferSpeed = true;
    else delete next.preferSpeed;
    return withPolicy(existing, next);
  });
  const identities = on
    ? ((await freshIdentities(ctx, deps)) ?? (await cachedIdentities(ctx.dataDir)))
    : await cachedIdentities(ctx.dataDir);
  const effective = describeSpeed(identities);
  const explanation = on
    ? [`${SAVED_PREFIX} ${effective.text}`]
    : [
        `${SAVED_PREFIX} Tenjin offers a paid tool only when your agent's own tools can't do the job as well. Your other rules stay as they are.`,
      ];
  return answer(
    {
      operation: 'speed',
      changed,
      scope: 'user',
      rule: { preferSpeed: on },
      explanation,
      ...(on ? { effective: [effective] } : {}),
      reset: on ? 'tenjin config speed off' : 'tenjin config speed on',
    },
    ctx,
    deps,
    identities,
  );
}

/* ------------------------------------------------------------- replacement */

/**
 * `tenjin config replacement on|off`: "Run Tenjin's picks automatically",
 * whether a host that supports it may run Tenjin's pick in place of the
 * agent's own web search or page fetch. `on` needs `--provider` (a nonempty
 * scope) or `--all-providers` (which removes any saved scope), and writes mode
 * and scope in one write; `off` keeps a saved scope for inspection. The scope
 * narrows automatic acceptance only: it never changes what is allowed or which
 * service is picked first.
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
      'Say which providers: --provider <provider> (repeatable), or --all-providers for any allowed provider.',
      'tenjin config replacement on --provider exa',
    );
  }
  const narrowed = args.state === 'on' && providers.length > 0;
  const identities = narrowed
    ? await liveIdentities(ctx, deps)
    : await cachedIdentities(ctx.dataDir);
  const scope =
    narrowed && identities !== undefined
      ? resolveAll(
          identities,
          providers.map((name) => ({ kind: 'provider' as const, name: name.trim() })),
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
      const policy = SavedPolicySchema.safeParse(router.policy);
      const saved = policy.success ? policy.data : { version: POLICY_VERSION };
      for (const target of scope) {
        const block = blockedBy(target, saved, identities);
        if (block !== undefined) conflict(target, block, identities);
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
  const effective = describeReplacement(router.nativeReplacement, identities, support);
  const limits = await limitsOf(ctx);
  const either = new Intl.ListFormat('en', { type: 'disjunction' });
  const explanation =
    args.state === 'off'
      ? [
          `${SAVED_PREFIX} ${effective.text} Tenjin's offers and the requests you make stay available; to stop Tenjin altogether, run \`tenjin config set router.enabled false\`.`,
        ]
      : [
          `${SAVED_PREFIX} ${REPLACEMENT_NAME} is on${scope !== undefined ? `, only when Tenjin picks ${either.format(scope.map((target) => labelOf(target, identities)))}` : ' for any allowed provider'}.`,
          'When Tenjin picks a service for a web search or page fetch your agent is about to make, it runs that pick in place of the search or fetch instead of offering it first, so each one is a charge you are not asked about separately. Each one names the service, its price and the search or fetch it answered.',
          `Your limits still apply (${limits.perCall} a call, ${limits.daily === null ? 'no daily limit' : `${limits.daily} a day`}, Tenjin balance): a call over them is not run in place; it is offered as usual and asks first.`,
          accountsNote(router, scope !== undefined),
          'This picks no provider ahead of another and changes nothing about what is allowed: add a preference or a rule for that.',
          support.why,
        ];
  return answer(
    {
      operation: 'replacement',
      changed: true,
      scope: 'machine',
      rule: {
        mode: router.nativeReplacement.mode,
        ...(router.nativeReplacement.providers !== undefined
          ? { providers: router.nativeReplacement.providers }
          : {}),
      },
      explanation,
      reset:
        args.state === 'on'
          ? 'tenjin config replacement off'
          : router.nativeReplacement.providers !== undefined
            ? `tenjin config replacement on ${router.nativeReplacement.providers.map((target) => flagFor(target)).join(' ')}`
            : 'tenjin config replacement on --all-providers',
      extra: { replacement: effective },
    },
    ctx,
    deps,
    identities,
  );
}

/**
 * WHAT AUTOMATIC USE DOES WITH THE USER'S CONNECTED ACCOUNTS (vraspar,
 * 2026-10-23): it runs them too, for the jobs Tenjin has checked, and their
 * own plans pay, outside the limits above. Named when some are connected; a
 * provider choice applies to them as to any pick, which the router decides.
 */
function accountsNote(router: RouterSettings, narrowed: boolean): string {
  const names = router.accounts.saved
    .filter((account) => account.mapped === true && router.accounts.connected.includes(account.id))
    .map(({ label }) => label);
  const within = narrowed ? ' within the same provider choice' : '';
  if (names.length === 0)
    return `An account you connect with \`tenjin connect\` runs this way too${within}, for the jobs Tenjin has checked, and its own plan pays, not the Tenjin balance.`;
  const yours = `your ${new Intl.ListFormat('en', { type: 'conjunction' }).format(names)} ${names.length === 1 ? 'account' : 'accounts'}`;
  return `It also runs ${yours} this way${within}, for the jobs Tenjin has checked: those calls bill your own plan, not the Tenjin balance, and don't count toward these limits.`;
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
    await cachedIdentities(ctx.dataDir),
  );
}
