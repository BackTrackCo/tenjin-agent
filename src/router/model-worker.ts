import { completedMessageSse, TooManyTools, workerMessages } from './model-messages';
import { WorkerDiagnosticsRecord } from './model-worker-diagnostics';
import type { Identities } from './identities';
import {
  answerWorkerWebSearch,
  workerFetchFallback,
  workerWebSearch,
  WORKER_PAGE_READ_LABEL,
  WORKER_SEARCH_LABEL,
  type WorkerFetchEvent,
  type WorkerRequest,
  type WorkerWebDeps,
} from './model-worker-web';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import {
  findDefinition,
  isCustomAgentType,
  WORKER_BUILTIN_AGENTS,
  workerAgent,
  type WorkerAgent,
} from './agent-tools';
import {
  query,
  resolveSettings as resolveWorkerSettings,
  type PermissionUpdate,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk/core';
import type { CodexModelPolicy } from './codex-model-gates';
import {
  qualifyNativeCodexWorker,
  runNativeCodexWorker,
  type NativeCodexSnapshot,
} from './codex-native-worker';
import { readClaudeCodeCached, meetsFloor } from './claude-cli';
import { markSessionServed } from './alive';
import { modelSettings } from './model-settings';
import {
  MODEL_MESSAGES_MAX_TOOLS,
  MODEL_NATIVE_TEXT_BYTES,
  MODEL_OUTPUT_TOKENS,
} from './model-limits';
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
  CLAUDE_DEEPSEEK_COMPACT_WINDOW,
  CLAUDE_DEEPSEEK_WORKER_MODEL,
  type ClaudeWorkerPermissionMode,
} from './claude-model-policy';
import type { InstructionContext } from './model-instructions';
import {
  claudeWorkerPrivatePaths,
  prepareClaudeWorkerSession,
  prepareClaudeWorkerTemp,
  type ClaudeWorkerSession,
} from './claude-worker-session';
import { claudeWorkerProcess } from './claude-worker-process';
import { claudeWorkerSandboxCompatible } from './claude-worker-sandbox';
import {
  findWindowsWorkerClaude,
  nativeWindowsShellPolicy,
  windowsWorkerLaunch,
  type WindowsWorkerLaunch,
} from './windows-worker-launch';
import { SettingsEnvValues, settingsFileEnv } from './model-worker-privacy';
import { workerCredentialProbe } from './worker-credential-probes';
import {
  readBlockUnchecked,
  sandboxJudgesRead,
  unattendedDenial,
  type WorkerAsk,
} from './worker-unattended';
import {
  NativeAgentPromptUnavailable,
  instructionExcludes,
  nativeAgentStartKey,
  readNativeAgentPromptCached,
  type NativeAgentPrompt,
} from './model-worker-agent-prompt';
import {
  jobScopedRules,
  type WorkerPermissionAnswer,
  type WorkerPermissionAsk,
  NATIVE_SUBAGENT_NOTE,
  workerTempNote,
} from './model-worker-prompt';
import {
  claudeWorkspaceWorktrees,
  resolveClaudeWorkspace,
  savedClaudeWorkspace,
  sameClaudeWorkspace,
  withholdDroppedDirectories,
  type ClaudeWorkspace,
} from './claude-workspace';
import {
  prepareWorkerGithub,
  redactWorkerMessage,
  redactWorkerSecrets,
  sessionTokenClears,
  WORKER_ALLOWED_DOMAINS,
  workerTokenValues,
  type WorkerGithub,
} from './worker-github';
import { envDeniedRoots, WorkerEnvSecrets } from './worker-env-secrets';
import {
  modelCallStop,
  withModelRetry,
  ModelWorkerStopped,
  withWorkerDeadline,
  WorkerRepeatReminder,
  workerResultError,
  workerStop,
} from './model-worker-control';

type QualifiedWorker = {
  path: string;
  source?: string;
  instructionContext?: InstructionContext;
  nativeSnapshot?: NativeCodexSnapshot;
  disclosureRepositories?: string[];
  claudeWorkspace?: ClaudeWorkspace;
  windows?: WindowsWorkerLaunch;
};

function readWorkerClaudeCode(cwd: string, windows?: WindowsWorkerLaunch) {
  return readClaudeCodeCached(
    process.env,
    windows ? dirname(windows.claudePath) : cwd,
    windows ? (env) => findWindowsWorkerClaude(env, windows.claudePath) : undefined,
  );
}

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
  const windows = await windowsWorkerLaunch(dataDir, cwd);
  if (process.platform === 'win32' && !windows) return null;
  // Read at every offer and again at its accept: once per binary file, not per call.
  const state = await readWorkerClaudeCode(cwd, windows ?? undefined);
  if (!state.binary || !state.version || !meetsFloor(state.version, '2.1.325')) return null;
  // A built-in a file redefines, a plugin's agent and the host's other built-ins run
  // natively. A custom type's own definition is read where it is offered and where it runs.
  if (
    WORKER_BUILTIN_AGENTS.has(agentType)
      ? (await findDefinition(agentType, { cwd, homeDir: homedir() })) !== null
      : !isCustomAgentType(agentType)
  )
    return null;
  const resolved = await resolveWorkerSettings({
    cwd,
    settingSources: ['user', 'project', 'local'],
  });
  const { effective } = resolved;
  if (!claudeWorkerAuthCompatible(process.env, effective.env)) return null;
  if (!claudeManagedProviderCompatible(resolved)) return null;
  if (
    (claudePermissionMode === 'auto' && effective.permissions?.disableAutoMode === 'disable') ||
    (claudePermissionMode === 'bypassPermissions' &&
      effective.permissions?.disableBypassPermissionsMode === 'disable')
  )
    return null;
  const disclosure = await modelSettings(dataDir, cwd);
  const claudeWorkspace =
    disclosure &&
    (await resolveClaudeWorkspace(
      cwd,
      effective,
      disclosure.scope === 'native-workspace' ? disclosure.scope : disclosure.repositories,
    ));
  return claudeWorkspace &&
    (windows
      ? disclosure?.routerOrigin === windows.routerOrigin && nativeWindowsShellPolicy(resolved)
      : claudeWorkerSandboxCompatible([cwd, claudeWorkspace.root], resolved))
    ? { ...state.binary, claudeWorkspace, ...(windows ? { windows } : {}) }
    : null;
}

