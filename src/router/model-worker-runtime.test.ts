import { beforeEach, expect, it, vi } from 'vitest';
import { query, resolveSettings } from '@anthropic-ai/claude-agent-sdk/core';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { readClaudeCode, meetsFloor } from './claude-cli';
import { qualifiedModelWorker, runModelWorker } from './model-worker';
import { modelSettings } from './model-settings';
import { workerStop } from './model-worker-control';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';

const native = vi.hoisted(() => ({
  close: vi.fn(),
  bridgeClose: vi.fn(),
  createServer: vi.fn(),
  promptMessages: [] as unknown[],
}));
vi.mock('@anthropic-ai/claude-agent-sdk/core', () => ({
  query: vi.fn(),
  resolveSettings: vi.fn(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo: vi.fn() }));
vi.mock('./claude-cli', () => ({ readClaudeCode: vi.fn(), meetsFloor: vi.fn() }));
vi.mock('./agent-tools', () => ({ findDefinition: vi.fn(async () => null) }));
vi.mock('./model-settings', async (original) => ({
  ...(await original<typeof import('./model-settings')>()),
  modelSettings: vi.fn(async () => ({ root: '/repo', repositories: ['/repo'] })),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  realpath: vi.fn(async (path: unknown) => String(path)),
  stat: async () => ({ isDirectory: () => true }),
}));
vi.mock('node:http', async (original) => ({
  ...(await original<typeof import('node:http')>()),
  createServer: (handle: unknown) => {
    native.createServer(handle);
    return {
      once: vi.fn(),
      listen: (_port: number, _host: string, ready: () => void) => ready(),
      address: () => ({ port: 12345 }),
      closeAllConnections: vi.fn(),
      close: (done: () => void) => {
        native.bridgeClose();
        done();
      },
    };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  native.promptMessages.length = 0;
  vi.mocked(readClaudeCode).mockResolvedValue({
    binary: { path: '/fixture/claude' },
    version: '2.1.325',
  } as never);
  vi.mocked(meetsFloor).mockReturnValue(true);
  vi.mocked(resolveSettings).mockResolvedValue({ effective: {} } as never);
  vi.mocked(realpath).mockImplementation(async (path) => String(path));
  vi.mocked(modelSettings).mockResolvedValue({ root: '/repo', repositories: ['/repo'] } as never);
});

const job = {
  id: 'owned',
  root: '/repo',
  native: {},
  task: 'Check the selected function.',
  decision: {
    claudePermissionMode: 'default',
    claudeWorkspace: {
      version: 1,
      root: '/repo',
      workingDirectories: ['/repo'],
      workingDirectorySpellings: ['/repo'].slice().sort(),
      readExceptions: [],
      writeExceptions: [],
    },
  },
} as unknown as ModelJob;
const options = () => ({
  dataDir: '/data',
  transport: {} as ModelTransport,
  signal: new AbortController().signal,
  claudePermissionMode: 'default' as const,
  currentClaudePermissionMode: () => 'default',
  permission: vi.fn(async () => false),
});
function sdkResult(
  result: Record<string, unknown>,
  sessionId?: string,
  beforeResult?: () => Promise<void>,
  activity: Record<string, unknown>[] = [],
) {
  vi.mocked(query).mockImplementation(
    (call) =>
      ({
        async *[Symbol.asyncIterator]() {
          for await (const message of call.prompt) native.promptMessages.push(message);
          yield {
            type: 'system',
            subtype: 'init',
            permissionMode: 'default',
            cwd: '/repo',
            session_id: sessionId,
          };
          await beforeResult?.();
          for (const message of activity) yield message;
          yield { type: 'result', session_id: sessionId, ...result };
        },
        accountInfo: async () => ({ apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' }),
        mcpServerStatus: async () => [],
        close: native.close,
      }) as unknown as ReturnType<typeof query>,
  );
}

function authenticationQuery(account: Promise<unknown>) {
  let started!: (value: Promise<IteratorResult<unknown>>) => void;
  const pendingPrompt = new Promise<Promise<IteratorResult<unknown>>>((resolve) => {
    started = resolve;
  });
  vi.mocked(query).mockImplementation((call) => {
    if (typeof call.prompt === 'string') throw new Error('Task was sent without authentication');
    const next = call.prompt[Symbol.asyncIterator]().next();
    started(next);
    return {
      accountInfo: () => account,
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', permissionMode: 'default' };
        yield { type: 'result', subtype: 'success', result: 'done' };
      },
      mcpServerStatus: async () => [],
      close: native.close,
    } as unknown as ReturnType<typeof query>;
  });
  return pendingPrompt;
}

const incompatibleSandboxes = [
  { sandbox: { filesystem: { disabled: true } } },
  { sandbox: { excludedCommands: ['git'] } },
  { sandbox: { filesystem: { allowManagedReadPathsOnly: true } } },
];

it.each(incompatibleSandboxes)(
  'keeps an unconfined shell configuration native before creating a worker: %j',
  async (effective) => {
    vi.mocked(resolveSettings).mockResolvedValue({ effective } as never);
    expect(await qualifiedModelWorker('/repo', 'general-purpose', undefined, '/data')).toBeNull();
  },
);

it.each(['*', '?', '[', ']'])(
  'keeps a startup path containing %s native before creating a worker',
  async (glob) => {
    const root = `/client ${glob}archive`;
    vi.mocked(modelSettings).mockResolvedValue({ root, repositories: [root] } as never);
    expect(await qualifiedModelWorker(root, 'general-purpose', undefined, '/data')).toBeNull();
  },
);

it('keeps a managed read-path restriction native even when the merged setting is false', async () => {
  vi.mocked(resolveSettings).mockResolvedValue({
    effective: { sandbox: { filesystem: { allowManagedReadPathsOnly: false } } },
    sources: [
      {
        source: 'managed',
        settings: { sandbox: { filesystem: { allowManagedReadPathsOnly: true } } },
      },
    ],
  } as never);
  expect(await qualifiedModelWorker('/repo', 'general-purpose', undefined, '/data')).toBeNull();
});

it('checks the physical startup directory when a harmless alias hides glob characters', async () => {
  vi.mocked(realpath).mockImplementation(async (path) =>
    String(path) === '/repo-alias' ? '/client[archive]' : String(path),
  );
  vi.mocked(modelSettings).mockResolvedValue({
    root: '/client[archive]',
    repositories: ['/client[archive]'],
  } as never);
  expect(
    await qualifiedModelWorker('/repo-alias', 'general-purpose', undefined, '/data'),
  ).toBeNull();
});

it('preserves ordinary startup spaces and explicitly false confinement exceptions', async () => {
  const root = '/client archive';
  vi.mocked(modelSettings).mockResolvedValue({ root, repositories: [root] } as never);
  vi.mocked(resolveSettings).mockResolvedValue({
    effective: {
      sandbox: {
        filesystem: { disabled: false, allowManagedReadPathsOnly: false },
        excludedCommands: [],
      },
    },
    sources: [
      {
        source: 'managed',
        settings: { sandbox: { filesystem: { allowManagedReadPathsOnly: false } } },
      },
    ],
  } as never);
  expect(await qualifiedModelWorker(root, 'general-purpose', undefined, '/data')).toMatchObject({
    claudeWorkspace: { root },
  });
});

it.each(incompatibleSandboxes)(
  'refuses a newly incompatible shell configuration before releasing an assignment: %j',
  async (effective) => {
    vi.mocked(resolveSettings)
      .mockResolvedValueOnce({ effective: {} } as never)
      .mockResolvedValue({ effective } as never);
    await expect(runModelWorker(job, options())).rejects.toThrow(/workspace scope|sandbox/);
    expect(query).not.toHaveBeenCalled();
    expect(native.promptMessages).toEqual([]);
    expect(native.bridgeClose).toHaveBeenCalled();
  },
);

it.each([undefined, 'gateway', 'bedrock'])(
  'never releases the original task to an unqualified initialized provider: %s',
  async (apiProvider) => {
    const pending = authenticationQuery(Promise.resolve({ apiProvider }));
    const messages = vi.fn();
    const activity = { running: vi.fn(), observe: vi.fn() };
    await expect(
      runModelWorker(job, {
        ...options(),
        activity,
        transport: { messages } as unknown as ModelTransport,
      }),
    ).rejects.toThrow(/unsupported API provider/);
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(messages).not.toHaveBeenCalled();
    expect(activity.running).not.toHaveBeenCalled();
    expect(activity.observe).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalled();
    expect(native.bridgeClose).toHaveBeenCalled();
  },
);

it.each([
  { apiProvider: 'firstParty' },
  { apiProvider: 'firstParty', apiKeySource: '/login managed key' },
  { apiProvider: 'firstParty', apiKeySource: 'oauth' },
  { apiProvider: 'firstParty', apiKeySource: 'none', tokenSource: 'ANTHROPIC_AUTH_TOKEN' },
  { apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper', email: 'account@example.test' },
  { apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY', subscriptionType: 'max' },
  { apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper', tokenSource: 'claude.ai' },
  {
    apiProvider: 'firstParty',
    apiKeySource: 'apiKeyHelper',
    tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
  },
  { apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper', tokenSource: 'CCR_OAUTH_TOKEN_FILE' },
  {
    apiProvider: 'firstParty',
    apiKeySource: 'apiKeyHelper',
    tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  },
])(
  'never releases the assignment when initialized auth provenance is ambiguous or OAuth-shaped: %j',
  async (account) => {
    const pending = authenticationQuery(Promise.resolve(account));
    const messages = vi.fn();
    await expect(
      runModelWorker(job, {
        ...options(),
        transport: { messages } as unknown as ModelTransport,
      }),
    ).rejects.toThrow(/unsupported API provider|authentication/);
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(messages).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalled();
    expect(native.bridgeClose).toHaveBeenCalled();
  },
);

it.each([
  ['apiKeyHelper', 'apiKeyHelper'],
  ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  ['ANTHROPIC_API_KEY', 'none'],
  ['apiKeyHelper', undefined],
])(
  'releases the complete assignment for native bridge key provenance %s/%s',
  async (apiKeySource, tokenSource) => {
    const pending = authenticationQuery(
      Promise.resolve({ apiProvider: 'firstParty', apiKeySource, tokenSource }),
    );
    const run = runModelWorker(job, options());
    expect(await pending).toEqual({
      done: false,
      value: expect.objectContaining({
        message: { role: 'user', content: [{ type: 'text', text: job.task }] },
      }),
    });
    await expect(run).resolves.toBe('done');
  },
);

it('observes actual worker messages without changing the result or leaking them into the handback', async () => {
  const events = [
    {
      type: 'assistant',
      uuid: 'assistant-message',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/repo/a' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'tool-result',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'observed fixture' }],
      },
    },
  ];
  sdkResult({ subtype: 'success', result: 'finished' }, undefined, undefined, events);
  const activity = { running: vi.fn(), observe: vi.fn() };
  await expect(runModelWorker(job, { ...options(), activity })).resolves.toBe('finished');
  expect(activity.running).toHaveBeenCalledOnce();
  expect(activity.observe.mock.calls.map(([message]) => message)).toEqual([
    expect.objectContaining({ type: 'system', subtype: 'init' }),
    ...events,
    expect.objectContaining({ type: 'result', result: 'finished' }),
  ]);
});

it('completes and drains the worker when the activity observer fails', async () => {
  sdkResult({ subtype: 'success', result: 'finished' });
  const activity = {
    running: vi.fn(() => {
      throw new Error('display unavailable');
    }),
    observe: vi.fn(() => {
      throw new Error('display unavailable');
    }),
  };
  await expect(runModelWorker(job, { ...options(), activity })).resolves.toBe('finished');
  expect(activity.running).toHaveBeenCalledOnce();
  expect(activity.observe).toHaveBeenCalled();
  expect(native.close).toHaveBeenCalled();
  expect(native.bridgeClose).toHaveBeenCalled();
});

it('releases the exact native user message only after provider initialization is allowed', async () => {
  let allow!: (account: unknown) => void;
  const account = new Promise((resolve) => {
    allow = resolve;
  });
  const pending = authenticationQuery(account);
  const run = runModelWorker(job, options());
  allow({ apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' });
  expect(await pending).toEqual({
    done: false,
    value: {
      type: 'user',
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: job.task }] },
    },
  });
  await expect(run).resolves.toBe('done');
});

it('cancels an unresolved authentication check and closes its pending task iterator', async () => {
  let started!: () => void;
  const checked = new Promise<void>((resolve) => {
    started = resolve;
  });
  const account = new Promise<never>(() => {});
  const pending = authenticationQuery(account);
  const queryImplementation = vi.mocked(query).getMockImplementation()!;
  vi.mocked(query).mockImplementation((call) => {
    const result = queryImplementation(call);
    started();
    return result;
  });
  const controller = new AbortController();
  const messages = vi.fn();
  const outcome = runModelWorker(job, {
    ...options(),
    signal: controller.signal,
    transport: { messages } as unknown as ModelTransport,
  }).catch((error: unknown) => error);
  await checked;
  controller.abort(new Error('Cancelled authentication'));
  expect(await outcome).toBeInstanceOf(Error);
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(messages).not.toHaveBeenCalled();
  expect(native.close).toHaveBeenCalled();
  expect(native.bridgeClose).toHaveBeenCalled();
});

it('uses the native emergency guard beyond the old forty-turn cutoff while retaining its evaluated model profile', async () => {
  sdkResult({ subtype: 'success', result: 'finished after 114 turns', num_turns: 114 });
  expect(await runModelWorker(job, options())).toBe('finished after 114 turns');
  const call = vi.mocked(query).mock.calls[0]![0];
  expect(call.options).toMatchObject({
    maxTurns: 500,
    effort: 'high',
    model: 'deepseek-flash[1m]',
    cwd: '/repo',
    persistSession: false,
  });
  expect(call.options?.settings).toMatchObject({
    autoMemoryEnabled: false,
    apiKeyHelper: expect.any(String),
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
  });
  expect(call.options?.disallowedTools).toEqual([
    'Agent',
    'Task',
    'mcp__plugin_tenjin_router__subagent',
    'mcp__plugin_tenjin_router__request',
    'mcp__plugin_tenjin_router__approve',
  ]);
  expect(call.options?.settingSources).toEqual(['user', 'project', 'local']);
  for (const name of [
    '.netrc',
    '.npmrc',
    '.git-credentials',
    '.claude/.credentials.json',
    '.claude/projects',
    '.claude/history.jsonl',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/.mcp.json',
    '.claude/mcp.json',
    '.claude.json',
    '.kube',
    '.gnupg',
  ]) {
    const path = join(homedir(), name);
    const absolute = `//${path.replaceAll('\\', '/').replace(/^\/+/, '')}`;
    expect(call.options?.settings).toHaveProperty(
      'permissions.deny',
      expect.arrayContaining([`Read(${absolute})`, `Edit(${absolute})`, `Write(${absolute})`]),
    );
    expect(call.options?.sandbox?.filesystem?.denyRead).toContain(path);
  }
  expect(call.options?.sandbox?.filesystem?.denyRead).not.toContain(join(homedir(), '.claude'));
  expect(call.options?.sandbox?.filesystem?.denyWrite).not.toContain(join(homedir(), '.claude'));
  expect(call.options?.settings).not.toHaveProperty(
    'permissions.deny',
    expect.arrayContaining([`Read(/${join(homedir(), '.claude')}/**)`]),
  );
  expect(native.close).toHaveBeenCalled();
  expect(native.bridgeClose).toHaveBeenCalled();
});

it('keeps native sibling working directories distinct from read-only and shell-write exceptions', async () => {
  const workspace = {
    version: 1,
    root: '/repo',
    workingDirectories: ['/repo', '/sibling'],
    workingDirectorySpellings: ['/repo', '/sibling'].slice().sort(),
    readExceptions: ['/read-only'],
    writeExceptions: ['/shell-write'],
  };
  vi.mocked(modelSettings).mockResolvedValue({
    root: '/repo',
    repositories: ['/repo', '/sibling', '/read-only', '/shell-write'],
  } as never);
  vi.mocked(resolveSettings).mockResolvedValue({
    effective: {
      permissions: { additionalDirectories: ['/sibling'] },
      sandbox: { filesystem: { allowRead: ['/read-only'], allowWrite: ['/shell-write'] } },
    },
  } as never);
  sdkResult({ subtype: 'success', result: 'done' });
  await runModelWorker(
    { ...job, decision: { ...job.decision, claudeWorkspace: workspace } },
    options(),
  );
  const call = vi.mocked(query).mock.calls[0]![0];
  expect(call.options?.additionalDirectories).toEqual(['/sibling']);
  expect(call.options?.settings).toMatchObject({
    permissions: {
      workingDirectoriesAsGiven: ['/repo', '/sibling'],
      blockReadsExemptPaths: ['/read-only'],
      blockWritesOutsideWorkingDirectories: true,
    },
  });
  expect(call.options?.settings).toHaveProperty(
    'permissions.deny',
    expect.arrayContaining([
      'Read(//sibling/**/.env*)',
      'Read(//read-only/**/.env*)',
      'Read(//shell-write/**/.env*)',
    ]),
  );
});

it.each(['additional directory', 'read exception', 'write exception'] as const)(
  'native-workspace consent still stops inference when its frozen %s is revoked',
  async (change) => {
    vi.mocked(modelSettings).mockResolvedValue({
      scope: 'native-workspace',
      root: '/repo',
      repositories: ['/repo'],
    } as never);
    const effective = {
      permissions: { additionalDirectories: ['/sibling'] },
      sandbox: { filesystem: { allowRead: ['/read-only'], allowWrite: ['/shell-write'] } },
    };
    vi.mocked(resolveSettings).mockResolvedValue({ effective } as never);
    const workspace = {
      version: 1,
      root: '/repo',
      workingDirectories: ['/repo', '/sibling'],
      workingDirectorySpellings: ['/repo', '/sibling'].sort(),
      readExceptions: ['/read-only'],
      writeExceptions: ['/shell-write'],
    };
    const messages = vi.fn();
    sdkResult({ subtype: 'success', result: 'not a valid completion' }, undefined, async () => {
      const changed = structuredClone(effective);
      if (change === 'additional directory') changed.permissions.additionalDirectories = [];
      else if (change === 'read exception') changed.sandbox.filesystem.allowRead = [];
      else changed.sandbox.filesystem.allowWrite = [];
      vi.mocked(resolveSettings).mockResolvedValue({ effective: changed } as never);
      const call = vi.mocked(query).mock.calls[0]![0];
      const handle = native.createServer.mock.calls[0]![0] as (
        request: unknown,
        response: unknown,
      ) => void;
      await new Promise<void>((complete) =>
        handle(
          {
            method: 'POST',
            url: '/v1/messages',
            headers: { 'x-api-key': call.options?.env?.ANTHROPIC_API_KEY },
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(
                JSON.stringify({ model: 'deepseek-flash', messages: [], max_tokens: 32000 }),
              );
            },
          },
          {
            headersSent: false,
            destroyed: false,
            writeHead() {
              return this;
            },
            end(_body: string, done?: () => void) {
              done?.();
              complete();
              return this;
            },
          },
        ),
      );
    });
    await expect(
      runModelWorker(
        { ...job, decision: { ...job.decision, claudeWorkspace: workspace } },
        { ...options(), transport: { messages } as unknown as ModelTransport },
      ),
    ).rejects.toThrow(/workspace scope changed|disclosure was revoked/);
    expect(messages).not.toHaveBeenCalled();
  },
);

it('applies native settings-source and project MCP credential guards while preserving ordinary application settings', async () => {
  vi.mocked(resolveSettings).mockResolvedValue({
    effective: {},
    sources: [
      { source: 'project', path: '/ancestor/.claude/settings.json', settings: {} },
      { source: 'local', path: '/custom/native-settings.json', settings: {} },
    ],
  } as never);
  sdkResult({ subtype: 'success', result: 'done' });
  await expect(runModelWorker(job, options())).resolves.toBe('done');
  const call = vi.mocked(query).mock.calls[0]![0];
  const paths = call.options?.sandbox?.filesystem?.denyRead;
  for (const file of [
    '/repo/.mcp.json',
    '/repo/.claude/settings.local.json',
    '/ancestor/.mcp.json',
    '/ancestor/.claude/settings.json',
    '/custom/native-settings.json',
  ])
    expect(paths).toContain(file);
  for (const file of [
    '/repo/settings.json',
    '/repo/.claude/skills/example/settings.json',
    '/custom/settings.json',
  ])
    expect(paths).not.toContain(file);
});

it.each([
  'native scope',
  'disclosure',
  'disabled sandbox',
  'managed read scope',
  'excluded command',
] as const)('denies the next native tool when %s changes during an activation', async (change) => {
  let decision: unknown;
  sdkResult({ subtype: 'success', result: 'guarded fixture' }, undefined, async () => {
    if (change === 'native scope')
      vi.mocked(resolveSettings).mockResolvedValue({
        effective: { permissions: { additionalDirectories: ['/sibling'] } },
      } as never);
    else if (change === 'disclosure') vi.mocked(modelSettings).mockResolvedValue(null);
    else
      vi.mocked(resolveSettings).mockResolvedValue({
        effective:
          change === 'disabled sandbox'
            ? { sandbox: { filesystem: { disabled: true } } }
            : change === 'excluded command'
              ? { sandbox: { excludedCommands: ['node'] } }
              : { sandbox: { filesystem: { allowManagedReadPathsOnly: true } } },
      } as never);
    const hook = vi.mocked(query).mock.calls[0]![0].options?.hooks?.PreToolUse?.[0]?.hooks[0];
    decision = await hook!(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/repo/a.ts' },
        tool_use_id: 'next',
      } as never,
      undefined,
      { signal: new AbortController().signal },
    );
  });
  await runModelWorker(job, options());
  expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
});

it.each(['disclosure', 'managed read scope'] as const)(
  'stops a paid bridge request after %s revocation before invoking transport',
  async (change) => {
    const messages = vi.fn();
    sdkResult({ subtype: 'success', result: 'not a valid completion' }, undefined, async () => {
      if (change === 'disclosure') vi.mocked(modelSettings).mockResolvedValue(null);
      else
        vi.mocked(resolveSettings).mockResolvedValue({
          effective: { sandbox: { filesystem: { allowManagedReadPathsOnly: true } } },
        } as never);
      const call = vi.mocked(query).mock.calls[0]![0];
      const handle = native.createServer.mock.calls[0]![0] as (
        request: unknown,
        response: unknown,
      ) => void;
      await new Promise<void>((complete) =>
        handle(
          {
            method: 'POST',
            url: '/v1/messages',
            headers: { 'x-api-key': call.options?.env?.ANTHROPIC_API_KEY },
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(
                JSON.stringify({ model: 'deepseek-flash', messages: [], max_tokens: 32000 }),
              );
            },
          },
          {
            headersSent: false,
            destroyed: false,
            writeHead() {
              return this;
            },
            end(_body: string, done?: () => void) {
              done?.();
              complete();
              return this;
            },
          },
        ),
      );
    });
    await expect(
      runModelWorker(job, { ...options(), transport: { messages } as unknown as ModelTransport }),
    ).rejects.toThrow(/workspace scope changed|disclosure was revoked/);
    expect(messages).not.toHaveBeenCalled();
  },
);

it('persists and resumes an exact owned SDK identity without changing the string result contract', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const observed = vi.fn(async () => {});
  sdkResult({ subtype: 'success', result: 'first result' }, sessionId);
  await expect(
    runModelWorker(job, {
      ...options(),
      claudeSession: { sessionId, onSession: observed },
    }),
  ).resolves.toBe('first result');
  expect(vi.mocked(query).mock.calls[0]![0].options).toMatchObject({
    persistSession: true,
    sessionId,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  });
  expect(observed).toHaveBeenCalledWith(sessionId);
  vi.mocked(getSessionInfo).mockResolvedValue({ sessionId, cwd: '/repo' } as never);
  sdkResult({ subtype: 'success', result: 'continued result' }, sessionId);
  await expect(
    runModelWorker(
      { ...job, task: 'Continue the selected check.' },
      {
        ...options(),
        claudeSession: { resume: sessionId, onSession: observed },
      },
    ),
  ).resolves.toBe('continued result');
  const resumed = vi.mocked(query).mock.calls[1]![0];
  expect(native.promptMessages.at(-1)).toEqual({
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'Continue the selected check.' }] },
  });
  expect(resumed.options).toMatchObject({ persistSession: true, resume: sessionId, maxTurns: 500 });
  expect(resumed.options).not.toHaveProperty('sessionId');
});

