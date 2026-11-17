import { isAbsolute, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { mask } from '../lib/redact';
import { canonicalHash } from '../lib/request-schema';
import { WORKER_ENDS } from './model-worker-control';

const MAX_ROWS = 128;
const MAX_BYTES = 128 * 1024;
const MAX_FIELD_BYTES = 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_SEEN = 1024;
const latestActivations = new Map<string, symbol>();
const id = z.string().min(1).max(200);
const location = z.string().min(1).max(2000).refine(isAbsolute);
const bindingSchema = z
  .object({
    parentSessionId: id,
    root: location,
    configDir: location,
    offerId: z.uuid(),
    workerHandle: z
      .string()
      .refine(
        (value) =>
          value.startsWith('tenjin-worker-') &&
          z.uuid().safeParse(value.slice('tenjin-worker-'.length)).success,
      ),
    // The agent type the worker runs as, a custom one too; a plugin's (`a:b`) is never offered.
    nativeProfile: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/),
    continuationId: z.uuid(),
    sdkSessionId: z.uuid(),
    generation: id,
  })
  .strict();
export type ModelWorkerActivityBinding = z.infer<typeof bindingSchema>;
export type ModelWorkerActivityRow = {
  id: string;
  sequence: number;
  kind: 'text' | 'tool' | 'status' | 'compaction';
  state: 'running' | 'completed' | 'error' | 'cancelled' | 'unknown';
  text?: string;
  name?: string;
  inputSummary?: string;
  /** A shell call's command, masked and bounded: for the local display, never a handback. */
  command?: string;
  outputPreview?: string;
  elapsedSeconds?: number;
  /** Which worker reply the row belongs to, so the viewer draws each reply as one step. */
  message?: string;
  /** A file read's line count, as Claude Code reports it: the viewer's `Read N lines`. */
  lines?: number;
  /** A web call's URL or query, masked and bounded: for the local display, never a handback. */
  target?: string;
  /** A web call's own figures from Claude Code's record, for the viewer's native line. */
  figures?: ModelWorkerActivityFigures;
  /** The router tool that served the call (`Exa search`, `Exa page read`), as its rows name it. */
  via?: string;
};
export type ModelWorkerActivityFigures = {
  bytes?: number;
  code?: number;
  codeText?: string;
  durationMs?: number;
  searchCount?: number;
  durationSeconds?: number;
};
const spendSchema = z
  .object({
    reservedAtomic: z.string().regex(/^\d{1,30}$/),
    actualAtomic: z.string().regex(/^\d{1,30}$/),
    uncertain: z.array(id).max(128),
  })
  .strict();
export type ModelWorkerActivitySpend = z.infer<typeof spendSchema>;
export type ModelWorkerActivitySnapshot = {
  version: 1;
  binding: ModelWorkerActivityBinding;
  sequence: number;
  state: 'starting' | 'running' | 'completed' | 'cancelled' | 'unknown';
  /** Whether the worker's Claude Code ever started: an ended job that never did ran nothing. */
  started: boolean;
  droppedRows: number;
  rows: ModelWorkerActivityRow[];
  /** Tool calls the worker made, counted past the bounded rows. */
  toolUses: number;
  /** As a native subagent's row counts its own: the latest request's input (cache
   * included) and all its output so far. It never goes down. */
  tokens: number;
  /** While running, what has settled so far; once terminal, the controller's final accounting. */
  spend?: ModelWorkerActivitySpend;
  /** A completed worker's answer, as the parent receives it, for the viewer's transcript. */
  result?: string;
};

/** What `subagent_activity` answers and the progress file holds: display data only. */
export function activityAnswer(
  snapshot: ModelWorkerActivitySnapshot,
  options: { rows: boolean; maxRows?: number; result?: boolean; after?: number },
) {
  const after = options.after;
  const rows = !options.rows
    ? undefined
    : after !== undefined
      ? // Only what changed since the reader's last sequence: a new row, or one whose state moved.
        snapshot.rows.filter((row) => row.sequence > after)
      : options.maxRows === undefined
        ? snapshot.rows
        : snapshot.rows.slice(-options.maxRows);
  return {
    status: 'activity' as const,
    activity: {
      version: snapshot.version,
      offerId: snapshot.binding.offerId,
      workerHandle: snapshot.binding.workerHandle,
      nativeProfile: snapshot.binding.nativeProfile,
      generation: snapshot.binding.generation,
      sequence: snapshot.sequence,
      state: snapshot.state,
      started: snapshot.started,
      toolUses: snapshot.toolUses,
      tokens: snapshot.tokens,
      ...(rows
        ? {
            droppedRows:
              after !== undefined
                ? snapshot.droppedRows
                : snapshot.droppedRows + snapshot.rows.length - rows.length,
            rows,
          }
        : {}),
      ...(snapshot.spend ? { spend: snapshot.spend } : {}),
      ...(options.result && snapshot.result !== undefined ? { result: snapshot.result } : {}),
    },
  };
}

