import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { RouterSwitch } from '../lib/config';
import { protectedJobsOf, taskOf, tierOf, type SpawnInput } from './agent-job';
import { decideAgentRoute, estimateOf, floorsOf, type AgentDecision } from './agent-route';
import { loadAgentRules } from './agent-rules';
import { definitionFacts, type AgentLookup, type DefinitionFacts } from './agent-tools';
import { readJsonFile, sweep, writePrivate } from './store-files';

/**
 * THE AGENT LEG'S MODEL AND EFFORT DECISION, the first build: rules only, and
 * only for the clearly safe group. `runDelegationHook` starts it beside the
 * paid leg when `router.subagents` (the model) or `router.effort` (the effort) is
 * `shadow` or `apply`; it reads the call, the agent's definition and the
 * parent's last model and effort, decides, and writes one private record per
 * spawn. The mod applies it (`hosts/claude/tenjin/hooks/agents.tsx`): the
 * model in `agent.spawn`, the effort in `turn.step`. Nothing here changes the
 * leg's reply, calls Tenjin's server or Jev, or touches money.
 *
 * TWO TOOLS, TWO SWITCHES. The model and the effort are decided together but
 * recorded and applied apart: `router.subagents` governs only the model and
 * `router.effort` only the effort, and neither turns the other on. An effort
 * left `off` stays exactly as asked even when the model changes.
 *
 * THE SAFE GROUP. A delegated job that only searches or reads (exploring or
 * explaining code, research on the web or in docs): an agent type whose tools
 * cannot edit, or a brief that asks for no change; not named, not in the
 * background, not a teammate and not isolated, so nothing addresses it later;
 * no review, security, design or migration job; no model or effort the
 * user's own latest words name. The decider's floors and skips still hold
 * after this, and its keyless table (`agent-rules.json`) then lowers the model
 * and effort, never raising either, the effort never under `router.effortFloor`.
 * Here the model goes down one tier at most, unless a rule says two for a
 * spawn that cannot change state.
 * Everything else, and every failure, runs exactly as asked.
 *
 * A HOLDOUT OF 20%, from the SHA-256 of the call's `tool_use_id`, runs as
 * asked on both and is recorded as held out.
 *
 * THE RECORD holds no prompt text: the call's facts, what decided and why, and
 * what the mod must do. 0600 in a 0700 directory, swept after 45 days.
 */

export const AGENT_ROUTES_DIR = 'agent-routes';
/** The share of routable spawns that run as asked, for the comparison. */
export const HOLDOUT_SHARE = 0.2;
const RETENTION_MS = 45 * 24 * 60 * 60_000;
const SWEEP_EVERY_MS = 24 * 60 * 60_000;
/** The transcript tail read for the parent's last model and the user's words. */
const TAIL_BYTES = 256 * 1024;
const USER_WORDS_CHARS = 4_000;
const MAX_RECORD_BYTES = 8 * 1024;

/** One Agent call as the leg decoded it. */
export interface AgentSpawnEvent {
  sessionId: string;
  transcriptPath?: string;
  cwd?: string;
  toolUseId: string;
  /** Present when a subagent made the call. */
  agentId?: string;
  permissionMode?: string;
  toolInput: Record<string, unknown>;
}

/** `router.subagents` and `router.effort`, as resolved for the event's directory. */
export interface AgentSwitches {
  model: RouterSwitch;
  effort: RouterSwitch;
  /** `router.effortFloor`: the lowest effort a rule may pick; unset, `medium`. */
  effortFloor?: 'low' | 'medium';
}

