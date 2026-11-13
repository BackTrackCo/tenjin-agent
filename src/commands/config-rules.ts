import { CliError } from '../lib/errors';
import { paint } from '../lib/output';
import {
  editSources,
  loadRawConfig,
  readPersonalRouter,
  type PartialConfig,
  type SettingScope,
} from '../lib/config';
import type { CommandContext, CommandResult } from '../context';
import {
  BUILT_IN_SOURCE,
  ONLY_DIMENSIONS,
  POLICY_VERSION,
  ReplacementProvidersSchema,
  SETTINGS_LIMITS,
  SavedPolicySchema,
  TARGET_KINDS,
  hasRules,
  onlyKey,
  scopeKey,
  targetKey,
  wirePolicy,
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
  folded,
  KIND_NOUN,
  labelOf,
  resolveName,
  servicesNaming,
  speedTasks,
  tasksOf,
  type Identities,
  type Named,
} from '../router/identities';
import { routerSettings, type ReplacementSetting, type RouterSettings } from '../router/settings';
import { savedAccountsIn } from '../router/accounts/saved';
import { persist, resolveFromContext } from './config';
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
  either,
  flagFor,
  list,
  onlyResetCommand,
  preferResetCommand,
  replacementSupport,
  nameOf,
  scopeFlag,
  settingsReadback,
  summarizeRule,
  unblockCommand,
  type LimitsReadback,
  type ReplacementSupport,
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
export type TargetFlags = Partial<Record<TargetKind, string[]>>;

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

interface Wanted {
  kind: TargetKind;
  name: string;
}

