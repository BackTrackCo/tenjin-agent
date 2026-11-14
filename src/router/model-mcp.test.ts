import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const worker = vi.hoisted(() => ({
  run: vi.fn(),
  qualified: vi.fn(
    async (cwd = '/repo', _profile?: string, ..._other: unknown[]) =>
      ({
        path: 'worker',
        claudeWorkspace: {
          version: 1 as const,
          root: cwd,
          workingDirectories: [cwd],
          workingDirectorySpellings: [cwd].slice().sort(),
          readExceptions: [] as string[],
          writeExceptions: [] as string[],
        },
      }) as {
        path: string;
        claudeWorkspace: {
          version: 1;
          root: string;
          workingDirectories: string[];
          workingDirectorySpellings: string[];
          readExceptions: string[];
          writeExceptions: string[];
        };
      } | null,
  ),
}));
vi.mock('./model-worker', () => ({
  runModelWorker: worker.run,
  qualifiedModelWorker: worker.qualified,
}));
import { registerModelTool } from './model-mcp';
import { ModelJobStore } from './model-job';
import type { ModelSession } from './model-handoff';
import type { ModelTransport } from './model-transport';
import offer from './fixtures/model-offer.json';
import parentPolicy from './model-parent-policy.json';
import { ModelWorkerStopped } from './model-worker-control';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { MODEL_WORKER_HANDLE_PREFIX, ModelConversationStore } from './model-conversations';
import type { ModelJob } from './model-job';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo: vi.fn() }));

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  worker.qualified.mockImplementation(async (cwd = '/repo') => ({
    path: 'worker',
    claudeWorkspace: {
      version: 1,
      root: cwd,
      workingDirectories: [cwd],
      workingDirectorySpellings: [cwd].slice().sort(),
      readExceptions: [],
      writeExceptions: [],
    },
  }));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

