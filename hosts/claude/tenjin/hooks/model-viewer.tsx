import type {
  EngineInterface,
  On,
  TurnStepChunk,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code';
import { update } from 'claude-code';
import {
  asRecord as record,
  subagentsEnabled as enabled,
  HELD_NOT_STARTED,
  HELD_WITH_OFFER,
  tenjinDataDir,
  textOf,
  withDelegatedHint,
} from './hook-data';
import type {
  TenjinModelActivity,
  TenjinModelViewerRecord,
  TenjinModelViewerState,
  TenjinModelWorker,
} from '../types';

// Source candidate: the production native ordering, permissions and Remote Control gate is separate.
const TYPE = 'tenjin:deepseek-viewer';
export const VIEWER_TYPE = TYPE;
const ACCEPT = 'mcp__plugin_tenjin_router__subagent';
const ACTIVITY = 'mcp__plugin_tenjin_router__subagent_activity';
const SERVER = 'plugin:tenjin:router';
const STATE = { plugin: 'tenjin', key: 'modelViewers' } as const;
const WORKERS = { plugin: 'tenjin', key: 'modelWorkers' } as const;
const ASSIGNMENTS = { plugin: 'tenjin', key: 'modelAssignments' } as const;
const OFFERS = { plugin: 'tenjin', key: 'modelOffers' } as const;
/** How long the CLI keeps an offer open (`model-job.ts`). */
const OFFER_MS = 15 * 60_000;
/**
 * Each loop's latest model request as the host numbers it, `<turn id>:<index>`, by
 * agent id ('' for the main loop). A held call names the request that made it, so
 * the CLI tells two calls of one response from the repeat that keeps an offer native.
 */
const steps = new Map<string, string>();
export function modelStep(agentId: string | undefined): string | undefined {
  const step = steps.get(agentId ?? '');
  return short(step) ? step : undefined;
}
/**
 * What the viewer agent is told. Its offer id and description follow, so the
 * transcript's first message can be drawn as the worker's real assignment.
 */
const VIEWER_PROMPT = 'Observe only the already owned DeepSeek worker activity.';
/**
 * THE WORKER'S CALLS AS CLAUDE CODE DRAWS ITS OWN: a viewer step asks for these tools,
 * and this module answers each from the worker's row, so none runs (`tool.call`
 * below; `tool.check` refuses any other call in a viewer's loop). A call of another
 * tool is written as a line of the step's text.
 */
const VIEWER_TOOLS = ['Read', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'] as const;
/** The ids a viewer step gives its calls, so no other call is answered as one. */
const CALL_ID = 'toolu_dsv';
/** A run's rows not yet written into its viewer's transcript, at most. */
const PENDING_ROWS = 2000;
/** What the engine draws of a message, at most. */
const ASSIGNMENT_CHARS = 100_000;
const RESULT_CHARS = 256 * 1024;
/** The CLI's own window of latest rows (`model-worker-activity.ts`). */
const ACTIVITY_ROWS = 128;
/** How often a running worker's row reads its activity file and its clock moves. */
const POLL_MS = 1000;
/** How long retirement waits for a viewer still starting, so it binds first. */
const SPAWN_WAIT_MS = 10_000;
/**
 * How long one viewer step waits for the worker's next reply, so it ends by itself (by
 * one 25 s read more at most) well before Claude Code ends it: the host aborts a
 * background agent that shows no progress for ten minutes (its stall watchdog,
 * 2.1.326). The viewer's stop is then held while the worker runs, and the next step
 * follows on.
 */
const STEP_MS = 5 * 60_000;
/** Claude Code ends a turn whose stop was held more than 8 times in a row. */
const MAX_HOLDS = 8;
/** Steps one viewer turn may take: one a worker reply, the holds between; past it the viewer ends, the worker runs on. */
const VIEWER_TURNS = 2000;
/** Viewer agents whose step ended at its bound, for their stop to be held once. */
const handedOver = new Set<string>();
type Row = TenjinModelActivity['rows'][number];
/**
 * What a viewer agent has followed of its worker: the activity sequence read, the
 * rows not yet written into its transcript, and how the job ended once it has. In
 * memory only; a reload starts it over.
 */
type View = {
  offerId: string;
  sequence: number;
  rows: Row[];
  shown: Set<string>;
  dropped: number;
  holds: number;
  ended?: Json;
  done?: boolean;
};
const views = new Map<string, View>();
/** The calls viewer steps made, by the id each step gave them, until each is answered. */
const viewerCalls = new Map<string, { row: Row; input: Json }>();
/** A viewer call a router tool served, by its id: its row names that tool (`Exa search`). */
const servedCalls = new Map<string, string>();
/**
 * THE WORKER'S ROW STANDS WHERE ITS HELD AGENT CALL STOOD, as the tool router redraws a
 * held `Web Search` row with the lookup that took it. Claude Code draws one Agent call
 * of a response as a row of its own, which this mod redraws: the offer while it is
 * open, then the worker. The accept call then draws nothing for that offer. Two or more
 * Agent calls of one response are Claude Code's own summary block, which no hook
 * redraws, so only their workers draw at the accept call.
 *
 * `heldRows`: the offers whose held row last drew compact, by surface. A row drawn in
 * full (ctrl+o) is the engine's, and there the accept call draws the worker.
 * `acceptSeen`: the accept call that runs an offer, as its row last read it; its answer
 * is how the worker ended, which the held row has no other way to read after a resume.
 * Facts about the drawing alone, in the module's own memory: a reload starts them over
 * and the next drawing of each row writes them again.
 */
const heldRows = new Set<string>();
/**
 * Offers whose held call was one of two or more Agent calls of one response, which Claude
 * Code draws as its summary block: never in place, whatever drew before. Live on alpha.80
 * the first call of such a response drew as a row of its own for a moment, before the
 * second call joined it, and marked itself in place; the accept then drew nothing for it
 * and its worker had no row at all.
 */
const groupedOffers = new Set<string>();
const inPlace = (surface: string, offerId: string) =>
  heldRows.has(surface + ':' + offerId) && !groupedOffers.has(offerId.toLowerCase());
type AcceptCall = { output?: unknown; isInterrupted?: boolean; isErrored?: boolean };
type AcceptSeen = AcceptCall & { call: string; batched: boolean; started: boolean };
const acceptSeen = new Map<string, AcceptSeen>();
/** Kept for a session's rows: far more than one screen holds. */
const DRAWN_MAX = 512;
function markHeldRow($: Dollar, key: string, compact: boolean): void {
  if (compact === heldRows.has(key)) return;
  if (compact) heldRows.add(key);
  else heldRows.delete(key);
  if (heldRows.size > DRAWN_MAX) heldRows.delete(heldRows.values().next().value!);
  $.ui.invalidate('ui.render');
}
/** An accept call that started nothing says so with an `action`; it never ran the worker. */
function startedNothing(output: unknown): boolean {
  return typeof acceptResponse(textOf(output))?.action === 'string';
}
/**
 * What an accept call's row read of its offers. The call that started the worker is
 * the offer's own (the accept hook names it); a call sent again while the worker runs
 * started nothing and never replaces it. After a reload the first call drawn takes an
 * offer, and one that ran its worker takes it from one that started nothing.
 */
function noteAccept($: Dollar, call: string | undefined, ids: string[], props: AcceptCall): void {
  if (!short(call)) return;
  let changed = false;
  for (const id of ids) {
    const held = acceptSeen.get(id);
    const started = !startedNothing(props.output);
    if (held && held.call !== call && (held.started || !started)) continue;
    if (
      held?.call === call &&
      held.output === props.output &&
      held.isInterrupted === props.isInterrupted &&
      held.isErrored === props.isErrored
    )
      continue;
    acceptSeen.delete(id);
    acceptSeen.set(id, {
      call,
      batched: ids.length > 1,
      started: held?.call === call ? held.started || started : started,
      ...(props.output !== undefined ? { output: props.output } : {}),
      ...(props.isInterrupted !== undefined ? { isInterrupted: props.isInterrupted } : {}),
      ...(props.isErrored !== undefined ? { isErrored: props.isErrored } : {}),
    });
    changed = true;
  }
  while (acceptSeen.size > DRAWN_MAX) acceptSeen.delete(acceptSeen.keys().next().value!);
  if (changed) $.ui.invalidate('ui.render');
}
/**
 * THE LINE FOR A PARALLEL AGENT SUMMARY'S HELD CALLS. Claude Code draws that summary
 * itself, with no render hook, and since a held call is answered as a refusal it reads
 * `Not run` for each. A held call the parent then ran needs no line, as a held web search
 * that is let through gets none: an accepted one has its DeepSeek row, and one kept native
 * by sending it again has its own native row. The line is only for a held call that
 * NEVER RAN in its turn (its offer was cancelled or left unanswered, or no offer could be
 * made), so the person sees why `Not run` stands. It is written when the parent's turn
 * ends and counts those calls alone; a logged line stays for good.
 */
const heldNotice: { pending?: { offers: Set<string>; unoffered: number } } = {};
/** The parent ran these held calls: accepted, or sent again and kept native. */
function settleHeld(ids: readonly string[]): void {
  const notice = heldNotice.pending;
  if (!notice) return;
  for (const id of ids) notice.offers.delete(id.toLowerCase());
  if (notice.offers.size === 0 && notice.unoffered === 0) heldNotice.pending = undefined;
}
const callsOf = (n: number) => `${n} Agent call${n === 1 ? '' : 's'}`;
function sayHeld($: Dollar): void {
  const notice = heldNotice.pending;
  if (!notice) return;
  heldNotice.pending = undefined;
  const open = notice.offers.size;
  try {
    if (open > 0)
      $.ui.log(
        `Tenjin held ${callsOf(open)} that did not run: ${open === 1 ? 'its DeepSeek offer was' : 'their DeepSeek offers were'} not accepted.`,
      );
    if (notice.unoffered > 0)
      $.ui.log(
        `Tenjin held ${callsOf(notice.unoffered)} that did not run: no DeepSeek offer could be made.`,
      );
  } catch {
    /* The transcript line is display only. */
  }
}
/** An aborted viewer turn's agent is read again once, after this, in case its stop lands late. */
const RECHECK_MS = 1500;
/** Set once the session ends: what ends with it is not a person stopping an agent. */
let sessionEnding = false;
/**
 * A turn that starts is a live session: `/clear` keeps this module for the session that
 * follows (Claude Code 2.1.328 ends the old one, then gives the process a new session id).
 */
export function sessionLives(): void {
  sessionEnding = false;
}
/**
 * Workers whose rows this module follows: an accept call in flight, or one it
 * took up again after a reload. A reload forgets them; a row then drawn as
 * running asks the CLI how its job stands (`adopt`).
 */
const liveWorkers = new Set<string>();
/** Rows taken up again in this module's life, each once. */
const adopted = new Set<string>();
/**
 * What the host answers an accept call it moved to the background: a tool call
 * still running after two minutes becomes a task of the session, and the
 * parent reads this notice in place of the worker's answer until the task ends.
 */
const HOST_MOVED = /still running after[\s\S]{0,80}moved to the background/;
/** Those tasks, by the id the notice names, so the task's own lines can name their worker. */
const movedTasks = new Map<string, readonly string[]>();
/** Accept calls by their tool use id, for the same. */
const acceptCalls = new Map<string, readonly string[]>();
const ENDED = ['completed', 'cancelled', 'unknown'];
/** Past the job's own 40-minute wall time: nothing can still be running. */
const RUN_LIMIT_MS = 45 * 60_000;
const ALIASES = 'deepseek-viewer-alias-v1:';
const SERIAL = 'deepseek-viewer-serial-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** The agent type a worker runs as: a built-in or a custom one. A plugin's (`a:b`) stays native. */
const PROFILE = /^[A-Za-z0-9_.-]{1,200}$/;
const profileOf = (value: unknown): value is string =>
  typeof value === 'string' && PROFILE.test(value);
const WORKER =
  /^tenjin-worker-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Deny-only fallback when both public observation reads fail. No job or scope authority.
const liveViewerGuards = new Map<string, { turnId?: string }>();
let pendingViewerSpawns = 0;
function guardViewer(id: string, turnId?: string) {
  let held = liveViewerGuards.get(id);
  if (!held && liveViewerGuards.size < 16) {
    held = {};
    liveViewerGuards.set(id, held);
  }
  if (held && !held.turnId && turnId) held.turnId = turnId;
  return held;
}
type Dollar = EngineInterface;
type Json = Record<string, unknown>;
type ViewerBinding = { parentSessionId: string; cwd: string; offerId: string };
type Alias = {
  parentSessionId: string;
  cwd: string;
  nativeId: string;
  workerHandle: string;
  offerId: string;
  generation: string;
  profile: string;
  ordinal: number;
};

const short = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
function clean(value: string, bytes = 512): string {
  // The controller already masks known secrets; remove terminal/format controls again at display.
  const text = value
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim();
  const encoded = new TextEncoder().encode(text);
  return encoded.length <= bytes
    ? text
    : new TextDecoder().decode(encoded.slice(0, bytes - 4)) + '…';
}
/** Display text of several lines: terminal and format controls removed, line breaks kept. */
function plain(value: string, chars: number): string {
  const text = value
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(?![\n\t])[\p{Cc}\p{Cf}]/gu, ' ')
    .trim();
  return text.length <= chars ? text : text.slice(0, chars - 1) + '…';
}
function json(value: unknown, max = 300_000): Json | undefined {
  if (typeof value !== 'string' || value.length > max) return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}
function body(value: unknown): Json | undefined {
  const outer = record(value);
  if (!outer || !Array.isArray(outer.content)) return json(value);
  for (const block of outer.content.slice(0, 4)) {
    const text = record(block);
    if (text?.type === 'text') {
      const parsed = json(text.text);
      if (parsed) return parsed;
    }
  }
  return undefined;
}

async function scope($: Dollar) {
  const parentSessionId = await $.session.id();
  const cwd = (await $.fs.stat(await $.session.cwd(), { resolve: true })).realPath;
  return short(parentSessionId, 2000) && short(cwd, 4000) ? { parentSessionId, cwd } : undefined;
}
async function load($: Dollar) {
  const owner = await scope($);
  if (!owner) return undefined;
  const held = await $.state.get(STATE);
  const old = held.value;
  const same =
    old?.version === 1 && old.parentSessionId === owner.parentSessionId && old.cwd === owner.cwd;
  const state: TenjinModelViewerState = same
    ? structuredClone(old)
    : {
        version: 1,
        ...owner,
        serial: old?.serial ?? 0,
        records: [],
        knownIds: [],
      };
  return { state, version: held.version };
}
async function change($: Dollar, edit: (state: TenjinModelViewerState) => void) {
  const owner = await scope($);
  if (!owner) return;
  // The public helper retries CAS conflicts and reapplies the ownership checks to fresh state.
  return update($, STATE, (old) => {
    const previous =
      old?.version === 1 && old.parentSessionId === owner.parentSessionId ? old : undefined;
    const state: TenjinModelViewerState =
      previous?.cwd === owner.cwd
        ? structuredClone(previous)
        : { version: 1, ...owner, serial: old?.serial ?? 0, records: [], knownIds: [] };
    if (previous && previous.cwd !== owner.cwd) {
      // A worker can outlive the directory that started it. Retain only the
      // identity needed to stop it. Its former display scope no longer applies.
      state.priorStops = [
        ...(previous.priorStops ?? []),
        ...previous.records
          .filter((r) => r.active)
          .map(({ offerId, nativeId, turnId }) => ({ offerId, nativeId, turnId })),
      ];
    }
    edit(state);
    return state;
  });
}
async function retireViewer($: Dollar, binding: ViewerBinding): Promise<void> {
  const [parentSessionId, held] = await Promise.all([$.session.id(), $.state.get(STATE)]);
  const previous = held.value;
  const item =
    (previous?.cwd === binding.cwd
      ? previous.records.find((r) => r.offerId === binding.offerId)
      : undefined) ?? previous?.priorStops?.find((r) => r.offerId === binding.offerId);
  if (
    !previous ||
    !item ||
    parentSessionId !== binding.parentSessionId ||
    previous.parentSessionId !== binding.parentSessionId
  )
    return;
  const nativeId = item.nativeId;
  // Display retirement uses the accepted binding, not current filesystem access.
  await update($, STATE, (current) => {
    if (!current) throw new Error('Activity binding unavailable');
    if (current.parentSessionId !== binding.parentSessionId) return current;
    const state = structuredClone(current);
    state.priorStops = state.priorStops?.filter((r) => r.offerId !== binding.offerId);
    const owned =
      state.cwd === binding.cwd
        ? state.records.find((r) => r.offerId === binding.offerId && r.nativeId === nativeId)
        : undefined;
    if (owned) {
      owned.active = false;
      owned.inspectionUnavailable = true;
    }
    return state;
  });
}
async function hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function aliasKey(nativeId: string): Promise<string> {
  return ALIASES + (await hex(nativeId));
}
/** The held Agent call's description as a row may show it: never a secret, URL or address. */
function titleOf(input: Json | undefined, fallback: string): string {
  const raw = typeof input?.description === 'string' ? input.description : fallback;
  return /secret|password|token|api.key|bearer|https?:|0x[0-9a-f]{32}/i.test(raw)
    ? fallback
    : clean(raw, 64) || fallback;
}
/** Where the CLI keeps a running worker's display activity (`model-worker-progress.ts`). */
async function progressPath($: Dollar, offerId: string): Promise<string | undefined> {
  const data = await tenjinDataDir($);
  if (!data) return undefined;
  const session = await $.session.id();
  return `${data}/progress/model-workers/${await hex(session)}-${await hex(offerId)}.json`;
}
async function readAlias($: Dollar, nativeId: unknown): Promise<Alias | undefined> {
  if (!short(nativeId)) return;
  const a = record(await $.store.get(await aliasKey(nativeId)));
  if (
    a &&
    short(a.parentSessionId, 2000) &&
    short(a.cwd, 4000) &&
    a.nativeId === nativeId &&
    short(a.workerHandle) &&
    WORKER.test(a.workerHandle) &&
    short(a.offerId) &&
    UUID.test(a.offerId) &&
    short(a.generation) &&
    profileOf(a.profile) &&
    Number.isSafeInteger(a.ordinal) &&
    Number(a.ordinal) > 0
  )
    return a as Alias;
}
async function serial($: Dollar): Promise<number> {
  const value = await $.store.get(SERIAL);
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}
async function registerType($: Dollar): Promise<void> {
  await $.agent.register({
    name: 'deepseek-viewer',
    description: 'Read-only activity for an already owned Tenjin DeepSeek worker',
    prompt:
      'Display the already owned DeepSeek worker activity. Never execute its assignment or request model inference.',
    // Every step is the plugin's own made-up response and every call it makes is answered
    // here, so no model request is made and no tool runs. The model is a placeholder that
    // only a failure of every guard below could reach. Worker limits are independent.
    tools: [...VIEWER_TOOLS],
    model: 'haiku',
    maxTurns: VIEWER_TURNS,
    omitClaudeMd: true,
  });
}

/**
 * Called only after the existing local handoff validated its offer. The held
 * call's own prompt is kept in the session's state, for its viewer's first
 * message alone; nothing here is saved across sessions but the serial.
 */
export async function rememberModelOffer(
  $: Dollar,
  offerId: string,
  nativeInput: Json,
): Promise<void> {
  try {
    if (!UUID.test(offerId) || !(await enabled($))) return;
    const profile = nativeInput.subagent_type ?? 'general-purpose';
    if (!profileOf(profile)) return;
    const priorSerial = await serial($);
    const title = titleOf(nativeInput, profile);
    await registerType($);
    let released: string | undefined;
    const current = await change($, (state) => {
      released = undefined;
      if (state.records.some((r) => r.offerId === offerId)) return;
      if (state.records.length >= 16) {
        // A worker that ran and ended goes before an offer that may still be accepted.
        const ran = state.records.findIndex((r) => !r.active && r.activity);
        const free = ran >= 0 ? ran : state.records.findIndex((r) => !r.active);
        if (free < 0) return;
        released = state.records.splice(free, 1)[0]?.offerId;
      }
      const ordinal = Math.max(state.serial, priorSerial) + 1;
      if (!Number.isSafeInteger(ordinal)) return;
      state.serial = ordinal;
      // THE AGENT LIST NAMES THE VIEWER AS THE TASK, as a native subagent's entry is its
      // call's description: ` (2)` on a second of the same, since the viewer binds by it.
      const taken = new Set(state.records.map((r) => r.description));
      let description = title;
      for (let n = 2; taken.has(description); n++) description = title + ' (' + n + ')';
      state.records.push({ offerId, ordinal, profile, title, description, active: false });
    });
    if (current) {
      await $.store.set(SERIAL, Math.max(await serial($), current.serial));
      // An Agent call's prompt, or a follow-up's message to its worker.
      const assignment = [nativeInput.prompt, nativeInput.message].find(
        (text): text is string => typeof text === 'string' && text.trim().length > 0,
      );
      if (assignment && current.records.some((r) => r.offerId === offerId))
        await $.state.set({ ...ASSIGNMENTS, id: offerId }, plain(assignment, ASSIGNMENT_CHARS));
      await $.state.set(
        { ...OFFERS, id: offerId },
        {
          at: await $.clock.now(),
          state: 'offered',
          // The host may hand the field over as the string "true" (2.1.327).
          ...(nativeInput.run_in_background === true || nativeInput.run_in_background === 'true'
            ? { background: true as const }
            : {}),
        },
      );
      if (released) await $.state.set({ ...ASSIGNMENTS, id: released }, '');
    }
  } catch {
    /* An unavailable viewer never changes the held assignment or acceptance. */
  }
}

/**
 * THE VETO IS THE SAME CALL SENT AGAIN, which the CLI lets run native, naming the
 * one open offer that repeat settled. That offer's row gives way to the native
 * call's own: one row a task. Any other offer, of the same assignment too, stays open.
 */
export async function keptNative($: Dollar, offerId: unknown): Promise<void> {
  try {
    if (!short(offerId) || !UUID.test(offerId)) return;
    settleHeld([offerId]);
    const ref = { ...OFFERS, id: offerId };
    const offer = (await $.state.get(ref)).value;
    if (offer?.state === 'offered') await $.state.set(ref, { ...offer, state: 'native' });
  } catch {
    /* Display only. */
  }
}

function activityOf(response: unknown, offerId: string): TenjinModelActivity | undefined {
  const outer = body(response),
    a = record(outer?.activity);
  if (
    outer?.status !== 'activity' ||
    a?.version !== 1 ||
    a.offerId !== offerId ||
    !short(a.workerHandle) ||
    !WORKER.test(a.workerHandle) ||
    !short(a.generation) ||
    !profileOf(a.nativeProfile) ||
    !Number.isSafeInteger(a.sequence) ||
    Number(a.sequence) < 0 ||
    !['starting', 'running', 'completed', 'cancelled', 'unknown'].includes(String(a.state))
  )
    return;
  const rows: TenjinModelActivity['rows'] = [];
  if (Array.isArray(a.rows))
    for (const value of a.rows.slice(-ACTIVITY_ROWS)) {
      const r = record(value);
      if (
        !r ||
        !short(r.id) ||
        !Number.isSafeInteger(r.sequence) ||
        !['text', 'tool', 'status', 'compaction'].includes(String(r.kind)) ||
        !['running', 'completed', 'error', 'cancelled', 'unknown'].includes(String(r.state))
      )
        continue;
      rows.push({
        id: r.id,
        sequence: Number(r.sequence),
        kind: r.kind as Row['kind'],
        state: String(r.state),
        ...(short(r.message, 64) ? { message: r.message } : {}),
        ...(Number.isSafeInteger(r.lines) && Number(r.lines) >= 0
          ? { lines: Number(r.lines) }
          : {}),
        ...(typeof r.target === 'string' ? { target: clean(r.target, 1024) } : {}),
        ...(short(r.via, 64) ? { via: clean(r.via, 64) } : {}),
        ...figuresOf(record(r.figures)),
        ...(typeof r.name === 'string' ? { name: clean(r.name, 120) } : {}),
        ...(typeof r.text === 'string' ? { text: clean(r.text) } : {}),
        ...(typeof r.inputSummary === 'string' ? { inputSummary: clean(r.inputSummary) } : {}),
        ...(typeof r.command === 'string' ? { command: clean(r.command, 1024) } : {}),
        // Its lines kept: a command's result line is its output's first lines.
        ...(typeof r.outputPreview === 'string'
          ? { outputPreview: plain(r.outputPreview, 1024) }
          : {}),
        ...(typeof r.elapsedSeconds === 'number' &&
        Number.isFinite(r.elapsedSeconds) &&
        r.elapsedSeconds >= 0
          ? { elapsedSeconds: r.elapsedSeconds }
          : {}),
      });
    }
  const spend = record(a.spend);
  const validSpend =
    spend &&
    typeof spend.reservedAtomic === 'string' &&
    /^\d{1,30}$/.test(spend.reservedAtomic) &&
    typeof spend.actualAtomic === 'string' &&
    /^\d{1,30}$/.test(spend.actualAtomic) &&
    Array.isArray(spend.uncertain) &&
    spend.uncertain.length <= 128 &&
    spend.uncertain.every((v) => short(v));
  return {
    version: 1,
    offerId,
    workerHandle: a.workerHandle,
    generation: a.generation,
    nativeProfile: a.nativeProfile,
    sequence: Number(a.sequence),
    state: a.state as TenjinModelActivity['state'],
    ...(typeof a.started === 'boolean' ? { started: a.started } : {}),
    droppedRows:
      (Number.isSafeInteger(a.droppedRows) && Number(a.droppedRows) >= 0
        ? Number(a.droppedRows)
        : 0) + (Array.isArray(a.rows) ? Math.max(0, a.rows.length - ACTIVITY_ROWS) : 0),
    rows,
    ...(Number.isSafeInteger(a.toolUses) && Number(a.toolUses) >= 0
      ? { toolUses: Number(a.toolUses) }
      : {}),
    ...(Number.isSafeInteger(a.tokens) && Number(a.tokens) >= 0
      ? { tokens: Number(a.tokens) }
      : {}),
    ...(validSpend
      ? {
          spend: {
            reservedAtomic: spend.reservedAtomic as string,
            actualAtomic: spend.actualAtomic as string,
            uncertain: [...(spend.uncertain as string[])],
          },
        }
      : {}),
  };
}
async function refresh($: Dollar, offerId: string, isCurrent = () => true): Promise<boolean> {
  const data = activityOf(
    await $.mcp.call(SERVER, 'subagent_activity', { offer_id: offerId }),
    offerId,
  );
  if (!data || !isCurrent()) return false;
  let applied = false;
  const current = await change($, (state) => {
    applied = false;
    const r = state.records.find((r) => r.offerId === offerId);
    if (
      !isCurrent() ||
      !r?.nativeId ||
      (r.workerHandle && r.workerHandle !== data.workerHandle) ||
      (r.generation && r.generation !== data.generation) ||
      (r.activity && r.activity.sequence > data.sequence)
    )
      return;
    r.workerHandle = data.workerHandle;
    r.generation = data.generation;
    r.profile = data.nativeProfile;
    r.activity = data;
    r.inspectionUnavailable = !r.active && ['starting', 'running'].includes(data.state);
    applied = true;
  });
  const r = current?.records.find((r) => r.offerId === offerId);
  if (!current || !r?.nativeId || !applied) return false;
  const alias: Alias = {
    parentSessionId: current.parentSessionId,
    cwd: current.cwd,
    nativeId: r.nativeId,
    workerHandle: data.workerHandle,
    generation: data.generation,
    offerId,
    profile: r.profile,
    ordinal: r.ordinal,
  };
  // Each owned native id retains its small metadata alias until the host's store limit is reached.
  // The bounded UI window must not silently discard across-day continuation identity.
  await $.store.set(await aliasKey(alias.nativeId), alias);
  return true;
}

/**
 * Adds what the CLI reports to the rows the viewer has yet to write. A row is kept
 * by its id as it changes; one already written is never written again.
 */
function merge(view: View, activity: TenjinModelActivity): void {
  view.sequence = Math.max(view.sequence, activity.sequence);
  for (const row of activity.rows) {
    // A status says only what runs now, which the row in the parent's view says.
    if (row.kind === 'status' || view.shown.has(row.id)) continue;
    const at = view.rows.findIndex((held) => held.id === row.id);
    if (at >= 0) view.rows[at] = row;
    else view.rows.push(row);
  }
  while (view.rows.length > PENDING_ROWS) {
    view.rows.shift();
    view.dropped++;
  }
}
/**
 * THE NEXT STEP OF THE VIEWER'S TRANSCRIPT: the worker's next reply whose calls have
 * all ended, its text and calls together, as a native subagent's reply is one step.
 * A reply of text alone goes with the next one, or with the end, since a step with
 * no call would end the viewer's turn.
 */
function nextReply(view: View): Row[] | undefined {
  const rows = view.rows;
  const key = (row: Row) => row.message ?? row.id;
  for (let from = 0; from < rows.length;) {
    let to = from;
    while (to < rows.length && key(rows[to]!) === key(rows[from]!)) to++;
    const calls = rows.slice(from, to).filter((row) => row.kind === 'tool');
    const ended = to < rows.length || !!view.ended || !calls.some((r) => r.state === 'running');
    if (!ended) return undefined;
    from = to;
    if (calls.some((row) => callOf(row))) return rows.splice(0, from);
  }
  return undefined;
}
/** A worker's call as one of the viewer's own tools takes it, or undefined for a line of text. */
function callOf(row: Row): Json | undefined {
  const given = json(row.inputSummary) ?? {};
  const text = (key: string) => typeof given[key] === 'string';
  if (row.name === 'Bash' && row.command) return { command: row.command };
  // A read is drawn as one only with its line count: `Read 0 lines` would be a wrong figure.
  if (
    row.name === 'Read' &&
    text('file_path') &&
    (row.lines !== undefined || row.state !== 'completed')
  )
    return {
      file_path: given.file_path,
      ...(typeof given.offset === 'number' ? { offset: given.offset } : {}),
    };
  if (row.name === 'Edit' && text('file_path') && text('old_string') && text('new_string'))
    return {
      file_path: given.file_path,
      old_string: given.old_string,
      new_string: given.new_string,
    };
  if (row.name === 'Write' && text('file_path') && text('content'))
    return { file_path: given.file_path, content: given.content };
  // A web call is drawn as one only with its own figures, which its native line reads.
  const known = row.state !== 'completed' || row.figures !== undefined;
  if (row.name === 'WebFetch' && row.target && known)
    return { url: row.target, prompt: text('prompt') ? given.prompt : '' };
  if (row.name === 'WebSearch' && row.target && known) return { query: row.target };
  return undefined;
}
/** A web call's figures from the CLI, numbers and a status word only. */
function figuresOf(given: Json | undefined): { figures?: NonNullable<Row['figures']> } {
  if (!given) return {};
  const figures: NonNullable<Row['figures']> = {};
  for (const key of ['bytes', 'code', 'durationMs', 'searchCount', 'durationSeconds'] as const) {
    const value = given[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) figures[key] = value;
  }
  if (typeof given.codeText === 'string') figures.codeText = clean(given.codeText, 64);
  return Object.keys(figures).length ? { figures } : {};
}
/**
 * A call's answer, from the worker's row: what Claude Code draws under the call. Never
 * a file's content: a read's line count, a command's first three lines of output (the
 * CLI's already replaced preview), an edit's path. A failed call reads its reason.
 */
function answerOf(tool: string, row: Row, input: Json): { result: unknown } | { deny: string } {
  if (row.state === 'error') return { deny: clean(row.outputPreview ?? 'Error', 400) };
  if (row.state !== 'completed') return { deny: 'Interrupted' };
  const filePath = String(input.file_path ?? '');
  if (tool === 'Read') {
    const lines = row.lines ?? 0;
    const startLine = typeof input.offset === 'number' ? input.offset : 1;
    return {
      result: {
        type: 'text',
        file: { filePath, content: '', numLines: lines, startLine, totalLines: lines },
      },
    };
  }
  if (tool === 'Bash') {
    const stdout = plain(row.outputPreview ?? '', 2000)
      .split('\n')
      .slice(0, 3)
      .map((line) => clean(line, 400))
      .join('\n');
    return { result: { stdout, stderr: '', interrupted: false } };
  }
  const figures = row.figures ?? {};
  if (tool === 'WebFetch')
    return {
      result: {
        url: String(input.url ?? ''),
        bytes: figures.bytes ?? 0,
        code: figures.code ?? 200,
        codeText: figures.codeText ?? '',
        result: '',
        durationMs: figures.durationMs ?? 0,
      },
    };
  if (tool === 'WebSearch')
    return {
      result: {
        query: String(input.query ?? ''),
        results: [],
        durationSeconds: figures.durationSeconds ?? 0,
        ...(figures.searchCount !== undefined ? { searchCount: figures.searchCount } : {}),
      },
    };
  const patch = { filePath, structuredPatch: [], originalFile: null };
  return tool === 'Edit'
    ? { result: { ...patch, oldString: '', newString: '', userModified: false, replaceAll: false } }
    : { result: { ...patch, type: 'update', content: '' } };
}
/** A call of a tool the viewer does not take, as a line of its text: `WebFetch(…)` and what came of it. */
function callLine(row: Row, cwd: string): string {
  const target = row.command ? clean(row.command, 240) : targetOf(row.inputSummary, cwd);
  const head = '⏺ ' + (row.name ?? 'Tool') + (target ? '(' + target + ')' : '');
  // A read says how much it read, never what: a file's content is never written here.
  const under =
    row.state === 'error'
      ? clean(row.outputPreview ?? 'Error', 400)
      : row.state !== 'completed'
        ? 'Interrupted'
        : row.name === 'Read'
          ? row.lines !== undefined
            ? 'Read ' + row.lines + (row.lines === 1 ? ' line' : ' lines')
            : ''
          : clean(plain(row.outputPreview ?? '', 400).split('\n')[0] ?? '', 160).replace(
              /\*\*|__/g,
              '',
            );
  return '```\n' + (head + (under ? '\n  ⎿  ' + under : '')).replaceAll('```', "'''") + '\n```';
}
/** Rows as a step's blocks: the worker's text and calls in order, each call with its id. */
function blocksOf(rows: Row[], cwd: string, view: View) {
  const blocks: ({ text: string } | { id: string; name: string; input: Json })[] = [];
  const say = (text: string) => {
    const last = blocks.at(-1);
    if (last && 'text' in last) last.text += '\n\n' + text;
    else blocks.push({ text });
  };
  if (view.dropped) say(view.dropped + ' earlier events omitted');
  view.dropped = 0;
  for (const row of rows) {
    view.shown.add(row.id);
    const input = row.kind === 'tool' ? callOf(row) : undefined;
    if (input && row.name) {
      const id = CALL_ID + row.id.replace(/[^A-Za-z0-9]/g, '').slice(-24);
      viewerCalls.set(id, { row, input });
      if (viewerCalls.size > 256) viewerCalls.delete(viewerCalls.keys().next().value!);
      if (row.via) servedCalls.set(id, row.via);
      if (servedCalls.size > 512) servedCalls.delete(servedCalls.keys().next().value!);
      blocks.push({ id, name: row.name, input });
      // Claude Code draws no row for a tool search, a native subagent's too.
    } else if (row.kind === 'tool' && row.name !== 'ToolSearch') say(callLine(row, cwd));
    else if (row.text) say(row.text);
  }
  if (view.shown.size > 4096) view.shown.delete(view.shown.values().next().value!);
  return blocks;
}

/** The one input a native row shows for a step: a path, under the session's folder when it is. */
function targetOf(summary: string | undefined, cwd: string): string | undefined {
  if (!summary) return undefined;
  const fields = json(summary);
  const value = fields
    ? Object.values(fields).find((v) => typeof v === 'string' && v.length > 0 && !v.startsWith('['))
    : /^[[{]/.test(summary)
      ? undefined
      : summary;
  if (typeof value !== 'string') return undefined;
  const shown = Array.from(
    clean(cwd && value.startsWith(cwd + '/') ? value.slice(cwd.length + 1) : value, 400),
  );
  return shown.length <= 48 ? shown.join('') : '…' + shown.slice(-47).join('');
}
/** The worker's latest step as a native subagent row names one: `Read(src/a.ts)`. */
function stepOf(activity: TenjinModelActivity, cwd: string): string | undefined {
  const latest = activity.rows.at(-1);
  if (latest?.kind === 'status' && latest.state === 'running' && latest.text) return latest.text;
  const tool = [...activity.rows].reverse().find((r) => r.kind === 'tool' && r.name);
  if (!tool?.name) return undefined;
  const target = tool.command ? clean(tool.command, 96) : targetOf(tool.inputSummary, cwd);
  return target ? tool.name + '(' + target + ')' : tool.name;
}
/** The viewer's band takes the newest activity the live file carried. Display only. */
async function showActivity($: Dollar, data: TenjinModelActivity): Promise<void> {
  const known = (await $.state.get(STATE)).value?.records.find((r) => r.offerId === data.offerId);
  if (!known || (known.activity && known.activity.sequence >= data.sequence)) return;
  await change($, (state) => {
    const r = state.records.find((r) => r.offerId === data.offerId);
    if (
      !r ||
      (r.workerHandle && r.workerHandle !== data.workerHandle) ||
      (r.generation && r.generation !== data.generation) ||
      (r.activity && r.activity.sequence >= data.sequence)
    )
      return;
    r.workerHandle = data.workerHandle;
    r.generation = data.generation;
    r.profile = data.nativeProfile;
    r.activity = data;
    r.inspectionUnavailable = !r.active && ['starting', 'running'].includes(data.state);
  });
}
/**
 * One tick of a running worker's row: its clock, and what the CLI's live file
 * says it has done. A file read, never an MCP call, so it does not wait on the
 * accept call that holds the connection.
 */
async function pollWorker(
  $: Dollar,
  offerId: string,
  path: string,
  cwd: string,
): Promise<TenjinModelActivity | 'missing'> {
  const ref = { ...WORKERS, id: offerId };
  const held = (await $.state.get(ref)).value;
  const now = await $.clock.now();
  let activity: TenjinModelActivity | undefined;
  try {
    activity = activityOf(await $.fs.read(path), offerId);
  } catch {
    // Not written yet, or already removed: the clock still moves.
  }
  const step = activity ? stepOf(activity, cwd) : undefined;
  // A row taken up after a resume that lost its record has no clock of its own.
  const live: TenjinModelWorker | undefined = held && {
    ...held,
    elapsedMs: Math.max(0, now - held.startedAt),
    ...(activity
      ? {
          state: activity.state,
          ...(activity.toolUses !== undefined ? { toolUses: activity.toolUses } : {}),
          ...(activity.tokens !== undefined ? { tokens: activity.tokens } : {}),
          ...(activity.spend ? { spentAtomic: activity.spend.actualAtomic } : {}),
          ...(step ? { current: step } : {}),
        }
      : {}),
  };
  if (live && JSON.stringify(live) !== JSON.stringify(held)) await $.state.set(ref, live);
  if (!activity) return 'missing';
  await showActivity($, activity);
  return activity;
}
/** How a worker ended, from the accept call's own answer; undefined when the answer is not one. */
function endedFrom(answer: Json | undefined): Partial<TenjinModelWorker> | undefined {
  // A worker that stopped with a known cause (`endedBy`) is drawn as one with none.
  const status = answer?.status === 'stopped' ? 'unknown' : answer?.status;
  if (
    status !== 'completed' &&
    status !== 'cancelled' &&
    status !== 'unknown' &&
    status !== 'not_started'
  )
    return undefined;
  const count = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
  const spend = record(answer!.spend);
  const actual =
    typeof spend?.actualAtomic === 'string' && /^\d{1,30}$/.test(spend.actualAtomic)
      ? spend.actualAtomic
      : undefined;
  const [uses, used, elapsed] = [answer!.toolUses, answer!.tokens, answer!.elapsedMs].map(count);
  return {
    ended: status,
    state: status === 'not_started' ? 'unknown' : status,
    ...(endedByOf(answer!.endedBy) ? { endedBy: answer!.endedBy as string } : {}),
    ...(uses !== undefined ? { toolUses: uses } : {}),
    ...(used !== undefined ? { tokens: used } : {}),
    ...(elapsed !== undefined ? { elapsedMs: elapsed } : {}),
    ...(actual !== undefined ? { spentAtomic: actual } : {}),
    ...(Array.isArray(spend?.uncertain) && spend.uncertain.length ? { unresolved: true } : {}),
  };
}
/** The same from the CLI's activity, for a call whose answer the host kept for a background task. */
function endedFromActivity(activity: TenjinModelActivity): Partial<TenjinModelWorker> {
  const state = activity.state as 'completed' | 'cancelled' | 'unknown';
  return {
    ended: activity.started === false && state === 'unknown' ? 'not_started' : state,
    state,
    ...(activity.toolUses !== undefined ? { toolUses: activity.toolUses } : {}),
    ...(activity.tokens !== undefined ? { tokens: activity.tokens } : {}),
    ...(activity.spend ? { spentAtomic: activity.spend.actualAtomic } : {}),
    ...(activity.spend?.uncertain.length ? { unresolved: true } : {}),
  };
}
/**
 * How a worker whose accept call no longer answers here ended, once it has: once its
 * display file is gone or says so, the CLI tells, from the job's own record, with the
 * job's own time. Past the job's wall time with no answer, the row stops following.
 */
async function endedNow(
  $: Dollar,
  offerId: string,
  seen: TenjinModelActivity | 'missing',
  startedAt: number,
): Promise<Partial<TenjinModelWorker> | undefined> {
  if (seen !== 'missing' && !ENDED.includes(seen.state)) return undefined;
  let ended: Partial<TenjinModelWorker> | undefined;
  try {
    const response = await $.mcp.call(SERVER, 'subagent_activity', { offer_id: offerId });
    ended = endedFrom(record(body(response)?.ended));
    const last = activityOf(response, offerId);
    if (last) {
      await showActivity($, last);
      if (!ended && ENDED.includes(last.state)) ended = endedFromActivity(last);
    }
  } catch {
    /* The file's own word, or the limit below, still ends the row. */
  }
  if (!ended && seen !== 'missing') ended = endedFromActivity(seen);
  if (!ended && (await $.clock.now()) - startedAt > RUN_LIMIT_MS) return { ended: 'unseen' };
  return ended;
}
/**
 * A ROW THAT NOTHING HERE FOLLOWS while it reads as running: its accept call began
 * before a reload, which stops this module's timers, or a resume. It asks the CLI
 * how the job stands: ended, its end line is written; running, it is followed again.
 */
async function settle($: Dollar, offerId: string, title: string): Promise<void> {
  if (liveWorkers.has(offerId)) return;
  const ref = { ...WORKERS, id: offerId };
  const [held, path, cwd, now] = await Promise.all([
    $.state.get(ref),
    progressPath($, offerId),
    $.session.cwd(),
    $.clock.now(),
  ]);
  if (held.value?.ended || !path) return;
  const startedAt = held.value?.startedAt ?? now;
  liveWorkers.add(offerId);
  let timer: { cancel(): void } | undefined;
  let polling = false;
  const end = async (ended: Partial<TenjinModelWorker>) => {
    timer?.cancel();
    try {
      const current = (await $.state.get(ref)).value;
      await $.state.set(ref, {
        ...(current ?? { offerId, title, startedAt, state: 'unknown' }),
        ...ended,
      });
      // A background worker this module took up again after a reload: its result is
      // still the parent's to get, once.
      if (ended.ended !== 'unseen') void deliverBackground($, offerId, title);
    } finally {
      liveWorkers.delete(offerId);
      $.ui.invalidate('ui.render');
    }
  };
  try {
    // Once, whatever the display file says: a file a killed process left still says running.
    const ended = await endedNow($, offerId, 'missing', startedAt);
    if (ended) return await end(ended);
    timer = $.clock.every(POLL_MS, async () => {
      if (polling) return;
      polling = true;
      try {
        const ended = await endedNow(
          $,
          offerId,
          await pollWorker($, offerId, path, cwd),
          startedAt,
        );
        if (ended) await end(ended);
      } catch {
        /* Display only. */
      } finally {
        polling = false;
      }
    });
  } catch {
    liveWorkers.delete(offerId);
  }
}
/** Takes up a row once in this module's life, after the drawing that found it. */
function adopt($: Dollar, offerId: string, title: string): void {
  if (adopted.has(offerId) || liveWorkers.has(offerId)) return;
  adopted.add(offerId);
  try {
    $.clock.after(0, () => settle($, offerId, title).catch(() => undefined));
  } catch {
    adopted.delete(offerId);
  }
}
/** Who or what ended a worker that did not complete, by the CLI's fixed code (`endedBy`). */
const ENDED_BY: Record<string, string> = {
  agent_stopped: 'Stopped by you',
  parent_cancel: 'Cancelled by the parent',
  host_aborted: 'Interrupted',
  session_ended: 'Session ended',
  time_limit: 'Time limit reached',
  budget: 'Budget reached',
  model_call_failed: 'Model call failed',
  model_call_timeout: 'Model call timed out',
  payment_refused: 'Payment refused',
  provider: 'DeepSeek unavailable',
  worker_error: 'Stopped',
};
function endedByOf(code: unknown): code is string {
  return typeof code === 'string' && Object.hasOwn(ENDED_BY, code);
}
/**
 * The end word of a worker that did not complete: from the job's end code, which a read
 * carries once the job's record holds its handback, and from its state until then.
 */
function stopWord(status: unknown, endedBy: unknown): string {
  if (endedByOf(endedBy)) return ENDED_BY[endedBy]!;
  return status === 'cancelled' ? 'Interrupted' : 'Stopped';
}
type WorkerEnding = { word: string; parts: string[] };

function endingText({ word, parts }: WorkerEnding): string {
  return word + (parts.length ? ' (' + parts.join(' · ') + ')' : '');
}

function workerEnding(live: TenjinModelWorker): WorkerEnding {
  const time = live.elapsedMs !== undefined ? [duration(live.elapsedMs)] : [];
  if (live.ended === 'not_started') return { word: 'Not started', parts: time };
  // NOT LEARNED HERE: said so, never as a failure of the work, and with no time past its end.
  const unseen = live.ended === 'unseen';
  const word =
    live.ended === 'completed'
      ? 'Done'
      : unseen
        ? 'Outcome not shown here'
        : stopWord(live.ended, live.endedBy);
  const parts = [
    ...(live.toolUses !== undefined || time.length ? [toolUses(live.toolUses ?? 0)] : []),
    ...(live.tokens !== undefined ? [tokens(live.tokens)] : []),
    ...(unseen ? [] : time),
    ...(live.spentAtomic !== undefined
      ? [
          dollars(live.spentAtomic) +
            (unseen ? ' so far' : live.unresolved ? ' · settlement unresolved' : ''),
        ]
      : []),
  ];
  return { word, parts };
}

function displayPreview(message: string, content: string): boolean {
  if (content === message) return true;
  if (!content.endsWith('…')) return false;
  const prefix = content.slice(0, -1);
  if (!prefix || prefix.length >= message.length || !message.startsWith(prefix)) return false;
  // Native Claude truncates display width at a grapheme boundary. The preview
  // carries no task authority; accept only an unchanged prefix of the full message.
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(message)) {
    const end = part.index + part.segment.length;
    if (end >= prefix.length) return end === prefix.length;
  }
  return false;
}
function claudeMessageInput(input: Json, recipientKind: 'agent' | 'name'): Json | undefined {
  const modern = input.to !== undefined && input.message !== undefined;
  const observable =
    ['type', 'recipient_kind', 'request_id', 'approve'].some((key) => key in input) ||
    (modern && (input.recipient !== undefined || input.content !== undefined));
  if (!observable) {
    const addresses = [input.to, input.recipient].filter((value) => value !== undefined);
    return addresses.length === 1 && (!Array.isArray(addresses[0]) || addresses[0].length === 1)
      ? input
      : undefined;
  }
  if (
    Array.isArray(input.to) ||
    Array.isArray(input.recipient) ||
    !modern ||
    typeof input.to !== 'string' ||
    typeof input.message !== 'string' ||
    new TextEncoder().encode(input.message).length > 128_000 ||
    input.type !== 'message' ||
    input.recipient !== input.to ||
    input.recipient_kind !== recipientKind ||
    typeof input.content !== 'string' ||
    !displayPreview(input.message, input.content) ||
    Object.keys(input).some(
      (key) =>
        ![
          'to',
          'message',
          'summary',
          'notify_when_idle',
          'type',
          'recipient',
          'recipient_kind',
          'content',
        ].includes(key),
    )
  )
    return undefined;
  // Claude 2.1.325 backfills this complete tuple for display while retaining
  // modern to/message. The strict backend still receives one address and full task.
  const canonical = { ...input };
  for (const key of ['type', 'recipient', 'recipient_kind', 'content']) delete canonical[key];
  return canonical;
}

/** Alias resolution supplies identity only; the existing capture still owns veto, scope and execution. */
export async function translateViewerContinuation(
  $: Dollar,
  tool: string,
  input: Json,
): Promise<{ input: Json; owned: boolean; unavailable?: boolean }> {
  let known = false;
  let targets: unknown[] = [];
  try {
    const fields = tool === 'SendMessage' ? ['to', 'recipient'] : ['resume'];
    let addresses = fields.filter((key) => input[key] !== undefined);
    targets = addresses.flatMap((key) =>
      Array.isArray(input[key]) ? (input[key] as unknown[]) : [input[key]],
    );
    if (
      tool === 'SendMessage' &&
      targets.some((target) => typeof target === 'string' && WORKER.test(target))
    ) {
      known = true;
      const canonical = claudeMessageInput(input, 'name');
      if (!canonical) return { input, owned: true, unavailable: true };
      input = canonical;
      addresses = fields.filter((key) => input[key] !== undefined);
      targets = addresses.flatMap((key) =>
        Array.isArray(input[key]) ? (input[key] as unknown[]) : [input[key]],
      );
    }
    if (
      addresses.length === 0 ||
      targets.every((target) => typeof target === 'string' && WORKER.test(target))
    )
      return { input, owned: false };
    const aliases = (
      await Promise.all(targets.slice(0, 16).map((target) => readAlias($, target)))
    ).filter((a): a is Alias => !!a);
    known = aliases.length > 0;
    if (!known) {
      const own = (await $.agent.list()).some((a) => targets.includes(a.id) && a.type === TYPE);
      return { input, owned: own, ...(own ? { unavailable: true } : {}) };
    }
    if (tool === 'SendMessage') {
      const canonical = claudeMessageInput(input, 'agent');
      if (!canonical) return { input, owned: true, unavailable: true };
      input = canonical;
      addresses = fields.filter((key) => input[key] !== undefined);
      targets = addresses.flatMap((key) =>
        Array.isArray(input[key]) ? (input[key] as unknown[]) : [input[key]],
      );
    }
    const owner = await scope($),
      alias = aliases.find((a) => a.nativeId === targets[0]);
    if (
      !owner ||
      !alias ||
      addresses.length !== 1 ||
      targets.length !== 1 ||
      aliases.some((a) => a.nativeId !== alias.nativeId) ||
      alias.parentSessionId !== owner.parentSessionId ||
      alias.cwd !== owner.cwd ||
      (tool !== 'SendMessage' &&
        input.subagent_type !== undefined &&
        input.subagent_type !== alias.profile)
    )
      return { input, owned: true, unavailable: true };
    const key = addresses[0]!;
    return {
      input: {
        ...input,
        [key]: Array.isArray(input[key]) ? [alias.workerHandle] : alias.workerHandle,
        ...(tool !== 'SendMessage' && input.subagent_type === undefined
          ? { subagent_type: alias.profile }
          : {}),
      },
      owned: true,
    };
  } catch {
    // A failed metadata store must not skip the independent native-type guard.
    try {
      known ||= (await $.agent.list()).some((a) => targets.includes(a.id) && a.type === TYPE);
    } catch {
      /* The deny-only tag below can still identify a previously observed native viewer. */
    }
    for (const target of targets.slice(0, 16))
      if (typeof target === 'string') known ||= await knownViewer($, target).catch(() => false);
    return { input, owned: known, ...(known ? { unavailable: true } : {}) };
  }
}

async function identify(
  $: Dollar,
  agentId: string,
  turnId?: string,
): Promise<{ item: TenjinModelViewerRecord } | undefined> {
  const native = (await $.agent.list()).find((a) => a.id === agentId);
  if (!native || native.type !== TYPE || native.spawnedBy !== 'tenjin') return;
  let matched = false;
  const current = await change($, (state) => {
    matched = false;
    const matches = state.records.filter(
      (r) =>
        (r.active || (r.nativeId === agentId && !!turnId && r.turnId === turnId)) &&
        r.description === native.description &&
        // Under the agent that accepted, or under the main loop where the host does not
        // place a plugin's agent under another (before 2.1.326).
        (native.parentId === undefined || r.parentId === native.parentId) &&
        (!r.nativeId || r.nativeId === agentId) &&
        (!turnId || !r.turnId || r.turnId === turnId),
    );
    if (matches.length !== 1) return;
    const item = matches[0]!;
    item.nativeId = agentId;
    if (turnId) item.turnId = turnId;
    matched = true;
  });
  const item = current?.records.find((r) => r.nativeId === agentId);
  return matched && item ? { item } : undefined;
}
async function knownViewer($: Dollar, agentId: string): Promise<boolean> {
  // This is a deny-only type guard, not job authority. A lost cwd must not erase a known guard.
  const state = (await $.state.get(STATE)).value;
  return (
    !!state &&
    (state.knownIds.includes(agentId) ||
      state.records.some((r) => r.nativeId === agentId) ||
      !!state.priorStops?.some((r) => r.nativeId === agentId))
  );
}
async function* finish(
  e: TurnStepInput,
  answer: string,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  if (answer) yield { kind: 'text', index: 0, text: answer };
  yield { kind: 'stop', stopReason: 'end_turn', usage: null };
  return {
    turnId: e.turnId,
    index: e.index,
    answer,
    toolUses: [],
    stopReason: 'end_turn',
    usage: null,
  };
}
/**
 * ONE STEP OF A VIEWER'S TRANSCRIPT: the worker's next reply, made up here, its calls
 * answered by the `tool.call` hook. It waits for that reply with follow reads that
 * wake when the activity moves (`after`); past its bound it ends empty and its stop
 * is held, so the next step follows on. Once the worker ended and its replies are
 * written, the last step writes its answer and end line.
 */
async function* viewerStep(
  $: Dollar,
  e: TurnStepInput,
  agentId: string,
  item: TenjinModelViewerRecord,
  view: View,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const cwd = (await $.state.get(STATE)).value?.cwd ?? '';
  const stepStart = await $.clock.now();
  try {
    let quick = 0;
    // Bound by the step's time alone: a long command wakes the read each second it runs.
    for (;;) {
      const reply = nextReply(view);
      if (reply) {
        view.holds = 0;
        const blocks = blocksOf(reply, cwd, view);
        for (const [index, block] of blocks.entries()) {
          if ('text' in block) yield { kind: 'text', index, text: block.text };
          else {
            yield { kind: 'tool', index, id: block.id, name: block.name };
            yield { kind: 'input', index, json: JSON.stringify(block.input) };
          }
        }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null };
        return {
          turnId: e.turnId,
          index: e.index,
          answer: blocks.flatMap((b) => ('text' in b ? [b.text] : [])).join('\n\n'),
          toolUses: blocks.flatMap((b) => ('id' in b ? [{ name: b.name, input: b.input }] : [])),
          stopReason: 'tool_use',
          usage: null,
        };
      }
      if (view.ended) {
        view.done = true;
        return yield* finish(e, await endOf($, item, view, cwd));
      }
      const before = await $.clock.now();
      if (before - stepStart >= STEP_MS) {
        // Ended here, before the host's ten-minute bound, with the stop held once.
        if (view.holds++ >= MAX_HOLDS) break;
        handedOver.add(agentId);
        return yield* finish(e, '');
      }
      const response = await $.mcp.call(SERVER, 'subagent_activity', {
        offer_id: view.offerId,
        follow: true,
        after: view.sequence,
      });
      if (response.isError) break;
      const value = body(response);
      const data = activityOf(response, view.offerId);
      const seen = view.sequence;
      if (data) merge(view, data);
      if (value?.status === 'ended' || (data && ENDED.includes(data.state))) {
        view.ended = { ...data, ...record(value?.ended) };
        try {
          // The run is over, so this read returns at once: its last rows and its answer.
          const last = await $.mcp.call(SERVER, 'subagent_activity', { offer_id: view.offerId });
          const final = activityOf(last, view.offerId);
          if (final) merge(view, final);
          const result = record(body(last)?.activity)?.result;
          view.ended = {
            ...view.ended,
            ...record(body(last)?.ended),
            ...(typeof result === 'string' && result.trim()
              ? { answer: plain(result, RESULT_CHARS) }
              : {}),
          };
        } catch {
          /* The rows read while it ran, and how it ended, still stand. */
        }
        continue;
      } else if (!data && value?.status !== 'waiting') break;
      // A read that did not wait and saw nothing new must not spin: a few short pauses.
      if (view.sequence === seen && (await $.clock.now()) - before < 1000) {
        if (++quick > 5) break;
        await $.clock.sleep(1000);
      }
    }
  } catch {
    /* An observer error never cancels, retries or replaces the actual worker. */
  }
  return yield* finish(
    e,
    'Activity unavailable. The worker result is returned separately to the parent.',
  );
}
function dollars(atomic: string): string {
  const padded = atomic.padStart(7, '0');
  // Whole cents keep two places: `$1.00`, `$0.0043`.
  const fraction = padded.slice(-6).replace(/0+$/, '').padEnd(2, '0');
  return '$' + padded.slice(0, -6) + '.' + fraction;
}
/** Counts as a native subagent row writes them: `12 tool uses`, `41.2k tokens`, `2m 13s`. */
function toolUses(count: number): string {
  return count + (count === 1 ? ' tool use' : ' tool uses');
}
function tokens(count: number): string {
  const compact = (value: number, unit: string) =>
    (Math.floor(value * 10) / 10).toFixed(1).replace(/\.0$/, '') + unit;
  return (
    (count < 1000
      ? String(count)
      : count < 1_000_000
        ? compact(count / 1000, 'k')
        : compact(count / 1_000_000, 'm')) + ' tokens'
  );
}
function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ' + (seconds % 60) + 's';
  return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
}
function displayState(item: TenjinModelViewerRecord): string {
  return item.inspectionUnavailable
    ? 'activity unavailable'
    : (item.activity?.state ?? 'activity unavailable');
}

