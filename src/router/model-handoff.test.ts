import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ getSessionInfo: vi.fn() }));
import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
vi.mock('./model-worker', () => ({ qualifiedModelWorker: vi.fn() }));
import { qualifiedModelWorker } from './model-worker';
import { makeInstructionContext } from './model-instructions';
import {
  ModelHandoff,
  modelOfferSchema,
  MODEL_BRIEF_GUIDANCE,
  type ModelSession,
} from './model-handoff';
import type { ModelTransport } from './model-transport';
import offer from './fixtures/model-offer.json';
import parentPolicy from './model-parent-policy.json';
import { nativeWorkspaceModelConsent } from './model-settings';
let dir: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function continuationFixture(multiple = false) {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-continuation-')));
  const repo = join(dir, 'repo'),
    configDir = join(dir, 'claude');
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
  await writeFile(
    join(repo, '.git/config'),
    '[remote "origin"]\nurl = git@github.com:Acme/repo.git\n',
  );
  await mkdir(configDir);
  const sibling = join(dir, 'sibling');
  await mkdir(sibling);
  const workspace = {
    version: 1 as const,
    root: repo,
    workingDirectories: multiple ? [repo, sibling] : [repo],
    workingDirectorySpellings: (multiple ? [repo, sibling] : [repo]).sort(),
    readExceptions: [],
    writeExceptions: [],
    droppedDirectories: [],
  };
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
          repositories: multiple ? [repo, sibling] : [repo],
          githubRepositories: ['Acme/repo'],
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
    decision: {
      ...offer,
      routerOrigin: 'http://localhost:3939',
      claudePermissionMode: 'default',
      claudeWorkspace: workspace,
    },
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
  vi.mocked(qualifiedModelWorker).mockResolvedValue({
    path: '/fixture/worker',
    source: 'path',
    claudeWorkspace: workspace,
  });
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
  return {
    model,
    session,
    conversation,
    owner,
    initial,
    route,
    requireResumeBudget,
    workspace,
    sibling,
  };
}

it('names one keep-native path and runs the unchanged repeat natively with no second route', async () => {
  const f = await continuationFixture();
  const transcript = join(dir, 'parent.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'user',
      sessionId: 'root',
      message: { role: 'user', content: 'Read the fixture and preserve its final line.' },
    }) + '\n',
  );
  f.route.mockImplementation(async (input: { jobId: string }) => ({
    ...offer,
    jobId: input.jobId,
  }));
  const session = { ...f.session, transcript };
  const held = {
    description: 'Read the fixture',
    prompt: 'Read the fixture.\nFINAL LINE',
    subagent_type: 'Explore',
  };
  const changed = { ...held, prompt: 'Read the whole fixture.\nFINAL LINE' };
  const first = await f.model.capture(session, 'held-call', held);
  expect(first).toMatchObject({ action: 'offer', parentPolicy });
  const instruction = 'instruction' in first ? String(first.instruction) : '';
  expect(instruction).toContain('with subagent({offer_id})');
  expect(instruction).toContain(
    'To keep it native, send the original Agent call again unchanged; that repeat costs no second routing fee.',
  );
  expect(instruction).not.toContain('tenjin-native');
  expect(f.route.mock.calls[0]?.[0]).not.toHaveProperty('expectedSpendAtomic');
  // The person typed while the parent worked, so its next calls land in a later turn.
  const later = { ...session, turnId: 'typed-turn' };
  expect(await f.model.capture(later, 'changed-call', changed)).toMatchObject({ action: 'offer' });
  expect(await f.model.capture(later, 'repeat-call', held)).toEqual({ action: 'native' });
  expect(await f.model.capture(later, 'changed-repeat', changed)).toEqual({ action: 'native' });
  expect(f.route).toHaveBeenCalledTimes(2);
  // Once per offer: the same call again is a new call, offered and routed again.
  expect(await f.model.capture(later, 'second-repeat', held)).toMatchObject({ action: 'offer' });
  expect(f.route).toHaveBeenCalledTimes(3);
  const task = await f.model.capture(
    { ...later, turnId: 'task-turn' },
    'task-call',
    { prompt: 'Read the task fixture.' },
    undefined,
    'Task',
  );
  expect('instruction' in task ? task.instruction : '').toContain(
    'send the original Task call again unchanged',
  );
});

it('keeps native tool guidance aligned with the complete Codex resubmission brief', async () => {
  const hook = await readFile(
    new URL('../../hosts/claude/tenjin/hooks/register.tsx', import.meta.url),
    'utf8',
  );
  expect(hook).toContain('\\n\\n' + MODEL_BRIEF_GUIDANCE + '`');
});