it.each(['default', 'acceptEdits', 'auto', 'dontAsk'] as const)(
  'binds an owned Claude %s offer independently of model-supplied mode claims',
  async (mode) => {
    worker.run.mockResolvedValue('completed fixture');
    dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-mode-offer-')));
    await mkdir(join(dir, 'native-config'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(dir, 'native-config'));
    const repo = join(dir, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        router: {
          subagents: true,
          subagentConsent: {
            version: 2,
            instructions: 'applicable',
            recipients: ['Tenjin', 'DeepSeek'],
            repositories: [repo],
            maxJobAtomic: '1000000',
            routerOrigin: 'http://localhost:3939',
          },
        },
      }),
    );
    const transcript = join(dir, 'root.jsonl');
    await writeFile(
      transcript,
      JSON.stringify({
        type: 'user',
        sessionId: 'root',
        message: { role: 'user', content: 'Check the selected function.' },
      }),
    );
    const session: ModelSession = {
      sessionId: 'root',
      turnId: 'turn',
      cwd: repo,
      transcript,
      harness: 'claude',
      claudePermissionMode: mode,
    };
    const route = vi.fn(async (body: { jobId: string }) => ({ ...offer, jobId: body.jobId }));
    const transport = {
      origin: 'http://localhost:3939',
      route,
      summary: async () => ({ actualAtomic: '0' }),
    } as unknown as ModelTransport;
    const server = new McpServer({ name: 'test', version: '1' });
    const model = registerModelTool(server, {
      dataDir: dir,
      harness: 'claude',
      session: () => session,
      transport: async () => transport,
    });
    const client = new Client(
      { name: 'test', version: '1' },
      { capabilities: { elicitation: { form: {} } } },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const listed = await client.listTools();
      const tool = listed.tools.find((tool) => tool.name === 'subagent');
      expect(tool?.description).toContain('Accept with offer_id');
      expect(tool?.description).not.toContain(parentPolicy);
      expect(tool?._meta?.['anthropic/alwaysLoad']).toBeUndefined();
      const captured = await client.callTool({
        name: 'subagent',
        arguments: {
          capture: {
            session_id: 'root',
            tool_use_id: 'native-call',
            input: {
              prompt: 'Read the selected function and report facts.',
              subagent_type: 'general-purpose',
              permission_mode: 'bypassPermissions',
            },
          },
        },
      });
      expect(JSON.stringify(captured)).toContain('offer_id');
      const store = new ModelJobStore(dir);
      const pending = await store.pending('root', 'turn');
      expect(pending?.decision.claudePermissionMode).toBe(mode);
      expect(JSON.stringify(route.mock.calls)).not.toContain('permissionMode');
      const accepted = await client.callTool({
        name: 'subagent',
        arguments: { offer_id: pending!.id },
      });
      expect(JSON.stringify(accepted)).toContain('completed fixture');
      const options = worker.run.mock.calls.at(-1)?.[1];
      expect(options.claudePermissionMode).toBe(mode);
      expect(options.currentClaudePermissionMode()).toBe(mode);
      session.claudePermissionMode = mode === 'auto' ? 'default' : 'auto';
      expect(options.currentClaudePermissionMode()).toBe(session.claudePermissionMode);
      session.claudePermissionMode = mode;
      const second = await store.offer({
        sessionId: 'root',
        turnId: 'next-turn',
        callId: 'next',
        root: repo,
        task: 'Read',
        native: {},
        capAtomic: '1000000',
        decision: { routerOrigin: transport.origin, claudePermissionMode: mode },
      });
      await store.decided(second.id, {
        action: 'model',
        routerOrigin: transport.origin,
        claudePermissionMode: mode,
      });
      session.turnId = 'next-turn';
      session.claudePermissionMode = mode === 'auto' ? 'default' : 'auto';
      const before = worker.run.mock.calls.length;
      expect(
        JSON.stringify(
          await client.callTool({ name: 'subagent', arguments: { offer_id: second.id } }),
        ),
      ).toContain('native');
      expect(worker.run.mock.calls.length).toBe(before);
      expect((await store.pending('root', 'next-turn'))?.state).toBe('offered');
    } finally {
      await model.shutdown();
      await client.close();
      await server.close();
    }
  },
);
it('cancels and drains an accepted Codex worker on the trusted lifecycle bridge; stale acceptance never restarts it', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-mcp-')));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: {
          version: 2,
          instructions: 'applicable',
          recipients: ['Tenjin', 'DeepSeek'],
          repositories: [repo],
          maxJobAtomic: '1000000',
          routerOrigin: 'http://localhost:3939',
        },
      },
    }),
  );
  const session: ModelSession = {
    sessionId: 'root',
    turnId: 'turn',
    cwd: repo,
    transcript: 'unused',
    harness: 'codex',
    codexPolicy: { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: {} },
  };
  const store = new ModelJobStore(dir);
  const job = await store.offer({
    sessionId: 'root',
    turnId: 'turn',
    callId: 'call',
    root: repo,
    task: 'Read fixture',
    native: {},
    capAtomic: '1000000',
    decision: { routerOrigin: 'http://localhost:3939' },
  });
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  worker.run.mockImplementation(async (_job, options) => {
    started();
    await new Promise<void>((resolve) =>
      options.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    throw new Error('cancelled');
  });
  const server = new McpServer({ name: 'test', version: '1' });
  const model = registerModelTool(server, {
    dataDir: dir,
    harness: 'codex',
    session: () => session,
    transport: async () =>
      ({
        origin: 'http://localhost:3939',
        summary: async () => ({ actualAtomic: '3000', reservedAtomic: '3000', uncertain: [] }),
      }) as unknown as ModelTransport,
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const foreign = await client.callTool({
      name: 'subagent',
      arguments: { offer_id: job.id },
      _meta: { threadId: 'foreign' },
    });
    expect(JSON.stringify(foreign)).toContain('native');
    expect(worker.run).not.toHaveBeenCalled();
    const running = client.callTool({
      name: 'subagent',
      arguments: { offer_id: job.id },
      _meta: { threadId: 'root' },
    });
    await Promise.race([
      began,
      running.then((result) => {
        throw new Error(`Worker did not start: ${JSON.stringify(result)}`);
      }),
    ]);
    await model.fence(session);
    expect(JSON.stringify(await running)).toContain('cancelled');
    const retry = await client.callTool({
      name: 'subagent',
      arguments: { offer_id: job.id },
      _meta: { threadId: 'root' },
    });
    expect(JSON.stringify(retry)).toContain('native');
    expect(worker.run).toHaveBeenCalledTimes(1);
  } finally {
    await model.shutdown();
    await client.close();
    await server.close();
  }
});

