import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { holdLock } from '../lib/held-lock';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// No setting turns an offer on any more; this test drives the offer path with its own saved consent.
vi.mock('./model-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./model-settings')>()),
  modelSettings: (await import('./saved-consent-test-utils')).savedModelSettings,
}));
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
function withInferenceRun<T>(
  this: ModelTransport,
  _runId: string,
  _signal: AbortSignal,
  run: (transport: ModelTransport) => Promise<T>,
) {
  return run(this);
}

const worker = vi.hoisted(() => ({
  run: vi.fn(),
  warm: vi.fn(),
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
  runModelWorker: (job: ModelJob, options: { early?: unknown }) =>
    (options.early ? worker.warm : worker.run)(job, options),
  WorkerStartUnconfirmed: class extends Error {},
  qualifiedModelWorker: worker.qualified,
}));
import { ACCEPT_PROGRESS_INTERVAL_MS, acceptProgress, registerModelTool } from './model-mcp';
import { WorkerStartUnconfirmed, type EarlyWorkerAccept } from './model-worker';
import { MODEL_RECORD_TTL_MS, ModelJobStore } from './model-job';
import type { ModelSession } from './model-handoff';
import type { ModelTransport } from './model-transport';
import offer from './fixtures/model-offer.json';
import parentPolicy from './model-parent-policy.json';
import { ModelWorkerStopped, WORKER_ENDS } from './model-worker-control';
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { MODEL_WORKER_HANDLE_PREFIX, ModelConversationStore } from './model-conversations';
import type { ModelJob } from './model-job';
import { modelConsent } from './saved-consent-test-utils';
import { workerProgressPath } from './model-worker-progress';

/** The transport's `route` as the handoff reads it: the router's answer and what the call authorized. */
function answering(route: (...args: never[]) => unknown) {
  return async (...args: never[]) => {
    const json = await route(...args);
    const fee =
      typeof json === 'object' && json !== null && 'routingFeeAtomic' in json
        ? BigInt(String(json.routingFeeAtomic))
        : 0n;
    return { json, authorizedAtomic: fee };
  };
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo: vi.fn() }));