/**
 * An accept call whose input does not yet say what it is: the model is still writing
 * it. A cancel, a capture and a Codex delegation name themselves by their own field.
 */
function undecided(input: unknown): boolean {
  const given = record(input) ?? {};
  if (
    !['offer_id', 'offer_ids', 'cancel', 'capture', 'delegation_id', 'task'].some(
      (key) => given[key] !== undefined,
    )
  )
    return true;
  // ITS OFFER ID STILL STREAMING: the host draws the input as it arrives, so for that
  // moment the call holds part of an id (live on alpha.64: the host's own
  // `plugin:tenjin:router` row stood between the offer row and the DeepSeek row).
  const partial = (id: unknown): boolean =>
    typeof id === 'string' && !UUID.test(id) && /^[0-9a-f-]{0,35}$/i.test(id);
  if (Object.keys(given).length !== 1) return false;
  // A cancel's id streams in the same way.
  if (partial(given.offer_id) || partial(given.cancel)) return true;
  const ids = given.offer_ids;
  return (
    Array.isArray(ids) &&
    (ids.length < 2 || ids.some(partial)) &&
    ids.every((id) => (short(id) && UUID.test(id)) || partial(id))
  );
}

/** A cancel of one offer by its id, as the model writes it: the offer's id. */
function cancelOf(input: unknown): string | undefined {
  const given = record(input);
  const id = given?.cancel;
  return given && Object.keys(given).length === 1 && short(id) && UUID.test(id) ? id : undefined;
}
/** The CLI's answer to a cancel that took: nothing but its status. */
function cancelAnswer(answer: Json | undefined): boolean {
  return answer?.status === 'cancelled' && Object.keys(answer).length === 1;
}