it('reports a harness stop while retaining uncertain spend and refusing repeated acceptance', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-harness-stop-')));
  const repo = join(dir, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: {
          version: 2,
          instructions: 'applicable',
          recipients: ['Tenjin', 'DeepSeek'],
          repositories: [repo],
          maxJobAtomic: '1000000',
          routerOrigin: 'http://localhost:3939',
        },
      },
    }),
  );
  const session: ModelSession = {
    sessionId: 'root',
    turnId: 'turn',
    cwd: repo,
    transcript: 'unused',
    harness: 'codex',
    codexPolicy: { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: {} },
  };
  const store = new ModelJobStore(dir);
  const job = await store.offer({
    sessionId: 'root',
    turnId: 'turn',
    callId: 'call',
    root: repo,
    task: 'Read fixture',
    native: {},
    capAtomic: '1000000',
    decision: { routerOrigin: 'http://localhost:3939' },
  });
  const spend = { actualAtomic: '3000', reservedAtomic: '3000', uncertain: ['owned-invocation'] };
  worker.run.mockRejectedValue(
    new ModelWorkerStopped({
      kind: 'harness_limit',
      reason: 'turn_guard',
      turns: 500,
    }),
  );
  const server = new McpServer({ name: 'test', version: '1' });
  const model = registerModelTool(server, {
    dataDir: dir,
    harness: 'codex',
    session: () => session,
    transport: async () =>
      ({
        origin: 'http://localhost:3939',
        summary: async () => spend,
      }) as unknown as ModelTransport,
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const accepted = await client.callTool({
      name: 'subagent',
      arguments: { offer_id: job.id },
      _meta: { threadId: 'root' },
    });
    const content = (accepted.content as Array<{ text: string }>)[0]!.text;
    const result = JSON.parse(content);
    expect(result).toMatchObject({
      status: 'unknown',
      spend,
      stopReason: { kind: 'harness_limit', reason: 'turn_guard', turns: 500 },
      nextStep: expect.stringContaining('do not rebuy an uncertain turn'),
    });
    expect((await store.pending('root', 'turn'))?.state).toBe('unknown');
    const retry = await client.callTool({
      name: 'subagent',
      arguments: { offer_id: job.id },
      _meta: { threadId: 'root' },
    });
    expect(JSON.stringify(retry)).toContain('native');
    expect(worker.run).toHaveBeenCalledTimes(1);
  } finally {
    await model.shutdown();
    await client.close();
    await server.close();
  }
});

