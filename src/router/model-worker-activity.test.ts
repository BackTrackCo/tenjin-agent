import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  ModelWorkerActivity,
  activityAnswer,
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

it('never includes thinking, authentication, system prompts or secret input values (known shapes in text are shown as written), and shows a shell command to the local display alone', () => {
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
    'private-environment-value',
    '873962',
    'private-nested-value',
  ])
    expect(serialized).not.toContain(secret);
  expect(serialized).toContain('Read the source.');
  expect(serialized).toContain('Bash');
  expect(serialized).toContain('[hidden]');
  // Shapes in text are shown as written: nothing masks them by shape any more.
  expect(serialized).toContain('ActualPrivateValue987');
  expect(serialized).toContain('PrivateResultValue123');
  // The command is its own row field, as a native row names a shell call, and the parent's
  // partial handback never carries it.
  const shell = () => f.activity.snapshot().rows.find((row) => row.name === 'Bash');
  expect(shell()?.command).toBe('printf private-command-value');
  expect(shell()?.inputSummary).not.toContain('private-command-value');
  f.activity.observe(f.tool('shell-two', 'Bash', { command: 'printf handback-check-value' }));
  expect(JSON.stringify(partialHandback(f.activity.snapshot()))).not.toContain(
    'handback-check-value',
  );
});

