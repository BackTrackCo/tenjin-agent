import type { EngineInterface, On } from 'claude-code';

import type { TenjinAgentCounts, TenjinAgentPart, TenjinAgentRow } from '../types';
import { awaitingEffort, EFFORTS, keepEffort, type Effort } from './agent-effort';
import {
  asRecord,
  clean,
  readJson,
  sha256Hex,
  showStatus,
  tenjinDataDir,
  type Status,
} from './shared';

/**
 * DELEGATED TASKS: the router's offer line and, under their own switches, the
 * model (`router.subagents`) and the effort (`router.effort`) the CLI's agent
 * leg decided. `register.tsx` hooks this in, and its one `turn.step` hook sends
 * a subagent's step to `agent-effort.ts`.
 *
 * - THE OFFER. The agent leg keeps the line it made for a task under the
 *   Agent call's `tool_use_id` (`progress/<sha256(session)>/delegate-*.json`,
 *   `markDelegated`); `agent.spawn` appends it to the task's prompt once. A
 *   classic hook's `updatedInput` on the call is refused in auto mode; this
 *   rewrite is not.
 * - THE MODEL AND THE EFFORT (`agent-routes/<sha256(tool_use_id)>.json`, the
 *   agent leg's record), each applied only where its own switch is `apply`:
 *   the model in `agent.spawn`, the effort on every step (`agent-effort.ts`).
 *   Neither is ever raised past what the spawn would run on. One dim line
 *   under the Agent row says what changed and what was asked, each part on
 *   its own; a held-out spawn says so; `shadow` says what it would do and
 *   changes nothing; a kept spawn shows nothing. The status line keeps counts.
 *   A tier is sent as its alias (`haiku`), which the host resolves to its
 *   current model; the row keeps what it resolved to, and claims the model
 *   only when the spawn ran on that tier. A Haiku spawn the host refuses, or
 *   whose result has no usable answer, runs once more, as asked.
 *
 * NOTHING ELSE CHANGES: never the agent type, the tool list, the background,
 * the name or the directory, so a routed subagent keeps the router's tools.
 * A resume, a fork, a teammate, a workflow agent, a missing, stale or foreign
 * record, or any failure runs the spawn as asked. Reads only: nothing is
 * written under the data dir.
 */

type Dollar = EngineInterface;
type Switch = 'off' | 'shadow' | 'apply';

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const ROWS = { plugin: 'tenjin', key: 'agentRows' } as const;
const COUNTS = { plugin: 'tenjin', key: 'agentCounts' } as const;
/** A record older than this is not the spawn's: the CLI writes it just before. */
const RECORD_MAX_AGE_MS = 10 * 60_000;
const LINE_MAX_CHARS = 2_000;
/** Where the host's hand-back frame ends and the subagent's own report begins. */
const REPORT_FOLLOWS = 'The report follows:';
const GUTTER = '  ⎿  ';
const TIERS = ['haiku', 'sonnet', 'opus', 'fable'] as const;
type Tier = (typeof TIERS)[number];

let counts: TenjinAgentCounts | undefined;