/** State supplied only after a Claude offer has been accepted and recorded. */
export type EarlyWorkerAccept = {
  job: ModelJob;
  transport: ModelTransport;
  accepted?: { at: number; marks: Record<string, number> };
  activity?: Parameters<typeof runModelWorker>[1]['activity'];
  currentClaudePermissionMode?: Parameters<typeof runModelWorker>[1]['currentClaudePermissionMode'];
  permission: Parameters<typeof runModelWorker>[1]['permission'];
};

/** A second worker must not start if the prewarmed worker could not be stopped. */
export class WorkerStartUnconfirmed extends Error {}

type EarlyWorkerInput = {
  accept: Promise<EarlyWorkerAccept>;
  onRelease: () => void;
};

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
    /** Tests only: a start-up window. A job has none; its start is bounded by the wall time and by cancel. */
    startupMs?: number;
    /** Tests only: the wait before a model call is tried again. */
    retryWait?: (ms: number, signal: AbortSignal) => Promise<void>;
    /** When the accept reached `tenjin mcp`, and the start phases marked before the run. */
    accepted?: { at: number; marks: Record<string, number> };
    /**
     * A worker started at offer time: it starts its Claude Code and brings it to ready,
     * then waits for `accept` before it sends the assignment. Until then no request leaves
     * it, its wall time has not begun, and nothing it needs from the accept is known.
     */
    early?: EarlyWorkerInput;
    /** `tenjin mcp`'s request executor, which pays for the worker's web searches. Absent,
     *  each search answers that it is not available. */
    web?: WorkerRequest;
    /** The router's identities read, which the person's rules for those searches are
     *  checked against. Absent, the copy the last read kept. */
    webIdentities?: () => Promise<Identities | undefined>;
    /** Where a worker that starts without its native agent prompt says why. Default: stderr. */
    warn?: (line: string) => void;
    activity?: {
      observe: (message: unknown) => void;
      running: () => void;
      rescrub?: (redact: (text: string) => string) => void;
      served?: (
        toolUseId: string,
        via: string,
        figures?: { bytes: number; code: number; codeText: string },
      ) => void;
    };
    permission: (
      tool: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
      ask?: WorkerPermissionAsk,
    ) => Promise<WorkerPermissionAnswer>;
  },
) {
  const run = async (signal: AbortSignal) => {
    const current = { ...options, signal };
    signal.throwIfAborted();
    if (current.codexPolicy)
      return runNativeCodexWorker(job, {
        ...current,
        codexPolicy: current.codexPolicy,
        // Codex has no job-wide allow; any allow is for this call only.
        permission: async (tool, input, signal) =>
          (await current.permission(tool, input, signal)) !== false,
      });
    assertClaudeWorkerMode(job.decision.claudePermissionMode, current.claudePermissionMode);
    if (!current.currentClaudePermissionMode)
      throw new Error('Owned Claude mode observer is unavailable');
    assertClaudeWorkerMode(
      job.decision.claudePermissionMode,
      current.currentClaudePermissionMode(),
    );
    const agentType = String(job.native.subagent_type ?? 'general-purpose');
    const binary = await qualifiedModelWorker(
      job.root,
      agentType,
      undefined,
      current.dataDir,
      signal,
      current.claudePermissionMode,
    );
    // A custom agent runs from its definition as read here, never from a name alone.
    const custom = WORKER_BUILTIN_AGENTS.has(agentType)
      ? null
      : await workerAgent(agentType, { root: job.root, homeDir: homedir() });
    if (custom && !('agent' in custom))
      throw new Error('Custom agent definition is unavailable or changed; keep native');
    const customAgent = custom?.agent;
    signal.throwIfAborted();
    assertClaudeWorkerMode(
      job.decision.claudePermissionMode,
      current.currentClaudePermissionMode(),
    );
    if (!binary) throw new Error('Claude Code worker is unavailable; keep native');
    if (binary.windows?.fingerprint !== job.decision.windowsWorker)
      throw new Error('The Windows worker profile changed; keep native');
    const saved = savedClaudeWorkspace(job.decision.claudeWorkspace);
    if (!saved || !binary.claudeWorkspace || !sameClaudeWorkspace(saved, binary.claudeWorkspace))
      throw new Error('Owned Claude workspace scope changed or is unavailable');
    return runQualifiedWorker(job, current, { ...binary, customAgent }, options.early);
  };
  return withWorkerDeadline(options.signal, run, options.early?.accept);
}