it('shows every explicit disclosure anchor and refuses a continuation whose native scope changes', async () => {
  const f = await continuationFixture(true);
  const native = { to: f.conversation.handle, message: 'Continue the same task.' };
  expect(
    await f.model.capture(f.session, 'continued', native, undefined, 'SendMessage'),
  ).toMatchObject({
    action: 'offer',
    workspace: f.workspace,
    consent: { repositories: [f.session.cwd, f.sibling], githubRepositories: ['Acme/repo'] },
  });
  vi.mocked(qualifiedModelWorker).mockResolvedValue({
    path: '/fixture/worker',
    claudeWorkspace: { ...f.workspace, workingDirectories: [f.session.cwd] },
  });
  expect(
    await f.model.capture(
      { ...f.session, turnId: 'new-turn' },
      'changed',
      native,
      undefined,
      'SendMessage',
    ),
  ).toMatchObject({
    action: 'refused',
    reason: expect.stringContaining('workspace scope changed'),
  });
  expect(f.route).not.toHaveBeenCalled();
});

it('refuses sibling disclosure revoked during qualification before routing or offering a continuation', async () => {
  const f = await continuationFixture(true);
  vi.mocked(qualifiedModelWorker).mockImplementation(async () => {
    const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    config.router.subagentConsent.repositories = [f.session.cwd];
    await writeFile(join(dir, 'config.json'), JSON.stringify(config));
    return { path: '/fixture/worker', claudeWorkspace: f.workspace };
  });
  expect(
    await f.model.capture(
      f.session,
      'continued',
      { to: f.conversation.handle, message: 'Continue' },
      undefined,
      'SendMessage',
    ),
  ).toMatchObject({ action: 'refused' });
  expect(await f.model.store.pending('root', 'later-turn')).toBeNull();
  expect(f.route).not.toHaveBeenCalled();
  expect(
    await f.model.capture({ ...f.session, turnId: 'initial-new-turn' }, 'new-worker', {
      prompt: 'Read both repositories.',
    }),
  ).toMatchObject({ action: 'native' });
  expect(f.route).not.toHaveBeenCalled();
});

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
      parentPolicy: expect.stringContaining('An unconditional live no-pay instruction'),
      instruction: expect.stringContaining('final veto'),
    });
    expect(result).toHaveProperty(
      'parentPolicy',
      expect.stringContaining('Never retry a Tenjin worker handle through native tools'),
    );
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

it.each([2, 3])('routes with consent v%i and preserves parent veto', async (version) => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'model-handoff-')));
  const repo = join(dir, 'repo');
  await mkdir(repo);
  await mkdir(join(repo, '.git'));
  await writeFile(
    join(repo, '.git/config'),
    '[remote "origin"]\nurl = git@github.com:Acme/repo.git\n',
  );
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
    disclosureRepositories: [repo],
  });
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
                githubRepositories: ['Acme/repo'],
                maxJobAtomic: '1000000',
                routerOrigin: 'http://localhost:3939',
              },
      },
    }),
  );
  const transcript = join(dir, 'owned.jsonl');
  const savedConfig = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
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
      version,
      repository: repo,
      githubRepositories: ['Acme/repo'],
      routerOrigin: 'http://localhost:3939',
      recipients: ['Tenjin', 'DeepSeek'],
    },
    instruction: expect.stringMatching(/binding instructions.*forbid disclosure/),
  });
  expect(recommendation).toHaveProperty('instruction', expect.stringContaining('final veto'));
  expect(recommendation).toHaveProperty(
    'instruction',
    expect.stringContaining('enabled DeepSeek routing'),
  );
  expect('instruction' in recommendation ? recommendation.instruction : '').not.toMatch(
    /opt[ -]?in/i,
  );
  expect(recommendation).toHaveProperty(
    'parentPolicy',
    expect.stringContaining(
      'An unconditional live no-pay instruction, including an unconditional worker paid-tool ban, vetoes the paid offer.',
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
    disclosureRepositories: [repo],
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
  // The consent statement is about the current endpoint and ceiling, not an
  // earlier configuration that happened to authorize classification.
  for (const [turnId, consentChange] of [
    ['origin-changed', { routerOrigin: 'https://other-router.example' }],
    ['cap-lowered', { maxJobAtomic: '500000' }],
  ] as const) {
    await writeFile(join(dir, 'config.json'), JSON.stringify(savedConfig));
    const guarded = { ...session, turnId };
    await model.captureCodex(guarded, `${turnId}-call`, native);
    const guardedJob = await model.store.pending('root', guarded.turnId);
    expect(guardedJob).not.toBeNull();
    route.mockImplementationOnce(async (body) => {
      await writeFile(
        join(dir, 'config.json'),
        JSON.stringify({
          ...savedConfig,
          router: {
            ...savedConfig.router,
            subagentConsent: { ...savedConfig.router.subagentConsent, ...consentChange },
          },
        }),
      );
      return { ...offer, jobId: body.jobId };
    });
    expect(await model.submitCodex(guarded, guardedJob!.id, task)).toEqual({
      action: 'native',
    });
    expect(await model.store.pending('root', guarded.turnId)).toMatchObject({ state: 'native' });
  }
  expect(route).toHaveBeenCalledTimes(4);
});