/**
 * How an ended job ended, as its row shows it: from the job's state and the
 * handback kept for it (the completed envelope or the stopped one). Its status,
 * own time, counts and spend only, never the assignment or the result. Undefined
 * while the job has not ended.
 */
export function endedDisplay(state: string, kept: string | null | undefined) {
  if (state !== 'completed' && state !== 'cancelled' && state !== 'unknown') return undefined;
  let handback: Record<string, unknown> = {};
  try {
    handback = object(JSON.parse(kept ?? '{}')) ?? {};
  } catch {
    // A record with no readable handback still says how it ended.
  }
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const [elapsedMs, toolUses, tokens] = [
    handback.elapsedMs,
    handback.toolUses,
    handback.tokens,
  ].map(count);
  const spend = spendSchema.safeParse(handback.spend);
  const endedBy = Object.keys(WORKER_ENDS).find((code) => code === handback.endedBy);
  return {
    // The handback's own word for a stop the job's state calls `unknown`.
    status:
      state === 'unknown' && (handback.status === 'not_started' || handback.status === 'stopped')
        ? handback.status
        : state,
    ...(endedBy ? { endedBy } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(spend.success ? { spend: spend.data } : {}),
  };
}

function outputTokens(value: unknown): number | undefined {
  const count = object(value)?.output_tokens;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

/** One turn's usage as a native subagent's token count reads it, or undefined. */
function usageTokens(value: unknown): number | undefined {
  const usage = object(value);
  if (!usage || (typeof usage.input_tokens !== 'number' && typeof usage.output_tokens !== 'number'))
    return undefined;
  let total = 0;
  for (const key of [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
    'output_tokens',
  ]) {
    const count = usage[key];
    if (count === undefined || count === null) continue;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
    total += count;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

const PARTIAL_ROWS = 24;
const PARTIAL_BYTES = 24 * 1024;
export type ModelWorkerPartial = {
  lastText?: string;
  rows: Omit<ModelWorkerActivityRow, 'id' | 'sequence' | 'elapsedSeconds'>[];
  omittedRows: number;
};

/** What a stopped worker hands its parent: its last text and latest rows, from the
 * already bounded and redacted display projection. Absent when it did nothing. */
export function partialHandback(
  snapshot: ModelWorkerActivitySnapshot | null | undefined,
): ModelWorkerPartial | undefined {
  if (!snapshot?.rows.length) return undefined;
  const lastText = [...snapshot.rows]
    .reverse()
    .find((row) => row.kind === 'text' && row.text)?.text;
  const rows = snapshot.rows
    .slice(-PARTIAL_ROWS)
    .map(({ kind, state, name, text, inputSummary, outputPreview }) => ({
      kind,
      state,
      ...(name ? { name } : {}),
      ...(text ? { text } : {}),
      ...(inputSummary ? { inputSummary } : {}),
      ...(outputPreview ? { outputPreview } : {}),
    }));
  let omittedRows = snapshot.droppedRows + snapshot.rows.length - rows.length;
  const size = () => Buffer.byteLength(JSON.stringify({ lastText, rows }));
  while (rows.length > 1 && size() > PARTIAL_BYTES) {
    rows.shift();
    omittedRows++;
  }
  return { ...(lastText ? { lastText } : {}), rows, omittedRows };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Bounds display data only. The SDK remains the owner of complete execution history. */
function preview(value: string): string {
  // Never run the pattern corpus over an unbounded provider string.
  if (value.length > 64 * 1024) return '[large content omitted from activity]';
  const terminalSafe = stripVTControlCharacters(value).replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    '',
  );
  const safe = mask(terminalSafe);
  const bytes = Buffer.from(safe);
  if (bytes.length <= MAX_FIELD_BYTES) return safe;
  // Decode a complete UTF-8 prefix; a replacement character is harmless display data.
  return bytes.subarray(0, MAX_FIELD_BYTES - 24).toString('utf8') + ' [preview shortened]';
}

const SECRET_FIELD = /pass|token|secret|auth|cookie|credential|private.?key|api.?key|headers?|env/i;
const PATH_FIELD = /^(?:file_path|path|directory|cwd|root)$/;
function inputSummary(value: unknown): string {
  const input = object(value);
  if (!input) return '[input omitted]';
  const fields: Record<string, string | number | boolean | null> = {};
  for (const [key, field] of Object.entries(input).slice(0, 12)) {
    // Field names and values can both be untrusted; secret-named fields carry no value.
    const name = preview(key).slice(0, 80);
    if (SECRET_FIELD.test(key)) fields[name] = '[hidden]';
    else if (
      PATH_FIELD.test(key) &&
      typeof field === 'string' &&
      (isAbsolute(field) || /^\.\.?\//.test(field))
    )
      fields[name] = preview(field);
    else if (typeof field === 'string') fields[name] = '[text: ' + field.length + ' chars]';
    else if (Array.isArray(field)) fields[name] = '[array: ' + field.length + ' items]';
    else if (field !== null && typeof field === 'object') fields[name] = '[object]';
    else if (typeof field === 'number' && Number.isFinite(field)) fields[name] = field;
    else if (typeof field === 'boolean' || field === null) fields[name] = field;
    else fields[name] = '[value omitted]';
  }
  return preview(JSON.stringify(fields));
}

/** A native row names a shell call by its command; the caller has replaced the job's secrets in it. */
function shellCommand(value: unknown): { command?: string } {
  const command = object(value)?.command;
  return typeof command === 'string' && command ? { command: preview(command) } : {};
}

/** What a native row names a web call by: a fetch's URL, a search's query. */
function webTarget(name: string, value: unknown): { target?: string } {
  const input = object(value);
  const field = name === 'WebFetch' ? input?.url : name === 'WebSearch' ? input?.query : undefined;
  return typeof field === 'string' && field ? { target: preview(field) } : {};
}

/** A tool's own figures, never its content: `Read N lines`, `Received 12KB (200 OK)`, `Did 1 search in 3s`. */
function figuresOf(name: string | undefined, record: Record<string, unknown> | null) {
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
  const amount = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  if (!record) return {};
  if (name === 'Read') {
    const lines = count(object(record.file)?.numLines);
    return lines === undefined ? {} : { lines };
  }
  const figures: ModelWorkerActivityFigures =
    name === 'WebFetch'
      ? {
          bytes: count(record.bytes),
          code: count(record.code),
          codeText:
            typeof record.codeText === 'string' ? preview(record.codeText).slice(0, 64) : undefined,
          durationMs: amount(record.durationMs),
        }
      : name === 'WebSearch'
        ? {
            searchCount: count(record.searchCount),
            durationSeconds: amount(record.durationSeconds),
          }
        : {};
  const known = Object.fromEntries(Object.entries(figures).filter(([, v]) => v !== undefined));
  return Object.keys(known).length ? { figures: known as ModelWorkerActivityFigures } : {};
}

function toolPreview(value: unknown): string | undefined {
  if (typeof value === 'string') return preview(value);
  if (!Array.isArray(value)) return undefined;
  return preview(
    value
      .slice(0, 8)
      .flatMap((raw) => {
        const block = object(raw);
        return block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
      })
      .join('\n'),
  );
}

function validBinding(binding: ModelWorkerActivityBinding): ModelWorkerActivityBinding {
  const parsed = bindingSchema.parse(binding);
  if (resolve(parsed.root) !== parsed.root || resolve(parsed.configDir) !== parsed.configDir)
    throw new Error('Worker activity requires the canonical owned workspace binding');
  return parsed;
}

/** A private, bounded display projection. No observation failure affects worker execution. */
export class ModelWorkerActivity {
  private value: ModelWorkerActivitySnapshot;
  private seen = new Set<string>();
  private listeners = new Set<() => void>();
  /** Each reply's output tokens, the largest seen for it. */
  private output = new Map<string, number>();
  private holding = false;
  private held = false;
  /** Calls a router tool served, by row id, until their rows have settled. */
  private servedBy = new Map<string, Pick<ModelWorkerActivityRow, 'via' | 'figures'>>();
  private readonly key: string;
  private readonly activationToken = Symbol();

  constructor(options: {
    /** In-memory namespace only; activity never reads or writes this directory. */
    dataDir: string;
    binding: ModelWorkerActivityBinding;
  }) {
    this.value = {
      version: 1,
      binding: validBinding(options.binding),
      sequence: 0,
      state: 'starting',
      started: false,
      droppedRows: 0,
      rows: [],
      toolUses: 0,
      tokens: 0,
    };
    const { parentSessionId, root, configDir, workerHandle } = this.value.binding;
    this.key = canonicalHash({
      dataDir: resolve(options.dataDir),
      parentSessionId,
      root,
      configDir,
      workerHandle,
    });
    latestActivations.delete(this.key);
    latestActivations.set(this.key, this.activationToken);
    if (latestActivations.size > 128)
      latestActivations.delete(latestActivations.keys().next().value!);
  }

  snapshot(): ModelWorkerActivitySnapshot {
    return structuredClone(this.value);
  }

  /** Calls `listener` after the activity changes. Display only; returns its removal. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    if (this.holding) {
      this.held = true;
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A display reader never changes the worker.
      }
    }
  }

  running(generation = this.value.binding.generation): void {
    if (!this.current(generation) || this.value.state !== 'starting') return;
    this.value.state = 'running';
    this.value.started = true;
    this.value.sequence++;
    this.boundSnapshot();
  }

  /** The completed worker's answer, set by the controller just before it finishes the job. */
  handback(result: string, generation = this.value.binding.generation): void {
    if (generation !== this.value.binding.generation || this.terminal()) return;
    const bytes = Buffer.from(result);
    this.value.result =
      bytes.length <= MAX_RESULT_BYTES
        ? result
        : bytes.subarray(0, MAX_RESULT_BYTES).toString('utf8') + ' [shortened]';
  }

  /** Only the controller supplies terminal state and authoritative payment accounting. */
  finish(
    state: 'completed' | 'cancelled' | 'unknown',
    spend?: ModelWorkerActivitySpend,
    generation = this.value.binding.generation,
  ): void {
    // A completed controller may finish after a resume owns the current activation.
    // Its old row must still end without changing the newer activation.
    if (generation !== this.value.binding.generation || this.terminal()) return;
    this.value.state = state;
    this.value.sequence++;
    const parsed = spendSchema.safeParse(spend);
    // A running figure never stands in for final accounting the controller could not read.
    if (parsed.success) this.value.spend = parsed.data;
    else delete this.value.spend;
    for (const row of this.value.rows) {
      if (row.state === 'running') row.state = state === 'completed' ? 'unknown' : state;
    }
    this.boundSnapshot();
  }

  /**
   * What has settled so far while the worker runs, read from the job's own
   * accounting. Display only: it never changes what is charged, reserved or settled.
   */
  spending(spend: unknown, generation = this.value.binding.generation): void {
    try {
      if (!this.current(generation) || this.terminal()) return;
      const parsed = spendSchema.safeParse(spend);
      if (!parsed.success) return;
      if (this.value.spend && canonicalHash(this.value.spend) === canonicalHash(parsed.data))
        return;
      this.value.spend = parsed.data;
      this.value.sequence++;
      this.boundSnapshot();
    } catch {
      // A display figure is optional.
    }
  }

  /** The SDK owns complete history; this retains only bounded, redacted display data. */
  observe(message: unknown, generation = this.value.binding.generation): void {
    // One message is one change: a reader wakes once, with every row it made.
    this.holding = true;
    try {
      this.observeOne(message, generation);
    } finally {
      this.holding = false;
      if (this.held) {
        this.held = false;
        this.changed();
      }
    }
  }

  private observeOne(message: unknown, generation: string): void {
    try {
      if (!this.current(generation) || this.terminal()) return;
      const event = object(message);
      if (!event || event.session_id !== this.value.binding.sdkSessionId) return;
      // Partial frames are followed by complete blocks; ignoring them avoids duplicates and thinking.
      if (!['assistant', 'user', 'tool_progress', 'system'].includes(String(event.type))) return;
      if (
        typeof event.uuid === 'string' &&
        (event.uuid.length > 200 || !this.remember('event:' + canonicalHash(event.uuid)))
      )
        return;
      if (event.type === 'assistant') {
        if (event.error) return;
        const msg = object(event.message);
        if (!msg || !Array.isArray(msg.content)) return;
        const messageId = typeof msg.id === 'string' ? msg.id.slice(0, 200) : event.uuid;
        const message = canonicalHash(messageId ?? null).slice(0, 16);
        // AS A NATIVE SUBAGENT'S ROW COUNTS: the latest request's input and all output so
        // far, and never down. Each content block of one reply arrives with that reply's
        // usage as it then stood, and a reply's input can be smaller than the one before
        // (compaction), so the turn's own sum moved up and down.
        const usage = usageTokens(msg.usage);
        const output = outputTokens(msg.usage);
        if (usage !== undefined && output !== undefined && typeof messageId === 'string') {
          this.output.set(messageId, Math.max(this.output.get(messageId) ?? 0, output));
          if (this.output.size > MAX_SEEN) this.output.delete(this.output.keys().next().value!);
        }
        const outputs = [...this.output.values()].reduce((sum, n) => sum + n, 0);
        const tokens =
          usage === undefined
            ? undefined
            : Math.max(this.value.tokens, usage - (output ?? 0) + outputs);
        if (tokens !== undefined && tokens !== this.value.tokens) {
          this.value.tokens = tokens;
          this.value.sequence++;
          this.changed();
        }
        for (const raw of msg.content.slice(0, 64)) {
          const block = object(raw);
          if (!block) continue;
          if (
            block.type === 'tool_use' &&
            typeof block.id === 'string' &&
            block.id.length <= 200 &&
            typeof block.name === 'string'
          ) {
            const key = 'tool:' + canonicalHash(block.id);
            if (!this.remember('block:' + key)) continue;
            this.value.toolUses++;
            this.add({
              id: key,
              kind: 'tool',
              state: 'running',
              name: preview(block.name).slice(0, 120),
              inputSummary: inputSummary(block.input),
              ...shellCommand(block.input),
              ...webTarget(block.name, block.input),
              message,
            });
          } else if (block.type === 'text' && typeof block.text === 'string') {
            const text = preview(block.text);
            const key = 'text:' + canonicalHash([messageId, text]);
            if (text && this.remember('block:' + key))
              this.add({ id: key, kind: 'text', state: 'completed', text, message });
          }
        }
      } else if (event.type === 'user') {
        const msg = object(event.message);
        if (!msg || !Array.isArray(msg.content)) return;
        // Claude Code sends one tool result a message, with its own record beside it.
        const record = msg.content.length === 1 ? object(event.tool_use_result) : null;
        for (const raw of msg.content.slice(0, 64)) {
          const block = object(raw);
          if (
            block?.type !== 'tool_result' ||
            typeof block.tool_use_id !== 'string' ||
            block.tool_use_id.length > 200
          )
            continue;
          const key = 'tool:' + canonicalHash(block.tool_use_id);
          if (!this.remember('result:' + key)) continue;
          const row = this.value.rows.find((row) => row.id === key && row.kind === 'tool');
          if (!row) continue;
          row.state = block.is_error === true ? 'error' : 'completed';
          row.outputPreview =
            block.is_error === true
              ? 'Tool reported an error; inspect its native history for details.'
              : toolPreview(block.content);
          if (block.is_error !== true) Object.assign(row, figuresOf(row.name, record));
          this.applyServed(row);
          row.sequence = ++this.value.sequence;
          this.boundSnapshot();
        }
      } else if (
        event.type === 'tool_progress' &&
        typeof event.tool_use_id === 'string' &&
        event.tool_use_id.length <= 200
      ) {
        const row = this.value.rows.find(
          (row) => row.id === 'tool:' + canonicalHash(event.tool_use_id),
        );
        if (
          row?.state !== 'running' ||
          typeof event.elapsed_time_seconds !== 'number' ||
          !Number.isFinite(event.elapsed_time_seconds) ||
          event.elapsed_time_seconds < 0
        )
          return;
        if (row.elapsedSeconds !== undefined && event.elapsed_time_seconds <= row.elapsedSeconds)
          return;
        row.elapsedSeconds = event.elapsed_time_seconds;
        row.sequence = ++this.value.sequence;
        this.boundSnapshot();
      } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
        for (const row of this.value.rows)
          if (row.kind === 'status' && row.state === 'running') row.state = 'completed';
        this.add({
          id: 'compact:' + this.value.sequence,
          kind: 'compaction',
          state: 'completed',
          text: 'Native context compacted',
        });
      } else if (
        event.type === 'system' &&
        event.subtype === 'status' &&
        event.status === 'compacting'
      ) {
        if (
          this.value.rows.at(-1)?.kind === 'status' &&
          this.value.rows.at(-1)?.state === 'running'
        )
          return;
        this.add({
          id: 'status:' + this.value.sequence,
          kind: 'status',
          state: 'running',
          text: 'Native context compacting',
        });
      }
    } catch {
      // Activity is observational, including malformed provider data and failed redaction.
    }
  }

  private terminal(): boolean {
    return !['starting', 'running'].includes(this.value.state);
  }

  private current(generation = this.value.binding.generation): boolean {
    return (
      generation === this.value.binding.generation &&
      latestActivations.get(this.key) === this.activationToken
    );
  }

  private remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  /**
   * Applies a redaction learned after rows were made, such as the values of an
   * env file found late, so the viewer, progress file and partial lose them too.
   */
  rescrub(redact: (text: string) => string): void {
    try {
      for (const row of this.value.rows) {
        let changed = false;
        for (const field of [
          'text',
          'inputSummary',
          'command',
          'target',
          'outputPreview',
        ] as const) {
          const before = row[field];
          if (before === undefined) continue;
          const after = redact(before);
          if (after !== before) {
            row[field] = after;
            changed = true;
          }
        }
        if (changed) row.sequence = ++this.value.sequence;
      }
    } catch {
      // Display data only; the next forwarded request is redacted regardless.
    }
    this.changed();
  }

  private add(row: Omit<ModelWorkerActivityRow, 'sequence'>): void {
    const added = { ...row, sequence: ++this.value.sequence };
    this.applyServed(added);
    this.value.rows.push(added);
    this.boundSnapshot();
  }

  /**
   * A call a router tool served: a worker's WebSearch (Exa search, always), or a WebFetch
   * whose local fetch failed and Exa page read stood in for (its figures are then Exa's
   * page, not the failed fetch's). Display only; told by the worker's tool hooks, which
   * may run before the call's result is seen.
   */
  served(
    toolUseId: string,
    via: string,
    figures?: ModelWorkerActivityFigures,
    generation = this.value.binding.generation,
  ): void {
    try {
      if (!this.current(generation) || this.terminal() || toolUseId.length > 200) return;
      const key = 'tool:' + canonicalHash(toolUseId);
      this.servedBy.set(key, { via: preview(via).slice(0, 64), ...(figures ? { figures } : {}) });
      if (this.servedBy.size > MAX_ROWS) this.servedBy.delete(this.servedBy.keys().next().value!);
      const row = this.value.rows.find((row) => row.id === key && row.kind === 'tool');
      if (row && this.applyServed(row)) {
        row.sequence = ++this.value.sequence;
        this.boundSnapshot();
      }
    } catch {
      // Display only.
    }
  }

  private applyServed(row: ModelWorkerActivityRow): boolean {
    const served = this.servedBy.get(row.id);
    if (!served) return false;
    row.via = served.via;
    if (served.figures) {
      // The page Exa read is the call's result: the local fetch's failure is not shown.
      row.figures = served.figures;
      if (row.state === 'error') {
        row.state = 'completed';
        delete row.outputPreview;
      }
    }
    return true;
  }

  private boundSnapshot(): void {
    try {
      // The answer has a bound of its own: it never pushes rows out.
      const bounded = () => JSON.stringify({ ...this.value, result: undefined });
      let serialized = bounded();
      while (this.value.rows.length > MAX_ROWS || Buffer.byteLength(serialized) > MAX_BYTES) {
        if (!this.value.rows.length) return;
        this.value.rows.shift();
        this.value.droppedRows++;
        serialized = bounded();
      }
    } catch {
      // Never change the execution result because a display snapshot is unavailable.
    } finally {
      // Every change of the sequence ends here, so a reader waiting on a change wakes.
      this.changed();
    }
  }
}
