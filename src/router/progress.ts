import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-json';

/**
 * The live status line's evidence: what this session is looking up right now,
 * which provider is actually being called, and what it cost.
 *
 * DISPLAY ONLY, AND STRICTLY DOWNSTREAM. Nothing here is read by the gate, the
 * decision, the spend policy or the paying leg; every write is best effort and
 * every failure is swallowed, so a full disk or a read-only data dir loses the
 * footer and changes no routing or payment outcome. That is the whole contract
 * this module has to keep.
 *
 * KEYED TO THE SESSION, NEVER GUESSED FROM IT. A record lives under the SHA-256
 * of the harness's own `session_id`, so the renderer for one session cannot see
 * another's. The hook knows that id; the tool, which runs inside the MCP server
 * process, does not, so it resolves the session in one of exactly two ways:
 *
 *  - BY BINDING. An `execute` decision leaves an `id-<hash>.json` marker in the
 *    session that produced it, and the model passes that id back on the tool
 *    call. Resolving through the marker is proof, not inference.
 *  - BY SOLE ACTIVITY. With no id, the request belongs to the only session that
 *    has been active recently, and when two have been, it belongs to neither as
 *    far as this module is concerned: {@link resolveProgressSession} returns
 *    null and nothing is written. A missing footer is the correct failure;
 *    showing one session's lookup in another session's terminal is not.
 */

const PROGRESS_DIR = 'progress';
/** The binding marker's prefix, so it can never be read back as a call record. */
const BINDING_PREFIX = 'id-';
/** A pre-call offer's marker, keyed by the harness's `tool_use_id`. */
const OFFER_PREFIX = 'offer-';
/** The session's own liveness touch, likewise outside the call-record pattern. */
const SESSION_FILE = 'session.json';
/** Call records are named by a 64-hex digest and nothing else is read as one. */
const CALL_FILE_RE = /^[a-f0-9]{64}\.json$/;

/** An in-flight call older than this is shown as stale, never as running. */
export const STALE_AFTER_MS = 90_000;
/**
 * How long a state stays on the footer once nothing has replaced it. The demo
 * holds each one for about ten seconds, which is what makes a decision that
 * takes a second readable at a one-second refresh; after that the line is
 * `x402 · ready` again.
 */
export const RECENT_MS = 10_000;
/** Older than this and a record is ignored by the renderer and pruned on write. */
export const EXPIRY_MS = 10 * 60_000;
/** How recently a session must have been touched to claim an id-less request. */
export const SESSION_ACTIVE_MS = 10 * 60_000;
/** Above this many files a session directory is reported rather than scanned. */
const MAX_RECORDS = 256;
/** A ceiling on the root scan. {@link pruneSessions} keeps it far below this:
 *  a directory is one LIVE session, not one session this machine ever had. */
const MAX_SESSIONS = 4_096;
/** A record larger than this is damaged or not ours; it is skipped unread. */
const MAX_RECORD_BYTES = 4_096;

export type ProgressPhase = 'routing' | 'calling' | 'done';

/** The two markers: a session's liveness touch and a decision-id binding. */
interface Stamp {
  version: 1;
  at: number;
}

/** What one call looks like on disk. Every string is already masked and bounded. */
interface SavedProgress extends Stamp {
  phase: ProgressPhase;
  /** The tool whose activity this is, as the footer names it. */
  operation: string;
  /** What the state SAYS: the outcome on `done`, and on an in-flight record the
   *  stage, when it is not the tool's own `selecting service`. */
  outcome?: string;
  /** Host plus path of the provider actually called, without a scheme. */
  endpoint?: string;
  /** The call's parameters as compact JSON. */
  parameters?: string;
  /** What the provider was paid, as USD. */
  price?: string;
}

