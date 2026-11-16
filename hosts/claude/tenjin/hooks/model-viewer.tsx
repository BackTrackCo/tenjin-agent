import type {
  EngineInterface,
  On,
  TurnStepChunk,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code';
import { update } from 'claude-code';
import { asRecord as record, subagentsEnabled as enabled } from './hook-data';
import { clearNativeRetries, normalizeNativeRetry } from './model-native-retry';
import type {
  TenjinModelActivity,
  TenjinModelViewerRecord,
  TenjinModelViewerState,
} from '../types';

// Source candidate: the production native ordering, permissions and Remote Control gate is separate.
const TYPE = 'tenjin:deepseek-viewer';
const ACCEPT = 'mcp__plugin_tenjin_router__subagent';
const SERVER = 'plugin:tenjin:router';
const LIVE_MESSAGE = 'DeepSeek worker activity\n';
const STATE = { plugin: 'tenjin', key: 'modelViewers' } as const;
const ALIASES = 'deepseek-viewer-alias-v1:';
const SERIAL = 'deepseek-viewer-serial-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  profile: 'general-purpose' | 'Explore';
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
async function aliasKey(nativeId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nativeId));
  return (
    ALIASES +
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  );
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
    (a.profile === 'general-purpose' || a.profile === 'Explore') &&
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
    // The observer owns one text response; worker limits are independent.
    maxTurns: 1,
    omitClaudeMd: true,
  });
}

