import { formatUsdDisplay } from '../lib/money';
import { SETTING_SCOPES, type SettingScope } from '../lib/config';
import {
  BUILT_IN_SOURCE,
  type OnlyRule,
  type PreferRule,
  type SavedPolicy,
  type Scope,
  type Target,
  type TargetKind,
} from '../router/settings-wire';
import {
  isListed,
  labelOf,
  servicesNaming,
  speedTasks,
  tasksOf,
  type Identities,
} from '../router/identities';
import type { ReplacementSetting, RouterSettings } from '../router/settings';
import { pidAlive, readObservations, type RouterObservation } from '../router/router-observation';

/**
 * WHAT A SAVED SETTING MEANS, IN THE USER'S WORDS (plan 36). Every `tenjin
 * config` operation answers with this readback, and bare `tenjin config`
 * lists it, so an agent reports what was actually written rather than what it
 * asked for. Ordinary text names services, providers, tasks and accounts by
 * their labels and says "balance", "your accounts", "your settings" and
 * "limits"; typed ids stay in the JSON beside it.
 *
 * Display only. What a rule covers is named from the router's identities
 * read (`identities.ts`); the server decides what it covers each time it
 * decides. With no identities at hand (offline), a rule is named by its ids.
 */

/** Said beside every saved routing rule. */
export const SAVED_HERE = 'Saved on this machine; not synced.';
/** How an operation's readback starts. */
export const SAVED_PREFIX = 'Saved on this machine (not synced):';

/** The automatic-use switch, by the one name a person sees. */
export const REPLACEMENT_NAME = "Run Tenjin's picks automatically";

const list = new Intl.ListFormat('en', { type: 'conjunction' });
const either = new Intl.ListFormat('en', { type: 'disjunction' });

/** A shell word for a typed id: one in quotes unless it is a plain token. */
export const shellWord = (id: string): string =>
  /^[A-Za-z0-9._:-]+$/.test(id) ? id : JSON.stringify(id);

const KIND_FLAG: Record<TargetKind, string> = {
  category: '--category',
  task: '--task',
  provider: '--provider',
  seller: '--seller',
  service: '--service',
  source: '--source',
};

export const flagFor = ({ kind, id }: Target): string => `${KIND_FLAG[kind]} ${shellWord(id)}`;

export function scopeFlag(scope: Scope): string {
  return scope.kind === 'global' ? '--global' : `${KIND_FLAG[scope.kind]} ${shellWord(scope.id)}`;
}

export const unblockCommand = (target: Target): string =>
  `tenjin config unblock ${flagFor(target)}`;

export function onlyResetCommand(rule: Pick<OnlyRule, 'scope' | 'dimension'>): string {
  return rule.dimension === 'capability'
    ? 'tenjin config reset --global --capabilities'
    : `tenjin config reset ${scopeFlag(rule.scope)} --restriction --dimension ${rule.dimension}`;
}

export const preferResetCommand = (scope: Scope): string =>
  `tenjin config reset ${scopeFlag(scope)} --preference`;

const MAX_NAMED = 8;

function named(labels: readonly string[]): string {
  if (labels.length <= MAX_NAMED) return list.format(labels);
  return `${labels.slice(0, MAX_NAMED).join(', ')} and ${labels.length - MAX_NAMED} more`;
}

const sameTarget = (a: Target, b: Target): boolean => a.kind === b.kind && a.id === b.id;

/**
 * The saved block that already rules a target out, if any: the same target,
 * a category block over a task, or a block over a service (its provider,
 * seller, task or category). Used to refuse a conflicting preference or only
 * rule and to mark one inactive in readback; never to decide a call.
 */
export function blockedBy(
  target: Target,
  policy: Pick<SavedPolicy, 'block'>,
  identities: Identities | undefined,
): Target | undefined {
  const blocks = policy.block ?? [];
  const same = blocks.find((block) => sameTarget(block, target));
  if (same !== undefined || identities === undefined) return same;
  if (target.kind === 'task') {
    return blocks.find(
      (block) =>
        block.kind === 'category' &&
        identities.categories.some(({ id, tasks }) => id === block.id && tasks.includes(target.id)),
    );
  }
  if (target.kind === 'service') {
    return blocks.find((block) =>
      servicesNaming(block, identities).some(({ id }) => id === target.id),
    );
  }
  return undefined;
}

