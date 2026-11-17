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
  tenjinDataDir,
  textOf,
} from './hook-data';
import type {
  TenjinModelActivity,
  TenjinModelTranscript,
  TenjinModelViewerRecord,
  TenjinModelViewerState,
  TenjinModelWorker,
} from '../types';

// Source candidate: the production native ordering, permissions and Remote Control gate is separate.
const TYPE = 'tenjin:deepseek-viewer';
const ACCEPT = 'mcp__plugin_tenjin_router__subagent';
const ACTIVITY = 'mcp__plugin_tenjin_router__subagent_activity';
const SERVER = 'plugin:tenjin:router';
const STATE = { plugin: 'tenjin', key: 'modelViewers' } as const;
const WORKERS = { plugin: 'tenjin', key: 'modelWorkers' } as const;
const TRANSCRIPTS = { plugin: 'tenjin', key: 'modelTranscripts' } as const;
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
 * What the viewer agent is told. Its record's description follows, so the
 * transcript's first message can be drawn as the worker's real assignment.
 */
const VIEWER_PROMPT = 'Observe only the already owned DeepSeek worker activity.';
/** A run's rows in memory, until its viewer has written them into its transcript. */
const TRANSCRIPT_ROWS = 2000;
const TRANSCRIPT_CHARS = 512 * 1024;
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
 * How long one viewer step follows the worker, so it ends by itself (by one 25 s
 * read more at most) well before Claude Code ends it: the host aborts a background
 * agent that shows no progress for ten minutes (its stall watchdog, 2.1.326). The
 * viewer's stop is then held while the worker runs, and the next step follows on.
 */
const STEP_MS = 5 * 60_000;
/**
 * Steps one viewer turn may take: 45 minutes, past the job's 40-minute wall time.
 * Claude Code ends a turn whose stop was held more than 8 times in a row.
 */
const MAX_STEPS = 9;
/** Viewer agents whose step ended at its bound, for their stop to be held once. */
const handedOver = new Set<string>();
/** An aborted viewer turn's agent is read again once, after this, in case its stop lands late. */
const RECHECK_MS = 1500;
/** Set once the session ends: what ends with it is not a person stopping an agent. */
let sessionEnding = false;
/**
 * Workers whose rows this module follows: an accept call in flight, or one it
 * took up again after a reload. A reload forgets them; a row then drawn as
 * running asks the CLI how its job stands (`adopt`).
 */
const liveWorkers = new Set<string>();
/** Rows taken up again in this module's life, each once. */
const adopted = new Set<string>();
/**
 * Each running worker's rows, by offer id. A viewer's turn is one long hook
 * call, and its state reads all stand at the moment it began, so the rows the
 * timer adds are shared here; the state copy is what the live drawing reads.
 */
const runs = new Map<string, TenjinModelTranscript>();
/**
 * What the host answers an accept call it moved to the background: a tool call
 * still running after two minutes becomes a task of the session, and the
 * parent reads this notice in place of the worker's answer until the task ends.
 */
