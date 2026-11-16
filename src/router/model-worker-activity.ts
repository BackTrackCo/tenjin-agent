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
  droppedRows: number;
  rows: ModelWorkerActivityRow[];
  spend?: ModelWorkerActivitySpend;
};

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
      droppedRows: 0,
      rows: [],
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
    if (parsed.success) this.value.spend = parsed.data;
    for (const row of this.value.rows) {
      if (row.state === 'running') row.state = state === 'completed' ? 'unknown' : state;
    }
    this.boundSnapshot();
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
