import type { Answers, ChoiceAnswer } from './agent-jev';
import {
  EFFORTS,
  TIERS,
  effortOf,
  kindOf,
  protectedJobsOf,
  taskOf,
  tierOf,
  type ProtectedJob,
  type SpawnInput,
} from './agent-job';
import type { AgentQuestions } from './agent-request';
import {
  thresholdsOf,
  type AgentRules,
  type CostSetting,
  type Thresholds,
  type WorkLabel,
} from './agent-rules';

/**
 * SETTLING JEV'S ANSWERS, two ways from the same single request, both pure so
 * the offline check can compare them and sweep thresholds without asking again:
 *
 * - `label`: Jev's direct kind-of-work label, mapped to a destination by the
 *   rules, applied only when it clears its probability floor and beats `keep`
 *   by the margin;
 * - `ratings`: Jev's yes/no ratings (how hard, how checkable, how costly a
 *   miss, whether a bigger model or more effort would help) through a small
 *   policy whose numbers are in the rules.
 *
 * Either way it never raises a model or effort, keeps what a definition pin
 * protects, and then guards the result: a re-spawn after a routed run escalates
 * or keeps, and a destination the allow and exclude lists rule out keeps.
 */

export type Dimension = 'model' | 'effort';
export type ClaudeTier = 'haiku' | 'sonnet' | 'opus';
export type LowerEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface Settled {
  route: 'keep' | 'claude' | 'outside-read';
  model?: ClaudeTier;
  effort?: LowerEffort;
  /** Where it goes: `claude/<tier>` for a model change, `outside/<model>` outside. */
  destination?: string;
  layer: 'rules' | 'jev';
  /** A stable code for what decided it. */
  why: string;
  /** The same for a person: the rule, or the label or ratings and their numbers. */
  reason: string;
}

export interface SettleOptions {
  /** `router.subagents.outside`: whether an outside destination may be picked. */
  outside: boolean;
  /** Dimensions the caller keeps as asked, beside what a definition pin keeps. */
  keep?: readonly Dimension[];
  by?: AgentRules['settleBy'];
  cost?: CostSetting;
}

/** Review, design and security jobs, in any area, keep their effort at `high`
 *  or above (plan decision 9; tenjin#817). The job is read as the floors read it. */
const HIGH_EFFORT_JOBS: ReadonlySet<ProtectedJob> = new Set(['review', 'security', 'design']);
export function keepsHighEffort(spawn: SpawnInput): boolean {
  return protectedJobsOf(spawn.agentType, taskOf(spawn)).some((job) => HIGH_EFFORT_JOBS.has(job));
}
/** Where a read-only repository question runs when it may not go outside. */
const MIDDLE_TIER = 'claude/sonnet';
const MARGIN_EPSILON = 1e-9;
const fmt = (p: number | undefined): string => (p === undefined ? '-' : p.toFixed(2));

export function settle(
  spawn: SpawnInput,
  answers: Answers<AgentQuestions>,
  rules: AgentRules,
  opts: SettleOptions,
): Settled {
  const t = thresholdsOf(rules, opts.cost);
  if (answers.userNamedModel.noul >= t.userNamedKeeps) {
    return keepAs(
      'jev',
      'user_named',
      `the user named a model or effort (${fmt(answers.userNamedModel.noul)})`,
    );
  }
  const kept = keptDimensions(spawn, rules, opts.keep);
  const kind = kindOf(spawn.brief, rules);
  const outsideOk =
    opts.outside &&
    !kept.has('model') &&
    answers.changesState.noul < t.outsideMaxChangesState &&
    answers.followUp.noul < t.outsideMaxFollowUp &&
    !spawn.addressable &&
    kind?.resumed !== undefined &&
    kind.resumed < t.outsideMaxResumed;
  const settled =
    (opts.by ?? rules.settleBy) === 'ratings'
      ? byRatings(spawn, answers, rules, t, kept, outsideOk)
      : byLabel(spawn, answers, rules, t, kept, outsideOk);
  return guard(spawn, settled, rules);
}