export function registerAgents(on: On, status: Status): void {
  /** Agent calls that ran on Haiku, until their result is read. */
  const onHaiku = new Set<string>();
  /** Agent calls whose Haiku run gave no usable answer: their next spawn runs as asked. */
  const again = new Set<string>();

  on('agent.spawn', async ($, e, next) => {
    if (e.resume !== undefined || e.fork || e.workflow !== undefined || e.isTeammate === true) {
      return next(e);
    }
    const respawn = again.delete(e.tool_use_id);
    const dataDir = await tenjinDataDir($);
    if (dataDir === null) return next(e);
    const session = await sha256Hex(await $.session.id());
    const key = await sha256Hex(e.tool_use_id);
    const now = await $.clock.now();
    const line = await offerLine($, `${dataDir}/progress/${session}/delegate-${key}.json`, now);
    const route = await routeOf($, `${dataDir}/agent-routes/${key}.json`, session, now);
    const asked = { model: tierOf(e.model ?? e.parentModel), effort: route?.runsOnEffort };
    const plan = route === null || respawn ? {} : await planOf($, route, asked.model);
    const asAsked = line === undefined ? e : { ...e, prompt: `${e.prompt}\n\n${line}` };
    const input = plan.model !== undefined ? { ...asAsked, model: plan.model } : asAsked;
    const settle = plan.effort !== undefined ? awaitingEffort() : undefined;
    let result: Awaited<ReturnType<typeof next>>;
    let refused: boolean;
    try {
      // READING ON HAIKU, REFUSED: the host would not run its Haiku (a denial
      // or a throw), so the spawn runs once more on the model it asked for, the
      // effort plan unchanged. Any other failure is the spawn's own.
      let first: Awaited<ReturnType<typeof next>> | undefined;
      try {
        first = await next(input);
      } catch (err) {
        if (plan.model !== 'haiku') throw err;
      }
      refused = plan.model === 'haiku' && (first === undefined || 'deny' in first);
      result = refused || first === undefined ? await next(asAsked) : first;
    } catch (err) {
      settle?.(undefined, null);
      throw err;
    }
    const agentId = 'agentId' in result ? result.agentId : undefined;
    settle?.(agentId, plan.effort ?? null);
    if (route === null) return result;
    if (agentId !== undefined && plan.effort !== undefined) {
      await keepEffort($, agentId, plan.effort, e.tool_use_id);
    }
    // What the host resolved the tier to: the row claims a model only when it ran.
    const resolved =
      'model' in result && typeof result.model === 'string' ? clean(result.model, 80) : undefined;
    const ranModel =
      plan.model !== undefined &&
      !refused &&
      (resolved === undefined || tierOf(resolved) === plan.model);
    const ran: Plan = {
      ...(ranModel ? { model: plan.model } : {}),
      ...(plan.effort !== undefined ? { effort: plan.effort } : {}),
    };
    if (ranModel && plan.model === 'haiku') onHaiku.add(e.tool_use_id);
    const row = respawn
      ? { respawned: true as const, reason: route.reason }
      : rowOf(route, ran, asked, ranModel ? resolved : undefined);
    if (row !== null) {
      await $.state.set({ ...ROWS, id: e.tool_use_id }, row);
      $.ui.invalidate('ui.render');
    }
    await count($, status, route, row);
    return result;
  });

  // A HAIKU RUN WITH NO USABLE ANSWER (no words in its report, as 2 of 30
  // graded Haiku runs ended) runs once more, as asked: the call goes again and
  // its spawn takes the model and effort it asked for. Counted on the row and
  // in the status entry. Any other call, and a denied one, is left as it ran.
  on('tool.call', { tool: ['Agent', 'Task'] }, async (_$, e, next) => {
    const ran = await next(e);
    if (!onHaiku.delete(e.tool_use_id) || 'deny' in ran || usableAnswer(ran)) return ran;
    again.add(e.tool_use_id);
    return next(e);
  });

  // The Agent row as the engine draws it, the decision one dim line beneath.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!AGENT_TOOLS.has(e.props.tool)) return next(e);
    const { value: row } = await $.state.get({ ...ROWS, id: e.props.tool_use_id });
    const text = row === undefined ? undefined : lineOf(row);
    if (text === undefined) return next(e);
    const own = await next(e);
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        {own}
        <Text dimColor wrap="truncate-end">{`${GUTTER}${text}`}</Text>
      </Box>
    );
  });
}

/** One dimension of the agent leg's record, as far as this mod reads it. */
interface Dim<T> {
  setting: Switch;
  decided?: T;
  apply: boolean;
}

/** The agent leg's record, as far as this mod reads it. */
interface Route {
  holdout: boolean;
  routed: boolean;
  model: Dim<Tier>;
  effort: Dim<Effort>;
  runsOnEffort?: Effort;
  reason: string;
  saving: { model?: number; effort?: number; both?: number };
}

/** What the spawn gets: a model and an effort, each only when it lowers. */
interface Plan {
  model?: Tier;
  effort?: Effort;
}

