import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../lib/atomic-json';
import { isRecord } from '../lib/guards';
import { mask } from '../lib/redact';
import { readJsonFile } from './store-files';

const run = promisify(execFile);
const MAX_NAMES = 256;
const MAX_REPEATS = 32;
const MAX_CALLS = 64;
const MAX_PHASES = 48;
const MAX_MS = 86_400_000;

/** A duration or count for the record: a whole number from 0, bounded. */
const whole = (value: unknown, max = MAX_MS): number | undefined =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(0, Math.round(value)))
    : undefined;

/**
 * WHERE ONE MODEL CALL'S TIME WENT inside the transport, in milliseconds: the first budget
 * read (`budgetMs`), the wait for room in the wallet's call rate (`paceWaitMs`: before the
 * quote for a router that advertises its rate, before the signed request for one that does
 * not), the unpaid quote round trip (`quoteMs`; `requoteMs` when a call that waited long
 * for its channel asked for the quote again under the lock), the reservation (`reserveMs`),
 * the wait for a channel's payment lock (`laneWaitMs`; `slot` is the shared lane the call
 * paid on, `laneMoved` says it was the other lane than its worker's own, and `waitedOn`
 * says who held its own channel when every channel it could pay on was held: this process
 * or another one), the checks under it (`gateMs`), the payer from its start to the paid request leaving (`signMs`:
 * policy, signer, signing, a deposit; `journalMs` of it is the refund journal's write), the
 * paid request to its response headers (`answerMs`), the headers to the payer's return
 * (`bodyMs`: the body read and the payment SDK's accounting), the payer's drain (`drainMs`)
 * and the local settlement (`settleMs`). `fetches` counts the other HTTP requests the payer
 * made, `outputCap` is the `max_tokens` the call asked for. The router answers a call whole, so no first token is seen here: `answerMs` is the
 * model's whole answer unless the router sends its headers early.
 */
export type ModelCallTiming = {
  slot: number;
  budgetMs?: number;
  quoteMs?: number;
  reserveMs?: number;
  laneWaitMs?: number;
  gateMs?: number;
  signMs?: number;
  journalMs?: number;
  answerMs?: number;
  bodyMs?: number;
  drainMs?: number;
  settleMs?: number;
  fetches?: number;
  requestBytes?: number;
  /** The output cap the call asked for (`max_tokens` as sent): the job's cap, or less
   *  where what was left of the job's ceiling could not reserve that much. */
  outputCap?: number;
  /** The wait for room in the wallet's call rate, before the request the router counts. */
  paceWaitMs?: number;
  /** The quote asked again under the channel's lock, because the first had grown old. */
  requoteMs?: number;
  /** The call paid on the other shared lane, because another call held its worker's own. */
  laneMoved?: true;
  /** Every channel the call could pay on was held when it came: who held its own. */
  waitedOn?: 'this_process' | 'other_process' | 'unknown';
};
const CALL_TIMES = [
  'budgetMs',
  'quoteMs',
  'reserveMs',
  'laneWaitMs',
  'gateMs',
  'signMs',
  'journalMs',
  'answerMs',
  'bodyMs',
  'drainMs',
  'settleMs',
  'paceWaitMs',
  'requoteMs',
] as const;

/**
 * One model call as the worker's bridge saw it: when its request arrived (`at`, ms after
 * the accept), how many other calls of this worker were then in flight (`live`), the time
 * since the worker's previous answer when none was (`gapMs`: the tools the worker ran in
 * between, and Claude Code's own work), the bridge's checks, redaction and body read
 * before the transport (`prepMs`), the whole call (`ms`), the transport's own split, the
 * tries it took, and the answer's token counts.
 */
export type WorkerCall = Partial<ModelCallTiming> & {
  at: number;
  live: number;
  gapMs?: number;
  prepMs?: number;
  ms?: number;
  tries?: number;
  failed?: true;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
};