/** Why a rule scoped to a task or category cannot apply: its scope is ruled out. */
function scopeRuledOut(
  scope: Scope,
  policy: SavedPolicy,
  identities: Identities | undefined,
): string | undefined {
  if (scope.kind === 'global') return undefined;
  const block = blockedBy({ kind: scope.kind, id: scope.id }, policy, identities);
  const where = labelOf({ kind: scope.kind, id: scope.id }, identities);
  if (block !== undefined)
    return `inactive: ${labelOf(block, identities)} is blocked, so Tenjin doesn't handle ${where}`;
  if (scope.kind !== 'task') return undefined;
  const capability = (policy.only ?? []).find(
    (rule) => rule.scope.kind === 'global' && rule.dimension === 'capability',
  );
  if (capability === undefined) return undefined;
  const allowed = capability.targets.some(
    (target) =>
      (target.kind === 'task' && target.id === scope.id) ||
      (target.kind === 'category' &&
        identities?.categories.some(
          ({ id, tasks }) => id === target.id && tasks.includes(scope.id),
        ) === true),
  );
  return allowed ? undefined : `inactive: your settings don't let Tenjin handle ${where}`;
}

function goneNote(targets: readonly Target[], identities: Identities | undefined) {
  const gone = targets.filter((target) => isListed(target, identities) === false);
  if (gone.length === 0) return undefined;
  const labels = gone.map((target) => labelOf(target, identities));
  return `${named(labels)} ${gone.length === 1 ? 'is' : 'are'} no longer available through Tenjin`;
}

/** One saved rule, as JSON and as a sentence. */
export interface RuleReadback {
  kind: 'block' | 'only' | 'prefer' | 'speed';
  /** The saved rule, typed ids and all. */
  rule: Target | OnlyRule | PreferRule | { preferSpeed: true };
  text: string;
  /** Why the rule cannot apply as written; it stays saved and visible. */
  inactive?: string;
  /** The catalog services it names, by id, when the identities are known. */
  covers?: string[];
  /** The one command that removes it. */
  reset: string;
}

function coversLine(services: readonly { label: string }[]): string {
  return services.length === 0 ? '' : ` That covers ${named(services.map(({ label }) => label))}.`;
}

/** The warning `block --source tenjin` reads back with: what stops, and what is left. */
export const TENJIN_TOOLS_OFF =
  "Tenjin's own tools are off, including free ones like the docs lookup, and saved or direct calls to them. Tenjin still picks among your connected accounts, and anything they can't do goes back to your agent's own tools.";

export function describeBlock(target: Target, identities: Identities | undefined): RuleReadback {
  const label = labelOf(target, identities);
  const services = servicesNaming(target, identities);
  let text: string;
  switch (target.kind) {
    case 'category': {
      const tasks = tasksOf(target.id, identities);
      text = `Tenjin can't handle anything in ${label}${tasks.length > 0 ? ` (${named(tasks)})` : ''}, including tasks added there later. Your agent's own tools are outside this setting.`;
      break;
    }
    case 'task':
      text = `Tenjin can't handle ${label}, whichever service could. Your agent's own tools are outside this setting.`;
      break;
    case 'provider':
      text = `${label} is blocked, including reviewed reseller routes identified as using it.${coversLine(services)} A service whose provider Tenjin can't confirm is left out while this block stands.`;
      break;
    case 'seller':
      text = `${label} is blocked as a seller; the same provider sold by someone else stays available.${coversLine(services)}`;
      break;
    case 'service':
      text = `${label} is blocked.`;
      break;
    case 'source':
      text =
        target.id === BUILT_IN_SOURCE
          ? `${TENJIN_TOOLS_OFF} You have no connected accounts yet, so for now every job goes back to your agent's own tools.`
          : `Your ${label} account is blocked: Tenjin won't use it.`;
      break;
  }
  const gone = goneNote([target], identities);
  return {
    kind: 'block',
    rule: target,
    text,
    ...(gone !== undefined ? { inactive: `inactive: ${gone}` } : {}),
    ...(identities !== undefined ? { covers: services.map(({ id }) => id) } : {}),
    reset: unblockCommand(target),
  };
}

const DIMENSION_NOUN: Record<OnlyRule['dimension'], string> = {
  capability: 'task',
  provider: 'provider',
  seller: 'seller',
  service: 'service',
};

