import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { writePrivate } from './store-files';
import {
  ModelWorkerActivity,
  readModelWorkerActivity,
  type ModelWorkerActivityBinding,
} from './model-worker-activity';

const directories: string[] = [];
const activities: ModelWorkerActivity[] = [];
afterEach(async () => {
  await Promise.all(activities.splice(0).map((activity) => activity.flush()));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.useRealTimers();
});

async function snapshotFile(dataDir: string) {
  const dir = join(dataDir, 'model-worker-activity');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
  expect(files).toHaveLength(1);
  return join(dir, files[0]!);
}

async function fixture(write?: (path: string, data: string) => Promise<void>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'tenjin-worker-activity-')));
  directories.push(dir);
  const dataDir = join(dir, 'data');
  const root = join(dir, 'repo');
  const configDir = join(dir, 'native');
  await Promise.all([root, configDir, dataDir].map((path) => mkdir(path)));
  const binding: ModelWorkerActivityBinding = {
    parentSessionId: randomUUID(),
    root,
    configDir,
    offerId: randomUUID(),
    workerHandle: 'tenjin-worker-' + randomUUID(),
    nativeProfile: 'general-purpose',
    continuationId: randomUUID(),
    sdkSessionId: randomUUID(),
    generation: randomUUID(),
  };
  const activity = new ModelWorkerActivity({ dataDir, binding, ...(write ? { write } : {}) });
  activities.push(activity);
  const event = (type: string, fields: Record<string, unknown> = {}) => ({
    type,
    uuid: randomUUID(),
    session_id: binding.sdkSessionId,
    ...fields,
  });
  const assistant = (content: unknown[], messageId: string = randomUUID()) =>
    event('assistant', { message: { id: messageId, content } });
  const tool = (
    toolId = 'read-one',
    name = 'Read',
    input: unknown = { file_path: join(root, 'index.ts') },
  ) => assistant([{ type: 'tool_use', id: toolId, name, input }]);
  const result = (toolId: string, content: unknown, isError = false) =>
    event('user', {
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolId, content, is_error: isError }],
      },
    });
  return { dir, dataDir, binding, activity, event, assistant, tool, result };
}

it('persists actual tool activity privately and updates a result without creating another row', async () => {
  const f = await fixture();
  f.activity.running();
  f.activity.observe(f.tool());
  f.activity.observe(
    f.event('tool_progress', { tool_use_id: 'read-one', elapsed_time_seconds: 2 }),
  );
  f.activity.observe(f.result('read-one', [{ type: 'text', text: 'export const answer = 42;' }]));
  await f.activity.flush();
  const read = await readModelWorkerActivity(f.dataDir, f.binding);
  expect(read?.state).toBe('running');
  expect(read?.rows).toMatchObject([
    {
      kind: 'tool',
      name: 'Read',
      state: 'completed',
      elapsedSeconds: 2,
      outputPreview: 'export const answer = 42;',
    },
  ]);
  expect(read?.rows[0]?.inputSummary).toContain(join(f.binding.root, 'index.ts'));
  if (process.platform !== 'win32') {
    const file = await snapshotFile(f.dataDir);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
  }
});

it('never persists thinking, authentication, system prompts, raw commands or secret input values', async () => {
  const f = await fixture();
  f.activity.observe(f.event('system', { subtype: 'init', system: 'private-system-prompt' }));
  f.activity.observe(f.event('auth_status', { output: ['private-auth-output'] }));
  f.activity.observe(
    f.assistant([
      { type: 'thinking', thinking: 'private-raw-thinking' },
      { type: 'text', text: 'Read the source. API_KEY="ActualPrivateValue987"' },
    ]),
  );
  f.activity.observe(
    f.tool('shell-one', 'Bash', {
      command: 'printf private-command-value',
      env: { DATABASE_PASSWORD: 'private-environment-value' },
      token: 873962,
      settings: { password: 'private-nested-value' },
    }),
  );
  f.activity.observe(f.result('shell-one', '{"api_key":"PrivateResultValue123","status":"ok"}'));
  await f.activity.flush();
  const serialized = JSON.stringify(await readModelWorkerActivity(f.dataDir, f.binding));
  for (const secret of [
    'private-system-prompt',
    'private-auth-output',
    'private-raw-thinking',
    'ActualPrivateValue987',
    'private-command-value',
    'private-environment-value',
    '873962',
    'private-nested-value',
    'PrivateResultValue123',
  ])
    expect(serialized).not.toContain(secret);
  expect(serialized).toContain('Read the source.');
  expect(serialized).toContain('Bash');
  expect(serialized).toContain('redacted');
});

