import { formatUsdDisplay } from '../lib/money';
import { SETTING_SCOPES, type SettingScope } from '../lib/config';
import {
  applies,
  blockCoverage,
  blocks,
  onlyCoverage,
  type Coverage,
  type SavedPolicy,
} from '../router/access';
import { isRetired, labelOf } from '../router/directory';
import type {
  DirectoryListing,
  OnlyRule,
  PreferRule,
  Scope,
  Target,
  TargetKind,
} from '../router/decision';
import type { ReplacementSetting, RouterSettings } from '../router/settings';
import { CLAUDE_CODE_FLOOR, meetsFloor } from '../router/claude-cli';
import { pidAlive, readObservations, type RouterObservation } from '../router/router-observation';
import pkg from '../../package.json';

/**
 * WHAT A SAVED SETTING MEANS, IN THE USER'S WORDS. Every `tenjin config`
 * operation answers with this readback, and the bare `tenjin config` lists it,
 * so an agent reports what was actually written rather than what it asked
 * for. Ordinary text names services, providers, tasks and accounts by their
 * catalog labels and says "balance", "your accounts", "your settings" and
 * "limits": typed ids and protocol terms stay in the JSON beside it.
 *
 * Coverage (the tasks a category holds, the services a block reaches) comes
 * from `access.ts`, the same matching enforcement uses, over the router's
 * directory, so what readback says a rule covers is what the rule refuses.
 * With no directory at hand (offline), a rule is named by its ids alone.
 */

/** Said beside every saved routing rule. */
export const SAVED_HERE = 'Saved on this machine; not synced.';
/** How an operation's readback starts. */
export const SAVED_PREFIX = 'Saved on this machine (not synced):';

/** The automatic-replacement switch, by the one name a person sees. */
export const REPLACEMENT_NAME = "Run Tenjin's picks automatically";

/**
 * WHETHER THE AGENT YOU RUN CAN RUN A PICK IN PLACE of its own search or
 * fetch, from what the running routers saw (`router-observation.ts`): only
 * Claude Code with the Tenjin plugin can, and only once a router has seen it.
 * Never claimed from the switch alone: a host that cannot is named, and with
 * no running session to check, readback says where it works.
 */
export interface ReplacementSupport {
  supported: boolean;
  why: string;
}

/** Where automatic use works, said when no running session shows it. */
const WHERE_IT_WORKS = `It works in Claude Code ${CLAUDE_CODE_FLOOR} or later with the Tenjin plugin; other agents keep getting ordinary offers.`;

