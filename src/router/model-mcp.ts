import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ModelHandoff, type ModelSession } from './model-handoff';
import { modelSettings } from './model-settings';
import { qualifiedModelWorker, runModelWorker } from './model-worker';
import type { ModelTransport } from './model-transport';
import { ModelLifecycle } from './model-lifecycle';
import { claudeWorkerPermissionMode } from './claude-model-policy';

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
  const controllers = new Map<string, { abort: AbortController; done: Promise<unknown> }>();
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
    await model.store.fence(session.sessionId, session.turnId, 'cancelling');
    await draining;
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
            input: z.record(z.string(), z.unknown()),
          })
          .optional(),
        delegation_id: z.string().uuid().optional(),
        task: z.string().optional(),
      },
    },
    async (args, extra) => {
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
        return answer({
          action: 'native',
          reason: 'Host worker permission bridge is not qualified',
        });
      if (
        [args.offer_id, args.cancel, args.capture, args.delegation_id].filter(
          (v) => v !== undefined,
        ).length !== 1
      )
        return answer({ action: 'native', reason: 'Use one subagent operation' });
      if (args.cancel) {
        const pending = await (await getHandoff()).store.pending(session.sessionId, session.turnId);
        if (pending?.id !== args.cancel) return answer({ status: 'not_owned' });
        await fence(session);
        return answer({ status: 'cancelled' });
      }
      return lifecycle
        .run(session, extra.signal, async (signal) => {
          if (args.capture) {
            if (
              options.harness !== 'claude' ||
              args.capture.session_id !== session.sessionId ||
              !server.server.getClientCapabilities()?.elicitation
            )
              return answer({
                action: 'native',
                reason: 'Owned root or permission prompts unavailable',
              });
            try {
              return answer(
                await (
                  await getHandoff()
                ).capture(session, args.capture.tool_use_id, args.capture.input, signal),
              );
            } catch {
              return answer({ action: 'native', reason: 'Model routing unavailable' });
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
          const current = await modelSettings(options.dataDir, session.cwd);
          const transport = await options.transport();
          if (!current || current.routerOrigin !== transport.origin)
            return answer({
              action: 'native',
              reason: 'Inference consent revoked or endpoint changed',
            });
          const model = await getHandoff();
          const pending = await model.store.pending(session.sessionId, session.turnId);
          if (
            options.harness === 'claude' &&
            (!claudeWorkerPermissionMode(currentClaudeMode()) ||
              pending?.decision.claudePermissionMode !== currentClaudeMode())
          )
            return answer({
              action: 'native',
              reason: 'Owned permission mode changed; retry native',
            });
          const qualified = await qualifiedModelWorker(
            session.cwd,
            'general-purpose',
            session.codexPolicy,
            options.dataDir,
            signal,
            options.harness === 'claude' ? currentClaudeMode() : undefined,
          );
          if (
            !qualified ||
            (options.harness === 'codex' &&
              JSON.stringify(qualified.nativeSnapshot) !==
                JSON.stringify(pending?.decision.nativeSnapshot))
          )
            return answer({
              action: 'native',
              reason: 'Host permissions changed; retry original native call',
            });
          signal.throwIfAborted();
          const job = await model.store.accept(args.offer_id, session.sessionId, session.turnId);
          if (
            !job ||
            job.root !== current.root ||
            job.decision.routerOrigin !== current.routerOrigin
          )
            return answer({
              action: 'native',
              reason:
                'Offer expired, changed, already selected or consent revoked; retry original native call unchanged',
            });
          if (
            options.harness === 'claude' &&
            job.decision.claudePermissionMode !== currentClaudeMode()
          ) {
            await model.store.finish(job.id, 'cancelled');
            return answer({
              action: 'native',
              reason: 'Owned permission mode changed; retry native',
            });
          }
          const abort = new AbortController();
          const stop = () => abort.abort();
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
          const started = Date.now();
          const done = (async () => {
            try {
              signal.throwIfAborted();
              const result = await runModelWorker(job, {
                dataDir: options.dataDir,
                transport,
                signal: abort.signal,
                ...(session.codexPolicy ? { codexPolicy: session.codexPolicy } : {}),
                ...(options.harness === 'claude'
                  ? {
                      claudePermissionMode: currentClaudeMode(),
                      currentClaudePermissionMode: currentClaudeMode,
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
              await model.store.finish(job.id, 'completed', result);
              return answer({
                status: 'completed',
                label: 'DeepSeek V4.1 Flash 1017',
                elapsedMs: Date.now() - started,
                spend: await transport.summary(job).catch(() => ({ accounting: 'unknown' })),
                result,
              });
            } catch {
              await model.store.finish(job.id, abort.signal.aborted ? 'cancelled' : 'unknown');
              return answer({
                status: abort.signal.aborted ? 'cancelled' : 'unknown',
                elapsedMs: Date.now() - started,
                spend: await transport.summary(job).catch(() => ({ accounting: 'unknown' })),
                nextStep:
                  'Inspect pending invocation receipts; do not rebuy an uncertain turn. Once quiesced, retry the original native Agent call unchanged.',
              });
            } finally {
              controllers.delete(job.id);
              signal.removeEventListener('abort', stop);
            }
          })();
          controllers.set(job.id, { abort, done });
          return done;
        })
        .catch(() =>
          answer({
            action: 'native',
            reason: 'Delegation interrupted; no new worker may start from this offer',
          }),
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