it("keeps a completed worker's answer for the viewer, beside its rows and out of the progress file's answer", () => {
  const f = fixture();
  f.activity.running();
  f.activity.observe(f.tool());
  f.activity.handback('The final answer.');
  f.activity.finish('completed');
  const snapshot = f.activity.snapshot();
  expect(snapshot.result).toBe('The final answer.');
  expect(snapshot.rows).toHaveLength(1);
  expect(activityAnswer(snapshot, { rows: true, result: true }).activity.result).toBe(
    'The final answer.',
  );
  expect(activityAnswer(snapshot, { rows: true }).activity).not.toHaveProperty('result');
  // Set once by the controller: nothing rewrites it after the job ended.
  f.activity.handback('A later answer.');
  expect(f.activity.snapshot().result).toBe('The final answer.');
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
  // Never started: an ended job in this state ran nothing, and the viewer says so.
  expect(f.activity.snapshot()).toMatchObject({
    sequence: 0,
    state: 'starting',
    started: false,
    rows: [],
  });
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

it('counts every tool use past the row bound, and tokens as the latest input plus all output', () => {
  const f = fixture();
  f.activity.running();
  const usage = { input_tokens: 900, cache_read_input_tokens: 40_000, output_tokens: 300 };
  const turn = f.event('assistant', {
    message: {
      id: 'turn-1',
      usage,
      content: [{ type: 'tool_use', id: 'first', name: 'Read', input: {} }],
    },
  });
  f.activity.observe(turn);
  // A replayed event is one turn, not two.
  f.activity.observe(turn);
  expect(f.activity.snapshot()).toMatchObject({ toolUses: 1, tokens: 41_200 });
  for (let at = 0; at < 140; at++) f.activity.observe(f.tool('bulk-' + at));
  f.activity.observe(
    f.event('assistant', {
      message: {
        id: 'turn-2',
        usage: { ...usage, cache_creation_input_tokens: 2_000, output_tokens: 500 },
        content: [{ type: 'text', text: 'Summarising.' }],
      },
    }),
  );
  const shown = f.activity.snapshot();
  expect(shown.rows.length).toBeLessThan(141);
  expect(shown.toolUses).toBe(141);
  // The latest request's input (42,900) and both replies' output (800).
  expect(shown.tokens).toBe(43_700);
  // A usage the SDK could not have sent leaves the last count standing.
  f.activity.observe(
    f.event('assistant', {
      message: { id: 'turn-3', usage: { input_tokens: -1, output_tokens: 1 }, content: [] },
    }),
  );
  expect(f.activity.snapshot().tokens).toBe(43_700);
});

// Live on alpha.68 the row's count jumped around: each block of a reply carried that reply's
// usage as it then stood, and a compacted request's input is smaller than the one before.
it('never lowers the token count, as a native subagent row never does', () => {
  const f = fixture();
  f.activity.running();
  const reply = (id: string, input: number, output: number, block: unknown) =>
    f.event('assistant', {
      message: { id, usage: { input_tokens: input, output_tokens: output }, content: [block] },
    });
  const seen: number[] = [];
  for (const event of [
    reply('a', 30_000, 10, { type: 'text', text: 'Reading.' }),
    reply('a', 30_000, 120, { type: 'tool_use', id: 't1', name: 'Read', input: {} }),
    reply('b', 31_000, 50, { type: 'tool_use', id: 't2', name: 'Read', input: {} }),
    // After compaction the next request carries far less input.
    reply('c', 9_000, 40, { type: 'text', text: 'Done.' }),
  ]) {
    f.activity.observe(event);
    seen.push(f.activity.snapshot().tokens);
  }
  expect(seen).toEqual([30_010, 30_120, 31_170, 31_170]);
});

it('shows settled spend while running, and drops it when final accounting is unreadable', () => {
  const f = fixture();
  f.activity.running();
  const settled = { reservedAtomic: '8000', actualAtomic: '4300', uncertain: ['call-two'] };
  f.activity.spending(settled);
  const sequence = f.activity.snapshot().sequence;
  expect(f.activity.snapshot().spend).toEqual(settled);
  f.activity.spending({ ...settled });
  f.activity.spending({ accounting: 'unknown' });
  expect(f.activity.snapshot().sequence).toBe(sequence);
  expect(f.activity.snapshot().spend).toEqual(settled);
  f.activity.finish('unknown', undefined);
  expect(f.activity.snapshot().spend).toBeUndefined();
  f.activity.spending(settled);
  expect(f.activity.snapshot().spend).toBeUndefined();
});

it("binds a worker that runs as a custom agent, never one named like a plugin's or with a space", () => {
  const f = fixture();
  const bind = (nativeProfile: string) =>
    new ModelWorkerActivity({ dataDir: f.dataDir, binding: { ...f.binding, nativeProfile } });
  expect(bind('loop-worker-high').snapshot().binding.nativeProfile).toBe('loop-worker-high');
  expect(() => bind('tenjin:deepseek-viewer')).toThrow();
  expect(() => bind('loop worker')).toThrow();
});

// The viewer draws each worker reply as one step: its text and its calls, and a read's line count.
it('marks the reply each row belongs to, and a read’s line count from its own record', () => {
  const f = fixture();
  f.activity.running();
  f.activity.observe(
    f.assistant(
      [
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_use', id: 'read-one', name: 'Read', input: { file_path: '/repo/a.ts' } },
      ],
      'msg-one',
    ),
  );
  f.activity.observe(f.assistant([{ type: 'text', text: 'Done.' }], 'msg-two'));
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  f.activity.observe({
    ...f.result('read-one', [{ type: 'text', text: '1\tconst a = ' + token }]),
    tool_use_result: { type: 'text', file: { filePath: '/repo/a.ts', numLines: 120 } },
  });
  const [text, read, done] = f.activity.snapshot().rows;
  expect(text?.message).toBe(read?.message);
  expect(done?.message).not.toBe(read?.message);
  expect(read?.lines).toBe(120);
  // The viewer's result lines come from this preview, which shows a secret shape as written.
  expect(read?.outputPreview).toContain(token);
});

// The viewer draws a web call as Claude Code does: `WebFetch(url)` and `Received 12KB (200 OK)`.
it('keeps a web call’s URL or query for the local display and its record’s figures, never its content', () => {
  const f = fixture();
  f.activity.running();
  f.activity.observe(
    f.tool('fetch-one', 'WebFetch', { url: 'https://pnpm.io/blog', prompt: 'newest release' }),
  );
  f.activity.observe(f.tool('search-one', 'WebSearch', { query: 'pnpm release' }));
  f.activity.observe({
    ...f.result('fetch-one', 'The latest release is **12.21.0**. PRIVATE_PAGE'),
    tool_use_result: {
      bytes: 12_345,
      code: 200,
      codeText: 'OK',
      result: 'PRIVATE_PAGE',
      durationMs: 812,
      url: 'https://pnpm.io/blog',
    },
  });
  f.activity.observe({
    ...f.result('search-one', 'Web search results'),
    tool_use_result: { query: 'pnpm release', results: ['PRIVATE_HIT'], durationSeconds: 2.5 },
  });
  const [fetch, search] = f.activity.snapshot().rows;
  expect(fetch).toMatchObject({
    target: 'https://pnpm.io/blog',
    figures: { bytes: 12_345, code: 200, codeText: 'OK', durationMs: 812 },
  });
  expect(search).toMatchObject({ target: 'pnpm release', figures: { durationSeconds: 2.5 } });
  expect(JSON.stringify([fetch?.figures, search?.figures])).not.toContain('PRIVATE_');
  f.activity.finish('unknown');
  expect(JSON.stringify(partialHandback(f.activity.snapshot()))).not.toContain('pnpm.io');
});

// The viewer names a worker call the router served by that tool, as the router's rows do.
it('marks a call a router tool served, also when its hook runs before the call is seen', () => {
  const f = fixture();
  f.activity.running();
  // Exa page read stood in for a fetch the site refused: its page, not the 403, is the result.
  f.activity.observe(f.tool('fetch-one', 'WebFetch', { url: 'https://npmjs.com/next' }));
  f.activity.served('fetch-one', 'Exa page read', { bytes: 23_400, code: 200, codeText: 'OK' });
  f.activity.observe({
    ...f.result('fetch-one', 'Request failed with status code 403'),
    tool_use_result: { bytes: 0, code: 403, codeText: 'Forbidden', result: '', durationMs: 90 },
  });
  // A search's hook can be told before the activity has seen the call.
  f.activity.served('search-one', 'Exa search');
  f.activity.observe(f.tool('search-one', 'WebSearch', { query: 'next 16' }));
  const [fetch, search] = f.activity.snapshot().rows;
  expect(fetch).toMatchObject({
    via: 'Exa page read',
    state: 'completed',
    figures: { bytes: 23_400, code: 200, codeText: 'OK' },
  });
  expect(search).toMatchObject({ via: 'Exa search' });
});

// A streamed turn reaches the viewer block by block with the usage as it then stood: the
// row's count follows the turn as it goes, and never steps back.
it('follows a streamed turn block by block with a count that only rises', () => {
  const f = fixture();
  f.activity.running();
  const block = (output: number, content: unknown) =>
    f.event('assistant', {
      message: {
        id: 'streamed',
        usage: { input_tokens: 12_000, cache_read_input_tokens: 3_000, output_tokens: output },
        content: [content],
      },
    });
  const seen: number[] = [];
  const rows: number[] = [];
  for (const event of [
    block(1, { type: 'text', text: 'Looking.' }),
    block(60, { type: 'tool_use', id: 'r1', name: 'Read', input: {} }),
    // A late block that carries an earlier, smaller count.
    block(25, { type: 'tool_use', id: 'r2', name: 'Read', input: {} }),
    block(140, { type: 'text', text: 'Done.' }),
  ]) {
    f.activity.observe(event);
    seen.push(f.activity.snapshot().tokens);
    rows.push(f.activity.snapshot().rows.length);
  }
  expect(seen).toEqual([15_001, 15_060, 15_060, 15_140]);
  // Each block's row is there as its block arrives, not at the turn's end.
  expect(rows).toEqual([1, 2, 3, 4]);
});
