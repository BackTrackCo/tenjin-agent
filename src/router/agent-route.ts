import type { AnswerShape, Answers, ChoiceAnswer, JevClient, JevWeakReason } from './agent-jev';
import { protectedJobsOf, taskOf, tierOf, type SpawnInput } from './agent-job';
import { jevRequest, type AgentQuestions } from './agent-request';
import type { AgentRules } from './agent-rules';
import { rulesDecision, settle, type KeylessOptions, type Settled } from './agent-settle';

export type { ParentMessage, SpawnInput } from './agent-job';
export type { AgentQuestions } from './agent-request';
export { settle, type Dimension, type KeylessOptions, type SettleOptions } from './agent-settle';

/**
 * THE AGENT LEG'S MODEL DECISION: where one delegated subagent runs, decided
 * once, at its first spawn. Not called from any hook yet; the offline check
 * (`scripts/agent-route-eval.mjs` in the workspace) runs it over labelled past
 * runs first.
 *
 * IN ORDER, AND EACH LAYER CAN ONLY KEEP. Skips (forks, remote isolation,
 * teammates, `codex:*`) are never decided. Hard floors, in code, hold before
 * Jev can change anything: a review, security review or design job whose task
 * part is about money, payments, x402, wallets, USDC, signing, auth,
 * credentials or migrations; any change to a migration; and, only when
 * `definitionPin` says so (it ships as `none`), a model or effort the agent's
 * definition pins. A model the parent wrote on the call, `fable` included, is
 * not a floor. Review, design and security jobs of any area keep their effort
 * at `high` or above (`agent-settle.ts`).
 * In `shadow` mode Jev is still asked so its counterfactual is recorded, and it
 * cannot change the outcome; in `apply` mode it is not asked. Then one Jev
 * request (`agent-request.ts`), settled by label or by ratings
 * (`agent-settle.ts`); without a key, a small rules table instead.
 *
 * NEVER RAISES, AND EVERY FAILURE KEEPS. A pick above what the spawn runs on is
 * recorded as Jev's `wanted` and not applied. Jev slow, down, invalid or under
 * a threshold, a brief the mask would change, an excluded destination, an
 * unreadable rules file or any throw: the spawn runs as requested.
 */

export interface JevTrace {
  model: string;
  latencyMs: number;
  inputTokens: number;
  weak?: JevWeakReason;
  status?: number;
  shape?: AnswerShape;
  /** Whether the parent slice went into the request. */
  parentSent: boolean;
  answers?: Answers<AgentQuestions>;
  /** Jev's own top labels before thresholds, floors and the no-raise rule. */
  wanted?: { work: string; effort: string };
}

export interface AgentDecision {
  /** `keep` runs the spawn as requested; `claude` changes the fields set below. */
  route: 'keep' | 'claude' | 'outside-read';
  model?: 'haiku' | 'sonnet' | 'opus';
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** `claude/<tier>` for a model change, `outside/<model>` for an outside read. */
  destination?: string;
  /** The layer that decided. */
  layer: 'skip' | 'floor' | 'rules' | 'jev' | 'weak';
  /** A stable code: the skip, floor, rule, weak reason or settlement. */
  why: string;
  /** The same for a person: the rule, floor, or label or ratings with their numbers. */
  reason: string;
  /** Every hard floor that held. */
  floors: string[];
  /** Relative usage per unit of work, asked against chosen: Haiku 1, Sonnet 3,
   *  Opus and Fable 5, less 15% per effort step down (25% from xhigh). An
   *  outside read is 0 here; it spends wallet money at its own quote. */
  estimate?: { asked: number; chosen: number };
  jev?: JevTrace;
}

export interface DecideDeps {
  /** Null when the rules file was unreadable: every spawn is kept. */
  rules: AgentRules | null;
  /** Null without a key: the keyless table decides. */
  jev: JevClient | null;
  mode: 'shadow' | 'apply';
  /** `router.subagents.outside`: whether an outside destination may be picked. */
  outside?: boolean;
  /**
   * The keyless table, as this caller runs it: `apply` lets apply mode act on
   * it though the rules file's `keyless.apply` is false, and the rest goes to
   * {@link rulesDecision}. Unset, the rules file alone decides.
   */
  keyless?: KeylessOptions & { apply?: boolean };
}