/**
 * ONE HELD CALL BEFORE ITS OFFER, written when the capture answers, also for an offer
 * nobody accepts. `at` is when the capture reached `tenjin mcp`: the plugin's hook held
 * the call before that, which this record does not see. The marks are milliseconds after
 * `at`: `job` (consent, repeat and worker checks done, the job record made),
 * `routeSent` (the parent context read, the routing request ready), `routeAnswered` (the
 * router's decision call, whole: the fee's signing and the server's own model call),
 * `decided` (the offer stored), `warm` (its worker's preparation started) and `returned`
 * (the answer handed back to the plugin). `routeFetchMs` is each HTTP round trip of the
 * decision call.
 */
export type OfferTiming = {
  at: number;
  action: string;
  marks: Record<string, number>;
  routeFetchMs: number[];
};

const OFFER_MARKS = ['job', 'routeSent', 'routeAnswered', 'decided', 'warm', 'returned'];

/** Merges fields into a job's record, or starts it. Never throws. */
async function mergeRecord(
  dataDir: string,
  jobId: string,
  merge: (kept: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  try {
    const path = join(dataDir, 'model-jobs', `${jobId}.diagnostics.json`);
    const kept = await readJsonFile(path, 1_000_000).catch(() => null);
    await writeFileAtomic(
      path,
      JSON.stringify(merge(isRecord(kept) && kept.version === 1 ? kept : { version: 1 })),
      { mode: 0o600, dirMode: 0o700 },
    );
  } catch {
    // A record that cannot be written leaves the job as it is.
  }
}

/** The time before an offer, kept beside the job's record. Never throws. */
export async function writeOfferTiming(
  dataDir: string,
  jobId: string,
  timing: {
    at: number;
    action: string;
    marks: Record<string, number>;
    routeFetchMs?: readonly number[];
  },
): Promise<void> {
  const marks: Record<string, number> = {};
  for (const name of OFFER_MARKS) {
    const when = timing.marks[name];
    const after = when === undefined ? undefined : whole(when - timing.at);
    if (after !== undefined) marks[name] = after;
  }
  const offer: OfferTiming = {
    at: Math.round(timing.at),
    action: timing.action.slice(0, 40),
    marks,
    routeFetchMs: (timing.routeFetchMs ?? []).slice(0, 8).flatMap((ms) => whole(ms) ?? []),
  };
  await mergeRecord(dataDir, jobId, (kept) => ({ ...kept, offer }));
}

/**
 * Start and end phases marked outside the worker (the accept call's own steps after the
 * worker returned), added to the job's record as milliseconds after `acceptedAt`. Never
 * throws, and the caller does not wait for it.
 */
export async function writeWorkerPhases(
  dataDir: string,
  jobId: string,
  acceptedAt: number,
  marks: Record<string, number>,
): Promise<void> {
  await mergeRecord(dataDir, jobId, (kept) => {
    const phases: Record<string, number> = isRecord(kept.phases)
      ? (kept.phases as Record<string, number>)
      : {};
    for (const [name, when] of Object.entries(marks).slice(0, 16))
      if (!(name in phases) && Object.keys(phases).length < MAX_PHASES && Number.isFinite(when))
        phases[name.slice(0, 40)] = Math.round(when - acceptedAt);
    return { ...kept, phases };
  });
}

/**
 * A BOUNDED RECORD OF HOW ONE WORKER RUN WENT, for looking into a stop or a drift later:
 * its tools and MCP servers, its root and commit, the output and context settings its
 * requests carried, whether its earlier reasoning went back on each turn, its repeat
 * reminders and how it ended. Names, numbers and codes only: no assignment, no tool
 * input or result, no model text. A run that failed also keeps its error (`failure`).
 * Written next to the job's record, readable by its user alone, swept with it after 7
 * days, and sent nowhere.
 */
export type WorkerDiagnostics = {
  version: 1;
  root: string;
  commit?: string;
  model?: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  settings: {
    /** The output cap the worker was given, and the largest one a request asked for. */
    outputCap: number;
    maxOutputTokens?: number;
    compactWindow: number;
    thinking: string[];
    /** None: the job's wall time and money ceiling bound a run. */
    maxTurns: null;
  };
  /** The image and document blocks the job sent as text: the worker did not see them. */
  omitted?: number;
  /** The latest request's history: assistant turns, and how many carried their reasoning back. */
  reasoning: { turns: number; withThinking: number; textTurns: number; textWithThinking: number };
  repeats: { tool: string; count: number }[];
  /**
   * Milliseconds from the accept call reaching `tenjin mcp` to each start phase, the first
   * time it happens: `cliProcess` (negative: when that process started), `checked` (consent
   * and offer checks), `qualified` (worker qualification and the Claude Code version
   * read), `promptRead` (the native agent prompt), `childSpawned`, `earlyReady` (SDK initialization
   * before releasing a warm worker), `childReady` (the SDK's
   * init), `firstRequest` (the bridge's first model request, before its quote round trip),
   * `firstAnswer` (that call answered), `firstActivity` (the first worker reply observed,
   * which the viewer's first row draws from). A worker's preparation: `workerStart`,
   * `envReady` (the env file scan, or an earlier one taken up), `workspaceRead` (settings
   * and private paths), `sdkInitialized` (the SDK's initialize answer), `envVerified` (a
   * warm worker's own scan agreed), `released` (the checks after the accept). The run's
   * ends: `refundProbed` (the router's refund-support answer), `lastAnswer` (the last
   * model answer sent to the worker), `resultMessage` (the SDK's result), `childClosed`
   * (its process gone), `workerReturned`, `refundClosed` (the run's channel closed),
   * `handbackStored` and `answered` (the accept call's answer handed to the host). With
   * an `offer`: `offerCaptured` and `offerReturned`.
   */
  phases: Record<string, number>;
  /**
   * Claude Code's own start-up checkpoints (`before_sandbox_init`, `action_after_setup`,
   * `stdin_listen_started`), each in milliseconds from the accept as this process saw it, so
   * the split of the child's start shows in a live record.
   */
  childMarks: Record<string, number>;
  /** Facts of the start: whether an earlier env scan was taken up, and a kept prompt read. */
  start: Record<string, boolean | number>;
  /** The time before the offer, written by the capture. */
  offer?: OfferTiming;
  /** The first model calls, one by one, and every call's sums. */
  calls: WorkerCall[];
  callTotals: Record<string, number>;
  /** Model calls tried again after a failure the router confirmed cost nothing. */
  retries: { attempt: number; cause: string; status?: number; code?: string }[];
  stop?: { subtype: string; turns?: number; stopReason?: string };
  failure?: WorkerFailure;
};

/**
 * WHY A RUN THAT DID NOT COMPLETE FAILED: the job's end code, and the error with its
 * causes, outermost first. Each has its class name, its code when it has one (a system
 * code such as `ETIMEDOUT`, the router's status or fixed error code) and the start of its
 * message with secret-shaped values masked. A job once ended `unknown` after 3 s with
 * nothing anywhere to say what had failed.
 */
export type WorkerFailure = {
  endedBy: string;
  errors: { name: string; code?: string; status?: number; message: string }[];
};
const MAX_CAUSES = 5;
const MAX_MESSAGE = 300;

export function workerFailure(endedBy: string, error: unknown): WorkerFailure {
  const errors: WorkerFailure['errors'] = [];
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSES && current !== undefined && current !== null; depth++) {
    const value = isRecord(current) ? current : {};
    // A model call's own fixed codes, and a worker stop's.
    const detail = [value.detail, value.stop].find(isRecord) ?? {};
    const code = [value.code, detail.code, detail.reason, detail.cause].find(
      (v): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v),
    );
    const status = [value.status, detail.status].find(
      (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599,
    );
    errors.push({
      name: (typeof value.name === 'string' ? value.name : typeof current).slice(0, 80),
      ...(code ? { code } : {}),
      ...(status !== undefined ? { status } : {}),
      message: mask(typeof value.message === 'string' ? value.message : String(current)).slice(
        0,
        MAX_MESSAGE,
      ),
    });
    current = value.cause;
  }
  return { endedBy: endedBy.slice(0, 80), errors };
}