function acceptedIds(input: unknown, withMetadata = false): string[] | undefined {
  const given = record(input);
  if (!given) return undefined;
  const keys = Object.keys(given).filter(
    (key) => !withMetadata || !['tool', 'tool_use_id', 'agentId', 'requestMeta'].includes(key),
  );
  if (keys.length !== 1) return undefined;
  if (keys[0] === 'offer_id' && short(given.offer_id) && UUID.test(given.offer_id))
    return [given.offer_id];
  const ids = given.offer_ids;
  if (
    keys[0] === 'offer_ids' &&
    Array.isArray(ids) &&
    ids.length >= 2 &&
    ids.every((id): id is string => short(id) && UUID.test(id)) &&
    new Set(ids.map((id) => id.toLowerCase())).size === ids.length
  )
    return ids;
}

function acceptResponse(text: string | undefined): Json | undefined {
  // A combined handback can exceed a single report. The router writes this envelope
  // as compact JSON. Keep any host result-file notice visible as received.
  return json(text, text?.startsWith('{"results":[') ? text.length : undefined);
}

function batchOutcomes(answer: Json | undefined): Map<string, Json> | undefined {
  if (!Array.isArray(answer?.results) || answer.results.length < 2) return undefined;
  const outcomes = new Map<string, Json>();
  for (const entry of answer.results) {
    const item = record(entry);
    const id = item?.offer_id;
    const outcome = record(item?.outcome);
    if (!short(id) || !UUID.test(id) || !outcome || outcomes.has(id)) return undefined;
    outcomes.set(id, outcome);
  }
  return outcomes;
}
/**
 * The accept calls a person's permission settings never ask about, as the plugin's
 * allow leg answered them before (it ran for each, and the host drew its run): the
 * model's accept or cancel of an offer by its id, and this plugin's own capture. Any
 * other input gets the host's own verdict; the CLI still checks the offer is this
 * session's own.
 */
