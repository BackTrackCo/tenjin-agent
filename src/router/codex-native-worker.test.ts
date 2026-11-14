import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withAppServer, type CodexAppOptions } from '../lib/codex-app-server';
import { canonicalHash } from '../lib/request-schema';
import { readCodexInstructionFilesOnServer } from './codex-instruction-reader';
import { qualifyNativeCodexWorker, runNativeCodexWorker } from './codex-native-worker';
import type { CodexModelPolicy } from './codex-model-gates';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';
import { codexModelPolicy } from './codex-model-context';

const http = vi.hoisted(() => ({
  handler: undefined as undefined | ((req: unknown, res: unknown) => void),
  closed: 0,
}));
vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  createServer: (handler: typeof http.handler) => {
    http.handler = handler;
    const server = new EventEmitter() as EventEmitter & Record<string, unknown>;
    server.listen = (_port: number, _host: string, done: () => void) => done();
    server.address = () => ({ port: 18091 });
    server.closeAllConnections = () => {};
    server.close = (done: () => void) => {
      http.closed++;
      done();
    };
    return server;
  },
}));
vi.mock('../lib/codex-app-server', () => ({ withAppServer: vi.fn() }));
vi.mock('./codex-model-context', () => ({ codexModelPolicy: vi.fn() }));
vi.mock('../lib/codex-bin', () => ({ resolveCodex: () => ({ cmd: '/native/codex', prefix: [] }) }));
vi.mock('./codex-instruction-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codex-instruction-reader')>()),
  readCodexInstructionFilesOnServer: vi.fn(),
}));
let dir: string,
  dataDir: string,
  root: string,
  home: string,
  policy: CodexModelPolicy,
  config: Record<string, unknown>,
  hooks: Record<string, unknown>[],
  inventory: Record<string, unknown>[];
let requests: Array<{ method: string; params: unknown }>,
  callbacks: CodexAppOptions,
  env: NodeJS.ProcessEnv,
  closed: boolean;