function wantedOf(flags: TargetFlags, kinds: readonly TargetKind[] = TARGET_KINDS): Wanted[] {
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

const one = <T>(values: readonly T[]): T => values[0] as T;

/** The router's identities now, or an error that saved nothing. */
async function liveIdentities(ctx: CommandContext, deps: ConfigRulesDeps): Promise<Identities> {
  const { baseUrl } = await resolveFromContext(ctx);
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

/** The config with `policy` saved as the wire sends it: every emptied
 *  collection and a false switch dropped, and no policy at all for no rules. */
function withPolicy(existing: PartialConfig, policy: SavedPolicy): PartialConfig {
  const router = { ...((existing.router ?? {}) as Record<string, unknown>) };
  delete router.policy;
  const rules = wirePolicy(policy);
  return {
    ...existing,
    router: {
      ...router,
      ...(hasRules(rules) ? { policy: { version: policy.version, ...rules } } : {}),
    },
  };
}

/** `rules` with `rule` in place of the one in its slot, or added after them,
 *  and the one it replaced. */
function upsert<T>(
  rules: readonly T[] | undefined,
  rule: T,
  slot: (rule: T) => string,
): { next: T[]; replaced: T | undefined } {
  const saved = rules ?? [];
  const replaced = saved.find((entry) => slot(entry) === slot(rule));
  return {
    next:
      replaced !== undefined
        ? saved.map((entry) => (entry === replaced ? rule : entry))
        : [...saved, rule],
    replaced,
  };
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

/** Refuses targets a saved block already rules out: blocks win. */
function refuseBlocked(
  targets: readonly Target[],
  policy: Pick<SavedPolicy, 'block'>,
  identities: Identities | undefined,
): void {
  for (const target of targets) {
    const block = blockedBy(target, policy, identities);
    if (block !== undefined) conflict(target, block, identities);
  }
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

/** The settings as they read back after a write, with the limits and where
 *  automatic use works. */
interface ReadBack {
  router: RouterSettings;
  limits: LimitsReadback;
  support: ReplacementSupport;
}

async function readBack(ctx: CommandContext, deps: ConfigRulesDeps): Promise<ReadBack> {
  const router = await routerSettings({ cwd: deps.cwd ?? process.cwd(), dataDir: ctx.dataDir });
  const { maxAutoSpend, sessionBudget } = await resolveFromContext(ctx);
  return {
    router,
    limits: describeLimits(maxAutoSpend.value, sessionBudget.value),
    support: await replacementSupport(ctx.dataDir),
  };
}

/** The line every saved rule change adds about automatic use. */
function replacementNote({ router, support }: ReadBack): string {
  if (router.nativeReplacement.mode === 'off')
    return `${REPLACEMENT_NAME} is off, and this doesn't turn it on.`;
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
  /** The sentences an agent reads: `--json`'s `explanation`, and the human
   *  lines of an operation with no {@link Outcome.human}. */
  explanation: string[];
  /** What a person reads at a terminal instead: at most three lines. */
  human?: Reply;
  effective?: RuleReadback[];
  removed?: unknown[];
  reset?: string;
  extra?: Record<string, unknown>;
}

/**
 * A REPLY AT A TERMINAL, AT MOST THREE LINES: `✓` and what changed, one line
 * on what that means, and the dim command that undoes it (the outcome's
 * `reset`). With no `done`, nothing changed and only `said` prints. A
 * problem is one `! ` line after it. The fine print lives in the command's
 * `--help`, and in full in `--json`'s `explanation`.
 */
export interface Reply {
  done?: string;
  said: string[];
  problems?: string[];
}

function replyLines(
  ctx: CommandContext,
  reply: Reply,
  reset: string | undefined,
  unreadable: readonly string[],
): string[] {
  const problems = [...(reply.problems ?? []), ...unreadable].map((problem) =>
    paint(ctx.io, 'yellow', `! ${problem}`),
  );
  if (reply.done === undefined) return [...reply.said, ...problems];
  return [
    `${paint(ctx.io, 'green', '✓')} ${reply.done}`,
    ...reply.said.map((line) => `  ${line}`),
    ...(reset !== undefined ? [`  ${paint(ctx.io, 'dim', `Undo: ${reset}`)}`] : []),
    ...problems,
  ];
}

/** "Inactive: Exa is blocked", from a readback's `inactive`. */
const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * THE ONE ENVELOPE EVERY OPERATION ANSWERS WITH: the changed rule, its saved
 * scope, what is in effect now, why, and how to undo it, from the file as it
 * reads back after the write (`read`, when the operation already read it)
 * rather than from what the operation meant.
 */
export async function answer(
  outcome: Outcome,
  ctx: CommandContext,
  deps: ConfigRulesDeps,
  identities: Identities | undefined,
  read?: ReadBack,
): Promise<CommandResult> {
  const { router, limits, support } = read ?? (await readBack(ctx, deps));
  const settings = settingsReadback(router, identities, limits, support);
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
    humanLines:
      outcome.human !== undefined
        ? replyLines(ctx, outcome.human, outcome.reset, unreadable)
        : [
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
    refuseBlocked(targets, policy, identities);
    const prefer = upsert(policy.prefer, rule, (entry) => scopeKey(entry.scope));
    replaced = prefer.replaced;
    after = { ...policy, prefer: prefer.next };
    checkSavable(after);
    return withPolicy(existing, after);
  });
  const effective = describePrefer(rule, after, identities);
  const read = await readBack(ctx, deps);
  const summary = summarizeRule(effective, identities, read.router.accounts.saved);
  const names = either.format(targets.map((target) => nameOf(target, identities)));
  return answer(
    {
      operation: 'prefer',
      changed: true,
      scope: 'user',
      rule,
      explanation: [`${SAVED_PREFIX} ${said(effective)}`, replacementNote(read)],
      human: {
        done: `${summary.name} ${summary.does}`,
        said: [
          targets.every(({ kind }) => kind === 'source')
            ? `${targets.length === 1 ? 'Its plan pays' : 'Their plans pay'}. Other tools still run when ${names} can't do the job.`
            : `Other tools still run when ${names} can't do the job.`,
        ],
        ...(effective.inactive !== undefined ? { problems: [sentence(effective.inactive)] } : {}),
      },
      effective: [effective],
      ...(replaced !== undefined ? { removed: [replaced] } : {}),
      // A replaced list comes back as it was; a new one is removed.
      reset: replaced !== undefined ? recreate(replaced) : preferResetCommand(scope),
    },
    ctx,
    deps,
    identities,
    read,
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
      'There is no only for accounts: "only use my account for X" is a preference, `tenjin config prefer --category <X> --source <account>`. To stop Tenjin offering its own tools on its own: `tenjin config block --source tenjin`.',
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
    refuseBlocked(targets, policy, identities);
    const only = upsert(policy.only, rule, onlyKey);
    replaced = only.replaced;
    after = { ...policy, only: only.next };
    checkSavable(after);
    return withPolicy(existing, after);
  });
  const effective = describeOnly(rule, after, identities);
  const read = await readBack(ctx, deps);
  const summary = summarizeRule(effective, identities);
  return answer(
    {
      operation: 'only',
      changed: true,
      scope: 'user',
      rule,
      explanation: [`${SAVED_PREFIX} ${said(effective)}`, replacementNote(read)],
      human: {
        ...onlyReply(rule, summary, identities),
        ...(effective.inactive !== undefined ? { problems: [sentence(effective.inactive)] } : {}),
      },
      effective: [effective],
      ...(replaced !== undefined ? { removed: [replaced] } : {}),
      reset: replaced !== undefined ? recreate(replaced) : onlyResetCommand(rule),
    },
    ctx,
    deps,
    identities,
    read,
  );
}

/** What an only rule says at a terminal: what Tenjin now offers, and what still runs. */
function onlyReply(
  rule: OnlyRule,
  summary: { name: string; short: string },
  identities: Identities | undefined,
): Reply {
  if (rule.dimension === 'capability') {
    const jobs = new Set(
      rule.targets.flatMap((target) =>
        target.kind === 'category' ? tasksOf(target.id, identities) : [target.id],
      ),
    );
    return {
      done: `Tenjin offers ${summary.short} on its own`,
      said: [
        `${jobs.size > 0 ? `${jobs.size} ${jobs.size === 1 ? 'kind' : 'kinds'} of job. ` : ''}Anything else still runs when you ask for it by name.`,
      ],
    };
  }
  const global = rule.scope.kind === 'global';
  return {
    done: global ? `Only ${summary.name}, for every job` : sentence(summary.short),
    said: [
      `If ${summary.name} can't do ${global ? 'a job' : 'it'}, Tenjin offers nothing for it. You can still ask for any tool by name.`,
    ],
  };
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
    added.push(...targets.filter((target) => !saved.has(targetKey(target))));
    if (added.length === 0) return existing;
    after = { ...policy, block: [...(policy.block ?? []), ...added] };
    checkSavable(after);
    return withPolicy(existing, after);
  });
  const read = await readBack(ctx, deps);
  const accounts = connectedLabels(read.router);
  const effective = targets.map((target) => describeBlock(target, identities, accounts));
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
  const already = targets
    .filter((target) => !fresh.has(targetKey(target)))
    .map((target) => `${blockName(target, identities)} was already blocked.`);
  const human: Reply =
    added.length === 0
      ? { said: already.map(sentence) }
      : {
          done: `Blocked ${list.format(added.map((target) => blockName(target, identities)))}`,
          said: [blockMeans(added, identities, accounts), ...already.map(sentence)],
          problems: nowInactive.map(
            (rule) =>
              `This makes a saved rule inactive: ${summarizeRule(rule, identities, read.router.accounts.saved).short}`,
          ),
        };
  const explanation = [
    ...added
      .map((target) => describeBlock(target, identities, accounts).text)
      .map((text, index) => (index === 0 ? `${SAVED_PREFIX} ${text}` : text)),
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
      human,
      effective,
      ...(added.length > 0
        ? { reset: added.map((target) => unblockCommand(target)).join(' && ') }
        : {}),
      extra: { inactive: nowInactive },
    },
    ctx,
    deps,
    identities,
    read,
  );
}