it('never dispatches a missing-history resume or binds a foreign SDK session', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const onSession = vi.fn(async () => {});
  vi.mocked(getSessionInfo).mockResolvedValue(undefined);
  await expect(
    runModelWorker(job, {
      ...options(),
      claudeSession: { resume: sessionId, onSession },
    }),
  ).rejects.toThrow(/history is missing/);
  expect(query).not.toHaveBeenCalled();
  expect(native.bridgeClose).not.toHaveBeenCalled();
  sdkResult({ subtype: 'success', result: 'foreign' }, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  await expect(
    runModelWorker(job, {
      ...options(),
      claudeSession: { sessionId, onSession },
    }),
  ).rejects.toThrow(/session/);
  expect(onSession).not.toHaveBeenCalled();
  expect(native.close).toHaveBeenCalled();
});

it('drains the native process when the owned session cannot be recorded', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  sdkResult({ subtype: 'success', result: 'not safe to report' }, sessionId);
  await expect(
    runModelWorker(job, {
      ...options(),
      claudeSession: {
        sessionId,
        onSession: async () => {
          throw new Error('Store unavailable');
        },
      },
    }),
  ).rejects.toThrow(/Store unavailable/);
  expect(native.close).toHaveBeenCalled();
  expect(native.bridgeClose).toHaveBeenCalled();
});

