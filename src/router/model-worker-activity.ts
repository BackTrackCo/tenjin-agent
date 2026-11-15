import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { mask } from '../lib/redact';
import { canonicalHash } from '../lib/request-schema';
import { withFileLock } from '../lib/lock';
import { PRIVATE, readJsonFile, writePrivate } from './store-files';

const MAX_ROWS = 128;
const MAX_BYTES = 128 * 1024;
const MAX_FIELD_BYTES = 1024;
const MAX_SEEN = 1024;
const latestWriters = new Map<string, { token: symbol; generation: string }>();
const writeTails = new Map<string, Promise<void>>();
const id = z.string().min(1).max(200);
const displayField = z
  .string()
  .max(MAX_FIELD_BYTES)
  .refine((value) => Buffer.byteLength(value) <= MAX_FIELD_BYTES);
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
const stateSchema = z.enum(['starting', 'running', 'completed', 'cancelled', 'unknown']);
const rowSchema = z
  .object({
    id,
    sequence: z.number().int().nonnegative(),
    kind: z.enum(['text', 'tool', 'status', 'compaction']),
    state: z.enum(['running', 'completed', 'error', 'cancelled', 'unknown']),
    text: displayField.optional(),
    name: z.string().max(120).optional(),
    inputSummary: displayField.optional(),
    outputPreview: displayField.optional(),
    elapsedSeconds: z.number().nonnegative().finite().optional(),
  })
  .strict();
export type ModelWorkerActivityRow = z.infer<typeof rowSchema>;
const spendSchema = z
  .object({
    reservedAtomic: z.string().regex(/^\d{1,30}$/),
    actualAtomic: z.string().regex(/^\d{1,30}$/),
    uncertain: z.array(id).max(128),
  })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    binding: bindingSchema,
    sequence: z.number().int().nonnegative(),
    state: stateSchema,
    droppedRows: z.number().int().nonnegative(),
    rows: z.array(rowSchema).max(MAX_ROWS),
    spend: spendSchema.optional(),
  })
  .strict();
export type ModelWorkerActivitySnapshot = z.infer<typeof snapshotSchema>;
export type ModelWorkerActivitySpend = z.infer<typeof spendSchema>;

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

function activityPath(dataDir: string, binding: ModelWorkerActivityBinding): string {
  const { parentSessionId, root, configDir, workerHandle } = binding;
  return join(
    dataDir,
    'model-worker-activity',
    canonicalHash({ parentSessionId, root, configDir, workerHandle }) + '.json',
  );
}

async function serializeWrite(path: string, write: () => Promise<void>): Promise<void> {
  const previous = writeTails.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  writeTails.set(path, next);
  try {
    await next;
  } finally {
    if (writeTails.get(path) === next) writeTails.delete(path);
  }
}

/** Read only an exact controller-owned activation, never an arbitrary session or transcript path. */
export async function readModelWorkerActivity(
  dataDir: string,
  binding: ModelWorkerActivityBinding,
): Promise<ModelWorkerActivitySnapshot | null> {
  try {
    const expected = validBinding(binding);
    const path = activityPath(dataDir, expected);
    const active = latestWriters.get(path);
    if (active && active.generation !== expected.generation) return null;
    const parsed = snapshotSchema.safeParse(await readJsonFile(path, MAX_BYTES));
    if (!parsed.success || canonicalHash(parsed.data.binding) !== canonicalHash(expected))
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** A private, bounded display projection. No observation failure affects worker execution. */
export class ModelWorkerActivity {
  private value: ModelWorkerActivitySnapshot;
  private seen = new Set<string>();
  private queued: string | undefined;
  private writing: Promise<void> | undefined;
  private readonly path: string;
  private readonly writerToken = Symbol();
  private readonly write: (path: string, data: string) => Promise<void>;
  private readonly isCurrentBinding: () => Promise<boolean>;

  constructor(options: {
    dataDir: string;
    binding: ModelWorkerActivityBinding;
    write?: (path: string, data: string) => Promise<void>;
    /** Controller-owned current-conversation check; observation never acquires financial locks. */
    isCurrentBinding?: () => Promise<boolean>;
  }) {
    this.value = {
      version: 1,
      binding: validBinding(options.binding),
      sequence: 0,
      state: 'starting',
      droppedRows: 0,
      rows: [],
    };
    this.path = activityPath(options.dataDir, this.value.binding);
    this.write = options.write ?? writePrivate;
    this.isCurrentBinding = options.isCurrentBinding ?? (async () => true);
    latestWriters.delete(this.path);
    latestWriters.set(this.path, {
      token: this.writerToken,
      generation: this.value.binding.generation,
    });
    if (latestWriters.size > 128) latestWriters.delete(latestWriters.keys().next().value!);
    this.publish();
  }

  snapshot(): ModelWorkerActivitySnapshot {
    return structuredClone(this.value);
  }

  running(generation = this.value.binding.generation): void {
    if (!this.current(generation) || this.value.state !== 'starting') return;
    this.value.state = 'running';
    this.value.sequence++;
    this.publish();
  }

  /** Only the controller supplies terminal state and authoritative payment accounting. */
  finish(
    state: 'completed' | 'cancelled' | 'unknown',
    spend?: ModelWorkerActivitySpend,
    generation = this.value.binding.generation,
  ): void {
    // A completed controller may finish after a new resume owns the disk projection.
    // Its old in-memory row must still end; it may never overwrite the newer file.
    if (generation !== this.value.binding.generation || this.terminal()) return;
    this.value.state = state;
    this.value.sequence++;
    const parsed = spendSchema.safeParse(spend);
    if (parsed.success) this.value.spend = parsed.data;
    for (const row of this.value.rows) {
      if (row.state === 'running') row.state = state === 'completed' ? 'unknown' : state;
    }
    this.publish();
  }

  /** SDK messages stay in memory; only an allowlisted, redacted projection is persisted. */
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
          this.publish();
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
        this.publish();
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
      latestWriters.get(this.path)?.token === this.writerToken
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
    this.publish();
  }

  private publish(): void {
    try {
      if (!this.current()) return;
      let serialized = JSON.stringify(this.value);
      while (this.value.rows.length > MAX_ROWS || Buffer.byteLength(serialized) > MAX_BYTES) {
        if (!this.value.rows.length) return;
        this.value.rows.shift();
        this.value.droppedRows++;
        serialized = JSON.stringify(this.value);
      }
      this.queued = serialized;
      this.pump();
    } catch {
      // Never change the execution result because a display snapshot is unavailable.
    }
  }

  private pump(): void {
    if (this.writing) return;
    this.writing = (async () => {
      while (this.queued !== undefined) {
        const data = this.queued;
        this.queued = undefined;
        try {
          if (!this.current()) continue;
          await serializeWrite(this.path, async () => {
            if (!this.current()) return;
            await mkdir(dirname(this.path), { recursive: true, mode: PRIVATE.dirMode });
            // Display-only per-worker locks; never wallet/job financial locks.
            await withFileLock(
              this.path + '.lock',
              async () => {
                if (!this.current() || !(await this.isCurrentBinding()) || !this.current()) return;
                await this.write(this.path, data);
              },
              { timeoutMs: 500 },
            );
          });
        } catch {
          // A later observation can repair display persistence; there is no worker retry.
        }
      }
    })().finally(() => {
      this.writing = undefined;
      if (this.queued !== undefined) this.pump();
    });
  }

  /** For shutdown/tests only; the inference loop never waits for the viewer. */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
  }
}