it('omits full SDK and tool errors while retaining the actual failed-tool outcome', async () => {
  const f = await fixture();
  f.activity.observe(f.tool());
  f.activity.observe(
    f.event('assistant', {
      error: 'server_error',
      message: { content: [{ type: 'text', text: 'private-sdk-error-detail' }] },
    }),
  );
  f.activity.observe(f.result('read-one', 'Error: private-tool-stack-and-credentials', true));
  const snapshot = f.activity.snapshot();
  expect(snapshot.rows).toMatchObject([{ name: 'Read', state: 'error' }]);
  expect(JSON.stringify(snapshot)).not.toContain('private-sdk-error-detail');
  expect(JSON.stringify(snapshot)).not.toContain('private-tool-stack-and-credentials');
  expect(snapshot.rows[0]?.outputPreview).toContain('Tool reported an error');
});

it('removes OSC links, cursor controls, CR, backspace and BEL before terminal display', async () => {
  const f = await fixture();
  const terminalText =
    '\u001b]8;;https://private.example/hidden-metadata\u0007link\u001b]8;;\u0007' +
    '\nfirst\rforged\b\tline\u009b31mred\u001b[0m\u0007';
  f.activity.observe(f.assistant([{ type: 'text', text: terminalText }]));
  f.activity.observe(
    f.tool('read-control', '\u001b[31mRead\u001b[0m', {
      file_path: '/repo/\r\u0007file.ts',
    }),
  );
  f.activity.observe(f.result('read-control', terminalText));
  await f.activity.flush();
  const snapshot = await readModelWorkerActivity(f.dataDir, f.binding);
  expect(snapshot?.rows[0]?.text).toBe('link\nfirstforged\tlinered');
  expect(snapshot?.rows[1]).toMatchObject({
    name: 'Read',
    outputPreview: 'link\nfirstforged\tlinered',
  });
  expect(snapshot?.rows[1]?.inputSummary).toContain('/repo/file.ts');
  expect(JSON.stringify(snapshot)).not.toContain('private.example');
  for (const text of snapshot?.rows.flatMap((row) => [
    row.text,
    row.name,
    row.inputSummary,
    row.outputPreview,
  ]) ?? [])
    // eslint-disable-next-line no-control-regex
    expect(text ?? '').not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

it('ignores partial thinking/text frames and deduplicates completed blocks and replayed UUIDs', async () => {
  const f = await fixture();
  f.activity.observe(
    f.event('stream_event', {
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'partial-private-thought' },
      },
    }),
  );
  const assistant = f.assistant(
    [
      { type: 'text', text: 'Inspecting the implementation.' },
      { type: 'tool_use', id: 'read-one', name: 'Read', input: { file_path: '/repo/index.ts' } },
    ],
    'same-message',
  );
  f.activity.observe(assistant);
  const sequence = f.activity.snapshot().sequence;
  f.activity.observe(assistant);
  f.activity.observe({ ...assistant, uuid: randomUUID() });
  expect(f.activity.snapshot().sequence).toBe(sequence);
  expect(f.activity.snapshot().rows).toHaveLength(2);
  expect(JSON.stringify(f.activity.snapshot())).not.toContain('partial-private-thought');
  f.activity.observe(f.result('read-one', 'done'));
  const done = f.activity.snapshot();
  f.activity.observe(f.result('read-one', 'changed replay'));
  expect(f.activity.snapshot()).toEqual(done);
});

it('refuses foreign sessions and stale generations without consuming legitimate event IDs', async () => {
  const f = await fixture();
  const tool = f.tool();
  f.activity.observe({ ...tool, session_id: randomUUID() });
  f.activity.observe(tool, 'old-generation');
  f.activity.running('old-generation');
  f.activity.finish('completed', undefined, 'old-generation');
  expect(f.activity.snapshot()).toMatchObject({ sequence: 0, state: 'starting', rows: [] });
  f.activity.observe(tool);
  expect(f.activity.snapshot().rows).toHaveLength(1);
  await f.activity.flush();
  expect(
    await readModelWorkerActivity(f.dataDir, { ...f.binding, generation: 'old-generation' }),
  ).toBeNull();
  expect(
    await readModelWorkerActivity(f.dataDir, { ...f.binding, parentSessionId: 'foreign' }),
  ).toBeNull();
});