it('admits no inference until the owned session observer has durably accepted the native identity', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  let startBinding!: () => void;
  let finishBinding!: () => void;
  const bindingStarted = new Promise<void>((resolve) => {
    startBinding = resolve;
  });
  const bindingFinished = new Promise<void>((resolve) => {
    finishBinding = resolve;
  });
  const messages = vi.fn(async () => ({ fixture: true }));
  vi.mocked(query).mockImplementation((call) => {
    let complete!: () => void;
    const responseComplete = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const handle = native.createServer.mock.calls[0]![0] as (
      request: unknown,
      response: unknown,
    ) => void;
    const response = {
      headersSent: false,
      destroyed: false,
      writeHead() {
        this.headersSent = true;
        return this;
      },
      end(_body: string, done?: () => void) {
        done?.();
        complete();
        return this;
      },
    };
    handle(
      {
        method: 'POST',
        url: '/v1/messages',
        headers: { 'x-api-key': call.options?.env?.ANTHROPIC_API_KEY },
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(
            JSON.stringify({ model: 'deepseek-flash', messages: [], max_tokens: 32000 }),
          );
        },
      },
      response,
    );
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'system',
          subtype: 'init',
          permissionMode: 'default',
          cwd: '/repo',
          session_id: sessionId,
        };
        await responseComplete;
        yield { type: 'result', subtype: 'success', session_id: sessionId, result: 'done' };
      },
      accountInfo: async () => ({ apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' }),
      mcpServerStatus: async () => [],
      close: native.close,
    } as unknown as ReturnType<typeof query>;
  });
  const run = runModelWorker(job, {
    ...options(),
    transport: { messages } as unknown as ModelTransport,
    claudeSession: {
      sessionId,
      onSession: async () => {
        startBinding();
        await bindingFinished;
      },
    },
  });
  await bindingStarted;
  expect(messages).not.toHaveBeenCalled();
  finishBinding();
  await expect(run).resolves.toBe('done');
  expect(messages).toHaveBeenCalledOnce();
});