function allowedAccept(input: unknown, ownCall: boolean): boolean {
  const given = record(input);
  const keys = given ? Object.keys(given) : [];
  // Its own capture, and its own read of an ended background worker's stored result.
  if (ownCall)
    return keys.length === 1 && (record(given?.capture) !== undefined || !!acceptedIds(input));
  const id = keys.length === 1 ? given?.[keys[0]!] : undefined;
  return !!acceptedIds(input) || (keys[0] === 'cancel' && short(id) && UUID.test(id));
}

/**
 * A BACKGROUND WORKER'S RESULT REACHES THE PARENT AS A PROMPT OF THIS PLUGIN, once the
 * worker has ended. Its accept call answered at once, so nothing else carries it: Claude
 * Code gives a plugin's own agent (the viewer) no completion notice in any mode (2.1.327
 * marks it notified at launch), and no call asks the host to move an MCP call to the
 * background at once. `$.prompt.submit` queues behind a running turn and starts a turn of
 * its own when the session is idle, as a background agent's notice does.
 *
 * What is handed over is the job's stored handback, read by the accept of an ended offer,
 * which starts nothing and charges nothing. Once per offer: the record says so, also
 * after a reload.
 */
const BACKGROUND_RESULT = 'DeepSeek background worker';
/**
 * Results whose prompt the host did not take, by offer, with the task's title. The host
 * refuses a prompt submitted while a `tool.call` hook of this plugin holds the turn (a
 * batch's accept call waiting for its foreground workers): it is sent again when that
 * call has returned, and when the main loop's turn completes.
 */