export async function decideAgentRoute(
  spawn: SpawnInput,
  deps: DecideDeps,
): Promise<AgentDecision> {
  try {
    const decision = await decide(spawn, deps);
    const estimate = estimateOf(spawn, decision);
    return estimate !== undefined ? { ...decision, estimate } : decision;
  } catch {
    return keep('weak', 'decider_error');
  }
}

async function decide(spawn: SpawnInput, deps: DecideDeps): Promise<AgentDecision> {
  const { rules } = deps;
  if (rules === null) return keep('weak', 'rules_unreadable');
  const skip = skipOf(spawn);
  if (skip !== null) return keep('skip', skip);
  const floors = floorsOf(spawn, rules);
  const floored = (jev?: JevTrace): AgentDecision => ({
    ...keep('floor', floors[0]!),
    reason: `floor ${floors.join(', ')}`,
    floors,
    ...(jev !== undefined ? { jev } : {}),
  });
  if (deps.jev === null) {
    if (floors.length > 0) return floored();
    const { apply, ...keyless } = deps.keyless ?? {};
    if (deps.mode === 'apply' && !rules.keyless.apply && apply !== true) {
      return keep('weak', 'not_configured');
    }
    return decided(rulesDecision(spawn, rules, keyless), floors);
  }
  if (floors.length > 0 && deps.mode === 'apply') return floored();
  const request = jevRequest(spawn, rules);
  if (request === null) return floors.length > 0 ? floored() : keep('weak', 'masked');
  const call = await deps.jev.ask(request.state, request.questions);
  const jev: JevTrace = {
    model: call.model,
    latencyMs: call.latencyMs,
    inputTokens: call.inputTokens,
    parentSent: request.parentSent,
    ...(call.weak !== undefined ? { weak: call.weak } : {}),
    ...(call.status !== undefined ? { status: call.status } : {}),
    ...(call.shape !== undefined ? { shape: call.shape } : {}),
    ...(call.answers !== null
      ? {
          answers: call.answers,
          wanted: { work: topOf(call.answers.work), effort: topOf(call.answers.effort) },
        }
      : {}),
  };
  if (floors.length > 0) return floored(jev);
  if (call.answers === null) return { ...keep('weak', call.weak ?? 'invalid_response'), jev };
  return {
    ...decided(settle(spawn, call.answers, rules, { outside: deps.outside === true })),
    jev,
  };
}

function decided(settled: Settled, floors: string[] = []): AgentDecision {
  return { ...settled, floors };
}

function keep(layer: AgentDecision['layer'], why: string): AgentDecision {
  return { route: 'keep', layer, why, reason: `${layer} ${why}`, floors: [] };
}

// --- skips and floors --------------------------------------------------------

/** Spawns this never decides: a fork shares its parent's context and model,
 *  and the others are not Claude subagents this leg can size. */
export function skipOf(spawn: SpawnInput): string | null {
  if (spawn.agentType === 'fork') return 'fork';
  if (spawn.isolation === 'remote') return 'remote';
  if (spawn.teammate) return 'teammate';
  if (spawn.agentType?.startsWith('codex:') === true) return 'codex';
  return null;
}

/** What a protected job must be about for its floor to hold: keyword and path
 *  patterns over the task part. In code, so no rules file can loosen them. */
