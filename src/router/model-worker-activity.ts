import { isAbsolute, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { mask } from '../lib/redact';
import { canonicalHash } from '../lib/request-schema';

const MAX_ROWS = 128;
const MAX_BYTES = 128 * 1024;
const MAX_FIELD_BYTES = 1024;
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
    nativeProfile: z.enum(['general-purpose', 'Explore']),
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
  outputPreview?: string;
  elapsedSeconds?: number;
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
  /** The latest worker turn's input, cache and output tokens, as a native
   * subagent counts its own: one turn's usage, never a running sum. */
  tokens: number;
  /** While running, what has settled so far; once terminal, the controller's final accounting. */
  spend?: ModelWorkerActivitySpend;
};

/** What `subagent_activity` answers and the progress file holds: display data only. */
export function activityAnswer(
  snapshot: ModelWorkerActivitySnapshot,
  options: { rows: boolean; maxRows?: number },
) {
  const rows = !options.rows
    ? undefined
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
        ? { droppedRows: snapshot.droppedRows + snapshot.rows.length - rows.length, rows }
        : {}),
      ...(snapshot.spend ? { spend: snapshot.spend } : {}),
    },
  };
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

  running(generation = this.value.binding.generation): void {
    if (!this.current(generation) || this.value.state !== 'starting') return;
    this.value.state = 'running';
    this.value.started = true;
    this.value.sequence++;
    this.boundSnapshot();
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
        const tokens = usageTokens(msg.usage);
        if (tokens !== undefined && tokens !== this.value.tokens) {
          this.value.tokens = tokens;
          this.value.sequence++;
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
            });
          } else if (block.type === 'text' && typeof block.text === 'string') {
            const text = preview(block.text);
            const key = 'text:' + canonicalHash([messageId, text]);
            if (text && this.remember('block:' + key))
              this.add({ id: key, kind: 'text', state: 'completed', text });
          }
        }
      } else if (event.type === 'user') {
        const msg = object(event.message);
        if (!msg || !Array.isArray(msg.content)) return;
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
        for (const field of ['text', 'inputSummary', 'outputPreview'] as const) {
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
  }

  private add(row: Omit<ModelWorkerActivityRow, 'sequence'>): void {
    this.value.rows.push({ ...row, sequence: ++this.value.sequence });
    this.boundSnapshot();
  }

  private boundSnapshot(): void {
    try {
      let serialized = JSON.stringify(this.value);
      while (this.value.rows.length > MAX_ROWS || Buffer.byteLength(serialized) > MAX_BYTES) {
        if (!this.value.rows.length) return;
        this.value.rows.shift();
        this.value.droppedRows++;
        serialized = JSON.stringify(this.value);
      }
    } catch {
      // Never change the execution result because a display snapshot is unavailable.
    }
  }
}
