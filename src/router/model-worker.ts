import { completedMessageSse, workerMessages } from './model-messages';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { findDefinition } from './agent-tools';
import { join } from 'node:path';
import {
  query,
  resolveSettings as resolveWorkerSettings,
} from '@anthropic-ai/claude-agent-sdk/core';
import type { CodexModelPolicy } from './codex-model-gates';
import {
  qualifyNativeCodexWorker,
  runNativeCodexWorker,
  type NativeCodexSnapshot,
} from './codex-native-worker';
import { readClaudeCode, meetsFloor } from './claude-cli';
import { modelSettings } from './model-settings';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';
import {
  assertClaudeWorkerMode,
  claudeDeepSeekWorkerEnv,
  CLAUDE_DEEPSEEK_MODEL,
  type ClaudeWorkerPermissionMode,
} from './claude-model-policy';
import type { InstructionContext } from './model-instructions';

type QualifiedWorker = {
  path: string;
  source?: string;
  instructionContext?: InstructionContext;
  nativeSnapshot?: NativeCodexSnapshot;
};

/** Qualify host policy, not model capability; unsupported paths stay native. */
export async function qualifiedModelWorker(
  cwd: string,
  agentType = 'general-purpose',
  codexPolicy?: CodexModelPolicy,
  dataDir?: string,
  signal?: AbortSignal,
  claudePermissionMode?: ClaudeWorkerPermissionMode,
): Promise<QualifiedWorker | null> {
  if (!dataDir) return null;
  if (codexPolicy) return qualifyNativeCodexWorker({ cwd, policy: codexPolicy, dataDir, signal });
  const state = await readClaudeCode(process.env, cwd);
  if (!state.binary || !state.version || !meetsFloor(state.version, '2.1.325')) return null;
  if (await findDefinition(agentType, { cwd, homeDir: homedir() })) return null;
  const { effective } = await resolveWorkerSettings({
    cwd,
    settingSources: ['user', 'project', 'local'],
  });
  if (claudePermissionMode === 'auto' && effective.permissions?.disableAutoMode === 'disable')
    return null;
  if (effective.sandbox?.filesystem?.disabled || effective.sandbox?.excludedCommands?.length)
    return null;
  const root = await realpath(cwd);
  const extra = [
    ...(effective.permissions?.additionalDirectories ?? []),
    ...(effective.sandbox?.filesystem?.allowRead ?? []),
  ];
  for (const path of extra) {
    const real = await realpath(resolve(cwd, path)).catch(() => null);
    if (!real || (real !== root && !real.startsWith(`${root}${sep}`))) return null;
  }
  return state.binary;
}

