import { completedMessageSse, workerMessages } from './model-messages';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import { findDefinition } from './agent-tools';
import {
  query,
  resolveSettings as resolveWorkerSettings,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk/core';
import type { CodexModelPolicy } from './codex-model-gates';
import {
  qualifyNativeCodexWorker,
  runNativeCodexWorker,
  type NativeCodexSnapshot,
} from './codex-native-worker';
import { readClaudeCode, meetsFloor } from './claude-cli';
import { modelSettings } from './model-settings';
import { MODEL_NATIVE_TEXT_BYTES } from './model-limits';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';
import {
  assertClaudeWorkerMode,
  claudeDeepSeekWorkerApiKeyHelper,
  claudeDeepSeekWorkerEnv,
  claudeDeepSeekWorkerSettingsEnv,
  claudeManagedProviderCompatible,
  claudeMcpProviderCompatible,
  claudeWorkerAuthCompatible,
  CLAUDE_DEEPSEEK_WORKER_MODEL,
  type ClaudeWorkerPermissionMode,
} from './claude-model-policy';
import type { InstructionContext } from './model-instructions';
import {
  claudeWorkerPrivatePaths,
  prepareClaudeWorkerSession,
  type ClaudeWorkerSession,
} from './claude-worker-session';
import { claudeWorkerProcess } from './claude-worker-process';
import { claudeWorkerSandboxCompatible } from './claude-worker-sandbox';
import {
  resolveClaudeWorkspace,
  savedClaudeWorkspace,
  sameClaudeWorkspace,
  type ClaudeWorkspace,
} from './claude-workspace';
import {
  withWorkerDeadline,
  WorkerRepeatReminder,
  workerResultError,
  WORKER_EMERGENCY_TURNS,
} from './model-worker-control';

type QualifiedWorker = {
  path: string;
  source?: string;
  instructionContext?: InstructionContext;
  nativeSnapshot?: NativeCodexSnapshot;
  disclosureRepositories?: string[];
  claudeWorkspace?: ClaudeWorkspace;
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
  if (!claudeWorkerAuthCompatible(process.env)) return null;
  const state = await readClaudeCode(process.env, cwd);
  if (!state.binary || !state.version || !meetsFloor(state.version, '2.1.325')) return null;
  if (await findDefinition(agentType, { cwd, homeDir: homedir() })) return null;
  const resolved = await resolveWorkerSettings({
    cwd,
    settingSources: ['user', 'project', 'local'],
  });
  const { effective } = resolved;
  if (!claudeWorkerAuthCompatible(process.env, effective.env)) return null;
  if (!claudeManagedProviderCompatible(resolved)) return null;
  if (claudePermissionMode === 'auto' && effective.permissions?.disableAutoMode === 'disable')
    return null;
  const disclosure = await modelSettings(dataDir, cwd);
  const claudeWorkspace =
    disclosure &&
    (await resolveClaudeWorkspace(
      cwd,
      effective,
      disclosure.scope === 'native-workspace' ? disclosure.scope : disclosure.repositories,
    ));
  return claudeWorkspace && claudeWorkerSandboxCompatible([cwd, claudeWorkspace.root], resolved)
    ? { ...state.binary, claudeWorkspace }
    : null;
}

/** Runs a qualified worker without changing the parent process or provider. */
export async function runModelWorker(
  job: ModelJob,
  options: {
    dataDir: string;
    transport: ModelTransport;
    signal: AbortSignal;
    codexPolicy?: CodexModelPolicy;
    claudePermissionMode?: ClaudeWorkerPermissionMode;
    currentClaudePermissionMode?: () => unknown;
    claudeSession?: ClaudeWorkerSession;
    activity?: {
      observe: (message: unknown) => void;
      running: () => void;
    };
    permission: (
      tool: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<boolean>;
  },
) {
  return withWorkerDeadline(options.signal, async (signal) => {
    const current = { ...options, signal };
    signal.throwIfAborted();
    if (current.codexPolicy)
      return runNativeCodexWorker(job, { ...current, codexPolicy: current.codexPolicy });
    assertClaudeWorkerMode(job.decision.claudePermissionMode, current.claudePermissionMode);
    if (!current.currentClaudePermissionMode)
      throw new Error('Owned Claude mode observer is unavailable');
    assertClaudeWorkerMode(
      job.decision.claudePermissionMode,
      current.currentClaudePermissionMode(),
    );
    const binary = await qualifiedModelWorker(
      job.root,
      String(job.native.subagent_type ?? 'general-purpose'),
      undefined,
      current.dataDir,
      signal,
      current.claudePermissionMode,
    );
    signal.throwIfAborted();
    assertClaudeWorkerMode(
      job.decision.claudePermissionMode,
      current.currentClaudePermissionMode(),
    );
    if (!binary) throw new Error('Claude Code worker is unavailable; keep native');
    const saved = savedClaudeWorkspace(job.decision.claudeWorkspace);
    if (!saved || !binary.claudeWorkspace || !sameClaudeWorkspace(saved, binary.claudeWorkspace))
      throw new Error('Owned Claude workspace scope changed or is unavailable');
    return runQualifiedWorker(job, current, binary);
  });
}

async function runQualifiedWorker(
  job: ModelJob,
  options: Parameters<typeof runModelWorker>[1],
  binary: { path: string; claudeWorkspace?: ClaudeWorkspace },
) {
  options.signal.throwIfAborted();
  const permissionMode = assertClaudeWorkerMode(
    job.decision.claudePermissionMode,
    options.claudePermissionMode,
  );
  const assertCurrentMode = () =>
    assertClaudeWorkerMode(permissionMode, options.currentClaudePermissionMode?.());
  assertCurrentMode();
  const workspace = savedClaudeWorkspace(job.decision.claudeWorkspace);
  if (!workspace) throw new Error('Owned Claude workspace scope is unavailable');
  const assertCurrentWorkspace = async () => {
    if (!claudeWorkerAuthCompatible(process.env))
      throw new Error('Native Claude authentication is owned by its host; keep native');
    const disclosure = await modelSettings(options.dataDir, job.root);
    const resolved = await resolveWorkerSettings({
      cwd: job.root,
      settingSources: ['user', 'project', 'local'],
    });
    if (
      !claudeManagedProviderCompatible(resolved) ||
      !claudeWorkerAuthCompatible(process.env, resolved.effective.env)
    )
      throw new Error('Managed Claude provider or authentication changed; keep native');
    const current =
      disclosure &&
      (await resolveClaudeWorkspace(
        job.root,
        resolved.effective,
        disclosure.scope === 'native-workspace' ? disclosure.scope : disclosure.repositories,
      ));
    if (
      !current ||
      !claudeWorkerSandboxCompatible([job.root, current.root], resolved) ||
      !sameClaudeWorkspace(workspace, current)
    )
      throw new Error('Owned Claude workspace scope changed or disclosure was revoked');
    return resolved;
  };
  const session = await prepareClaudeWorkerSession(options.claudeSession, job.root);
  const protectedRoots = [
    ...new Set([
      ...workspace.workingDirectories,
      ...workspace.readExceptions,
      ...workspace.writeExceptions,
    ]),
  ];
  options.signal.throwIfAborted();
  assertCurrentMode();
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  const token = randomBytes(32).toString('hex');
  const nativeProcess = claudeWorkerProcess();
  const pending = new Set<Promise<void>>();
  let worker: ReturnType<typeof query> | undefined;
  let proxyFailure: { error: unknown } | undefined;
  let initialized!: (allowed: boolean) => void;
  const nativeModeReady = new Promise<boolean>((resolve) => {
    initialized = resolve;
  });
  let authorizePrompt!: (allowed: boolean) => void;
  const authenticationReady = new Promise<boolean>((resolve) => {
    authorizePrompt = resolve;
  });
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    if (!(await authenticationReady)) return;
    controller.signal.throwIfAborted();
    yield {
      type: 'user',
      session_id: '',
      message: { role: 'user', content: [{ type: 'text', text: job.task }] },
      parent_tool_use_id: null,
    };
  }
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
        await assertCurrentWorkspace();
        assertCurrentMode();
        if (controller.signal.aborted) throw new Error('Model consent revoked or job cancelled');
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
  let executionFailure: { error: unknown } | undefined;
  let closeFailure: { error: unknown; quiescent: boolean } | undefined;
  const repeats = new WorkerRepeatReminder();
  try {
    await new Promise<void>((resolve, reject) => {
      bridge.once('error', reject);
      bridge.listen(0, '127.0.0.1', resolve);
    });
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('Worker bridge failed');
    const env = claudeDeepSeekWorkerEnv(process.env, `http://127.0.0.1:${address.port}`, token);
    const resolved = await assertCurrentWorkspace();
    const privatePaths = await claudeWorkerPrivatePaths(
      options.dataDir,
      job.root,
      process.env,
      resolved.effective.env,
      { sources: resolved.sources, workingDirectories: workspace.workingDirectories },
    );
    if (
      !claudeManagedProviderCompatible(resolved) ||
      (permissionMode === 'auto' && resolved.effective.permissions?.disableAutoMode === 'disable')
    )
      throw new Error('Managed Claude worker policy changed; keep native');
    assertCurrentMode();
    options.signal.throwIfAborted();
    worker = query({
      prompt: prompt(),
      options: {
        pathToClaudeCodeExecutable: binary.path,
        spawnClaudeCodeProcess: nativeProcess.spawn,
        cwd: job.root,
        additionalDirectories: workspace.workingDirectories.slice(1),
        env,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        model: CLAUDE_DEEPSEEK_WORKER_MODEL,
        ...(job.native.subagent_type === 'Explore' ? { agent: 'Explore' } : {}),
        effort: 'high',
        abortController: controller,
        permissionMode,
        ...session?.query,
        settingSources: ['user', 'project', 'local'],
        settings: {
          // Auto memory is undeclared input outside this job's disclosure scope.
          // Native settings, instruction files and owned session history still load.
          autoMemoryEnabled: false,
          apiKeyHelper: claudeDeepSeekWorkerApiKeyHelper(),
          env: claudeDeepSeekWorkerSettingsEnv(`http://127.0.0.1:${address.port}`, token),
          permissions: {
            blockReadsOutsideWorkingDirectories: true,
            blockWritesOutsideWorkingDirectories: true,
            workingDirectoriesAsGiven: workspace.workingDirectorySpellings,
            blockReadsExemptPaths: workspace.readExceptions,
            deny: [
              ...privatePaths.deny,
              ...protectedRoots.flatMap((root) => {
                const absolute = `//${root.replaceAll('\\', '/').replace(/^\/+/, '')}`;
                const patterns = [
                  `${absolute}/.env*`,
                  `${absolute}/**/.env*`,
                  ...(basename(root).startsWith('.env') ? [absolute] : []),
                ];
                return ['Read', 'Edit', 'Write'].flatMap((tool) =>
                  patterns.map((pattern) => `${tool}(${pattern})`),
                );
              }),
            ],
          },
        },
        sandbox: {
          enabled: true,
          allowUnsandboxedCommands: false,
          failIfUnavailable: true,
          filesystem: {
            denyRead: [
              ...privatePaths.paths,
              ...protectedRoots.flatMap((root) => [
                `${root}/.env*`,
                `${root}/**/.env*`,
                ...(basename(root).startsWith('.env') ? [root] : []),
              ]),
            ],
            denyWrite: privatePaths.paths,
          },
        },
        // Direct callers remain ephemeral; only the owned controller may retain
        // and reopen a session. Native retention/config discovery are unchanged.
        persistSession: session !== undefined,
        // Emergency runaway guard; ordinary jobs may continue until completion.
        maxTurns: WORKER_EMERGENCY_TURNS,
        disallowedTools: [
          'Agent',
          'Task',
          'mcp__plugin_tenjin_router__subagent',
          'mcp__plugin_tenjin_router__request',
          'mcp__plugin_tenjin_router__approve',
        ],
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async () => {
                  try {
                    assertCurrentMode();
                    await assertCurrentWorkspace();
                  } catch {
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason:
                          'Owned permission mode or workspace scope changed or is unavailable',
                      },
                    };
                  }
                  return !controller.signal.aborted
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
          PostToolUse: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== 'PostToolUse') return {};
                  const reminder = repeats.observe(input.tool_name, input.tool_input);
                  return reminder
                    ? {
                        hookSpecificOutput: {
                          hookEventName: 'PostToolUse',
                          additionalContext: reminder,
                        },
                      }
                    : {};
                },
              ],
            },
          ],
          PostToolUseFailure: [
            {
              hooks: [
                async (input) => {
                  if (input.hook_event_name !== 'PostToolUseFailure') return {};
                  const reminder = repeats.observe(input.tool_name, input.tool_input);
                  return reminder
                    ? {
                        hookSpecificOutput: {
                          hookEventName: 'PostToolUseFailure',
                          additionalContext: reminder,
                        },
                      }
                    : {};
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
    controller.signal.throwIfAborted();
    let stopAuthentication!: () => void;
    const authenticationStopped = new Promise<never>((_resolve, reject) => {
      stopAuthentication = () => reject(controller.signal.reason);
    });
    controller.signal.addEventListener('abort', stopAuthentication, { once: true });
    try {
      // accountInfo is the maintained SDK initialize response, before a task is
      // sent. A saved gateway can override env/helper auth without an env flag.
      const account = await Promise.race([worker.accountInfo(), authenticationStopped]);
      if (
        account?.apiProvider !== 'firstParty' ||
        !['apiKeyHelper', 'ANTHROPIC_API_KEY'].includes(account.apiKeySource ?? '') ||
        account.email !== undefined ||
        account.subscriptionType !== undefined ||
        (account.tokenSource !== undefined &&
          !['none', 'apiKeyHelper', 'ANTHROPIC_AUTH_TOKEN'].includes(account.tokenSource))
      )
        throw new Error(
          'Native Claude selected an unsupported API provider or authentication source; keep native',
        );
      controller.signal.throwIfAborted();
      authorizePrompt(true);
    } finally {
      controller.signal.removeEventListener('abort', stopAuthentication);
    }
    let activityReady = false;
    for await (const message of worker) {
      if (message.type === 'system' && message.subtype === 'init') {
        const matches = message.permissionMode === permissionMode;
        if (session) {
          if ((await realpath(message.cwd)) !== (await realpath(job.root)))
            throw new Error('Native Claude changed the owned worker workspace');
          session.assert(message.session_id);
        }
        if (matches && !claudeMcpProviderCompatible(await worker.mcpServerStatus()))
          throw new Error('An MCP depends on replaced provider credentials; keep native');
        if (!matches) throw new Error('Native Claude changed the owned permission mode');
        await session?.bind(message.session_id);
        controller.signal.throwIfAborted();
        assertCurrentMode();
        initialized(matches);
        clearTimeout(initTimer);
        activityReady = true;
        try {
          options.activity?.running();
        } catch {
          // Display failures never change execution or permission decisions.
        }
      }
      if (activityReady) {
        try {
          options.activity?.observe(message);
        } catch {
          // The SDK remains the owner of complete worker history.
        }
      }
      if (message.type === 'result') {
        session?.assert(message.session_id);
        if (message.subtype !== 'success') throw workerResultError(message);
        result = message.result;
      }
    }
    if (proxyFailure) throw proxyFailure.error;
    if (!result) throw new Error('DeepSeek worker returned no completed result');
    if (Buffer.byteLength(result, 'utf8') > MODEL_NATIVE_TEXT_BYTES)
      throw new Error('Worker handback exceeds size limit; inspect receipts before retrying');
  } catch (error) {
    executionFailure = proxyFailure ?? { error };
  } finally {
    authorizePrompt(false);
    clearTimeout(initTimer);
    initialized(false);
    controller.signal.removeEventListener('abort', denyInitialization);
    controller.abort();
    worker?.close();
    const processClosed = (async () => {
      let cleanupFailure: { error: unknown } | undefined;
      try {
        await worker?.return?.();
      } catch (error) {
        cleanupFailure = { error };
      }
      const drained = await nativeProcess.drain();
      return cleanupFailure || !drained.successful
        ? {
            error:
              cleanupFailure?.error ??
              new Error('Claude worker process did not close successfully'),
            quiescent: true,
          }
        : undefined;
    })().then(
      (outcome) => outcome,
      (error) => ({ error, quiescent: false }),
    );
    bridge.closeAllConnections();
    await Promise.allSettled([...pending]);
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    options.signal.removeEventListener('abort', cancel);
    closeFailure = await processClosed;
  }
  if (closeFailure && (!executionFailure || !closeFailure.quiescent)) throw closeFailure.error;
  if (executionFailure) throw executionFailure.error;
  return result!;
}