it('does not return a completed worker while its native process has exited but stdio is still draining', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 42,
    exitCode: 0,
    signalCode: null,
    killed: false,
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  let sdkCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    sdkCleanup = resolve;
  });
  vi.mocked(query).mockImplementation((call) => {
    call.options?.spawnClaudeCodeProcess?.({
      command: '/fixture/claude',
      args: ['--fixture'],
      cwd: '/repo',
      env: {},
      signal: new AbortController().signal,
    });
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', permissionMode: 'default' };
        yield { type: 'result', subtype: 'success', result: 'done' };
      },
      accountInfo: async () => ({ apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' }),
      mcpServerStatus: async () => [],
      close: native.close,
      return: async () => {
        sdkCleanup();
        return { done: true };
      },
    } as unknown as ReturnType<typeof query>;
  });
  let returned = false;
  const run = runModelWorker(job, options()).then((value) => {
    returned = true;
    return value;
  });
  await cleanup;
  child.emit('exit', 0, null);
  await Promise.resolve();
  expect(returned).toBe(false);
  child.emit('close', 0, null);
  await expect(run).resolves.toBe('done');
  expect(returned).toBe(true);
});

it.each([
  { subtype: 'error_max_turns', reason: 'turn_guard' },
  { subtype: 'error_max_budget_usd', reason: 'budget_guard' },
  { subtype: 'success', reason: undefined },
])(
  'preserves $subtype after a confirmed signalled close without accepting a clean result from a bad exit',
  async ({ subtype, reason }) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 42,
      exitCode: null,
      signalCode: 'SIGTERM',
      killed: false,
      kill: vi.fn(() => true),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    vi.mocked(query).mockImplementation((call) => {
      call.options?.spawnClaudeCodeProcess?.({
        command: '/fixture/claude',
        args: ['--fixture'],
        cwd: '/repo',
        env: {},
        signal: new AbortController().signal,
      });
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', permissionMode: 'default' };
          yield { type: 'result', subtype, result: 'not a confirmed success', num_turns: 500 };
        },
        accountInfo: async () => ({ apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' }),
        mcpServerStatus: async () => [],
        close: native.close,
        return: async () => {
          child.emit('close', null, 'SIGTERM');
          return { done: true };
        },
      } as unknown as ReturnType<typeof query>;
    });
    const error = await runModelWorker(job, options()).catch((error) => error);
    if (reason) expect(workerStop(error)).toMatchObject({ kind: 'harness_limit', reason });
    else {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('did not close successfully');
    }
  },
);

