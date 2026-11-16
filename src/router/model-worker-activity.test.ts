import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  ModelWorkerActivity,
  partialHandback,
  type ModelWorkerActivityBinding,
} from './model-worker-activity';

function fixture() {
  const dir = join(tmpdir(), 'tenjin-worker-activity-' + randomUUID());
  const dataDir = join(dir, 'data');
  const binding: ModelWorkerActivityBinding = {
    parentSessionId: randomUUID(),
    root: join(dir, 'repo'),
    configDir: join(dir, 'native'),
    offerId: randomUUID(),
    workerHandle: 'tenjin-worker-' + randomUUID(),
    nativeProfile: 'general-purpose',
    continuationId: randomUUID(),
    sdkSessionId: randomUUID(),
    generation: randomUUID(),
  };
  const activity = new ModelWorkerActivity({ dataDir, binding });
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
    input: unknown = { file_path: join(binding.root, 'index.ts') },
  ) => assistant([{ type: 'tool_use', id: toolId, name, input }]);
  const result = (toolId: string, content: unknown, isError = false) =>
    event('user', {
      message: {
        content: [{ type: 'tool_result', tool_use_id: toolId, content, is_error: isError }],
      },
    });
  return { dir, dataDir, binding, activity, event, assistant, tool, result };
}

it('records actual tool activity and updates a result without creating another row', () => {
  const f = fixture();
  f.activity.running();
  f.activity.observe(f.tool());
  f.activity.observe(
    f.event('tool_progress', { tool_use_id: 'read-one', elapsed_time_seconds: 2 }),
  );
  f.activity.observe(f.result('read-one', [{ type: 'text', text: 'export const answer = 42;' }]));
  const read = f.activity.snapshot();
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
});