export interface AgentLegDeps {
  dataDir: string;
  homeDir: string;
  now?: () => number;
  warn?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** One dimension's decision: the switch, what was decided, and whether the mod applies it. */
export interface DimensionRecord<T extends string> {
  setting: RouterSwitch;
  decided?: T;
  /** True when the mod is to change it: its switch at `apply`, decided, not held out. */
  apply: boolean;
}

/** What the mod reads (`mod-state.ts`): version 1 grows by optional fields only. */
export interface AgentRouteRecord {
  version: 1;
  at: number;
  /** SHA-256 of the session id: the mod applies a record of its own session only. */
  session: string;
  toolUseId: string;
  parentAgentId?: string;
  agentType: string;
  background: boolean;
  isolation?: string;
  named: boolean;
  teammate: boolean;
  permissionMode?: string;
  /** What the call named. */
  asked: { model?: string; effort?: string };
  definition?: { model?: string; effort?: string; readOnly?: boolean };
  /** The parent's last model and effort, from its transcript. */
  parent: { model?: string; effort?: string };
  /** What the spawn runs on if kept: the call's, else the definition's, else the parent's. */
  runsOn: { model?: string; effort?: string };
  /** The environment forces every subagent's model or effort. */
  forced: { model: boolean; effort: boolean };
  /** `safe`, or why the spawn is outside the safe group. */
  group: string;
  floors: string[];
  decider: { layer: string; why: string; rules?: string };
  route: AgentDecision['route'];
  model: DimensionRecord<'haiku' | 'sonnet' | 'opus'>;
  effort: DimensionRecord<'low' | 'medium' | 'high' | 'xhigh'>;
  /** For a person: why it changed, or why not. */
  reason: string;
  /** Estimated percent less usage: the model change alone, the effort change
   *  alone, and both (the weights `agent-route.ts` estimates with). */
  saving?: { model?: number; effort?: number; both?: number };
  holdout: boolean;
}

/** The keyless table's rule ids, for a person. */
const RULE_REASONS: Readonly<Record<string, string>> = {
  'explore-agent': 'read-only search agent',
  'web-fetch-agent': 'web page read',
  'research-or-explore-brief': 'read-only search or research',
};

/** A brief that asks for a change: then only a read-only agent type is in the group. */
const CHANGES =
  /\b(?:edit|edits|editing|write|writes|writing|rewrite|implement\w*|fix|fixes|fixing|change|changes|changing|modif\w+|update|updates|updating|create|creates|creating|add|adds|adding|delete|deleting|remove|removing|rename\w*|refactor\w*|commit\w*|push|pushing|merge|merging|install\w*|deploy\w*|migrat\w*|apply|applying|patch\w*|run (?:the )?(?:tests?|build|script|checks?)|open (?:a )?(?:draft )?(?:pr|pull request)|file (?:an? )?issue|post|send|sends|sending)\b/i;

/** The user naming a model or an effort in their own latest words. */
const USER_NAMED =
  /\b(?:haiku|sonnet|opus|fable|xhigh|ultrathink)\b|\b(?:low|medium|high|max)\s+effort\b|\beffort\s+(?:low|medium|high|max)\b/i;

/**
 * Decide and record one spawn; the record, or null when nothing could be
 * written. Never throws.
 */
export async function recordAgentSpawn(
  event: AgentSpawnEvent,
  switches: AgentSwitches,
  deps: AgentLegDeps,
): Promise<AgentRouteRecord | null> {
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const now = deps.now?.() ?? Date.now();
    const rules = await loadAgentRules({ dataDir: deps.dataDir, warn });
    const lookup: AgentLookup = {
      ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
      homeDir: deps.homeDir,
    };
    const input = event.toolInput;
    const agentType = text(input.subagent_type) ?? 'general-purpose';
    const definition = await definitionFacts(agentType, lookup);
    // A subagent's own spawn: its transcript is not the one named here, so
    // nothing of the parent is read and an unnamed model or effort is kept.
    const tail =
      event.agentId === undefined && event.transcriptPath !== undefined
        ? await transcriptTail(event.transcriptPath)
        : {};
    const asked = { model: text(input.model), effort: text(input.effort) };
    const spawn: SpawnInput = {
      agentType,
      ...optional('description', given(input.description) ? input.description : undefined),
      brief: typeof input.prompt === 'string' ? input.prompt : '',
      named: compact(asked),
      runsOn: compact({
        model: asked.model ?? definition?.model ?? tail.model,
        effort: asked.effort ?? definition?.effort ?? tail.effort,
      }),
      ...optional('parentEffort', tail.effort),
      background: input.run_in_background === true,
      // Any name at all, however long, makes it addressable.
      addressable: given(input.name),
      ...optional('isolation', given(input.isolation) ? String(input.isolation) : undefined),
      teammate: given(input.team_name),
      definition,
    };
    const env = deps.env ?? process.env;
    const forced = {
      model: (env.CLAUDE_CODE_SUBAGENT_MODEL ?? '').length > 0,
      effort: (env.CLAUDE_CODE_EFFORT_LEVEL ?? '').length > 0,
    };
    const mode = switches.model === 'apply' || switches.effort === 'apply' ? 'apply' : 'shadow';
    const outside = rules === null ? 'rules_unreadable' : outsideGroup(spawn, tail.userWords);
    const decision: AgentDecision =
      rules === null || outside !== null
        ? {
            route: 'keep',
            layer: 'skip',
            why: outside ?? 'rules_unreadable',
            reason: `kept: ${outside ?? 'rules_unreadable'}`,
            floors: rules === null ? [] : floorsOf(spawn, rules),
          }
        : await decideAgentRoute(spawn, {
            rules,
            jev: null,
            mode,
            keyless: { ...KEYLESS, effortFloor: switches.effortFloor ?? 'medium' },
          });
    const holdout = heldOut(event.toolUseId);
    const routed = decision.route === 'claude';
    const dimension = <T extends string>(
      setting: RouterSwitch,
      decided: T | undefined,
    ): DimensionRecord<T> => ({
      setting,
      ...(routed && decided !== undefined ? { decided } : {}),
      apply: setting === 'apply' && routed && decided !== undefined && !holdout,
    });
    const saving = routed ? savingOf(spawn, decision) : undefined;
    const record: AgentRouteRecord = {
      version: 1,
      at: now,
      session: sha256(event.sessionId),
      toolUseId: event.toolUseId,
      ...optional('parentAgentId', event.agentId),
      agentType,
      background: spawn.background,
      ...optional('isolation', spawn.isolation),
      named: spawn.addressable,
      teammate: spawn.teammate,
      ...optional('permissionMode', event.permissionMode),
      asked: compact(asked),
      ...(definition !== null ? { definition: definitionOf(definition) } : {}),
      parent: compact({ model: tail.model, effort: tail.effort }),
      runsOn: spawn.runsOn,
      forced,
      group: outside ?? 'safe',
      floors: decision.floors,
      decider: {
        layer: decision.layer,
        why: decision.why,
        ...(rules !== null ? { rules: rules.hash } : {}),
      },
      route: decision.route,
      model: dimension(switches.model, decision.model),
      effort: dimension(switches.effort, decision.effort),
      reason: routed ? (RULE_REASONS[decision.why] ?? `rule ${decision.why}`) : decision.reason,
      ...(saving !== undefined ? { saving } : {}),
      holdout,
    };
    const body = JSON.stringify(record);
    if (Buffer.byteLength(body, 'utf8') > MAX_RECORD_BYTES) return null;
    const dir = join(deps.dataDir, AGENT_ROUTES_DIR);
    await writePrivate(join(dir, `${sha256(event.toolUseId)}.json`), body);
    await sweepOld(dir, now);
    return record;
  } catch (err) {
    warn(
      `tenjin hook: the delegated task's model decision failed (${err instanceof Error ? err.message : String(err)}), so it runs as asked`,
    );
    return null;
  }
}

