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
  fitAdmission,
  ModelHandoff,
  modelOfferSchema,
  MODEL_BRIEF_GUIDANCE,
  type ModelCaller,
  type ModelSession,
} from './model-handoff';
import { MODEL_ROUTE_BODY_BYTES, MODEL_ROUTE_ENVELOPE_BYTES } from './model-limits';
import type { ModelTransport } from './model-transport';
import offer from './fixtures/model-offer.json';
import parentPolicy from './model-parent-policy.json';
import { modelConsent } from './model-settings';
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
          reads: 'claude-home',
          recipients: ['Tenjin', 'DeepSeek', 'Exa'],
          repositories: multiple ? [repo, sibling] : [repo],
          githubRepositories: ['Acme/repo'],
          maxJobAtomic: '1000000',
          routerOrigin: 'http://localhost:3939',
        },
      },
    }),
  );
  const route = vi.fn(),
    requireResumeBudget = vi.fn(async () => {}),
    reconcile = vi.fn(async () => {});
  const model = new ModelHandoff({
    dataDir: dir,
    transport: {
      origin: 'http://localhost:3939',
      route,
      requireResumeBudget,
      reconcile,
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
    reconcile,
    workspace,
    sibling,
  };
}

// Operator ruling 2026-11-18: a background Agent call gets an offer. It was kept native as
// `input_filter:run_in_background`, so no loop worker and no background call could be routed.
it('offers a background Agent call, says its worker runs in the background, and keeps its unchanged repeat native', async () => {
  const f = await continuationFixture();
  const transcript = join(dir, 'parent.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'user',
      sessionId: 'root',
      message: { role: 'user', content: 'Read the fixture in the background.' },
    }) + '\n',
  );
  f.route.mockImplementation(async (input: { jobId: string }) => ({
    ...offer,
    jobId: input.jobId,
  }));
  const session = { ...f.session, transcript };
  const held = { description: 'Read the fixture', prompt: 'Read the fixture.' };
  const background = { ...held, run_in_background: true };
  const made = await f.model.capture(session, 'background-call', background);
  expect(made).toMatchObject({ action: 'offer', background: true });
  expect('instruction' in made ? made.instruction : '').toContain(
    'its worker does: the accept call returns at once',
  );
  const id = 'offer_id' in made ? String(made.offer_id) : '';
  expect((await f.model.store.owned(id, 'root'))?.native).toMatchObject({
    run_in_background: true,
  });
  // Live on alpha.78 (Claude Code 2.1.327): the host handed the field over as the STRING
  // "true", the offer said nothing of the background and its accept ran in the foreground.
  const spelled = await f.model.capture(session, 'string-call', {
    ...held,
    prompt: 'Read the other fixture.',
    run_in_background: 'true',
  });
  expect(spelled).toMatchObject({ action: 'offer', background: true });
  expect('instruction' in spelled ? spelled.instruction : '').toContain(
    'its worker does: the accept call returns at once',
  );
  // "false" is a foreground call, and a value nobody understands keeps the call native.
  const off = await f.model.capture(session, 'false-call', {
    ...held,
    prompt: 'Read a third fixture.',
    run_in_background: 'false',
  });
  expect(off).toMatchObject({ action: 'offer' });
  expect(off).not.toHaveProperty('background');
  expect(
    await f.model.capture(session, 'odd-call', { ...held, run_in_background: 'later' }),
  ).toMatchObject({ action: 'native' });
  expect((await f.model.store.noOffers()).at(-1)).toMatchObject({
    code: 'input_filter',
    detail: 'run_in_background',
  });
  // A foreground call's offer says nothing of the background.
  const plain = await f.model.capture(session, 'foreground-call', held);
  expect(plain).not.toHaveProperty('background');
  expect('instruction' in plain ? plain.instruction : '').not.toContain('background');
  // The veto is the same call again: it settles the background offer alone and runs natively.
  expect(await f.model.capture({ ...session, turnId: 'next-turn' }, 'repeat', background)).toEqual({
    action: 'native',
    settled: id,
  });
  expect(f.route).toHaveBeenCalledTimes(4);
});

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
  expect(instruction).toContain('subagent({offer_ids: [id1, id2, ...]})');
  expect(instruction).toContain(
    'To keep it native, send the original Agent call again unchanged; that repeat costs no second routing fee.',
  );
  // Either choice is one call and no narration: a parent once explained each veto in prose.
  expect(instruction).toContain('as one call with no comment on the choice');
  expect(instruction).not.toContain('tenjin-native');
  // Review of 2120958a: in Claude Code the hook's refusal line says the call was held and
  // has not run, so the instruction does not say it a third time.
  expect(instruction).not.toContain('No assignment has been sent');
  expect(f.route.mock.calls[0]?.[0]).not.toHaveProperty('expectedSpendAtomic');
  // A second, different call of the same turn is judged by itself and gets its own offer,
  // while the first is still open: a native parent's calls all run.
  const second = await f.model.capture(session, 'changed-call', changed);
  expect(second).toMatchObject({ action: 'offer' });
  const ids = [first, second].map((made) => ('offer_id' in made ? String(made.offer_id) : ''));
  expect(new Set(ids).size).toBe(2);
  // Each repeat names the one offer it settled, and that offer alone ends.
  const later = { ...session, turnId: 'typed-turn' };
  expect(await f.model.capture(later, 'repeat-call', held)).toEqual({
    action: 'native',
    settled: ids[0],
  });
  expect((await f.model.store.owned(ids[1]!, 'root'))?.state).toBe('offered');
  expect(await f.model.capture(later, 'changed-repeat', changed)).toEqual({
    action: 'native',
    settled: ids[1],
  });
  expect((await f.model.store.noOffers()).at(-1)).toMatchObject({
    code: 'kept_native',
    offerId: ids[1],
  });
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