export function describeOnly(
  rule: OnlyRule,
  policy: SavedPolicy,
  identities: Identities | undefined,
): RuleReadback {
  const names = list.format(rule.targets.map((target) => labelOf(target, identities)));
  const noun = DIMENSION_NOUN[rule.dimension];
  const unmet =
    rule.targets.length === 1
      ? "If it can't meet a request,"
      : 'If none of them can meet a request,';
  let text: string;
  if (rule.dimension === 'capability') {
    const tasks = rule.targets.flatMap((target) =>
      target.kind === 'category' ? tasksOf(target.id, identities) : [labelOf(target, identities)],
    );
    text = `Tenjin may handle ${names} only, including newly added reviewed services there.${tasks.length > 0 ? ` That covers ${named([...new Set(tasks)])}.` : ''} This limits which tasks Tenjin does anywhere; your other blocks and spending limits still apply.`;
  } else if (rule.scope.kind === 'global') {
    text = `Tenjin may use only ${names} as its ${noun}, for every task. ${unmet} Tenjin explains rather than use another ${noun}.`;
  } else {
    const where = labelOf({ kind: rule.scope.kind, id: rule.scope.id }, identities);
    text = `When Tenjin handles ${where}, it can use only ${names}. ${unmet} Tenjin explains rather than use another ${noun}. Other tasks are unaffected.`;
  }
  const blocked = rule.targets.filter(
    (target) => blockedBy(target, policy, identities) !== undefined,
  );
  const gone = goneNote(rule.targets, identities);
  const inactive =
    scopeRuledOut(rule.scope, policy, identities) ??
    (blocked.length === rule.targets.length
      ? `unsatisfiable: everything it allows is blocked, so Tenjin refuses what it covers`
      : gone !== undefined
        ? `partly inactive: ${gone}`
        : undefined);
  return {
    kind: 'only',
    rule,
    text,
    ...(inactive !== undefined ? { inactive } : {}),
    reset: onlyResetCommand(rule),
  };
}

export function describePrefer(
  rule: PreferRule,
  policy: SavedPolicy,
  identities: Identities | undefined,
): RuleReadback {
  const labels = rule.targets.map((target) => labelOf(target, identities));
  const accounts = rule.targets.every((target) => target.kind === 'source');
  const ordered = labels.length === 1 ? labels[0]! : `${list.format(labels)}, in that order,`;
  let text: string;
  if (rule.scope.kind === 'global') {
    text = `Across every task, Tenjin tries your ${ordered} ${labels.length === 1 ? 'account' : 'accounts'} first where it can. A task's or category's own preference comes first.`;
  } else if (accounts && rule.scope.kind === 'category') {
    const where = labelOf({ kind: 'category', id: rule.scope.id }, identities);
    text = `${where} jobs use your ${ordered} ${labels.length === 1 ? 'account' : 'accounts'} first, and ${labels.length === 1 ? 'that plan pays' : 'those plans pay'}. Everything else is unchanged. If ${either.format(labels)} can't do a particular job, Tenjin can still use another tool for it.`;
  } else {
    const where = labelOf({ kind: rule.scope.kind, id: rule.scope.id }, identities);
    const jobs = rule.scope.kind === 'category' ? `${where} jobs` : where;
    text = `Prefer ${ordered} when Tenjin handles ${jobs}. Other allowed services remain available if ${labels.length === 1 ? labels[0] : 'none of them'} can't meet the request.`;
  }
  const blocked = rule.targets.filter(
    (target) => blockedBy(target, policy, identities) !== undefined,
  );
  const blockedNames = list.format(blocked.map((target) => labelOf(target, identities)));
  const gone = goneNote(rule.targets, identities);
  const inactive =
    scopeRuledOut(rule.scope, policy, identities) ??
    (blocked.length === rule.targets.length
      ? `inactive: ${blockedNames} ${blocked.length === 1 ? 'is' : 'are'} blocked`
      : blocked.length > 0
        ? `partly inactive: ${blockedNames} ${blocked.length === 1 ? 'is' : 'are'} blocked and skipped`
        : gone !== undefined
          ? `partly inactive: ${gone}`
          : undefined);
  return {
    kind: 'prefer',
    rule,
    text,
    ...(inactive !== undefined ? { inactive } : {}),
    reset: preferResetCommand(rule.scope),
  };
}

/** What the speed preference costs and what it never does, said with every readback of it. */
const SPEED_TERMS =
  'They cost more, and your limits still apply. This changes when Tenjin offers, never which service it picks, and it turns nothing on by itself.';