let dir: string;
/** A Claude job is found by its own id; the tests name theirs by the turn that made it. */
async function jobOf(turn: string): Promise<ModelJob | null> {
  const folder = join(dir, 'model-jobs');
  let found: ModelJob | null = null;
  for (const name of await readdir(folder)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
    const job = JSON.parse(await readFile(join(folder, name), 'utf8')) as ModelJob;
    if (job.sessionId === 'root' && job.turnId === turn) found = job;
  }
  return found;
}
beforeEach(() => {
  vi.clearAllMocks();
  worker.warm.mockReset().mockRejectedValue(new Error('No warm process in this fixture'));
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
  [true, false].flatMap((named) =>
    (['default', 'acceptEdits', 'auto', 'dontAsk'] as const).map((mode) => ({ named, mode })),
  ),
)(
  'binds Claude $mode under a consent with named directories ($named) independently of model-supplied claims',
  async ({ named, mode }) => {
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
          subagentConsent: !named
            ? modelConsent({ routerOrigin: 'http://localhost:3939' })
            : {
                version: 2,
                instructions: 'applicable',
                reads: 'claude-home',
                recipients: ['Tenjin', 'DeepSeek', 'Exa'],
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
      claudePermissionMode: mode,
    };
    const route = vi.fn(async (body: { jobId: string }) => ({ ...offer, jobId: body.jobId }));
    const transport = {
      origin: 'http://localhost:3939',
      route: answering(route),
      withInferenceRun,
      summary: async () => ({ actualAtomic: '0' }),
    } as unknown as ModelTransport;
    const server = new McpServer({ name: 'test', version: '1' });
    const model = registerModelTool(server, {
      dataDir: dir,
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
      expect(offered.consent).toMatchObject({
        version: 2,
        repository: repo,
        repositories: [repo],
      });
      const store = new ModelJobStore(dir);
      const pending = await jobOf('turn');
      expect(pending?.decision.claudePermissionMode).toBe(mode);
      expect(JSON.stringify(route.mock.calls.map((call) => call.slice(0, 3)))).not.toContain(
        'permissionMode',
      );
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
      expect((await jobOf('next-turn'))?.state).toBe('offered');
    } finally {
      await model.shutdown();
      await client.close();
      await server.close();
    }
  },
);
async function ownedClaudeFixture(
  agentType = 'general-purpose',
  heldAgentCall = false,
  /** More fields of the held call, such as `run_in_background`. */
  heldFields: Record<string, unknown> = {},
) {
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
          reads: 'claude-home',
          recipients: ['Tenjin', 'DeepSeek', 'Exa'],
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
  const reconcile = vi.fn(async (_job: ModelJob) => {});
  const transport = {
    origin: 'http://localhost:3939',
    route: answering(route),
    requireResumeBudget,
    reconcile,
    summary,
    withInferenceRun,
  } as unknown as ModelTransport;
  const getTransport = vi.fn(async () => transport);
  // One `tenjin mcp` process: its own server, tool registration and host connection.
  const start = async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    const model = registerModelTool(server, {
      dataDir: dir,
      session: () => session,
      sessionEnded,
      transport: getTransport,
    });
    const client = new Client(
      { name: 'test', version: '1' },
      { capabilities: { elicitation: { form: {} } } },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    return { server, model, client };
  };
  const sessionEnded = vi.fn();
  let { server, model, client } = await start();
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
        ...heldFields,
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
  const activity = async (args: { offer_id: string; follow?: boolean; after?: number }) => {
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
  /**
   * A follow-up sent from a process that did not accept the worker (a resumed session):
   * the choice is not made, so it is held as an offer. In the process that accepted it,
   * the follow-up runs at once.
   */
  const heldCapture = async (handle: string, callId = 'followup-call') => {
    await restart();
    return capture(handle, callId);
  };
  const close = async () => {
    await model.shutdown();
    await client.close();
    await server.close();
  };
  /** The session resumed: the same session id, records and data folder in a new process. */
  const restart = async () => {
    await close();
    ({ server, model, client } = await start());
  };
  return {
    restart,
    repo,
    configDir,
    session,
    sessionEnded,
    model,
    store,
    conversations,
    job,
    client,
    call,
    activity,
    capture,
    heldCapture,
    close,
    route,
    requireResumeBudget,
    reconcile,
    summary,
    getTransport,
    transport,
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
    expect(await capture('repeat-call')).toEqual({ action: 'native', settled: f.job.id });
    expect(await f.store.accept(f.job.id, f.session.sessionId)).toBeNull();
    expect(f.route).not.toHaveBeenCalled();
    expect(worker.run).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('records the time before an offer when the capture answers, and the ends of the accept call', async () => {
  // Operator item of 2026-11-18: no record had the time before the offer (the held call,
  // the router's decision, the offer returned) or the tail after the worker's last answer.
  const f = await ownedClaudeFixture();
  vi.stubEnv('HOME', dir);
  f.route.mockImplementation(async (body: { jobId: string }) => ({ ...offer, jobId: body.jobId }));
  try {
    const made = await f.call({
      capture: {
        session_id: f.session.sessionId,
        tool_use_id: 'timed-call',
        tool: 'Agent',
        input: { prompt: 'Read the timed fixture.' },
      },
    });
    expect(made).toMatchObject({ action: 'offer' });
    const path = join(dir, 'model-jobs', `${made.offer_id}.diagnostics.json`);
    const before = JSON.parse(await readFile(path, 'utf8'));
    expect(before).toEqual({
      version: 1,
      offer: {
        at: expect.any(Number),
        action: 'offer',
        marks: {
          job: expect.any(Number),
          routeSent: expect.any(Number),
          routeAnswered: expect.any(Number),
          decided: expect.any(Number),
          warm: expect.any(Number),
          returned: expect.any(Number),
        },
        routeFetchMs: [],
      },
    });
    expect(await f.call({ offer_id: made.offer_id })).toMatchObject({ status: 'completed' });
    const after = JSON.parse(await readFile(path, 'utf8'));
    expect(after.offer).toEqual(before.offer);
    expect(Object.keys(after.phases)).toEqual(
      expect.arrayContaining(['handbackStored', 'answered']),
    );
    expect(after.phases.answered).toBeGreaterThanOrEqual(after.phases.handbackStored);
  } finally {
    await f.close();
  }
});

it("offers a native subagent's held call for that subagent, runs its accept, and records its failure as from a subagent", async () => {
  // Catches: a capture with no field for the subagent that made the call, so its offer
  // named no agent (and the main loop's same call could settle it), and its no-offer
  // record read as the main loop's.
  const f = await ownedClaudeFixture();
  vi.stubEnv('HOME', dir);
  f.route.mockImplementation(async (body: { jobId: string }) => ({ ...offer, jobId: body.jobId }));
  const held = (id: string) =>
    f.call({
      capture: {
        session_id: f.session.sessionId,
        tool_use_id: id,
        tool: 'Agent',
        input: { prompt: `Read the ${id} fixture.` },
        step: 'child-turn:0',
        agent: { id: 'child-1', type: 'general-purpose', parents: [], cwd: f.repo },
      },
    });
  try {
    const made = await held('child-call');
    expect(made).toMatchObject({ action: 'offer' });
    expect((await f.store.owned(made.offer_id, f.session.sessionId))?.caller).toBe('child-1');
    expect(await f.call({ offer_id: made.offer_id })).toMatchObject({ status: 'completed' });
    expect(worker.run).toHaveBeenCalledTimes(1);
    worker.qualified.mockRejectedValueOnce(new Error('unreadable settings'));
    expect(await held('failed-call')).toMatchObject({ action: 'native' });
    expect((await f.store.noOffers()).at(-1)).toMatchObject({
      code: 'capture_error',
      from: 'subagent',
    });
    // An offer the subagent did not take in time says so too.
    const late = await held('late-call');
    const expiresAt = (await f.store.owned(late.offer_id, f.session.sessionId))!.expiresAt;
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1);
    expect((await f.call({ offer_id: late.offer_id })).action).toBe('native');
    expect((await f.store.noOffers()).at(-1)).toMatchObject({
      code: 'expired',
      offerId: late.offer_id,
      from: 'subagent',
    });
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

function captureNewOffer(
  f: Awaited<ReturnType<typeof ownedClaudeFixture>>,
  id: string,
  step: string,
) {
  return f.call({
    capture: {
      session_id: f.session.sessionId,
      tool_use_id: id,
      tool: 'Agent',
      input: { prompt: 'Read the worker fixture.' },
      step,
    },
  });
}

type WarmOptions = {
  signal: AbortSignal;
  early: { accept: Promise<EarlyWorkerAccept>; onRelease: () => void };
};

it('warms one worker per offer and releases it only when an accept wins the job', async () => {
  const f = await ownedClaudeFixture();
  f.route.mockImplementation(async (body: { jobId: string }) => ({ ...offer, jobId: body.jobId }));
  let reportAccept!: (accepted: EarlyWorkerAccept) => void;
  const acceptedByWorker = new Promise<EarlyWorkerAccept>((resolve) => {
    reportAccept = resolve;
  });
  worker.warm.mockImplementation(async (_job: ModelJob, options: WarmOptions) => {
    const accepted = await options.early.accept;
    options.early.onRelease();
    reportAccept(accepted);
    return 'completed warm fixture';
  });
  try {
    const held = await captureNewOffer(f, 'warm-call', 'turn-1');
    expect(held.action).toBe('offer');
    const duplicate = await captureNewOffer(f, 'warm-call', 'turn-1');
    expect(duplicate.offer_id).toBe(held.offer_id);
    expect(worker.warm).toHaveBeenCalledOnce();
    expect(worker.run).not.toHaveBeenCalled();
    expect((await f.store.owned(held.offer_id, f.session.sessionId))?.state).toBe('offered');

    f.session.turnId = 'accepted-in-a-later-turn';
    const running = f.call({ offer_id: held.offer_id });
    expect((await acceptedByWorker).job).toMatchObject({ id: held.offer_id, state: 'running' });
    const answer = await running;
    expect(answer).toMatchObject({ status: 'completed', result: 'completed warm fixture' });
    expect(await f.call({ offer_id: held.offer_id })).toEqual(answer);
    expect(worker.run).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(['veto', 'expiry', 'parent end', 'cancel', 'mode changed', 'consent revoked'] as const)(
  'stops a still-unaccepted warm worker on %s without releasing its assignment',
  async (reason) => {
    const f = await ownedClaudeFixture();
    if (reason === 'expiry') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    f.route.mockImplementation(async (body: { jobId: string }) => ({
      ...offer,
      jobId: body.jobId,
    }));
    let onSpawn!: (options: WarmOptions) => void;
    let onStop!: () => void;
    const began = new Promise<WarmOptions>((resolve) => {
      onSpawn = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      onStop = resolve;
    });
    const assigned = vi.fn();
    worker.warm.mockImplementation(async (_job: ModelJob, options: WarmOptions) => {
      const stop = new Promise<never>((_, reject) =>
        options.signal.addEventListener(
          'abort',
          () => {
            onStop();
            reject(new Error('Warm worker stopped'));
          },
          { once: true },
        ),
      );
      onSpawn(options);
      return Promise.race([options.early.accept.then(assigned), stop]);
    });
    try {
      const held = await captureNewOffer(f, 'warm-call', 'turn-1');
      expect(held.action).toBe('offer');
      const child = await began;
      if (reason === 'veto') {
        expect(await captureNewOffer(f, 'veto-call', 'turn-2')).toEqual({
          action: 'native',
          settled: held.offer_id,
        });
      } else if (reason === 'expiry') {
        const job = (await f.store.owned(held.offer_id, f.session.sessionId))!;
        await vi.advanceTimersByTimeAsync(job.expiresAt - Date.now());
      } else if (reason === 'parent end') {
        await f.model.shutdown();
      } else if (reason === 'mode changed') {
        f.session.claudePermissionMode = 'auto';
        expect((await f.call({ offer_id: held.offer_id })).action).toBe('native');
      } else if (reason === 'consent revoked') {
        await writeFile(join(dir, 'config.json'), '{}');
        expect((await f.call({ offer_id: held.offer_id })).action).toBe('native');
      } else {
        expect(await f.call({ cancel: held.offer_id })).toEqual({ status: 'cancelled' });
      }
      await stopped;
      expect(child.signal.aborted).toBe(true);
      expect(assigned).not.toHaveBeenCalled();
      expect(worker.run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await f.close();
    }
  },
);

it.each(['startup failed', 'cleanup unconfirmed', 'already released'] as const)(
  'handles %s without replaying a released or unconfirmed warm worker',
  async (reason) => {
    const f = await ownedClaudeFixture();
    f.route.mockImplementation(async (body: { jobId: string }) => ({
      ...offer,
      jobId: body.jobId,
    }));
    worker.warm.mockImplementation(async (_job: ModelJob, options: WarmOptions) => {
      if (reason === 'cleanup unconfirmed') throw new WorkerStartUnconfirmed('Unknown descendants');
      if (reason === 'already released') {
        await options.early.accept;
        options.early.onRelease();
      }
      throw new Error('warm fixture stopped');
    });
    try {
      const held = await captureNewOffer(f, 'warm-call', 'turn-1');
      const answer = await f.call({ offer_id: held.offer_id });
      if (reason === 'startup failed') {
        expect(answer.status).toBe('completed');
        expect(worker.run).toHaveBeenCalledOnce();
      } else {
        expect(answer.status).toBe('unknown');
        expect(worker.run).not.toHaveBeenCalled();
      }
    } finally {
      await f.close();
    }
  },
);

it('advertises read-only display activity and write-capable single and batch acceptance', async () => {
  const f = await ownedClaudeFixture();
  try {
    const tools = (await f.client.listTools()).tools;
    const activity = tools.find((tool) => tool.name === 'subagent_activity');
    expect(activity?.annotations?.readOnlyHint).toBe(true);
    expect(Object.keys(activity?.inputSchema.properties ?? {}).sort()).toEqual([
      'after',
      'follow',
      'offer_id',
    ]);
    expect(activity?.inputSchema.required).toEqual(['offer_id']);
    const subagent = tools.find((tool) => tool.name === 'subagent');
    expect(subagent?.description).toContain('accept selected offers together with offer_ids');
    expect(subagent?.annotations?.readOnlyHint).toBe(false);
    // No field carries a permission, a mode or an answer to a worker: a parent's text
    // reaches a worker only as its assignment or a held follow-up.
    expect(Object.keys(subagent?.inputSchema.properties ?? {}).sort()).toEqual([
      'cancel',
      'capture',
      // The id of the session that closed, from the plugin alone: it ends that session's
      // background workers and nothing else.
      'end_session',
      'offer_id',
      'offer_ids',
      // With cancel: a label for the job's record of who ended it, fixed values.
      'reason',
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
    expect((await jobOf('first-turn'))?.state).toBe('offered');
    expect(worker.run).not.toHaveBeenCalled();
    expect(f.route).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

// Operator ruling 2026-11-17: a DeepSeek worker starts no DeepSeek worker. A worker's
// Claude Code once listed this tool from a second registration of the same server.
it('registers neither the subagent tool nor the activity read in a process started inside a model worker', async () => {
  vi.stubEnv('TENJIN_MODEL_WORKER', '1');
  const f = await ownedClaudeFixture();
  try {
    // A server with no tool at all answers the listing with an error.
    const listed = await f.client.listTools().then(
      (answer) => answer.tools.map((tool) => tool.name),
      () => [],
    );
    expect(listed).toEqual([]);
    await expect(f.call({ offer_id: f.job.id })).rejects.toThrow();
    expect((await jobOf('first-turn'))?.state).toBe('offered');
    expect(worker.run).not.toHaveBeenCalled();
    expect(worker.warm).not.toHaveBeenCalled();
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
    expect((await jobOf('first-turn'))?.state).toBe('offered');
  } finally {
    await f.close();
  }
});

// Failure caught: a parent had no way to tell a running worker anything (a stale PR head
// ran for 100k tokens). A SendMessage to its handle reaches the same job's next turn.
it('delivers a SendMessage to a running worker in order, and refuses another session, a reported worker and a handle nobody runs', async () => {
  const f = await ownedClaudeFixture();
  const heard: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let reported!: () => void;
  const afterReport = new Promise<void>((resolve) => (reported = resolve));
  worker.run.mockImplementation(async (_job, options) => {
    options.activity.running();
    started();
    await blocked;
    for (let m = await options.inbox.next(); m !== null; m = await options.inbox.next()) {
      heard.push(m);
      if (heard.length === 2) break;
    }
    // The worker reports: nothing is waiting, so the inbox closes.
    options.inbox.closeIfEmpty();
    reported();
    return 'completed fixture';
  });
  const handle = `tenjin-worker-${f.job.id}`;
  const send = (message: string, id: string) =>
    f.call({
      capture: {
        session_id: f.session.sessionId,
        tool_use_id: id,
        tool: 'SendMessage',
        input: { to: handle, message },
      },
    });
  try {
    // Nothing runs yet: no address to write to.
    expect((await send('too early', 'early')).action).toBe('refused');
    const accepted = f.call({ offer_id: f.job.id });
    await ready;
    expect(await send('the head moved to abc123', 'one')).toMatchObject({
      action: 'delivered',
      worker_handle: handle,
      message: expect.stringMatching(/^Delivered to the DeepSeek worker tenjin-worker-/),
    });
    // The other session's handle is refused, with nothing queued.
    f.session.sessionId = 'foreign';
    expect((await send('not yours', 'foreign')).action).toBe('refused');
    f.session.sessionId = 'root';
    expect((await send('then rebase', 'two')).action).toBe('delivered');
    // Held-and-offered is not the path of a running worker: no offer was made.
    expect(f.route).not.toHaveBeenCalled();
    release();
    await afterReport;
    // After the report and before the handback: not delivered, never silently dropped.
    const late = await send('too late', 'late');
    expect(late.action).toBe('refused');
    expect(late.reason).toMatch(/not delivered/);
    expect((await accepted).status).toBe('completed');
    expect(heard).toEqual(['the head moved to abc123', 'then rebase']);
    expect(worker.run).toHaveBeenCalledOnce();
  } finally {
    release();
    await f.close();
  }
});

// Failure caught: a follow-up to a finished worker took two calls (a held offer, then an
// accept). Addressed by name from the session that accepted it, it is one call, and it
// runs the accept's own checks; a resumed session keeps the held offer.
it('runs a follow-up to a finished worker in one call from the session that accepted it, and holds it where the choice is not made', async () => {
  const f = await ownedClaudeFixture();
  try {
    const first = await f.call({ offer_id: f.job.id });
    expect(first.status).toBe('completed');
    f.session.turnId = 'followup-turn';
    const sent = await f.capture(first.worker_handle);
    expect(sent).toMatchObject({
      action: 'continued',
      worker_handle: first.worker_handle,
      message: expect.stringMatching(
        /^The DeepSeek worker tenjin-worker-.* continues with your message/,
      ),
    });
    // The accept ran: a second run with the first one's history, no routing fee, and the
    // result kept for the session as a background worker's is.
    await vi.waitFor(() => expect(worker.run).toHaveBeenCalledTimes(2));
    const [execution, options] = worker.run.mock.calls[1]!;
    expect(execution).toMatchObject({
      id: f.job.id,
      task: 'Continue the same change with the current constraints.',
      decision: { requireExistingBudget: true },
    });
    expect(options.claudeSession).toMatchObject({ resume: expect.any(String) });
    expect(f.route).not.toHaveBeenCalled();
    // Wait for the background worker to end, by its stored result, not by a clock.
    await vi.waitFor(async () =>
      expect((await f.call({ offer_id: sent.offer_id })).status).toBe('completed'),
    );
    // A process that did not accept the worker (a resumed session, a reloaded plugin) has
    // no choice made: the follow-up is held as an offer and starts nothing.
    f.session.turnId = 'third-turn';
    const runs = worker.run.mock.calls.length;
    const held = await f.heldCapture(first.worker_handle);
    expect(held).toMatchObject({ action: 'offer', continuation: true });
    expect(held).not.toHaveProperty('direct');
    expect(worker.run).toHaveBeenCalledTimes(runs);
  } finally {
    await f.close();
  }
});

// Failure caught: a one-call follow-up runs with no accept call of the parent's to end, so a
// cancel by its offer id (what the agent list's stop and a parent cancel send) must end it:
// the worker's signal aborts, and it ends cancelled with nothing signed again.
it('ends a one-call follow-up when it is cancelled by its offer id', async () => {
  const f = await ownedClaudeFixture();
  try {
    const first = await f.call({ offer_id: f.job.id });
    expect(first.status).toBe('completed');
    let aborted = false;
    worker.run.mockImplementation(
      (_job, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            aborted = true;
            reject(options.signal.reason);
          });
        }),
    );
    f.session.turnId = 'followup-turn';
    const sent = await f.capture(first.worker_handle);
    expect(sent.action).toBe('continued');
    await vi.waitFor(() => expect(worker.run).toHaveBeenCalledTimes(2));
    expect(aborted).toBe(false);
    expect(await f.call({ cancel: sent.offer_id, reason: 'agent_stopped' })).toEqual({
      status: 'cancelled',
    });
    await vi.waitFor(() => expect(aborted).toBe(true));
    await vi.waitFor(async () =>
      expect((await f.call({ offer_id: sent.offer_id })).status).toBe('cancelled'),
    );
    expect(worker.run).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

// Failure caught: a message the parent was told was delivered was dropped when the job
// failed before the worker read it, and nothing said so.
it('hands back the messages a failed worker never read', async () => {
  const f = await ownedClaudeFixture();
  let fail!: () => void;
  const failing = new Promise<void>((_resolve, reject) => {
    fail = () => reject(new Error('worker error'));
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  worker.run.mockImplementation(async () => {
    started();
    await failing;
    return 'never';
  });
  try {
    const accepted = f.call({ offer_id: f.job.id });
    await ready;
    const sent = await f.call({
      capture: {
        session_id: f.session.sessionId,
        tool_use_id: 'unread',
        tool: 'SendMessage',
        input: { to: `tenjin-worker-${f.job.id}`, message: 'Use the new head.' },
      },
    });
    expect(sent.action).toBe('delivered');
    fail();
    const ended = await accepted;
    expect(ended.messagesNotRead).toMatchObject({ count: 1, messages: ['Use the new head.'] });
  } finally {
    fail();
    await f.close();
  }
});

// Failure caught (a refusal that fails closed): the owner's root was the spelling of the
// accept and was compared with the real path of the session's directory, so a symlinked
// working directory could never write to its own running worker.
it('delivers a message to a running worker from a symlinked working directory', async () => {
  const f = await ownedClaudeFixture();
  const heard: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  worker.run.mockImplementation(async (_job, options) => {
    started();
    await blocked;
    const text = await options.inbox.next();
    if (text !== null) heard.push(text);
    options.inbox.closeIfEmpty();
    return 'completed fixture';
  });
  try {
    const alias = join(dir, 'repo-alias-send');
    await symlink(f.repo, alias, 'dir');
    f.session.cwd = alias;
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
    const accepted = f.call({ offer_id: f.job.id });
    await ready;
    const sent = await f.call({
      capture: {
        session_id: f.session.sessionId,
        tool_use_id: 'alias-send',
        tool: 'SendMessage',
        input: { to: `tenjin-worker-${f.job.id}`, message: 'Through the alias.' },
      },
    });
    expect(sent.action).toBe('delivered');
    release();
    expect((await accepted).status).toBe('completed');
    expect(heard).toEqual(['Through the alias.']);
  } finally {
    release();
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
    expect((await jobOf('first-turn'))?.state).toBe('offered');
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
    // A reader that shows the run as it goes: answered at once past an older sequence,
    // with the rows that changed since, while the follow to the end still waits.
    const delta = await f.activity({ offer_id: f.job.id, follow: true, after: 0 });
    expect(delta).toMatchObject({ status: 'activity', activity: { state: 'running' } });
    expect(delta.activity.rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Read' })]),
    );
    expect(delta.activity).not.toHaveProperty('result');
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
    expect((await jobOf('first-turn'))?.state).toBe('running');
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
        // Each case: one call where this process accepted the worker (refused, nothing held,
        // when the ceiling has no room), a held offer after a resume or a reload.
        continuation: expect.stringMatching(
          /one call starts the worker again at once[\s\S]*the call is refused and nothing is held[\s\S]*After a resumed session or a reloaded plugin, Tenjin holds the follow-up as an offer/,
        ),
      });
      // The address the offer named before the accept is the one the conversation took.
      expect(first.worker_handle).toBe(`tenjin-worker-${f.job.id}`);
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
      const held = await f.heldCapture(first.worker_handle);
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
      const local = await jobOf('followup-turn');
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
    expect((await jobOf('first-turn'))?.state).toBe('offered');
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
    const local = await jobOf('first-turn');
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
      expect((await jobOf('first-turn'))?.state).toBe('running');
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
      expect((await jobOf('first-turn'))?.state).toBe(
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
    const held = await f.heldCapture(first.worker_handle);
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
    const held = await f.heldCapture(first.worker_handle);
    f.requireResumeBudget.mockRejectedValue(new Error('Original ledger missing'));
    expect((await f.call({ offer_id: held.offer_id })).action).toBe('refused');
    expect((await jobOf('ledger-turn'))?.state).toBe('offered');
    expect(worker.run).toHaveBeenCalledTimes(1);
    f.session.sessionId = 'foreign';
    f.session.turnId = 'foreign-turn';
    expect((await f.heldCapture(first.worker_handle)).action).toBe('refused');
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
    const held = await f.heldCapture(first.worker_handle);
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
    const held = await f.heldCapture(first.worker_handle);
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
    const stop = f.call({ cancel: held.offer_id }).then(() => {
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
    expect((await jobOf('first-turn'))?.state).toBe('cancelled');
  } finally {
    await f.close();
  }
});

it('answers a follow that outlasts its wait with where the worker stands, so no read is held open for the run', async () => {
  const f = await ownedClaudeFixture();
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  worker.run.mockImplementation(async () => {
    started();
    await blocked;
    return 'completed fixture';
  });
  try {
    const accepted = f.call({ offer_id: f.job.id });
    await began;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const following = f.activity({ offer_id: f.job.id, follow: true });
    // Two timers: the client's own request limit, then the follow's wait once it is reached.
    while (vi.getTimerCount() < 2) await new Promise((next) => setImmediate(next));
    vi.advanceTimersByTime(25_000);
    // Not ended: the viewer reads again, and each read stays far under the host's two minutes.
    expect(await following).toMatchObject({
      status: 'activity',
      activity: { offerId: f.job.id, state: 'starting' },
    });
    vi.useRealTimers();
    const last = f.activity({ offer_id: f.job.id, follow: true });
    release();
    expect(await last).toMatchObject({ status: 'activity', activity: { state: 'completed' } });
    expect((await accepted).status).toBe('completed');
  } finally {
    vi.useRealTimers();
    release();
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
    // The file is written after the worker starts; a loaded runner needs more than the
    // default one second, and nothing else about the test depends on that wait.
    await vi.waitFor(
      async () =>
        expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
          status: 'activity',
          activity: { offerId: f.job.id },
        }),
      { timeout: 10_000 },
    );
    release();
    expect(await accepted).toMatchObject({
      status: 'completed',
      toolUses: 1,
      tokens: 31_234,
      spend: { actualAtomic: '3000' },
    });
    await vi.waitFor(async () => expect(readFile(path, 'utf8')).rejects.toThrow(), {
      timeout: 10_000,
    });
  } finally {
    release();
    await f.close();
  }
});

it('tells the parent how many image or document blocks its worker did not see, and nothing when none', async () => {
  const f = await ownedClaudeFixture();
  worker.run.mockImplementation(async (_job, options) => {
    options.omitted.add('image:one');
    options.omitted.add('document:two');
    return 'completed fixture';
  });
  try {
    const answer = (await f.call({ offer_id: f.job.id })) as {
      omitted?: { blocks: number; note: string };
    };
    expect(answer.omitted?.blocks).toBe(2);
    expect(answer.omitted?.note).toContain('did not see 2 image or document blocks');
    expect(answer.omitted?.note).toContain('run this job natively');
  } finally {
    await f.close();
  }
  const g = await ownedClaudeFixture();
  worker.run.mockResolvedValue('completed fixture');
  try {
    expect(await g.call({ offer_id: g.job.id })).not.toHaveProperty('omitted');
  } finally {
    await g.close();
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

it('keeps the error of a worker that failed with no known cause, with secret-shaped text masked', async () => {
  const f = await ownedClaudeFixture();
  worker.run.mockRejectedValue(
    new Error('The warm Claude worker exited: GITHUB_TOKEN=ghp_' + 'a1B2'.repeat(9)),
  );
  try {
    expect(await f.call({ offer_id: f.job.id })).toMatchObject({
      status: 'unknown',
      endedBy: 'worker_error',
    });
    const record = JSON.parse(
      await readFile(join(dir, 'model-jobs', `${f.job.id}.diagnostics.json`), 'utf8'),
    );
    expect(record.failure.endedBy).toBe('worker_error');
    expect(record.failure.errors[0].message).toContain('The warm Claude worker exited');
    expect(JSON.stringify(record)).not.toContain('a1B2a1B2');
  } finally {
    await f.close();
  }
});

it('promises no free native repeat when a continuation never started', async () => {
  const f = await ownedClaudeFixture('general-purpose', true);
  try {
    const first = await f.call({ offer_id: f.job.id });
    f.session.turnId = 'followup-turn';
    const held = await f.heldCapture(first.worker_handle);
    worker.run.mockRejectedValue(
      new ModelWorkerStopped({ kind: 'not_started', reason: 'startup_timeout' }),
    );
    const stopped = await f.call({ offer_id: held.offer_id });
    expect(stopped.status).toBe('not_started');
    expect(stopped.nextStep).not.toContain('no second routing fee');
    expect(stopped.nextStep).toContain('This owned conversation is fenced');
    // The repeat it must not promise: the continuation is refused, never run again.
    expect((await f.heldCapture(first.worker_handle, 'repeat-call')).action).toBe('refused');
  } finally {
    await f.close();
  }
});

// Live case for the model call: a review worker's call failed at the router and the job
// ended `unknown`, with no cause the parent could read.
it.each([
  [{ kind: 'harness_limit', reason: 'turn_guard', turns: 3 }, 'turn_limit'],
  [{ kind: 'execution_failure', reason: 'model_call_failed', status: 502 }, 'model_call_failed'],
  [{ kind: 'execution_failure', reason: 'model_call_timeout' }, 'model_call_timeout'],
  [{ kind: 'execution_failure', reason: 'provider_failed', status: 500 }, 'provider'],
  [
    { kind: 'execution_failure', reason: 'model_call_failed', payer: 'wallet_low' },
    'model_call_failed',
  ],
] as const)(
  "hands a stopped worker's cause and counts back beside its partial work (%o)",
  async (stop, endedBy) => {
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
          content: [
            { type: 'text', text: 'I start with the required reads.' },
            { type: 'tool_use', id: 'bash-1', name: 'Bash', input: {} },
          ],
        },
      });
      throw new ModelWorkerStopped(stop);
    });
    try {
      const answer = await f.call({ offer_id: f.job.id });
      expect(answer).toMatchObject({
        status: 'stopped',
        endedBy,
        ended: WORKER_ENDS[endedBy],
        stopReason: stop,
        toolUses: 1,
        tokens: 15,
        partial: {
          lastText: 'I start with the required reads.',
          rows: expect.arrayContaining([expect.objectContaining({ name: 'Bash' })]),
        },
      });
      // The payer's code comes with Tenjin's own words for it and what the person can do.
      if ('payer' in stop)
        expect(answer.payment).toEqual({
          reason: expect.stringContaining('wallet holds less'),
          fix: expect.stringContaining('tenjin fund'),
        });
      else expect(answer).not.toHaveProperty('payment');
      // A later accept in the session reads the same end from the job's record.
      expect(await f.call({ offer_id: f.job.id })).toMatchObject({ status: 'stopped', endedBy });
    } finally {
      await f.close();
    }
  },
);

// LATER TURNS, RESTARTS AND REPEATED ACCEPTS, in the session that owns the offer.

it('accepts an offer in a later turn of its session, and answers a repeat with the stored result and no second worker', async () => {
  const f = await ownedClaudeFixture();
  try {
    f.session.turnId = 'a-later-turn';
    const first = await f.call({ offer_id: f.job.id });
    expect(first).toMatchObject({ status: 'completed', result: 'completed owned fixture' });
    f.session.turnId = 'a-still-later-turn';
    expect(await f.call({ offer_id: f.job.id })).toEqual(first);
    // After the conversation has moved on to a follow-up, the first result is still there.
    const held = await f.heldCapture(first.worker_handle);
    expect(held.action).toBe('offer');
    expect(await f.call({ offer_id: f.job.id })).toEqual(first);
    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(f.route).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it('returns a finished result after the session is resumed in a new process, and continues that worker by its handle with no routing fee', async () => {
  const f = await ownedClaudeFixture();
  try {
    const first = await f.call({ offer_id: f.job.id });
    await f.restart();
    f.session.turnId = 'after-resume';
    expect(await f.call({ offer_id: f.job.id })).toEqual(first);
    expect(worker.run).toHaveBeenCalledTimes(1);
    const held = await f.heldCapture(first.worker_handle);
    expect(held).toMatchObject({ action: 'offer', continuation: true, routingFeeAtomic: '0' });
    expect((await f.call({ offer_id: held.offer_id })).status).toBe('completed');
    expect(worker.run).toHaveBeenCalledTimes(2);
    expect(worker.run.mock.calls[1]![1].claudeSession).toMatchObject({
      resume: worker.run.mock.calls[0]![1].claudeSession.sessionId,
    });
    expect(f.route).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it.each(['stopped', 'not_started', 'cancelled'] as const)(
  'keeps a %s handback for a later accept in the same session: what the parent already received, with the spend as it now stands',
  async (status) => {
    const f = await ownedClaudeFixture('general-purpose', true);
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
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
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            { type: 'text', text: 'connecting to the staging database' },
            { type: 'tool_use', id: 'bash-1', name: 'Bash', input: {} },
          ],
        },
      });
      started();
      if (status === 'cancelled')
        await new Promise<void>((resolve) =>
          options.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      throw status === 'not_started'
        ? new ModelWorkerStopped({ kind: 'not_started', reason: 'startup_timeout' })
        : new ModelWorkerStopped({ kind: 'harness_limit', reason: 'turn_guard', turns: 3 });
    });
    try {
      const running = f.call({ offer_id: f.job.id });
      await began;
      if (status === 'cancelled')
        expect(await f.call({ cancel: f.job.id })).toEqual({ status: 'cancelled' });
      const first = await running;
      expect(first).toMatchObject({
        status,
        toolUses: 1,
        partial: { lastText: 'connecting to the staging database' },
      });
      // On disk: the handback the parent received, less its spend, in a file only the user reads.
      const path = join(dir, 'model-jobs', `${f.job.id}.json`);
      const handedBack = Object.fromEntries(
        Object.entries(first).filter(([key]) => key !== 'spend'),
      );
      expect(JSON.parse(JSON.parse(await readFile(path, 'utf8')).result)).toEqual(handedBack);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      f.summary.mockResolvedValue({ actualAtomic: '4000', reservedAtomic: '4000', uncertain: [] });
      for (const resumed of [false, true]) {
        if (resumed) await f.restart();
        f.session.turnId = `later-${resumed}`;
        const again = await f.call({ offer_id: f.job.id });
        expect(again).toEqual({
          ...handedBack,
          spend: { actualAtomic: '4000', reservedAtomic: '4000', uncertain: [] },
        });
      }
      // The run is over, so its uncertain calls were settled with the server before the report.
      expect(f.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ id: f.job.id }),
        expect.any(AbortSignal),
      );
      expect(worker.run).toHaveBeenCalledTimes(1);
      expect(f.route).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it('refuses a repeated accept while the worker runs, and starts exactly one worker for accepts that race', async () => {
  const f = await ownedClaudeFixture();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  worker.run.mockImplementation(async () => {
    await finished;
    return 'one worker';
  });
  try {
    const raced = [f.call({ offer_id: f.job.id }), f.call({ offer_id: f.job.id })];
    await vi.waitFor(() => expect(worker.run).toHaveBeenCalledTimes(1));
    f.session.turnId = 'while-it-runs';
    const repeat = await f.call({ offer_id: f.job.id });
    expect(repeat.reason).toContain('still running');
    expect((await f.store.owned(f.job.id, 'root'))?.state).toBe('running');
    // The accepting process holds the job's runner lock for as long as the worker runs, so a
    // strand probe finds a runner alive.
    const runnerLock = join(dir, 'model-jobs', `${f.job.id}.runner`);
    await expect(holdLock(runnerLock, { timeoutMs: 0 })).rejects.toMatchObject({
      name: 'LockTimeoutError',
    });
    expect(await f.store.strand(f.job.id)).toBeNull();
    finish();
    const answers = await Promise.all(raced);
    // After the job's last finish the lock is free again.
    await vi.waitFor(async () => (await holdLock(runnerLock, { timeoutMs: 0 }))());
    expect(answers.filter((answer) => answer.status === 'completed')).toHaveLength(1);
    expect(answers.filter((answer) => answer.status === undefined)).toHaveLength(1);
    expect(worker.run).toHaveBeenCalledTimes(1);
  } finally {
    finish();
    await f.close();
  }
});

it('says the job store is busy, not that the offer was taken, when its lock is held', async () => {
  const f = await ownedClaudeFixture();
  const store = await holdLock(join(dir, 'model-jobs', 'lock'));
  try {
    const answer = await f.call({ offer_id: f.job.id });
    expect(answer.reason).toContain('job store is busy');
    expect(answer.reason).toContain('Nothing was charged');
    expect(worker.run).not.toHaveBeenCalled();
  } finally {
    store();
    await f.close();
  }
}, 20_000);

it.each(['a new process', 'the same process'] as const)(
  'reports a worker its process left running as interrupted to %s, without restarting or continuing it',
  async (where) => {
    const f = await ownedClaudeFixture();
    try {
      // What a killed `tenjin mcp` leaves: the job, its conversation and its display file say running.
      const owner = { parentSessionId: 'root', root: f.repo, configDir: f.configDir };
      const accepted = (await f.store.accept(f.job.id, 'root'))!;
      const conversation = await f.conversations.create({
        job: accepted,
        parentSessionId: 'root',
        sdkSessionId: randomUUID(),
        configDir: f.configDir,
      });
      await f.conversations.accept(conversation.handle, owner, f.job.id);
      const shown = workerProgressPath(dir, 'root', f.job.id);
      await mkdir(join(shown, '..'), { recursive: true });
      await writeFile(shown, '{}');
      if (where === 'a new process') {
        const pid = spawnSync(process.execPath, ['-e', '']).pid;
        await writeFile(
          join(dir, 'model-jobs', `${f.job.id}.json`),
          JSON.stringify({ ...accepted, runner: { pid, acceptedAt: Date.now() } }),
        );
        await f.restart();
      }
      f.session.turnId = 'after-the-loss';
      const stopped = await f.call({ offer_id: f.job.id });
      expect(stopped).toMatchObject({
        status: 'unknown',
        stopReason: { kind: 'interrupted' },
        spend: { actualAtomic: '3000' },
        nextStep: expect.stringContaining('cannot be continued'),
      });
      expect((await f.store.owned(f.job.id, 'root'))?.state).toBe('unknown');
      expect((await f.conversations.lookup(conversation.handle, owner))?.state).toBe('unknown');
      await expect(stat(shown)).rejects.toThrow();
      expect((await f.heldCapture(conversation.handle)).action).toBe('refused');
      expect(await f.call({ offer_id: f.job.id })).toEqual(stopped);
      expect(worker.run).not.toHaveBeenCalled();
      expect(f.route).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);

it('gives another session nothing for an offer id: no result, no start and no cancel', async () => {
  const f = await ownedClaudeFixture();
  try {
    const first = await f.call({ offer_id: f.job.id });
    const offered = await f.store.offer({
      sessionId: 'root',
      turnId: 'second-turn',
      callId: 'second-call',
      root: f.repo,
      task: 'A second assignment.',
      native: {},
      capAtomic: '1000000',
      decision: { ...(await f.store.owned(f.job.id, 'root'))!.decision },
    });
    f.session.sessionId = 'another-session';
    f.session.turnId = 'its-turn';
    for (const id of [f.job.id, offered.id, randomUUID()]) {
      expect(await f.call({ offer_id: id })).toEqual({
        action: 'native',
        reason: 'No such offer in this session',
      });
      expect(await f.call({ cancel: id })).toEqual({ status: 'not_owned' });
    }
    expect((await f.store.owned(offered.id, 'root'))?.state).toBe('offered');
    expect(worker.run).toHaveBeenCalledTimes(1);
    // The owner still has both.
    f.session.sessionId = 'root';
    f.session.turnId = 'owner-returns';
    expect(await f.call({ offer_id: f.job.id })).toEqual(first);
    expect(await f.call({ cancel: offered.id })).toEqual({ status: 'cancelled' });
    expect((await f.store.owned(offered.id, 'root'))?.state).toBe('cancelled');
    // A cancelled offer that no accept ever reached has no worker to report.
    expect((await f.call({ offer_id: offered.id })).status).toBeUndefined();
    expect(worker.run).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it('removes model records a week after their last write when the process starts', async () => {
  const f = await ownedClaudeFixture();
  try {
    const old = join(dir, 'model-jobs', `${randomUUID()}.budget.json`);
    await writeFile(old, '{}');
    const then = new Date(Date.now() - MODEL_RECORD_TTL_MS - 60_000);
    await utimes(old, then, then);
    await f.restart();
    expect((await f.call({ offer_id: f.job.id })).status).toBe('completed');
    await expect(stat(old)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("keeps a worker's permission dialog open past the MCP SDK's 60 seconds, as a native prompt waits, and answers no once the connection is gone", async () => {
  const f = await ownedClaudeFixture();
  let asked!: () => void;
  const shown = new Promise<void>((resolve) => {
    asked = resolve;
  });
  let decide!: (decision: string) => void;
  const decided = new Promise<string>((resolve) => {
    decide = resolve;
  });
  const forms: string[] = [];
  f.client.setRequestHandler(ElicitRequestSchema, async (request) => {
    forms.push(request.params.message);
    asked();
    return { action: 'accept' as const, content: { decision: await decided } };
  });
  const answers: unknown[] = [];
  worker.run.mockImplementation(async (_job, options) => {
    const ask = () =>
      options.permission('Bash', { command: 'pnpm lint' }, new AbortController().signal, {});
    answers.push(await ask());
    await f.client.close();
    answers.push(await ask());
    return 'completed fixture';
  });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    void f.client
      .callTool({ name: 'subagent', arguments: { offer_id: f.job.id } }, undefined, {
        timeout: 3_600_000,
      })
      .catch(() => undefined);
    await shown;
    // The person takes two minutes. The dialog is still theirs to answer.
    vi.advanceTimersByTime(120_000);
    await new Promise((next) => setImmediate(next));
    expect(answers).toEqual([]);
    decide('job');
    vi.useRealTimers();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(forms).toEqual(['DeepSeek worker wants to use Bash\npnpm lint']);
    // Only the person's own choice in that dialog allows for the job; a dead connection denies.
    expect(answers).toEqual(['job', false]);
  } finally {
    vi.useRealTimers();
    decide('deny');
    await f.close().catch(() => undefined);
  }
});

// Operator ruling 2026-11-18: a background Agent call gets an offer, and its worker runs in
// the background as a native background agent does.
// The second spelling is the one Claude Code 2.1.327 handed the hook live (alpha.78): the
// job then ran in the foreground and its accept blocked for 24.6 s.
it.each([true, 'true'] as const)(
  "answers a background call's accept at once, runs its worker past the call, and keeps the result for the session (run_in_background: %j)",
  async (spelling) => {
    const f = await ownedClaudeFixture('general-purpose', true, { run_in_background: spelling });
    let finish!: (result: string) => void;
    const finished = new Promise<string>((resolve) => {
      finish = resolve;
    });
    worker.run.mockImplementation(async () => finished);
    try {
      const started = await f.call({ offer_id: f.job.id });
      expect(started).toMatchObject({
        status: 'started',
        background: true,
        offer_id: f.job.id,
        worker_handle: expect.stringMatching(/^tenjin-worker-/),
      });
      expect(started.instruction).toContain('Its result arrives by itself when it ends');
      expect(started).not.toHaveProperty('result');
      await vi.waitFor(() => expect(worker.run).toHaveBeenCalledTimes(1));
      expect((await f.store.owned(f.job.id, 'root'))?.state).toBe('running');
      // A repeat while it runs starts nothing and says where the result will come from.
      const repeat = await f.call({ offer_id: f.job.id });
      expect(repeat.reason).toContain('still running in the background');
      expect((await f.activity({ offer_id: f.job.id })).activity.state).not.toBe('completed');
      finish('background worker report');
      await vi.waitFor(async () =>
        expect((await f.store.owned(f.job.id, 'root'))?.state).toBe('completed'),
      );
      // Its handback is the one a foreground accept returns, read by the same call.
      expect(await f.call({ offer_id: f.job.id })).toMatchObject({
        status: 'completed',
        result: 'background worker report',
        worker_handle: started.worker_handle,
        spend: { actualAtomic: '3000' },
      });
      expect(worker.run).toHaveBeenCalledTimes(1);
      expect(f.route).not.toHaveBeenCalled();
      // Its follow-up is held and offered by the worker's handle, as a foreground worker's is.
      expect((await f.heldCapture(started.worker_handle)).action).toBe('offer');
    } finally {
      finish('late');
      await f.close();
    }
  },
);

it.each([
  'a cancel by its offer',
  "the session's end",
  // `/clear` ends the session and may keep this process: the plugin cancels each
  // background worker by its id, and the record says the session ended it.
  "the plugin's cancel at the session's end",
  // The plugin then tells this process that the session closed: what it did not cancel
  // by id ends too, and the session's record is dropped for the next session.
  "the plugin's word that the session closed",
] as const)(
  'ends a running background worker on %s, with that cause in its stored handback',
  async (how) => {
    const f = await ownedClaudeFixture('general-purpose', true, { run_in_background: true });
    let began!: () => void;
    const begun = new Promise<void>((resolve) => {
      began = resolve;
    });
    worker.run.mockImplementation(async (_job, options) => {
      began();
      await new Promise<void>((resolve) =>
        options.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw new Error('cancelled');
    });
    let closed = false;
    try {
      expect((await f.call({ offer_id: f.job.id })).status).toBe('started');
      await begun;
      if (how === 'a cancel by its offer') {
        f.session.turnId = 'a-later-turn';
        expect(await f.call({ cancel: f.job.id })).toEqual({ status: 'cancelled' });
        expect(await f.call({ offer_id: f.job.id })).toMatchObject({
          status: 'cancelled',
          endedBy: 'parent_cancel',
        });
        // Its record says who ended it, with no error to keep (live on alpha.80: no record).
        expect(
          JSON.parse(
            await readFile(join(dir, 'model-jobs', `${f.job.id}.diagnostics.json`), 'utf8'),
          ).failure,
        ).toEqual({ endedBy: 'parent_cancel', errors: [] });
      } else if (how === "the plugin's cancel at the session's end") {
        expect(await f.call({ cancel: f.job.id, reason: 'session_ended' })).toEqual({
          status: 'cancelled',
        });
        const ended = await f.store.owned(f.job.id, 'root');
        expect(ended?.state).toBe('cancelled');
        expect(JSON.parse(ended?.result ?? '{}')).toMatchObject({ endedBy: 'session_ended' });
      } else if (how === "the plugin's word that the session closed") {
        // Another session's id ends nothing here.
        expect(await f.call({ end_session: 'another-session' })).toEqual({ status: 'not_owned' });
        expect((await f.store.owned(f.job.id, 'root'))?.state).toBe('running');
        expect(await f.call({ end_session: 'root' })).toEqual({ status: 'ended' });
        const ended = await f.store.owned(f.job.id, 'root');
        expect(ended?.state).toBe('cancelled');
        expect(JSON.parse(ended?.result ?? '{}')).toMatchObject({ endedBy: 'session_ended' });
        expect(f.sessionEnded.mock.calls).toEqual([['root']]);
      } else {
        closed = true;
        await f.close();
        const ended = await f.store.owned(f.job.id, 'root');
        expect(ended?.state).toBe('cancelled');
        expect(JSON.parse(ended?.result ?? '{}')).toMatchObject({ endedBy: 'session_ended' });
      }
    } finally {
      if (!closed) await f.close();
    }
  },
);

it('accepts a foreground and a background offer in one batch: the background one answers started, and both workers run side by side', async () => {
  const f = await ownedClaudeFixture();
  const background = await f.store.offer({
    sessionId: 'root',
    turnId: 'first-turn',
    callId: 'background-call',
    root: f.repo,
    task: 'A background assignment.',
    native: { prompt: 'A background assignment.', run_in_background: true },
    nativeTool: 'Agent',
    capAtomic: '1000000',
    decision: { ...(await f.store.owned(f.job.id, 'root'))!.decision },
  });
  const finish = new Map<string, (result: string) => void>();
  worker.run.mockImplementation(
    (job) => new Promise<string>((resolve) => finish.set(job.id, resolve)),
  );
  try {
    const batch = f.call({ offer_ids: [f.job.id, background.id] });
    await vi.waitFor(() => expect(finish.size).toBe(2));
    // Each worker runs on its own run's channel.
    finish.get(f.job.id)!('foreground report');
    const { results } = await batch;
    expect(results[0]).toMatchObject({
      offer_id: f.job.id,
      outcome: { status: 'completed', result: 'foreground report' },
    });
    expect(results[1]).toMatchObject({
      offer_id: background.id,
      outcome: { status: 'started', background: true },
    });
    expect((await f.store.owned(background.id, 'root'))?.state).toBe('running');
    finish.get(background.id)!('background report');
    await vi.waitFor(async () =>
      expect((await f.store.owned(background.id, 'root'))?.state).toBe('completed'),
    );
    expect(await f.call({ offer_id: background.id })).toMatchObject({
      status: 'completed',
      result: 'background report',
    });
  } finally {
    for (const resolve of finish.values()) resolve('late');
    await f.close();
  }
});

it('runs two batched offers concurrently and returns separate results after cancelling one', async () => {
  const f = await ownedClaudeFixture();
  const second = await f.store.offer({
    sessionId: 'root',
    turnId: 'first-turn',
    callId: 'second-call',
    root: f.repo,
    task: 'A second assignment.',
    native: {},
    capAtomic: '1000000',
    decision: { ...(await f.store.owned(f.job.id, 'root'))!.decision },
  });
  const finish = new Map<string, (result: string) => void>();
  let bothStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bothStarted = resolve;
  });
  worker.run.mockImplementation(
    (job: ModelJob, options: { signal: AbortSignal }) =>
      new Promise<string>((resolve, reject) => {
        finish.set(job.id, resolve);
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        });
        if (finish.size === 2) bothStarted();
      }),
  );
  f.route.mockImplementation(async (body: { jobId: string }) => ({ ...offer, jobId: body.jobId }));
  try {
    expect(await f.call({ offer_ids: [f.job.id, f.job.id.toUpperCase()] })).toMatchObject({
      action: 'native',
      reason: 'Use distinct offer ids',
    });
    expect(await f.call({ offer_id: f.job.id, offer_ids: [f.job.id, second.id] })).toMatchObject({
      action: 'native',
      reason: 'Use one subagent operation',
    });
    expect(worker.run).not.toHaveBeenCalled();
    const missing = randomUUID();
    const batch = f.call({ offer_ids: [second.id, missing, f.job.id] });
    await started;
    expect(worker.run.mock.calls.map(([, options]) => options.transport)).toEqual([
      await f.getTransport(),
      await f.getTransport(),
    ]);
    // A repeated accept of a running offer starts no third worker.
    expect((await f.call({ offer_id: second.id })).reason).toContain('still running');
    expect(await f.call({ cancel: second.id })).toEqual({ status: 'cancelled' });
    expect((await f.store.owned(second.id, 'root'))?.state).toBe('cancelled');
    expect((await f.store.owned(f.job.id, 'root'))?.state).toBe('running');
    // A cancel used to close its whole turn: the next held call of the turn is still offered.
    const held = await f.call({
      capture: {
        session_id: 'root',
        tool_use_id: 'third-call',
        tool: 'Agent',
        input: { prompt: 'Read the third fixture.' },
      },
    });
    expect(held).toMatchObject({ action: 'offer', routingFeeAtomic: offer.routingFeeAtomic });
    expect(f.route).toHaveBeenCalledTimes(1);
    finish.get(f.job.id)!('result of the first');
    const done = await batch;
    expect(done).toMatchObject({
      results: [
        { offer_id: second.id, outcome: { status: 'cancelled' } },
        {
          offer_id: missing,
          outcome: { action: 'native', reason: 'No such offer in this session' },
        },
        { offer_id: f.job.id, outcome: { status: 'completed', result: 'result of the first' } },
      ],
    });
    // Each offer answers with its own stored result afterwards, and nothing ran twice.
    expect(await f.call({ offer_ids: [second.id, missing, f.job.id] })).toEqual(done);
    expect(await f.call({ offer_id: f.job.id })).toEqual(done.results[2].outcome);
    expect(worker.run).toHaveBeenCalledTimes(2);
    // Only one new job in a batch still uses the original channel.
    worker.run.mockResolvedValueOnce('remaining assignment');
    expect(await f.call({ offer_ids: [missing, held.offer_id] })).toMatchObject({
      results: [
        { offer_id: missing, outcome: { action: 'native' } },
        { offer_id: held.offer_id, outcome: { status: 'completed' } },
      ],
    });
    expect(worker.run.mock.calls[2]?.[1].transport).toBe(await f.getTransport());
  } finally {
    await f.close();
  }
});

it('records a failed capture, a held call of another session and an offer nobody took in time', async () => {
  const f = await ownedClaudeFixture();
  const held = (session: string) =>
    f.call({
      capture: {
        session_id: session,
        tool_use_id: `call-${session}`,
        tool: 'Agent',
        input: { prompt: 'Read the fixture.' },
      },
    });
  try {
    worker.qualified.mockRejectedValueOnce(new Error('unreadable settings'));
    expect(await held('root')).toMatchObject({ action: 'native' });
    expect(await held('another-session')).toMatchObject({ action: 'native' });
    vi.spyOn(Date, 'now').mockReturnValue(f.job.expiresAt + 1);
    expect((await f.call({ offer_id: f.job.id })).action).toBe('native');
    expect(worker.run).not.toHaveBeenCalled();
    expect(
      (await f.store.noOffers()).map(({ code, sessionId, offerId }) => ({
        code,
        sessionId,
        offerId,
      })),
    ).toEqual([
      { code: 'capture_error', sessionId: 'root' },
      { code: 'no_session', sessionId: 'another-session' },
      { code: 'expired', sessionId: 'root', offerId: f.job.id },
    ]);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it('records that a host with no permission prompt, or no session yet, kept a held call native', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'claude-no-offer-')));
  let session: ModelSession | undefined = {
    sessionId: 'root',
    turnId: 'turn',
    cwd: dir,
    transcript: '',
    claudePermissionMode: 'default',
  };
  const server = new McpServer({ name: 'test', version: '1' });
  const model = registerModelTool(server, {
    dataDir: dir,
    session: () => session,
    transport: async () => ({ origin: 'http://localhost:3939' }) as unknown as ModelTransport,
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const held = async () => {
    const reply = await client.callTool({
      name: 'subagent',
      arguments: {
        capture: { session_id: 'root', tool_use_id: 'call', tool: 'Task', input: { prompt: 'x' } },
      },
    });
    return JSON.parse((reply.content as Array<{ text: string }>)[0]!.text);
  };
  try {
    expect(await held()).toMatchObject({ action: 'native' });
    session = undefined;
    expect(await held()).toMatchObject({ action: 'native' });
    expect(
      (await new ModelJobStore(dir).noOffers()).map(({ code, tool }) => ({ code, tool })),
    ).toEqual([
      { code: 'host_unqualified', tool: 'Task' },
      { code: 'no_session', tool: 'Task' },
    ]);
  } finally {
    await model.shutdown();
    await client.close();
    await server.close();
  }
});

it.each([
  ['parent_cancel', 'the parent cancels it'],
  ['agent_stopped', "the person stops the worker's agent"],
  ['host_aborted', 'the host ends the accept call'],
  ['session_ended', 'the session ends'],
] as const)('records %s as what ended a job when %s', async (endedBy, _when) => {
  // A live job once read `cancelled` with nothing to say who or what had ended it.
  const f = await ownedClaudeFixture();
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  worker.run.mockImplementation(
    (_job: ModelJob, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const stopped = (cause: Error) => reject(cause);
        options.signal.addEventListener('abort', () => stopped(new Error('aborted')), {
          once: true,
        });
        started();
      }),
  );
  const host = new AbortController();
  const running = f.client
    .callTool({ name: 'subagent', arguments: { offer_id: f.job.id } }, undefined, {
      signal: host.signal,
    })
    .then(
      (reply) => JSON.parse((reply.content as Array<{ text: string }>)[0]!.text),
      () => undefined,
    );
  await began;
  if (endedBy === 'parent_cancel') await f.call({ cancel: f.job.id });
  if (endedBy === 'agent_stopped') await f.call({ cancel: f.job.id, reason: 'agent_stopped' });
  if (endedBy === 'host_aborted') host.abort();
  const closing = endedBy === 'host_aborted' || endedBy === 'session_ended';
  if (closing) await f.model.shutdown();
  const result = await running;
  // The accept call's own answer says it where one is delivered, and the record always.
  if (!closing) expect(result).toMatchObject({ endedBy });
  const record = await f.store.owned(f.job.id, 'root');
  expect(JSON.parse(record!.result!)).toMatchObject({
    endedBy,
    status: 'cancelled',
  });
  // A later read from a process with no live view of the job draws the same end.
  await f.restart();
  expect(await f.activity({ offer_id: f.job.id })).toMatchObject({
    status: 'ended',
    ended: { endedBy },
  });
  await f.close();
});

const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
afterEach(() => {
  vi.useRealTimers();
});
const extra = (meta?: { progressToken: number }) => ({
  ...(meta ? { _meta: meta } : {}),
  sendNotification: async (notification: unknown) => {
    sent.push(notification as (typeof sent)[number]);
  },
});

it('sends progress on the call token every interval while it waits, and none after it ends', async () => {
  sent.length = 0;
  vi.useFakeTimers();
  const stop = acceptProgress(extra({ progressToken: 9 }));
  // Three quiet minutes of a job that has no wall time: the host hears three times.
  await vi.advanceTimersByTimeAsync(3 * ACCEPT_PROGRESS_INTERVAL_MS);
  expect(sent.map((n) => [n.method, n.params.progressToken, n.params.progress])).toEqual([
    ['notifications/progress', 9, 60],
    ['notifications/progress', 9, 120],
    ['notifications/progress', 9, 180],
  ]);
  // Well inside the host's 1,800 s idle limit.
  expect(ACCEPT_PROGRESS_INTERVAL_MS).toBeLessThanOrEqual(120_000);
  stop();
  await vi.advanceTimersByTimeAsync(5 * ACCEPT_PROGRESS_INTERVAL_MS);
  expect(sent).toHaveLength(3);
});

it('sends nothing when the host sent no progress token, and a failed send never throws', async () => {
  sent.length = 0;
  vi.useFakeTimers();
  const none = acceptProgress(extra());
  const failing = acceptProgress({
    _meta: { progressToken: 1 },
    sendNotification: async () => {
      throw new Error('closed');
    },
  });
  await vi.advanceTimersByTimeAsync(2 * ACCEPT_PROGRESS_INTERVAL_MS);
  none();
  failing();
  expect(sent).toHaveLength(0);
});