export const SENSITIVE_AREAS: readonly { id: string; re: RegExp }[] = [
  {
    id: 'money',
    re: /\b(money|payments?|payouts?|refunds?|billing|invoices?|charges?|fees?)\b|payments?\.ts|routing-payer|spend-ledger/i,
  },
  { id: 'x402', re: /x402/i },
  { id: 'wallet', re: /\bwallets?\b|\bkeystores?\b|lib\/wallet/i },
  { id: 'usdc', re: /\busdc\b/i },
  {
    id: 'signing',
    re: /\b(signing|signers?|signatures?|private[ -]keys?|seed phrases?|mnemonics?|eip-?712|permit2)\b/i,
  },
  {
    id: 'auth',
    re: /\b(auth|authn|authz|authentication|authenticate|authorization|oauth|login|sign[ -]?in|jwt|siwe|siwx|passkeys?)\b/i,
  },
  {
    id: 'secrets',
    re: /\b(credentials?|secrets?|api[ -]?keys?|passwords?|passphrases?|(access|auth|bearer|api|refresh) tokens?)\b|\.env\b/i,
  },
  { id: 'migration', re: /\b(migrations?|migrate|migrating|alter table|ddl)\b|drizzle\//i },
  {
    id: 'security',
    re: /\b(security|threat[ -]?model\w*|vulnerabilit(y|ies)|exploits?|prompt injection|cso)\b/i,
  },
];

/**
 * Every hard floor that holds for this spawn. The job decides, not the
 * vocabulary: a review, a security review or a design job holds only when its
 * task part is in a sensitive area, and mechanical work in those areas is
 * Jev's to decide.
 */
export function floorsOf(spawn: SpawnInput, rules: AgentRules): string[] {
  const task = taskOf(spawn);
  const sensitive = SENSITIVE_AREAS.some((area) => area.re.test(task));
  const held: string[] = [];
  for (const job of protectedJobsOf(spawn.agentType, task)) {
    if (job === 'migration') held.push('migration-change');
    else if (sensitive) held.push(`sensitive-${job}`);
  }
  for (const extra of rules.extraFloors) {
    if (new RegExp(extra.pattern, 'i').test(task)) held.push(`extra:${extra.id}`);
  }
  // A model the parent wrote on the call is not a floor (plan decision 11): a
  // model the user named is Jev's `userNamedModel`, read from their own words.
  const pinned = spawn.definition?.model !== undefined || spawn.definition?.effort !== undefined;
  if (pinned && rules.definitionPin.protects === 'both') held.push('definition-pin');
  return held;
}

// --- the estimate ------------------------------------------------------------

const WEIGHT: Record<string, number> = { haiku: 1, sonnet: 3, opus: 5, fable: 5 };
/** Effort steps as the operator's accounting counts them: `max` as `xhigh`. */
const STEP: Record<string, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 3 };

/**
 * Relative usage per unit of work, what the spawn runs on against what the
 * decision picks (see {@link AgentDecision.estimate}); undefined when the
 * spawn's model is not a tier this knows. Only `route`, `model` and `effort`
 * of the decision are read, so a caller can price one dimension alone.
 */
export function estimateOf(
  spawn: SpawnInput,
  decision: Pick<AgentDecision, 'route' | 'model' | 'effort'>,
): AgentDecision['estimate'] | undefined {
  const tier = tierOf(spawn.runsOn.model);
  if (tier === undefined) return undefined;
  const asked = WEIGHT[tier]!;
  if (decision.route === 'outside-read') return { asked, chosen: 0 };
  let factor = 1;
  const from = STEP[spawn.runsOn.effort ?? ''];
  const to = decision.effort !== undefined ? STEP[decision.effort] : undefined;
  if (from !== undefined && to !== undefined) {
    for (let step = from; step > to; step--) factor *= 1 - (step === 3 ? 0.25 : 0.15);
  }
  const chosen = WEIGHT[decision.model ?? tier]! * factor;
  return { asked, chosen: Math.round(chosen * 100) / 100 };
}

/** The label Jev ranked first, `keep` winning a tie. */
function topOf(answer: ChoiceAnswer): string {
  if (answer.probabilities === undefined) return answer.choice;
  let best = 'keep';
  let bestP = answer.probabilities.keep ?? -1;
  for (const [label, p] of Object.entries(answer.probabilities)) {
    if (p > bestP) [best, bestP] = [label, p];
  }
  return best;
}