/**
 * Adds a failed run's error to the job's record, or starts the record for a run that
 * ended before its worker wrote one. Never throws: diagnostics change nothing.
 */
export async function writeWorkerFailure(
  dataDir: string,
  jobId: string,
  failure: WorkerFailure,
): Promise<void> {
  await mergeRecord(dataDir, jobId, (kept) => ({ ...kept, failure }));
}

const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string').map((v) => v.slice(0, 200))
    : [];
const blocks = (message: unknown): Record<string, unknown>[] => {
  const content = (message as { content?: unknown } | null)?.content;
  return Array.isArray(content)
    ? content.filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object')
    : [];
};

export class WorkerDiagnosticsRecord {
  private value: WorkerDiagnostics;
  private acceptedAt: number;

  constructor(root: string, compactWindow: number, outputCap: number) {
    this.value = {
      version: 1,
      root,
      tools: [],
      mcpServers: [],
      settings: { outputCap, compactWindow, thinking: [], maxTurns: null },
      reasoning: { turns: 0, withThinking: 0, textTurns: 0, textWithThinking: 0 },
      repeats: [],
      retries: [],
      phases: {},
      childMarks: {},
      start: {},
      calls: [],
      callTotals: { count: 0 },
    };
    this.acceptedAt = Date.now();
  }