it('never includes thinking, authentication, system prompts, raw commands or secret input values', () => {
  const f = fixture();
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
  const serialized = JSON.stringify(f.activity.snapshot());
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

it('omits full SDK and tool errors while retaining the actual failed-tool outcome', () => {
  const f = fixture();
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

it('removes OSC links, cursor controls, CR, backspace and BEL before terminal display', () => {
  const f = fixture();
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
  const snapshot = f.activity.snapshot();
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

it('ignores partial thinking/text frames and deduplicates completed blocks and replayed UUIDs', () => {
  const f = fixture();
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

it('refuses foreign sessions and stale generations without consuming legitimate event IDs', () => {
  const f = fixture();
  const tool = f.tool();
  f.activity.observe({ ...tool, session_id: randomUUID() });
  f.activity.observe(tool, 'old-generation');
  f.activity.running('old-generation');
  f.activity.finish('completed', undefined, 'old-generation');
  expect(f.activity.snapshot()).toMatchObject({ sequence: 0, state: 'starting', rows: [] });
  f.activity.observe(tool);
  expect(f.activity.snapshot().rows).toHaveLength(1);
});

it('never reopens a cancelled activation on late tool results, status or completion', () => {
  const f = fixture();
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

it('takes financial totals only from the controller, never SDK estimates or result events', () => {
  const f = fixture();
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

it('bounds accumulated Unicode content, row count and fields without truncating execution inputs', () => {
  const f = fixture();
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

it('tracks native compaction without retaining its surrounding system data', () => {
  const f = fixture();
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

it('a resumed activation fences late events on the previous one without changing either history', () => {
  const f = fixture();
  f.activity.running();
  f.activity.observe(f.tool());
  const old = f.activity.snapshot();
  const next = {
    ...f.binding,
    offerId: randomUUID(),
    continuationId: randomUUID(),
    generation: randomUUID(),
  };
  const resumed = new ModelWorkerActivity({ dataDir: f.dataDir, binding: next });
  resumed.running();
  resumed.observe(f.assistant([{ type: 'text', text: 'current activation' }]));
  const current = resumed.snapshot();
  const late = f.assistant([{ type: 'text', text: 'late old activation' }]);
  f.activity.observe(late);
  f.activity.observe(f.result('read-one', 'late result'));
  f.activity.running();
  expect(f.activity.snapshot()).toEqual(old);
  expect(resumed.snapshot()).toEqual(current);
  // Refused stale observations do not consume event identity in the current activation.
  resumed.observe(late);
  expect(resumed.snapshot().rows).toMatchObject([
    { text: 'current activation' },
    { text: 'late old activation' },
  ]);
});

it('finishes the previous row after resume without altering the new activation', () => {
  const f = fixture();
  f.activity.running();
  f.activity.observe(f.tool());
  const next = {
    ...f.binding,
    offerId: randomUUID(),
    continuationId: randomUUID(),
    generation: randomUUID(),
  };
  const resumed = new ModelWorkerActivity({ dataDir: f.dataDir, binding: next });
  resumed.running();
  // The native completion is durable, but the old controller's display callback was delayed.
  f.activity.finish('completed', { reservedAtomic: '4100', actualAtomic: '3900', uncertain: [] });
  expect(f.activity.snapshot()).toMatchObject({
    state: 'completed',
    rows: [{ name: 'Read', state: 'unknown' }],
    spend: { actualAtomic: '3900' },
  });
  expect(resumed.snapshot()).toMatchObject({ binding: next, state: 'running', rows: [] });
  expect(resumed.snapshot().spend).toBeUndefined();
  f.activity.finish('cancelled');
  expect(f.activity.snapshot().state).toBe('completed');
});

it('keeps identical worker identities independent in separate Tenjin data namespaces', () => {
  const f = fixture();
  const other = new ModelWorkerActivity({
    dataDir: join(f.dir, 'other-data'),
    binding: f.binding,
  });
  f.activity.running();
  other.running();
  f.activity.observe(f.assistant([{ type: 'text', text: 'first store' }]));
  other.observe(f.assistant([{ type: 'text', text: 'second store' }]));
  expect(f.activity.snapshot()).toMatchObject({
    state: 'running',
    rows: [{ text: 'first store' }],
  });
  expect(other.snapshot()).toMatchObject({ state: 'running', rows: [{ text: 'second store' }] });
});

it('contains malformed observations without changing execution-facing state', () => {
  const f = fixture();
  const malformed = Object.defineProperty({}, 'type', {
    get() {
      throw new Error('private-event-error');
    },
  });
  expect(() => f.activity.observe(malformed)).not.toThrow();
  f.activity.observe(f.tool());
  expect(() => f.activity.finish('completed')).not.toThrow();
  expect(f.activity.snapshot().state).toBe('completed');
  expect(JSON.stringify(f.activity.snapshot())).not.toContain('private-');
});

it("hands a stopped worker's last text and latest rows to the parent instead of nothing", () => {
  const f = fixture();
  expect(partialHandback(f.activity.snapshot())).toBeUndefined();
  f.activity.running();
  f.activity.observe(f.assistant([{ type: 'text', text: 'Reading the diff first.' }]));
  f.activity.observe(f.tool('diff', 'Bash', { command: 'git diff main' }));
  f.activity.observe(f.result('diff', [{ type: 'text', text: '+ new line' }]));
  f.activity.observe(f.assistant([{ type: 'text', text: 'Found one risky change in pay.ts.' }]));
  f.activity.finish('unknown');
  const partial = partialHandback(f.activity.snapshot());
  expect(partial?.lastText).toBe('Found one risky change in pay.ts.');
  expect(partial?.rows.map((row) => row.kind)).toEqual(['text', 'tool', 'text']);
  expect(partial?.omittedRows).toBe(0);
});

it('keeps the partial handback within its byte bound by dropping the oldest rows', () => {
  const f = fixture();
  f.activity.running();
  for (let i = 0; i < 40; i++)
    f.activity.observe(f.assistant([{ type: 'text', text: `step ${i} ` + 'x'.repeat(900) }]));
  const partial = partialHandback(f.activity.snapshot())!;
  expect(Buffer.byteLength(JSON.stringify(partial))).toBeLessThan(25 * 1024);
  expect(partial.rows.at(-1)?.text).toContain('step 39');
  expect(partial.lastText).toContain('step 39');
  expect(partial.omittedRows + partial.rows.length).toBe(40);
});