const undelivered = new Map<string, string>();
function deliverLater($: Dollar): void {
  for (const [offerId, title] of [...undelivered]) void deliverBackground($, offerId, title);
}
/** That prompt's first line, as its row reads it, bare or under the host's frame for a plugin's prompt. */
const BACKGROUND_ROW =
  /DeepSeek background worker "[^"\n]{0,80}" \(offer [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\) /i;
const delivering = new Set<string>();
/** How long a read waits for the CLI to store an ended job's handback, at most. */
const HANDBACK_READS = 20;
async function deliverBackground($: Dollar, offerId: string, title: string): Promise<void> {
  if (sessionEnding || delivering.has(offerId)) return;
  delivering.add(offerId);
  try {
    const ref = { ...OFFERS, id: offerId };
    const offer = (await $.state.get(ref)).value;
    if (!offer?.background || offer.delivered) return;
    let handback: string | undefined;
    for (let read = 0; read < HANDBACK_READS && !handback; read++) {
      const said = textOf(await $.mcp.call(SERVER, 'subagent', { offer_id: offerId }));
      // Still closing: its record is written a moment after its display says it ended.
      if (said && !startedNothing(said) && !startedInBackground(acceptResponse(said)))
        handback = said;
      else await $.clock.sleep(500);
    }
    // HOW IT ENDED COMES FIRST, in the job's own words: a worker the parent cancelled says
    // so before anything else, so its late message is not read as new work.
    const answer = acceptResponse(handback);
    const how =
      answer?.status === 'completed'
        ? 'finished.'
        : typeof answer?.ended === 'string' && answer.ended.trim()
          ? 'did not complete: ' + clean(answer.ended, 200).replace(/[.]?$/, '.')
          : 'ended.';
    await $.prompt.submit({
      text:
        `${BACKGROUND_RESULT} "${title}" (offer ${offerId}) ${how} This is the result of the background subagent call you accepted earlier, as a background agent's result arrives: it is not a new task, nothing new started and nothing more was charged.\n` +
        (handback ??
          '{"status":"unknown","nextStep":"Its result could not be read here. Accept this offer again with subagent({offer_id}) to read the stored result; that starts no worker."}'),
    });
    undelivered.delete(offerId);
    const current = (await $.state.get(ref)).value;
    if (current) await $.state.set(ref, { ...current, delivered: true });
  } catch {
    // Sent again from a later event. The stored result stays too: accepting the offer
    // again returns it.
    undelivered.delete(offerId);
    undelivered.set(offerId, title);
    if (undelivered.size > 64) undelivered.delete(undelivered.keys().next().value!);
  } finally {
    delivering.delete(offerId);
  }
}

/** How long the session's end waits for its cancels to be taken, at most. */
const SESSION_END_WAIT_MS = 1500;
/**
 * THE SESSION'S END ENDS ITS BACKGROUND WORKERS. A foreground worker ends with its accept
 * call. A background worker is tied to the Tenjin process alone, which the host may keep
 * across `/clear`: it would run on and spend up to its cap, for a session that can no
 * longer be handed its result. Each offer of a background call whose result was not
 * handed over is cancelled by its own id, with the reason its record keeps. An ended
 * job's cancel changes nothing, and its stored result stays readable on a resume.
 */
async function endBackgroundWorkers($: Dollar, closed: string | undefined): Promise<void> {
  const ids = new Set<string>([...liveWorkers, ...undelivered.keys()]);
  try {
    for (const record of (await $.state.get(STATE)).value?.records ?? []) ids.add(record.offerId);
  } catch {
    /* The workers this module follows are still named. */
  }
  const cancels = [...ids].map(async (offerId) => {
    try {
      const offer = (await $.state.get({ ...OFFERS, id: offerId })).value;
      if (
        !offer?.background ||
        offer.delivered ||
        offer.state === 'native' ||
        offer.state === 'cancelled'
      )
        return;
      await $.mcp.call(SERVER, 'subagent', { cancel: offerId, reason: 'session_ended' });
    } catch {
      /* The Tenjin process ends its own workers when it stops. */
    }
  });
  // THE CLI IS TOLD THE SESSION CLOSED, after the cancels: it ends what this module did
  // not know of (a worker warming for an open offer) and drops its record of the session,
  // so that the next session of this Claude Code is taken up and gets offers.
  const told = (async () => {
    await Promise.allSettled(cancels);
    try {
      await $.mcp.call(SERVER, 'subagent', { end_session: closed ?? (await $.session.id()) });
    } catch {
      /* The Tenjin process ends its own workers when it stops. */
    }
  })();
  await Promise.race([told, $.clock.sleep(SESSION_END_WAIT_MS)]);
}

async function watchAccept(
  $: Dollar,
  offerId: string,
  caller: string | undefined,
  batched: boolean,
) {
  let timer: { cancel(): void } | undefined;
  let binding: ViewerBinding | undefined;
  let spawned: Promise<void> | undefined;
  let polling = false,
    closed = false,
    prepared = false,
    viewerStarted = false,
    background = false,
    stopped = false,
    observed = false,
    startedAt = 0;
  // THE END OF THE LIVE DISPLAY, once: with the accept call's own answer, or,
  // for a call the host moved to the background, when the CLI says the worker ended.
  const stop = (ended?: Partial<TenjinModelWorker>) => {
    if (stopped) return;
    stopped = true;
    closed = true;
    try {
      timer?.cancel();
    } catch {
      /* Timer failures do not rewrite the handback. */
    }
    try {
      // UI I/O cannot delay or replace the original worker result, even when inspect hangs.
      $.clock.after(0, async () => {
        try {
          if (ended) {
            const ref = { ...WORKERS, id: offerId };
            const held = (await $.state.get(ref)).value;
            if (held) await $.state.set(ref, { ...held, ...ended });
          }
        } catch {
          /* The row then ends from the call's own answer. */
        }
        // Followed here no more once its end is written, so no drawing takes it for a
        // row that a reload left behind.
        if (liveWorkers.delete(offerId)) $.ui.invalidate('ui.render');
        // A background worker's result goes to the parent now, whichever came first: its
        // end, or its accept call's answer (a batch holds that until its foreground
        // workers end). `deliverBackground` sends nothing for a foreground offer.
        if (ended) {
          const title = (await $.state.get({ ...WORKERS, id: offerId }).catch(() => undefined))
            ?.value?.title;
          void deliverBackground($, offerId, title ?? 'subagent');
        }
        try {
          if (!prepared) return;
          // A viewer still starting binds to its running record before it retires.
          if (spawned && !viewerStarted)
            await Promise.race([spawned, $.clock.sleep(SPAWN_WAIT_MS)]);
          if (binding) await retireViewer($, binding);
          await refresh($, offerId);
        } catch {
          /* The last confirmed rows remain visibly marked unavailable. */
        }
      });
    } catch {
      /* Preserve the exact original acceptance outcome. */
      liveWorkers.delete(offerId);
    }
  };
  if (await enabled($).catch(() => false)) {
    // THE LIVE ROW comes first and stands alone: it reads the CLI's own activity
    // file, so it needs neither the viewer, nor its bookkeeping below, nor a
    // second call on this connection. Followed here before its record is written.
    liveWorkers.delete(offerId);
    liveWorkers.add(offerId);
    try {
      const known = (await $.state.get(STATE)).value?.records.find((r) => r.offerId === offerId);
      await $.state.set(
        { ...WORKERS, id: offerId },
        {
          offerId,
          title: known?.title ?? 'subagent',
          startedAt: (startedAt = await $.clock.now()),
          elapsedMs: 0,
          state: 'starting',
        },
      );
    } catch {
      /* The row then draws without its title or clock. */
    }
    try {
      $.ui.invalidate('ui.render');
      const [path, cwd] = await Promise.all([progressPath($, offerId), $.session.cwd()]);
      if (path)
        timer = $.clock.every(POLL_MS, async () => {
          if (closed || polling) return;
          polling = true;
          try {
            const seen = await pollWorker($, offerId, path, cwd);
            observed ||= seen !== 'missing';
            if (stopped || (!background && !(batched && observed))) return;
            const ended = await endedNow($, offerId, seen, startedAt);
            if (ended) stop(ended);
          } catch {
            /* Display only. */
          } finally {
            polling = false;
          }
        });
    } catch {
      /* Display only. */
    }
    try {
      const current = await change($, (state) => {
        prepared = false;
        const item = state.records.find((r) => r.offerId === offerId);
        if (
          !item ||
          item.active ||
          item.nativeId ||
          state.priorStops?.some((r) => r.offerId === offerId) ||
          (state.priorStops?.length ?? 0) + state.records.filter((r) => r.active).length >= 16
        )
          return;
        item.active = true;
        // The viewer is listed under the agent that accepted, as its own subagent is.
        if (caller !== undefined) item.parentId = caller;
        else delete item.parentId;
        prepared = true;
      });
      const item = current?.records.find((r) => r.offerId === offerId);
      if (current && item && prepared)
        binding = {
          parentSessionId: current.parentSessionId,
          cwd: current.cwd,
          offerId: item.offerId,
        };
      if (current && item && prepared && liveViewerGuards.size + pendingViewerSpawns < 16) {
        // Count the pending spawn until it returns, even after classic-start tags its id.
        pendingViewerSpawns++;
        // NOT AWAITED: the worker never waits for its viewer to start.
        spawned = (async () => {
          try {
            const viewer = await $.agent.spawn({
              subagentType: TYPE,
              ...(caller !== undefined ? { parentAgentId: caller } : {}),
              description: item.description,
              prompt: VIEWER_PROMPT + ' ' + offerId + ' ' + item.description,
              cwd: current.cwd,
            });
            if (viewer.agentId) {
              const nativeId = viewer.agentId;
              if ((await $.session.id()) !== current.parentSessionId) return;
              await update($, STATE, (held) => {
                if (!held) throw new Error('Activity binding unavailable');
                if (held.parentSessionId !== current.parentSessionId) return held;
                const state = structuredClone(held);
                const r =
                  state.records.find((record) => record.offerId === offerId && record.active) ??
                  state.priorStops?.find((record) => record.offerId === offerId);
                if (r && (!r.nativeId || r.nativeId === nativeId)) r.nativeId = nativeId;
                return state;
              });
            }
          } catch {
            /* Failed observation cannot start, duplicate or cancel the real worker. */
          } finally {
            pendingViewerSpawns--;
            viewerStarted = true;
          }
        })();
      }
    } catch {
      /* All observation setup is optional. */
    }
  }
  return {
    stop,
    move: () => {
      if (timer) background = true;
      else stop();
    },
    /** A background call's worker: followed to its end, where its result is handed to the parent. */
    follow: () => {
      if (timer) background = true;
      else stop();
    },
  };
}

/** Whether a call is this plugin's own (its activity read, its viewer agent), by who raised it. */
export function raisedByThisPlugin(origin: { plugin?: string } | undefined): boolean {
  return origin?.plugin === 'tenjin';
}