async function ownedClaudeFixture(agentType = 'general-purpose') {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'owned-model-continuation-')));
  const repo = join(dir, 'repo'),
    configDir = join(dir, 'native-config');
  await mkdir(join(repo, '.git'), { recursive: true });
  await mkdir(configDir);
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: {
          version: 2,
          instructions: 'applicable',
          recipients: ['Tenjin', 'DeepSeek'],
          repositories: [repo],
          maxJobAtomic: '1000000',
          routerOrigin: 'http://localhost:3939',
        },
      },
    }),
  );
  const transcript = join(dir, 'root.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'user',
      sessionId: 'root',
      message: { role: 'user', content: 'Continue the selected implementation.' },
    }),
  );
  const session: ModelSession = {
    sessionId: 'root',
    turnId: 'first-turn',
    cwd: repo,
    transcript,
    harness: 'claude',
    claudePermissionMode: 'default',
  };
  vi.mocked(getSessionInfo).mockImplementation(
    async (id) => ({ sessionId: id, cwd: repo }) as never,
  );
  worker.run.mockResolvedValue('completed owned fixture');
  const route = vi.fn(),
    requireResumeBudget = vi.fn(async (_job: ModelJob) => {});
  const summary = vi.fn(async () => ({
    actualAtomic: '3000',
    reservedAtomic: '3000',
    uncertain: [],
  }));
  const transport = {
    origin: 'http://localhost:3939',
    route,
    requireResumeBudget,
    summary,
  } as unknown as ModelTransport;
  const server = new McpServer({ name: 'test', version: '1' });
  const model = registerModelTool(server, {
    dataDir: dir,
    harness: 'claude',
    session: () => session,
    transport: async () => transport,
  });
  const client = new Client(
    { name: 'test', version: '1' },
    { capabilities: { elicitation: { form: {} } } },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const store = new ModelJobStore(dir),
    conversations = new ModelConversationStore(dir);
  const job = await store.offer(
    {
      sessionId: 'root',
      turnId: 'first-turn',
      callId: 'initial-call',
      root: repo,
      task: 'Implement the selected change.',
      native: { subagent_type: agentType },
      capAtomic: '1000000',
      decision: {},
    },
    'routing',
  );
  await store.decided(job.id, {
    ...offer,
    jobId: job.id,
    routerOrigin: transport.origin,
    claudePermissionMode: 'default',
    claudeWorkspace: {
      version: 1,
      root: repo,
      workingDirectories: [repo],
      workingDirectorySpellings: [repo].slice().sort(),
      readExceptions: [],
      writeExceptions: [],
    },
  });
  const call = async (args: Record<string, unknown>) => {
    const reply = await client.callTool({ name: 'subagent', arguments: args });
    return JSON.parse((reply.content as Array<{ text: string }>)[0]!.text);
  };
  const capture = async (handle: string, callId = 'followup-call') =>
    call({
      capture: {
        session_id: session.sessionId,
        tool_use_id: callId,
        tool: 'SendMessage',
        input: { to: handle, message: 'Continue the same change with the current constraints.' },
      },
    });
  const close = async () => {
    await model.shutdown();
    await client.close();
    await server.close();
  };
  return {
    repo,
    configDir,
    session,
    model,
    store,
    conversations,
    job,
    call,
    capture,
    close,
    route,
    requireResumeBudget,
  };
}

