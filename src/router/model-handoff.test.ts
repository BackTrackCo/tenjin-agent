import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo: vi.fn() }));
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
vi.mock('./model-worker', () => ({ qualifiedModelWorker: vi.fn() }));
import { qualifiedModelWorker } from './model-worker';
import { makeInstructionContext } from './model-instructions';
import { ModelHandoff, modelOfferSchema, type ModelSession } from './model-handoff';
import type { ModelTransport } from './model-transport';
import offer from './fixtures/model-offer.json';
import parentPolicy from './model-parent-policy.json';
let dir: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function continuationFixture() {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-continuation-')));
  const repo = join(dir, 'repo'),
    configDir = join(dir, 'claude');
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
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
  const route = vi.fn(),
    requireResumeBudget = vi.fn(async () => {});
  const model = new ModelHandoff({
    dataDir: dir,
    transport: {
      origin: 'http://localhost:3939',
      route,
      requireResumeBudget,
    } as unknown as ModelTransport,
  });
  const initial = await model.store.offer({
    sessionId: 'root',
    turnId: 'initial',
    callId: 'initial-call',
    root: repo,
    task: 'Original complete task',
    native: { prompt: 'Original complete task', subagent_type: 'general-purpose' },
    decision: { ...offer, routerOrigin: 'http://localhost:3939', claudePermissionMode: 'default' },
    capAtomic: '900000',
  });
  const sdkSessionId = randomUUID();
  const conversation = await model.conversations.create({
    job: initial,
    parentSessionId: 'root',
    sdkSessionId,
    configDir,
  });
  const owner = { parentSessionId: 'root', root: repo, configDir };
  await model.conversations.accept(conversation.handle, owner, initial.id);
  await model.conversations.finish(
    conversation.handle,
    owner,
    initial.id,
    'completed',
    'Original result',
  );
  vi.mocked(qualifiedModelWorker).mockResolvedValue({ path: '/fixture/worker', source: 'path' });
  vi.mocked(getSessionInfo).mockResolvedValue({ sessionId: sdkSessionId, cwd: repo } as Awaited<
    ReturnType<typeof getSessionInfo>
  >);
  const session: ModelSession = {
    sessionId: 'root',
    turnId: 'later-turn',
    cwd: repo,
    transcript: '',
    harness: 'claude',
    claudePermissionMode: 'default',
  };
  return { model, session, conversation, owner, initial, route, requireResumeBudget };
}

it('offers an across-day continuation with full parent veto, same job ceiling and no Jev fee', async () => {
  const f = await continuationFixture();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 3 * 86400000);
  try {
    const native = {
      to: f.conversation.handle,
      message: 'Continue with the exact next step.\nReturn JSON.',
    };
    const result = await f.model.capture(f.session, 'follow-up', native, undefined, 'SendMessage');
    expect(result).toMatchObject({
      action: 'offer',
      started: false,
      continuation: true,
      worker_handle: f.conversation.handle,
      routingFeeAtomic: '0',
      capAtomic: '900000',
      parentPolicy: expect.stringContaining('A live applicable no-pay instruction'),
      instruction: expect.stringContaining('final veto'),
    });
    expect('parentPolicy' in result ? result.parentPolicy : undefined).not.toContain(
      'otherwise retry the original native Agent call unchanged',
    );
    const selected = await f.model.store.pending('root', 'later-turn');
    expect(selected).toMatchObject({
      task: native.message,
      decision: {
        jobId: f.initial.decision.jobId,
        workerHandle: f.conversation.handle,
        workerConfigDir: f.owner.configDir,
      },
    });
    expect(f.requireResumeBudget).toHaveBeenCalledWith(
      expect.objectContaining({ id: f.initial.id }),
    );
    expect(f.route).not.toHaveBeenCalled();
    expect(
      await f.model.capture(f.session, 'follow-up', native, undefined, 'SendMessage'),
    ).toMatchObject({ offer_id: selected!.id });
  } finally {
    vi.restoreAllMocks();
  }
});