function byLabel(
  spawn: SpawnInput,
  answers: Answers<AgentQuestions>,
  rules: AgentRules,
  t: Thresholds,
  kept: Set<Dimension>,
  outsideOk: boolean,
): Settled {
  const destinationOf = (label: string): string | undefined =>
    label === 'keep' ? undefined : rules.destinations[label as Exclude<WorkLabel, 'keep'>];
  const outside = (label: string) => destinationOf(label)?.startsWith('outside/') === true;
  const work = pickLabel(
    answers.work,
    () => true,
    () => t.minProbability,
    t.minMarginOverKeep,
  );
  const said = `label ${work.label ?? 'keep'} ${fmt(work.p)} against keep ${fmt(work.keepP)}`;
  // An outside label goes outside only when this spawn may and it clears the
  // higher floor; otherwise it runs on the middle tier (the plan's table).
  const goesOutside =
    work.label !== undefined &&
    outside(work.label) &&
    outsideOk &&
    (work.p ?? 0) >= t.outsideMinProbability;
  const tierFor = (label: string) => tierOf(outside(label) ? MIDDLE_TIER : destinationOf(label));
  if (goesOutside && work.label !== undefined) {
    return {
      route: 'outside-read',
      destination: destinationOf(work.label)!,
      layer: 'jev',
      why: 'label',
      reason: said,
    };
  }
  const effort = pickLabel(
    answers.effort,
    () => true,
    () => t.minProbability,
    t.minMarginOverKeep,
  );
  return combine(
    kept.has('model')
      ? { reason: 'kept' }
      : work.label !== undefined
        ? lowerModel(spawn, tierFor(work.label))
        : work,
    kept.has('effort')
      ? { reason: 'kept' }
      : effort.label !== undefined
        ? lowerEffort(spawn, effort.label, t.maxEffortStepsDown)
        : effort,
    'jev',
    'label',
    `${said}; effort ${effort.label ?? 'keep'} ${fmt(effort.p)}`,
  );
}

/**
 * The ratings policy. The model stays when a miss is costly or a bigger model
 * would help; a light, checkable task goes to the light tier (or outside, when
 * that is allowed); anything under the middle line to the middle tier. Effort
 * stays when more of it would help, and otherwise follows how hard the task is.
 */
function byRatings(
  spawn: SpawnInput,
  answers: Answers<AgentQuestions>,
  rules: AgentRules,
  t: Thresholds,
  kept: Set<Dimension>,
  outsideOk: boolean,
): Settled {
  const hard = answers.hard.noul;
  const checkable = answers.checkable.noul;
  const costly = answers.costlyWrong.noul;
  const bigger = answers.biggerHelps.noul;
  const more = answers.effortHelps.noul;
  const said = `ratings hard ${fmt(hard)}, checkable ${fmt(checkable)}, costly ${fmt(costly)}, bigger model helps ${fmt(bigger)}, more effort helps ${fmt(more)}`;
  const modelStays = costly >= t.costlyKeeps || bigger >= t.biggerHelpsKeeps;
  const light = hard < t.lightMaxHard && checkable >= t.lightMinCheckable;
  const reader = rules.destinations['repo-question'];
  if (!modelStays && light && outsideOk && reader.startsWith('outside/')) {
    return {
      route: 'outside-read',
      destination: reader,
      layer: 'jev',
      why: 'ratings',
      reason: said,
    };
  }
  const model: Lowered<ClaudeTier> = kept.has('model')
    ? { reason: 'kept' }
    : modelStays
      ? { reason: 'ratings_keep' }
      : light
        ? lowerModel(spawn, 'haiku')
        : hard < t.middleMaxHard
          ? lowerModel(spawn, 'sonnet')
          : { reason: 'ratings_hard' };
  const target: LowerEffort | undefined =
    more >= t.effortHelpsKeeps
      ? undefined
      : hard < t.lowEffortMaxHard
        ? 'low'
        : hard < t.mediumEffortMaxHard
          ? 'medium'
          : 'high';
  const effort: Lowered<LowerEffort> = kept.has('effort')
    ? { reason: 'kept' }
    : target === undefined
      ? { reason: 'ratings_keep' }
      : lowerEffort(spawn, target, t.maxEffortStepsDown);
  return combine(model, effort, 'jev', 'ratings', said);
}

/** How the keyless table may move a spawn, beyond what the rules file says. */
export interface KeylessOptions {
  /** At most this many model tiers below what the spawn runs on: a rule whose
   *  target is further down stops there. The rules' own `maxTiersDown` wins
   *  for a spawn that cannot change state. Unset, the rule's target stands. */
  maxTiersDown?: number;
  /** A spawn asked for `max` effort is lowered as one at `xhigh` is, as the
   *  usage estimate already counts it ({@link estimateOf}). Unset, from `max`. */
  maxAsXhigh?: boolean;
  /** `router.effortFloor`: a rule's effort target below it stops there, so
   *  `low` is refused at `medium`. Unset, the rule's target stands. */
  effortFloor?: 'low' | 'medium';
}

/** The keyless table: the first rule whose types and kinds both match. Named
 *  spawns are not routed by it, since they are the ones resumed. */