/** The spawn's record, or null: absent, damaged or another version. */
export async function readAgentRoute(
  dataDir: string,
  toolUseId: string,
): Promise<AgentRouteRecord | null> {
  const row = await readJsonFile(
    join(dataDir, AGENT_ROUTES_DIR, `${sha256(toolUseId)}.json`),
    MAX_RECORD_BYTES,
  );
  return row?.version === 1 ? (row as unknown as AgentRouteRecord) : null;
}

/**
 * Why a spawn is outside the safe group, or null when it is in it. Read in
 * code from the call and the task part of its brief (`taskOf`), never from
 * anything the subagent will produce.
 */
export function outsideGroup(spawn: SpawnInput, userWords?: string): string | null {
  if (spawn.addressable) return 'named';
  if (spawn.background) return 'background';
  if (spawn.teammate) return 'teammate';
  if (spawn.isolation !== undefined) return 'isolation';
  const task = taskOf(spawn);
  if (protectedJobsOf(spawn.agentType, task).length > 0) return 'protected_job';
  if (spawn.definition?.edits !== false && CHANGES.test(task)) return 'changes';
  if (userWords !== undefined && USER_NAMED.test(userWords)) return 'user_named';
  return null;
}

/** True for the share of spawns held out, the same for one call every time. */
export function heldOut(toolUseId: string): boolean {
  const first = createHash('sha256').update(toolUseId).digest().readUInt32BE(0);
  return first / 2 ** 32 < HOLDOUT_SHARE;
}