/**
 * WHAT `speed on` SAYS, and readback repeats while it is on: the kinds of job
 * it changes, by the labels of the tasks the identities read marks `speed`
 * (an own-tools eval found the paid route as accurate and clearly faster).
 * None marked is said plainly: the setting changes nothing until one is. With
 * no identities at hand, it says it could not tell which.
 */
export function describeSpeed(identities: Identities | undefined): RuleReadback {
  const marked = speedTasks(identities);
  const text =
    marked === undefined
      ? `Tenjin will also offer paid tools for the kinds of job marked as just as accurate as your agent's own tools and clearly faster; it couldn't look up which those are right now, and \`tenjin config\` names them once it can. ${SPEED_TERMS}`
      : marked.length === 0
        ? `No kinds of job are marked faster yet, so this changes nothing until one is. Then Tenjin will also offer paid tools for them, where a measured paid tool is as accurate as your agent's own tools and clearly faster. ${SPEED_TERMS}`
        : `Tenjin will also offer paid tools for ${named(marked)}, where a measured paid tool is as accurate as your agent's own tools and clearly faster. ${SPEED_TERMS}`;
  return {
    kind: 'speed',
    rule: { preferSpeed: true },
    text,
    ...(identities !== undefined
      ? {
          covers: identities.tasks.filter(({ speed }) => speed === true).map(({ id }) => id),
        }
      : {}),
    reset: 'tenjin config speed off',
  };
}

/** Every saved rule: blocks, then only rules, then preferences, then speed. */
export function describeRules(
  policy: SavedPolicy,
  identities: Identities | undefined,
): RuleReadback[] {
  return [
    ...(policy.block ?? []).map((target) => describeBlock(target, identities)),
    ...(policy.only ?? []).map((rule) => describeOnly(rule, policy, identities)),
    ...(policy.prefer ?? []).map((rule) => describePrefer(rule, policy, identities)),
    ...(policy.preferSpeed === true ? [describeSpeed(identities)] : []),
  ];
}

/** The two automatic limits, as a person reads them, on the Tenjin balance. */
export interface LimitsReadback {
  perCall: string;
  /** `null`: no daily limit. */
  daily: string | null;
  text: string;
}

export function describeLimits(maxAutoSpend: string, sessionBudget: string): LimitsReadback {
  const perCall = `$${formatUsdDisplay(maxAutoSpend)}`;
  const daily = sessionBudget === 'none' ? null : `$${formatUsdDisplay(sessionBudget)}`;
  return {
    perCall,
    daily,
    text: `Limits: ${perCall} a call, ${daily === null ? 'no daily limit' : `${daily} a day`} (Tenjin balance).`,
  };
}

/**
 * WHETHER THE AGENT YOU RUN CAN RUN A PICK IN PLACE of its own search or
 * fetch, from what the routers running here saw (`router-observation.ts`):
 * only Claude Code with the Tenjin plugin can. Never claimed from the switch
 * alone: an agent that cannot is named, and with no running session to
 * check, readback says where it works.
 */
export interface ReplacementSupport {
  supported: boolean;
  why: string;
}

const WHERE_IT_WORKS =
  'It works in Claude Code with the Tenjin plugin; other agents, Codex included, keep getting ordinary offers.';

export function replacementSupportOf(
  observations: readonly RouterObservation[],
): ReplacementSupport {
  const newest = [...observations].sort((a, b) => b.at - a.at);
  const claude = newest.find((o) => o.harness === 'claude' && o.servedSession);
  if (claude !== undefined) {
    return claude.launchedByPlugin
      ? {
          supported: true,
          why: 'Your Claude Code runs it in place of its own web search or page fetch.',
        }
      : {
          supported: false,
          why: `Your running Claude Code has Tenjin without its plugin, so it keeps getting ordinary offers. ${WHERE_IT_WORKS}`,
        };
  }
  if (newest.some((o) => o.harness === 'codex')) {
    return {
      supported: false,
      why: `Codex can't run a pick in place of its own search or fetch, so it keeps getting ordinary offers. ${WHERE_IT_WORKS}`,
    };
  }
  return { supported: false, why: WHERE_IT_WORKS };
}

/** {@link replacementSupportOf} for the routers running on this machine now. */
export async function replacementSupport(dataDir: string): Promise<ReplacementSupport> {
  const live = (await readObservations(dataDir).catch(() => [])).filter((o) => pidAlive(o.pid));
  return replacementSupportOf(live);
}

