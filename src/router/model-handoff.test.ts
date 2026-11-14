import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('./model-worker', () => ({ qualifiedModelWorker: vi.fn() }));
import { qualifiedModelWorker } from './model-worker';
import { makeInstructionContext } from './model-instructions';
import { ModelHandoff, modelOfferSchema, type ModelSession } from './model-handoff';
import type { ModelTransport } from './model-transport';
import offer from './fixtures/model-offer.json';
let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
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
  expect(await model.submitCodex(session, pending!.id, task)).toMatchObject({
    action: 'offer',
    started: false,
  });
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
});

it('consumes the server canonical offer contract without enabling an alias or provider switch', () => {
  expect(modelOfferSchema.safeParse(offer).success).toBe(true);
  expect(modelOfferSchema.safeParse({ ...offer, model: 'other-model' }).success).toBe(false);
  expect(
    modelOfferSchema.safeParse({ ...offer, endpoint: 'https://elsewhere.test/messages' }).success,
  ).toBe(false);
});