it('refuses owned handles for missing history, foreign parents, revocation and unavailable accounting without routing', async () => {
  const f = await continuationFixture();
  const native = { resume: f.conversation.handle, prompt: 'Continue' };
  expect(
    await f.model.capture({ ...f.session, sessionId: 'foreign' }, 'foreign', native),
  ).toMatchObject({ action: 'refused' });
  vi.mocked(getSessionInfo).mockResolvedValue(undefined);
  expect(await f.model.capture(f.session, 'missing', native)).toMatchObject({ action: 'refused' });
  vi.mocked(getSessionInfo).mockResolvedValue({
    sessionId: f.conversation.sdkSessionId,
    cwd: f.session.cwd,
  } as Awaited<ReturnType<typeof getSessionInfo>>);
  f.requireResumeBudget.mockRejectedValueOnce(new Error('missing budget'));
  expect(await f.model.capture(f.session, 'budget', native)).toMatchObject({ action: 'refused' });
  await writeFile(join(dir, 'config.json'), '{}');
  expect(await f.model.capture(f.session, 'revoked', native)).toMatchObject({ action: 'refused' });
  expect(f.route).not.toHaveBeenCalled();
  expect(await f.model.store.pending('root', 'later-turn')).toBeNull();
});

it('refuses a complete follow-up whose encoded private record would be unreadable without truncating or selecting it', async () => {
  const f = await continuationFixture();
  const result = await f.model.capture(
    f.session,
    'large',
    {
      to: f.conversation.handle,
      message: 'Keep every character: ' + '\u0000'.repeat(120_000),
    },
    undefined,
    'SendMessage',
  );
  expect(result).toMatchObject({ action: 'refused', started: false });
  expect(await f.model.store.pending('root', 'later-turn')).toBeNull();
  expect((await f.model.conversations.lookup(f.conversation.handle, f.owner))?.state).toBe('idle');
  expect(f.route).not.toHaveBeenCalled();
});

