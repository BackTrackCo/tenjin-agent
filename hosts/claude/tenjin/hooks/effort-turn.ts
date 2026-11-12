import type {
  EngineInterface,
  PromptSubmitInput,
  TurnCompleteInput,
  TurnStartInput,
} from 'claude-code';

import {
  EFFORT_OFF,
  asksApproval,
  bucketOf,
  classify,
  decide,
  isLevel,
  readEffortSettings,
  type Classified,
  type Decision,
  type EffortSettings,
  type Level,
} from './effort-rules';
import { sha256Hex, tenjinDataDir } from './shared';

/**
 * MAIN-AGENT EFFORT, ONE TURN AT A TIME: what started each main-session turn
 * (from `prompt.submit`), its class and settings (at `turn.start`), the one
 * decision made at its first model request, and the record kept when it ends.
 *
 * Memory only, per load: a reload or a resume starts over, and its first turn
 * is floored. Text is read to classify a turn and never kept, written or
 * hashed; the one text held is the last typed message, for the repeat rule,
 * and only in memory.
 */

type Dollar = EngineInterface;

/** A submission waiting for the turn it starts. */
type Submitted = { origin: string; text: string; isCommand: boolean };

export type TurnPlan = {
  turnId: string;
  settings: EffortSettings;
  classified: Classified;
  isTyped: boolean;
  isFirstTurn: boolean;
  isApprovalPending: boolean;
  hadEffortCommand: boolean;
  session: string;
  turn: string;
  bucket: number;
  decision?: Decision | null;
  isEffortByHand?: boolean;
  /** A typed message reached the model inside this turn: it runs as asked from then on. */
  isReleased: boolean;
  steps: number;
};

/** What the status entry counts, for the session. */
export type EffortCounts = {
  lowered: number;
  raised: number;
  heldOut: number;
  floored: number;
  byHand: number;
  askedToThink: number;
};

const TYPED = new Set(['composer', 'bridge', 'sdk']);
/** Commands after which the person chose the level themselves. */
const EFFORT_COMMANDS = new Set(['effort', 'model']);
const PENDING_MAX = 8;

export function createTurns() {
  const pending: Submitted[] = [];
  const plans = new Map<string, TurnPlan>();
  let completed = 0;
  let lastTyped: string | undefined;
  let approvalPending = false;
  let effortCommand = false;
  let lastSessionEffort: unknown;
  const counts: EffortCounts = {
    lowered: 0,
    raised: 0,
    heldOut: 0,
    floored: 0,
    byHand: 0,
    askedToThink: 0,
  };

  return {
    counts,

    submitted(e: PromptSubmitInput): void {
      if (e.command !== undefined && EFFORT_COMMANDS.has(e.command.name)) effortCommand = true;
      const kind = e.origin?.kind ?? 'unclassified';
      // Typed while a turn ran: if it reaches that turn, the turn stops being changed.
      if (e.turnId !== undefined && TYPED.has(kind)) {
        const running = plans.get(e.turnId);
        if (running !== undefined) running.isReleased = true;
      }
      pending.push({
        origin: kind,
        text: e.text,
        isCommand: e.command !== undefined || (e.attachments?.length ?? 0) > 0,
      });
      if (pending.length > PENDING_MAX) pending.shift();
    },

    async started(
      e: TurnStartInput,
      settings: EffortSettings,
      sessionId: string,
    ): Promise<TurnPlan> {
      const at = pending.findIndex((p) => p.text === e.text);
      const from = at === -1 ? undefined : pending.splice(at, 1)[0];
      const classified =
        settings.mode === 'off'
          ? ({ class: 'keep', moreThought: false } as const)
          : classify({
              origin: from?.origin,
              text: e.text,
              isCommand: from?.isCommand ?? false,
              ...(lastTyped !== undefined ? { previousTyped: lastTyped } : {}),
            });
      const session = await sha256Hex(sessionId);
      const turn = await sha256Hex(`${sessionId}:${e.turnId}`);
      const plan: TurnPlan = {
        turnId: e.turnId,
        settings,
        classified,
        isTyped: from !== undefined && TYPED.has(from.origin) && !from.isCommand,
        isFirstTurn: completed === 0,
        isApprovalPending: approvalPending,
        hadEffortCommand: effortCommand,
        session,
        turn,
        bucket: bucketOf(turn),
        isReleased: false,
        steps: 0,
      };
      effortCommand = false;
      if (plan.isTyped) lastTyped = e.text;
      plans.set(e.turnId, plan);
      return plan;
    },

    /** A turn that is on and has made no model request yet. */
    isUndecided(turnId: string): boolean {
      const plan = plans.get(turnId);
      return plan !== undefined && plan.settings.mode !== 'off' && plan.decision === undefined;
    },

    /** The turn's decision, made once at its first model request and held after. */
    decided(turnId: string, sessionEffort: unknown, model?: string): TurnPlan | undefined {
      const plan = plans.get(turnId);
      if (plan === undefined) return undefined;
      plan.steps += 1;
      if (plan.decision !== undefined || plan.settings.mode === 'off') return plan;
      plan.isEffortByHand =
        plan.hadEffortCommand ||
        (lastSessionEffort !== undefined && sessionEffort !== lastSessionEffort);
      lastSessionEffort = sessionEffort;
      plan.decision = decide({
        classified: plan.classified,
        settings: plan.settings,
        isFirstTurn: plan.isFirstTurn,
        isEffortByHand: plan.isEffortByHand,
        isApprovalPending: plan.isApprovalPending,
        sessionEffort,
        ...(model !== undefined ? { model } : {}),
        bucket: plan.bucket,
      });
      count(counts, plan);
      return plan;
    },

    /** The turn ended: what it leaves for the next one, and its plan when it is to be recorded. */
    completed(e: TurnCompleteInput): TurnPlan | undefined {
      const plan = plans.get(e.turnId);
      plans.delete(e.turnId);
      completed += 1;
      approvalPending = asksApproval(e.answer);
      return plan !== undefined && isRecorded(plan) ? plan : undefined;
    },
  };
}