async function runQualifiedWorker(
  job: ModelJob,
  options: Parameters<typeof runModelWorker>[1],
  binary: {
    path: string;
    claudeWorkspace?: ClaudeWorkspace;
    customAgent?: WorkerAgent;
    windows?: WindowsWorkerLaunch;
  },
  early?: EarlyWorkerInput,
) {
  // A worker started at offer time sends nothing until its accept releases it.
  let released = !early;
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
  const settingsEnv = new SettingsEnvValues();
  const assertCurrentWorkspace = async () => {
    if (!claudeWorkerAuthCompatible(process.env))
      throw new Error('Native Claude authentication is owned by its host; keep native');
    const disclosure = await modelSettings(options.dataDir, job.root);
    const windows = binary.windows ? await windowsWorkerLaunch(options.dataDir, job.root) : null;
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
      !(binary.windows
        ? windows?.fingerprint === binary.windows.fingerprint &&
          windows.routerOrigin === disclosure?.routerOrigin &&
          windows.routerOrigin === options.transport.origin &&
          nativeWindowsShellPolicy(resolved)
        : claudeWorkerSandboxCompatible([job.root, current.root], resolved)) ||
      !sameClaudeWorkspace(workspace, current)
    )
      throw new Error('Owned Claude workspace scope changed or disclosure was revoked');
    // Checked before each tool call and request, so a value added mid-job is known too.
    settingsEnv.add(resolved.effective.env);
    return { resolved, disclosure };
  };
  const session = await prepareClaudeWorkerSession(options.claudeSession, job.root);
  const worktrees = await claudeWorkspaceWorktrees(workspace);
  const protectedRoots = [
    ...new Set([
      ...workspace.workingDirectories,
      ...workspace.readExceptions,
      ...workspace.writeExceptions,
    ]),
  ];
  // Before the native init timer starts: `gh auth token` may wait on the keychain. A setup
  // failure leaves the worker without GitHub access, never without its job.
  const github: WorkerGithub | undefined = binary.windows
    ? undefined
    : await prepareWorkerGithub(process.env).catch(() => undefined);
  // The job's GitHub env: its token or none, and with a token named for workers the
  // session's own cleared, also when the setup failed.
  const githubEnv = binary.windows ? {} : (github?.env ?? sessionTokenClears(process.env));
  // Literal GitHub token values; the bridge removes them before anything leaves.
  let secrets: readonly string[] = github?.secrets ?? workerTokenValues(process.env);
  const token = randomBytes(32).toString('hex');
  // Also before the timer: the worker reads its env files as a native subagent does, and
  // their values are replaced in everything that leaves this process. A scan that stops
  // short keeps every env file denied.
  // The job's own temp folder, as a native session has its scratchpad. Without one the
  // worker uses the shared temp root, as before. Made before the scan: it is a working
  // directory too, so an env file a command writes there has its values replaced as well.
  const temp = await prepareClaudeWorkerTemp().catch(() => undefined);
  const envFiles = await WorkerEnvSecrets.start([
    ...workspace.workingDirectories,
    ...worktrees,
    ...(temp ? [temp.directory, temp.scratchpad] : []),
  ]);
  const envDenied = new Set(
    envDeniedRoots(
      protectedRoots,
      [...workspace.workingDirectories, ...worktrees],
      envFiles.scanned,
    ),
  );
  // A repository's `.claude/settings.json` stays closed to reads where the scan did not
  // cover its root, or where no recursive watcher would learn one made during the job.
  const settingsClosed = (root: string) => envDenied.has(root) || !envFiles.watching;
  const redactEnv = (text: string) => envFiles.redact(settingsEnv.redact(text));
  const redactAll = (text: string) => redactEnv(redactWorkerSecrets(text, [token, ...secrets]));
  // The user's settings files the worker may read, set at start.
  let settingsFiles: readonly string[] = [];
  // A value found late is also removed from activity rows made before it was known.
  let envValues = envFiles.size;
  const refreshEnv = async () => {
    await envFiles.refresh();
    // A settings file the worker may read is read again, so a value added since is
    // known. One that no longer parses has unknown values: nothing more leaves.
    for (const path of settingsFiles) {
      const env = await settingsFileEnv(path);
      if (env === undefined) throw new Error('A Claude settings file could not be read');
      settingsEnv.add(env);
    }
    if (envFiles.size + settingsEnv.size === envValues) return;
    envValues = envFiles.size + settingsEnv.size;
    try {
      options.activity?.rescrub?.(redactAll);
    } catch {
      // Display only.
    }
  };
  try {
    options.signal.throwIfAborted();
    assertCurrentMode();
    if (
      binary.windows &&
      (!envFiles.scanned || envFiles.withheld.length || envFiles.unlisted.length)
    )
      throw new Error('Cannot cover workspace env files before starting the Windows worker');
  } catch (error) {
    envFiles.close();
    await github?.close().catch(() => undefined);
    await temp?.close().catch(() => undefined);
    throw error;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  // The worker's settings carry the bridge token and the job's GitHub env: in a private
  // file, never on its command line.
  const nativeProcess = claudeWorkerProcess({
    secrets: () => [token, ...secrets],
    windows: binary.windows,
  });
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
  // What a native subagent of this type gets, read from this Claude Code before it starts.
  let nativeAgent: NativeAgentPrompt | undefined;
  async function* prompt(): AsyncGenerator<SDKUserMessage> {
    if (!(await authenticationReady)) return;
    controller.signal.throwIfAborted();
    // A native subagent gets its git status with its task, once, when it starts.
    const context = session?.query.resume === undefined ? (nativeAgent?.context ?? []) : [];
    yield {
      type: 'user',
      session_id: '',
      message: {
        role: 'user',
        content: [...context, job.task].map((text) => ({ type: 'text' as const, text })),
      },
      parent_tool_use_id: null,
    };
  }
  const denyInitialization = () => initialized(false);
  controller.signal.addEventListener('abort', denyInitialization, { once: true });
  // No start-up window, as for a native subagent: a loaded machine starts Claude Code
  // slowly, and a missed start leaves the routing fee paid. The job's wall time and a
  // cancel bound the start.
  let started = false;
  const initTimer =
    options.startupMs === undefined
      ? undefined
      : setTimeout(() => {
          initialized(false);
          controller.abort(
            new ModelWorkerStopped({ kind: 'not_started', reason: 'startup_timeout' }),
          );
          worker?.close();
        }, options.startupMs);
  initTimer?.unref();
  // The worker's web searches, and a page its WebFetch could not fetch, paid as Tenjin
  // tool calls from the person's wallet and counted in this job's budget.
  const web: WorkerWebDeps = {
    job,
    transport: options.transport,
    dataDir: options.dataDir,
    ...(options.web ? { request: options.web } : {}),
    ...(options.webIdentities ? { identities: options.webIdentities } : {}),
    signal: controller.signal,
  };
  // The viewer names a call a router tool served by that tool, as the router's rows do: a
  // WebSearch is always Exa search here, a WebFetch only when Exa page read stood in.
  const served = (id: unknown, via: string, bytes?: number) => {
    try {
      if (typeof id === 'string')
        options.activity?.served?.(
          id,
          via,
          bytes === undefined ? undefined : { bytes, code: 200, codeText: 'OK' },
        );
    } catch {
      // Display only.
    }
  };
  const fetchFallback = async (event: WorkerFetchEvent, id: unknown) =>
    !released || controller.signal.aborted
      ? null
      : workerFetchFallback(event, {
          ...web,
          redact: redactAll,
          onRead: (bytes) => served(id, WORKER_PAGE_READ_LABEL, bytes),
        });
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
        // Before the accept nothing goes to Tenjin or DeepSeek: a request is refused here.
        if (!released) {
          res.writeHead(503, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              type: 'error',
              error: { type: 'overloaded_error', message: 'The DeepSeek job is not accepted yet' },
            }),
          );
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
          if (size > 8 * 1024 * 1024) throw new UnsupportedRequest('the request is too large');
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        // What leaves for the model: built for the request, and built again before each retry
        // with the checks every request passes (the workspace and mode checks are above).
        const outgoing = async () => {
          // An env file a command just wrote, or a settings file the person just changed, is
          // read before this request leaves.
          await refreshEnv();
          // One that cannot be read in full cannot be replaced, and the worker's denies
          // are fixed at start: nothing more leaves this job.
          if (envFiles.uncovered.size)
            throw new ModelWorkerStopped({
              kind: 'execution_failure',
              reason: 'env_file_unscanned',
            });
          // Env values may need JSON escapes, so they are replaced in the parsed strings.
          const text = withholdDroppedDirectories(
            redactWorkerSecrets(body, [token, ...secrets]),
            workspace.droppedDirectories,
          );
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new UnsupportedRequest('the request is not JSON');
          }
          return redactWorkerMessage(parsed, redactEnv) as Record<string, unknown>;
        };
        const raw = await outgoing();
        const send = (message: unknown) => {
          if (raw.stream === true)
            res
              .writeHead(200, { 'content-type': 'text/event-stream' })
              .end(completedMessageSse(message));
          else
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(message));
        };
        // A worker's WebSearch: answered here, never sent on to the model.
        const search = workerWebSearch(raw);
        if (search) {
          send(await answerWorkerWebSearch(search, web));
          return;
        }
        let messages: ReturnType<typeof workerMessages>;
        try {
          messages = workerMessages(raw);
          diagnostics.mark('firstRequest');
          diagnostics.request(raw);
        } catch (error) {
          // The router would refuse it, and every call after it that offers as many.
          if (error instanceof TooManyTools)
            throw new UnsupportedRequest(
              `it offers ${error.count} tools, more than the ${MODEL_MESSAGES_MAX_TOOLS} one request may carry`,
            );
          throw new UnsupportedRequest('the request has a field or tool the bridge does not send');
        }
        assertCurrentMode();
        // A model call that returned no result ends the job with its cause in fixed codes
        // (the router's status, a timeout, the ceiling), not as an error nobody can read.
        // A call the router confirms cost nothing is tried again for a transient failure,
        // as the DeepSeek harness does (`withModelRetry`); any other failure ends the job.
        // A RETRY IS A NEW SEND: it waits, so it passes again every check this request did
        // (consent and the workspace, the mode, a cancel, env files and their values).
        let attempts = 0;
        const message = await withModelRetry(
          async () => {
            if (attempts++ > 0) {
              await assertCurrentWorkspace();
              assertCurrentMode();
              if (controller.signal.aborted)
                throw new Error('Model consent revoked or job cancelled');
              messages = workerMessages(await outgoing());
            }
            return options.transport.messages(job, messages, controller.signal);
          },
          controller.signal,
          (attempt, failure) => diagnostics.retry(attempt, failure.detail),
          options.retryWait,
        ).catch((error: unknown) => {
          throw controller.signal.aborted ? error : modelCallStop(error);
        });
        diagnostics.mark('firstAnswer');
        send(message);
      } catch (error) {
        // ONE REQUEST THE BRIDGE CANNOT SEND fails alone, as a provider's 400 does: nothing
        // was sent on or paid, and the native tool that asked for it reports the error.
        if (error instanceof UnsupportedRequest) {
          if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
          if (!res.destroyed)
            res.end(
              JSON.stringify({
                type: 'error',
                error: {
                  type: 'invalid_request_error',
                  message: `Tenjin's worker bridge did not send this request: ${error.message}. Nothing was charged.`,
                },
              }),
            );
          return;
        }
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
  // Auto and bypass workers never wait on a person; the sandbox and the secrets boundary still apply.
  const nobodyAsked = permissionMode === 'auto' || permissionMode === 'bypassPermissions';
  const repeats = new WorkerRepeatReminder();
  const diagnostics = new WorkerDiagnosticsRecord(
    job.root,
    CLAUDE_DEEPSEEK_COMPACT_WINDOW,
    MODEL_OUTPUT_TOKENS,
  );
  if (options.accepted && !early) diagnostics.accepted(options.accepted.at, options.accepted.marks);
  const repeated = (tool: string, input: unknown) => {
    const reminder = repeats.observe(tool, input);
    diagnostics.repeat(tool, reminder);
    return reminder;
  };
  // Calls a person allowed for the rest of this job; never persisted.
  const allowedForJob = new Set<string>();
  try {
    await new Promise<void>((resolve, reject) => {
      bridge.once('error', reject);
      bridge.listen(0, '127.0.0.1', resolve);
    });
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('Worker bridge failed');
    const env = claudeDeepSeekWorkerEnv(process.env, `http://127.0.0.1:${address.port}`, token);
    const { resolved, disclosure } = await assertCurrentWorkspace();
    const privatePaths = await claudeWorkerPrivatePaths(
      options.dataDir,
      job.root,
      process.env,
      resolved.effective.env,
      {
        sources: resolved.sources,
        workingDirectories: [...workspace.workingDirectories, ...worktrees],
      },
    );
    // Known before the worker starts, so a first read of a settings file is replaced too.
    for (const values of privatePaths.settingsEnv) settingsEnv.add(values);
    settingsFiles = privatePaths.settingsFiles;
    // A GitHub token in the person's settings env reaches the worker's commands too.
    secrets = [...new Set([...secrets, ...workerTokenValues(resolved.effective.env ?? {})])];
    const dropped = workspace.droppedDirectories;
    if (
      !claudeManagedProviderCompatible(resolved) ||
      (permissionMode === 'auto' &&
        resolved.effective.permissions?.disableAutoMode === 'disable') ||
      (permissionMode === 'bypassPermissions' &&
        resolved.effective.permissions?.disableBypassPermissionsMode === 'disable')
    )
      throw new Error('Managed Claude worker policy changed; keep native');
    const agentType = String(job.native.subagent_type ?? 'general-purpose');
    // The temp folder is a working directory, so the file tools take its literal paths.
    const additionalDirectories = [
      ...workspace.workingDirectories.slice(1),
      ...worktrees,
      ...(temp ? [temp.directory] : []),
    ];
    const agentInput = {
      binary: binary.path,
      cwd: job.root,
      additionalDirectories: additionalDirectories.filter((dir) => dir !== temp?.directory),
      agentType,
      ...(binary.windows ? { windows: binary.windows } : {}),
      ...(binary.customAgent ? { customAgent: binary.customAgent } : {}),
    };
    const startSettings = ({
      resolved,
      disclosure,
    }: Awaited<ReturnType<typeof assertCurrentWorkspace>>) =>
      JSON.stringify([
        resolved.effective,
        resolved.sources,
        disclosure && { ...disclosure, maxJobAtomic: disclosure.maxJobAtomic?.toString() },
      ]);
    const offeredSettings = early ? startSettings({ resolved, disclosure }) : undefined;
    const offeredAgent = early ? await nativeAgentStartKey(agentInput) : undefined;
    try {
      nativeAgent = await readNativeAgentPromptCached({
        ...agentInput,
        additionalDirectories,
        ...(temp ? { ephemeralDirectories: [temp.directory] } : {}),
        signal: controller.signal,
      });
      diagnostics.mark('promptRead');
    } catch (error) {
      if (controller.signal.aborted) throw error;
      // The worker still starts, with Claude Code's main prompt and the subagent note.
      (options.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
        `tenjin: the DeepSeek worker starts with Claude Code's main prompt: the ${agentType} subagent prompt could not be read (${error instanceof NativeAgentPromptUnavailable ? error.reason : 'read_failed'})`,
      );
    }
    assertCurrentMode();
    options.signal.throwIfAborted();
    diagnostics.mark('childSpawned');
    worker = query({
      prompt: prompt(),
      options: {
        pathToClaudeCodeExecutable: binary.path,
        spawnClaudeCodeProcess: nativeProcess.spawn,
        cwd: job.root,
        additionalDirectories,
        env: {
          ...env,
          // Sandboxed commands reach the network only through the sandbox proxy; Node's
          // fetch ignores the proxy variables unless told, and fails DNS instead.
          NODE_USE_ENV_PROXY: '1',
          ...githubEnv,
          TENJIN_WORKER_GITHUB_TOKEN: undefined,
          TENJIN_WORKER_GITHUB_TOKEN_FILE: undefined,
          ...(temp ? { CLAUDE_CODE_TMPDIR: temp.directory } : {}),
        },
        // The prompt Claude Code gives a native subagent of this type, as it built it above.
        // Claude Code still adds the environment, the person's CLAUDE.md files and the
        // skills to each request itself.
        systemPrompt: nativeAgent
          ? {
              type: 'custom',
              prompt: [...nativeAgent.prompt, ...(temp ? [workerTempNote(temp.scratchpad)] : [])],
            }
          : {
              type: 'preset',
              preset: 'claude_code',
              append: [
                NATIVE_SUBAGENT_NOTE,
                ...(temp ? [workerTempNote(temp.scratchpad)] : []),
              ].join('\n\n'),
            },
        model: CLAUDE_DEEPSEEK_WORKER_MODEL,
        // The native agent the parent asked for, with that agent's own tools.
        agent: agentType,
        ...(binary.customAgent ? { agents: { [agentType]: binary.customAgent } } : {}),
        effort: 'high',
        abortController: controller,
        permissionMode,
        ...session?.query,
        settingSources: ['user', 'project', 'local'],
        // The flag settings hold the bridge token and the job's GitHub env: written first to
        // a private file, so the SDK's arguments and its debug log name only the file.
        settings: nativeProcess.settingsFile({
          // Auto memory is undeclared input outside this job's disclosure scope.
          // Native settings, instruction files and owned session history still load.
          autoMemoryEnabled: false,
          // The CLAUDE.md files a native subagent of this type starts without (all of them
          // for `Explore`). Claude Code puts them in a main thread's first request, which
          // the worker is, whatever its agent says.
          ...(nativeAgent?.withheldInstructions.length
            ? { claudeMdExcludes: instructionExcludes(nativeAgent.withheldInstructions) }
            : {}),
          ...(!binary.windows ? { apiKeyHelper: claudeDeepSeekWorkerApiKeyHelper() } : {}),
          env: {
            ...claudeDeepSeekWorkerSettingsEnv(`http://127.0.0.1:${address.port}`, token),
            // Above a GitHub token in the person's settings env, which Claude Code would
            // otherwise hand the worker's commands in place of the job's own, or of none.
            ...githubEnv,
            TENJIN_WORKER_GITHUB_TOKEN: '',
            TENJIN_WORKER_GITHUB_TOKEN_FILE: '',
            // Above a value in the person's settings, which would move the temp root back.
            ...(temp ? { CLAUDE_CODE_TMPDIR: temp.directory } : {}),
          },
          permissions: {
            blockReadsOutsideWorkingDirectories: true,
            blockWritesOutsideWorkingDirectories: true,
            workingDirectoriesAsGiven: [
              ...new Set([
                ...workspace.workingDirectorySpellings,
                ...worktrees,
                ...(temp ? [temp.directory] : []),
              ]),
            ].sort(),
            // Session history and the user's settings, as a native subagent reads them.
            blockReadsExemptPaths: [...workspace.readExceptions, ...privatePaths.readable],
            // The read block still asks about a command that names one of them, and in auto
            // and bypass mode nobody can answer: a Read rule lifts that ask, and the mode
            // still judges the command. Default mode keeps the native asks.
            ...(nobodyAsked
              ? {
                  allow: privatePaths.readable.flatMap((path) => {
                    const absolute = `//${path.replaceAll('\\', '/').replace(/^\/+/, '')}`;
                    return [`Read(${absolute})`, `Read(${absolute}/**)`];
                  }),
                }
              : {}),
            deny: [
              ...privatePaths.deny,
              ...protectedRoots.flatMap((root) => {
                const absolute = `//${root.replaceAll('\\', '/').replace(/^\/+/, '')}`;
                const patterns = [
                  // Inside the working directories env files are the native defaults' to
                  // judge; their values never leave. Outside them they stay private.
                  ...(envDenied.has(root)
                    ? [
                        `${absolute}/.env*`,
                        `${absolute}/**/.env*`,
                        ...(basename(root).startsWith('.env') ? [absolute] : []),
                      ]
                    : []),
                  // A consented workspace holds other repositories' native settings too.
                  ...NESTED_PRIVATE.map((name) => `${absolute}/**/${name}`),
                ];
                return [
                  ...['Read', 'Edit', 'Write'].flatMap((tool) =>
                    patterns.map((pattern) => `${tool}(${pattern})`),
                  ),
                  // A repository's `.claude/settings.json` is read as a native subagent reads
                  // it where the env scan covered it and a watcher learns one made during the
                  // job (no recursive watcher on Linux): its env values are known, and one
                  // that could not be parsed is denied by its path below. It is never written.
                  ...(settingsClosed(root) ? ['Read', 'Edit', 'Write'] : ['Edit', 'Write']).map(
                    (tool) => `${tool}(${absolute}/**/${NESTED_SETTINGS})`,
                  ),
                ];
              }),
              // An env or settings file that could not be read in full at start cannot be redacted.
              ...envFiles.withheld.flatMap((path) => {
                const absolute = `//${path.replaceAll('\\', '/').replace(/^\/+/, '')}`;
                return ['Read', 'Edit', 'Write'].map((tool) => `${tool}(${absolute})`);
              }),
              // Nor can one in a folder the scan could not list, whatever its name.
              ...envFiles.unlisted.flatMap((path) => {
                const absolute = `//${path.replaceAll('\\', '/').replace(/^\/+/, '')}`;
                return ['Read', 'Edit', 'Write'].flatMap((tool) => [
                  `${tool}(${absolute}/.env*)`,
                  `${tool}(${absolute}/**/.env*)`,
                  `${tool}(${absolute}/**/${NESTED_SETTINGS})`,
                ]);
              }),
              // Native settings still add these; the worker may not use them.
              ...dropped.flatMap((path) => {
                const absolute = `//${path.replaceAll('\\', '/').replace(/^\/+/, '')}`;
                return ['Read', 'Edit', 'Write'].flatMap((tool) => [
                  `${tool}(${absolute})`,
                  `${tool}(${absolute}/**)`,
                ]);
              }),
            ],
          },
          // Here, as the SDK would merge its own `sandbox` option, which it refuses beside a
          // settings file.
          ...(!binary.windows
            ? {
                sandbox: {
                  enabled: true,
                  allowUnsandboxedCommands: false,
                  failIfUnavailable: true,
                  // Other hosts ask in default mode and are denied where no one answers.
                  network: { allowedDomains: [...WORKER_ALLOWED_DOMAINS] },
                  // gh is a Go program: on macOS it verifies TLS through the trust service only.
                  ...(github?.authenticated && process.platform === 'darwin'
                    ? { enableWeakerNetworkIsolation: true }
                    : {}),
                  filesystem: {
                    allowRead: [...(github ? [github.directory] : []), ...privatePaths.readable],
                    ...(github ? { allowWrite: [github.directory] } : {}),
                    denyRead: [
                      ...privatePaths.paths,
                      ...protectedRoots.flatMap((root) => [
                        ...(envDenied.has(root)
                          ? [
                              `${root}/.env*`,
                              `${root}/**/.env*`,
                              ...(basename(root).startsWith('.env') ? [root] : []),
                            ]
                          : []),
                        ...NESTED_PRIVATE.map((name) => `${root}/**/${name}`),
                        ...(settingsClosed(root) ? [`${root}/**/${NESTED_SETTINGS}`] : []),
                      ]),
                      ...envFiles.withheld,
                      // Commands cannot read inside a folder the scan could not list.
                      ...envFiles.unlisted,
                      ...dropped,
                      // Other sessions' temp files; this job's own are in its temp folder.
                      ...(temp?.shared ?? []),
                    ],
                    denyWrite: [...privatePaths.paths, ...privatePaths.readable, ...dropped],
                  },
                },
              }
            : {}),
        }),
        // Direct callers remain ephemeral; only the owned controller may retain
        // and reopen a session. Native retention/config discovery are unchanged.
        persistSession: session !== undefined,
        // No turn cap (operator ruling 2026-11-17, as the DeepSeek harness has none): the
        // job's wall time and money ceiling bound a run.
        disallowedTools: [
          'Agent',
          'Task',
          'mcp__plugin_tenjin_router__subagent',
          'mcp__plugin_tenjin_router__request',
          'mcp__plugin_tenjin_router__approve',
          // A native subagent has no question tool in any mode; it ends with its report.
          'AskUserQuestion',
          // Nor the main thread's own tools, such as scheduling a wake-up.
          ...(nativeAgent?.withheldTools ?? []),
        ],
        // Auto mode: the native classifier judges each call that needs a decision.
        // Auto and bypass: a call that would still prompt is answered at once below,
        // by `worker-unattended`. No call waits for a person.
        ...(permissionMode === 'bypassPermissions'
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (input) => {
                  if (!released)
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: 'The DeepSeek job has not been accepted.',
                      },
                    };
                  // An env file read by name is known before its content can be forwarded.
                  if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Read')
                    await envFiles
                      .add((input.tool_input as { file_path?: unknown } | undefined)?.file_path)
                      .catch(() => undefined);
                  // The secrets boundary: a credential probe is refused in every mode.
                  // Every other call is the accepted mode's to judge.
                  const probe =
                    input.hook_event_name === 'PreToolUse'
                      ? workerCredentialProbe(input.tool_name, input.tool_input)
                      : undefined;
                  if (probe)
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: `${probe} This call was not run.`,
                      },
                    };
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
                  if (input.tool_name === 'WebSearch')
                    served(input.tool_use_id, WORKER_SEARCH_LABEL);
                  const context = [
                    repeated(input.tool_name, input.tool_input),
                    input.tool_name === 'WebFetch'
                      ? await fetchFallback(
                          { input: input.tool_input, response: input.tool_response },
                          input.tool_use_id,
                        )
                      : null,
                  ].filter((text) => typeof text === 'string');
                  return context.length
                    ? {
                        hookSpecificOutput: {
                          hookEventName: 'PostToolUse',
                          additionalContext: context.join('\n\n'),
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
                  if (input.tool_name === 'WebSearch')
                    served(input.tool_use_id, WORKER_SEARCH_LABEL);
                  const context = [
                    repeated(input.tool_name, input.tool_input),
                    input.tool_name === 'WebFetch' && input.is_interrupt !== true
                      ? await fetchFallback(
                          { input: input.tool_input, error: input.error },
                          input.tool_use_id,
                        )
                      : null,
                  ].filter((text) => typeof text === 'string');
                  return context.length
                    ? {
                        hookSpecificOutput: {
                          hookEventName: 'PostToolUseFailure',
                          additionalContext: context.join('\n\n'),
                        },
                      }
                    : {};
                },
              ],
            },
          ],
        },
        canUseTool: async (
          tool: string,
          input: Record<string, unknown>,
          context: {
            signal: AbortSignal;
            suggestions?: PermissionUpdate[];
            suppressAlwaysAllowRule?: boolean;
            title?: string;
            description?: string;
          } & WorkerAsk,
        ) => {
          if (!released)
            return { behavior: 'deny', message: 'The DeepSeek job has not been accepted.' };
          assertCurrentMode();
          if (nobodyAsked)
            return !binary.windows && sandboxJudgesRead(tool, input, context, permissionMode)
              ? { behavior: 'allow', updatedInput: input }
              : {
                  behavior: 'deny',
                  message: unattendedDenial(context, readBlockUnchecked(tool, input, context)),
                };
          if (permissionMode === 'dontAsk')
            return {
              behavior: 'deny',
              message: 'Inherited dontAsk mode does not authorize a prompt',
            };
          const key = JSON.stringify([tool, input]);
          if (allowedForJob.has(key)) return { behavior: 'allow', updatedInput: input };
          const allowed = await options.permission(tool, input, context.signal, {
            ...(context.title ? { title: context.title } : {}),
            ...(context.description ? { description: context.description } : {}),
            ...(context.decisionReason ? { reason: context.decisionReason } : {}),
          });
          assertCurrentMode();
          if (allowed === 'job') {
            allowedForJob.add(key);
            const rules = context.suppressAlwaysAllowRule
              ? []
              : jobScopedRules(context.suggestions);
            return {
              behavior: 'allow',
              updatedInput: input,
              ...(rules.length ? { updatedPermissions: rules } : {}),
            };
          }
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
    const stoppedBeforeAssignment = early
      ? Promise.race([
          authenticationStopped,
          nativeProcess.exited.then(() => {
            throw new Error('The warm Claude worker exited before its assignment');
          }),
        ])
      : authenticationStopped;
    try {
      // accountInfo is the maintained SDK initialize response, before a task is
      // sent. A saved gateway can override env/helper auth without an env flag.
      const account = await Promise.race([worker.accountInfo(), stoppedBeforeAssignment]);
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
      if (early) {
        // SDK initialization can finish before an assignment is sent. Release inference
        // only after the accept path has won the job and this child still fits its scope.
        diagnostics.mark('earlyReady');
        const accept = await Promise.race([early.accept, stoppedBeforeAssignment]);
        assertCurrentMode();
        // Without a recursive watcher, refresh() cannot discover a new env file in a
        // previously empty nested directory. Start fresh if its fixed denies need to change.
        if (
          (!envFiles.watching || binary.windows) &&
          !(await Promise.race([envFiles.refreshBeforeAssignment(), stoppedBeforeAssignment]))
        )
          throw new Error("The warm Claude worker's env file restrictions changed");
        const current = await assertCurrentWorkspace();
        const selected = await readWorkerClaudeCode(job.root, binary.windows);
        const custom = WORKER_BUILTIN_AGENTS.has(agentType)
          ? null
          : await workerAgent(agentType, { root: job.root, homeDir: homedir() });
        const directories = [
          ...workspace.workingDirectories.slice(1),
          ...(await claudeWorkspaceWorktrees(workspace)),
        ];
        const agent =
          selected.binary && (!custom || 'agent' in custom)
            ? await nativeAgentStartKey({
                ...agentInput,
                binary: selected.binary.path,
                additionalDirectories: directories,
                customAgent: custom?.agent,
              })
            : null;
        if (
          !offeredAgent ||
          agent !== offeredAgent ||
          startSettings(current) !== offeredSettings ||
          (WORKER_BUILTIN_AGENTS.has(agentType) &&
            (await findDefinition(agentType, { cwd: job.root, homeDir: homedir() })) !== null)
        )
          throw new Error('The warm Claude worker no longer matches the accepted job');
        controller.signal.throwIfAborted();
        if (nativeProcess.hasExited())
          throw new Error('The warm Claude worker exited before its assignment');
        assertCurrentMode();
        job = accept.job;
        web.job = accept.job;
        web.transport = options.transport = accept.transport;
        options.permission = accept.permission;
        options.activity = accept.activity;
        options.currentClaudePermissionMode = accept.currentClaudePermissionMode;
        if (accept.accepted) diagnostics.accepted(accept.accepted.at, accept.accepted.marks);
        early.onRelease();
        released = true;
      }
      authorizePrompt(true);
    } finally {
      controller.signal.removeEventListener('abort', stopAuthentication);
    }
    let activityReady = false;
    for await (const message of worker) {
      if (message.type === 'assistant') diagnostics.mark('firstActivity');
      if (message.type === 'system' && message.subtype === 'init') {
        diagnostics.mark('childReady');
        diagnostics.init(message);
        // The plugin's `SessionStart` entry (`tenjin hook alive`) marks a session it serves,
        // and the mod skips that event in a worker as a native subagent has none: the
        // worker's session is marked here instead, so an older settings install's legs stay
        // silent in it as before.
        await markSessionServed(options.dataDir, { session_id: message.session_id });
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
        started = true;
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
          // Rows reach the progress file, the viewer and a partial handback: drop the job's
          // token and env values first, including an env file a tool just wrote.
          if (message.type === 'user') await refreshEnv();
          if (!envFiles.uncovered.size)
            options.activity?.observe(redactWorkerMessage(message, redactAll));
        } catch {
          // The SDK remains the owner of complete worker history.
        }
      }
      if (message.type === 'result') {
        diagnostics.stop(message);
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
      const stopNow = !released || options.signal.aborted;
      // Signal the whole group without waiting on the SDK's iterator when interrupted.
      const returned = Promise.resolve()
        .then(async () => {
          await worker?.return?.();
          return undefined;
        })
        .catch((error: unknown) => ({ error }));
      const drained = await nativeProcess.drain({ now: stopNow });
      const cleanupFailure = stopNow ? undefined : await returned;
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
    if (released) await diagnostics.write(options.dataDir, job.id);
    await github?.close().catch(() => undefined);
    await temp?.close().catch(() => undefined);
    // Last look, so the result and a stopped worker's partial lose a late value too.
    await refreshEnv().catch(() => undefined);
    envFiles.close();
  }
  if (early && !released && closeFailure?.quiescent === false)
    throw new WorkerStartUnconfirmed('Warm Claude worker cleanup could not be confirmed', {
      cause: closeFailure.error,
    });
  if (closeFailure && (!executionFailure || !closeFailure.quiescent)) throw closeFailure.error;
  // A child that never started reports that, whatever the SDK threw on the way out,
  // also when the job's wall time is what ended the wait.
  const stop = workerStop(controller.signal.reason);
  if (stop?.kind === 'not_started' || (!started && stop?.reason === 'wall_time'))
    throw new ModelWorkerStopped({ kind: 'not_started', reason: 'startup_timeout' });
  if (executionFailure) throw executionFailure.error;
  return redactAll(result!);
}

/** Native local settings and MCP config of repositories nested in a worker root: closed. */
const NESTED_PRIVATE = ['.claude/settings.local.json', '.mcp.json'];
/**
 * A repository's shared settings, at any depth: readable where the env scan covered its
 * folder, which learns its env values, and never written by the file tools. A working
 * directory's own copy is in the sandbox's write denies too, so a merge or checkout that
 * must rewrite it fails at that write, as a native sandboxed command does before it asks
 * to run unsandboxed, which a worker's command cannot.
 */
const NESTED_SETTINGS = '.claude/settings.json';

/** A worker request the bridge refuses before anything is sent on or paid; the message
 *  is fixed text, never the request's content. */
class UnsupportedRequest extends Error {}