it('names a withheld native directory in the offer beside its keep-native path and cap', async () => {
  const f = await continuationFixture();
  const transcript = join(dir, 'parent.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'user',
      sessionId: 'root',
      message: { role: 'user', content: 'Read the fixture.' },
    }) + '\n',
  );
  f.route.mockImplementation(async (input: { jobId: string }) => ({
    ...offer,
    jobId: input.jobId,
  }));
  vi.mocked(qualifiedModelWorker).mockResolvedValue({
    path: '/fixture/worker',
    source: 'path',
    claudeWorkspace: { ...f.workspace, droppedDirectories: [f.sibling] },
  });
  const held = { description: 'Read the fixture', prompt: 'Read the fixture.' };
  // The parent tells the person what the worker lacks, can keep it native for free,
  // and the plugin's offer row draws the cap.
  expect(await f.model.capture({ ...f.session, transcript }, 'held-call', held)).toMatchObject({
    action: 'offer',
    capAtomic: expect.stringMatching(/^[1-9][0-9]*$/),
    workspaceNote: expect.stringContaining(f.sibling),
    instruction: expect.stringContaining(
      'To keep it native, send the original Agent call again unchanged',
    ),
  });
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

it('keeps the assignment and transcript local when consent is revoked during the last job read', async () => {
  const f = await continuationFixture();
  const transcript = join(dir, 'fresh.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'user',
      sessionId: f.session.sessionId,
      message: { role: 'user', content: 'Read the synthetic workspace fixture.' },
    }),
  );
  const owned = f.model.store.owned.bind(f.model.store);
  vi.spyOn(f.model.store, 'owned').mockImplementation(async (id, owner) => {
    const pending = await owned(id, owner);
    if (pending?.state === 'routing')
      await writeFile(join(dir, 'config.json'), JSON.stringify({ router: { subagents: false } }));
    return pending;
  });
  expect(
    await f.model.capture({ ...f.session, transcript }, 'revoke-before-send', {
      prompt: 'Check the fixture and report what you find.',
    }),
  ).toMatchObject({ action: 'native' });
  expect(f.route).not.toHaveBeenCalled();
});