export function registerModelViewer(on: On): void {
  on('agent.offer', { agent: TYPE }, () => ({ isOffered: false }));
  on('session.start', async ($, e, next) => {
    // A module the host keeps across `/clear` serves the next session too.
    sessionEnding = false;
    try {
      if (await enabled($)) await registerType($);
    } catch {
      /* Optional viewer. */
    }
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    sessionEnding = true;
    try {
      // The event names the session that closed.
      const closed = (e as { sessionId?: unknown }).sessionId;
      await endBackgroundWorkers($, typeof closed === 'string' && closed ? closed : undefined);
    } catch {
      /* The session ends as it would have. */
    }
    return next(e);
  });
  // A STEP THAT ENDED AT ITS BOUND while its worker runs: the viewer's stop is held,
  // so the next step of the same turn follows on and its agent stays listed.
  on('classic.SubagentStop', async ($, e, next) => {
    if (next.origin.plugin !== 'engine' || e.agent_type !== TYPE || !handedOver.has(e.agent_id))
      return next(e);
    try {
      const item = (await $.state.get(STATE)).value?.records.find((r) => r.nativeId === e.agent_id);
      if (item?.active) return { block: 'The DeepSeek worker is still running.' };
    } catch {
      /* The viewer ends; the worker runs on. */
    }
    handedOver.delete(e.agent_id);
    return next(e);
  });
  on('classic.SubagentStart', async ($, e, next) => {
    if (next.origin.plugin === 'engine' && e.agent_type === TYPE) {
      // Tag before any fallible host call; the native event pins this type and id.
      guardViewer(e.agent_id);
      try {
        // A listed viewer may be stopped before its first step supplies a turn id.
        await identify($, e.agent_id).catch(() => undefined);
        await change($, (state) => {
          if (state.knownIds.includes(e.agent_id)) return;
          const live = state.records.filter((r) => r.active).map((r) => r.nativeId);
          const ids = [...state.knownIds, e.agent_id];
          while (ids.length > 16) {
            const free = ids.findIndex((id) => !live.includes(id) && id !== e.agent_id);
            if (free < 0) break;
            ids.splice(free, 1);
          }
          state.knownIds = ids.slice(-16);
        });
      } catch {
        /* The native qualification must prove this mark precedes the first step. */
      }
      return next(e);
    }
    // Any other subagent: the router's hint for its task, if its call had one.
    return withDelegatedHint($, e, await next(e));
  });
  on('agent.spawn', { subagentType: TYPE }, async ($, e, next) => {
    try {
      const held = await load($);
      const matches = held?.state.records.filter(
        (r) =>
          r.active &&
          !r.nativeId &&
          r.description === e.description &&
          (e.parentAgentId === undefined || r.parentId === e.parentAgentId),
      );
      if (e.resume || next.origin.plugin !== 'tenjin' || matches?.length !== 1)
        return { deny: 'This activity viewer cannot execute or resume an assignment.' };
      return next(e);
    } catch {
      return { deny: 'DeepSeek activity viewer is unavailable.' };
    }
  }).catch(() => ({ deny: 'DeepSeek activity viewer is unavailable.' }));

  // THE ACTIVITY READ IS THE VIEWER'S OWN. A parent that polls a running worker with
  // it reads the whole activity into its context and draws a `Called
  // plugin:tenjin:router` line; a native subagent's parent does not check on it at
  // all. So the model's own call is refused. The host raises this plugin's own
  // `$.mcp.call` as a `tool.call` of the tool too, under this plugin's origin (seen
  // on 2.1.326): refused there, the viewer's first read threw, and its agent ended
  // within a second of the accept and left the agent list.
  on('tool.call', { tool: ACTIVITY }, (_$, e, next) => {
    if (raisedByThisPlugin(next.origin)) return next(e);
    return {
      deny: "This read is the Tenjin plugin's own, for the DeepSeek worker's viewer. A worker's result arrives by itself: as the result of your subagent call, or as that task's notification when the call was moved to the background. Do not check on it. If someone asks how it is doing, say it is still running and that they can open the DeepSeek agent in the agent list. To stop it, call subagent with cancel.",
    };
  });

  // A VIEWER STEP'S CALL IS ANSWERED HERE, from the worker's row, and runs nothing: an
  // answer at `tool.call` serves the tool and skips its permission check. Any other call
  // in a viewer's loop, or one this hook fails to answer, is refused at `tool.check`.
  on('tool.call', { tool: [...VIEWER_TOOLS] }, (_$, e, next) => {
    const call = e.agentId !== undefined ? viewerCalls.get(e.tool_use_id ?? '') : undefined;
    if (!call) return next(e);
    viewerCalls.delete(e.tool_use_id!);
    return answerOf(e.tool, call.row, call.input) as never;
  }).catch((_$, e, next) =>
    next.called || !viewerCalls.has(e.tool_use_id ?? '')
      ? next(e)
      : { deny: 'DeepSeek activity unavailable.' },
  );
  const refused = {
    decision: 'deny',
    reason: 'The DeepSeek activity viewer runs no tool.',
  } as const;
  on('tool.check', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const viewer =
        liveViewerGuards.has(e.agentId) || (await knownViewer($, e.agentId).catch(() => false));
      if (viewer) return refused;
    }
    // In place of the allow leg the plugin's hooks file runs for other hosts, whose run
    // the host draws as a row of its own beside the accept's.
    if (e.tool === ACCEPT && allowedAccept(e.input, raisedByThisPlugin(next.origin)))
      return { decision: 'allow', reason: 'Tenjin subagent' };
    return next(e);
  }).catch((_$, e, next) =>
    e.agentId !== undefined && liveViewerGuards.has(e.agentId) ? refused : next(e),
  );

  heldNotice.pending = undefined;
  on('tool.call', { tool: ACCEPT }, async ($, e, next) => {
    // ONLY A HELD CALL ASKS FOR AN OFFER. `capture` is this mod's own transport,
    // sent for an Agent, Task or SendMessage call it holds. Sent by the model it
    // would buy a routing decision for a call nobody made.
    if (e.capture !== undefined && next.origin.plugin !== 'tenjin')
      return {
        deny: 'Tenjin makes an offer only for an Agent, Task or SendMessage call it holds. Call that tool; never send capture yourself.',
      };
    // The end of a session is the host's word, which only this plugin relays.
    if (e.end_session !== undefined && next.origin.plugin !== 'tenjin')
      return { deny: 'Tenjin ends a session’s workers by itself when the session closes.' };
    // `reason` says the person stopped the worker's agent, or that its session ended, so
    // only this plugin sends it.
    if (e.reason !== undefined && next.origin.plugin !== 'tenjin')
      return {
        deny: 'Tenjin records why a worker stopped by itself. To stop a worker, call subagent with cancel alone.',
      };
    // The parent's accept of a held call settles it: an accepted call never counts in the
    // held line. The plugin's own read is no answer, and neither is a subagent's own call.
    if (e.capture === undefined && e.agentId === undefined && !raisedByThisPlugin(next.origin))
      settleHeld(acceptedIds(e, true) ?? []);
    // A cancelled offer is settled too: its row has nothing left to offer. A native
    // subagent's cancel of the offer it got settles it as the main loop's does.
    if (short(e.cancel) && UUID.test(e.cancel)) {
      const outcome = await next(e);
      try {
        const ref = { ...OFFERS, id: e.cancel };
        const offer = (await $.state.get(ref)).value;
        if (offer && json(outcome.text)?.status === 'cancelled')
          await $.state.set(ref, { ...offer, state: 'cancelled' });
      } catch {
        /* Display only. */
      }
      return outcome;
    }
    // Capture/cancel calls are never execution accepts. A NATIVE SUBAGENT'S ACCEPT is one:
    // its worker gets the same row, viewer and end line, the viewer under that subagent.
    // A viewer's own loop and a DeepSeek worker's process start none (neither has the tool).
    const offerIds = acceptedIds(e, true);
    if (
      !offerIds ||
      // The plugin's own read of an ended offer's stored result starts and draws nothing.
      raisedByThisPlugin(next.origin) ||
      (e.agentId !== undefined &&
        (liveViewerGuards.has(e.agentId) || (await knownViewer($, e.agentId).catch(() => true)))) ||
      (await $.env.get('TENJIN_MODEL_WORKER').catch(() => undefined)) === '1'
    )
      return next(e);
    const batched = offerIds.length > 1;
    // A repeat keeps the existing worker's observer and its clock.
    const watchers = new Map<string, Awaited<ReturnType<typeof watchAccept>>>();
    for (const id of offerIds) {
      if (!liveWorkers.has(id)) watchers.set(id, await watchAccept($, id, e.agentId, batched));
    }
    if (watchers.size && short(e.tool_use_id)) {
      acceptCalls.set(e.tool_use_id, offerIds);
      // This call runs these workers: its row's answer is theirs, whichever row draws it.
      for (const id of watchers.keys()) {
        const seen = acceptSeen.get(id);
        if (seen?.call === e.tool_use_id) seen.started = true;
        else acceptSeen.set(id, { call: e.tool_use_id, batched, started: true });
      }
    }
    let outcome: Awaited<ReturnType<typeof next>>;
    try {
      outcome = await next(e);
    } catch (error) {
      for (const watcher of watchers.values()) watcher.stop();
      throw error;
    }
    const said = typeof outcome.text === 'string' ? outcome.text : '';
    const answer = acceptResponse(said);
    if (!answer && HOST_MOVED.test(said)) {
      // The host owns this single outstanding request and its completion notice.
      // The worker displays follow their own jobs until each ends.
      for (const watcher of watchers.values()) watcher.move();
      const task = /\btask ([A-Za-z0-9_-]{1,64})\b/.exec(said)?.[1];
      if (task && watchers.size) movedTasks.set(task, offerIds);
    } else {
      const results = batched ? batchOutcomes(answer) : undefined;
      for (const [id, watcher] of watchers) {
        const own = results?.get(id) ?? answer;
        // A BACKGROUND CALL'S WORKER runs on past its accept call, which answered at once:
        // its row follows the job until it ends, as a call the host moved is followed.
        if (startedInBackground(own)) watcher.follow();
        else watcher.stop(endedFrom(own));
      }
    }
    // A background result that waited for this call to return goes out once it has.
    if (undelivered.size)
      try {
        $.clock.after(0, () => deliverLater($));
      } catch {
        /* The turn's end sends it. */
      }
    return outcome;
  });
  on('turn.step', async function* ($, e, next) {
    const loop = e.agentId ?? '';
    steps.delete(loop);
    steps.set(loop, e.turnId + ':' + e.index);
    if (steps.size > 64) steps.delete(steps.keys().next().value!);
    if (!e.agentId) return yield* next(e);
    let marked = !!liveViewerGuards.get(e.agentId);
    if (marked) guardViewer(e.agentId, e.turnId);
    try {
      marked ||= await knownViewer($, e.agentId).catch(() => false);
      if (marked) guardViewer(e.agentId, e.turnId);
      const native = (await $.agent.list()).find((a) => a.id === e.agentId);
      if (native?.type !== TYPE)
        return marked ? yield* finish(e, 'DeepSeek activity unavailable.') : yield* next(e);
      marked = true;
      guardViewer(e.agentId, e.turnId);
      const owned = await identify($, e.agentId, e.turnId);
      if (!owned || !(await enabled($)) || (owned.item.turnId && owned.item.turnId !== e.turnId))
        return yield* finish(
          e,
          'DeepSeek activity unavailable. Continue through the owned worker handle.',
        );
      handedOver.delete(e.agentId);
      let view = views.get(e.agentId);
      if (view?.offerId !== owned.item.offerId) {
        view = {
          offerId: owned.item.offerId,
          sequence: 0,
          rows: [],
          shown: new Set(),
          dropped: 0,
          holds: 0,
        };
        views.set(e.agentId, view);
        if (views.size > 16) views.delete(views.keys().next().value!);
      }
      // AFTER ITS LAST STEP the viewer says nothing more: the host may ask it again (its
      // hand-back reminder asked three times live), and a native subagent's view ends
      // with its answer. An empty step draws nothing.
      if (view.done) return yield* finish(e, '');
      return yield* viewerStep($, e, e.agentId, owned.item, view);
    } catch {
      if (marked) return yield* finish(e, 'DeepSeek activity unavailable.');
      return yield* next(e);
    }
  }).catch(async function* ($, e, next) {
    if (
      e.agentId &&
      (liveViewerGuards.has(e.agentId) || (await knownViewer($, e.agentId).catch(() => false)))
    )
      return yield* finish(e, 'DeepSeek activity unavailable.');
    return yield* next(e);
  });
  on('turn.complete', async ($, e, next) => {
    // The main loop's turn alone: a viewer's turn that ends meanwhile says nothing of it.
    if (!e.agentId) sayHeld($);
    if (!e.agentId && undelivered.size) deliverLater($);
    if (e.agentId) {
      const guard = liveViewerGuards.get(e.agentId);
      if (guard && (!guard.turnId || guard.turnId === e.turnId)) liveViewerGuards.delete(e.agentId);
    }
    if (e.agentId) {
      handedOver.delete(e.agentId);
      views.delete(e.agentId);
    }
    try {
      // ONLY A STOP OF THE AGENT CANCELS ITS WORKER: a person's from the agent list, or the
      // parent's TaskStop, as for a native subagent. An abort is also the host ending the
      // viewer's turn for its own reasons (its stall watchdog, at ten minutes), which says
      // nothing about the worker; only a stopped agent reads `killed`. How long the step
      // has run tells nothing: a person can stop the agent at any moment of it.
      if (e.agentId && e.reason === 'aborted' && !sessionEnding) {
        const agentId = e.agentId;
        // Cancellation uses the prior binding even when cwd access was revoked. This
        // grants no work/scope authority; the backend still checks its owned pending offer.
        const bound = async () => {
          const [parentSessionId, held] = await Promise.all([$.session.id(), $.state.get(STATE)]);
          const state = held.value;
          const item =
            state?.version === 1 && state.parentSessionId === parentSessionId
              ? (state.records.find((r) => r.active && r.nativeId === agentId) ??
                state.priorStops?.find((r) => r.nativeId === agentId))
              : undefined;
          return item && (!item.turnId || item.turnId === e.turnId)
            ? { offerId: item.offerId, parentSessionId }
            : undefined;
        };
        const stopped = async () =>
          (await $.agent.list()).some(
            (a) =>
              a.id === agentId &&
              a.type === TYPE &&
              a.spawnedBy === 'tenjin' &&
              (a.status === 'killed' || a.taskStatus === 'killed'),
          );
        const cancel = async (item: { offerId: string; parentSessionId: string }) => {
          const response = await $.mcp.call(SERVER, 'subagent', {
            cancel: item.offerId,
            reason: 'agent_stopped',
          });
          if (body(response)?.status !== 'cancelled') return;
          await update($, STATE, (state) => {
            if (!state) throw new Error('Activity binding unavailable');
            if (state.parentSessionId !== item.parentSessionId || !state.priorStops) return state;
            return {
              ...state,
              priorStops: state.priorStops.filter(
                (r) => !(r.offerId === item.offerId && r.nativeId === agentId),
              ),
            };
          });
        };
        const item = await bound();
        if (item && (await stopped())) await cancel(item);
        else if (item)
          // A stop may mark the agent a moment after its turn ends: read it once more.
          $.clock.after(RECHECK_MS, async () => {
            try {
              const still = await bound();
              if (still && !sessionEnding && (await stopped())) await cancel(still);
            } catch {
              /* Not a stop that can be told: the worker runs on. */
            }
          });
      }
    } catch {
      /* Failed UI cancellation is not a new execution or payment. */
    }
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { view, hasSurvey, isCollapsed, maxRows, bodyColumns } = e.props;
    if (!view.agentId || hasSurvey || isCollapsed || maxRows < 1 || bodyColumns < 1) return next(e);
    const [parentSessionId, held] = await Promise.all([$.session.id(), $.state.get(STATE)]);
    const state = held.value;
    const item =
      state?.parentSessionId === parentSessionId
        ? state.records.find((r) => r.nativeId === view.agentId && r.turnId)
        : undefined;
    if (!item) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const a = item.activity;
    const width = Math.max(1, Math.min(160, Math.floor(bodyColumns)));
    const running =
      !item.inspectionUnavailable && (a?.state === 'starting' || a?.state === 'running');
    // ONE STATUS LINE, since a subagent's view has no other place for its model,
    // counts and spend. What the worker does is the transcript's to show, not
    // this band's. While it runs, only what has settled: never a reservation
    // that reads as a price.
    const line = [
      'DeepSeek V4.1 Flash 1017',
      displayState(item),
      a?.toolUses !== undefined ? toolUses(a.toolUses) : undefined,
      a?.tokens ? tokens(a.tokens) : undefined,
      !a?.spend
        ? 'spend pending'
        : running
          ? dollars(a.spend.actualAtomic) + ' so far'
          : 'spent ' +
            dollars(a.spend.actualAtomic) +
            ' · reserved ' +
            dollars(a.spend.reservedAtomic) +
            (a.spend.uncertain.length ? ' · settlement unresolved' : ''),
    ]
      .filter((part): part is string => part !== undefined)
      .join(' · ');
    return (
      <Box flexDirection="column" width={width}>
        <Text wrap="truncate-end">{Array.from(clean(line, 640)).slice(0, width).join('')}</Text>
      </Box>
    );
  });

  // Claude Code's parallel Agent summary bypasses the tool render hooks. A
  // transcript notice identifies the held calls alongside that native summary.
  // By call: the offer it got, or none where Tenjin held it with no offer.
  const heldCalls = new Map<string, string | undefined>();
  on('tool.call', { tool: ['Agent', 'Task'] }, async ($, e, next) => {
    const answer = await next(e);
    // PostToolBatch sees model-facing text. Claude omits the agent id from
    // Explore and Plan handbacks, so identify holds before it formats them.
    const held = heldOffer(answer.deny ?? answer.result);
    if (held) {
      heldCalls.set(e.tool_use_id, held === 'unavailable' ? undefined : held.offerId.toLowerCase());
      if (heldCalls.size > 512) heldCalls.delete(heldCalls.keys().next().value!);
    }
    return answer;
  });
  on('classic.PostToolBatch', ($, e, next) => {
    if (heldCalls.size === 0) return next(e);
    const offers = new Set<string>();
    const heldOffers = new Set<string>();
    let unoffered = 0;
    let grouped = false;
    for (const tool of ['Agent', 'Task']) {
      const calls = e.tool_calls.filter((call) => call.tool_name === tool);
      const held = calls.filter((call) => heldCalls.has(call.tool_use_id));
      for (const call of held) {
        const offer = heldCalls.get(call.tool_use_id);
        heldCalls.delete(call.tool_use_id);
        if (offer) {
          offers.add(offer);
          heldOffers.add(call.tool_use_id);
        }
        // One of several Agent calls of the response: the host's block is its row.
        if (offer && calls.length > 1 && !groupedOffers.has(offer)) {
          groupedOffers.add(offer);
          if (groupedOffers.size > DRAWN_MAX)
            groupedOffers.delete(groupedOffers.values().next().value!);
          $.ui.invalidate('ui.render');
        }
      }
      unoffered += held.filter((call) => !heldOffers.has(call.tool_use_id)).length;
      grouped ||= held.length > 0 && calls.length > 1;
    }
    const pending = heldNotice.pending;
    if (grouped) {
      // Calls of an earlier response still open in this turn stay counted with these.
      heldNotice.pending = {
        offers: new Set([...(pending?.offers ?? []), ...offers]),
        unoffered: (pending?.unoffered ?? 0) + unoffered,
      };
    } else if (pending && offers.size > 0 && pending.offers.size > 0) {
      // ONE CALL OF THE SUMMARY SENT AGAIN AND HELD AGAIN (live: auto mode refused one call
      // of a response, the parent sent it again): its new offer stands in for an open one.
      pending.offers.delete(pending.offers.values().next().value!);
      for (const offer of offers) pending.offers.add(offer);
    }
    return next(e);
  });

  // Individual accepts show a live DeepSeek row. Individual held Agent calls
  // show their offer until settled, with the result available in ctrl+o.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, output, isInterrupted, isErrored } = e.props;
    // A WORKER'S CALL A ROUTER TOOL SERVED names that tool, as the router's own rows do
    // (`Exa search("q")`): in the worker nothing was replaced, Exa is what searched. Its
    // result line under the row stays the host's own.
    const via = servedCalls.get(e.props.tool_use_id);
    if (via && (tool === 'WebSearch' || tool === 'WebFetch')) {
      const given = record(input) ?? {};
      const argument =
        tool === 'WebSearch' ? '"' + String(given.query ?? '') + '"' : String(given.url ?? '');
      return workerRow($.ui.resolve(e), {
        state: e.props.isRunning ? 'running' : isErrored || isInterrupted ? 'error' : 'done',
        name: via,
        argument: clean(argument, 400),
      });
    }
    if (tool === ACCEPT) {
      const offerIds = acceptedIds(input);
      if (!offerIds) {
        // THE CALL AS THE MODEL IS STILL WRITING IT: no offer id to read yet, so the host's
        // own row would stand here for that moment as `plugin:tenjin:router - subagent`,
        // between the offer row and the DeepSeek row. Nothing is drawn until the input
        // says which call it is. A cancel, a capture and a call with an answer keep the
        // host's row. Also where the row reads as expanded: a folded run this mod unfolds
        // (the ToolGroup hook below) hands its rows down expanded, so passing those on
        // drew the host's row for that moment (live on alpha.66: `plugin:` for a split second).
        if (undecided(input) && output === undefined && !isErrored && !isInterrupted) {
          const { Box } = $.ui.resolve(e);
          return <Box display="none" />;
        }
        // A CANCEL DRAWS NOTHING OF ITS OWN, as an accept draws nothing: the worker's row
        // says `Cancelled by the parent`, and an offer nobody accepted says `cancelled` on
        // its held row. Live on alpha.80 the host's row stood under the worker's with the
        // raw `{"status":"cancelled"}`. A cancel that was refused, failed or was cut keeps
        // the host's row.
        if (
          cancelOf(input) &&
          !isErrored &&
          !isInterrupted &&
          (output === undefined || cancelAnswer(acceptResponse(textOf(output))))
        ) {
          const { Box } = $.ui.resolve(e);
          return <Box display="none" />;
        }
        return next(e);
      }
      return (
        (await acceptRows($, $.ui.resolve(e), e.surface, offerIds, e.props, e.props.isExpanded)) ??
        next(e)
      );
    }
    if (tool === 'Agent' || tool === 'Task') {
      const held = heldOffer(output);
      if (!held) return next(e);
      const offerId = held === 'unavailable' ? '' : held.offerId;
      const ui = $.ui.resolve(e);
      const full = e.props.isExpanded === true;
      if (held !== 'unavailable' && UUID.test(offerId)) {
        const [offer, worker, now] = await Promise.all([
          $.state.get({ ...OFFERS, id: offerId }),
          $.state.get({ ...WORKERS, id: offerId }),
          $.clock.now(),
        ]);
        const key = e.surface + ':' + offerId;
        const seen = acceptSeen.get(offerId);
        // ONE ROW A TASK, AND IT IS THIS ONE. An accepted offer's worker draws here, where
        // its call stood, and the accept call draws nothing for it. Shown in full
        // (ctrl+o), this row is the held call and its offer, and the accept call's row
        // is the worker's.
        if (worker.value || seen) {
          markHeldRow($, key, !full);
          if (full) return next(e);
          // In the host's summary block this row is not on the screen: the accept call's is.
          if (groupedOffers.has(offerId.toLowerCase())) return <ui.Box display="none" />;
          const row = await describeWorker(
            $,
            offerId,
            seen ?? {},
            seen?.batched ?? false,
            titleOf(record(input), 'subagent'),
          );
          if (row) return workerRow(ui, row);
        }
        // An offer kept native by its repeated call or left to expire is settled with no
        // worker: the native call's own row is the task's row, and this one draws nothing.
        else if (
          offer.value &&
          offer.value.state !== 'cancelled' &&
          (offer.value.state !== 'offered' || now - offer.value.at > OFFER_MS)
        ) {
          if (full) return next(e);
          return <ui.Box display="none" />;
        } else {
          markHeldRow($, key, !full);
          // A CANCELLED OFFER NOBODY ACCEPTED keeps this row, which says so: the cancel
          // call draws nothing, and no native call follows a cancel.
          if (offer.value?.state === 'cancelled')
            return workerRow(ui, {
              state: 'held',
              name: tool,
              struck: true,
              argument: titleOf(record(input), 'subagent'),
              tail: ' · Tenjin offered DeepSeek · cancelled',
            });
        }
      }
      // THE OFFER, as the tool router marks a held `Web Search` row: the native name
      // struck through, and what Tenjin offered in its place.
      return workerRow(ui, {
        state: 'held',
        name: tool,
        struck: held !== 'unavailable',
        argument: titleOf(record(input), 'subagent'),
        tail:
          held === 'unavailable'
            ? ' · Tenjin held it · not started'
            : ' · Tenjin offered DeepSeek' +
              (held.capAtomic ? ' · cap ' + dollars(held.capAtomic) : ''),
      });
    }
    return next(e);
  });
  // A standalone batch owns one compact group. Ctrl+O draws ToolUse and
  // ToolResult directly, so its individual rows can expand without render state.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded) return next(e);
    const [call] = e.props.calls;
    if (e.props.isCallsOnly !== false && e.props.calls.length === 1 && call?.tool === ACCEPT) {
      const ids = acceptedIds(call.input);
      if (ids && ids.length > 1) {
        const batch = await acceptRows($, $.ui.resolve(e), e.surface, ids, call, false);
        if (batch !== undefined) return batch;
      }
    }
    // Other accepts in a folded run keep the engine's individual rows.
    const accepts = e.props.calls.some(
      (call) =>
        call.tool === ACCEPT &&
        (acceptedIds(call.input) || undecided(call.input) || cancelOf(call.input)),
    );
    return next(accepts ? { ...e, props: { ...e.props, isExpanded: true } } : e);
  });
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { tool, output, isExpanded } = e.props;
    if (isExpanded === true) return next(e);
    // The host's notice for a call it moved to the background names the server and
    // the tool: the row above already says the worker runs on.
    const said = textOf(output);
    const answer = tool === ACCEPT ? acceptResponse(said) : undefined;
    const ours =
      tool === ACCEPT
        ? acceptAnswer(answer) ||
          !!batchOutcomes(answer) ||
          HOST_MOVED.test(said ?? '') ||
          // Only a cancel that took answers with its status alone.
          cancelAnswer(answer)
        : (tool === 'Agent' || tool === 'Task') && heldOffer(output) !== undefined;
    if (!ours) return next(e);
    const { Box } = $.ui.resolve(e);
    return <Box display="none" />;
  });
  // Its first message is the worker's real assignment, as a native subagent's
  // is the prompt its parent sent. The drawing alone: the viewer agent was told
  // only the short line above, and nothing is sent to its model.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const told = e.props.text.trim();
    // THE END OF A WORKER WHOSE ACCEPT CALL THE HOST MOVED TO THE BACKGROUND comes as
    // that task's notification, which names the server and the tool. It reads as a
    // native subagent's does: who finished, and its counts.
    const task = e.props.task;
    const moved =
      (task?.toolUseId !== undefined ? acceptCalls.get(task.toolUseId) : undefined) ??
      (task?.id !== undefined ? movedTasks.get(task.id) : undefined) ??
      movedTasks.get(/^MCP task (\S+) \(/.exec(told)?.[1] ?? '');
    if (moved !== undefined && moved.length > 1) {
      // Completing the host task says nothing about how any one worker ended.
      const workers = await Promise.all(
        moved.map(async (id) => (await $.state.get({ ...WORKERS, id })).value),
      );
      if (workers.every((worker) => worker === undefined)) return next(e);
      const statuses = workers.map((worker) => worker?.ended);
      const finished = statuses.filter((status) => status === 'completed').length;
      const unconfirmed = statuses.filter(
        (status) => !status || status === 'unseen' || status === 'unknown',
      ).length;
      const other = moved.length - finished - unconfirmed;
      const summary = [
        finished ? finished + ' finished' : undefined,
        other ? other + ' ended without completing' : undefined,
        unconfirmed ? unconfirmed + ' unconfirmed' : undefined,
      ]
        .filter(Boolean)
        .join(' · ');
      if (e.props.isExpanded)
        return next({ ...e, props: { ...e.props, text: 'DeepSeek workers · ' + summary } });
      const { Box, Text } = $.ui.resolve(e);
      return (
        <Box marginTop={1}>
          <Text dimColor>{'› Message from @DeepSeek (ctrl+o to expand)'}</Text>
        </Box>
      );
    }
    if (moved?.[0] !== undefined) {
      const live = (await $.state.get({ ...WORKERS, id: moved[0] })).value;
      if (!live) return next(e);
      const how =
        live.ended === 'unseen'
          ? undefined
          : (live.ended ?? (task?.status === 'completed' ? 'completed' : undefined));
      const text =
        'DeepSeek "' +
        live.title +
        '" ' +
        (how === 'completed'
          ? 'finished'
          : how === 'not_started'
            ? 'did not start'
            : how === undefined || endedByOf(live.endedBy)
              ? 'ended'
              : how === 'cancelled'
                ? 'was interrupted'
                : 'stopped') +
        (live.ended ? ' · ' + endingText(workerEnding(live)) : '');
      // AS A NATIVE SUBAGENT'S RETURN READS in the compact view: one dim line naming the
      // sender. The row's sender (`from`) is the host's alone to set, so the line is
      // drawn here; in full (ctrl+o) the row says who finished and its counts.
      if (e.props.isExpanded) return next({ ...e, props: { ...e.props, text } });
      const { Box, Text } = $.ui.resolve(e);
      return (
        <Box marginTop={1}>
          <Text dimColor>{'› Message from @DeepSeek (ctrl+o to expand)'}</Text>
        </Box>
      );
    }
    // A background worker's result, handed over by this plugin: one dim line naming the
    // sender in the compact view, as the notice of a moved call reads; in full, as sent.
    if (!task && BACKGROUND_ROW.test(told)) {
      if (e.props.isExpanded) return next(e);
      const { Box, Text } = $.ui.resolve(e);
      return (
        <Box marginTop={1}>
          <Text dimColor>{'› Message from @DeepSeek (ctrl+o to expand)'}</Text>
        </Box>
      );
    }
    if (!told.startsWith(VIEWER_PROMPT + ' ')) return next(e);
    // `<offer id> <description>`, as the viewer was told.
    const [, offerId, description = ''] =
      /^(\S{36}) ([\s\S]*)$/.exec(told.slice(VIEWER_PROMPT.length + 1)) ?? [];
    if (!offerId) return next(e);
    const item = (await $.state.get(STATE)).value?.records.find((r) => r.offerId === offerId);
    const assignment = item
      ? (await $.state.get({ ...ASSIGNMENTS, id: item.offerId })).value
      : undefined;
    // After a restart the prompt is no longer held: say whose viewer this is.
    const text =
      assignment || 'DeepSeek worker for: ' + description.replace(/^DeepSeek #\d+ · /, '');
    return next({ ...e, props: { ...e.props, text } });
  });
  // THE VIEWER'S ROW IN THE AGENT LIST reads as the worker's: `DeepSeek` where a native
  // row names its agent type, then the host's own words for the task (its progress
  // summary, else the description) and the worker's counts. The `tenjin:` type itself
  // is the host's to name; the row's body is the one part a plugin draws.
  on('ui.render', { component: 'AgentRow' }, async ($, e, next) => {
    if (e.props.type !== TYPE) return next(e);
    const item = (await $.state.get(STATE)).value?.records.find((r) => r.nativeId === e.props.id);
    const live = item ? (await $.state.get({ ...WORKERS, id: item.offerId })).value : undefined;
    const counts = [
      live?.toolUses ? toolUses(live.toolUses) : undefined,
      live?.tokens ? tokens(live.tokens) : undefined,
      live?.elapsedMs !== undefined ? duration(live.elapsedMs) : undefined,
    ].filter((part): part is string => part !== undefined);
    const task = clean(e.props.label.split('\n')[0] ?? '', 200) || clean(e.props.description, 200);
    return next({ ...e, props: { ...e.props, body: ['DeepSeek ' + task, ...counts].join(' · ') } });
  });
}