const HOST_MOVED = /still running after[\s\S]{0,80}moved to the background/;
/** Those tasks, by the id the notice names, so the task's own lines can name their worker. */
const movedTasks = new Map<string, string>();
/** Accept calls by their tool use id, for the same. */
const acceptCalls = new Map<string, string>();
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
function json(value: unknown): Json | undefined {
  if (typeof value !== 'string' || value.length > 300_000) return undefined;
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
    const same =
      old?.version === 1 && old.parentSessionId === owner.parentSessionId && old.cwd === owner.cwd;
    const state: TenjinModelViewerState = same
      ? structuredClone(old)
      : { version: 1, ...owner, serial: old?.serial ?? 0, records: [], knownIds: [] };
    edit(state);
    return state;
  });
}
async function retireViewer($: Dollar, binding: ViewerBinding): Promise<void> {
  const [parentSessionId, held] = await Promise.all([$.session.id(), $.state.get(STATE)]);
  const previous = held.value;
  const item = previous?.records.find((r) => r.offerId === binding.offerId);
  if (
    !previous ||
    !item ||
    parentSessionId !== binding.parentSessionId ||
    previous.parentSessionId !== binding.parentSessionId ||
    previous.cwd !== binding.cwd
  )
    return;
  const nativeId = item.nativeId;
  // Display retirement uses the accepted binding, not current filesystem access.
  await update($, STATE, (current) => {
    if (!current) throw new Error('Activity binding unavailable');
    if (current.parentSessionId !== binding.parentSessionId || current.cwd !== binding.cwd)
      return current;
    const state = structuredClone(current);
    const owned = state.records.find(
      (r) => r.offerId === binding.offerId && r.nativeId === nativeId,
    );
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
    tools: [],
    // Every step is the plugin's own made-up response; a held stop continues the turn
    // only up to this bound. Worker limits are independent.
    maxTurns: MAX_STEPS + 1,
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
      state.records.push({
        offerId,
        ordinal,
        profile,
        title,
        description: 'DeepSeek #' + ordinal + ' · ' + title,
        active: false,
      });
    });
    if (current) {
      await $.store.set(SERIAL, Math.max(await serial($), current.serial));
      // An Agent call's prompt, or a follow-up's message to its worker.
      const assignment = [nativeInput.prompt, nativeInput.message].find(
        (text): text is string => typeof text === 'string' && text.trim().length > 0,
      );
      if (assignment && current.records.some((r) => r.offerId === offerId))
        await $.state.set({ ...ASSIGNMENTS, id: offerId }, plain(assignment, ASSIGNMENT_CHARS));
      await $.state.set({ ...OFFERS, id: offerId }, { at: await $.clock.now(), state: 'offered' });
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
        kind: r.kind as TenjinModelActivity['rows'][number]['kind'],
        state: String(r.state),
        ...(typeof r.name === 'string' ? { name: clean(r.name, 120) } : {}),
        ...(typeof r.text === 'string' ? { text: clean(r.text) } : {}),
        ...(typeof r.inputSummary === 'string' ? { inputSummary: clean(r.inputSummary) } : {}),
        ...(typeof r.command === 'string' ? { command: clean(r.command, 1024) } : {}),
        ...(typeof r.outputPreview === 'string' ? { outputPreview: clean(r.outputPreview) } : {}),
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

function rowChars(row: TenjinModelActivity['rows'][number]): number {
  return (
    64 +
    (row.text?.length ?? 0) +
    (row.inputSummary?.length ?? 0) +
    (row.command?.length ?? 0) +
    (row.outputPreview?.length ?? 0)
  );
}
/**
 * Adds what the CLI reports now to the run's rows. The CLI shows a window of
 * its latest rows; a row is kept here by its id as it changes, so the viewer's
 * transcript holds the whole run, inside the bound above.
 */
async function addRows(
  $: Dollar,
  offerId: string,
  activity: TenjinModelActivity,
): Promise<TenjinModelTranscript> {
  const held = runs.get(offerId);
  if (held && held.sequence >= activity.sequence) return held;
  const rows = [...(held?.rows ?? [])];
  const at = new Map(rows.map((row, index) => [row.id, index]));
  for (const row of activity.rows) {
    const index = at.get(row.id);
    if (index !== undefined) rows[index] = row;
    else {
      at.set(row.id, rows.length);
      rows.push(row);
    }
  }
  let dropped = held?.dropped ?? 0;
  let chars = rows.reduce((sum, row) => sum + rowChars(row), 0);
  while (rows.length > TRANSCRIPT_ROWS || chars > TRANSCRIPT_CHARS) {
    chars -= rowChars(rows.shift()!);
    dropped++;
  }
  const next: TenjinModelTranscript = { sequence: activity.sequence, dropped, rows };
  runs.set(offerId, next);
  await $.state.set({ ...TRANSCRIPTS, id: offerId }, next);
  return next;
}
type TranscriptLine = { kind: 'call' | 'under' | 'text' | 'note'; text: string };
/**
 * A run as a native subagent's transcript reads: each tool call as
 * `Read(src/a.ts)` or `Bash(pnpm lint)`, a refused or failed call's reason
 * under it, and the worker's own text between calls.
 */
function transcriptLines(rows: TenjinModelActivity['rows'], cwd: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const row of rows) {
    if (row.kind === 'tool') {
      const target = row.command ? clean(row.command, 240) : targetOf(row.inputSummary, cwd);
      lines.push({ kind: 'call', text: (row.name ?? 'Tool') + (target ? '(' + target + ')' : '') });
      if (row.state === 'error' && row.outputPreview)
        lines.push({ kind: 'under', text: clean(row.outputPreview, 400) });
      else if (row.state === 'cancelled') lines.push({ kind: 'under', text: 'Interrupted' });
    } else if (row.kind === 'text') {
      if (row.text) lines.push({ kind: 'text', text: row.text });
    } else if (row.text) lines.push({ kind: 'note', text: row.text });
  }
  return lines;
}
const LINE_MARK = { call: '⏺ ', under: '  ⎿  ', note: '· ', text: '' } as const;
/** The run as the text the viewer's transcript keeps: rows verbatim, the worker's text as it wrote it. */
function writtenLines(lines: TranscriptLine[], dropped: number): string {
  let out = dropped ? dropped + ' earlier events omitted\n' : '';
  let fenced = false;
  const fence = (open: boolean) => {
    if (open !== fenced) out += '```\n';
    fenced = open;
  };
  for (const line of lines) {
    fence(line.kind !== 'text');
    out +=
      line.kind === 'text'
        ? '\n' + line.text + '\n\n'
        : LINE_MARK[line.kind] + line.text.replaceAll('```', "'''") + '\n';
  }
  fence(false);
  return out;
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
  await addRows($, offerId, activity);
  await showActivity($, activity);
  return activity;
}
/** How a worker ended, from the accept call's own answer; undefined when the answer is not one. */
function endedFrom(answer: Json | undefined): Partial<TenjinModelWorker> | undefined {
  const status = answer?.status;
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
      await addRows($, offerId, last);
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
  worker_error: 'Stopped',
};
function endedByOf(code: unknown): code is string {
  return typeof code === 'string' && Object.hasOwn(ENDED_BY, code);
}
/** The end word of a worker that did not complete; an older CLI sends no code. */
function stopWord(status: unknown, endedBy: unknown): string {
  if (endedByOf(endedBy)) return ENDED_BY[endedBy]!;
  return status === 'cancelled' ? 'Interrupted' : 'Stopped';
}
/** An ended worker's line, as a native subagent's: `Done (12 tool uses · 41.2k tokens · 2m 13s · $0.039)`. */
function endLine(live: TenjinModelWorker): string {
  const time = live.elapsedMs !== undefined ? [duration(live.elapsedMs)] : [];
  if (live.ended === 'not_started') return 'Not started' + time.map((t) => ' (' + t + ')').join('');
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
  return word + (parts.length ? ' (' + parts.join(' · ') + ')' : '');
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
        r.parentId === native.parentId &&
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
    (state.knownIds.includes(agentId) || state.records.some((r) => r.nativeId === agentId))
  );
}
async function* finish(
  e: TurnStepInput,
  answer: string,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  yield { kind: 'text', index: 0, text: answer };
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
  return !['offer_id', 'cancel', 'capture', 'delegation_id', 'task'].some(
    (key) => given[key] !== undefined,
  );
}