let failure: unknown;
let parentOverride: Record<string, unknown> | undefined;
let loadedHooks: Record<string, unknown>[] | undefined;
let parentEnvironments: unknown;
let providerOverride: Record<string, unknown> | undefined;
let effectiveOverride: Record<string, unknown> | undefined;
let startOverride: Record<string, unknown> | undefined, onTurn: (() => Promise<void>) | undefined;
const permission = vi.fn(async () => true),
  responses = vi.fn(async () => 'event: response.completed\ndata: {}\n\n');
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'native-codex-worker-')));
  root = join(dir, 'repo');
  home = join(dir, 'home');
  dataDir = join(dir, 'data');
  await mkdir(dataDir);
  await writeFile(
    join(dataDir, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: {
          version: 2,
          instructions: 'applicable',
          recipients: ['Tenjin', 'DeepSeek'],
          repositories: [root],
          maxJobAtomic: '1000000',
          routerOrigin: 'http://localhost',
        },
      },
    }),
  );
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'AGENTS.md'), 'GLOBAL_NATIVE_INSTRUCTION\n');
  await writeFile(join(root, 'AGENTS.md'), 'REPO_NATIVE_INSTRUCTION\n');
  await writeFile(join(dir, 'config.toml'), '# owned native config\n');
  vi.stubEnv('CODEX_HOME', join(home, '.codex'));
  config = {
    approvals_reviewer: 'auto_review',
    mcp_servers: { fixture: {}, router: {} },
    project_doc_max_bytes: 32768,
  };
  hooks = [];
  inventory = [
    {
      name: 'fixture',
      runtimeStatus: 'connected',
      authStatus: 'oAuth',
      toolsError: null,
      tools: { read: { name: 'read', inputSchema: { type: 'object' } } },
    },
  ];
  const parent = {
    sessionId: 'parent',
    turnId: 'parent-turn',
    baseInstructions: 'EXACT_PARENT_BASE',
    developerInstructions: 'EXTRA_PARENT_AUTHORITY',
    runtimeWorkspaceRoots: [root],
    transcriptPath: join(dir, 'owned-rollout.jsonl'),
    localEnvironment: {
      cwd: root,
      filesystem: 'NATIVE_FILESYSTEM_WITNESS',
      shell: 'zsh',
      network: null,
      fingerprint: canonicalHash({ cwd: root, filesystem: 'NATIVE_FILESYSTEM_WITNESS' }),
    },
  };
  policy = {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: { type: 'workspace-write' },
    permissionProfile: {
      type: 'managed',
      network: 'restricted',
      file_system: {
        type: 'restricted',
        entries: [
          { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
          { path: { type: 'path', path: root }, access: 'write' },
        ],
      },
    },
    disabledPluginIds: [],
    parent: { ...parent, fingerprint: canonicalHash(parent) },
  };
  requests = [];
  callbacks = {};
  env = {};
  closed = false;
  parentOverride = undefined;
  loadedHooks = undefined;
  parentEnvironments = null;
  startOverride = undefined;
  providerOverride = undefined;
  effectiveOverride = undefined;
  onTurn = undefined;
  permission.mockClear();
  responses.mockClear();
  http.closed = 0;
  vi.mocked(codexModelPolicy).mockImplementation(async () => {
    const current = structuredClone(policy);
    if (current.parent && parentOverride) {
      Object.assign(current.parent, parentOverride);
      const authority = Object.fromEntries(
        Object.entries(current.parent).filter(([key]) => key !== 'fingerprint'),
      );
      current.parent.fingerprint = canonicalHash(authority);
    }
    return current;
  });
  vi.mocked(readCodexInstructionFilesOnServer).mockImplementation(
    async (_request, _options, paths) =>
      Promise.all(
        paths.map(async (path) => {
          const bytes = await readFile(path),
            s = await stat(path);
          return {
            path,
            contents: bytes.toString('utf8'),
            bytes: bytes.length,
            stamp: canonicalHash({
              bytes: bytes.toString('base64'),
              ino: s.ino,
              dev: s.dev,
              mode: s.mode,
            }),
          };
        }),
      ),
  );
  vi.mocked(withAppServer).mockImplementation(
    async (_home, childEnv, _timeout, fn, options = {}) => {
      callbacks = options;
      env = childEnv;
      const providerConfig = options.configOverrides!.find((value) =>
        value.startsWith('model_providers.tenjin_deepseek_worker_v1='),
      )!;
      const ownedUrl = JSON.parse(/base_url=("[^"]*")/.exec(providerConfig)![1]!);
      const catalogPath = JSON.parse(
        options
          .configOverrides!.find((value) => value.startsWith('model_catalog_json='))!
          .slice('model_catalog_json='.length),
      );
      const defaultProfile = options.configOverrides?.find((value) =>
        value.startsWith('default_permissions='),
      );
      const purpose = () => ({
        model: 'deepseek-flash',
        model_provider: 'tenjin_deepseek_worker_v1',
        model_reasoning_effort: 'high',
        model_catalog_json: catalogPath,
        model_providers: {
          tenjin_deepseek_worker_v1: {
            name: 'Tenjin DeepSeek worker',
            base_url: ownedUrl,
            wire_api: 'responses',
            env_key: 'TENJIN_MODEL_TOKEN',
            requires_openai_auth: false,
            supports_websockets: false,
            request_max_retries: 0,
            stream_max_retries: 0,
            ...providerOverride,
          },
        },
      });
      try {
        if (
          !defaultProfile ||
          !options.configOverrides?.some((value) =>
            value.startsWith(`permissions.${JSON.parse(defaultProfile.slice(20))}.filesystem=`),
          )
        )
          throw new Error('Config defines permission profiles without an owned default');
        return await fn(async (method, params) => {
          requests.push({ method, params });
          if (method === 'thread/read')
            return {
              thread: {
                id: 'parent',
                sessionId: 'parent',
                parentThreadId: null,
                source: 'vscode',
                extra: null,
                environments: parentEnvironments,
              },
            };
          if (method === 'config/read')
            return {
              config: structuredClone({ ...config, ...purpose(), ...effectiveOverride }),
              layers: [
                {
                  name: { type: 'user', file: join(dir, 'config.toml') },
                  config: structuredClone(config),
                  version: 'user-unchanged',
                },
                {
                  name: { type: 'sessionFlags' },
                  config: purpose(),
                  version: canonicalHash(purpose()),
                },
              ],
            };
          if (method === 'hooks/list')
            return {
              data: [
                {
                  cwd: root,
                  hooks: structuredClone(
                    (params as { threadId?: string }).threadId ? (loadedHooks ?? hooks) : hooks,
                  ),
                  errors: [],
                  warnings: [],
                },
              ],
            };
          if (method === 'configRequirements/read') return { requirements: null };
          if (method === 'mcpServerStatus/list')
            return { data: structuredClone(inventory), nextCursor: null };
          if (method === 'thread/start') {
            const p = params as Record<string, unknown>;
            return {
              thread: { id: 'worker' },
              model: 'deepseek-flash',
              modelProvider: 'tenjin_deepseek_worker_v1',
              approvalPolicy: p.approvalPolicy,
              approvalsReviewer: p.approvalsReviewer,
              activePermissionProfile: { id: p.permissions },
              runtimeWorkspaceRoots: p.runtimeWorkspaceRoots,
              ...startOverride,
            };
          }
          if (method === 'turn/start') {
            queueMicrotask(() => {
              void onTurn?.();
            });
            return { turn: { id: 'worker-turn' } };
          }
          return {};
        }, '0.167.0-alpha.4.1');
      } catch (error) {
        failure = error;
        return null;
      } finally {
        closed = true;
      }
    },
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const qualify = () =>
  qualifyNativeCodexWorker({
    cwd: root,
    dataDir,
    policy,
    home,
    signal: new AbortController().signal,
  });
async function job() {
  const qualified = await qualify();
  expect(qualified).not.toBeNull();
  return {
    id: 'owned',
    root,
    task: 'Complete owned task',
    decision: { nativeSnapshot: qualified!.nativeSnapshot },
    native: { fork_turns: 'none' },
  } as unknown as ModelJob;
}
const options = (signal = new AbortController().signal) => ({
  dataDir,
  transport: { responses } as unknown as ModelTransport,
  signal,
  codexPolicy: policy,
  permission,
});
async function final() {
  await callbacks.onNotification?.('item/completed', {
    threadId: 'worker',
    turnId: 'worker-turn',
    item: {
      id: 'final',
      type: 'agentMessage',
      phase: 'final_answer',
      text: 'owned completed result',
    },
  });
  await callbacks.onNotification?.('turn/completed', {
    threadId: 'worker',
    turn: { id: 'worker-turn', status: 'completed' },
  });
}
async function provider(overrides: Record<string, unknown> = {}) {
  const req = Readable.from([
    JSON.stringify({
      model: 'deepseek-flash',
      reasoning: { effort: 'high' },
      stream: true,
      input: 'Owned provider fixture',
      ...overrides,
    }),
  ]) as unknown as Record<string, unknown>;
  req.method = 'POST';
  req.url = '/v1/responses';
  req.headers = { authorization: `Bearer ${env.TENJIN_MODEL_TOKEN}` };
  await new Promise<void>((resolve) => {
    const res = {
      destroyed: false,
      headersSent: false,
      writeHead() {
        res.headersSent = true;
        return res;
      },
      end() {
        resolve();
      },
    };
    http.handler!(req, res);
  });
}
it('qualifies native autoReview and preserves parent base, roots, authenticated MCP and command hooks without generation', async () => {
  hooks = [
    {
      handlerType: 'command',
      enabled: true,
      eventName: 'preToolUse',
      command: 'guard',
      trustStatus: 'trusted',
      currentHash: 'same-definition',
    },
  ];
  const q = await qualify();
  if (!q) throw failure;
  expect(q?.instructionContext.documents.map((d) => d.content.trim())).toEqual([
    'GLOBAL_NATIVE_INSTRUCTION',
    'REPO_NATIVE_INSTRUCTION',
  ]);
  const start = requests.find((r) => r.method === 'thread/start')!.params as Record<
    string,
    unknown
  >;
  expect(start).toMatchObject({
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    baseInstructions: 'EXACT_PARENT_BASE',
    developerInstructions: 'EXTRA_PARENT_AUTHORITY',
    runtimeWorkspaceRoots: [root],
    environments: [{ environmentId: 'local', cwd: root, runtimeWorkspaceRoots: [root] }],
  });
  expect(start).not.toHaveProperty('sandbox');
  expect(start).not.toHaveProperty('config.project_doc_max_bytes');
  expect(callbacks.configOverrides).toContain(
    `default_permissions=${JSON.stringify(start.permissions)}`,
  );
  expect(callbacks.configOverrides).toContainEqual(
    expect.stringMatching(
      new RegExp(`^permissions\\.${start.permissions}\\.filesystem=.*glob_scan_max_depth`),
    ),
  );
  expect(
    requests.some((r) => ['turn/start', 'command/exec', 'mcpServer/tool/call'].includes(r.method)),
  ).toBe(false);
  expect(callbacks.configOverrides).toEqual(
    expect.arrayContaining(['mcp_servers.router.env.TENJIN_MODEL_WORKER="1"']),
  );
  expect(env.TENJIN_MODEL_WORKER).toBe('1');
  expect(closed).toBe(true);
});
it.each([
  { handlerType: 'prompt' },
  { handlerType: 'agent' },
  { handlerType: 'command', eventName: 'preModelRequest' },
  { handlerType: 'command', trustStatus: 'untrusted' },
])('keeps unqualified hook authority native before starting a thread: %s', async (change) => {
  const base: Record<string, unknown> = {
    handlerType: 'command',
    enabled: true,
    eventName: 'preToolUse',
    command: 'guard',
    trustStatus: 'trusted',
    currentHash: 'same',
  };
  hooks = [{ ...base, ...change }];
  expect(await qualify()).toBeNull();
  expect(requests.some((r) => r.method === 'thread/start')).toBe(false);
});
const pluginDeclarationHash = `sha256:${'a'.repeat(64)}`;
const pluginContentHash = `sha256:${'b'.repeat(64)}`;
const pluginHook = () => ({
  key: 'owned-plugin-guard',
  handlerType: 'command',
  command: 'guard',
  eventName: 'preToolUse',
  enabled: true,
  source: 'plugin',
  pluginId: 'fixture@marketplace',
  trustStatus: 'trusted',
  currentHash: `${pluginDeclarationHash}/${pluginContentHash}`,
});
it('qualifies unchanged native plugin hooks while retaining their complete content hash', async () => {
  hooks = [pluginHook()];
  loadedHooks = [{ ...hooks[0], currentHash: pluginDeclarationHash }];
  expect(await qualify()).not.toBeNull();
  expect(requests.filter((r) => r.method === 'hooks/list').map((r) => r.params)).toEqual([
    { cwds: [root] },
    { cwds: [root] },
    { threadId: 'worker' },
  ]);
});
it.each([
  { currentHash: `sha256:${'c'.repeat(64)}` },
  { pluginId: 'different@marketplace' },
  { source: 'user' },
  { command: 'different guard' },
  { trustStatus: 'untrusted' },
  { currentHash: `${pluginDeclarationHash}/${pluginContentHash}` },
])('refuses loaded plugin-hook authority mismatches: %s', async (change) => {
  hooks = [pluginHook()];
  loadedHooks = [{ ...hooks[0], currentHash: pluginDeclarationHash, ...change }];
  expect(await qualify()).toBeNull();
  expect(responses).not.toHaveBeenCalled();
});
it('rejects plugin content drift even when the loaded declaration stays identical', async () => {
  hooks = [pluginHook()];
  loadedHooks = [{ ...hooks[0], currentHash: pluginDeclarationHash }];
  const accepted = await job();
  hooks[0]!.currentHash = `${pluginDeclarationHash}/sha256:${'c'.repeat(64)}`;
  await expect(runNativeCodexWorker(accepted, options())).rejects.toThrow(
    /host changed after recommendation/,
  );
  expect(responses).not.toHaveBeenCalled();
});
it('refuses downgraded native reviewer and disabled plugins that remain active', async () => {
  startOverride = { approvalsReviewer: 'user' };
  expect(await qualify()).toBeNull();
  startOverride = undefined;
  policy.disabledPluginIds = ['blocked'];
  inventory[0]!.pluginId = 'blocked';
  expect(await qualify()).toBeNull();
});
it('keeps opaque dotted plugin IDs in the TOML value instead of the native dotted-key path', async () => {
  policy.disabledPluginIds = ['tool.with.dots@marketplace.example', 'other@marketplace'];
  expect(await qualify()).not.toBeNull();
  const overrides = callbacks.configOverrides!.filter((value) => value.startsWith('plugins'));
  expect(overrides).toHaveLength(1);
  const override = overrides[0]!;
  // The pinned native key parser uses path.split('.'); quoting a key segment
  // cannot protect periods or remove quotes from a plugin identity.
  expect(override.slice(0, override.indexOf('='))).toBe('plugins');
  for (const id of policy.disabledPluginIds)
    expect(override.slice(override.indexOf('=') + 1)).toContain(
      `${JSON.stringify(id)} = { enabled = false }`,
    );
});
it('keeps missing parent authority native before any child starts', async () => {
  delete policy.parent;
  expect(await qualify()).toBeNull();
});
it('never interprets a null loaded-parent selection as local without frozen native evidence', async () => {
  delete policy.parent!.localEnvironment;
  expect(await qualify()).toBeNull();
  expect(requests).toEqual([]);
  expect(responses).not.toHaveBeenCalled();
});
it.each([
  { selection: [] },
  { selection: [{ environmentId: 'remote', cwd: '/other', runtimeWorkspaceRoots: [] }] },
])(
  'refuses a loaded selection contradicting proved native local state: %s',
  async ({ selection }) => {
    parentEnvironments = selection;
    expect(await qualify()).toBeNull();
    expect(requests.some((r) => r.method === 'thread/start')).toBe(false);
  },
);
it('re-reads parent authority before acceptance/start, before native initialization or fees', async () => {
  await job();
  requests = [];
  parentOverride = { localEnvironment: { ...policy.parent!.localEnvironment, network: 'changed' } };
  expect(await qualify()).toBeNull();
  expect(requests).toEqual([]);
  expect(responses).not.toHaveBeenCalled();
});
it('re-reads parent environment after worker start and before its first inference purchase', async () => {
  const accepted = await job();
  onTurn = async () => {
    parentOverride = {
      localEnvironment: { ...policy.parent!.localEnvironment, filesystem: 'changed' },
    };
    await provider();
  };
  await expect(runNativeCodexWorker(accepted, options())).rejects.toThrow(
    /parent environment or authority changed/,
  );
  expect(responses).not.toHaveBeenCalled();
});
it('rejects an updated parent deferred inventory before its first inference purchase', async () => {
  const accepted = await job();
  onTurn = async () => {
    parentOverride = { deferredNamespaces: ['mcp__newly_advertised'] };
    await provider();
  };
  await expect(runNativeCodexWorker(accepted, options())).rejects.toThrow(
    /parent environment or authority changed/,
  );
  expect(responses).not.toHaveBeenCalled();
});
it('takes only the owned completed final answer, including notifications racing turn/start', async () => {
  const accepted = await job();
  onTurn = async () => {
    await callbacks.onNotification?.('item/completed', {
      threadId: 'foreign',
      turnId: 'worker-turn',
      item: { id: 'evil', type: 'agentMessage', phase: 'final_answer', text: 'foreign' },
    });
    await final();
  };
  expect(await runNativeCodexWorker(accepted, options())).toBe('owned completed result');
  expect(http.closed).toBe(1);
  expect(
    requests.some((r) => r.method === 'mcpServer/tool/call' || r.method === 'command/exec'),
  ).toBe(false);
});
it('uses the paid Responses bridge for worker calls and defaults only the bounded output cap', async () => {
  const accepted = await job();
  onTurn = async () => {
    await provider();
    await final();
  };
  expect(await runNativeCodexWorker(accepted, options())).toBe('owned completed result');
  expect(responses).toHaveBeenCalledWith(
    accepted,
    {
      model: 'deepseek-flash',
      reasoning: { effort: 'high' },
      stream: true,
      input: 'Owned provider fixture',
      max_output_tokens: 65536,
    },
    expect.any(AbortSignal),
  );
});
it('config drift before first inference aborts without purchasing a request', async () => {
  const accepted = await job();
  onTurn = async () => {
    config.changedPolicy = 'new';
    await provider();
  };
  await expect(runNativeCodexWorker(accepted, options())).rejects.toThrow(/configuration changed/);
  expect(responses).not.toHaveBeenCalled();
  expect(http.closed).toBe(1);
});
it('initial AGENTS drift aborts before provider inference', async () => {
  const accepted = await job();
  onTurn = async () => {
    await writeFile(join(root, 'AGENTS.md'), 'CHANGED_BINDING');
    await provider();
  };
  await expect(runNativeCodexWorker(accepted, options())).rejects.toThrow(/instructions changed/);
  expect(responses).not.toHaveBeenCalled();
});
it('preserves a fatal paid transport failure and stops after one attempted bridge call', async () => {
  const accepted = await job();
  responses.mockRejectedValueOnce(new Error('signed receipt remains uncertain'));
  onTurn = provider;
  await expect(runNativeCodexWorker(accepted, options())).rejects.toThrow(
    'signed receipt remains uncertain',
  );
  expect(responses).toHaveBeenCalledTimes(1);
  expect(http.closed).toBe(1);
});
it('cancellation interrupts the native turn and drains the owned bridge', async () => {
  const accepted = await job(),
    controller = new AbortController();
  onTurn = async () => {
    await Promise.resolve();
    controller.abort(new Error('User stopped'));
  };
  await expect(runNativeCodexWorker(accepted, options(controller.signal))).rejects.toThrow(
    'User stopped',
  );
  expect(requests.some((r) => r.method === 'turn/interrupt')).toBe(true);
  expect(http.closed).toBe(1);
  expect(closed).toBe(true);
});
it('one-shot native approval preserves owned command details and refuses unknown grants/forms', async () => {
  const accepted = await job();
  onTurn = async () => {
    expect(
      await callbacks.onServerRequest!('item/commandExecution/requestApproval', {
        threadId: 'worker',
        turnId: 'worker-turn',
        itemId: 'cmd',
        command: 'echo owned',
        cwd: root,
      }),
    ).toEqual({ decision: 'accept' });
    expect(
      await callbacks.onServerRequest!('item/commandExecution/requestApproval', {
        threadId: 'worker',
        turnId: 'worker-turn',
        itemId: 'cmd',
        command: 'echo owned',
        cwd: root,
        additionalPermissions: { network: true },
      }),
    ).toEqual({ decision: 'decline' });
    expect(
      await callbacks.onServerRequest!('mcpServer/elicitation/request', {
        threadId: 'worker',
        turnId: 'worker-turn',
      }),
    ).toEqual({ action: 'cancel' });
    await final();
  };
  await runNativeCodexWorker(accepted, options());
  expect(permission).toHaveBeenCalledTimes(1);
});

it('lets trusted MCP hook guards run through the native pipeline', async () => {
  hooks = [
    {
      handlerType: 'mcpTool',
      enabled: true,
      eventName: 'preToolUse',
      server: 'fixture',
      tool: 'guard',
      trustStatus: 'trusted',
      currentHash: 'native-mcp-guard',
    },
  ];
  expect(await qualify()).not.toBeNull();
  expect(requests.some((r) => r.method === 'mcpServer/tool/call')).toBe(false);
});
it('refuses an explicitly parent-served external namespace missing from the child catalog', async () => {
  policy.parent!.externalTools = [{ namespace: 'mcp__cua_repl', tools: ['js'] }];
  expect(await qualify()).toBeNull();
  expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
  policy.parent!.externalTools = [{ namespace: 'mcp__fixture', tools: ['read'] }];
  expect(await qualify()).not.toBeNull();
});
it('requires deferred-only parent capabilities even when no tools were materialized', async () => {
  policy.parent!.deferredNamespaces = ['mcp__artifact_session', 'mcp__codex_app', 'mcp__fixture'];
  expect(await qualify()).toBeNull();
  expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
  expect(responses).not.toHaveBeenCalled();
  policy.parent!.deferredNamespaces = ['mcp__fixture'];
  expect(await qualify()).not.toBeNull();
  inventory[0]!.tools = {};
  expect(await qualify()).toBeNull();
});
it('does not treat arbitrary MCP tool metadata as proof of another native namespace', async () => {
  policy.parent!.deferredNamespaces = ['mcp__artifact_session'];
  inventory[0]!.tools = { read: { name: 'read', namespace: 'mcp__artifact_session' } };
  expect(await qualify()).toBeNull();
  expect(responses).not.toHaveBeenCalled();
});
it('native rule-file drift is detected before the first paid request', async () => {
  await mkdir(join(dir, 'rules'));
  const rule = join(dir, 'rules', 'fixture.rules');
  await writeFile(rule, 'prefix_rule(pattern=["python3"], decision="prompt")');
  const accepted = await job();
  onTurn = async () => {
    await writeFile(rule, 'prefix_rule(pattern=["python3"], decision="forbidden")');
    await provider();
  };
  await expect(runNativeCodexWorker(accepted, options())).rejects.toThrow(/configuration changed/);
  expect(responses).not.toHaveBeenCalled();
});

it.each([
  { base_url: 'https://outside.invalid/v1' },
  { env_key: 'OPENAI_API_KEY' },
  { wire_api: 'chat' },
  { requires_openai_auth: true },
  { supports_websockets: true },
  { request_max_retries: 1 },
  { http_headers: { authorization: 'unexpected-auth' } },
  { query_params: { redirect: 'elsewhere' } },
  { experimental_bearer_token: 'unowned' },
  { auth: { command: 'unowned' } },
  { env_http_headers: { authorization: 'OPENAI_API_KEY' } },
  { capabilities: { web_search: true } },
  { model_catalog_url: 'https://outside.invalid/models' },
  { supports_standalone_web_search: true },
  { unknown_native_option: null },
])('rejects effective provider overrides before projection/thread start: %s', async (changed) => {
  providerOverride = changed;
  expect(await qualify()).toBeNull();
  expect(requests.some((r) => r.method === 'thread/start')).toBe(false);
});
it('accepts the exact fully serialized native provider defaults without accepting additional authority', async () => {
  providerOverride = {
    model_catalog_url: null,
    env_key_instructions: null,
    experimental_bearer_token: null,
    auth: null,
    gateway_oauth: null,
    aws: null,
    project_id: null,
    location: null,
    credential_file: null,
    capabilities: null,
    query_params: null,
    http_headers: null,
    env_http_headers: null,
    stream_idle_timeout_ms: null,
    websocket_connect_timeout_ms: null,
    supports_standalone_web_search: false,
  };
  expect(await qualify()).not.toBeNull();
  expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
});
it('rejects an effective unowned catalog before a thread starts', async () => {
  effectiveOverride = { model_catalog_json: '/unowned/catalog.json' };
  expect(await qualify()).toBeNull();
  expect(requests.some((r) => r.method === 'thread/start')).toBe(false);
});
it.each(['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_API_KEY'])(
  'keeps an active foreign MCP requiring cleared %s native before thread start or purchase',
  async (key) => {
    config.mcp_servers = { fixture: { env_vars: [key] } };
    expect(await qualify()).toBeNull();
    expect(requests.some((r) => r.method === 'thread/start')).toBe(false);
    expect(responses).not.toHaveBeenCalled();
  },
);
it('preserves an explicit foreign MCP credential override without restoring it to worker commands', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'parent-provider-secret');
  config.mcp_servers = {
    fixture: {
      env_vars: ['OPENAI_API_KEY', 'NEON_API_KEY'],
      env: { OPENAI_API_KEY: 'explicit-fixture-credential' },
    },
  };
  expect(await qualify()).not.toBeNull();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(config.mcp_servers).toMatchObject({
    fixture: { env: { OPENAI_API_KEY: 'explicit-fixture-credential' } },
  });
});
it('ignores disabled and owned MCP env dependencies and preserves unrelated MCP auth', async () => {
  config.mcp_servers = {
    disabled: { enabled: false, env_vars: ['OPENAI_API_KEY'] },
    router: { env_vars: ['TYPESAFE_KEY'] },
    fixture: { env_vars: ['NEON_API_KEY'] },
  };
  expect(await qualify()).not.toBeNull();
});
it('refuses an empty literal MCP override and catches an auth dependency added before inference', async () => {
  config.mcp_servers = { fixture: { env_vars: ['OPENAI_API_KEY'], env: { OPENAI_API_KEY: '' } } };
  expect(await qualify()).toBeNull();
  config.mcp_servers = { fixture: {} };
  const accepted = await job();
  onTurn = async () => {
    config.mcp_servers = { fixture: { env_vars: ['OPENAI_API_KEY'] } };
    await provider();
  };
  await expect(runNativeCodexWorker(accepted, options())).rejects.toThrow(
    /Native MCP requires a provider credential/,
  );
  expect(responses).not.toHaveBeenCalled();
});
it('revalidates effective provider destination before first paid inference', async () => {
  const accepted = await job();
  onTurn = async () => {
    providerOverride = { base_url: 'https://outside.invalid/v1' };
    await provider();
  };
  await expect(runNativeCodexWorker(accepted, options())).rejects.toThrow(
    /provider\/catalog authority changed/,
  );
  expect(responses).not.toHaveBeenCalled();
});
it('preserves user-layer model changes while normalizing only owned session flag versions', async () => {
  const accepted = await job();
  config.model = 'new-user-model';
  onTurn = final;
  await expect(runNativeCodexWorker(accepted, options())).rejects.toThrow(
    /host changed after recommendation/,
  );
  expect(responses).not.toHaveBeenCalled();
});
it('allows low effort only for an explicitly native Guardian request', async () => {
  const accepted = await job();
  onTurn = async () => {
    await provider({
      reasoning: { effort: 'low' },
      client_metadata: { 'x-openai-subagent': 'guardian' },
    });
    await final();
  };
  expect(await runNativeCodexWorker(accepted, options())).toBe('owned completed result');
  expect(responses).toHaveBeenCalledWith(
    accepted,
    expect.objectContaining({ reasoning: { effort: 'low' } }),
    expect.any(AbortSignal),
  );
});
it.each([
  { reasoning: { effort: 'low' } },
  { reasoning: { effort: 'high' }, client_metadata: { 'x-openai-subagent': 'guardian' } },
])('refuses native request effort/role drift before a purchase: %s', async (changed) => {
  const accepted = await job();
  onTurn = async () => {
    await provider(changed);
  };
  await expect(runNativeCodexWorker(accepted, options())).rejects.toThrow(
    /Unsupported native model request/,
  );
  expect(responses).not.toHaveBeenCalled();
});