/** The record for this call, of this session, version 1 and fresh; else null. */
async function routeOf(
  $: Dollar,
  path: string,
  session: string,
  now: number,
): Promise<Route | null> {
  const record = await readJson($, path);
  if (record?.version !== 1 || record.session !== session || !fresh(record.at, now)) return null;
  const model = dimOf(record.model, (v) => TIERS.find((tier) => tier === v && tier !== 'fable'));
  const effort = dimOf(record.effort, (v) => EFFORTS.find((level) => level === v));
  const runsOn = EFFORTS.find((level) => level === asRecord(record.runsOn)?.effort);
  const saving = asRecord(record.saving) ?? {};
  const pct = (value: unknown) =>
    typeof value === 'number' && value > 0 && value < 100 ? Math.round(value) : undefined;
  return {
    holdout: record.holdout === true,
    routed:
      record.route === 'claude' && (model.decided !== undefined || effort.decided !== undefined),
    model,
    effort,
    ...(runsOn !== undefined ? { runsOnEffort: runsOn } : {}),
    reason: typeof record.reason === 'string' ? clean(record.reason, 80) : '',
    saving: compact({
      model: pct(saving.model),
      effort: pct(saving.effort),
      both: pct(saving.both),
    }),
  };
}

function dimOf<T>(value: unknown, known: (v: unknown) => T | undefined): Dim<T> {
  const dim = asRecord(value);
  const setting: Switch =
    dim?.setting === 'apply' || dim?.setting === 'shadow' ? dim.setting : 'off';
  const decided = known(dim?.decided);
  return {
    setting,
    ...(decided !== undefined ? { decided } : {}),
    apply: setting === 'apply' && dim?.apply === true && decided !== undefined,
  };
}

/**
 * What changes, each under its own switch: the model only below what the
 * spawn runs on, the effort (checked again at each step) only lower, and
 * neither where the session forces it on every subagent.
 */