it('routes successful and failed identical calls through soft native hook context without changing permissions or outputs', async () => {
  sdkResult({ subtype: 'success', result: 'done', num_turns: 1 });
  await runModelWorker(job, options());
  const hooks = vi.mocked(query).mock.calls[0]![0].options?.hooks;
  const success = hooks?.PostToolUse?.[0]?.hooks[0];
  const failure = hooks?.PostToolUseFailure?.[0]?.hooks[0];
  expect(success).toBeTypeOf('function');
  expect(failure).toBeTypeOf('function');
  const contexts = [];
  for (let i = 1; i <= 8; i++) {
    const failed = i % 2 === 0;
    const hook = failed ? failure! : success!;
    contexts.push(
      await hook(
        {
          hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse',
          tool_name: 'Read',
          tool_input: i % 2 ? { path: 'a', offset: 1 } : { offset: 1, path: 'a' },
          tool_use_id: `call-${i}`,
        } as never,
        undefined,
        { signal: new AbortController().signal },
      ),
    );
  }
  expect(
    contexts.map((value, i) => ('hookSpecificOutput' in value ? i + 1 : null)).filter(Boolean),
  ).toEqual([3, 5, 8]);
  for (const value of contexts) {
    expect(JSON.stringify(value)).not.toMatch(
      /permissionDecision|updatedToolOutput|classifierContext/,
    );
  }
});