it('routes the complete resubmitted task with owned parent context once, and preserves the parent veto', async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-handoff-')));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
  const instructionFile = join(repo, 'AGENTS.md');
  await writeFile(instructionFile, 'Ask before publishing. Keep guarded Neon jobs native.');
  const instructionContext = await makeInstructionContext({
    harness: 'codex',
    root: repo,
    documents: [
      {
        path: instructionFile,
        content: 'Ask before publishing. Keep guarded Neon jobs native.',
        source: 'Codex project',
      },
    ],
    configHash: 'fixture',
    watchPaths: [instructionFile],
  });
  vi.mocked(qualifiedModelWorker).mockResolvedValue({
    path: '/fixture/worker',
    source: 'path',
    instructionContext,
  });
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
  const transcript = join(dir, 'owned.jsonl');
  await writeFile(
    transcript,
    [
      {
        type: 'session_meta',
        payload: {
          id: 'root',
          session_id: 'root',
          source: 'vscode',
          thread_source: null,
          cli_version: '0.163.0',
        },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          thread_id: 'root',
          item: {
            type: 'UserMessage',
            id: 'u1',
            content: [
              { type: 'text', text: 'Keep Neon guarded and report factual findings only.' },
            ],
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  const route = vi.fn(async (body: { jobId: string }) => ({ ...offer, jobId: body.jobId }));
  const model = new ModelHandoff({
    dataDir: dir,
    transport: { origin: 'http://localhost:3939', route } as unknown as ModelTransport,
  });
  const session: ModelSession = {
    sessionId: 'root',
    turnId: 'turn',
    cwd: repo,
    transcript,
    harness: 'codex',
    codexPolicy: { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: {} },
  };
  const native = { message: 'encrypted assignment', task_name: 'check', fork_turns: 'none' };
  const hold = await model.captureCodex(session, 'native-call', native);
  expect(hold?.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(route).not.toHaveBeenCalled();
  const pending = await model.store.pending('root', 'turn');
  const task =
    'Read the current implementation.\nPreserve literal command: pnpm check\nReturn JSON with findings and evidence.';
  const recommendation = await model.submitCodex(session, pending!.id, task);
  expect(recommendation).toMatchObject({
    action: 'offer',
    started: false,
    parentPolicy,
    consent: {
      version: 2,
      repository: repo,
      routerOrigin: 'http://localhost:3939',
      recipients: ['Tenjin', 'DeepSeek'],
    },
    instruction: expect.stringMatching(/binding instructions.*forbid disclosure/),
  });
  expect(recommendation).toHaveProperty('instruction', expect.stringContaining('final veto'));
  expect(recommendation).toHaveProperty(
    'parentPolicy',
    expect.stringContaining(
      'A live applicable no-pay instruction, including a worker paid-tool restriction, vetoes the paid offer even with saved routing opt-in.',
    ),
  );
  expect(route).toHaveBeenCalledWith(
    expect.objectContaining({
      subagentTask: task,
      parentContext: [
        { role: 'user', content: 'Keep Neon guarded and report factual findings only.' },
      ],
    }),
    undefined,
  );
  expect(await model.submitCodex(session, pending!.id, 'changed')).toMatchObject({
    action: 'native',
  });
  expect(await model.captureCodex(session, 'native-retry', native)).toBeNull();
  expect(await model.store.accept(pending!.id, 'root', 'turn')).toBeNull();
  expect(route).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(route.mock.calls[0])).not.toContain(
    'Ask before publishing. Keep guarded Neon jobs native.',
  );
  const routed = await model.store.pending('root', 'turn');
  expect(routed?.decision.instructionContext).toEqual(instructionContext);

  const changed = { ...session, turnId: 'changed-turn' };
  await model.captureCodex(changed, 'next-native-call', native);
  const next = await model.store.pending('root', 'changed-turn');
  await writeFile(instructionFile, 'A binding instruction changed after capture.');
  expect(await model.submitCodex(changed, next!.id, task)).toMatchObject({ action: 'native' });
  expect(route).toHaveBeenCalledTimes(1);

  // Revocation while the paid classifier runs cannot manufacture a current
  // consent statement or an inference offer from the earlier saved settings.
  await writeFile(instructionFile, 'Ask before publishing. Keep guarded Neon jobs native.');
  vi.mocked(qualifiedModelWorker).mockResolvedValue({
    path: '/fixture/worker',
    instructionContext: await makeInstructionContext({
      harness: 'codex',
      root: repo,
      documents: instructionContext.documents,
      configHash: 'fixture',
      watchPaths: [instructionFile],
    }),
  });
  const revoking = { ...session, turnId: 'revoking' };
  await model.captureCodex(revoking, 'revoking-call', native);
  const revokingJob = await model.store.pending('root', 'revoking');
  route.mockImplementationOnce(async (body) => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ router: { subagents: true, subagentConsent: { version: 1 } } }),
    );
    return { ...offer, jobId: body.jobId };
  });
  expect(await model.submitCodex(revoking, revokingJob!.id, task)).toEqual({ action: 'native' });
  expect(route).toHaveBeenCalledTimes(2);
  expect(
    await model.captureCodex({ ...session, turnId: 'revoked' }, 'revoked-call', native),
  ).toBeNull();
  expect(route).toHaveBeenCalledTimes(2);
});

it('consumes the server canonical offer contract without enabling an alias or provider switch', () => {
  expect(modelOfferSchema.safeParse(offer).success).toBe(true);
  expect(modelOfferSchema.safeParse({ ...offer, model: 'other-model' }).success).toBe(false);
  expect(
    modelOfferSchema.safeParse({ ...offer, endpoint: 'https://elsewhere.test/messages' }).success,
  ).toBe(false);
});