/**
 * The viewer's last step after the worker ended: what is left of its rows, its answer
 * as the parent received it (in place of its last reply's shortened text), and the end
 * line with the job's own word, counts and time.
 */
async function endOf(
  $: Dollar,
  item: TenjinModelViewerRecord,
  view: View,
  cwd: string,
): Promise<string> {
  const ended = view.ended ?? {};
  const answer = typeof ended.answer === 'string' ? ended.answer : undefined;
  const rows = view.rows.splice(0).filter((row) => !answer || row.kind !== 'text');
  const said = blocksOf(rows, cwd, view).flatMap((block) => ('text' in block ? [block.text] : []));
  const [live, now] = await Promise.all([
    $.state.get({ ...WORKERS, id: item.offerId }),
    $.clock.now(),
  ]);
  // The job's own time when the CLI gives it; otherwise the time since the accept.
  const elapsedMs = Number.isSafeInteger(ended.elapsedMs)
    ? ended.elapsedMs
    : live.value
      ? Math.max(0, now - live.value.startedAt)
      : undefined;
  const counts = doneParts(
    { ...ended, ...(elapsedMs !== undefined ? { elapsedMs } : {}) },
    live.value,
  ).join(' · ');
  const state = ended.state ?? (ended.status === 'stopped' ? 'unknown' : ended.status);
  const started = ended.started ?? ended.status !== 'not_started';
  const end =
    state === 'completed'
      ? 'Done (' + counts + ')'
      : started === false
        ? endingOf({ state, started })
        : stopWord(state, ended.endedBy) + ' (' + counts + ')\n' + endingOf({ state, started });
  return [...said, ...(answer ? [answer] : []), end].join('\n\n');
}
/** How the viewer's transcript ends: what happened to the worker, never a run that did not happen. */
function endingOf(activity: Json): string {
  if (activity.started === false)
    return activity.state === 'cancelled'
      ? 'Not started: the start was interrupted, so no work ran.'
      : 'Not started: Claude Code did not start, so no work ran. The parent keeps this task native.';
  return activity.state === 'cancelled'
    ? 'Interrupted: the worker was stopped before it finished. What it had done is returned to the parent.'
    : 'Stopped: the worker ended before it finished. What it had done is returned to the parent.';
}