  /** A fact of the start, once: a flag or a count. */
  fact(name: string, value: boolean | number): void {
    if (name in this.value.start || Object.keys(this.value.start).length >= 16) return;
    this.value.start[name.slice(0, 40)] =
      typeof value === 'boolean' ? value : (whole(value, Number.MAX_SAFE_INTEGER) ?? 0);
  }

  private live = 0;
  private answeredAt: number | undefined;

  /**
   * One model request the bridge received. `prepared` when it is ready for the transport,
   * `done` with the answer's usage (or nothing for a call that failed), whichever try
   * answered and the transport's own split.
   */
  call(at = Date.now()): {
    prepared: (at?: number) => void;
    done: (
      outcome: { usage?: unknown; tries?: number; timing?: ModelCallTiming },
      at?: number,
    ) => void;
    /** A request that turned out to be no model call: counted nowhere. */
    drop: () => void;
  } {
    const idle = this.live === 0 && this.answeredAt !== undefined;
    const gapMs = idle ? whole(at - this.answeredAt!) : undefined;
    const entry: WorkerCall = {
      at: Math.round(at - this.acceptedAt),
      live: this.live,
      ...(gapMs !== undefined ? { gapMs } : {}),
    };
    this.live++;
    let ended = false;
    return {
      drop: () => {
        if (ended) return;
        ended = true;
        this.live--;
      },
      prepared: (when = Date.now()) => {
        const prepMs = whole(when - at);
        if (prepMs !== undefined) entry.prepMs = prepMs;
      },
      done: (outcome, when = Date.now()) => {
        if (ended) return;
        ended = true;
        this.live--;
        this.answeredAt = when;
        this.value.phases.lastAnswer = Math.round(when - this.acceptedAt);
        const ms = whole(when - at);
        if (ms !== undefined) entry.ms = ms;
        const tries = whole(outcome.tries, 1000);
        if (tries !== undefined && tries > 1) entry.tries = tries;
        const usage = isRecord(outcome.usage) ? outcome.usage : undefined;
        if (!usage) entry.failed = true;
        const tokens = (value: unknown) => whole(value, Number.MAX_SAFE_INTEGER);
        const counts = {
          inputTokens: tokens(usage?.input_tokens),
          cachedTokens: tokens(usage?.cache_read_input_tokens),
          outputTokens: tokens(usage?.output_tokens),
          thinkingTokens: tokens(
            isRecord(usage?.output_tokens_details)
              ? usage.output_tokens_details.thinking_tokens
              : undefined,
          ),
        };
        for (const [name, value] of Object.entries(counts))
          if (value !== undefined) entry[name as keyof typeof counts] = value;
        const timing = outcome.timing;
        if (timing) {
          entry.slot = whole(timing.slot, 16) ?? 0;
          if (timing.laneMoved === true) entry.laneMoved = true;
          if (
            timing.waitedOn === 'this_process' ||
            timing.waitedOn === 'other_process' ||
            timing.waitedOn === 'unknown'
          )
            entry.waitedOn = timing.waitedOn;
          for (const name of [...CALL_TIMES, 'fetches', 'requestBytes', 'outputCap'] as const) {
            const value = whole(timing[name], Number.MAX_SAFE_INTEGER);
            if (value !== undefined) entry[name] = value;
          }
        }
        const totals = this.value.callTotals;
        totals.count = (totals.count ?? 0) + 1;
        for (const name of ['ms', 'gapMs', 'prepMs', 'outputTokens', ...CALL_TIMES] as const) {
          const value = entry[name];
          if (value !== undefined) totals[name] = (totals[name] ?? 0) + value;
        }
        if (entry.failed) totals.failed = (totals.failed ?? 0) + 1;
        if (this.value.calls.length < MAX_CALLS) this.value.calls.push(entry);
      },
    };
  }