async function planOf($: Dollar, route: Route, runsOn: Tier | undefined): Promise<Plan> {
  const forcedModel = ((await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL')) ?? '') !== '';
  const forcedEffort = ((await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')) ?? '') !== '';
  const model = route.model.decided;
  const effort = route.effort.decided;
  const lowers =
    model !== undefined && runsOn !== undefined && TIERS.indexOf(model) < TIERS.indexOf(runsOn);
  return {
    ...(route.model.apply && lowers && !forcedModel ? { model } : {}),
    ...(route.effort.apply && effort !== undefined && !forcedEffort ? { effort } : {}),
  };
}

/** The row line's facts, or null where nothing changed or would. */
function rowOf(
  route: Route,
  plan: Plan,
  asked: { model: Tier | undefined; effort: Effort | undefined },
  resolved?: string,
): TenjinAgentRow | null {
  if (!route.routed) return null;
  const part = (to: string, from: string | undefined, done: boolean): TenjinAgentPart => ({
    to,
    ...(from !== undefined ? { from } : {}),
    done,
  });
  const applying = route.model.setting === 'apply' || route.effort.setting === 'apply';
  if (route.holdout && applying) return { holdout: true, reason: route.reason };
  const model =
    plan.model !== undefined
      ? { ...part(plan.model, asked.model, true), ...(resolved !== undefined ? { resolved } : {}) }
      : route.model.setting === 'shadow' && route.model.decided !== undefined
        ? part(route.model.decided, asked.model, false)
        : undefined;
  const effort =
    plan.effort !== undefined
      ? part(plan.effort, asked.effort, true)
      : route.effort.setting === 'shadow' && route.effort.decided !== undefined
        ? part(route.effort.decided, asked.effort, false)
        : undefined;
  if (model === undefined && effort === undefined) return null;
  // The saving of what the lead verb names: what ran, else what would.
  const lead = [model, effort].some((p) => p?.done === true);
  const m = model !== undefined && model.done === lead;
  const f = effort !== undefined && effort.done === lead;
  const saving = m && f ? route.saving.both : m ? route.saving.model : route.saving.effort;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    reason: route.reason,
    ...(saving !== undefined ? { saving } : {}),
  };
}

/**
 * The line a row draws: `Tenjin ran this on Sonnet (asked Opus) at medium
 * (asked high) · read-only search agent · about 52% less usage`, each part
 * only when that dimension changed, or would.
 */
function lineOf(row: TenjinAgentRow): string | undefined {
  if (row.holdout === true) return 'Tenjin left this as asked (holdout)';
  if (row.respawned === true)
    return 'Tenjin ran this again as asked: its Haiku run gave no usable answer';
  const said = (p: TenjinAgentPart | undefined, word: 'on' | 'at') =>
    p === undefined
      ? undefined
      : word === 'on'
        ? `on ${named(p.to)}${p.from !== undefined ? ` (asked ${named(p.from)})` : ''}`
        : `at ${p.to}${p.from !== undefined ? ` (asked ${p.from})` : ''}`;
  const parts = [
    { p: row.model, text: said(row.model, 'on') },
    { p: row.effort, text: said(row.effort, 'at') },
  ].filter((x) => x.text !== undefined);
  const ran = parts.filter((x) => x.p?.done === true).map((x) => x.text);
  const would = parts.filter((x) => x.p?.done === false).map((x) => x.text);
  if (ran.length === 0 && would.length === 0) return undefined;
  const head =
    ran.length > 0
      ? `Tenjin ran this ${ran.join(' ')}${would.length > 0 ? `, and would run it ${would.join(' ')}` : ''}`
      : `Tenjin would run this ${would.join(' ')}`;
  const reason = row.reason !== undefined && row.reason.length > 0 ? ` · ${row.reason}` : '';
  const saving = row.saving !== undefined ? ` · about ${row.saving}% less usage` : '';
  return `${head}${reason}${saving}`;
}

/** The spawn counted once, and the status line drawn from the counts. */
async function count(
  $: Dollar,
  status: Status,
  route: Route,
  row: TenjinAgentRow | null,
): Promise<void> {
  counts ??= (await $.state.get(COUNTS)).value ?? {
    model: 'off',
    effort: 'off',
    spawns: 0,
    routed: 0,
    held: 0,
    would: 0,
  };
  const ran = row?.model?.done === true || row?.effort?.done === true;
  const would = !ran && (row?.model !== undefined || row?.effort !== undefined);
  const respawned = row?.respawned === true;
  counts = {
    model: route.model.setting,
    effort: route.effort.setting,
    // A re-spawn is the same delegated task, run again.
    spawns: counts.spawns + (respawned ? 0 : 1),
    routed: counts.routed + (ran ? 1 : 0),
    held: counts.held + (row?.holdout === true ? 1 : 0),
    would: counts.would + (would ? 1 : 0),
    ...(respawned || counts.respawned !== undefined
      ? { respawned: (counts.respawned ?? 0) + (respawned ? 1 : 0) }
      : {}),
  };
  await $.state.set(COUNTS, counts);
  const word = (setting: Switch) => (setting === 'apply' ? 'on' : setting);
  showStatus(
    $,
    status,
    'subagents',
    [
      `model ${word(counts.model)}, effort ${word(counts.effort)}`,
      `${counts.spawns} spawns`,
      `${counts.routed} routed`,
      `${counts.held} held out`,
      ...(counts.would > 0 ? [`${counts.would} would move`] : []),
      ...((counts.respawned ?? 0) > 0 ? [`${counts.respawned} re-spawned as asked`] : []),
      'explore and research only',
    ].join(' · '),
  );
}

/** The offer line the agent leg kept for this call: one line, fresh, of version 1. */
async function offerLine($: Dollar, path: string, now: number): Promise<string | undefined> {
  const record = await readJson($, path);
  if (record?.version !== 1 || typeof record.offerId !== 'string' || !fresh(record.at, now)) {
    return undefined;
  }
  const line = record.line;
  if (typeof line !== 'string' || line.length === 0 || line.length > LINE_MAX_CHARS) {
    return undefined;
  }
  return /[\p{Cc}\p{Cf}]/u.test(line) ? undefined : line;
}

/** A delegated task's result with words in its report; the host's hand-back frame aside. */
function usableAnswer(ran: { text?: unknown }): boolean {
  const text = typeof ran.text === 'string' ? ran.text : '';
  const frame = text.lastIndexOf(REPORT_FOLLOWS);
  const report = frame === -1 ? text : text.slice(frame + REPORT_FOLLOWS.length);
  return /[\p{L}\p{N}]/u.test(report);
}

function fresh(at: unknown, now: number): boolean {
  return typeof at === 'number' && at <= now + 60_000 && now - at <= RECORD_MAX_AGE_MS;
}

function tierOf(model: string | undefined): Tier | undefined {
  const lower = model?.toLowerCase();
  return lower === undefined ? undefined : TIERS.find((tier) => lower.includes(tier));
}

function named(tier: string): string {
  return `${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
}

function compact<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