it('holds an across-day continuation to run or cancel, with nothing to judge, the same job ceiling and no routing fee', async () => {
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
      parentPolicy: expect.stringContaining('It carries no permission'),
      // The two calls the parent may make, as the tool spells them.
      instruction: expect.stringMatching(
        /subagent\(\{offer_id\}\).*subagent\(\{cancel: offer_id\}\)/,
      ),
    });
    expect(result).toHaveProperty(
      'parentPolicy',
      expect.stringContaining('Never retry a Tenjin worker handle through native tools'),
    );
    // A native SendMessage resumes its subagent with no confirmation: the parent is
    // asked to judge nothing, in the instruction or the policy.
    const said =
      'instruction' in result && 'parentPolicy' in result
        ? result.instruction + ' ' + result.parentPolicy
        : '';
    expect(said).not.toMatch(/veto|Assess|recommendation/i);
    // The text still goes to another model: what binds an assignment binds a follow-up,
    // so a plan or a restricted disclosure cannot reach DeepSeek through a worker
    // that was accepted for something else.
    expect(result).toHaveProperty(
      'parentPolicy',
      expect.stringMatching(
        /restricts this worker's model, privacy, disclosure or paid inference still binds/,
      ),
    );
    expect(result).toHaveProperty(
      'parentPolicy',
      expect.stringContaining('plan authoring and substantive plan review stay native'),
    );
    expect(result).toHaveProperty('instruction', expect.stringContaining('binding restrictions'));
    expect(said).toContain('no routing fee');
    const selected = await f.model.store.owned(
      'offer_id' in result ? String(result.offer_id) : '',
      'root',
    );
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
    // What the earlier run left uncertain is settled with the server before the budget counts.
    expect(f.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ id: f.initial.id }),
      expect.any(AbortSignal),
    );
    expect(f.reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      f.requireResumeBudget.mock.invocationCallOrder[0]!,
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

it.each([
  ['names the repository', true],
  ['names no directory', false],
] as const)('routes with a consent that %s and preserves parent veto', async (_what, named) => {
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
        subagentConsent: !named
          ? modelConsent({ routerOrigin: 'http://localhost:3939' })
          : {
              version: 2,
              instructions: 'applicable',
              reads: 'claude-home',
              recipients: ['Tenjin', 'DeepSeek', 'Exa'],
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
      version: 2,
      repository: repo,
      githubRepositories: ['Acme/repo'],
      routerOrigin: 'http://localhost:3939',
      recipients: ['Tenjin', 'DeepSeek', 'Exa'],
    },
    instruction: expect.stringMatching(/Exa\..*binding instructions.*forbid disclosure/),
  });
  expect(recommendation).toHaveProperty('instruction', expect.stringContaining('final veto'));
  // Codex has no refusal line above the offer, so its instruction still says it.
  expect(recommendation).toHaveProperty(
    'instruction',
    expect.stringContaining('No assignment has been sent to a worker.'),
  );
  expect(recommendation).toHaveProperty(
    'instruction',
    expect.stringContaining('turned DeepSeek subagents on'),
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
    expect.any(Function),
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
  for (const [turnId, consentChange, limits, code] of [
    ['origin-changed', { routerOrigin: 'https://other-router.example' }, {}, 'no_consent'],
    // A ceiling the person named meanwhile, under the cap the call was held at. Its record
    // read `scope_not_covered`, which names no cap (review of b7974566).
    ['cap-lowered', { maxJobAtomic: '500000' }, {}, 'job_cap_lowered'],
    // The cap is the per-call limit, so a limit lowered during routing lowers it too.
    ['limit-lowered', {}, { maxAutoSpend: '500000' }, 'job_cap_lowered'],
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
          ...limits,
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
    expect((await model.store.noOffers()).at(-1)).toMatchObject({ code });
  }
  expect(route).toHaveBeenCalledTimes(5);
});

it('native-workspace routing follows later native projects and discloses only their current qualified roots', async () => {
  const f = await continuationFixture();
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({
      router: {
        subagents: true,
        subagentConsent: modelConsent({ routerOrigin: 'http://localhost:3939' }),
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
      consent: { version: 2, repository: root, repositories: [root] },
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
        subagentConsent: modelConsent({ routerOrigin: 'http://localhost:3939' }),
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
    consent: { version: 2, repositories: [f.session.cwd, f.sibling] },
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
  // The result size a router honours is kept with the job; an offer with none, or with a
  // value that is no size, is still an offer.
  expect(modelOfferSchema.parse({ ...offer, maxResultBytes: 4_000_000 }).maxResultBytes).toBe(
    4_000_000,
  );
  expect(modelOfferSchema.parse(offer)).not.toHaveProperty('maxResultBytes');
  expect(modelOfferSchema.parse({ ...offer, maxResultBytes: '4MB' }).maxResultBytes).toBe(
    undefined,
  );
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
  expect((await f.model.store.noOffers()).at(-1)).toMatchObject({ code: 'job_cap_too_low' });
  config.router.subagentConsent.maxJobAtomic = '1000000';
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  await f.model.capture({ ...f.session, turnId: 'control', transcript }, 'control-call', {
    prompt: 'Read the fixture.',
  });
  expect(f.route).toHaveBeenCalledTimes(1);
});

// The offer's cap, which the row draws as `cap $X`, was the consent's own amount, $1 from
// install, whatever the person's per-call limit said.
it.each([
  ['500000', '500000'],
  // The consent names a $1 ceiling: a higher limit does not lift it.
  ['3000000', '1000000'],
  // Under what one model call and its routing fee need: no offer, and nothing is routed.
  ['50000', null],
] as const)('offers a job at the per-call limit %s with the cap %s', async (maxAutoSpend, cap) => {
  const f = await routedFixture();
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  await writeFile(join(dir, 'config.json'), JSON.stringify({ ...config, maxAutoSpend }));
  const answer = await f.model.capture(f.session, 'limited-call', { prompt: 'Read the fixture.' });
  if (cap !== null) {
    expect(answer).toMatchObject({ action: 'offer', capAtomic: cap });
    return;
  }
  expect(answer).toMatchObject({ action: 'native' });
  expect(f.route).not.toHaveBeenCalled();
  expect((await f.model.store.noOffers()).at(-1)).toMatchObject({ code: 'job_cap_too_low' });
});

async function routedFixture() {
  const f = await continuationFixture();
  const transcript = join(dir, 'parent.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'user',
      sessionId: 'root',
      message: { role: 'user', content: 'Read the fixture and report its facts.' },
    }) + '\n',
  );
  f.route.mockImplementation(async (input: { jobId: string }) => ({
    ...offer,
    jobId: input.jobId,
  }));
  return { ...f, session: { ...f.session, transcript } };
}

it('offers a call made while another job of the session runs, in a turn no prompt started', async () => {
  const f = await routedFixture();
  const first = await f.model.capture(f.session, 'first-call', { prompt: 'Read A.' });
  const running = 'offer_id' in first ? String(first.offer_id) : '';
  expect((await f.model.store.accept(running, 'root'))?.state).toBe('running');
  // A task notification woke the parent: no prompt was typed, so the turn id is the same.
  const next = await f.model.capture(f.session, 'woken-call', { prompt: 'Read B.' });
  expect(next).toMatchObject({ action: 'offer', routingFeeAtomic: offer.routingFeeAtomic });
  expect('offer_id' in next ? next.offer_id : running).not.toBe(running);
  // The running job is untouched by the new offer.
  expect((await f.model.store.owned(running, 'root'))?.state).toBe('running');
  expect(f.route).toHaveBeenCalledTimes(2);
});

it('offers two identical calls of one model response each, and settles one of them a repeat', async () => {
  const f = await routedFixture();
  const same = { description: 'Twin', prompt: 'Read the same fixture.' };
  const capture = (call: string, step: string) =>
    f.model.capture(f.session, call, same, undefined, 'Agent', step);
  const made = [await capture('twin-a', 'turn:3'), await capture('twin-b', 'turn:3')];
  expect(made).toMatchObject([{ action: 'offer' }, { action: 'offer' }]);
  const ids = made.map((one) => ('offer_id' in one ? String(one.offer_id) : ''));
  expect(new Set(ids).size).toBe(2);
  // One fee an offer, and none for a repeat: the next response keeps the first native.
  expect(f.route).toHaveBeenCalledTimes(2);
  expect(await capture('repeat-a', 'turn:4')).toEqual({ action: 'native', settled: ids[0] });
  // The other offer is still open, is accepted by its own id, and starts one worker.
  expect((await f.model.store.accept(ids[1]!, 'root'))?.id).toBe(ids[1]);
  expect(await f.model.store.accept(ids[1]!, 'root')).toBeNull();
  expect(await f.model.store.accept(ids[0]!, 'root')).toBeNull();
  expect(f.route).toHaveBeenCalledTimes(2);
});

/** A native subagent as the mod sends it: listed, in the session's folder, under the main loop. */
const child = (agentId: string, more: Partial<ModelCaller> = {}): ModelCaller => ({
  agentId,
  agentType: 'general-purpose',
  parents: [],
  cwd: join(dir, 'repo'),
  ...more,
});

/** A native subagent's own transcript, where Claude Code keeps it beside the session's. */
async function subagentTranscript(agentId: string, task: string, reply: string) {
  const folder = join(dir, 'root', 'subagents');
  await mkdir(folder, { recursive: true });
  const row = (type: 'user' | 'assistant', text: string) =>
    JSON.stringify({
      type,
      sessionId: 'root',
      isSidechain: true,
      agentId,
      message: { role: type, content: text },
    });
  await writeFile(
    join(folder, `agent-${agentId}.jsonl`),
    `${row('user', task)}\n${row('assistant', reply)}\n`,
  );
}

const offerId = (made: object) => ('offer_id' in made ? String(made.offer_id) : '');
const routedContext = (route: ReturnType<typeof vi.fn>, call: number) =>
  (route.mock.calls[call]![0] as { parentContext: { content: string }[] }).parentContext.map(
    (message) => message.content,
  );

it("offers a native subagent's call to that subagent, judged with its own conversation after the session's", async () => {
  // Catches: every subagent call kept native as `input_filter:agentId`, and a subagent's
  // assignment judged by the parent's latest message alone, not by its own task.
  const f = await routedFixture();
  vi.stubEnv('HOME', dir);
  await subagentTranscript('child-1', 'CHILD TASK: audit the parser.', 'CHILD REPLY: reading it.');
  const made = await f.model.capture(
    f.session,
    'child-call',
    { description: 'Parser', prompt: 'Read the parser fixture.' },
    undefined,
    'Agent',
    'child-turn:0',
    child('child-1'),
  );
  expect(made).toMatchObject({ action: 'offer', parentPolicy });
  const id = offerId(made);
  expect((await f.model.store.owned(id, 'root'))?.caller).toBe('child-1');
  const context = routedContext(f.route, 0);
  expect(context).toContain('CHILD TASK: audit the parser.');
  expect(context.at(-1)).toBe('CHILD REPLY: reading it.');
  expect(await f.model.store.noOffers()).toEqual([]);
  // The subagent accepts it by its id in the session, as the main loop does.
  expect((await f.model.store.accept(id, 'root'))?.state).toBe('running');
});

it("keeps a subagent's offer native only by that subagent's repeat, never by another loop's same call", async () => {
  // Catches: a repeat matched by content alone, so the main loop's or another subagent's
  // identical call settled a subagent's offer, and that subagent's repeat bought a second fee.
  const f = await routedFixture();
  vi.stubEnv('HOME', dir);
  const same = { description: 'Twin', prompt: 'Read the same fixture.' };
  const call = (id: string, step: string, caller?: ModelCaller) =>
    f.model.capture(f.session, id, same, undefined, 'Agent', step, caller);
  const fromChild = await call('child-call', 'child-turn:0', child('child-1'));
  const fromMain = await call('main-call', 'main-turn:0');
  const fromOther = await call('other-call', 'other-turn:0', child('child-2'));
  expect([fromChild, fromMain, fromOther]).toMatchObject([
    { action: 'offer' },
    { action: 'offer' },
    { action: 'offer' },
  ]);
  expect(await call('child-repeat', 'child-turn:1', child('child-1'))).toEqual({
    action: 'native',
    settled: offerId(fromChild),
  });
  expect((await f.model.store.noOffers()).at(-1)).toMatchObject({
    code: 'kept_native',
    offerId: offerId(fromChild),
    from: 'subagent',
  });
  expect((await f.model.store.owned(offerId(fromMain), 'root'))?.state).toBe('offered');
  expect((await f.model.store.owned(offerId(fromOther), 'root'))?.state).toBe('offered');
  expect(f.route).toHaveBeenCalledTimes(3);
});

it("offers a call two native agents deep to the agent that made it, and gives a worker's own calls none", async () => {
  // Catches: a nested agent's call kept native, judged with another loop's conversation or
  // kept native by its parent subagent's same call; and a worker's own call offered.
  const f = await routedFixture();
  vi.stubEnv('HOME', dir);
  await subagentTranscript('grandchild', 'NESTED TASK: list the exports.', 'NESTED REPLY: on it.');
  const same = { prompt: 'Read the nested fixture.' };
  const nested = child('grandchild', { parents: ['general-purpose'] });
  const call = (id: string, step: string, caller: ModelCaller, native = same) =>
    f.model.capture(f.session, id, native, undefined, 'Agent', step, caller);
  const made = await call('nested', 'g:0', nested);
  expect(made).toMatchObject({ action: 'offer' });
  expect((await f.model.store.owned(offerId(made), 'root'))?.caller).toBe('grandchild');
  expect(routedContext(f.route, 0).at(-1)).toBe('NESTED REPLY: on it.');
  // Its parent subagent's same call is that subagent's own, offered by itself.
  expect(await call('parent', 'c:0', child('child-1'))).toMatchObject({ action: 'offer' });
  expect(await call('nested-repeat', 'g:1', nested)).toEqual({
    action: 'native',
    settled: offerId(made),
  });
  expect(f.route).toHaveBeenCalledTimes(2);
  // A DeepSeek worker's own calls, its subagents' included, get no offer and no record.
  vi.stubEnv('TENJIN_MODEL_WORKER', '1');
  const before = (await f.model.store.noOffers()).length;
  expect(await call('worker', 'w:0', nested, { prompt: 'Read B.' })).toEqual({ action: 'native' });
  expect(f.route).toHaveBeenCalledTimes(2);
  expect(await f.model.store.noOffers()).toHaveLength(before);
});

it('records why a subagent cannot take an offer, from a subagent: its tools, a mode of its own at or above it, or a folder of its own', async () => {
  // Catches: an offer to a subagent that cannot call the accept tool (a fee it can only
  // repeat away), a worker in the session's mode or folder in place of a child that would
  // inherit another mode or a worktree, and a record that does not say a subagent made it.
  const f = await routedFixture();
  vi.stubEnv('HOME', dir);
  const agents = join(f.workspace.root, '.claude', 'agents');
  await mkdir(agents, { recursive: true });
  const define = (name: string, frontmatter: string) =>
    writeFile(
      join(agents, `${name}.md`),
      `---\nname: ${name}\ndescription: test\n${frontmatter}---\n\nYou are ${name}.\n`,
    );
  await define('reader', 'tools: Read, Agent\n');
  await define('lead', 'permissionMode: acceptEdits\n');
  await define('helper', 'tools: Read, Agent, mcp__plugin_tenjin_router\n');
  let n = 0;
  const capture = (caller: ModelCaller | undefined, session: ModelSession = f.session) =>
    f.model.capture(
      session,
      `call-${++n}`,
      { prompt: 'Read.' },
      undefined,
      'Agent',
      `${n}`,
      caller,
    );
  const reason = async (caller?: ModelCaller, session?: ModelSession) => {
    expect(await capture(caller, session)).toEqual({ action: 'native' });
    const { code, detail, from } = (await f.model.store.noOffers()).at(-1)!;
    return { code, detail, from };
  };
  const unqualified = (detail: string) => ({
    code: 'caller_unqualified',
    detail,
    from: 'subagent',
  });
  expect(await reason(child('a', { agentType: 'reader' }))).toEqual(unqualified('tools'));
  // One the host did not list: nothing says what it can call.
  expect(await reason({ agentId: 'b' })).toEqual(unqualified('tools'));
  expect(await reason(child('c', { agentType: 'lead' }))).toEqual(unqualified('mode'));
  expect(await reason(child('d', { parents: ['lead'] }))).toEqual(unqualified('mode'));
  // An agent above it that the host no longer lists may have set one.
  expect(await reason(child('e', { parents: ['general-purpose', ''] }))).toEqual(
    unqualified('mode'),
  );
  const worktree = join(f.workspace.root, '.claude', 'worktrees', 'w');
  expect(await reason(child('f', { cwd: worktree }))).toEqual(unqualified('folder'));
  // Any other reason says the same of a subagent's call, and nothing of the main loop's.
  const plan = { ...f.session, claudePermissionMode: 'plan' as never };
  const planned = { code: 'permission_mode', detail: 'plan' };
  expect(await reason(child('g'), plan)).toEqual({ ...planned, from: 'subagent' });
  expect(await reason(undefined, plan)).toEqual({ ...planned, from: undefined });
  expect(f.route).not.toHaveBeenCalled();
  // Tools that name the accept tool's server, under agents in the session's mode: offered.
  const helper = child('h', { agentType: 'helper', parents: ['general-purpose'] });
  expect(await capture(helper)).toMatchObject({ action: 'offer' });
});

it('offers a custom agent whose definition pins no model, and keeps one that pins a model native', async () => {
  const f = await routedFixture();
  const agents = join(f.workspace.root, '.claude', 'agents');
  await mkdir(agents, { recursive: true });
  const define = (name: string, frontmatter: string) =>
    writeFile(
      join(agents, `${name}.md`),
      `---\nname: ${name}\ndescription: test\n${frontmatter}---\n\nYou are ${name}.\n`,
    );
  await define('loop-worker', 'model: inherit\neffort: high\ntools: Read, Bash\n');
  await define('pinned-worker', 'model: opus\n');
  const call = (type: string) =>
    f.model.capture(f.session, `call-${type}`, {
      prompt: 'Read the fixture.',
      subagent_type: type,
    });
  expect(await call('loop-worker')).toMatchObject({ action: 'offer' });
  // The worker is qualified as that agent, so its accept and its run read the same type.
  expect(vi.mocked(qualifiedModelWorker).mock.calls.at(-1)?.[1]).toBe('loop-worker');
  expect(await call('pinned-worker')).toEqual({ action: 'native' });
  expect((await f.model.store.noOffers()).at(-1)).toMatchObject({
    code: 'input_filter',
    detail: 'definition:model',
  });
  expect(f.route).toHaveBeenCalledTimes(1);
});

it.each([
  ['codex:codex-rescue'],
  ['vercel:deployment-expert'],
  ['stripe:Company Researcher'],
  ['claude-code-guide'],
  ['Plan'],
])(
  "never offers %s: a plugin's agent or the host's own, not the person's to send",
  async (type) => {
    const f = await routedFixture();
    vi.mocked(qualifiedModelWorker).mockClear();
    // The Codex lane's wrapper would match as a definition if it were read: it is not.
    const agents = join(f.workspace.root, '.claude', 'agents');
    await mkdir(agents, { recursive: true });
    await writeFile(
      join(agents, 'rescue.md'),
      '---\nname: codex:codex-rescue\ndescription: test\ntools: Bash\n---\n\nRun codex.\n',
    );
    expect(
      await f.model.capture(f.session, 'call', { prompt: 'Rescue the task.', subagent_type: type }),
    ).toEqual({ action: 'native' });
    expect((await f.model.store.noOffers()).at(-1)).toMatchObject({
      code: 'input_filter',
      detail: 'subagent_type',
      tool: 'Agent',
    });
    // Nothing was qualified, routed or paid for.
    expect(qualifiedModelWorker).not.toHaveBeenCalled();
    expect(f.route).not.toHaveBeenCalled();
  },
);

it('records one code for each reason a held call gets no offer, and never its text', async () => {
  const f = await routedFixture();
  const call = { prompt: 'PRIVATE-ASSIGNMENT read the fixture.' };
  let n = 0;
  const reason = async (
    native: Record<string, unknown> = call,
    session: ModelSession = f.session,
  ) => {
    expect(await f.model.capture(session, `call-${n++}`, native)).toMatchObject({
      action: 'native',
    });
    const { code, detail, bytes, limit } = (await f.model.store.noOffers()).at(-1)!;
    return { code, detail, bytes, limit };
  };
  expect(await reason(call, { ...f.session, claudePermissionMode: 'plan' as never })).toMatchObject(
    { code: 'permission_mode', detail: 'plan' },
  );
  for (const field of ['name', 'team_name', 'isolation', 'resume'])
    expect(await reason({ ...call, [field]: 'set' })).toMatchObject({
      code: 'input_filter',
      detail: field,
    });
  expect(await reason({ ...call, subagent_type: 'custom-agent' })).toMatchObject({
    code: 'input_filter',
    detail: 'subagent_type',
  });
  vi.mocked(qualifiedModelWorker).mockResolvedValueOnce(null);
  expect(await reason()).toMatchObject({ code: 'worker_unqualified' });
  vi.mocked(qualifiedModelWorker).mockResolvedValueOnce({
    path: '/fixture/worker',
    claudeWorkspace: { ...f.workspace, workingDirectories: [f.workspace.root, '/elsewhere'] },
  });
  expect(await reason()).toMatchObject({ code: 'scope_not_covered' });
  expect(
    await reason(call, { ...f.session, transcript: join(dir, 'missing.jsonl') }),
  ).toMatchObject({ code: 'parent_context_unavailable' });
  const large = await reason({ prompt: 'x'.repeat(20_000) });
  expect(large).toMatchObject({ code: 'over_size_limit', limit: MODEL_ROUTE_BODY_BYTES });
  expect(large.bytes).toBeGreaterThan(20_000);
  expect(f.route).not.toHaveBeenCalled();
  f.route.mockRejectedValueOnce(new Error('PRIVATE-ASSIGNMENT refused'));
  expect(await reason()).toMatchObject({ code: 'route_error' });
  f.route.mockResolvedValueOnce({ schemaVersion: 1, action: 'native', reason: 'no_paid' });
  expect(await reason()).toMatchObject({ code: 'server_declined', detail: 'no_paid' });
  f.route.mockResolvedValueOnce({ ...offer, jobId: randomUUID() });
  expect(await reason()).toMatchObject({ code: 'invalid_offer' });
  // Cancelled while its route request was being built: the answer is no longer wanted.
  const made = f.model.store.offer.bind(f.model.store);
  vi.spyOn(f.model.store, 'offer').mockImplementationOnce(async (...args) => {
    const job = await made(...args);
    await f.model.store.fenceOwned(job.id, 'root');
    return job;
  });
  expect(await reason()).toMatchObject({ code: 'superseded' });
  // The session closed while the router was asked.
  const closing = new AbortController();
  f.route.mockImplementationOnce(async () => {
    closing.abort();
    throw new Error('aborted');
  });
  const other = { prompt: 'PRIVATE-ASSIGNMENT read another fixture.' };
  expect(await f.model.capture(f.session, 'closing-call', other, closing.signal)).toMatchObject({
    action: 'native',
  });
  expect((await f.model.store.noOffers()).at(-1)).toMatchObject({ code: 'interrupted' });
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  config.router.subagentConsent.routerOrigin = 'https://elsewhere.test';
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  expect(await reason(other)).toMatchObject({ code: 'no_consent' });
  expect(await readFile(join(dir, 'model-jobs', 'no-offers.json'), 'utf8')).not.toContain(
    'PRIVATE-ASSIGNMENT',
  );
});

it('fits a route request by giving up parent context, oldest first, and never the assignment', () => {
  const size = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value)) + MODEL_ROUTE_ENVELOPE_BYTES;
  const admission = (task: string, context: string[]) => ({
    schemaVersion: 1 as const,
    consent: true as const,
    accepts: ['deepseek-flash'] as ['deepseek-flash'],
    subagentTask: task,
    parentContext: context.map((content) => ({ role: 'user' as const, content })),
  });
  const task = 'Assignment "quoted"\n'.repeat(300);
  const small = admission(task, ['one', 'two']);
  expect(fitAdmission(small)).toEqual(small);
  const fitted = fitAdmission(admission(task, ['old '.repeat(2000), 'mid', 'new\n'.repeat(4000)]));
  expect(size(fitted)).toBeLessThanOrEqual(MODEL_ROUTE_BODY_BYTES);
  expect(fitted.subagentTask).toBe(task);
  // The newest message is the one kept, cut at its end; the router needs one entry.
  expect(fitted.parentContext).toHaveLength(1);
  expect(fitted.parentContext[0]!.content.startsWith('new\nnew\n')).toBe(true);
  // An assignment over the limit by itself is never cut: the request stays over.
  const over = fitAdmission(admission('x'.repeat(17_000), ['context']));
  expect(over.subagentTask).toHaveLength(17_000);
  expect(over.parentContext).toEqual([{ role: 'user', content: '' }]);
  expect(size(over)).toBeGreaterThan(MODEL_ROUTE_BODY_BYTES);
});