type Elements = ReturnType<Dollar['ui']['resolve']>;
type WorkerRow = {
  state: 'running' | 'done' | 'error' | 'held';
  name: string;
  /** The native call's name, struck through: an offer stands in its place. */
  struck?: boolean;
  argument?: string;
  starting?: boolean;
  tail?: string;
  under?: string;
  ending?: WorkerEnding;
};
/**
 * One worker's row, from the accept call that runs it (its answer, once it has one)
 * and the worker's own record. Undefined for an answered call that says nothing of a
 * worker and has none: that call keeps the engine's row.
 */
async function describeWorker(
  $: Dollar,
  offerId: string,
  { output, isInterrupted, isErrored }: AcceptCall,
  batched: boolean,
  described?: string,
): Promise<WorkerRow | undefined> {
  const said = textOf(output);
  const answer = acceptResponse(said);
  const ended = (batched ? batchOutcomes(answer)?.get(offerId) : undefined) ?? answer;
  const [held, known, offer] = await Promise.all([
    $.state.get({ ...WORKERS, id: offerId }),
    $.state.get(STATE),
    $.state.get({ ...OFFERS, id: offerId }),
  ]);
  const live = held.value;
  // Before the accept hook has run (the host is still checking the call), the offer's
  // own record names the task; after a resume, the held call's own description does.
  const title =
    live?.title ??
    known.value?.records.find((r) => r.offerId === offerId)?.title ??
    described ??
    'subagent';
  const head = { name: 'DeepSeek', argument: title };
  const status = ended?.status;
  if (
    status === 'completed' ||
    status === 'cancelled' ||
    status === 'unknown' ||
    status === 'stopped'
  ) {
    const word = status === 'completed' ? 'Done' : stopWord(status, ended!.endedBy);
    return {
      ...head,
      state: status === 'completed' ? 'done' : 'error',
      ending: { word, parts: doneParts(ended!, live) },
    };
  }
  // Nothing ran, and the answer says so: a start that never finished, or a refused accept.
  if (status === 'not_started' || typeof ended?.action === 'string')
    return {
      ...head,
      state: isErrored || status === 'not_started' ? 'error' : 'held',
      ending: {
        word: 'Not started',
        parts: typeof ended?.elapsedMs === 'number' ? [duration(ended.elapsedMs)] : [],
      },
    };
  // NOT THE WORKER'S ANSWER: nothing yet, an Esc, or the host's own notice
  // for a call it moved to the background after two minutes. The worker's
  // record says where it stands; a missing answer never reads as an end.
  if (live?.ended)
    return {
      ...head,
      state: live.ended === 'completed' ? 'done' : live.ended === 'unseen' ? 'held' : 'error',
      ending: workerEnding(live),
    };
  if (isInterrupted)
    return {
      ...head,
      state: 'error',
      ending: {
        word: 'Interrupted',
        parts: live?.elapsedMs !== undefined ? [duration(live.elapsedMs)] : [],
      },
    };
  // A BACKGROUND WORKER'S ROW READS AS A NATIVE BACKGROUND AGENT'S while it runs: one
  // still line, its progress in the agent list. Its end line follows when it has ended,
  // and its result arrives as a message of its own.
  if (startedInBackground(ended) || (live && offer.value?.background)) {
    // After a reload or a resume nothing here follows it: the CLI is asked how it stands.
    if (!liveWorkers.has(offerId)) adopt($, offerId, title);
    return { ...head, state: 'running', under: 'Backgrounded agent (↓ to manage)' };
  }
  const moved = output !== undefined && HOST_MOVED.test(said ?? '');
  if (output !== undefined && !live && !moved) return undefined;
  // A running row nothing here follows, after a reload or a resume: the CLI is asked.
  if ((live || moved) && !liveWorkers.has(offerId)) adopt($, offerId, title);
  // From the moment of accept: Claude Code is still starting until the first tick says more.
  const starting = live ? live.state !== 'running' : !moved;
  const parts = [
    !live && moved ? 'running in the background' : undefined,
    live?.toolUses ? toolUses(live.toolUses) : undefined,
    live?.tokens ? tokens(live.tokens) : undefined,
    live?.elapsedMs !== undefined ? duration(live.elapsedMs) : undefined,
    live?.spentAtomic ? dollars(live.spentAtomic) + ' so far' : undefined,
  ].filter((part): part is string => part !== undefined);
  return {
    ...head,
    state: 'running',
    starting,
    ...(parts.length ? { tail: ' · ' + parts.join(' · ') } : {}),
    ...(starting || !live ? {} : { under: live.current ?? 'Working' }),
  };
}
/**
 * WHAT AN ACCEPT CALL DRAWS: the workers whose held Agent row is not there to draw
 * them (see `heldRows`), as one row or one group. Nothing where each of its workers
 * draws on its own held row: the accept adds no row of its own, as the request call
 * that took a held `Web Search` draws none.
 */
async function acceptRows(
  $: Dollar,
  ui: Elements,
  surface: string,
  offerIds: string[],
  call: AcceptCall & { tool_use_id?: string },
  isExpanded?: boolean,
) {
  noteAccept($, call.tool_use_id, offerIds, call);
  const batched = offerIds.length > 1;
  const described = await Promise.all(
    offerIds.map((offerId) => describeWorker($, offerId, call, batched)),
  );
  if (described.some((row) => row === undefined)) return undefined;
  const { Box } = ui;
  const kept = offerIds.flatMap((offerId, index) =>
    inPlace(surface, offerId) ? [] : [{ offerId, row: described[index]! }],
  );
  if (kept.length === 0) return <Box display="none" />;
  const rows = kept.map((item) => item.row);
  if (rows.length === 1) return workerRow(ui, rows[0]!);
  const ids = kept.map((item) => item.offerId);
  if (!isExpanded) return workerGroup(ui, rows, ids);
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => (
        <Box key={ids[index]}>{workerRow(ui, row)}</Box>
      ))}
    </Box>
  );
}
/** A tool row as the engine draws one: the dot, the name bold, the input in
 *  parentheses, a dim tail, and one dim line under it. */
function workerRow({ Box, Text }: Elements, row: WorkerRow) {
  const dot =
    row.state === 'done'
      ? { color: 'success' }
      : row.state === 'error'
        ? { color: 'error' }
        : { dimColor: true };
  const head = (
    <Box key="head" flexDirection="row">
      <Box minWidth={2}>
        <Text {...dot}>⏺</Text>
      </Box>
      <Box flexShrink={0}>
        <Text bold strikethrough={row.struck === true} wrap="truncate-end">
          {row.name}
        </Text>
      </Box>
      <Box flexWrap="nowrap">
        <Text wrap="truncate-end">
          {row.argument !== undefined ? '(' + row.argument + ')' : ''}
        </Text>
        <Text dimColor>{(row.starting ? ' · starting' : '') + (row.tail ?? '')}</Text>
      </Box>
    </Box>
  );
  const detail = row.ending ? endingText(row.ending) : row.under;
  const under =
    detail === undefined
      ? []
      : [
          <Box key="under" flexDirection="row">
            <Text dimColor>{'  ⎿  '}</Text>
            <Text dimColor wrap="truncate-end">
              {clean(detail, 400)}
            </Text>
          </Box>,
        ];
  return (
    <Box flexDirection="column" marginTop={1}>
      {[head, ...under]}
    </Box>
  );
}
/** A compact batch keeps the live state of every accepted worker visible. */
function workerGroup({ Box, Text }: Elements, rows: WorkerRow[], offerIds: string[]) {
  const finished = rows.filter((row) => row.state === 'done').length;
  const running = rows.some((row) => row.state === 'running');
  const allFinished = finished === rows.length;
  const summary = running
    ? `Running ${rows.length} DeepSeek agents…`
    : allFinished
      ? `${rows.length} DeepSeek agents finished`
      : `${finished} of ${rows.length} DeepSeek agents finished`;
  const dot = running ? { dimColor: true } : { color: allFinished ? 'success' : 'error' };
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text {...dot}>⏺</Text>
        </Box>
        <Text>{summary}</Text>
      </Box>
      {rows.map((row, index) => {
        const last = index === rows.length - 1;
        const detail =
          row.ending?.word ?? row.under ?? (row.starting ? 'Initializing…' : undefined);
        const tail = row.ending?.parts.length ? ' · ' + row.ending.parts.join(' · ') : row.tail;
        return (
          <Box key={offerIds[index]} flexDirection="column">
            <Box flexDirection="row">
              <Text dimColor>{last ? '  └ ' : '  ├ '}</Text>
              <Text bold wrap="truncate-end">
                {row.argument ?? row.name}
              </Text>
              <Text dimColor wrap="truncate-end">
                {tail ?? ''}
              </Text>
            </Box>
            {detail !== undefined ? (
              <Box flexDirection="row">
                <Text dimColor>{last ? '    ⎿  ' : '  │ ⎿  '}</Text>
                <Text dimColor wrap="truncate-end">
                  {clean(detail, 400)}
                </Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

/** An accept call's own answer, which its live row already says: a worker
 *  handback (it carries `elapsedMs`) or a refusal to start one. A cancel's
 *  short status is not one, and keeps the engine's result block. */
function acceptAnswer(answer: Json | undefined): boolean {
  return (
    typeof answer?.elapsedMs === 'number' ||
    typeof answer?.action === 'string' ||
    startedInBackground(answer)
  );
}
/** An accept call's answer for a background call: its worker started and runs on (`model-mcp.ts`). */
function startedInBackground(answer: Json | undefined): boolean {
  return answer?.status === 'started' && answer.background === true;
}
/** The `Done (…)` line's counts, from the handback, as a native subagent's: uses, tokens, time, then spend. */
function doneParts(ended: Json, live: TenjinModelWorker | undefined): string[] {
  const count = (value: unknown) =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
  const uses = count(ended.toolUses) ?? live?.toolUses ?? 0;
  const used = count(ended.tokens) ?? live?.tokens;
  const elapsed = count(ended.elapsedMs);
  const spend = record(ended.spend);
  const actual =
    typeof spend?.actualAtomic === 'string' && /^\d{1,30}$/.test(spend.actualAtomic)
      ? spend.actualAtomic
      : undefined;
  const unresolved = Array.isArray(spend?.uncertain) && spend.uncertain.length > 0;
  return [
    toolUses(uses),
    ...(used !== undefined ? [tokens(used)] : []),
    ...(elapsed !== undefined ? [duration(elapsed)] : []),
    ...(actual !== undefined
      ? [dollars(actual) + (unresolved ? ' · settlement unresolved' : '')]
      : spend?.accounting === 'unknown'
        ? ['spend unknown']
        : []),
  ];
}
/**
 * A held Agent call, as the local hook answered it (`register.tsx`): refused with an
 * offer, whose id and cap are read from the refusal's text, or held and not started.
 * Told by the text's first line.
 */
function heldOffer(
  output: unknown,
): { offerId: string; capAtomic?: string } | 'unavailable' | undefined {
  const capOf = (offer: Json | undefined): { capAtomic?: string } => {
    const cap = offer?.capAtomic;
    return typeof cap === 'string' && /^[1-9][0-9]{0,29}$/.test(cap) ? { capAtomic: cap } : {};
  };
  // The refusal, as the row holds it: its text, bare or inside the host's own wrapping.
  const said =
    typeof output === 'string'
      ? output
      : (textOf(output) ??
        [record(output)?.text, record(output)?.error, record(output)?.message].find(
          (text): text is string => typeof text === 'string',
        ));
  if (said) {
    const at = said.indexOf(HELD_WITH_OFFER + ' (offer ');
    if (at >= 0) {
      const offerId = said.slice(at + HELD_WITH_OFFER.length + 8, at + HELD_WITH_OFFER.length + 44);
      if (!UUID.test(offerId)) return undefined;
      // The offer is the text's last line, as the CLI wrote it.
      const from = said.indexOf('\n{', at);
      return { offerId, ...capOf(from < 0 ? undefined : json(said.slice(from + 1).trim())) };
    }
    if (said.includes(HELD_NOT_STARTED)) return 'unavailable';
  }
  return undefined;
}