it('never reopens a cancelled activation on late tool results, status or completion', async () => {
  const f = await fixture();
  f.activity.running();
  f.activity.observe(f.tool());
  f.activity.finish('cancelled', {
    reservedAtomic: '10000',
    actualAtomic: '3000',
    uncertain: ['call-one'],
  });
  const cancelled = f.activity.snapshot();
  f.activity.observe(f.result('read-one', 'late success'));
  f.activity.observe(f.event('system', { subtype: 'compact_boundary' }));
  f.activity.running();
  f.activity.finish('completed', { reservedAtomic: '0', actualAtomic: '0', uncertain: [] });
  expect(f.activity.snapshot()).toEqual(cancelled);
  expect(cancelled.rows[0]?.state).toBe('cancelled');
  expect(cancelled.spend).toEqual({
    reservedAtomic: '10000',
    actualAtomic: '3000',
    uncertain: ['call-one'],
  });
});

it('takes financial totals only from the controller, never SDK estimates or result events', async () => {
  const f = await fixture();
  f.activity.observe(
    f.event('result', {
      subtype: 'success',
      total_cost_usd: 9000,
      spend: { actualAtomic: '9000000000' },
    }),
  );
  expect(f.activity.snapshot().spend).toBeUndefined();
  f.activity.finish('completed', { reservedAtomic: '4100', actualAtomic: '3900', uncertain: [] });
  expect(f.activity.snapshot().spend?.actualAtomic).toBe('3900');
});

it('bounds accumulated Unicode content, row count and fields without truncating execution inputs', async () => {
  const f = await fixture();
  const original = '界'.repeat(2000);
  for (let n = 0; n < 300; n++)
    f.activity.observe(f.assistant([{ type: 'text', text: original + n }]));
  const snapshot = f.activity.snapshot();
  expect(original).toHaveLength(2000);
  expect(snapshot.sequence).toBe(300);
  expect(snapshot.rows.length).toBeGreaterThan(0);
  expect(snapshot.rows.length).toBeLessThan(200);
  expect(snapshot.droppedRows).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(128 * 1024);
  expect(snapshot.rows.every((row) => Buffer.byteLength(row.text ?? '') <= 1024)).toBe(true);
  f.activity.observe(f.assistant([{ type: 'text', text: 'x'.repeat(100_000) }]));
  expect(f.activity.snapshot().rows.at(-1)?.text).toContain('large content omitted');
});

it('tracks native compaction without persisting its surrounding system data', async () => {
  const f = await fixture();
  f.activity.observe(
    f.event('system', { subtype: 'status', status: 'compacting', extra: 'private-status-detail' }),
  );
  f.activity.observe(f.event('system', { subtype: 'status', status: 'compacting' }));
  f.activity.observe(
    f.event('system', {
      subtype: 'compact_boundary',
      compact_metadata: { secret: 'private-compaction-data' },
    }),
  );
  expect(f.activity.snapshot().rows).toMatchObject([
    { kind: 'status', state: 'completed', text: 'Native context compacting' },
    { kind: 'compaction', state: 'completed', text: 'Native context compacted' },
  ]);
  expect(JSON.stringify(f.activity.snapshot())).not.toContain('private-');
});

it('keeps display writes coalesced and non-blocking while the sink is slow', async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstWrite = new Promise<void>((resolve) => {
    started = resolve;
  });
  const written: string[] = [];
  const write = vi.fn(async (_path: string, data: string) => {
    written.push(data);
    if (written.length === 1) {
      started();
      await gate;
    }
  });
  const f = await fixture(write);
  await firstWrite;
  for (let n = 0; n < 50; n++)
    f.activity.observe(f.assistant([{ type: 'text', text: 'step ' + n }]));
  f.activity.finish('completed');
  expect(f.activity.snapshot().state).toBe('completed');
  expect(write).toHaveBeenCalledTimes(1);
  release();
  await f.activity.flush();
  expect(write).toHaveBeenCalledTimes(2);
  expect(JSON.parse(written.at(-1)!).state).toBe('completed');
});

it('replaces the one per-worker projection on resume and fences an older queued write', async () => {
  let started!: () => void;
  let release!: () => void;
  const firstWrite = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async (path, data) => {
    started();
    await gate;
    await writePrivate(path, data);
  });
  await firstWrite;
  f.activity.finish('completed');
  const next = {
    ...f.binding,
    offerId: randomUUID(),
    continuationId: randomUUID(),
    generation: randomUUID(),
  };
  const resumed = new ModelWorkerActivity({ dataDir: f.dataDir, binding: next });
  activities.push(resumed);
  resumed.running();
  resumed.observe({
    type: 'assistant',
    uuid: randomUUID(),
    session_id: next.sdkSessionId,
    message: { id: randomUUID(), content: [{ type: 'text', text: 'current activation' }] },
  });
  release();
  await Promise.all([f.activity.flush(), resumed.flush()]);
  expect(await readModelWorkerActivity(f.dataDir, f.binding)).toBeNull();
  expect(await readModelWorkerActivity(f.dataDir, next)).toMatchObject({
    binding: next,
    state: 'running',
    rows: [{ text: 'current activation' }],
  });
  await snapshotFile(f.dataDir);
});