  /** The SDK's `init` message: the model, tools and MCP servers the run has. */
  init(message: { model?: unknown; tools?: unknown; mcp_servers?: unknown }): void {
    if (typeof message.model === 'string') this.value.model = message.model.slice(0, 200);
    this.value.tools = names(message.tools).slice(0, MAX_NAMES);
    this.value.mcpServers = (Array.isArray(message.mcp_servers) ? message.mcp_servers : [])
      .slice(0, MAX_NAMES)
      .flatMap((s: { name?: unknown; status?: unknown }) =>
        typeof s?.name === 'string'
          ? [{ name: s.name.slice(0, 200), status: String(s.status ?? '').slice(0, 40) }]
          : [],
      );
  }

  /** One request the bridge received from the worker's Claude Code. */
  request(raw: Record<string, unknown>, sent: Record<string, unknown> = raw): void {
    // The thinking mode and the output cap are those of the request as it was SENT, which
    // the router and DeepSeek read, not what Claude Code asked for. The history is the
    // worker's own.
    const cap = sent.max_tokens;
    if (typeof cap === 'number' && Number.isSafeInteger(cap))
      this.value.settings.maxOutputTokens = Math.max(this.value.settings.maxOutputTokens ?? 0, cap);
    const thinking = (sent.thinking as { type?: unknown } | undefined)?.type;
    if (typeof thinking === 'string' && !this.value.settings.thinking.includes(thinking))
      this.value.settings.thinking = [...this.value.settings.thinking, thinking.slice(0, 40)];
    const turns = (Array.isArray(raw.messages) ? raw.messages : []).filter(
      (m: { role?: unknown }) => m?.role === 'assistant',
    );
    const reasoning = { turns: turns.length, withThinking: 0, textTurns: 0, textWithThinking: 0 };
    for (const turn of turns) {
      const kinds = blocks(turn).map((b) => b.type);
      const thought = kinds.includes('thinking') || kinds.includes('redacted_thinking');
      if (thought) reasoning.withThinking++;
      if (!kinds.includes('tool_use')) {
        reasoning.textTurns++;
        if (thought) reasoning.textWithThinking++;
      }
    }
    this.value.reasoning = reasoning;
  }

  /** The image and document blocks the job sent as text: how many the worker did not see. */
  omitted(count: number): void {
    const value = whole(count, MAX_CALLS * 64);
    if (value !== undefined) this.value.omitted = value;
  }

  /** A repeat reminder that fired: which tool, at which count. */
  repeat(tool: string, count: number | undefined): void {
    if (count === undefined || this.value.repeats.length >= MAX_REPEATS) return;
    this.value.repeats.push({ tool: tool.slice(0, 200), count });
  }