/**
 * How this build runs the keyless table: by the table alone, which the first
 * live check found at least as good as Jev for choosing a tier (the plan's
 * "First live result"), so apply mode may act on it; the model at most one
 * tier below what the spawn runs on; and a spawn at `max` lowered exactly as
 * one at `xhigh`, as the usage estimate counts it. The record keeps `max` as
 * what it runs on. A rule's own `maxTiersDown` may take a read-only spawn one
 * tier further (`agent-settle.ts`), and `router.effortFloor` bounds its effort.
 */
const KEYLESS = { apply: true, maxTiersDown: 1, maxAsXhigh: true } as const;

/** Estimated percent less usage: the model change alone, the effort change
 *  alone, and both, by the decider's own estimate. */
function savingOf(
  spawn: SpawnInput,
  decision: AgentDecision,
): AgentRouteRecord['saving'] | undefined {
  const pct = (picked: Pick<AgentDecision, 'route' | 'model' | 'effort'>) => {
    const estimate = estimateOf(spawn, picked);
    if (estimate === undefined) return undefined;
    const saved = Math.round((1 - estimate.chosen / estimate.asked) * 100);
    return saved > 0 ? saved : undefined;
  };
  if (tierOf(spawn.runsOn.model) === undefined) return undefined;
  const { route, model, effort } = decision;
  return compact({
    model: model !== undefined ? pct({ route, model }) : undefined,
    effort: effort !== undefined ? pct({ route, effort }) : undefined,
    both: pct({ route, model, effort }),
  });
}

/**
 * The parent's last model and effort, and the user's own latest words, from
 * the last {@link TAIL_BYTES} of the session's transcript. Only those three
 * are read: never a tool result, and nothing of it is kept.
 */
export async function transcriptTail(
  path: string,
): Promise<{ model?: string; effort?: string; userWords?: string }> {
  let lines: string[];
  try {
    const file = await open(path, 'r');
    try {
      const { size } = await file.stat();
      const start = Math.max(0, size - TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await file.read(buffer, 0, buffer.length, start);
      lines = buffer.toString('utf8').split('\n');
      if (start > 0) lines.shift();
    } finally {
      await file.close();
    }
  } catch {
    return {};
  }
  const found: { model?: string; effort?: string; userWords?: string } = {};
  for (let at = lines.length - 1; at >= 0; at--) {
    if (found.model !== undefined && found.userWords !== undefined) break;
    const line = lines[at]!;
    if (line.length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.isSidechain === true) continue;
    const message = entry.message as { model?: unknown; content?: unknown } | undefined;
    if (entry.type === 'assistant' && found.model === undefined) {
      const model = text(message?.model);
      if (model !== undefined && tierOf(model) !== undefined) {
        found.model = model;
        const effort = text(entry.effort);
        if (effort !== undefined) found.effort = effort;
      }
    } else if (entry.type === 'user' && found.userWords === undefined && entry.isMeta !== true) {
      const words = userWordsOf(message?.content);
      if (words !== undefined) found.userWords = words.slice(0, USER_WORDS_CHARS);
    }
  }
  return found;
}

/** A user entry's own typed text; undefined for a tool result. */
function userWordsOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  if (content.some((block) => (block as { type?: unknown })?.type === 'tool_result')) {
    return undefined;
  }
  const parts = content
    .filter((block) => (block as { type?: unknown })?.type === 'text')
    .map((block) => (block as { text?: unknown }).text)
    .filter((part): part is string => typeof part === 'string');
  return parts.length > 0 ? parts.join('\n') : undefined;
}

let lastSweep = 0;

async function sweepOld(dir: string, now: number): Promise<void> {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  await sweep(dir, async (_name, path) => now - (await lstat(path)).mtimeMs > RETENTION_MS, {
    limit: 20_000,
  });
}

function definitionOf(facts: DefinitionFacts): NonNullable<AgentRouteRecord['definition']> {
  return compact({
    model: facts.model,
    effort: facts.effort,
    ...(facts.edits !== undefined ? { readOnly: !facts.edits } : {}),
  });
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A nonempty string of any length. */
function given(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A nonempty, bounded string, else undefined: what a record may keep. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 1_000 ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value !== undefined ? ({ [key]: value } as Record<K, V>) : {};
}

/** The object without its undefined fields. */
function compact<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