it('finishes the previous in-memory row after resume claims disk without altering the new activation', async () => {
  const f = await fixture();
  f.activity.running();
  f.activity.observe(f.tool());
  await f.activity.flush();
  const next = {
    ...f.binding,
    offerId: randomUUID(),
    continuationId: randomUUID(),
    generation: randomUUID(),
  };
  const resumed = new ModelWorkerActivity({ dataDir: f.dataDir, binding: next });
  activities.push(resumed);
  resumed.running();
  // The native completion is durable, but the old controller's display callback was delayed.
  f.activity.finish('completed', { reservedAtomic: '4100', actualAtomic: '3900', uncertain: [] });
  expect(f.activity.snapshot()).toMatchObject({
    state: 'completed',
    spend: { actualAtomic: '3900' },
  });
  await Promise.all([f.activity.flush(), resumed.flush()]);
  expect(await readModelWorkerActivity(f.dataDir, next)).toMatchObject({
    binding: next,
    state: 'running',
    rows: [],
  });
  expect((await readModelWorkerActivity(f.dataDir, next))?.spend).toBeUndefined();
  expect(await readModelWorkerActivity(f.dataDir, f.binding)).toBeNull();
  f.activity.finish('cancelled');
  expect(f.activity.snapshot().state).toBe('completed');
});

it('checks the controller generation inside the UI lock and treats revocation/errors as display-only', async () => {
  const f = await fixture();
  await f.activity.flush();
  const binding = { ...f.binding, generation: randomUUID() };
  const write = vi.fn(async () => undefined);
  const observer = new ModelWorkerActivity({
    dataDir: f.dataDir,
    binding,
    write,
    isCurrentBinding: async () => false,
  });
  activities.push(observer);
  observer.observe(f.tool());
  await observer.flush();
  expect(write).not.toHaveBeenCalled();
  expect(await readModelWorkerActivity(f.dataDir, f.binding)).toBeNull();
  expect(observer.snapshot().rows).toHaveLength(1);
  const unavailable = new ModelWorkerActivity({
    dataDir: f.dataDir,
    binding: { ...binding, generation: randomUUID() },
    write,
    isCurrentBinding: async () => {
      throw new Error('private-validator-error');
    },
  });
  activities.push(unavailable);
  unavailable.finish('unknown');
  await unavailable.flush();
  expect(write).not.toHaveBeenCalled();
  expect(unavailable.snapshot().state).toBe('unknown');
});

it('swallows persistence and malformed-observation failures without changing execution-facing state', async () => {
  const f = await fixture(async () => {
    throw new Error('private-write-error');
  });
  const malformed = Object.defineProperty({}, 'type', {
    get() {
      throw new Error('private-event-error');
    },
  });
  expect(() => f.activity.observe(malformed)).not.toThrow();
  f.activity.observe(f.tool());
  expect(() => f.activity.finish('completed')).not.toThrow();
  await expect(f.activity.flush()).resolves.toBeUndefined();
  expect(f.activity.snapshot().state).toBe('completed');
  expect(JSON.stringify(f.activity.snapshot())).not.toContain('private-');
});

it('rejects symlink snapshots, oversized files and stored ownership/generation substitutions', async () => {
  const f = await fixture();
  await f.activity.flush();
  const file = await snapshotFile(f.dataDir);
  const original = await readFile(file, 'utf8');
  const elsewhere = join(f.dir, 'elsewhere.json');
  await writeFile(elsewhere, original);
  await rm(file);
  await symlink(elsewhere, file);
  expect(await readModelWorkerActivity(f.dataDir, f.binding)).toBeNull();
  await rm(file);
  await writeFile(
    file,
    JSON.stringify({
      ...JSON.parse(original),
      binding: { ...f.binding, generation: 'substituted' },
    }),
  );
  expect(await readModelWorkerActivity(f.dataDir, f.binding)).toBeNull();
  await writeFile(file, ' '.repeat(200_000));
  expect(await readModelWorkerActivity(f.dataDir, f.binding)).toBeNull();
});
