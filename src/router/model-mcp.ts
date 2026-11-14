import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ModelHandoff, type ModelSession } from './model-handoff';
import { modelSettings } from './model-settings';
import { qualifiedModelWorker, runModelWorker } from './model-worker';
import type { ModelTransport } from './model-transport';
import { ModelLifecycle } from './model-lifecycle';
import { claudeWorkerPermissionMode } from './claude-model-policy';
import { workerStop } from './model-worker-control';
import { claudeWorkerConfigDir } from './claude-worker-session';
import { continuationRefusal, ownedModelReference } from './model-continuation';
import type { ModelConversation, ModelConversationOwner } from './model-conversations';
import { savedClaudeWorkspace, sameClaudeWorkspace } from './claude-workspace';

type ActiveConversation = {
  handle: string;
  owner: ModelConversationOwner;
  continuationId: string;
};

const workerShutdown = new WeakMap<McpServer, () => Promise<void>>();
export async function stopModelWorkers(server: McpServer) {
  await workerShutdown.get(server)?.();
}

export function registerModelTool(
  server: McpServer,
  options: {
    dataDir: string;
    harness: 'claude' | 'codex';
    session: () => ModelSession | undefined;
    transport: () => Promise<ModelTransport>;
  },
) {
  const lifecycle = new ModelLifecycle();
  const controllers = new Map<
    string,
    { abort: AbortController; done: Promise<unknown>; conversation?: ActiveConversation }
  >();
  let handoff: ModelHandoff | undefined;
  const getHandoff = async () =>
    (handoff ??= new ModelHandoff({
      dataDir: options.dataDir,
      transport: await options.transport(),
    }));
  const answer = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  });
  const fence = async (session: ModelSession) => {
    const draining = lifecycle.fence(session);
    const model = await getHandoff();
    const pending = await model.store.pending(session.sessionId, session.turnId);
    const fenceConversation = async () => {
      if (options.harness !== 'claude' || !pending) return;
      const active = controllers.get(pending.id)?.conversation;
      const owner = active?.owner ?? {
        parentSessionId: session.sessionId,
        root: pending.root,
        configDir:
          typeof pending.decision.workerConfigDir === 'string'
            ? pending.decision.workerConfigDir
            : claudeWorkerConfigDir(pending.root),
      };
      const conversation = active
        ? { handle: active.handle }
        : typeof pending.decision.workerHandle === 'string'
          ? await model.conversations.lookup(pending.decision.workerHandle, owner)
          : await model.conversations.findByJob(pending.id, owner);
      if (conversation) await model.conversations.fence(conversation.handle, owner, pending.id);
    };
    await model.store.fence(session.sessionId, session.turnId, 'cancelling');
    await fenceConversation();
    await draining;
    await fenceConversation();
    await model.store.fence(session.sessionId, session.turnId);
  };
  server.registerTool(
    'subagent',
    {
      title: 'Tenjin subagent',
      description:
        'Run or cancel a Tenjin DeepSeek subagent offer. Accept with offer_id; cancel with cancel. For a held Codex delegation, submit delegation_id and the complete plaintext task. The offer carries consent and the parent routing policy.',
      annotations: { title: 'DeepSeek subagent', readOnlyHint: false },
      inputSchema: {
        offer_id: z.string().uuid().optional(),
        cancel: z.string().uuid().optional(),
        // Mod transport only. The same MCP process has already seen the owned root hook.
        capture: z
          .object({
            session_id: z.string(),
            tool_use_id: z.string(),
            tool: z.enum(['Agent', 'Task', 'SendMessage']).optional(),
            input: z.record(z.string(), z.unknown()),
          })
          .optional(),
        delegation_id: z.string().uuid().optional(),
        task: z.string().optional(),
      },
    },
    async (args, extra) => {
      let ownedContinuation = args.capture
        ? ownedModelReference(args.capture.input, args.capture.tool ?? 'Agent').owned
        : false;
      const unavailable = (reason: string) =>
        answer(ownedContinuation ? continuationRefusal(reason) : { action: 'native', reason });
      const session = options.session();
      const ownedSessionId = session?.sessionId;
      const ownedTurnId = session?.turnId;
      const currentClaudeMode = () => {
        const current = options.session();
        return current?.sessionId === ownedSessionId && current?.turnId === ownedTurnId
          ? current?.claudePermissionMode
          : undefined;
      };
      if (
        !session ||
        process.env.TENJIN_MODEL_WORKER === '1' ||
        (options.harness === 'codex' && extra._meta?.['threadId'] !== session.sessionId)
      )
        return unavailable('Host worker permission bridge is not qualified');
      if (
        [args.offer_id, args.cancel, args.capture, args.delegation_id].filter(
          (v) => v !== undefined,
        ).length !== 1
      )
        return unavailable('Use one subagent operation');
      if (args.cancel) {
        const pending = await (await getHandoff()).store.pending(session.sessionId, session.turnId);
        if (pending?.id !== args.cancel) return answer({ status: 'not_owned' });
        await fence(session);
        return answer({ status: 'cancelled' });
      }
      if (args.offer_id && options.harness === 'claude') {
        const model = await getHandoff();
        const selected = await model.store.pending(session.sessionId, session.turnId);
        ownedContinuation ||=
          typeof selected?.decision.workerHandle === 'string' ||
          (await model.conversations.findByJob(args.offer_id, {
            parentSessionId: session.sessionId,
            root: session.cwd,
            configDir: claudeWorkerConfigDir(session.cwd),
          })) !== null;
      }
      return lifecycle
        .run(session, extra.signal, async (signal) => {
          if (args.capture) {
            if (
              options.harness !== 'claude' ||
              args.capture.session_id !== session.sessionId ||
              !server.server.getClientCapabilities()?.elicitation
            )
              return unavailable('Owned root or permission prompts unavailable');
            try {
              return answer(
                await (
                  await getHandoff()
                ).capture(
                  session,
                  args.capture.tool_use_id,
                  args.capture.input,
                  signal,
                  args.capture.tool,
                ),
              );
            } catch {
              return unavailable('Model routing unavailable');
            }
          }
          if (args.delegation_id) {
            if (options.harness !== 'codex' || typeof args.task !== 'string')
              return answer({ action: 'native', reason: 'Complete plaintext assignment required' });
            try {
              return answer(
                await (
                  await getHandoff()
                ).submitCodex(session, args.delegation_id, args.task, signal),
              );
            } catch {
              return answer({
                action: 'native',
                reason: 'Routing unavailable; retry the original native call unchanged',
              });
            }
          }
          if (!args.offer_id)
            return answer({ action: 'native', reason: 'Unsupported submission on this host' });
          const model = await getHandoff();
          const pending = await model.store.pending(session.sessionId, session.turnId);
          const owner: ModelConversationOwner = {
            parentSessionId: session.sessionId,
            root: session.cwd,
            configDir: claudeWorkerConfigDir(session.cwd),
          };
          let conversation: ModelConversation | null = null;
          const resumed =
            options.harness === 'claude' && typeof pending?.decision.workerHandle === 'string';
          ownedContinuation ||= resumed;
          if (options.harness === 'claude' && pending?.id === args.offer_id) {
            conversation = resumed
              ? await model.conversations.lookup(pending.decision.workerHandle as string, owner)
              : await model.conversations.findByJob(pending.id, owner);
            ownedContinuation ||= resumed || conversation !== null;
            // This is local result recovery only. Neither an idle nor a running
            // record can start here; accept also repairs a completed continuation
            // saved just before a crash updating its conversation and local job.
            if (
              conversation &&
              ['idle', 'running'].includes(conversation.state) &&
              conversation.currentContinuationId === pending.id &&
              ['running', 'completed', 'unknown'].includes(pending.state)
            ) {
              const replay = await model.conversations.accept(
                conversation.handle,
                owner,
                pending.id,
              );
              if (replay?.action === 'replay') {
                const envelope = JSON.parse(replay.result);
                if (
                  envelope?.status !== 'completed' ||
                  envelope.worker_handle !== conversation.handle
                )
                  return unavailable('Stored worker completion is unavailable');
                await model.store.finish(pending.id, 'completed').catch(() => undefined);
                return answer(envelope);
              }
            }
          }
          const current = await modelSettings(options.dataDir, session.cwd);
          const transport = await options.transport();
          if (!current || current.routerOrigin !== transport.origin)
            return unavailable('Inference consent revoked or endpoint changed');
          if (
            options.harness === 'claude' &&
            (!claudeWorkerPermissionMode(currentClaudeMode()) ||
              pending?.decision.claudePermissionMode !== currentClaudeMode())
          )
            return unavailable(
              ownedContinuation
                ? 'Owned permission mode changed'
                : 'Owned permission mode changed; retry native',
            );
          if (resumed) {
            if (
              !conversation ||
              conversation.originalJob.decision.routerOrigin !== current.routerOrigin ||
              conversation.root !== current.root ||
              pending?.id !== args.offer_id
            )
              return unavailable('Owned worker history, repository or endpoint changed');
            try {
              await transport.requireResumeBudget(conversation.originalJob);
            } catch {
              return unavailable(
                'Original conversation budget is missing, uncertain or unavailable',
              );
            }
          }
          const qualified = await qualifiedModelWorker(
            session.cwd,
            String(
              (resumed
                ? conversation?.originalJob.native.subagent_type
                : pending?.native.subagent_type) ?? 'general-purpose',
            ),
            session.codexPolicy,
            options.dataDir,
            signal,
            options.harness === 'claude' ? currentClaudeMode() : undefined,
          );
          const offeredWorkspace = savedClaudeWorkspace(pending?.decision.claudeWorkspace);
          if (
            !qualified ||
            (options.harness === 'claude' &&
              (!offeredWorkspace ||
                !qualified.claudeWorkspace ||
                !sameClaudeWorkspace(offeredWorkspace, qualified.claudeWorkspace))) ||
            (options.harness === 'codex' &&
              JSON.stringify(qualified.nativeSnapshot) !==
                JSON.stringify(pending?.decision.nativeSnapshot))
          )
            return unavailable(
              ownedContinuation
                ? 'Host permissions changed'
                : 'Host permissions changed; retry original native call',
            );
          signal.throwIfAborted();
          const job = await model.store.accept(args.offer_id, session.sessionId, session.turnId);
          if (
            !job ||
            job.root !== current.root ||
            job.decision.routerOrigin !== current.routerOrigin
          )
            return unavailable(
              ownedContinuation
                ? 'Continuation expired, changed, already selected or consent revoked'
                : 'Offer expired, changed, already selected or consent revoked; retry original native call unchanged',
            );
          if (
            options.harness === 'claude' &&
            job.decision.claudePermissionMode !== currentClaudeMode()
          ) {
            await model.store.finish(job.id, 'cancelled');
            return unavailable(
              ownedContinuation
                ? 'Owned permission mode changed'
                : 'Owned permission mode changed; retry native',
            );
          }
          let activeConversation: ActiveConversation | undefined;
          let executionJob = job;
          if (options.harness === 'claude') {
            try {
              if (!resumed) {
                conversation = await model.conversations.create({
                  job,
                  parentSessionId: session.sessionId,
                  sdkSessionId: randomUUID(),
                  configDir: owner.configDir,
                });
              }
              if (!conversation) throw new Error('Owned conversation unavailable');
              ownedContinuation = true;
              const accepted = await model.conversations.accept(conversation.handle, owner, job.id);
              if (accepted?.action !== 'start') throw new Error('Continuation already selected');
              conversation = accepted.conversation;
              activeConversation = { handle: conversation.handle, owner, continuationId: job.id };
              if (resumed)
                executionJob = {
                  ...conversation.originalJob,
                  task: job.task,
                  capAtomic: job.capAtomic,
                  turnId: job.turnId,
                  callId: job.callId,
                  decision: {
                    ...conversation.originalJob.decision,
                    claudePermissionMode: currentClaudeMode(),
                    claudeWorkspace: job.decision.claudeWorkspace,
                    requireExistingBudget: true,
                  },
                };
            } catch {
              await model.store.finish(job.id, 'unknown');
              return unavailable('Owned conversation could not be selected; no worker started');
            }
          }
          const abort = new AbortController();
          const stop = () => abort.abort();
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
          const started = Date.now();
          const done = (async () => {
            try {
              signal.throwIfAborted();
              const result = await runModelWorker(executionJob, {
                dataDir: options.dataDir,
                transport,
                signal: abort.signal,
                ...(session.codexPolicy ? { codexPolicy: session.codexPolicy } : {}),
                ...(options.harness === 'claude'
                  ? {
                      claudePermissionMode: currentClaudeMode(),
                      currentClaudePermissionMode: currentClaudeMode,
                      claudeSession: {
                        ...(resumed
                          ? { resume: conversation!.sdkSessionId }
                          : { sessionId: conversation!.sdkSessionId }),
                        onSession: async (id: string) => {
                          if (id !== conversation!.sdkSessionId)
                            throw new Error('Native Claude changed the owned session');
                        },
                      },
                    }
                  : {}),
                permission: async (tool, input, signal) => {
                  if (!server.server.getClientCapabilities()?.elicitation || signal.aborted)
                    return false;
                  const details = JSON.stringify(input);
                  if (Buffer.byteLength(details) > 12000) return false;
                  const response = await server.server.elicitInput(
                    {
                      mode: 'form',
                      message: `DeepSeek worker requests ${tool}: ${details}`,
                      requestedSchema: {
                        type: 'object',
                        properties: {
                          allow: {
                            type: 'boolean',
                            title: 'Allow this action once',
                            default: false,
                          },
                        },
                        required: ['allow'],
                      },
                    },
                    { signal },
                  );
                  return response.action === 'accept' && response.content?.allow === true;
                },
              });
              const envelope = {
                status: 'completed',
                label: 'DeepSeek V4.1 Flash 1017',
                elapsedMs: Date.now() - started,
                spend: await transport
                  .summary(executionJob)
                  .catch(() => ({ accounting: 'unknown' })),
                result,
                ...(activeConversation
                  ? {
                      worker_handle: activeConversation.handle,
                      continuation: `Continue with SendMessage({to:"${activeConversation.handle}",message:"<complete follow-up and current constraints>"}). Tenjin will hold it for the parent accept/veto decision.`,
                    }
                  : {}),
              };
              if (activeConversation) {
                const serialized = JSON.stringify(envelope);
                if (
                  !(await model.conversations.finish(
                    activeConversation.handle,
                    activeConversation.owner,
                    job.id,
                    'completed',
                    serialized,
                  ))
                )
                  throw new Error('Owned worker completion could not be persisted');
                // The conversation result is already durable. A failed local
                // job update is repaired by replay, never by another worker.
                await model.store.finish(job.id, 'completed').catch(() => undefined);
              } else await model.store.finish(job.id, 'completed', result);
              return answer(envelope);
            } catch (error) {
              if (activeConversation)
                await model.conversations
                  .finish(
                    activeConversation.handle,
                    activeConversation.owner,
                    job.id,
                    abort.signal.aborted ? 'cancelled' : 'unknown',
                  )
                  .catch(() => false);
              await model.store
                .finish(job.id, abort.signal.aborted ? 'cancelled' : 'unknown')
                .catch(() => undefined);
              return answer({
                status: abort.signal.aborted ? 'cancelled' : 'unknown',
                stopReason: workerStop(error),
                elapsedMs: Date.now() - started,
                spend: await transport
                  .summary(executionJob)
                  .catch(() => ({ accounting: 'unknown' })),
                nextStep: activeConversation
                  ? 'Inspect pending invocation receipts; do not rebuy an uncertain turn. This owned conversation is fenced. Do not pass its handle to native tools; explicitly create a fresh native assignment with the needed context if required.'
                  : 'Inspect pending invocation receipts; do not rebuy an uncertain turn. Once quiesced, retry the original native Agent call unchanged.',
              });
            } finally {
              controllers.delete(job.id);
              signal.removeEventListener('abort', stop);
            }
          })();
          controllers.set(job.id, {
            abort,
            done,
            ...(activeConversation ? { conversation: activeConversation } : {}),
          });
          return done;
        })
        .catch(() =>
          unavailable('Delegation interrupted; no new worker may start from this offer'),
        );
    },
  );
  const shutdown = async () => {
    await lifecycle.stop();
    for (const running of controllers.values()) running.abort.abort();
    await Promise.allSettled([...controllers.values()].map((c) => c.done));
  };
  workerShutdown.set(server, shutdown);
  return {
    shutdown,
    fence,
    async codexHook(session: ModelSession, raw: Record<string, unknown>) {
      if (process.env.TENJIN_MODEL_WORKER === '1') return null;
      if (
        !['collaborationspawn_agent', 'spawn_agent', 'Agent'].includes(String(raw.tool_name)) ||
        typeof raw.tool_use_id !== 'string' ||
        !raw.tool_input ||
        typeof raw.tool_input !== 'object' ||
        Array.isArray(raw.tool_input)
      )
        return null;
      return lifecycle
        .run(session, undefined, async (signal) =>
          (await getHandoff()).captureCodex(
            session,
            raw.tool_use_id as string,
            raw.tool_input as Record<string, unknown>,
            signal,
          ),
        )
        .catch(() => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'This delegation window was interrupted; start a new turn.',
          },
        }));
    },
  };
}