export type Turns = ReturnType<typeof createTurns>;

/** The level a step of this plan is sent at, or undefined to send it as the engine would. */
export function levelFor(plan: TurnPlan | undefined): Level | undefined {
  const decision = plan?.decision;
  if (plan === undefined || decision == null || plan.isReleased) return undefined;
  if (plan.settings.mode !== 'apply' || decision.used === decision.sessionEffort) return undefined;
  return decision.used;
}

function count(counts: EffortCounts, plan: TurnPlan): void {
  if (plan.isEffortByHand === true) counts.byHand += 1;
  if (plan.classified.moreThought) counts.askedToThink += 1;
  const d = plan.decision;
  if (d == null) return;
  if (d.floor !== undefined) counts.floored += 1;
  else if (d.isHoldout) counts.heldOut += 1;
  else if (d.class === 'correction') counts.raised += 1;
  else counts.lowered += 1;
}

/** A turn of a class the rules know, or one where the person touched effort themselves. */
function isRecorded(plan: TurnPlan): boolean {
  if (plan.settings.mode === 'off') return false;
  return plan.decision != null || plan.isEffortByHand === true || plan.classified.moreThought;
}

/** This turn's settings, read from the CLI's config files; `off` on any failure. */
export async function settingsOf($: Dollar): Promise<EffortSettings> {
  try {
    const dataDir = await tenjinDataDir($);
    if (dataDir === null) return EFFORT_OFF;
    return await readEffortSettings(
      {
        read: async (path) => ((await $.fs.exists(path)) ? $.fs.read(path) : undefined),
        exists: (path) => $.fs.exists(path),
      },
      { dataDir, cwd: await $.session.cwd(), home: await $.env.get('HOME') },
    );
  } catch {
    return EFFORT_OFF;
  }
}

// RECORDS --------------------------------------------------------------------

/** Where the records live under the data dir, one file per turn. */
const RECORD_DIR = 'effort';

/**
 * Writes one record file, 0600 in a 0700 folder, then deletes records older
 * than 45 days. Node, because the engine's own file write takes no mode. Argument 1 is the
 * folder, 2 the file name; the record is stdin.
 */
const RECORD_SCRIPT = [
  "const fs=require('fs'),path=require('path');",
  'const [dir,name]=process.argv.slice(1);',
  'if(!/^turn-[0-9a-f]{64}\\.json$/.test(name))process.exit(2);',
  'fs.mkdirSync(dir,{recursive:true,mode:0o700});',
  'const tmp=path.join(dir,`.${name}.${process.pid}.tmp`);',
  "fs.writeFileSync(tmp,fs.readFileSync(0,'utf8'),{mode:0o600,flag:'wx'});",
  'fs.renameSync(tmp,path.join(dir,name));',
  'const cut=Date.now()-45*864e5;',
  'for(const f of fs.readdirSync(dir)){',
  'if(!/^turn-[0-9a-f]{64}\\.json$/.test(f))continue;',
  'const p=path.join(dir,f);',
  'try{if(fs.statSync(p).mtimeMs<cut)fs.unlinkSync(p)}catch{}}',
].join('');

/** The record: counts, levels and codes only. No message text and no hash of any. */
type EffortRecord = {
  version: 1;
  at: number;
  session: string;
  turn: string;
  mode: 'shadow' | 'apply';
  class: string;
  reason: string | null;
  floor: string | null;
  sessionEffort: string | null;
  effortUsed: string | null;
  holdout: boolean;
  released: boolean;
  effortByHand: boolean;
  moreThought: boolean;
  steps: number;
  seconds: number;
  end: string;
  model: string | null;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  } | null;
};

function recordOf(plan: TurnPlan, e: TurnCompleteInput, at: number): EffortRecord {
  const d = plan.decision ?? null;
  const used = plan.isReleased ? (d?.sessionEffort ?? null) : (d?.used ?? null);
  const u = e.usage;
  return {
    version: 1,
    at,
    session: plan.session,
    turn: plan.turn,
    mode: plan.settings.mode === 'apply' ? 'apply' : 'shadow',
    class: plan.classified.class,
    reason: plan.classified.reason ?? null,
    floor: d?.floor ?? null,
    sessionEffort: d?.sessionEffort ?? null,
    effortUsed: isLevel(used) ? used : null,
    holdout: d?.isHoldout ?? false,
    released: plan.isReleased,
    effortByHand: plan.isEffortByHand === true,
    moreThought: plan.classified.moreThought,
    steps: plan.steps,
    seconds: Math.round(e.durationMs / 100) / 10,
    end: e.reason,
    model: u?.model ?? null,
    tokens:
      u === undefined
        ? null
        : {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheRead: u.cache_read_input_tokens,
            cacheCreation: u.cache_creation_input_tokens,
          },
  };
}

export async function keepRecord($: Dollar, plan: TurnPlan, e: TurnCompleteInput): Promise<void> {
  try {
    const dataDir = await tenjinDataDir($);
    if (dataDir === null) return;
    const record = recordOf(plan, e, await $.clock.now());
    await $.process.run(
      ['node', '-e', RECORD_SCRIPT, `${dataDir}/${RECORD_DIR}`, `turn-${plan.turn}.json`],
      { stdin: `${JSON.stringify(record)}\n`, timeoutMs: 5000 },
    );
  } catch {
    // A record that cannot be written changes nothing about the turn.
  }
}