export interface ProgressStep {
  phase: ProgressPhase;
  operation?: string;
  outcome?: string;
  /** The executed provider's URL. It can differ from the hint's suggestion. */
  provider?: string;
  parameters?: unknown;
  price?: string;
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function bounded(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length <= limit ? value : `${chars.slice(0, limit - 1).join('')}…`;
}

/**
 * Provider text reaches a terminal here, so it is treated as hostile: control
 * characters, format characters and directional overrides are replaced before
 * anything is written, and again before anything is printed. A footer that can
 * be made to repaint the line above it is a spoofing surface, not a display.
 */
export function sanitize(value: string, limit: number): string {
  return bounded(
    value
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
    limit,
  );
}

/**
 * The CLI's own redaction, behind a dynamic import ON PURPOSE: the rule corpus
 * and the BIP-39 wordlist are a real parse cost, the renderer runs once a
 * second, and only the write path needs them. `dist-chunks.test.ts` pins it.
 */
async function clean(value: string, limit: number): Promise<string> {
  const { mask } = await import('../lib/redact');
  return sanitize(mask(value), limit);
}

/** Host plus path, which is what names a provider to a person watching. */
async function endpointOf(value: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'invalid endpoint';
  }
  if (url.username !== '' || url.password !== '') return 'invalid endpoint';
  return clean(`${url.host}${url.pathname === '/' ? '' : url.pathname}`, 110);
}

async function parametersOf(value: unknown): Promise<string | undefined> {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return undefined;
  }
  return json === undefined ? undefined : clean(json, 180);
}

export function sessionDir(dataDir: string, sessionId: string): string {
  return join(dataDir, PROGRESS_DIR, digest(sessionId));
}

/** A fresh key for one call, so two overlapping lookups never share a record. */
export function newCallId(): string {
  return randomUUID();
}

/**
 * Mark this session live, so an id-less tool call made from it can be
 * attributed. Written on every hook event, including the ones that route
 * nothing: an open session has to be distinguishable from a closed one.
 */
export async function noteSession(
  dataDir: string,
  sessionId: string,
  now = Date.now(),
): Promise<void> {
  await write(join(sessionDir(dataDir, sessionId), SESSION_FILE), { version: 1, at: now });
}

/** Record that this decision id was produced in this session. */
export async function bindDecision(
  dataDir: string,
  sessionId: string,
  decisionId: string,
  now = Date.now(),
): Promise<void> {
  await write(join(sessionDir(dataDir, sessionId), `${BINDING_PREFIX}${digest(decisionId)}.json`), {
    version: 1,
    at: now,
  });
}

/**
 * ONE OFFER PER LOOKUP. The pre-call hook marks the native call it offered on,
 * by the harness's own `tool_use_id`, and the after-call hook reads the mark
 * before it asks again about the same call. Expires and is pruned like every
 * other record here.
 */
export async function markOffered(
  dataDir: string,
  sessionId: string,
  toolUseId: string,
  now = Date.now(),
): Promise<void> {
  await write(join(sessionDir(dataDir, sessionId), `${OFFER_PREFIX}${digest(toolUseId)}.json`), {
    version: 1,
    at: now,
  });
}

export async function wasOffered(
  dataDir: string,
  sessionId: string,
  toolUseId: string,
  now = Date.now(),
): Promise<boolean> {
  const path = join(sessionDir(dataDir, sessionId), `${OFFER_PREFIX}${digest(toolUseId)}.json`);
  const stamp = await readStamp(path);
  return stamp !== null && now - stamp.at <= EXPIRY_MS;
}

/**
 * Which session directory a tool call belongs to, or null for "cannot tell".
 * Null is a normal answer and its only consequence is a footer that stays quiet.
 */