it('keeps native turn-limit diagnostics separate from model capability and never exposes SDK error text', async () => {
  sdkResult({
    subtype: 'error_max_turns',
    num_turns: 500,
    errors: ['secret-key=private'],
    stop_reason: 'max_turns',
  });
  const error = await runModelWorker(job, options()).catch((error: unknown) => error);
  expect(workerStop(error)).toEqual({ kind: 'harness_limit', reason: 'turn_guard', turns: 500 });
  expect(JSON.stringify(error)).not.toContain('secret-key');
  expect(native.close).toHaveBeenCalled();
  expect(native.bridgeClose).toHaveBeenCalled();
});

it.each(['', '/repo/custom-claude'])(
  'protects the exact credentials file in a defined custom config %s without hiding the workspace',
  async (config) => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', config);
    try {
      sdkResult({ subtype: 'success', result: 'done' });
      await runModelWorker(job, options());
      const call = vi.mocked(query).mock.calls[0]![0];
      const credential = (config || '/repo') + '/.credentials.json';
      expect(call.options?.env?.CLAUDE_CONFIG_DIR).toBe(config);
      expect(call.options?.settings).toHaveProperty(
        'permissions.deny',
        expect.arrayContaining([
          `Read(/${credential})`,
          `Edit(/${credential})`,
          `Write(/${credential})`,
        ]),
      );
      expect(call.options?.settings).toHaveProperty('env.CLAUDE_CODE_DISABLE_AUTO_MEMORY', '1');
      expect(call.options?.sandbox?.filesystem?.denyRead).toContain(credential);
      expect(call.options?.sandbox?.filesystem?.denyRead).not.toContain('/repo');
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.each(['/repo/secure-storage', ''])(
  'protects native secure-storage fallback %s from file tools and Bash',
  async (secure) => {
    vi.mocked(resolveSettings).mockResolvedValue({
      effective: { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: secure } },
    } as never);
    sdkResult({ subtype: 'success', result: 'done' });
    await runModelWorker(job, options());
    const call = vi.mocked(query).mock.calls[0]![0];
    const credential = join(secure || join(homedir(), '.claude'), '.credentials.json');
    expect(call.options?.settings).toHaveProperty(
      'permissions.deny',
      expect.arrayContaining([
        `Read(/${credential})`,
        `Edit(/${credential})`,
        `Write(/${credential})`,
      ]),
    );
    expect(call.options?.sandbox?.filesystem?.denyRead).toContain(credential);
  },
);

it.each(['auto', 'default'] as const)(
  'in %s mode routes a would-be prompt to a person only when one can answer',
  async (mode) => {
    const owned = {
      ...job,
      decision: { ...job.decision, claudePermissionMode: mode },
    } as unknown as ModelJob;
    vi.mocked(query).mockImplementation(
      (call) =>
        ({
          async *[Symbol.asyncIterator]() {
            for await (const message of call.prompt) native.promptMessages.push(message);
            yield { type: 'system', subtype: 'init', permissionMode: mode, cwd: '/repo' };
            yield { type: 'result', subtype: 'success', result: 'finished' };
          },
          accountInfo: async () => ({ apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' }),
          mcpServerStatus: async () => [],
          close: native.close,
        }) as unknown as ReturnType<typeof query>,
    );
    await expect(
      runModelWorker(owned, {
        ...options(),
        claudePermissionMode: mode,
        currentClaudePermissionMode: () => mode,
      }),
    ).resolves.toBe('finished');
    const sent = vi.mocked(query).mock.calls.at(-1)![0].options!;
    if (mode === 'auto') {
      // Auto mode: the classifier decides; nothing may wait on a person dialog.
      expect(sent.permissionPrompts).toBe('none');
      expect(sent.canUseTool).toBeUndefined();
      expect(sent.disallowedTools).toContain('AskUserQuestion');
    } else {
      expect(sent.permissionPrompts).toBeUndefined();
      expect(sent.canUseTool).toBeTypeOf('function');
      expect(sent.disallowedTools).not.toContain('AskUserQuestion');
    }
  },
);