it('continues a Claude session through SendMessage with the original ledger and exact completed replay', async () => {
  const f = await ownedClaudeFixture();
  try {
    const first = await f.call({ offer_id: f.job.id });
    expect(first).toMatchObject({
      status: 'completed',
      worker_handle: expect.stringMatching(/^tenjin-worker-/),
      continuation: expect.stringContaining('SendMessage'),
    });
    const initialOptions = worker.run.mock.calls[0]![1];
    const sdkId = initialOptions.claudeSession.sessionId;
    expect(sdkId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(initialOptions.claudeSession.onSession(sdkId)).resolves.toBeUndefined();
    await expect(initialOptions.claudeSession.onSession('foreign')).rejects.toThrow(/session/);
    expect(JSON.stringify(first)).not.toContain(sdkId);
    expect(await f.call({ offer_id: f.job.id })).toEqual(first);
    expect(worker.run).toHaveBeenCalledTimes(1);
    f.session.turnId = 'followup-turn';
    f.session.claudePermissionMode = 'auto';
    const configPath = join(dir, 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.router.subagentConsent.maxJobAtomic = '500000';
    await writeFile(configPath, JSON.stringify(config));
    const held = await f.capture(first.worker_handle);
    expect(held).toMatchObject({
      action: 'offer',
      continuation: true,
      routingFeeAtomic: '0',
      capAtomic: '500000',
    });
    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(f.route).not.toHaveBeenCalled();
    config.router.subagentConsent.maxJobAtomic = '1000000';
    await writeFile(configPath, JSON.stringify(config));
    const result = await f.call({ offer_id: held.offer_id });
    expect(result.worker_handle).toBe(first.worker_handle);
    const [execution, options] = worker.run.mock.calls[1]!;
    expect(execution).toMatchObject({
      id: f.job.id,
      turnId: 'followup-turn',
      callId: 'followup-call',
      task: 'Continue the same change with the current constraints.',
      capAtomic: '500000',
      decision: { jobId: f.job.id, requireExistingBudget: true, claudePermissionMode: 'auto' },
    });
    expect(options.claudeSession).toMatchObject({ resume: sdkId });
    expect(options.claudeSession).not.toHaveProperty('sessionId');
    expect(f.requireResumeBudget.mock.calls.every(([job]) => job.id === f.job.id)).toBe(true);
    expect(await f.call({ offer_id: held.offer_id })).toEqual(result);
    expect(worker.run).toHaveBeenCalledTimes(2);
    const local = await f.store.pending('root', 'followup-turn');
    expect(local?.state).toBe('completed');
    expect(local?.result).toBeUndefined();
    const replay = await f.conversations.accept(
      first.worker_handle,
      {
        parentSessionId: 'root',
        root: f.repo,
        configDir: f.configDir,
      },
      held.offer_id,
    );
    expect(replay?.action).toBe('replay');
    if (replay?.action === 'replay') expect(JSON.parse(replay.result)).toEqual(result);
  } finally {
    await f.close();
  }
});

it('refuses acceptance when the independently qualified native workspace no longer matches the offered scope', async () => {
  const f = await ownedClaudeFixture();
  try {
    worker.qualified.mockImplementation(async (cwd) => ({
      path: 'worker',
      claudeWorkspace: {
        version: 1,
        root: cwd!,
        workingDirectories: [cwd!, join(dir, 'new-native-directory')],
        workingDirectorySpellings: [cwd!, join(dir, 'new-native-directory')].slice().sort(),
        readExceptions: [],
        writeExceptions: [],
      },
    }));
    expect(await f.call({ offer_id: f.job.id })).toMatchObject({
      action: 'native',
      reason: expect.stringContaining('Host permissions changed'),
    });
    expect(worker.run).not.toHaveBeenCalled();
    expect((await f.store.pending('root', 'first-turn'))?.state).toBe('offered');
  } finally {
    await f.close();
  }
});

it('replays a near-limit Claude result with JSON-escaped control characters from its single canonical conversation record', async () => {
  const f = await ownedClaudeFixture();
  try {
    const text = '\0'.repeat(255000);
    worker.run.mockResolvedValue(text);
    const first = await f.call({ offer_id: f.job.id });
    expect(first.status).toBe('completed');
    expect(first.result === text).toBe(true);
    const local = await f.store.pending('root', 'first-turn');
    expect(local?.state).toBe('completed');
    expect(local?.result).toBeUndefined();
    const replay = await f.call({ offer_id: f.job.id });
    expect(JSON.stringify(replay) === JSON.stringify(first)).toBe(true);
    expect(worker.run).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it.each(['running', 'unknown'] as const)(
  'recovers a durable Claude result from a %s local job after the separate completion writes were interrupted',
  async (state) => {
    const f = await ownedClaudeFixture();
    const finish = vi.spyOn(ModelJobStore.prototype, 'finish');
    try {
      finish.mockRejectedValueOnce(new Error('Synthetic local completion write failure'));
      const first = await f.call({ offer_id: f.job.id });
      expect(first.status).toBe('completed');
      expect((await f.store.pending('root', 'first-turn'))?.state).toBe('running');
      if (state === 'unknown') await f.store.finish(f.job.id, 'unknown');
      // Crash after continuation completion, before the separate conversation-idle
      // write and local job completion. No new model/tool activity may repair it.
      const path = join(
        dir,
        'model-conversations',
        first.worker_handle.slice(MODEL_WORKER_HANDLE_PREFIX.length) + '.json',
      );
      const conversation = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...conversation, state: 'running' }));
      expect(await f.call({ offer_id: f.job.id })).toEqual(first);
      expect((await f.store.pending('root', 'first-turn'))?.state).toBe(
        state === 'running' ? 'completed' : 'unknown',
      );
      expect(worker.run).toHaveBeenCalledTimes(1);
    } finally {
      finish.mockRestore();
      await f.close();
    }
  },
);

it('cancels an unstarted Claude continuation back to idle and refuses stale or changed-config selection', async () => {
  const f = await ownedClaudeFixture();
  try {
    const first = await f.call({ offer_id: f.job.id });
    f.session.turnId = 'cancel-offer';
    const held = await f.capture(first.worker_handle);
    const owner = { parentSessionId: 'root', root: f.repo, configDir: f.configDir };
    expect((await f.conversations.lookup(first.worker_handle, owner))?.state).toBe('offered');
    const changed = join(dir, 'changed-config');
    await mkdir(changed);
    vi.stubEnv('CLAUDE_CONFIG_DIR', changed);
    const refused = await f.call({ offer_id: held.offer_id });
    expect(refused.action).toBe('refused');
    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(await f.call({ cancel: held.offer_id })).toEqual({ status: 'cancelled' });
    expect((await f.conversations.lookup(first.worker_handle, owner))?.state).toBe('idle');
    vi.stubEnv('CLAUDE_CONFIG_DIR', f.configDir);
    expect((await f.call({ offer_id: held.offer_id })).action).toBe('refused');
    expect(worker.run).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('refuses a missing original ledger before activation and keeps a foreign Claude handle out of native fallback', async () => {
  const f = await ownedClaudeFixture();
  try {
    const first = await f.call({ offer_id: f.job.id });
    const multiple = await f.call({
      offer_id: f.job.id,
      capture: {
        session_id: 'root',
        tool_use_id: 'invalid-multiple',
        tool: 'SendMessage',
        input: { to: first.worker_handle, message: 'Continue with current constraints.' },
      },
    });
    expect(multiple.action).toBe('refused');
    f.session.turnId = 'ledger-turn';
    const held = await f.capture(first.worker_handle);
    f.requireResumeBudget.mockRejectedValue(new Error('Original ledger missing'));
    expect((await f.call({ offer_id: held.offer_id })).action).toBe('refused');
    expect((await f.store.pending('root', 'ledger-turn'))?.state).toBe('offered');
    expect(worker.run).toHaveBeenCalledTimes(1);
    f.session.sessionId = 'foreign';
    f.session.turnId = 'foreign-turn';
    expect((await f.capture(first.worker_handle)).action).toBe('refused');
    expect(f.route).not.toHaveBeenCalled();
    expect(worker.run).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('qualifies an Explore continuation with its original native profile even when general-purpose is unavailable', async () => {
  const f = await ownedClaudeFixture('Explore');
  worker.qualified.mockImplementation(async (cwd, profile) =>
    profile === 'Explore'
      ? {
          path: 'worker',
          claudeWorkspace: {
            version: 1,
            root: cwd!,
            workingDirectories: [cwd!],
            workingDirectorySpellings: [cwd!].slice().sort(),
            readExceptions: [],
            writeExceptions: [],
          },
        }
      : null,
  );
  try {
    const first = await f.call({ offer_id: f.job.id });
    expect(first.status).toBe('completed');
    f.session.turnId = 'explore-followup';
    const held = await f.capture(first.worker_handle);
    expect(held.action).toBe('offer');
    expect((await f.call({ offer_id: held.offer_id })).status).toBe('completed');
    expect(worker.qualified.mock.calls.every(([, profile]) => profile === 'Explore')).toBe(true);
    expect(worker.run).toHaveBeenCalledTimes(2);
  } finally {
    worker.qualified.mockImplementation(async (cwd) => ({
      path: 'worker',
      claudeWorkspace: {
        version: 1,
        root: cwd!,
        workingDirectories: [cwd!],
        workingDirectorySpellings: [cwd!].slice().sort(),
        readExceptions: [],
        writeExceptions: [],
      },
    }));
    await f.close();
  }
});

it('fences and drains a running Claude continuation before refusing duplicate activation', async () => {
  const f = await ownedClaudeFixture();
  try {
    const first = await f.call({ offer_id: f.job.id });
    f.session.turnId = 'running-turn';
    const held = await f.capture(first.worker_handle);
    let started!: () => void, drain!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const drained = new Promise<void>((resolve) => {
      drain = resolve;
    });
    worker.run.mockImplementation(async (_job, options) => {
      started();
      await new Promise<void>((resolve) =>
        options.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await drained;
      throw new Error('cancelled after drain');
    });
    const running = f.call({ offer_id: held.offer_id });
    await began;
    expect((await f.call({ offer_id: held.offer_id })).action).toBe('refused');
    let fenced = false;
    const stop = f.model.fence(f.session).then(() => {
      fenced = true;
    });
    await Promise.resolve();
    expect(fenced).toBe(false);
    drain();
    await stop;
    const result = await running;
    expect(result.status).toBe('cancelled');
    expect(result.nextStep).not.toContain('retry the original native Agent call unchanged');
    expect(
      (
        await f.conversations.lookup(first.worker_handle, {
          parentSessionId: 'root',
          root: f.repo,
          configDir: f.configDir,
        })
      )?.state,
    ).toBe('cancelled');
    expect(worker.run).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});