export async function resolveProgressSession(
  dataDir: string,
  opts: { id?: string; now?: number } = {},
): Promise<string | null> {
  const now = opts.now ?? Date.now();
  const root = join(dataDir, PROGRESS_DIR);
  let names: string[];
  try {
    const directory = await opendir(root);
    names = [];
    for await (const entry of directory) {
      if (entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)) names.push(entry.name);
      if (names.length >= MAX_SESSIONS) break;
    }
  } catch {
    return null;
  }
  if (opts.id !== undefined && opts.id.length > 0) {
    const marker = `${BINDING_PREFIX}${digest(opts.id)}.json`;
    for (const name of names) {
      const bound = await readStamp(join(root, name, marker));
      if (bound !== null && now - bound.at <= EXPIRY_MS) return join(root, name);
    }
    // A stale or unknown id says nothing about which session asked, so the
    // sole-activity rule below still applies rather than a wrong attribution.
  }
  const live: string[] = [];
  for (const name of names) {
    const touched = await readStamp(join(root, name, SESSION_FILE));
    if (touched !== null && now - touched.at <= SESSION_ACTIVE_MS) live.push(name);
    if (live.length > 1) return null;
  }
  return live.length === 1 ? join(root, live[0] as string) : null;
}

/**
 * Record one step of one call. The caller holds the directory (from
 * {@link sessionDir} or {@link resolveProgressSession}) and the call id, so a
 * step never has to re-resolve anything on the hot path.
 */
export async function writeProgress(
  directory: string,
  callId: string,
  step: ProgressStep,
  now = Date.now(),
): Promise<void> {
  const endpoint = step.provider === undefined ? undefined : await endpointOf(step.provider);
  const parameters =
    step.parameters === undefined ? undefined : await parametersOf(step.parameters);
  const saved: SavedProgress = {
    version: 1,
    at: now,
    phase: step.phase,
    operation: sanitize(step.operation ?? 'request', 24) || 'request',
    ...(step.outcome !== undefined ? { outcome: sanitize(step.outcome, 40) } : {}),
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
    ...(step.price !== undefined ? { price: sanitize(step.price, 24) } : {}),
  };
  await write(join(directory, `${digest(callId)}.json`), saved);
}

export interface LookupFooter {
  /** A decision is in flight. */
  routing(): Promise<void>;
  /** The EXECUTED provider, which can differ from what the hint suggested. */
  calling(step: { provider: string; parameters?: unknown }): Promise<void>;
  /** The outcome, and what the provider was paid for it. */
  done(
    outcome: string,
    step?: { provider?: string; parameters?: unknown; price?: string },
  ): Promise<void>;
}

/** A footer for a session this call cannot be attributed to: it writes nothing. */
const SILENT: LookupFooter = {
  routing: async () => undefined,
  calling: async () => undefined,
  done: async () => undefined,
};

/**
 * The `request` tool's footer: the session is resolved ONCE, at the top of the
 * call, and each later step is one small write. An unresolvable session yields
 * {@link SILENT}, and the lookup runs exactly as it would have.
 */
export async function openLookupFooter(
  dataDir: string,
  opts: { id?: string; operation?: string; now?: () => number } = {},
): Promise<LookupFooter> {
  const now = opts.now ?? Date.now;
  const directory = await resolveProgressSession(dataDir, {
    ...(opts.id !== undefined ? { id: opts.id } : {}),
    now: now(),
  }).catch(() => null);
  if (directory === null) return SILENT;
  const callId = newCallId();
  const operation = opts.operation ?? 'request';
  const step = async (patch: ProgressStep): Promise<void> => {
    await writeProgress(directory, callId, { operation, ...patch }, now());
  };
  return {
    routing: async () => {
      await step({ phase: 'routing' });
      await pruneProgress(directory, now());
    },
    calling: async (calling) => step({ phase: 'calling', ...calling }),
    done: async (outcome, detail) => step({ phase: 'done', outcome, ...detail }),
  };
}

/**
 * Remove records past {@link EXPIRY_MS}. Run from a writer, never from the
 * renderer: the footer refreshes once a second and must stay read-only.
 */
export async function pruneProgress(directory: string, now = Date.now()): Promise<void> {
  try {
    const dir = await opendir(directory);
    let count = 0;
    for await (const entry of dir) {
      if (++count > MAX_RECORDS) return;
      if (!entry.isFile() || entry.name === SESSION_FILE) continue;
      const record = await readStamp(join(directory, entry.name));
      if (record === null || now - record.at > EXPIRY_MS) {
        await rm(join(directory, entry.name), { force: true }).catch(() => undefined);
      }
    }
  } catch {
    // Housekeeping only. Nothing downstream depends on it having run.
  }
}