/** A blocked target as a reply names it: "Firecrawl", "your fal account". */
function blockName(target: Target, identities: Identities | undefined): string {
  if (target.kind !== 'source') return labelOf(target, identities);
  return target.id === BUILT_IN_SOURCE
    ? "Tenjin's own tools"
    : `your ${labelOf(target, identities)} account`;
}

/** What a block means, in one line: what stops, and that asking by name still works. */
function blockMeans(
  added: readonly Target[],
  identities: Identities | undefined,
  accounts: readonly string[],
): string {
  const BY_NAME = 'You can still ask for one by name.';
  if (added.length > 1) return `Tenjin won't offer them on its own. ${BY_NAME}`;
  const target = added[0]!;
  if (target.kind === 'source' && target.id === BUILT_IN_SOURCE) {
    return accounts.length > 0
      ? `Tenjin now offers only your ${list.format(accounts)} ${accounts.length === 1 ? 'account' : 'accounts'}. Ask for one of Tenjin's tools by name to use it.`
      : 'With no connected accounts, Tenjin offers nothing on its own for now. Ask for a tool by name to use it.';
  }
  if (target.kind === 'category') {
    const jobs = tasksOf(target.id, identities).length;
    return `Tenjin won't offer ${jobs > 0 ? `its ${jobs} kinds of job` : 'anything in it'} on its own, or any added later. You can still ask by name.`;
  }
  if (target.kind === 'task')
    return "Tenjin won't offer it on its own, whoever could do it. You can still ask by name.";
  const tools = target.kind === 'source' ? 0 : servicesNaming(target, identities).length;
  return tools > 1
    ? `Tenjin won't offer its ${tools} tools on its own. ${BY_NAME}`
    : "Tenjin won't offer it on its own. You can still ask for it by name.";
}