export function rulesDecision(
  spawn: SpawnInput,
  rules: AgentRules,
  opts: KeylessOptions = {},
): Settled {
  if (spawn.addressable)
    return keepAs('rules', 'addressable', 'a named spawn is not routed by rule');
  const kind = kindOf(spawn.brief, rules)?.id;
  const type = spawn.agentType ?? 'general-purpose';
  const rule = rules.keyless.rules.find(
    (r) =>
      (r.types === undefined || r.types.includes(type)) &&
      (r.kinds === undefined || (kind !== undefined && r.kinds.includes(kind))),
  );
  if (rule === undefined) return keepAs('rules', 'no_rule', 'no rule matches');
  const steps = thresholdsOf(rules).maxEffortStepsDown;
  const kept = keptDimensions(spawn, rules);
  // READING ON HAIKU, and a cap past one tier, only for a spawn that cannot
  // change state (`readsOnly`), and Haiku only for one asked for high or above,
  // so it runs at high: any other keeps the rule as Sonnet at most and the
  // caller's cap, as before rules could say either.
  const reads = spawn.definition?.readsOnly === true;
  const asked = effortOf(spawn.runsOn.effort);
  const high = asked !== undefined && EFFORTS.indexOf(asked) >= EFFORTS.indexOf('high');
  const model = rule.model === 'haiku' && !(reads && high) ? 'sonnet' : rule.model;
  const cap = reads
    ? (rule.maxTiersDown ?? rules.keyless.maxTiersDown ?? opts.maxTiersDown)
    : opts.maxTiersDown;
  const settled = combine(
    model !== undefined && !kept.has('model')
      ? lowerModel(spawn, cappedTier(spawn, model, cap))
      : { reason: 'rule_keeps' },
    rule.effort !== undefined && !kept.has('effort')
      ? lowerEffort(
          spawn,
          flooredEffort(rule.effort, opts.effortFloor),
          steps,
          opts.maxAsXhigh === true,
        )
      : { reason: 'rule_keeps' },
    'rules',
    rule.id,
    `rule ${rule.id}`,
  );
  return guard(spawn, settled, rules);
}

/** The dimensions kept as asked: what a definition pin protects, and what the
 *  caller keeps. */
export function keptDimensions(
  spawn: SpawnInput,
  rules: AgentRules,
  keep: readonly Dimension[] = [],
): Set<Dimension> {
  const kept = new Set<Dimension>(keep);
  const pinned = spawn.definition?.model !== undefined || spawn.definition?.effort !== undefined;
  const protects = rules.definitionPin.protects;
  if (pinned && protects !== 'none') {
    if (protects !== 'effort') kept.add('model');
    if (protects !== 'model') kept.add('effort');
  }
  return kept;
}

// --- guards, after a decision -----------------------------------------------

const RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

/** A re-spawn first, then the allow and exclude lists. Each can only keep. */
function guard(spawn: SpawnInput, settled: Settled, rules: AgentRules): Settled {
  if (settled.route === 'keep') return settled;
  const escalated = spawn.respawn ? escalate(spawn.respawn.routedTo, settled) : settled;
  const destination = escalated.destination;
  if (destination !== undefined && !permitted(destination, rules)) {
    return keepAs(settled.layer, 'excluded', `${destination} is not an allowed destination`);
  }
  return escalated;
}

/**
 * THE SAME JOB AGAIN, SOON AFTER A ROUTED RUN: the parent found the routed run
 * short. The decision goes at least one tier above the earlier one, keeps its
 * effort as asked, and never goes outside; otherwise it keeps. An outside run
 * counts as the middle tier, and a destination this cannot rank as the top.
 */
function escalate(routedTo: string, settled: Settled): Settled {
  const earlier = routedTo.startsWith('outside/')
    ? RANK.sonnet!
    : (RANK[tierOf(routedTo) ?? 'fable'] ?? RANK.fable!);
  const model =
    settled.route === 'claude' && settled.model !== undefined && RANK[settled.model]! > earlier
      ? settled.model
      : undefined;
  if (model === undefined) {
    return keepAs(settled.layer, 'respawn', `re-spawned after a run on ${routedTo}`);
  }
  return {
    route: 'claude',
    model,
    destination: `claude/${model}`,
    layer: settled.layer,
    why: 'respawn',
    reason: `re-spawned after a run on ${routedTo}: escalated`,
  };
}

/** Allowed when the allow list is empty or names it, and no exclude does. */
export function permitted(destination: string, rules: AgentRules): boolean {
  const allowed = rules.allow.length === 0 || rules.allow.some((g) => globMatch(g, destination));
  return allowed && !rules.exclude.some((g) => globMatch(g, destination));
}

/** `*` matches any run of characters, slashes included; nothing else is special. */
function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 'i').test(value);
}

// --- picking and lowering ---------------------------------------------------

interface LabelPick {
  label?: string;
  p?: number;
  keepP?: number;
  reason: string;
}