/** Called only after the existing local handoff validated its offer. No assignment is persisted here. */
export async function rememberModelOffer(
  $: Dollar,
  offerId: string,
  nativeInput: Json,
): Promise<void> {
  try {
    if (!UUID.test(offerId) || !(await enabled($))) return;
    const profile = nativeInput.subagent_type ?? 'general-purpose';
    if (profile !== 'general-purpose' && profile !== 'Explore') return;
    const priorSerial = await serial($);
    const rawTitle =
      typeof nativeInput.description === 'string' ? nativeInput.description : profile;
    const title = /secret|password|token|api.key|bearer|https?:|0x[0-9a-f]{32}/i.test(rawTitle)
      ? profile
      : clean(rawTitle, 64);
    await registerType($);
    const current = await change($, (state) => {
      if (state.records.some((r) => r.offerId === offerId)) return;
      if (state.records.length >= 16) {
        const free = state.records.findIndex((r) => !r.active);
        if (free < 0) return;
        state.records.splice(free, 1);
      }
      const ordinal = Math.max(state.serial, priorSerial) + 1;
      if (!Number.isSafeInteger(ordinal)) return;
      state.serial = ordinal;
      state.records.push({
        offerId,
        ordinal,
        profile,
        description: 'DeepSeek #' + ordinal + ' · ' + title,
        active: false,
      });
    });
    if (current) {
      await $.store.set(SERIAL, Math.max(await serial($), current.serial));
    }
  } catch {
    /* An unavailable viewer never changes the held assignment or acceptance. */
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
    (a.nativeProfile !== 'general-purpose' && a.nativeProfile !== 'Explore') ||
    !Number.isSafeInteger(a.sequence) ||
    Number(a.sequence) < 0 ||
    !['starting', 'running', 'completed', 'cancelled', 'unknown'].includes(String(a.state))
  )
    return;
  const rows: TenjinModelActivity['rows'] = [];
  if (Array.isArray(a.rows))
    for (const value of a.rows.slice(-24)) {
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
    droppedRows:
      (Number.isSafeInteger(a.droppedRows) && Number(a.droppedRows) >= 0
        ? Number(a.droppedRows)
        : 0) + (Array.isArray(a.rows) ? Math.max(0, a.rows.length - 24) : 0),
    rows,
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
  const fraction = padded.slice(-6).replace(/0+$/, '');
  return '$' + padded.slice(0, -6) + (fraction ? '.' + fraction : '');
}
function displayState(item: TenjinModelViewerRecord): string {
  return item.inspectionUnavailable
    ? 'activity unavailable'
    : (item.activity?.state ?? 'activity unavailable');
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

  on('tool.call', { tool: ACCEPT }, async ($, e, next) => {
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
    let timer: { cancel(): void } | undefined;
    let binding: ViewerBinding | undefined;
    let polling = false,
      closed = false,
      prepared = false;
    try {
      if (await enabled($)) {
        const current = await change($, (state) => {
          prepared = false;
          const item = state.records.find((r) => r.offerId === e.offer_id);
          if (!item || item.active || item.nativeId) return;
          item.active = true;
          prepared = true;
        });
        const item = current?.records.find((r) => r.offerId === e.offer_id);
        if (current && item) {
          if (prepared)
            binding = {
              parentSessionId: current.parentSessionId,
              cwd: current.cwd,
              offerId: item.offerId,
            };
          if (prepared && liveViewerGuards.size + pendingViewerSpawns < 16) {
            // Count the pending spawn until it returns, even after classic-start tags its id.
            pendingViewerSpawns++;
            try {
              const spawned = await $.agent.spawn({
                subagentType: TYPE,
                description: item.description,
                prompt: 'Observe only the already owned DeepSeek worker activity.',
                cwd: current.cwd,
              });
              if (spawned.agentId) {
                await change($, (state) => {
                  const r = state.records.find((r) => r.offerId === e.offer_id);
                  if (r?.active && (!r.nativeId || r.nativeId === spawned.agentId))
                    r.nativeId = spawned.agentId;
                });
              }
            } catch {
              /* Failed observation cannot start, duplicate or cancel the real worker. */
            } finally {
              pendingViewerSpawns--;
            }
            timer = $.clock.every(500, async () => {
              if (closed || polling) return;
              polling = true;
              try {
                await refresh($, e.offer_id as string, () => !closed);
              } catch {
                /* Display only. */
              } finally {
                polling = false;
              }
            });
          }
        }
      }
    } catch {
      /* All observation setup is optional. */
    }
    try {
      return await next(e);
    } finally {
      closed = true;
      try {
        timer?.cancel();
      } catch {
        /* Timer failures do not rewrite the handback. */
      }
      if (prepared) {
        try {
          // UI I/O cannot delay or replace the original worker result, even when inspect hangs.
          $.clock.after(0, async () => {
            try {
              if (binding) await retireViewer($, binding);
              await refresh($, e.offer_id as string);
            } catch {
              /* The last confirmed rows remain visibly marked unavailable. */
            }
          });
        } catch {
          /* Preserve the exact original acceptance outcome. */
        }
      }
    }
  });
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* normalizeNativeRetry($, next(e), next.signal);
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
      if (e.index !== 0)
        return yield* finish(
          e,
          'DeepSeek activity observation finished. The worker result is returned separately to the parent.',
        );
      yield { kind: 'text', index: 0, text: LIVE_MESSAGE };
      let tail = 'Activity unavailable. The worker result is returned separately to the parent.';
      try {
        const response = await $.mcp.call(SERVER, 'subagent_activity', {
          offer_id: owned.item.offerId,
          follow: true,
        });
        const value = body(response);
        if (
          !response.isError &&
          value?.status === 'activity' &&
          record(value.activity)?.offerId === owned.item.offerId
        )
          tail =
            'Activity observation finished. The worker result is returned separately to the parent.';
      } catch {
        /* An observer error never cancels, retries or replaces the actual worker. */
      }
      yield { kind: 'text', index: 0, text: tail };
      yield { kind: 'stop', stopReason: 'end_turn', usage: null };
      return {
        turnId: e.turnId,
        index: e.index,
        answer: LIVE_MESSAGE + tail,
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
    if (e.agentId === undefined) await clearNativeRetries($).catch(() => undefined);
    if (e.agentId) {
      const guard = liveViewerGuards.get(e.agentId);
      if (guard && (!guard.turnId || guard.turnId === e.turnId)) liveViewerGuards.delete(e.agentId);
    }
    try {
      if (e.agentId && e.reason === 'aborted') {
        const [parentSessionId, held] = await Promise.all([$.session.id(), $.state.get(STATE)]);
        const state = held.value;
        // Cancellation uses the prior binding even when cwd access was revoked. This
        // grants no work/scope authority; the backend still checks its owned pending offer.
        const item =
          state?.version === 1 && state.parentSessionId === parentSessionId
            ? state.records.find((r) => r.nativeId === e.agentId)
            : undefined;
        if (item?.active && (!item.turnId || item.turnId === e.turnId))
          await $.mcp.call(SERVER, 'subagent', { cancel: item.offerId });
      }
    } catch {
      /* Failed UI cancellation is not a new execution or payment. */
    }
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    await clearNativeRetries($).catch(() => undefined);
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
    const rows = Math.max(1, Math.min(12, Math.floor(maxRows)));
    const fit = (value: string) => Array.from(clean(value, 640)).slice(0, width).join('');
    const details: string[] = [];
    for (const r of a?.rows ?? []) {
      details.push(r.kind === 'tool' ? (r.name ?? 'Tool') + ' · ' + r.state : (r.text ?? r.kind));
      if (r.inputSummary) details.push(r.inputSummary);
      if (r.outputPreview) details.push(r.outputPreview);
    }
    const spend = a?.spend
      ? 'Spent ' +
        dollars(a.spend.actualAtomic) +
        ' · reserved ' +
        dollars(a.spend.reservedAtomic) +
        (a.spend.uncertain.length ? ' · settlement unresolved' : '')
      : 'Spend pending';
    const lines = ['DeepSeek V4.1 Flash 1017 · ' + displayState(item)];
    if (rows > 2) {
      lines.push(
        'Recent activity · up to 24 events' +
          (a?.droppedRows ? ' · ' + a.droppedRows + ' earlier events omitted' : '') +
          (details.length > rows - 3 ? ' · latest lines shown' : ''),
      );
      if (rows > 3) lines.push(...details.slice(-(rows - 3)));
    }
    if (rows > 1) lines.push(spend);
    return (
      <Box flexDirection="column" width={width}>
        {lines.map((line, index) => (
          <Text key={String(index)} wrap="truncate-end" dimColor={index > 0}>
            {fit(line)}
          </Text>
        ))}
      </Box>
    );
  });
}