/** Candidate maintained runner. Parent process/provider/Remote Control are untouched. */
export async function runModelWorker(
  job: ModelJob,
  options: {
    dataDir: string;
    transport: ModelTransport;
    signal: AbortSignal;
    codexPolicy?: CodexModelPolicy;
    claudePermissionMode?: ClaudeWorkerPermissionMode;
    currentClaudePermissionMode?: () => unknown;
    permission: (
      tool: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<boolean>;
  },
) {
  options.signal.throwIfAborted();
  if (options.codexPolicy)
    return runNativeCodexWorker(job, { ...options, codexPolicy: options.codexPolicy });
  assertClaudeWorkerMode(job.decision.claudePermissionMode, options.claudePermissionMode);
  if (!options.currentClaudePermissionMode)
    throw new Error('Owned Claude mode observer is unavailable');
  assertClaudeWorkerMode(job.decision.claudePermissionMode, options.currentClaudePermissionMode());
  const binary = await qualifiedModelWorker(
    job.root,
    String(job.native.subagent_type ?? 'general-purpose'),
    undefined,
    options.dataDir,
    options.signal,
    options.claudePermissionMode,
  );
  options.signal.throwIfAborted();
  assertClaudeWorkerMode(job.decision.claudePermissionMode, options.currentClaudePermissionMode());
  if (!binary) throw new Error('Claude Code worker is unavailable; keep native');
  return runQualifiedWorker(job, options, binary);
}

async function runQualifiedWorker(
  job: ModelJob,
  options: Parameters<typeof runModelWorker>[1],
  binary: { path: string },
) {
  options.signal.throwIfAborted();
  const permissionMode = assertClaudeWorkerMode(
    job.decision.claudePermissionMode,
    options.claudePermissionMode,
  );
  const assertCurrentMode = () =>
    assertClaudeWorkerMode(permissionMode, options.currentClaudePermissionMode?.());
  assertCurrentMode();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  const token = randomBytes(32).toString('hex');
  const pending = new Set<Promise<void>>();
  let worker: ReturnType<typeof query> | undefined;
  let proxyFailure: { error: unknown } | undefined;
  let initialized!: (allowed: boolean) => void;
  const nativeModeReady = new Promise<boolean>((resolve) => {
    initialized = resolve;
  });
  const denyInitialization = () => initialized(false);
  controller.signal.addEventListener('abort', denyInitialization, { once: true });
  const initTimer = setTimeout(() => {
    initialized(false);
    controller.abort(new Error('Native Claude permission mode initialization timed out'));
    worker?.close();
  }, 10_000);
  initTimer.unref();
  const bridge = createServer((req, res) => {
    const handle = async () => {
      try {
        if (
          req.method !== 'POST' ||
          req.url?.split('?')[0] !== '/v1/messages' ||
          (req.headers.authorization !== `Bearer ${token}` && req.headers['x-api-key'] !== token)
        ) {
          res.writeHead(403).end();
          return;
        }
        const settings = await modelSettings(options.dataDir, job.root);
        assertCurrentMode();
        if (!settings || controller.signal.aborted)
          throw new Error('Model consent revoked or job cancelled');
        if (!(await nativeModeReady))
          throw new Error('Native Claude did not preserve the owned permission mode');
        assertCurrentMode();
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) throw new Error('Worker request too large');
          chunks.push(chunk);
        }
        const raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const messages = workerMessages(raw);
        assertCurrentMode();
        const message = await options.transport.messages(job, messages, controller.signal);
        if (raw.stream === true)
          res
            .writeHead(200, { 'content-type': 'text/event-stream' })
            .end(completedMessageSse(message));
        else
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
      } catch (error) {
        proxyFailure ??= { error };
        const stop = () => {
          // Transport has already drained any signed accounting before it
          // throws. Stop the model loop rather than retrying a failed turn.
          controller.abort(error);
          worker?.close();
        };
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        if (!res.destroyed)
          res.end(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'api_error',
                message: 'Tenjin worker request stopped; inspect receipts before retrying',
              },
            }),
            stop,
          );
        else stop();
      }
    };
    const done = handle();
    pending.add(done);
    void done.then(
      () => pending.delete(done),
      () => pending.delete(done),
    );
  });
  let result: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      bridge.once('error', reject);
      bridge.listen(0, '127.0.0.1', resolve);
    });
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('Worker bridge failed');
    const env = claudeDeepSeekWorkerEnv(process.env, `http://127.0.0.1:${address.port}`, token);
    options.signal.throwIfAborted();
    worker = query({
      prompt: job.task,
      options: {
        pathToClaudeCodeExecutable: binary.path,
        cwd: job.root,
        env,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        model: CLAUDE_DEEPSEEK_MODEL,
        ...(job.native.subagent_type === 'Explore' ? { agent: 'Explore' } : {}),
        effort: 'high',
        abortController: controller,
        permissionMode,
        settingSources: ['user', 'project', 'local'],
        // Native worktree and sandbox, fail closed when unavailable. No bypass mode.
        // Preserve the parent's workspace, including uncommitted changes.
        // The SDK sandbox isolates execution; native worktree-only calls stay native.
        settings: {
          permissions: {
            blockReadsOutsideWorkingDirectories: true,
            blockWritesOutsideWorkingDirectories: true,
            workingDirectoriesAsGiven: [job.root],
          },
        },
        sandbox: {
          enabled: true,
          allowUnsandboxedCommands: false,
          failIfUnavailable: true,
          filesystem: {
            denyRead: [
              options.dataDir,
              join(homedir(), '.aws'),
              join(job.root, '.env'),
              join(job.root, '.env.local'),
              `${job.root}/**/.env*`,
              join(homedir(), '.ssh'),
              join(homedir(), '.codex', 'auth.json'),
            ],
          },
        },
        persistSession: false,
        maxTurns: 40,
        disallowedTools: ['Agent', 'Task', 'mcp__plugin_tenjin_router__subagent'],
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async () => {
                  try {
                    assertCurrentMode();
                  } catch {
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: 'Owned permission mode changed or is unavailable',
                      },
                    };
                  }
                  const settings = await modelSettings(options.dataDir, job.root);
                  return settings && !controller.signal.aborted
                    ? {}
                    : {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'deny',
                          permissionDecisionReason: 'Model access revoked or job cancelled',
                        },
                      };
                },
              ],
            },
          ],
        },
        canUseTool: async (tool, input, context) => {
          assertCurrentMode();
          if (permissionMode === 'dontAsk')
            return {
              behavior: 'deny',
              message: 'Inherited dontAsk mode does not authorize a prompt',
            };
          const allowed = await options.permission(tool, input, context.signal);
          assertCurrentMode();
          return allowed
            ? { behavior: 'allow', updatedInput: input }
            : {
                behavior: 'deny',
                message: 'User or inherited permission policy declined this action',
              };
        },
      },
    });
    for await (const message of worker) {
      if (message.type === 'system' && message.subtype === 'init') {
        const matches = message.permissionMode === permissionMode;
        initialized(matches);
        clearTimeout(initTimer);
        if (!matches) throw new Error('Native Claude changed the owned permission mode');
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success') throw new Error('DeepSeek worker did not finish');
        result = message.result;
      }
    }
    if (proxyFailure) throw proxyFailure.error;
    if (!result) throw new Error('DeepSeek worker returned no completed result');
    if (Buffer.byteLength(result, 'utf8') > 256_000)
      throw new Error('Worker handback exceeds size limit; inspect receipts before retrying');
    return result;
  } catch (error) {
    if (proxyFailure) throw proxyFailure.error;
    throw error;
  } finally {
    clearTimeout(initTimer);
    initialized(false);
    controller.signal.removeEventListener('abort', denyInitialization);
    controller.abort();
    worker?.close();
    bridge.closeAllConnections();
    await Promise.allSettled([...pending]);
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    options.signal.removeEventListener('abort', cancel);
  }
}