/**
 * A label changes the spawn only when it is not `keep`, clears its floor and
 * beats `keep` by the margin. With only `{choice, confidence}`, the confidence
 * stands in for the label's probability and `keep` is given all that is left.
 */
function pickLabel(
  answer: ChoiceAnswer,
  eligible: (label: string) => boolean,
  minFor: (label: string) => number,
  margin: number,
): LabelPick {
  let label: string;
  let p: number;
  let keepP: number;
  if (answer.probabilities !== undefined) {
    const ranked = Object.entries(answer.probabilities)
      .filter(([l]) => l === 'keep' || eligible(l))
      .sort(([la, a], [lb, b]) => b - a || Number(lb === 'keep') - Number(la === 'keep'));
    [label, p] = ranked[0] ?? ['keep', 1];
    keepP = answer.probabilities.keep ?? 0;
  } else {
    label = answer.choice;
    if (label === 'keep') return { reason: 'top_is_keep', p: answer.confidence };
    if (!eligible(label)) return { reason: 'not_eligible' };
    if (answer.confidence === undefined) return { reason: 'no_confidence' };
    p = answer.confidence;
    keepP = 1 - p;
  }
  if (label === 'keep') return { reason: 'top_is_keep', p, keepP };
  if (p < minFor(label)) return { reason: 'below_probability', p, keepP };
  // Inclusive, as written: 0.6 - 0.4 is 0.19999999999999996 in floating point.
  if (p - keepP < margin - MARGIN_EPSILON) return { reason: 'below_margin', p, keepP };
  return { label, p, keepP, reason: 'picked' };
}

interface Lowered<T> {
  value?: T;
  reason: string;
}

function lowerModel(spawn: SpawnInput, target: string | undefined): Lowered<ClaudeTier> {
  const tier = tierOf(target);
  const current = tierOf(spawn.runsOn.model);
  if (tier === undefined || tier === 'fable') return { reason: 'not_a_tier' };
  if (current === undefined) return { reason: 'model_unknown' };
  if (TIERS.indexOf(tier) >= TIERS.indexOf(current)) return { reason: 'no_raise' };
  return { value: tier, reason: 'lowered' };
}

/** The rule's target, or the tier `maxTiersDown` below what the spawn runs on
 *  when the target is further down; unchanged when either tier is unknown. */
function cappedTier(
  spawn: SpawnInput,
  target: string,
  maxTiersDown: number | undefined,
): string | undefined {
  const tier = tierOf(target);
  const current = tierOf(spawn.runsOn.model);
  if (maxTiersDown === undefined || tier === undefined || current === undefined) return target;
  const lowest = Math.max(0, TIERS.indexOf(current) - maxTiersDown);
  return TIERS.indexOf(tier) < lowest ? TIERS[lowest] : target;
}

/** A rule's effort target, raised to the floor when it is below it. */
function flooredEffort(target: string, floor: 'low' | 'medium' | undefined): string {
  const at = EFFORTS.indexOf(target as (typeof EFFORTS)[number]);
  return floor !== undefined && at !== -1 && at < EFFORTS.indexOf(floor) ? floor : target;
}

function lowerEffort(
  spawn: SpawnInput,
  label: string,
  maxSteps: number,
  maxAsXhigh = false,
): Lowered<LowerEffort> {
  const target = effortOf(label);
  const asked = effortOf(spawn.runsOn.effort);
  const current = maxAsXhigh && asked === 'max' ? 'xhigh' : asked;
  if (target === undefined) return { reason: 'not_an_effort' };
  if (current === undefined) return { reason: 'effort_unknown' };
  const now = EFFORTS.indexOf(current);
  const floor = keepsHighEffort(spawn) ? Math.min(now, EFFORTS.indexOf('high')) : 0;
  const next = Math.max(EFFORTS.indexOf(target), now - maxSteps, floor);
  if (next >= now) return { reason: next === floor && floor > 0 ? 'skill_effort' : 'no_raise' };
  return { value: EFFORTS[next] as LowerEffort, reason: 'lowered' };
}

function combine(
  model: Lowered<ClaudeTier> | LabelPick,
  effort: Lowered<LowerEffort> | LabelPick,
  layer: Settled['layer'],
  why: string,
  reason: string,
): Settled {
  const m = 'value' in model ? model.value : undefined;
  const e = 'value' in effort ? effort.value : undefined;
  if (m === undefined && e === undefined) {
    return keepAs(layer, `model:${model.reason} effort:${effort.reason}`, reason);
  }
  return {
    route: 'claude',
    ...(m !== undefined ? { model: m, destination: `claude/${m}` } : {}),
    ...(e !== undefined ? { effort: e } : {}),
    layer,
    why,
    reason,
  };
}

function keepAs(layer: Settled['layer'], why: string, reason: string): Settled {
  return { route: 'keep', layer, why, reason };
}