  /** Times from the accept on: the accept's own time and the marks made before the run. */
  accepted(at: number, marks: Record<string, number> = {}): void {
    // A worker started at offer time marked its start before the accept: those phases
    // are moved to count from the accept too, so they read negative.
    for (const name of Object.keys(this.value.phases))
      this.value.phases[name] = this.value.phases[name]! + Math.round(this.acceptedAt - at);
    for (const name of Object.keys(this.value.childMarks))
      this.value.childMarks[name] = this.value.childMarks[name]! + Math.round(this.acceptedAt - at);
    for (const call of this.value.calls) call.at += Math.round(this.acceptedAt - at);
    this.acceptedAt = at;
    for (const [name, when] of Object.entries(marks).slice(0, 16)) this.mark(name, when);
  }

  /** A start phase reached, once: milliseconds since the accept. */
  mark(name: string, at = Date.now()): void {
    if (name in this.value.phases || Object.keys(this.value.phases).length >= MAX_PHASES) return;
    this.value.phases[name.slice(0, 40)] = Math.round(at - this.acceptedAt);
  }

  /** A start-up checkpoint of the child, once: milliseconds since the accept. */
  childMark(name: string, at = Date.now()): void {
    const marks = this.value.childMarks;
    if (name in marks || Object.keys(marks).length >= MAX_PHASES) return;
    marks[name.slice(0, 40)] = Math.round(at - this.acceptedAt);
  }

  /** A model call tried again: which try failed, and why (fixed codes). */
  retry(attempt: number, failure: { cause: string; status?: number; code?: string }): void {
    if (this.value.retries.length >= MAX_REPEATS) return;
    this.value.retries.push({
      attempt,
      cause: failure.cause.slice(0, 40),
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      ...(failure.code !== undefined && /^[a-z][a-z0-9_]{0,63}$/.test(failure.code)
        ? { code: failure.code }
        : {}),
    });
  }

  /** The SDK's result message: its subtype, turn count and stop reason. */
  stop(result: { subtype?: unknown; num_turns?: unknown; stop_reason?: unknown }): void {
    if (typeof result.subtype !== 'string') return;
    this.value.stop = {
      subtype: result.subtype.slice(0, 80),
      ...(Number.isSafeInteger(result.num_turns) ? { turns: Number(result.num_turns) } : {}),
      ...(typeof result.stop_reason === 'string'
        ? { stopReason: result.stop_reason.slice(0, 80) }
        : {}),
    };
  }

  snapshot(): WorkerDiagnostics {
    return structuredClone(this.value);
  }

  /** Writes the record beside the job's own. Never throws: diagnostics change nothing. */
  async write(dataDir: string, jobId: string): Promise<void> {
    try {
      const head = await run('git', ['-C', this.value.root, 'rev-parse', 'HEAD'], {
        timeout: 2000,
      }).catch(() => undefined);
      const commit = head?.stdout.trim();
      if (commit && /^[0-9a-f]{40,64}$/.test(commit)) this.value.commit = commit;
      const path = join(dataDir, 'model-jobs', `${jobId}.diagnostics.json`);
      // The capture wrote the time before the offer into this file: kept, and its two
      // ends are counted from the accept beside the other phases.
      const kept = await readJsonFile(path, 1_000_000).catch(() => null);
      const offer = isRecord(kept) && isRecord(kept.offer) ? (kept.offer as OfferTiming) : null;
      if (offer && typeof offer.at === 'number') {
        this.value.offer = offer;
        this.mark('offerCaptured', offer.at);
        if (typeof offer.marks?.returned === 'number')
          this.mark('offerReturned', offer.at + offer.marks.returned);
      }
      await writeFileAtomic(path, JSON.stringify(this.value), { mode: 0o600, dirMode: 0o700 });
    } catch {
      // A record that cannot be written leaves the job as it is.
    }
  }
}