/** Whether a call of the activity read is this plugin's own, by who raised it. */
export function ownActivityRead(origin: { plugin?: string } | undefined): boolean {
  return origin?.plugin === 'tenjin';
}

export function registerModelViewer(on: On): void {
  on('agent.offer', { agent: TYPE }, () => ({ isOffered: false }));
  on('session.start', async ($, e, next) => {
    try {
      if (await enabled($)) await registerType($);
    } catch {
      /* Optional viewer. */
    }
    return next(e);
  });
  on('session.end', (_$, e, next) => {
    sessionEnding = true;
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
    }
    return next(e);
  });
  on('agent.spawn', { subagentType: TYPE }, async ($, e, next) => {
    try {
      const held = await load($);
      const matches = held?.state.records.filter(
        (r) =>
          r.active &&
          !r.nativeId &&
          r.description === e.description &&
          r.parentId === e.parentAgentId,
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
    if (ownActivityRead(next.origin)) return next(e);
    return {
      deny: "This read is the Tenjin plugin's own, for the DeepSeek worker's viewer. A worker's result arrives by itself: as the result of your subagent call, or as that task's notification when the call was moved to the background. Do not check on it. If someone asks how it is doing, say it is still running and that they can open the DeepSeek agent in the agent list. To stop it, call subagent with cancel.",
    };
  });

  on('tool.call', { tool: ACCEPT }, async ($, e, next) => {
    // ONLY A HELD CALL ASKS FOR AN OFFER. `capture` is this mod's own transport,
    // sent for an Agent, Task or SendMessage call it holds. Sent by the model it
    // would buy a routing decision for a call nobody made.
    if (e.capture !== undefined && next.origin.plugin !== 'tenjin')
      return {
        deny: 'Tenjin makes an offer only for an Agent, Task or SendMessage call it holds. Call that tool; never send capture yourself.',
      };
    // `reason` says the person stopped the worker's agent, so only this plugin sends it.
    if (e.reason !== undefined && next.origin.plugin !== 'tenjin')
      return {
        deny: 'Tenjin records why a worker stopped by itself. To stop a worker, call subagent with cancel alone.',
      };
    // A cancelled offer is settled too: its row has nothing left to offer.
    if (e.agentId === undefined && short(e.cancel) && UUID.test(e.cancel)) {
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
    // Capture/cancel calls and deterministic viewer calls are never execution accepts.
    if (
      e.agentId !== undefined ||
      !short(e.offer_id) ||
      !UUID.test(e.offer_id) ||
      Object.keys(e).some(
        (key) => !['tool', 'tool_use_id', 'agentId', 'requestMeta', 'offer_id'].includes(key),
      )
    )
      return next(e);
    const offerId = e.offer_id;
    // An accept sent again while its worker runs starts nothing: the row that is
    // already live keeps its clock and counts, and ends when that worker does.
    if (liveWorkers.has(offerId)) return next(e);
    let timer: { cancel(): void } | undefined;
    let binding: ViewerBinding | undefined;
    let spawned: Promise<void> | undefined;
    let polling = false,
      closed = false,
      prepared = false,
      viewerStarted = false,
      background = false,
      stopped = false,
      startedAt = 0;
    // THE END OF THE LIVE DISPLAY, once: with the accept call's own answer, or,
    // for a call the host moved to the background, when the CLI says the worker ended.
    const stop = (ended?: Partial<TenjinModelWorker>) => {
      if (stopped) return;
      stopped = true;
      closed = true;
      try {
        timer?.cancel();
        // Its viewer writes the rows into its transcript at once; with no viewer they are let go.
        $.clock.after(60_000, () => void runs.delete(offerId));
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
      if (short(e.tool_use_id)) acceptCalls.set(e.tool_use_id, offerId);
      try {
        $.ui.invalidate('ui.render');
        const [path, cwd] = await Promise.all([progressPath($, offerId), $.session.cwd()]);
        if (path)
          timer = $.clock.every(POLL_MS, async () => {
            if (closed || polling) return;
            polling = true;
            try {
              const seen = await pollWorker($, offerId, path, cwd);
              if (!background || stopped) return;
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
          if (!item || item.active || item.nativeId) return;
          item.active = true;
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
                description: item.description,
                prompt: VIEWER_PROMPT + ' ' + item.description,
                cwd: current.cwd,
              });
              if (viewer.agentId) {
                await change($, (state) => {
                  const r = state.records.find((r) => r.offerId === offerId);
                  if (r?.active && (!r.nativeId || r.nativeId === viewer.agentId))
                    r.nativeId = viewer.agentId;
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
    let outcome: Awaited<ReturnType<typeof next>>;
    try {
      outcome = await next(e);
    } catch (error) {
      stop();
      throw error;
    }
    const said = typeof outcome.text === 'string' ? outcome.text : '';
    const answer = json(said);
    if (acceptAnswer(answer) || !timer || !HOST_MOVED.test(said)) {
      stop(endedFrom(answer));
      return outcome;
    }
    // THE HOST MOVED THE CALL TO THE BACKGROUND, as it does for any tool call
    // still running after two minutes: the parent got the host's notice, and
    // the worker runs on. Most workers run longer than that, so this is the
    // usual path. The row and the viewer go on from the CLI's display file,
    // and end when the CLI says the worker did.
    background = true;
    const task = /\btask ([A-Za-z0-9_-]{1,64})\b/.exec(said)?.[1];
    if (task) movedTasks.set(task, offerId);
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
      // A later step follows on only after a step that ended at its bound.
      if (e.index !== 0 && !handedOver.delete(e.agentId))
        return yield* finish(
          e,
          'DeepSeek activity observation finished. The worker result is returned separately to the parent.',
        );
      // The transcript opens with the worker's own name: while only this line stands, the
      // rows draw live under it; the whole run is written after it when the worker ends.
      const header = e.index === 0 ? owned.item.description + '\n' : '';
      if (header) yield { kind: 'text', index: 0, text: header };
      let tail = 'Activity unavailable. The worker result is returned separately to the parent.';
      const stepStart = await $.clock.now();
      try {
        // Followed in short reads, never one held open for the run: a call past two
        // minutes becomes a background task of the parent session, with its own lines
        // there and its answer sent to the parent model.
        let quick = 0;
        for (let read = 0; read < 240; read++) {
          const before = await $.clock.now();
          if (before - stepStart >= STEP_MS) {
            // Ended here, before the host's ten-minute bound; the last step may not hand over.
            if (e.index + 1 < MAX_STEPS) {
              handedOver.add(e.agentId);
              tail = '';
            }
            break;
          }
          const response = await $.mcp.call(SERVER, 'subagent_activity', {
            offer_id: owned.item.offerId,
            follow: true,
          });
          const value = body(response);
          const stands = record(value?.activity);
          if (response.isError) break;
          if (value?.status === 'activity' && stands?.offerId === owned.item.offerId) {
            if (ENDED.includes(String(stands.state))) {
              tail = await writtenRun($, owned.item, stands);
              break;
            }
          } else if (value?.status !== 'waiting') break;
          // A read that did not wait must not spin: a few short pauses, then no more.
          if ((await $.clock.now()) - before < 1000) {
            if (++quick > 5) break;
            await $.clock.sleep(1000);
          }
        }
      } catch {
        /* An observer error never cancels, retries or replaces the actual worker. */
      }
      if (tail) yield { kind: 'text', index: 0, text: tail };
      yield { kind: 'stop', stopReason: 'end_turn', usage: null };
      return {
        turnId: e.turnId,
        index: e.index,
        answer: header + tail,
        toolUses: [],
        stopReason: 'end_turn',
        usage: null,
      };
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
    if (e.agentId) {
      const guard = liveViewerGuards.get(e.agentId);
      if (guard && (!guard.turnId || guard.turnId === e.turnId)) liveViewerGuards.delete(e.agentId);
    }
    if (e.agentId) handedOver.delete(e.agentId);
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
              ? state.records.find((r) => r.nativeId === agentId)
              : undefined;
          return item?.active && (!item.turnId || item.turnId === e.turnId) ? item : undefined;
        };
        const stopped = async () =>
          (await $.agent.list()).some(
            (a) => a.id === agentId && (a.status === 'killed' || a.taskStatus === 'killed'),
          );
        const cancel = (offerId: string) =>
          $.mcp.call(SERVER, 'subagent', { cancel: offerId, reason: 'agent_stopped' });
        const item = await bound();
        if (item && (await stopped())) await cancel(item.offerId);
        else if (item)
          // A stop may mark the agent a moment after its turn ends: read it once more.
          $.clock.after(RECHECK_MS, async () => {
            try {
              const still = await bound();
              if (still && !sessionEnding && (await stopped())) await cancel(still.offerId);
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

  // THE ROWS. An accept call is one live DeepSeek row that ends in a native
  // `Done (…)` line; a held Agent call reads as the offer it is, never as a
  // subagent that finished. Both keep their own row in every view, and the
  // engine's result block shows only where rows show in full (ctrl+o).
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const { tool, input, output, isInterrupted, isErrored } = e.props;
    if (tool === ACCEPT) {
      const offerId = record(input)?.offer_id;
      if (!short(offerId) || !UUID.test(offerId)) {
        // THE CALL AS THE MODEL IS STILL WRITING IT: no offer id to read yet, so the host's
        // own row would stand here for that moment as `plugin:tenjin:router - subagent`,
        // between the offer row and the DeepSeek row. Nothing is drawn until the input
        // says which call it is. A cancel, a capture and a call with an answer keep the
        // host's row.
        if (undecided(input) && output === undefined && !isErrored && !isInterrupted) {
          if (e.props.isExpanded === true) return next(e);
          const { Box } = $.ui.resolve(e);
          return <Box display="none" />;
        }
        return next(e);
      }
      const [held, known] = await Promise.all([
        $.state.get({ ...WORKERS, id: offerId }),
        $.state.get(STATE),
      ]);
      const live = held.value;
      // Before the accept hook has run (the host is still checking the call), the offer's
      // own record names the task.
      const title =
        live?.title ?? known.value?.records.find((r) => r.offerId === offerId)?.title ?? 'subagent';
      const head = { name: 'DeepSeek', argument: title };
      const ui = $.ui.resolve(e);
      const said = textOf(output);
      const ended = json(said);
      const status = ended?.status;
      if (status === 'completed' || status === 'cancelled' || status === 'unknown') {
        const word = status === 'completed' ? 'Done' : stopWord(status, ended!.endedBy);
        return workerRow(ui, {
          ...head,
          state: status === 'completed' ? 'done' : 'error',
          under: word + ' (' + doneParts(ended!, live).join(' · ') + ')',
        });
      }
      // Nothing ran, and the answer says so: a start that never finished, or a refused accept.
      if (status === 'not_started' || typeof ended?.action === 'string')
        return workerRow(ui, {
          ...head,
          state: isErrored || status === 'not_started' ? 'error' : 'held',
          under:
            'Not started' +
            (typeof ended?.elapsedMs === 'number' ? ' (' + duration(ended.elapsedMs) + ')' : ''),
        });
      // NOT THE WORKER'S ANSWER: nothing yet, an Esc, or the host's own notice
      // for a call it moved to the background after two minutes. The worker's
      // record says where it stands; a missing answer never reads as an end.
      if (live?.ended)
        return workerRow(ui, {
          ...head,
          state: live.ended === 'completed' ? 'done' : live.ended === 'unseen' ? 'held' : 'error',
          under: endLine(live),
        });
      if (isInterrupted)
        return workerRow(ui, {
          ...head,
          state: 'error',
          under:
            'Interrupted' +
            (live?.elapsedMs !== undefined ? ' (' + duration(live.elapsedMs) + ')' : ''),
        });
      const moved = output !== undefined && HOST_MOVED.test(said ?? '');
      if (output !== undefined && !live && !moved) return next(e);
      // A running row nothing here follows, after a reload or a resume: the CLI is asked.
      if ((live || moved) && !liveWorkers.has(offerId)) adopt($, offerId, title);
      // From the moment of accept: Claude Code is still starting until the first tick says more.
      const starting = live ? live.state !== 'running' : !moved;
      const parts = [
        starting ? 'starting' : undefined,
        !live && moved ? 'running in the background' : undefined,
        live?.toolUses ? toolUses(live.toolUses) : undefined,
        live?.tokens ? tokens(live.tokens) : undefined,
        live?.elapsedMs !== undefined ? duration(live.elapsedMs) : undefined,
        live?.spentAtomic ? dollars(live.spentAtomic) + ' so far' : undefined,
      ].filter((part): part is string => part !== undefined);
      return workerRow(ui, {
        ...head,
        state: 'running',
        tail: ' · ' + parts.join(' · '),
        ...(starting || !live ? {} : { under: live.current ?? 'Working' }),
      });
    }
    if (tool === 'Agent' || tool === 'Task') {
      const held = heldOffer(output);
      if (!held) return next(e);
      const offerId = String(record(output)?.agentId ?? '').slice(13);
      if (held !== 'unavailable' && UUID.test(offerId)) {
        const [offer, worker, now] = await Promise.all([
          $.state.get({ ...OFFERS, id: offerId }),
          $.state.get({ ...WORKERS, id: offerId }),
          $.clock.now(),
        ]);
        // ONE ROW A TASK. An offer that was accepted, kept native by its repeated
        // call, cancelled or left to expire is settled: the worker's row or the
        // native call's own row is the task's row, and this one draws nothing.
        // ctrl+o still shows the held call and its offer.
        if (
          worker.value ||
          (offer.value && (offer.value.state !== 'offered' || now - offer.value.at > OFFER_MS))
        ) {
          if (e.props.isExpanded === true) return next(e);
          const { Box } = $.ui.resolve(e);
          return <Box display="none" />;
        }
      }
      return workerRow($.ui.resolve(e), {
        state: 'held',
        name: tool,
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
  // The transcript folds a run of calls into one count line, which for an
  // accept reads `Calling plugin:tenjin:router…` and draws no row at all. A
  // group that holds an accept unfolds, so its DeepSeek row draws.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    // A call still being written counts: folded, it reads `Calling plugin:tenjin:router…`
    // for the moment before its offer id is there.
    const accepts = e.props.calls.some((call) => {
      const offerId = record(call.input)?.offer_id;
      return (
        call.tool === ACCEPT && ((short(offerId) && UUID.test(offerId)) || undecided(call.input))
      );
    });
    return next(
      accepts && !e.props.isExpanded ? { ...e, props: { ...e.props, isExpanded: true } } : e,
    );
  });
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const { tool, output, isExpanded } = e.props;
    if (isExpanded === true) return next(e);
    // The host's notice for a call it moved to the background names the server and
    // the tool: the row above already says the worker runs on.
    const ours =
      tool === ACCEPT
        ? acceptAnswer(json(textOf(output))) || HOST_MOVED.test(textOf(output) ?? '')
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
    if (moved !== undefined) {
      const live = (await $.state.get({ ...WORKERS, id: moved })).value;
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
        (live.ended ? ' · ' + endLine(live) : '');
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
    if (!told.startsWith(VIEWER_PROMPT + ' ')) return next(e);
    const description = told.slice(VIEWER_PROMPT.length + 1);
    const item = (await $.state.get(STATE)).value?.records.find(
      (r) => r.description === description,
    );
    const assignment = item
      ? (await $.state.get({ ...ASSIGNMENTS, id: item.offerId })).value
      : undefined;
    // After a restart the prompt is no longer held: say whose viewer this is.
    const text =
      assignment || 'DeepSeek worker for: ' + description.replace(/^DeepSeek #\d+ · /, '');
    return next({ ...e, props: { ...e.props, text } });
  });
  // THE VIEWER'S SPINNER, the one in the DeepSeek agent's own view (its `requestId`
  // is that agent's id), names the worker's step and carries THE TRANSCRIPT WHILE
  // THE WORKER RUNS: a turn's reply is drawn as a message only once it is whole, so
  // until then the spinner is the one thing the host draws in the transcript area,
  // and the worker's rows are drawn above it there, as a native subagent's rows
  // stand above its spinner. Every other spinner is the host's own: while a native
  // subagent runs, its parent's spinner keeps its own words, time and tokens, and
  // the subagent's step shows under its row, as the worker's does under its row.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    // No worker of this session runs: the spinner is the engine's, at no cost.
    if (!liveWorkers.size) return next(e);
    const state = (await $.state.get(STATE)).value;
    const viewed = state?.records.find((r) => r.active && r.nativeId === e.requestId);
    if (!viewed || !state) return next(e);
    const offerId = viewed.offerId;
    const live = (await $.state.get({ ...WORKERS, id: offerId })).value;
    const step = live?.current ?? (live?.state === 'running' ? 'working' : 'starting');
    const spinner = next({
      ...e,
      props: { ...e.props, message: clean('DeepSeek · ' + step, 120) },
    });
    const held = (await $.state.get({ ...TRANSCRIPTS, id: offerId })).value;
    const lines = transcriptLines(held?.rows ?? [], state.cwd);
    // The latest rows that fit above the spinner; the whole run is written when it ends.
    const room = Math.max(4, Math.min(200, (e.viewport?.rows ?? 48) - 8));
    const hidden = Math.max(0, lines.length - room) + (held?.dropped ?? 0);
    const { Box, Text } = $.ui.resolve(e);
    return (
      <Box flexDirection="column">
        {[
          ...(hidden
            ? [
                <Text key="hidden" dimColor>
                  {'… ' + hidden + ' earlier ' + (hidden === 1 ? 'line' : 'lines')}
                </Text>,
              ]
            : []),
          ...lines.slice(-room).map((line, index) => (
            <Text
              key={String(index)}
              dimColor={line.kind === 'under' || line.kind === 'note'}
              wrap={line.kind === 'text' ? 'wrap' : 'truncate-end'}
            >
              {LINE_MARK[line.kind] + (line.kind === 'text' ? clean(line.text, 1200) : line.text)}
            </Text>
          )),
          <Box key="spinner">{await spinner}</Box>,
        ]}
      </Box>
    );
  });
}

/**
 * The whole run as the viewer's transcript keeps it after the worker ended:
 * every row added up while it ran and the CLI's last window, the answer the
 * parent received, and the counts line. The rows held in memory are then released.
 */
async function writtenRun($: Dollar, item: TenjinModelViewerRecord, ended: Json): Promise<string> {
  let held = runs.get(item.offerId);
  let answer: string | undefined;
  let own: unknown;
  let endedBy: unknown = ended.endedBy;
  try {
    // The run is over, so this read returns at once: its last rows and its answer.
    const last = await $.mcp.call(SERVER, 'subagent_activity', { offer_id: item.offerId });
    const data = activityOf(last, item.offerId);
    if (data) held = await addRows($, item.offerId, data);
    const result = record(body(last)?.activity)?.result;
    if (typeof result === 'string' && result.trim()) answer = plain(result, RESULT_CHARS);
    own = record(body(last)?.ended)?.elapsedMs;
    endedBy = record(body(last)?.ended)?.endedBy ?? endedBy;
  } catch {
    /* The rows read while it ran still stand. */
  }
  const [live, state, now] = await Promise.all([
    $.state.get({ ...WORKERS, id: item.offerId }),
    $.state.get(STATE),
    $.clock.now(),
  ]);
  // The job's own time when the CLI gives it. This turn's state reads stand at the
  // moment it began, so otherwise only the start time is used.
  const elapsedMs = Number.isSafeInteger(own)
    ? own
    : live.value
      ? Math.max(0, now - live.value.startedAt)
      : undefined;
  const counts = doneParts(
    { ...ended, ...(elapsedMs !== undefined ? { elapsedMs } : {}) },
    live.value,
  ).join(' · ');
  const end =
    ended.state === 'completed'
      ? 'Done (' + counts + ')'
      : ended.started === false
        ? endingOf(ended)
        : stopWord(ended.state, endedBy) + ' (' + counts + ')\n' + endingOf(ended);
  const text =
    writtenLines(transcriptLines(held?.rows ?? [], state.value?.cwd ?? ''), held?.dropped ?? 0) +
    (answer ? '\n' + answer + '\n' : '') +
    '\n' +
    end;
  runs.delete(item.offerId);
  try {
    await $.state.set(
      { ...TRANSCRIPTS, id: item.offerId },
      { sequence: held?.sequence ?? 0, dropped: 0, rows: [] },
    );
  } catch {
    /* Display only. */
  }
  return text;
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
  argument?: string;
  tail?: string;
  under?: string;
};
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
        <Text bold wrap="truncate-end">
          {row.name}
        </Text>
      </Box>
      <Box flexWrap="nowrap">
        <Text wrap="truncate-end">
          {row.argument !== undefined ? '(' + row.argument + ')' : ''}
        </Text>
        <Text dimColor>{row.tail ?? ''}</Text>
      </Box>
    </Box>
  );
  const under =
    row.under === undefined
      ? []
      : [
          <Box key="under" flexDirection="row">
            <Text dimColor>{'  ⎿  '}</Text>
            <Text dimColor wrap="truncate-end">
              {clean(row.under, 400)}
            </Text>
          </Box>,
        ];
  return (
    <Box flexDirection="column" marginTop={1}>
      {[head, ...under]}
    </Box>
  );
}
/** An accept call's own answer, which its live row already says: a worker
 *  handback (it carries `elapsedMs`) or a refusal to start one. A cancel's
 *  short status is not one, and keeps the engine's result block. */
function acceptAnswer(answer: Json | undefined): boolean {
  return typeof answer?.elapsedMs === 'number' || typeof answer?.action === 'string';
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
 * A held Agent call's result as the local hook made it (`register.tsx`): an
 * offer, with its cap when the offer named one, or a call held and not started.
 * The fabricated `completed` shape stays, as the Agent output schema has no
 * other that carries the offer to the parent; only its drawing changes.
 */
function heldOffer(output: unknown): { capAtomic?: string } | 'unavailable' | undefined {
  const result = record(output);
  if (
    result?.status !== 'completed' ||
    result.totalToolUseCount !== 0 ||
    typeof result.agentId !== 'string'
  )
    return undefined;
  if (result.agentId === 'tenjin-unavailable') return 'unavailable';
  if (!/^tenjin-offer-/.test(result.agentId) || !UUID.test(result.agentId.slice(13)))
    return undefined;
  const offer = json(textOf(result.content));
  const cap = offer?.capAtomic;
  return typeof cap === 'string' && /^[1-9][0-9]{0,29}$/.test(cap) ? { capAtomic: cap } : {};
}