export interface ReplacementReadback {
  mode: ReplacementSetting['mode'];
  providers?: Target[];
  problem?: string;
  supported: boolean;
  text: string;
  reset?: string;
}

export function describeReplacement(
  setting: ReplacementSetting,
  identities: Identities | undefined,
  support: ReplacementSupport,
): ReplacementReadback {
  const providers = setting.providers?.map((target) => labelOf(target, identities));
  const base = {
    mode: setting.mode,
    ...(setting.providers !== undefined ? { providers: setting.providers } : {}),
    ...(setting.problem !== undefined ? { problem: setting.problem } : {}),
    supported: support.supported,
  };
  if (setting.problem !== undefined) {
    return {
      ...base,
      text: `${REPLACEMENT_NAME}: off, because the saved value can't be read (${setting.problem}). Run \`tenjin config replacement off\` to clear it.`,
      reset: 'tenjin config replacement off',
    };
  }
  if (setting.mode === 'off') {
    return {
      ...base,
      text:
        providers === undefined
          ? `${REPLACEMENT_NAME}: off.`
          : `${REPLACEMENT_NAME}: off (its saved choice of ${list.format(providers)} is kept for when it is turned on).`,
    };
  }
  const scope =
    providers === undefined
      ? 'for any allowed provider'
      : `only when Tenjin picks ${either.format(providers)}`;
  return {
    ...base,
    text: `${REPLACEMENT_NAME}: on, ${scope}. ${support.why}`,
    reset: 'tenjin config replacement off',
  };
}

/** Where each personal setting lives, from the one registry. */
export function scopesOf(): Record<string, SettingScope> {
  return { ...SETTING_SCOPES };
}

/** The whole readback `tenjin config` shows and its `--json` carries. */
export interface SettingsReadback {
  saved: string;
  scopes: Record<string, SettingScope>;
  /** False while Tenjin is paused, here or by a project file. */
  enabled: boolean;
  policy: { status: RouterSettings['policy']['status']; problem?: string };
  /** The hash every routing call sends now: shown, never authority. */
  settingsHash?: string;
  rules: RuleReadback[];
  replacement: ReplacementReadback;
  limits: LimitsReadback;
  /** Removes every saved routing rule, readable or not. */
  reset: string;
}

/** Said wherever rules this build cannot read show. */
export const POLICY_INVALID_TEXT =
  "Your Tenjin settings can't be read, so Tenjin won't route or run anything until they're fixed.";

export function settingsReadback(
  router: Pick<RouterSettings, 'enabled' | 'policy' | 'nativeReplacement' | 'wire'>,
  identities: Identities | undefined,
  limits: LimitsReadback,
  support: ReplacementSupport,
): { data: SettingsReadback; lines: string[] } {
  const { policy, enabled } = router;
  const rules = policy.status === 'ok' ? describeRules(policy.saved, identities) : [];
  const replacement = describeReplacement(router.nativeReplacement, identities, support);
  const data: SettingsReadback = {
    saved: SAVED_HERE,
    scopes: scopesOf(),
    enabled: enabled.value,
    policy: {
      status: policy.status,
      ...(policy.status === 'invalid' ? { problem: policy.problem } : {}),
    },
    ...(router.wire.status === 'ok' ? { settingsHash: router.wire.settings.hash } : {}),
    rules,
    replacement,
    limits,
    reset: 'tenjin config reset --all',
  };
  const lines = ['Your settings (saved on this machine, not synced):'];
  if (!enabled.value) {
    const where =
      enabled.source === 'project' || enabled.source === 'local'
        ? `by ${enabled.path ?? 'a project file'}`
        : 'on this machine';
    lines.push(
      `  Tenjin is paused ${where}, so none of these apply until it is on again (router.enabled).`,
    );
  }
  if (policy.status === 'invalid') {
    lines.push(
      `  ${POLICY_INVALID_TEXT} ${policy.problem}. Clear the saved rules with \`tenjin config reset --all\`.`,
    );
  } else if (rules.length === 0) {
    lines.push('  No custom rules: Tenjin uses its defaults.');
  }
  for (const rule of rules) {
    const inactive = rule.inactive !== undefined ? ` (${rule.inactive})` : '';
    lines.push(`  - ${rule.text}${inactive} Undo: \`${rule.reset}\``);
  }
  lines.push(`  ${replacement.text}`, `  ${limits.text}`);
  lines.push('  Change them with `tenjin config --help`.');
  return { data, lines };
}