/**
 * Remove the directories of sessions that are over.
 *
 * WITHOUT THIS THE ROOT ONLY GROWS, one directory per session this machine has
 * ever had, and a root big enough to hit {@link MAX_SESSIONS} would leave
 * {@link resolveProgressSession} scanning an arbitrary subset that need not
 * contain the session asking. Run from the hook, which is the one writer that
 * fires on every turn; a directory whose session is still live is never touched.
 */
export async function pruneSessions(dataDir: string, now = Date.now()): Promise<void> {
  const root = join(dataDir, PROGRESS_DIR);
  try {
    const directory = await opendir(root);
    let seen = 0;
    for await (const entry of directory) {
      if (++seen > MAX_SESSIONS) return;
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const path = join(root, entry.name);
      const session = await readStamp(join(path, SESSION_FILE));
      if (session !== null && now - session.at <= SESSION_ACTIVE_MS) continue;
      // The touch is gone or old, so the only thing that can keep this
      // directory is a record still inside the renderer's window.
      if (await hasLiveRecord(path, now)) continue;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch {
    // Housekeeping only. Nothing downstream depends on it having run.
  }
}

async function hasLiveRecord(directory: string, now: number): Promise<boolean> {
  try {
    const dir = await opendir(directory);
    let count = 0;
    for await (const entry of dir) {
      if (++count > MAX_RECORDS) return true;
      if (!entry.isFile() || entry.name === SESSION_FILE) continue;
      const record = await readStamp(join(directory, entry.name));
      if (record !== null && now - record.at <= EXPIRY_MS) return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * The footer for one session: one line, bounded, sanitized, and empty of
 * everything but this session's own calls. Read-only by construction.
 */
export async function renderProgress(
  dataDir: string,
  sessionId: string,
  options: { now?: number; columns?: number } = {},
): Promise<string> {
  const now = options.now ?? Date.now();
  // The harness truncates to the real terminal width, and `COLUMNS` rarely
  // survives into a status-line process, so the default is a wide terminal
  // rather than a narrow one: cutting a provider's path off at 80 columns on a
  // 200-column terminal loses exactly the part worth reading.
  const columns = Math.max(45, Math.min(400, options.columns || 160));
  const directory = sessionDir(dataDir, sessionId);
  const records: SavedProgress[] = [];
  try {
    const dir = await opendir(directory);
    let count = 0;
    for await (const entry of dir) {
      if (++count > MAX_RECORDS) return bounded('x402 · activity exceeds display limit', columns);
      if (!entry.isFile() || !CALL_FILE_RE.test(entry.name)) continue;
      const record = await readCall(join(directory, entry.name));
      if (record !== null && now - record.at <= EXPIRY_MS) records.push(record);
    }
  } catch (error) {
    // A SESSION WITH NO DIRECTORY IS IDLE, not broken: it has simply not looked
    // anything up yet, and the router being on is the thing the idle line says.
    // Any OTHER read failure is this display failing, and a display that failed
    // prints nothing rather than a status it did not read.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? READY : '';
  }
  const running = records
    .filter((row) => row.phase !== 'done' && now - row.at <= holdMs(row))
    .sort((a, b) => b.at - a.at);
  // Only a LOOKUP goes stale out loud. A hook decision has a five-second budget,
  // so one still in flight after its hold is a dead hook, and the footer says
  // ready rather than naming a stage nothing is working on.
  const stale = records.filter(
    (row) => row.phase !== 'done' && now - row.at > holdMs(row) && row.operation === 'request',
  );
  const finished = records
    .filter((row) => row.phase === 'done' && now - row.at <= RECENT_MS)
    .sort((a, b) => b.at - a.at);
  const head = running[0] ?? finished[0] ?? stale.sort((a, b) => b.at - a.at)[0];
  if (head === undefined) return READY;
  // OVERLAPPING CALLS ARE COUNTED, NOT HIDDEN. The newest running call is the
  // one worth naming; the rest are a count, because a second endpoint and its
  // parameters do not fit a line beside the first.
  const alsoRunning = running.length - (running[0] === head ? 1 : 0);
  const suffix = alsoRunning > 0 ? ` · +${alsoRunning} more` : '';
  return bounded(`${line(head, now)}${suffix}`, columns);
}

/** What the footer says when this session has nothing running or just finished.
 *  It is the visible proof that the router is on, so it is never blank. */
const READY = 'x402 · ready';

/**
 * How long this state holds the line. A lookup in flight holds it until it
 * lands, because a provider call can take a minute; everything else holds it
 * for {@link RECENT_MS}, which is how the demo reads: one state per second or
 * so, each one still there when the next arrives.
 */
function holdMs(row: SavedProgress): number {
  return row.phase !== 'done' && row.operation === 'request' ? STALE_AFTER_MS : RECENT_MS;
}

/**
 * One call, as the footer says it: `x402 · <tool>: <state> <host/path> ·
 * <parameters> · <price>`. Every field is sanitized AGAIN here, because what is
 * on disk is input to this process even when this process wrote it.
 */
function line(row: SavedProgress, now: number): string {
  const operation = sanitize(row.operation, 24) || 'request';
  if (row.phase !== 'done' && now - row.at > STALE_AFTER_MS) {
    return `x402 · ${operation}: stale, no outcome recorded`;
  }
  // `selecting service` is the demo's own word for a decision in flight, and a
  // stage the hook names for itself wins over it.
  const state =
    row.phase === 'routing'
      ? sanitize(row.outcome ?? 'selecting service', 40)
      : row.phase === 'calling'
        ? 'calling'
        : sanitize(row.outcome ?? 'done', 40);
  return (
    `x402 · ${operation}: ${state}` +
    (row.endpoint !== undefined ? ` ${sanitize(row.endpoint, 110)}` : '') +
    (row.parameters !== undefined ? ` · ${sanitize(row.parameters, 180)}` : '') +
    (row.price !== undefined ? ` · ${sanitize(row.price, 24)}` : '')
  );
}

async function write(path: string, body: Stamp | SavedProgress): Promise<void> {
  try {
    await writeFileAtomic(path, JSON.stringify(body), { mode: 0o600, dirMode: 0o700 });
  } catch {
    // The footer is the only thing that can be lost here, by design.
  }
}

/** A marker's timestamp, or null for absent, damaged or not ours. */
async function readStamp(path: string): Promise<Stamp | null> {
  return stampOf(await readJson(path));
}

function stampOf(row: Record<string, unknown> | null): Stamp | null {
  if (row === null) return null;
  return row.version === 1 && typeof row.at === 'number' && Number.isFinite(row.at)
    ? { version: 1, at: row.at }
    : null;
}

/** A call record, or null. Every field is re-checked: what is on disk is input. */
async function readCall(path: string): Promise<SavedProgress | null> {
  const row = await readJson(path);
  const stamp = stampOf(row);
  if (row === null || stamp === null || typeof row.operation !== 'string') return null;
  if (!['routing', 'calling', 'done'].includes(row.phase as string)) return null;
  const optional = ['outcome', 'endpoint', 'parameters', 'price'] as const;
  if (!optional.every((key) => row[key] === undefined || typeof row[key] === 'string')) return null;
  return {
    ...stamp,
    phase: row.phase as ProgressPhase,
    operation: row.operation,
    ...Object.fromEntries(
      optional.filter((key) => row[key] !== undefined).map((key) => [key, row[key]]),
    ),
  };
}

/**
 * One bounded JSON object, or null. `O_NOFOLLOW` because these files live under
 * a directory the user can write: a symlink planted here must not turn a footer
 * read into a read of something else.
 */
async function readJson(path: string): Promise<Record<string, unknown> | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  if (file === undefined) return null;
  try {
    if ((await file.stat()).size > MAX_RECORD_BYTES) return null;
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_RECORD_BYTES) return null;
    const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    return parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
      ? null
      : (parsed as Record<string, unknown>);
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}