it('native-workspace routing follows later native projects and discloses only their current qualified roots', async () => {
  const f = await continuationFixture();
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: nativeWorkspaceModelConsent({ routerOrigin: 'http://localhost:3939' }),
      },
    }),
  );
  const transcript = join(dir, 'parent.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'user',
      sessionId: 'root',
      message: { role: 'user', content: 'Read the current project and report its facts.' },
    }) + '\n',
  );
  f.route.mockImplementation(async (body) => ({ ...offer, jobId: body.jobId }));
  for (const [index, root] of [f.session.cwd, f.sibling].entries()) {
    const workspace = {
      ...f.workspace,
      root,
      workingDirectories: [root],
      workingDirectorySpellings: [root],
    };
    vi.mocked(qualifiedModelWorker).mockResolvedValue({
      path: '/fixture/worker',
      claudeWorkspace: workspace,
    });
    const result = await f.model.capture(
      { ...f.session, cwd: root, turnId: `project-${index}`, transcript },
      `call-${index}`,
      { prompt: 'Read the fixture.' },
    );
    expect(result).toMatchObject({
      action: 'offer',
      started: false,
      capAtomic: '1000000',
      parentPolicy,
      consent: { version: 3, scope: 'native-workspace', repository: root, repositories: [root] },
      workspace,
    });
  }
  expect(f.route).toHaveBeenCalledTimes(2);
  const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  expect(saved.router.subagentConsent).not.toHaveProperty('repositories');
});

it('native-workspace continuation keeps its original scope and budget with a truthful current offer', async () => {
  const f = await continuationFixture(true);
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: nativeWorkspaceModelConsent({ routerOrigin: 'http://localhost:3939' }),
      },
    }),
  );
  const result = await f.model.capture(
    f.session,
    'resume-v3',
    { to: f.conversation.handle, message: 'Continue the complete assignment.\nFINAL_LINE' },
    undefined,
    'SendMessage',
  );
  expect(result).toMatchObject({
    action: 'offer',
    started: false,
    continuation: true,
    capAtomic: '900000',
    routingFeeAtomic: '0',
    consent: { version: 3, scope: 'native-workspace', repositories: [f.session.cwd, f.sibling] },
  });
  expect(f.route).not.toHaveBeenCalled();
  expect(f.requireResumeBudget).toHaveBeenCalledWith(f.initial);
});

it('consumes the server canonical offer contract without enabling an alias or provider switch', () => {
  expect(modelOfferSchema.safeParse(offer).success).toBe(true);
  expect(modelOfferSchema.safeParse({ ...offer, model: 'other-model' }).success).toBe(false);
  expect(
    modelOfferSchema.safeParse({ ...offer, endpoint: 'https://elsewhere.test/messages' }).success,
  ).toBe(false);
});

it('keeps a legacy undersized job native before purchasing model routing', async () => {
  const f = await continuationFixture();
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  config.router.subagentConsent.maxJobAtomic = '40000';
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  const transcript = join(dir, 'parent.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'user',
      sessionId: 'root',
      message: { role: 'user', content: 'Read the fixture and report its facts.' },
    }) + '\n',
  );
  expect(
    await f.model.capture({ ...f.session, turnId: 'tiny', transcript }, 'tiny-call', {
      prompt: 'Read the fixture.',
    }),
  ).toMatchObject({ action: 'native' });
  expect(f.route).not.toHaveBeenCalled();
  config.router.subagentConsent.maxJobAtomic = '1000000';
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  await f.model.capture({ ...f.session, turnId: 'control', transcript }, 'control-call', {
    prompt: 'Read the fixture.',
  });
  expect(f.route).toHaveBeenCalledTimes(1);
});