export function replacementSupportOf(
  observations: readonly RouterObservation[],
): ReplacementSupport {
  const newest = [...observations].sort((a, b) => b.at - a.at);
  const claude = newest.find((o) => o.harness === 'claude' && o.servedSession);
  if (claude !== undefined) {
    const { client } = claude;
    if (
      claude.launchedByPlugin &&
      client?.name === 'claude-code' &&
      meetsFloor(client.version, CLAUDE_CODE_FLOOR)
    ) {
      return {
        supported: true,
        why: 'Your Claude Code runs it in place of its own web search or page fetch.',
      };
    }
    return {
      supported: false,
      why: `Your running Claude Code can't run a pick in place of its own search or fetch, so it keeps getting ordinary offers. ${WHERE_IT_WORKS}`,
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

/** The build that enforces these settings: a Tenjin from before them ignores them. */
export const ENFORCED_BY = `Enforced by this Tenjin (${pkg.version}); a version from before these settings ignores them.`;

/** One saved rule, as JSON and as a sentence. */
export interface RuleReadback {
  kind: 'block' | 'only' | 'prefer';
  /** The saved rule, typed ids and all. */
  rule: Target | OnlyRule | PreferRule;
  text: string;
  /** Why the rule cannot apply as written; it stays saved and visible. */
  inactive?: string;
  covers?: Coverage;
  /** The one command that removes it. */
  reset: string;
}

const list = new Intl.ListFormat('en', { type: 'conjunction' });
const either = new Intl.ListFormat('en', { type: 'disjunction' });

/** A shell word for a typed id: ids hold letters, digits, spaces and `._:-`. */
export const shellWord = (id: string) => (/^[A-Za-z0-9._:-]+$/.test(id) ? id : `"${id}"`);

const KIND_FLAG: Record<TargetKind, string> = {
  category: '--category',
  task: '--task',
  provider: '--provider',
  seller: '--seller',
  service: '--service',
  source: '--source',
};

export const flagFor = ({ kind, id }: Target) => `${KIND_FLAG[kind]} ${shellWord(id)}`;

function scopeFlag(scope: Scope): string {
  return scope.kind === 'global' ? '--global' : `--task ${shellWord(scope.id)}`;
}

/** The command that removes a block. */
export const unblockCommand = (target: Target) => `tenjin config unblock ${flagFor(target)}`;

/** The command that removes an only rule, and nothing beside it. */
export function onlyResetCommand(rule: Pick<OnlyRule, 'scope' | 'dimension'>): string {
  return rule.dimension === 'capability'
    ? 'tenjin config reset --global --capabilities'
    : `tenjin config reset ${scopeFlag(rule.scope)} --restriction --dimension ${rule.dimension}`;
}

/** The command that removes a preference entry. */
export const preferResetCommand = (scope: Scope) =>
  `tenjin config reset ${scopeFlag(scope)} --preference`;

const MAX_NAMED = 8;

function named(labels: readonly string[]): string {
  if (labels.length <= MAX_NAMED) return list.format(labels);
  return `${labels.slice(0, MAX_NAMED).join(', ')} and ${labels.length - MAX_NAMED} more`;
}

function taskLabel(id: string, listing: DirectoryListing | undefined): string {
  return labelOf({ kind: 'task', id }, listing);
}

/** The saved block that already rules a target out, if any: the same id, a
 *  category that holds a task, or a block that reaches a service. */
export function blockedBy(
  target: Target,
  policy: SavedPolicy,
  listing: DirectoryListing | undefined,
): Target | undefined {
  const saved = policy.block ?? [];
  const same = saved.find(({ kind, id }) => kind === target.kind && id === target.id);
  if (same !== undefined || listing === undefined) return same;
  if (target.kind === 'task')
    return saved.find(
      ({ kind, id }) =>
        kind === 'category' &&
        listing.categories.some(
          (category) => category.id === id && category.tasks.includes(target.id),
        ),
    );
  if (target.kind === 'service') {
    const service = listing.services.find(({ id }) => id === target.id);
    if (service !== undefined) return saved.find((block) => blocks(block, service.identity));
  }
  return undefined;
}

/** Why a rule scoped to a task cannot apply: the task itself is ruled out. */
function taskRuledOut(
  task: string,
  policy: SavedPolicy,
  listing: DirectoryListing | undefined,
): string | undefined {
  const block = blockedBy({ kind: 'task', id: task }, policy, listing);
  if (block !== undefined)
    return `inactive: ${labelOf(block, listing)} is blocked, so Tenjin doesn't handle ${taskLabel(task, listing)}`;
  const capability = (policy.only ?? []).find(
    ({ scope, dimension }) => scope.kind === 'global' && dimension === 'capability',
  );
  if (capability === undefined) return undefined;
  const categories =
    listing?.categories.filter(({ tasks }) => tasks.includes(task)).map(({ id }) => id) ?? [];
  const admitted = capability.targets.some(
    ({ kind, id }) =>
      (kind === 'task' && id === task) || (kind === 'category' && categories.includes(id)),
  );
  return admitted
    ? undefined
    : `inactive: your settings don't let Tenjin handle ${taskLabel(task, listing)}`;
}

function retiredNote(targets: readonly Target[], listing: DirectoryListing | undefined) {
  const gone = targets.filter((target) => isRetired(target, listing));
  return gone.length === 0
    ? undefined
    : `${named(gone.map((target) => labelOf(target, listing)))} ${gone.length === 1 ? 'is' : 'are'} no longer available`;
}

function coversLine(covers: Coverage | undefined): string {
  if (covers === undefined) return '';
  if (covers.services.length === 0) return ' No current service is affected.';
  return ` Covers ${named(covers.services.map(({ label }) => label))}.`;
}

export function describeBlock(target: Target, listing: DirectoryListing | undefined): RuleReadback {
  const label = labelOf(target, listing);
  const covers = listing === undefined ? undefined : blockCoverage(target, listing);
  const services = coversLine(covers);
  let text: string;
  switch (target.kind) {
    case 'category': {
      const tasks = covers?.tasks.length ? `: ${named(covers.tasks)}` : '';
      text = `Tenjin can't handle anything in ${label}${tasks}, including services added there later. Your agent's own tools are outside this setting.`;
      break;
    }
    case 'task':
      text = `Tenjin can't handle ${label}, whichever service could. Your agent's own tools are outside this setting.`;
      break;
    case 'provider':
      text = `${label} is blocked, including reviewed reseller routes identified as using it.${services} A service whose upstream Tenjin can't verify is treated as blocked too.`;
      break;
    case 'seller':
      text = `${label} is blocked as a seller; the same provider sold by someone else stays available.${services} A service whose seller Tenjin can't verify is treated as blocked too.`;
      break;
    case 'service':
      text = `${label} is blocked.`;
      break;
    case 'source':
      text =
        target.id === 'tenjin'
          ? `${label} are blocked, saved and direct calls included. Tenjin's routing fee can still use your balance, within your limits.`
          : `${label} is blocked.`;
      break;
  }
  const gone = retiredNote([target], listing);
  return {
    kind: 'block',
    rule: target,
    text,
    ...(gone !== undefined ? { inactive: `inactive: ${gone}` } : {}),
    ...(covers !== undefined ? { covers } : {}),
    reset: unblockCommand(target),
  };
}

const DIMENSION_NOUN: Record<OnlyRule['dimension'], string> = {
  capability: 'task',
  provider: 'provider',
  seller: 'seller',
  service: 'service',
};

/** Routes the rule leaves out only because they also run through a party it
 *  does not name: "also runs through Venice". */
function throughOthers(rule: OnlyRule, listing: DirectoryListing | undefined): string {
  if (listing === undefined || rule.dimension !== 'provider') return '';
  const allowed = new Set(rule.targets.map(({ id }) => id));
  const partial = listing.services.filter(
    ({ identity }) =>
      applies(rule.scope, identity) &&
      identity.providers.some((id) => allowed.has(id)) &&
      !identity.providers.every((id) => allowed.has(id)),
  );
  if (partial.length === 0) return '';
  const others = [
    ...new Set(
      partial.flatMap(({ identity }) => identity.providers.filter((id) => !allowed.has(id))),
    ),
  ].map((id) => labelOf({ kind: 'provider', id }, listing));
  return ` Left out: ${named(partial.map(({ label }) => label))}, which also ${partial.length === 1 ? 'runs' : 'run'} through ${list.format(others)}.`;
}

export function describeOnly(
  rule: OnlyRule,
  policy: SavedPolicy,
  listing: DirectoryListing | undefined,
): RuleReadback {
  const names = list.format(rule.targets.map((target) => labelOf(target, listing)));
  const covers = listing === undefined ? undefined : onlyCoverage(rule, listing);
  const noun = DIMENSION_NOUN[rule.dimension];
  const unmet =
    rule.targets.length === 1
      ? "If it can't meet a request,"
      : 'If none of them can meet a request,';
  let text: string;
  if (rule.dimension === 'capability') {
    const tasks = covers?.tasks.length ? ` That covers ${named(covers.tasks)}.` : '';
    text = `Tenjin may handle ${names} only, including services added there later.${tasks} This limits which tasks Tenjin does anywhere; your other blocks and spending limits still apply.`;
  } else if (rule.scope.kind === 'global') {
    text = `Tenjin may use only ${names} as its ${noun}, for every task.${throughOthers(rule, listing)} ${unmet} Tenjin explains rather than use another ${noun}.`;
  } else {
    const task = taskLabel(rule.scope.id, listing);
    text = `When Tenjin handles ${task}, it can use only ${names}.${throughOthers(rule, listing)} ${unmet} Tenjin explains rather than use another ${noun}. Other tasks are unaffected.`;
  }
  const blocked = rule.targets.filter((target) => blockedBy(target, policy, listing) !== undefined);
  const inactive =
    (rule.scope.kind === 'task' ? taskRuledOut(rule.scope.id, policy, listing) : undefined) ??
    (blocked.length === rule.targets.length
      ? `unsatisfiable: everything it allows is blocked, so Tenjin refuses ${rule.scope.kind === 'task' ? taskLabel(rule.scope.id, listing) : 'every task it reaches'}`
      : undefined) ??
    (() => {
      const gone = retiredNote(rule.targets, listing);
      return gone !== undefined ? `partly inactive: ${gone}` : undefined;
    })();
  return {
    kind: 'only',
    rule,
    text,
    ...(inactive !== undefined ? { inactive } : {}),
    ...(covers !== undefined ? { covers } : {}),
    reset: onlyResetCommand(rule),
  };
}

export function describePrefer(
  rule: PreferRule,
  policy: SavedPolicy,
  listing: DirectoryListing | undefined,
): RuleReadback {
  const labels = rule.targets.map((target) => labelOf(target, listing));
  const names = either.format(labels);
  const text =
    rule.scope.kind === 'global'
      ? `Across every task, Tenjin tries ${list.format(labels)}${labels.length === 1 ? '' : ', in that order,'} first where possible. A task's own preference comes first.`
      : `Prefer ${labels.length === 1 ? names : `${list.format(labels)}, in that order,`} when Tenjin handles ${taskLabel(rule.scope.id, listing)}. Other allowed services remain available if ${labels.length === 1 ? names : 'none of them'} can't meet the request.`;
  const blocked = rule.targets.filter((target) => blockedBy(target, policy, listing) !== undefined);
  const inactive =
    (rule.scope.kind === 'task' ? taskRuledOut(rule.scope.id, policy, listing) : undefined) ??
    (blocked.length === rule.targets.length
      ? `inactive: ${list.format(blocked.map((target) => labelOf(target, listing)))} ${blocked.length === 1 ? 'is' : 'are'} blocked`
      : blocked.length > 0
        ? `partly inactive: ${list.format(blocked.map((target) => labelOf(target, listing)))} ${blocked.length === 1 ? 'is' : 'are'} blocked and skipped`
        : undefined) ??
    (() => {
      const gone = retiredNote(rule.targets, listing);
      return gone !== undefined ? `partly inactive: ${gone}` : undefined;
    })();
  return {
    kind: 'prefer',
    rule,
    text,
    ...(inactive !== undefined ? { inactive } : {}),
    reset: preferResetCommand(rule.scope),
  };
}

/** Every saved rule, blocks first, then only rules, then preferences. */
export function describeRules(
  policy: SavedPolicy,
  listing: DirectoryListing | undefined,
): RuleReadback[] {
  return [
    ...(policy.block ?? []).map((target) => describeBlock(target, listing)),
    ...(policy.only ?? []).map((rule) => describeOnly(rule, policy, listing)),
    ...(policy.prefer ?? []).map((rule) => describePrefer(rule, policy, listing)),
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
  listing: DirectoryListing | undefined,
  support: ReplacementSupport,
): ReplacementReadback {
  const providers = setting.providers?.map((target) => labelOf(target, listing));
  const base = {
    mode: setting.mode,
    ...(setting.providers !== undefined ? { providers: setting.providers } : {}),
    ...(setting.problem !== undefined ? { problem: setting.problem } : {}),
    supported: support.supported,
  };
  if (setting.problem !== undefined)
    return {
      ...base,
      text: `${REPLACEMENT_NAME}: off, because the saved value can't be read (${setting.problem}). Run \`tenjin config replacement off\` to clear it.`,
      reset: 'tenjin config replacement off',
    };
  if (setting.mode === 'off')
    return {
      ...base,
      text:
        providers === undefined
          ? `${REPLACEMENT_NAME}: off.`
          : `${REPLACEMENT_NAME}: off (its saved choice of ${list.format(providers)} is kept for when it is turned on).`,
    };
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
  return Object.fromEntries(Object.entries(SETTING_SCOPES).map(([key, { scope }]) => [key, scope]));
}

/** The whole readback `tenjin config` shows and its `--json` carries. */
export interface SettingsReadback {
  saved: string;
  scopes: Record<string, SettingScope>;
  /** False while Tenjin is paused, here or by a project file. */
  enabled: boolean;
  policy: { status: RouterSettings['policy']['status']; problem?: string; revision?: string };
  rules: RuleReadback[];
  replacement: ReplacementReadback;
  limits: LimitsReadback;
  /** Removes every saved routing rule, readable or not. */
  reset: string;
}

/** The fix a policy this build cannot read gets: said wherever it shows. */
export const POLICY_INVALID_TEXT =
  "Your Tenjin settings can't be read, so Tenjin won't run services until they're fixed.";

export function settingsReadback(
  router: Pick<RouterSettings, 'enabled' | 'policy' | 'nativeReplacement'>,
  listing: DirectoryListing | undefined,
  limits: LimitsReadback,
  support: ReplacementSupport,
): { data: SettingsReadback; lines: string[] } {
  const { policy, enabled } = router;
  const rules = policy.status === 'ok' ? describeRules(policy.saved, listing) : [];
  const replacement = describeReplacement(router.nativeReplacement, listing, support);
  const data: SettingsReadback = {
    saved: SAVED_HERE,
    scopes: scopesOf(),
    enabled: enabled.value,
    policy: {
      status: policy.status,
      ...(policy.status === 'invalid' ? { problem: policy.problem } : {}),
      ...(policy.status === 'ok' && policy.revision !== undefined
        ? { revision: policy.revision }
        : {}),
    },
    rules,
    replacement,
    limits,
    reset: 'tenjin config reset --all',
  };
  const lines = [`Your settings (${SAVED_HERE.replace(/\.$/, '').toLowerCase()}):`];
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
  if (rules.length > 0) lines.push(`  ${ENFORCED_BY}`);
  lines.push(`  ${replacement.text}`, `  ${limits.text}`);
  lines.push('  Change them with `tenjin config --help`.');
  return { data, lines };
}
