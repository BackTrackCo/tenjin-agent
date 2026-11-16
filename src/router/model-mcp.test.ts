import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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
import { nativeWorkspaceModelConsent } from './model-settings';
import { workerProgressPath } from './model-worker-progress';

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

it.each(
  [2, 3].flatMap((version) =>
    (['default', 'acceptEdits', 'auto', 'dontAsk'] as const).map((mode) => ({ version, mode })),
  ),
)(
  'binds Claude $mode under consent v$version independently of model-supplied claims',
  async ({ version, mode }) => {
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
          subagentConsent:
            version === 3
              ? nativeWorkspaceModelConsent({ routerOrigin: 'http://localhost:3939' })
              : {
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
      expect(tool?._meta?.['anthropic/alwaysLoad']).toBe(true);
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
      const offered = JSON.parse((captured.content as Array<{ text: string }>)[0]!.text);
      expect(offered.consent).toMatchObject({ version, repository: repo, repositories: [repo] });
      if (version === 3) expect(offered.consent.scope).toBe('native-workspace');
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
      // A parent prompt (new turn) and a mode switch while the worker runs must
      // not change its mode: a changed mode used to stop the worker as `unknown`.
      session.claudePermissionMode = mode === 'auto' ? 'default' : 'auto';
      session.turnId = 'prompt-typed-while-running';
      expect(options.currentClaudePermissionMode()).toBe(mode);
      session.turnId = 'turn';
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
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).not.toContain('subagent_activity');
    expect(tools.find((tool) => tool.name === 'subagent')?._meta).toBeUndefined();
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

async function ownedClaudeFixture(agentType = 'general-purpose', heldAgentCall = false) {
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
  const getTransport = vi.fn(async () => transport);
  const server = new McpServer({ name: 'test', version: '1' });
  const model = registerModelTool(server, {
    dataDir: dir,
    harness: 'claude',
    session: () => session,
    transport: getTransport,
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
      native: {
        subagent_type: agentType,
        ...(heldAgentCall
          ? {
              prompt: 'Preserve `pnpm check` exactly.\nReturn JSON.\nFINAL LINE',
              description: 'Original description',
              model: 'sonnet',
            }
          : {}),
      },
      ...(heldAgentCall ? { nativeTool: 'Agent' as const } : {}),
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
  const activity = async (args: { offer_id: string; follow?: boolean }) => {
    const reply = await client.callTool({ name: 'subagent_activity', arguments: args });
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
    client,
    call,
    activity,
    capture,
    close,
    route,
    requireResumeBudget,
    getTransport,
  };
}

it('runs the unchanged Agent repeat of an offer natively through capture, once, with no route or worker', async () => {
  const f = await ownedClaudeFixture('Explore', true);
  const capture = (id: string) =>
    f.call({
      capture: {
        session_id: f.session.sessionId,
        tool_use_id: id,
        tool: 'Agent',
        input: f.job.native,
      },
    });
  try {
    expect(await capture('repeat-call')).toEqual({ action: 'native' });
    expect(await f.store.accept(f.job.id, f.session.sessionId, f.session.turnId)).toBeNull();
    expect(f.route).not.toHaveBeenCalled();
    expect(worker.run).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('advertises display activity as read-only without changing the original subagent wire contract', async () => {
  const f = await ownedClaudeFixture();
  try {
    const tools = (await f.client.listTools()).tools;
    const activity = tools.find((tool) => tool.name === 'subagent_activity');
    expect(activity?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(activity?.inputSchema.properties ?? {}).sort()).toEqual([
      'follow',
      'offer_id',
    ]);
    expect(activity?.inputSchema.required).toEqual(['offer_id']);
    const subagent = tools.find((tool) => tool.name === 'subagent');
    expect(subagent?.description).toBe(
      'Run or cancel a Tenjin DeepSeek subagent offer. Accept with offer_id; cancel with cancel. For a held Codex delegation, submit delegation_id and the complete plaintext task. The offer carries consent and the parent routing policy.',
    );
    expect(subagent?.annotations?.readOnlyHint).toBe(false);
    expect(Object.keys(subagent?.inputSchema.properties ?? {}).sort()).toEqual([
      'cancel',
      'capture',
      'delegation_id',
      'offer_id',
      'task',
    ]);
    expect(subagent?.inputSchema.required ?? []).toEqual([]);
  } finally {
    await f.close();
  }
});

it('keeps activity unavailable inside a model worker without claiming or starting its offer', async () => {
  const f = await ownedClaudeFixture();
  try {
    vi.stubEnv('TENJIN_MODEL_WORKER', '1');
    expect(await f.activity({ offer_id: f.job.id, follow: true })).toEqual({
      status: 'unavailable',
    });
    expect((await f.store.pending('root', 'first-turn'))?.state).toBe('offered');
    expect(worker.run).not.toHaveBeenCalled();
    expect(f.route).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('rejects an unrelated activity follow without initializing transport or mutating the job store', async () => {
  const f = await ownedClaudeFixture();
  const jobFiles = async () => {
    const path = join(dir, 'model-jobs');
    return Promise.all(
      (await readdir(path))
        .sort()
        .map(async (name) => [name, await readFile(join(path, name), 'utf8')]),
    );
  };
  try {
    const before = await jobFiles();
    expect(await f.activity({ offer_id: randomUUID(), follow: true })).toEqual({
      status: 'unavailable',
    });
    expect(f.getTransport).not.toHaveBeenCalled();
    expect(worker.run).not.toHaveBeenCalled();
    expect(worker.qualified).not.toHaveBeenCalled();
    expect(f.route).not.toHaveBeenCalled();
    expect(await jobFiles()).toEqual(before);
    expect((await f.store.pending('root', 'first-turn'))?.state).toBe('offered');
  } finally {
    await f.close();
  }
});

it('inspects only owned activity without starting work, changing selection or adding the trace to the handback', async () => {
  const f = await ownedClaudeFixture();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  worker.run.mockImplementation(async (_job, options) => {
    options.activity.running();
    options.activity.observe({
      type: 'assistant',
      uuid: 'actual-sdk-observation',
      session_id: options.claudeSession.sessionId,
      message: {
        id: 'message-1',
        content: [
          {
            type: 'tool_use',
            id: 'read-1',
            name: 'Read',
            input: { file_path: '/repo/observed.ts' },
          },
        ],
      },
    });
    started();
    await blocked;
    return 'completed fixture';
  });
  let accepted: Promise<Record<string, unknown>> | undefined;
  let following: Promise<Record<string, unknown>> | undefined;
  try {
    expect(await f.activity({ offer_id: f.job.id })).toEqual({ status: 'unavailable' });
    expect(worker.run).not.toHaveBeenCalled();
    expect((await f.store.pending('root', 'first-turn'))?.state).toBe('offered');
    following = f.activity({ offer_id: f.job.id, follow: true });
    accepted = f.call({ offer_id: f.job.id });
    await ready;
    const viewed = await f.activity({ offer_id: f.job.id });
    expect(viewed).toMatchObject({
      status: 'activity',
      activity: { state: 'running', offerId: f.job.id },
    });
    expect(viewed.activity.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Read', state: 'running' })]),
    );
    expect(JSON.stringify(viewed)).toContain('observed.ts');
    expect(JSON.stringify(viewed)).not.toContain('sdkSessionId');
    f.session.sessionId = 'foreign';
    expect(await f.activity({ offer_id: f.job.id })).toEqual({ status: 'unavailable' });
    expect(await f.activity({ offer_id: f.job.id, follow: true })).toEqual({
      status: 'unavailable',
    });
    expect((await f.call({ offer_id: f.job.id })).status).not.toBe('completed');
    f.session.sessionId = 'root';
    expect((await f.call({ offer_id: f.job.id })).status).not.toBe('completed');
    expect((await f.call({ offer_id: f.job.id, cancel: f.job.id })).reason).toBe(
      'Use one subagent operation',
    );
    expect((await f.store.pending('root', 'first-turn'))?.state).toBe('running');
    release();
    const completed = await accepted;
    expect(completed.status).toBe('completed');
    expect(JSON.stringify(completed)).not.toContain('observed.ts');
    const followed = await following;
    expect(followed).toMatchObject({
      status: 'activity',
      activity: { state: 'completed', offerId: f.job.id },
    });
    expect(followed.activity).not.toHaveProperty('rows');
    expect(followed.activity).not.toHaveProperty('droppedRows');
    expect(JSON.stringify(followed)).not.toContain('observed.ts');
    expect(await f.activity({ offer_id: f.job.id })).toMatchObject({
      status: 'activity',
      activity: {
        state: 'completed',
        spend: { actualAtomic: '3000', reservedAtomic: '3000', uncertain: [] },
      },
    });
    expect(worker.run).toHaveBeenCalledOnce();
    expect(f.route).not.toHaveBeenCalled();
  } finally {
    f.session.sessionId = 'root';
    release();
    await accepted?.catch(() => undefined);
    await following?.catch(() => undefined);
    await f.close();
  }
});

it('inspects the owned activation when the parent workspace and Claude config use symlink spellings', async () => {
  const f = await ownedClaudeFixture();
  try {
    const repoAlias = join(dir, 'repo-alias');
    const configAlias = join(dir, 'config-alias');
    await symlink(f.repo, repoAlias, 'dir');
    await symlink(f.configDir, configAlias, 'dir');
    f.session.cwd = repoAlias;
    vi.stubEnv('CLAUDE_CONFIG_DIR', configAlias);
    worker.qualified.mockImplementation(async () => ({
      path: 'worker',
      claudeWorkspace: {
        version: 1,
        root: f.repo,
        workingDirectories: [f.repo],
        workingDirectorySpellings: [f.repo],
        readExceptions: [],
        writeExceptions: [],
      },
    }));
    expect((await f.call({ offer_id: f.job.id })).status).toBe('completed');
    expect(await f.activity({ offer_id: f.job.id })).toMatchObject({
      status: 'activity',
      activity: { state: 'completed', offerId: f.job.id },
    });
    expect(worker.run).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it.each(['general-purpose', 'Explore'] as const)(
  'continues a Claude %s session through SendMessage with the original profile, ledger and exact completed replay',
  async (nativeProfile) => {
    const f = await ownedClaudeFixture(nativeProfile);
    try {
      const first = await f.call({ offer_id: f.job.id });
      expect(first).toMatchObject({
        status: 'completed',
        worker_handle: expect.stringMatching(/^tenjin-worker-/),
        continuation: expect.stringContaining('SendMessage'),
      });
      const [initialExecution, initialOptions] = worker.run.mock.calls[0]!;
      expect(initialExecution.native).toMatchObject({ subagent_type: nativeProfile });
      for (const follow of [false, true])
        expect(await f.activity({ offer_id: f.job.id, follow })).toMatchObject({
          status: 'activity',
          activity: { nativeProfile, state: 'completed', workerHandle: first.worker_handle },
        });
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
        native: { subagent_type: nativeProfile },
        decision: { jobId: f.job.id, requireExistingBudget: true, claudePermissionMode: 'auto' },
      });
      for (const follow of [false, true])
        expect(await f.activity({ offer_id: held.offer_id, follow })).toMatchObject({
          status: 'activity',
          activity: { nativeProfile, state: 'completed', workerHandle: first.worker_handle },
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
  },
);

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

it('cancels a running Claude worker by its offer after a later parent prompt changed the turn', async () => {
  const f = await ownedClaudeFixture();
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
  try {
    const running = f.call({ offer_id: f.job.id });
    await began;
    f.session.turnId = 'later-turn';
    expect(await f.call({ cancel: randomUUID() })).toEqual({ status: 'not_owned' });
    expect(await f.call({ cancel: f.job.id })).toEqual({ status: 'cancelled' });
    expect((await running).status).toBe('cancelled');
    expect((await f.store.pending('root', 'first-turn'))?.state).toBe('cancelled');
  } finally {
    await f.close();
  }
});

it('reports native tool-use and token counts and keeps the live file only while the worker runs', async () => {
  const f = await ownedClaudeFixture();
  const path = workerProgressPath(dir, 'root', f.job.id);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  worker.run.mockImplementation(async (_job, options) => {
    options.activity.running();
    options.activity.observe({
      type: 'assistant',
      uuid: 'turn-one',
      session_id: options.claudeSession.sessionId,
      message: {
        id: 'message-1',
        usage: { input_tokens: 1200, cache_read_input_tokens: 30_000, output_tokens: 34 },
        content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: {} }],
      },
    });
    started();
    await blocked;
    return 'completed fixture';
  });
  try {
    const accepted = f.call({ offer_id: f.job.id });
    await ready;
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        status: 'activity',
        activity: { offerId: f.job.id },
      }),
    );
    release();
    expect(await accepted).toMatchObject({
      status: 'completed',
      toolUses: 1,
      tokens: 31_234,
      spend: { actualAtomic: '3000' },
    });
    await vi.waitFor(async () => expect(readFile(path, 'utf8')).rejects.toThrow());
  } finally {
    release();
    await f.close();
  }
});

it('hands back a worker that never started as not started, with the free native repeat next', async () => {
  const f = await ownedClaudeFixture('general-purpose', true);
  worker.run.mockRejectedValue(
    new ModelWorkerStopped({ kind: 'not_started', reason: 'startup_timeout' }),
  );
  try {
    expect(await f.call({ offer_id: f.job.id })).toMatchObject({
      status: 'not_started',
      stopReason: { kind: 'not_started', reason: 'startup_timeout' },
      nextStep:
        'No worker started: Claude Code did not start within its start-up window. Keep it native: send the original Agent call again unchanged; that repeat costs no second routing fee.',
    });
  } finally {
    await f.close();
  }
});

it("hands a stopped worker's counts back beside its partial work", async () => {
  const f = await ownedClaudeFixture();
  worker.run.mockImplementation(async (_job, options) => {
    options.activity.running();
    options.activity.observe({
      type: 'assistant',
      uuid: 'turn-one',
      session_id: options.claudeSession.sessionId,
      message: {
        id: 'message-1',
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: {} }],
      },
    });
    throw new ModelWorkerStopped({ kind: 'harness_limit', reason: 'turn_guard', turns: 3 });
  });
  try {
    expect(await f.call({ offer_id: f.job.id })).toMatchObject({
      status: 'unknown',
      toolUses: 1,
      tokens: 15,
      partial: { rows: [expect.objectContaining({ name: 'Bash' })] },
    });
  } finally {
    await f.close();
  }
});