/* ----------------------------------------------------------------- unblock */

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
  const nothing = missing.map(
    ({ kind, name }) => `Nothing blocks a ${KIND_NOUN[kind]} named "${name}".`,
  );
  const human: Reply =
    removed.length === 0
      ? { said: [...nothing, 'Nothing changed.'] }
      : {
          done: `Unblocked ${list.format(removed.map((target) => blockName(target, identities)))}`,
          said: [
            `Tenjin can offer ${removed.length === 1 ? 'it' : 'them'} on its own again.`,
            ...nothing,
          ],
        };
  return answer(
    {
      operation: 'unblock',
      changed: removed.length > 0,
      scope: 'user',
      rule: removed,
      explanation,
      human,
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
          : named !== undefined
            ? savedScope(
                named,
                only.map(({ scope: s }) => s),
                identities,
              )
            : undefined;
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
  const human: Reply =
    missing !== undefined
      ? { said: [`${missing} Nothing changed.`] }
      : mode === 'all'
        ? {
            done: 'Removed all your rules',
            said: ['Automatic picks and your limits are unchanged.'],
          }
        : {
            done: `Removed ${describeRemoved(mode, removed, identities)}`,
            said: ['Your other rules are unchanged.'],
          };
  return answer(
    {
      operation: 'reset',
      changed: missing === undefined,
      scope: 'user',
      explanation,
      human,
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
  const targets = rule.targets.map((target) => flagFor(target)).join(' ');
  if ('dimension' in rule) return `tenjin config only ${scopeFlag(rule.scope)} ${targets}`;
  // An account-wide preference is `--source` alone, with no `--global`.
  const where = rule.scope.kind === 'global' ? '' : scopeFlag(rule.scope);
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
  /** The switch as this write found it, read inside the lock. */
  let was = false;
  await persist(ctx.dataDir, (existing) => {
    const policy = savedPolicyOf(existing);
    was = policy.preferSpeed === true;
    if (was === on) return existing;
    const next: SavedPolicy = { ...policy };
    if (on) next.preferSpeed = true;
    else delete next.preferSpeed;
    return withPolicy(existing, next);
  });
  const changed = was !== on;
  const identities = on
    ? ((await freshIdentities(ctx, deps)) ?? (await cachedIdentities(ctx.dataDir)))
    : await cachedIdentities(ctx.dataDir);
  const effective = describeSpeed(identities);
  const explanation = on
    ? [`${SAVED_PREFIX} ${effective.text}`]
    : [
        `${SAVED_PREFIX} Tenjin offers a paid tool only when your agent's own tools can't do the job as well. Your other rules stay as they are.`,
      ];
  const marked = speedTasks(identities)?.map(
    (label) => label.charAt(0).toLowerCase() + label.slice(1),
  );
  const human: Reply = !changed
    ? { said: [`Speed is already ${on ? 'on' : 'off'}.`] }
    : on
      ? {
          done: 'Speed on',
          said: [
            marked === undefined
              ? "Tenjin also offers faster paid tools where they're as accurate. Your limits still apply."
              : marked.length === 0
                ? 'No jobs are marked faster yet, so nothing changes for now.'
                : `Tenjin also offers faster paid tools for ${list.format(marked)}. Your limits still apply.`,
          ],
        }
      : {
          done: 'Speed off',
          said: ["Tenjin offers a paid tool only when your agent's own can't do the job as well."],
        };
  return answer(
    {
      operation: 'speed',
      changed,
      scope: 'user',
      rule: { preferSpeed: on },
      explanation,
      human,
      ...(on ? { effective: [effective] } : {}),
      // Only a change has an undo, and it puts the switch back as it was.
      ...(changed ? { reset: `tenjin config speed ${was ? 'on' : 'off'}` } : {}),
    },
    ctx,
    deps,
    identities,
  );
}

/* ------------------------------------------------------------- replacement */

/** The command that puts automatic use back as `before` had it. A scope kept
 *  while it is off is not put back: turning it on always names one. */
function restoreReplacement(before: ReplacementSetting): string {
  if (before.mode === 'off') return 'tenjin config replacement off';
  return before.providers !== undefined
    ? `tenjin config replacement on ${before.providers.map((target) => flagFor(target)).join(' ')}`
    : 'tenjin config replacement on --all-providers';
}

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
  // THE SCOPE AS IT WILL BE READ BACK: a list the reader refuses would make
  // automatic use read as off, so it is refused here and nothing is saved.
  if (scope !== undefined && !ReplacementProvidersSchema.safeParse(scope).success) {
    usage(
      `Automatic use can be narrowed to at most ${SETTINGS_LIMITS.targets} providers; that names ${scope.length}. Nothing was saved.`,
      'Name fewer providers, or use --all-providers for any allowed provider.',
      { limit: SETTINGS_LIMITS.targets, providers: scope },
    );
  }
  /** Automatic use as this write found it and left it, read inside the lock. */
  let before: ReplacementSetting = { mode: 'off' };
  let after: ReplacementSetting = { mode: 'off' };
  await persist(ctx.dataDir, (existing) => {
    const router = { ...((existing.router ?? {}) as Record<string, unknown>) };
    before = readPersonalRouter(router).nativeReplacement;
    if (args.state === 'off') {
      router.nativeReplacement = 'off';
      // A valid provider choice is kept for when it is turned on again; one
      // the reader refuses (`[]`, say) goes, so this is the repair readback
      // names for it.
      if (
        router.nativeReplacementProviders !== undefined &&
        !ReplacementProvidersSchema.safeParse(router.nativeReplacementProviders).success
      ) {
        delete router.nativeReplacementProviders;
      }
    } else {
      if (scope !== undefined) {
        // A blocked provider never runs, so naming it here is a conflict.
        const policy = SavedPolicySchema.safeParse(router.policy);
        refuseBlocked(scope, policy.success ? policy.data : {}, identities);
        router.nativeReplacementProviders = scope;
      } else {
        delete router.nativeReplacementProviders;
      }
      router.nativeReplacement = 'when-routed';
    }
    after = readPersonalRouter(router).nativeReplacement;
    // What reads back the same is not written again.
    return JSON.stringify(after) === JSON.stringify(before) ? existing : { ...existing, router };
  });
  const changed = JSON.stringify(after) !== JSON.stringify(before);
  const read = await readBack(ctx, deps);
  const { router, support, limits } = read;
  const effective = describeReplacement(router.nativeReplacement, identities, support);
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
  const named =
    scope !== undefined
      ? `, only for ${either.format(scope.map((target) => labelOf(target, identities)))}`
      : '';
  const human: Reply = !changed
    ? { said: [`Automatic picks are already ${args.state}.`] }
    : args.state === 'on'
      ? {
          done: `Automatic picks on${named}`,
          said: [
            'In Claude Code, Tenjin now runs its pick in place of a web search or page fetch, and says what it ran and what it cost. Your limits still apply.',
          ],
        }
      : { done: 'Automatic picks off', said: ['Tenjin goes back to offering its picks first.'] };
  return answer(
    {
      operation: 'replacement',
      changed,
      human,
      scope: 'machine',
      rule: {
        mode: router.nativeReplacement.mode,
        ...(router.nativeReplacement.providers !== undefined
          ? { providers: router.nativeReplacement.providers }
          : {}),
      },
      explanation,
      // Off before and after is the same behaviour (a repair of an unreadable
      // value, say): there is nothing to put back.
      ...(changed && (before.mode !== 'off' || after.mode !== 'off')
        ? { reset: restoreReplacement(before) }
        : {}),
      extra: { replacement: effective },
    },
    ctx,
    deps,
    identities,
    read,
  );
}

/**
 * WHAT AUTOMATIC USE DOES WITH THE USER'S CONNECTED ACCOUNTS (vraspar,
 * 2026-10-23): it runs them too, and their own plans pay, outside the limits
 * above. Named when some are connected; a provider choice applies to them as
 * to any pick, which the router decides.
 */
function accountsNote(router: RouterSettings, narrowed: boolean): string {
  const names = router.accounts.saved
    .filter((account) => account.mapped === true && router.accounts.connected.includes(account.id))
    .map(({ label }) => label);
  const within = narrowed ? ' within the same provider choice' : '';
  if (names.length === 0)
    return `An account you connect with \`tenjin connect\` runs this way too${within}, and its own plan pays, not the Tenjin balance.`;
  const yours = `your ${new Intl.ListFormat('en', { type: 'conjunction' }).format(names)} ${names.length === 1 ? 'account' : 'accounts'}`;
  return `It also runs ${yours} this way${within}: those calls bill your own plan, not the Tenjin balance, and don't count toward these limits.`;
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
  await persist(ctx.dataDir, (existing) =>
    editSources(existing, (saved) =>
      saved.map((entry) => {
        if (entry.id !== before.id) return entry;
        const next = { ...entry };
        if (on) next.onRefusal = 'tenjin';
        else delete next.onRefusal;
        return next;
      }),
    ),
  );
  const after = find((await loadRawConfig(ctx.dataDir)).router) ?? before;
  const { label, id } = after;
  const changed = (before.onRefusal === 'tenjin') !== on;
  const human: Reply = !changed
    ? { said: [`Fallback is already ${args.state} for ${label}.`] }
    : on
      ? {
          done: `Fallback on for ${label}`,
          said: [
            `When ${label} refuses a call, Tenjin's own tool runs instead, on your Tenjin balance.`,
          ],
        }
      : {
          done: `Fallback off for ${label}`,
          said: [
            `When ${label} refuses a call, Tenjin offers its own tool and runs it only when you say so.`,
          ],
        };
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
      changed,
      scope: 'user',
      explanation,
      human,
      ...(on ? { reset: `tenjin config fallback off --source ${id}` } : {}),
      extra: { account: { id, label, onRefusal: on ? 'tenjin' : 'ask' } },
    },
    ctx,
    deps,
    await cachedIdentities(ctx.dataDir),
  );
}
