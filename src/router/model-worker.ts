import { WorkerInbox } from './model-worker-inbox';
import {
  completedMessageSse,
  searchRefusedMessage,
  TooManyTools,
  workerMessages,
  workerSearchMessages,
} from './model-messages';
import { RelayedCut, sseError, sseFrame, type StreamEvent } from './model-stream';
import { WorkerDiagnosticsRecord, type ModelCallTiming } from './model-worker-diagnostics';
import type { Identities } from './identities';
import {
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
import { dirname } from 'node:path';
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
import { readClaudeCodeCached, meetsFloor } from './claude-cli';
import { markSessionServed } from './alive';
import { modelSettings, providerOf, type WorkerProvider } from './model-settings';
import { CLAUDE_TENJIN_TOOLS } from './names';
import {
  MODEL_MESSAGES_MAX_TOOLS,
  MODEL_NATIVE_TEXT_BYTES,
  compactWindowTokens,
  offeredOutputTokens,
} from './model-limits';
import type { ModelJob } from './model-job';
import type { WorkerTransport } from './model-transport';
import {
  assertClaudeWorkerMode,
  claudeDeepSeekWorkerApiKeyHelper,
  claudeDeepSeekWorkerEnv,
  claudeDeepSeekWorkerSettingsEnv,
  claudeManagedProviderCompatible,
  claudeMcpProviderCompatible,
  claudeWorkerAuthCompatible,
  CLAUDE_DEEPSEEK_WORKER_MODEL,
  CLAUDE_WORKER_THINKING_ENV,
  type ClaudeWorkerPermissionMode,
} from './claude-model-policy';
import {
  claudeWorkerPrivatePaths,
  jobTempPatterns,
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
  redactGithubTokenShapes,
  redactWorkerJson,
  redactWorkerMessage,
  redactWorkerSecrets,
  sessionTokenClears,
  settingsFileWalletValues,
  WORKER_ALLOWED_DOMAINS,
  workerGithubPatterns,
  workerTokenValues,
  workerWalletValues,
  type WorkerGithub,
} from './worker-github';
import {
  ModelCallFailed,
  MODEL_REFUSED_CODE,
  modelCallStop,
  withModelRetry,
  ModelWorkerStopped,
  WorkerRepeatReminder,
  workerResultError,
  workerStop,
} from './model-worker-control';

type QualifiedWorker = {
  path: string;
  source?: string;
  claudeWorkspace?: ClaudeWorkspace;
  windows?: WindowsWorkerLaunch;
  customAgent?: WorkerAgent;
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
  dataDir?: string,
  signal?: AbortSignal,
  claudePermissionMode?: ClaudeWorkerPermissionMode,
  /** The provider whose consent covers the worker: Neon has its own record. */
  provider: WorkerProvider = 'deepseek',
): Promise<QualifiedWorker | null> {
  if (!dataDir) return null;
  if (!claudeWorkerAuthCompatible(process.env)) return null;
  const windows = await windowsWorkerLaunch(dataDir, cwd);
  if (process.platform === 'win32' && !windows) return null;
  // The Windows worker's account is set up against Tenjin's router: the Neon worker has none.
  if (provider === 'neon' && windows) return null;
  // Read at every offer and again at its accept: once per binary file, not per call.
  const state = await readWorkerClaudeCode(cwd, windows ?? undefined);
  if (!state.binary || !state.version || !meetsFloor(state.version, '2.1.325')) return null;
  const builtin = WORKER_BUILTIN_AGENTS.has(agentType);
  if (!builtin && !isCustomAgentType(agentType)) return null;
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
  const disclosure = await modelSettings(dataDir, cwd, provider);
  const claudeWorkspace =
    disclosure &&
    (await resolveClaudeWorkspace(
      cwd,
      effective,
      disclosure.scope === 'native-workspace' ? disclosure.scope : disclosure.repositories,
    ));
  if (
    !claudeWorkspace ||
    // THE WINDOWS WORKER HAS NO SHELL SANDBOX and runs as another account, which was given
    // the directories the person named at that opt-in: the limited scope is the only one
    // it runs under.
    !(windows
      ? disclosure?.routerOrigin === windows.routerOrigin &&
        disclosure.scope === 'repositories' &&
        nativeWindowsShellPolicy(resolved)
      : claudeWorkerSandboxCompatible([cwd, claudeWorkspace.root], resolved))
  )
    return null;
  const lookup = {
    root: claudeWorkspace.root,
    cwd,
    homeDir: homedir(),
    additionalDirectories: [
      ...(effective.permissions?.additionalDirectories ?? []),
      ...claudeWorkspace.workingDirectories.slice(1),
      ...(await claudeWorkspaceWorktrees(claudeWorkspace)),
    ],
  };
  // A definition that could override a built-in's permissions leaves it native.
  if (builtin && (await findDefinition(agentType, lookup).catch(() => undefined)) !== null)
    return null;
  const custom = builtin ? null : await workerAgent(agentType, lookup);
  if (custom && 'unmatched' in custom) return null;
  return {
    ...state.binary,
    claudeWorkspace,
    ...(windows ? { windows } : {}),
    ...(custom ? { customAgent: custom.agent } : {}),
  };
}

/** State supplied only after a Claude offer has been accepted and recorded. */
export type EarlyWorkerAccept = {
  job: ModelJob;
  /** What the parent writes to the worker while it runs. */
  inbox?: WorkerInbox;
  transport: WorkerTransport;
  accepted?: { at: number; marks: Record<string, number> };
  /** The job's image and document blocks sent as text, which the released worker adds to. */
  omitted?: Set<string>;
  activity?: Parameters<typeof runModelWorker>[1]['activity'];
  currentClaudePermissionMode?: Parameters<typeof runModelWorker>[1]['currentClaudePermissionMode'];
  permission: Parameters<typeof runModelWorker>[1]['permission'];
};

/** A second worker must not start if the prewarmed worker could not be stopped. */
export class WorkerStartUnconfirmed extends Error {}

/** Why a search that cost nothing did not run, in words the worker passes on. */
function searchFailure(cause: string): string {
  if (cause === 'budget') return "this job's budget has no room for a search";
  if (cause === 'payment_refused') return 'the payment was refused before anything was sent';
  return 'the search did not run and nothing was charged';
}

type EarlyWorkerInput = {
  accept: Promise<EarlyWorkerAccept>;
  onRelease: () => void;
};

/** Runs a qualified worker without changing the parent process or provider. */
export async function runModelWorker(
  job: ModelJob,
  options: {
    dataDir: string;
    transport: WorkerTransport;
    signal: AbortSignal;
    claudePermissionMode?: ClaudeWorkerPermissionMode;
    currentClaudePermissionMode?: () => unknown;
    claudeSession?: ClaudeWorkerSession;
    /** What the parent writes to this worker while it runs: each message is a user message at its next turn. */
    inbox?: WorkerInbox;
    /** Tests only: a start-up window. A job has none; a cancel bounds its start. */
    startupMs?: number;
    /** Tests only: the wait before a model call is tried again. */
    retryWait?: (ms: number, signal: AbortSignal) => Promise<void>;
    /** When the accept reached `tenjin mcp`, and the start phases marked before the run. */
    accepted?: { at: number; marks: Record<string, number> };
    /**
     * A worker started at offer time: it starts its Claude Code and brings it to ready,
     * then waits for `accept` before it sends the assignment. Until then no request leaves
     * it, and nothing it needs from the accept is known.
     */
    early?: EarlyWorkerInput;
    /** `tenjin mcp`'s request executor, which pays for a page the worker's WebFetch could
     *  not fetch. Absent, each page read answers that it is not available. */
    web?: WorkerRequest;
    /** The router's identities read, which the person's rules for those page reads are
     *  checked against. Absent, the copy the last read kept. */
    webIdentities?: () => Promise<Identities | undefined>;
    /** Where a worker that starts without its native agent prompt says why. Default: stderr. */
    warn?: (line: string) => void;
    /** The image and document blocks the job sent as text; the worker adds one each. */
    omitted?: Set<string>;
    activity?: {
      observe: (message: unknown) => void;
      running: () => void;
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
      current.dataDir,
      signal,
      current.claudePermissionMode,
      // The job's own provider: a Neon job's scope is computed under the Neon consent.
      providerOf(job),
    );
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
    return runQualifiedWorker(job, current, binary, options.early);
  };
  // NO WALL TIME, as a native subagent has none: the job runs until it completes, reaches its
  // dollar cap or the daily budget, is cancelled, or its session ends. A stop the caller's
  // signal carries is what the job reports.
  options.signal.throwIfAborted();
  try {
    const result = await run(options.signal);
    options.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (
      options.signal.reason instanceof ModelWorkerStopped &&
      workerStop(error)?.kind !== 'not_started'
    )
      throw options.signal.reason;
    throw error;
  }
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
  // Whose consent covers the job, and whose model its calls go to.
  const provider = providerOf(job);
  // The start time for the diagnostic record, which is made further down.
  const workerStart = Date.now();
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
    const disclosure = await modelSettings(options.dataDir, job.root, provider);
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
          disclosure.scope === 'repositories' &&
          windows.routerOrigin === options.transport.origin &&
          nativeWindowsShellPolicy(resolved)
        : claudeWorkerSandboxCompatible([job.root, current.root], resolved)) ||
      !sameClaudeWorkspace(workspace, current)
    )
      throw new Error('Owned Claude workspace scope changed or disclosure was revoked');
    await refreshWalletSecrets(resolved.effective.env);
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
  // A Windows job has no GitHub setup, so it always strips GitHub token shapes (`removeSecrets`).
  const github: WorkerGithub | undefined = binary.windows
    ? undefined
    : await prepareWorkerGithub(process.env).catch(() => undefined);
  // The job's GitHub env: its token or none, and with a token named for workers the
  // session's own cleared, also when the setup failed.
  const githubEnv = binary.windows ? {} : (github?.env ?? sessionTokenClears(process.env));
  // Literal GitHub token values; the bridge removes them before anything leaves.
  let secrets: readonly string[] = github?.secrets ?? workerTokenValues(process.env);
  // The wallet's key and passphrase, by value, from every place a worker could read them:
  // this process's environment (a command can read it), the merged settings `env`, and the
  // `env` block of each settings file its file tools open. Its own environment drops them;
  // this removes them from everything the bridge forwards. Refreshed on every send.
  let walletSecrets: readonly string[] = workerWalletValues(process.env);
  let settingsFiles: readonly string[] = [];
  const refreshWalletSecrets = async (settingsEnv: Record<string, string | undefined> = {}) => {
    walletSecrets = [
      ...new Set([
        ...workerWalletValues(process.env),
        ...workerWalletValues(settingsEnv),
        ...(await settingsFileWalletValues(settingsFiles)),
      ]),
    ];
  };
  // A job whose GitHub setup failed knows no token by value; an earlier job's, resent from
  // a continued transcript, goes by its shape.
  const removeSecrets = (text: string) => {
    const removed = redactWorkerSecrets(text, [token, ...secrets, ...walletSecrets]);
    return github ? removed : redactGithubTokenShapes(removed);
  };
  const token = randomBytes(32).toString('hex');
  // The job's own temp folder, as a native session has its scratchpad. Without one the
  // worker uses the shared temp root, as before.
  const temp = await prepareClaudeWorkerTemp().catch(() => undefined);
  const agentType = String(job.native.subagent_type ?? 'general-purpose');
  // The temp folder is a working directory, so the file tools take its literal paths.
  // The linked worktrees are granted through the worker's settings, not `--add-dir`: a
  // directory passed as a flag has its `.claude` folder loaded (skills, agents, commands),
  // which a native subagent of the session does not do for its worktrees (92 of them here
  // cost 0.5 s of the child's start and put 160 duplicate skills in its list), and a
  // directory the settings name is a working directory of the session all the same, so the
  // sandbox lets git write that worktree's administrative folder. Windows keeps the flag.
  const settingsDirectories = binary.windows ? [] : worktrees;
  const additionalDirectories = [
    ...workspace.workingDirectories.slice(1),
    ...(binary.windows ? worktrees : []),
    ...(temp ? [temp.directory] : []),
  ];
  // What the start key stamps, as at the accept: every directory the worker may use.
  const keyedDirectories = [...workspace.workingDirectories.slice(1), ...worktrees];
  const agentInput = {
    binary: binary.path,
    cwd: job.root,
    additionalDirectories: keyedDirectories,
    agentType,
    ...(binary.windows ? { windows: binary.windows } : {}),
    ...(binary.customAgent ? { customAgent: binary.customAgent } : {}),
  };
  const readPrompt = (signal: AbortSignal) =>
    readNativeAgentPromptCached({
      ...agentInput,
      additionalDirectories,
      ...(temp ? { ephemeralDirectories: [temp.directory] } : {}),
      signal,
    });
  const managedPolicyHolds = ({ resolved }: Awaited<ReturnType<typeof assertCurrentWorkspace>>) =>
    claudeManagedProviderCompatible(resolved) &&
    !(permissionMode === 'auto' && resolved.effective.permissions?.disableAutoMode === 'disable') &&
    !(
      permissionMode === 'bypassPermissions' &&
      resolved.effective.permissions?.disableBypassPermissionsMode === 'disable'
    );
  // THE SUBAGENT PROMPT IS READ AHEAD, while the worker's settings and private paths are
  // read. The read starts a Claude Code of its own that sends nothing out. The checks that
  // stand before the read stand before this one too; they run again further down, where
  // this read's result is taken or, without one, the read is made.
  const promptStop = new AbortController();
  const stopPrompt = () => promptStop.abort(options.signal.reason);
  options.signal.addEventListener('abort', stopPrompt, { once: true });
  if (options.signal.aborted) stopPrompt();
  const promptAhead = (async () => {
    try {
      if (!managedPolicyHolds(await assertCurrentWorkspace())) return undefined;
    } catch {
      return undefined;
    }
    const from = Date.now();
    try {
      return { native: await readPrompt(promptStop.signal), ms: Date.now() - from };
    } catch (error) {
      return { error };
    }
  })();
  // The job's GitHub and temp folders exist from here: a start that fails before the
  // `try` that follows removes them, as every later end does.
  const removeJobFolders = async () => {
    await github?.close().catch(() => undefined);
    await temp?.close().catch(() => undefined);
  };
  // The job's own bridge token and GitHub token, wherever they appear in text that leaves
  // this process or is written to disk.
  const redactAll = (text: string) => removeSecrets(text);
  try {
    options.signal.throwIfAborted();
    assertCurrentMode();
  } catch (error) {
    options.signal.removeEventListener('abort', stopPrompt);
    promptStop.abort(error);
    await removeJobFolders();
    throw error;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  // The read made ahead ends with the worker, whatever ends it.
  controller.signal.addEventListener('abort', () => promptStop.abort(controller.signal.reason), {
    once: true,
  });
  // The worker's settings carry the bridge token and the job's GitHub env: in a private
  // file, never on its command line.
  const nativeProcess = claudeWorkerProcess({
    secrets: () => [token, ...secrets, ...walletSecrets],
    windows: binary.windows,
    onStartupMark: (name, at) => diagnostics.childMark(name, at),
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
    // Later messages from the parent, in order, each at the worker's next turn. The input
    // stays open until the worker has reported with none waiting.
    for (let text = await options.inbox?.next(); text != null; text = await options.inbox?.next())
      yield {
        type: 'user',
        session_id: '',
        message: { role: 'user', content: [{ type: 'text' as const, text }] },
        parent_tool_use_id: null,
        priority: 'next',
      };
  }
  const denyInitialization = () => initialized(false);
  controller.signal.addEventListener('abort', denyInitialization, { once: true });
  // No start-up window, as for a native subagent: a loaded machine starts Claude Code
  // slowly, and a missed start leaves the routing fee paid. A cancel bounds the
  // start.
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
  // A page the worker's WebFetch could not fetch, paid as a Tenjin tool call from the
  // person's wallet and counted in this job's budget.
  const web: WorkerWebDeps = {
    job,
    transport: options.transport,
    dataDir: options.dataDir,
    ...(options.web ? { request: options.web } : {}),
    ...(options.webIdentities ? { identities: options.webIdentities } : {}),
    signal: controller.signal,
  };
  // The viewer names a call by what served it: a WebSearch by DeepSeek's own search, a
  // WebFetch by Exa page read only when that read stood in for a failed local fetch.
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
  const assertCurrentSend = async () => {
    await assertCurrentWorkspace();
    assertCurrentMode();
    controller.signal.throwIfAborted();
  };
  const fetchFallback = async (event: WorkerFetchEvent, id: unknown) => {
    if (!released || controller.signal.aborted) return null;
    // The Neon worker sends nothing to Tenjin's router: a page it could not fetch is not read.
    if (provider === 'neon') return null;
    await assertCurrentSend();
    return workerFetchFallback(event, {
      ...web,
      redact: redactAll,
      onRead: (bytes) => served(id, WORKER_PAGE_READ_LABEL, bytes),
    });
  };
  const bridge = createServer((req, res) => {
    const handle = async () => {
      let timed: ReturnType<WorkerDiagnosticsRecord['call']> | undefined;
      // A streamed reply: events have left for the child (`started`), and its last one was sent.
      const live = { started: false, stopped: false, counted: false };
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
        timed = diagnostics.call();
        await assertCurrentSend();
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
        // Build what leaves only after reading the body, under current scope and redaction.
        const outgoing = async () => {
          await assertCurrentSend();
          const text = withholdDroppedDirectories(
            redactWorkerJson(body, removeSecrets),
            workspace.droppedDirectories,
          );
          try {
            return JSON.parse(text) as Record<string, unknown>;
          } catch {
            throw new UnsupportedRequest('the request is not JSON');
          }
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
        // The provider's events go to the child as they arrive, when it asked for a stream.
        // A child that has gone away is no longer written to; the call runs on to its
        // receipt.
        const relayEvent =
          raw.stream === true
            ? (event: StreamEvent) => {
                if (res.destroyed || res.writableEnded) return;
                if (!res.headersSent) {
                  res.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                  });
                  diagnostics.mark('firstActivity');
                }
                live.started = true;
                if (event.type === 'message_delta') live.counted = true;
                if (event.type === 'message_stop') live.stopped = true;
                res.write(sseFrame(event));
              }
            : undefined;
        // A WORKER'S WEB SEARCH IS ONE MODEL CALL: the nested request becomes a Messages
        // body holding DeepSeek's own search tool, paid, reserved, signed and settled as
        // any model call. A tool field the router's schema refuses, or no query, ends the
        // search alone here, before anything is sent or paid.
        const search = workerWebSearch(raw);
        if (search) {
          const why =
            provider === 'neon'
              ? 'the Neon worker has no web search'
              : search.refused !== null
                ? `the request's ${search.refused} filter is not supported`
                : search.query.length === 0
                  ? 'the search had no query'
                  : null;
          if (why !== null) {
            send(searchRefusedMessage(search, why));
            return;
          }
          diagnostics.mark('firstRequest');
          diagnostics.request(raw, workerSearchMessages(search));
          timed.prepared();
          let attempts = 0;
          let timing: ModelCallTiming | undefined;
          let message: Record<string, unknown>;
          try {
            message = await withModelRetry(
              async () => {
                attempts++;
                return options.transport.messages(
                  job,
                  workerSearchMessages(search),
                  controller.signal,
                  assertCurrentSend,
                  (split) => {
                    timing = split;
                  },
                );
              },
              controller.signal,
              (attempt, failure) => diagnostics.retry(attempt, failure.detail),
              options.retryWait,
            );
          } catch (error) {
            // A SEARCH THAT COST NOTHING FAILS ALONE: the child gets the native error
            // block and the assignment goes on with its local tools. An uncertain payment
            // still ends the job, as any uncertain model call does, because the job must
            // not spend more while that call is unresolved.
            if (
              error instanceof ModelCallFailed &&
              !controller.signal.aborted &&
              (error.detail.uncharged === true ||
                error.detail.cause === 'budget' ||
                error.detail.cause === 'payment_refused')
            ) {
              timed.done({ tries: attempts, ...(timing ? { timing } : {}) });
              send(searchRefusedMessage(search, searchFailure(error.detail.cause)));
              return;
            }
            throw error;
          }
          timed.done({ usage: message.usage, tries: attempts, ...(timing ? { timing } : {}) });
          send(message);
          return;
        }
        let messages: ReturnType<typeof workerMessages>;
        try {
          messages = workerMessages(raw, outputCap, options.omitted);
          diagnostics.mark('firstRequest');
          diagnostics.request(raw, messages);
          diagnostics.omitted(options.omitted?.size ?? 0);
          timed.prepared();
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
        // (consent and the workspace, the mode, a cancel).
        let attempts = 0;
        let timing: ModelCallTiming | undefined;
        const message = await withModelRetry(
          async () => {
            if (attempts++ > 0) {
              messages = workerMessages(await outgoing(), outputCap, options.omitted);
              diagnostics.omitted(options.omitted?.size ?? 0);
            }
            return options.transport.messages(
              job,
              messages,
              controller.signal,
              assertCurrentSend,
              (split) => {
                timing = split;
              },
              relayEvent,
            );
          },
          controller.signal,
          (attempt, failure) => diagnostics.retry(attempt, failure.detail),
          options.retryWait,
        ).catch((error: unknown) => {
          timed?.done({ tries: attempts, ...(timing ? { timing } : {}) });
          if (controller.signal.aborted) throw error;
          // Cut after events reached the child, and the router proves nothing was charged:
          // the turn ends in an error event and the job goes on. Anything else ends the job.
          if (
            live.started &&
            error instanceof ModelCallFailed &&
            error.detail.relayed === true &&
            error.detail.uncharged === true &&
            // A reply DeepSeek refused to give ends the job as `refused`, as before any event.
            error.detail.code !== MODEL_REFUSED_CODE
          )
            throw new RelayedCut({ cause: error });
          throw modelCallStop(error);
        });
        diagnostics.mark('firstAnswer');
        if (live.started) {
          // The events were the answer, and the call is settled: the receipt is checked and
          // charged. After `message_delta` (the usage was counted) only `message_stop` is
          // left to come, and it carries no content, so the reply is complete and ends with
          // that event, nothing made up. A reply that ended before `message_delta` was not
          // counted that way: the child is told, as for any reply that ends early.
          if (!res.destroyed && !res.writableEnded) {
            if (!live.stopped) {
              if (live.counted) res.write(sseFrame({ type: 'message_stop' }));
              else res.write(sseError('The model reply ended before its last event'));
            }
            res.end();
          }
        } else send(message);
        timed.done({ usage: message.usage, tries: attempts, ...(timing ? { timing } : {}) });
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
        if (error instanceof RelayedCut) {
          if (!res.destroyed && !res.writableEnded)
            res.end(sseError('The model call was cut after its reply began; nothing was charged'));
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
            live.started
              ? sseError('Tenjin worker request stopped; inspect receipts before retrying')
              : JSON.stringify({
                  type: 'error',
                  error: {
                    type: 'api_error',
                    message: 'Tenjin worker request stopped; inspect receipts before retrying',
                  },
                }),
            stop,
          );
        else stop();
      } finally {
        // A request the bridge refused, or one that ended before a reply.
        timed?.drop();
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
  // Auto and bypass workers never wait on a person; the sandbox still applies.
  const nobodyAsked = permissionMode === 'auto' || permissionMode === 'bypassPermissions';
  const repeats = new WorkerRepeatReminder();
  // What the job's own offer says, so a job keeps one cap from its first call to its last.
  const outputCap = offeredOutputTokens(job.decision);
  const diagnostics = new WorkerDiagnosticsRecord(
    job.root,
    compactWindowTokens(outputCap),
    outputCap,
  );
  if (options.accepted && !early) diagnostics.accepted(options.accepted.at, options.accepted.marks);
  diagnostics.mark('workerStart', workerStart);
  const repeated = (tool: string, input: unknown) => {
    const reminder = repeats.observe(tool, input);
    diagnostics.repeat(tool, reminder?.count);
    return reminder?.text;
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
    const env = claudeDeepSeekWorkerEnv(
      process.env,
      `http://127.0.0.1:${address.port}`,
      token,
      outputCap,
    );
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
    diagnostics.mark('workspaceRead');
    settingsFiles = privatePaths.readable;
    await refreshWalletSecrets(resolved.effective.env);
    // A GitHub token in the person's settings env reaches the worker's commands too.
    secrets = [...new Set([...secrets, ...workerTokenValues(resolved.effective.env ?? {})])];
    const dropped = workspace.droppedDirectories;
    const otherTemps = await jobTempPatterns();
    const otherGithub = await workerGithubPatterns();
    if (!managedPolicyHolds({ resolved, disclosure }))
      throw new Error('Managed Claude worker policy changed; keep native');
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
    const promptReadFrom = Date.now();
    try {
      const ahead = await promptAhead;
      if (ahead && 'error' in ahead) throw ahead.error;
      nativeAgent = ahead?.native ?? (await readPrompt(controller.signal));
      diagnostics.mark('promptRead');
      // A kept read answers in a few milliseconds; a fresh one starts a Claude Code.
      diagnostics.fact('promptReadMs', ahead?.ms ?? Date.now() - promptReadFrom);
      diagnostics.fact('promptAhead', ahead !== undefined);
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
          // Above an `alwaysThinkingEnabled: false` in the person's own settings.
          alwaysThinkingEnabled: true,
          // The CLAUDE.md files a native subagent of this type starts without (all of them
          // for `Explore`). Claude Code puts them in a main thread's first request, which
          // the worker is, whatever its agent says.
          ...(nativeAgent?.withheldInstructions.length
            ? { claudeMdExcludes: instructionExcludes(nativeAgent.withheldInstructions) }
            : {}),
          ...(!binary.windows ? { apiKeyHelper: claudeDeepSeekWorkerApiKeyHelper() } : {}),
          env: {
            ...claudeDeepSeekWorkerSettingsEnv(
              `http://127.0.0.1:${address.port}`,
              token,
              outputCap,
            ),
            ...CLAUDE_WORKER_THINKING_ENV,
            // Above a GitHub token in the person's settings env, which Claude Code would
            // otherwise hand the worker's commands in place of the job's own, or of none.
            ...githubEnv,
            TENJIN_WORKER_GITHUB_TOKEN: '',
            TENJIN_WORKER_GITHUB_TOKEN_FILE: '',
            // Above a value in the person's settings, which would move the temp root back.
            ...(temp ? { CLAUDE_CODE_TMPDIR: temp.directory } : {}),
          },
          permissions: {
            ...(settingsDirectories.length ? { additionalDirectories: settingsDirectories } : {}),
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
                // A consented workspace holds other repositories' native settings too.
                const patterns = NESTED_PRIVATE.map((name) => `${absolute}/**/${name}`);
                return [
                  ...['Read', 'Edit', 'Write'].flatMap((tool) =>
                    patterns.map((pattern) => `${tool}(${pattern})`),
                  ),
                  // A repository's `.claude/settings.json` is read as a native subagent reads
                  // it, and never written.
                  ...['Edit', 'Write'].map((tool) => `${tool}(${absolute}/**/${NESTED_SETTINGS})`),
                ];
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
                    // The job's own temp and GitHub folders, which `denyRead` names with every
                    // other job's below: `allowRead` wins over `denyRead`, and deeper denies
                    // inside them still hold.
                    allowRead: [
                      ...(github ? [github.directory] : []),
                      ...(temp ? [temp.directory] : []),
                      ...privatePaths.readable,
                    ],
                    ...(github ? { allowWrite: [github.directory] } : {}),
                    denyRead: [
                      ...privatePaths.paths,
                      ...protectedRoots.flatMap((root) =>
                        NESTED_PRIVATE.map((name) => `${root}/**/${name}`),
                      ),
                      ...dropped,
                      // Other sessions' temp files; this job's own are in its temp folder.
                      ...(temp?.shared ?? []),
                      // Other jobs' temp, GitHub and settings folders: their commands' output and
                      // files as written, gh caches, and their bridge and GitHub tokens. The file
                      // tools already refuse them, as folders outside the working directories.
                      // Built without this job's own setup, so another job's folders stay closed
                      // when its GitHub or temp setup failed.
                      ...(temp?.others ?? otherTemps),
                      ...(github?.others ?? otherGithub),
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
        // job's money ceiling and a cancel bound a run.
        disallowedTools: [
          // A worker starts no subagent, native or DeepSeek, and none of its calls is
          // held or offered (operator ruling 2026-11-17).
          'Agent',
          'Task',
          ...CLAUDE_TENJIN_TOOLS,
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
                  const deny = (permissionDecisionReason: string, additionalContext?: string) => ({
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse' as const,
                      permissionDecision: 'deny' as const,
                      permissionDecisionReason,
                      ...(additionalContext ? { additionalContext } : {}),
                    },
                  });
                  if (!released) return deny('The DeepSeek job has not been accepted.');
                  // THE REPEAT REMINDER COUNTS HERE, the one place every call of the model
                  // passes, whoever refuses it afterwards: this hook, a deny rule, the
                  // permission callback, don't-ask mode or the auto-mode classifier. None
                  // of those reaches a hook that runs after a tool (checked on Claude Code
                  // 2.1.325 and 2.1.328), and the classifier's own `PermissionDenied` hook
                  // can hand the model nothing. The context given here reaches the model
                  // with the call's result or its refusal.
                  const reminder =
                    input.hook_event_name === 'PreToolUse'
                      ? repeated(input.tool_name, input.tool_input)
                      : undefined;
                  // Every call is the accepted mode's to judge, as a native subagent's is.
                  try {
                    assertCurrentMode();
                    await assertCurrentWorkspace();
                  } catch {
                    return deny(
                      'Owned permission mode or workspace scope changed or is unavailable',
                      reminder,
                    );
                  }
                  if (controller.signal.aborted)
                    return deny('Model access revoked or job cancelled', reminder);
                  return reminder
                    ? {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse' as const,
                          additionalContext: reminder,
                        },
                      }
                    : {};
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
      diagnostics.mark('sdkInitialized');
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
        const current = await assertCurrentWorkspace();
        const selected = await readWorkerClaudeCode(job.root, binary.windows);
        const directories = [
          ...workspace.workingDirectories.slice(1),
          ...(await claudeWorkspaceWorktrees(workspace)),
        ];
        const lookup = {
          root: job.root,
          cwd: job.root,
          homeDir: homedir(),
          additionalDirectories: [
            ...(current.resolved.effective.permissions?.additionalDirectories ?? []),
            ...directories,
          ],
        };
        const builtin = WORKER_BUILTIN_AGENTS.has(agentType);
        const custom = builtin ? null : await workerAgent(agentType, lookup);
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
          (builtin && (await findDefinition(agentType, lookup).catch(() => undefined)) !== null)
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
        options.omitted = accept.omitted;
        options.activity = accept.activity;
        options.inbox = accept.inbox;
        options.currentClaudePermissionMode = accept.currentClaudePermissionMode;
        if (accept.accepted) diagnostics.accepted(accept.accepted.at, accept.accepted.marks);
        diagnostics.mark('released');
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
          // tokens first.
          options.activity?.observe(redactWorkerMessage(message, redactAll));
        } catch {
          // The SDK remains the owner of complete worker history.
        }
      }
      if (message.type === 'result') {
        diagnostics.mark('resultMessage');
        diagnostics.stop(message);
        session?.assert(message.session_id);
        if (message.subtype !== 'success') throw workerResultError(message);
        result = message.result;
        // Reported with nothing waiting: the input closes and the worker ends. A message
        // queued meanwhile is sent first, and its turn reports again.
        options.inbox?.closeIfEmpty();
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
    // Seal, not close: what was queued and never read is the caller's to report.
    options.inbox?.seal();
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
    options.signal.removeEventListener('abort', stopPrompt);
    closeFailure = await processClosed;
    diagnostics.mark('childClosed');
    if (released) await diagnostics.write(options.dataDir, job.id);
    await removeJobFolders();
  }
  if (early && !released && closeFailure?.quiescent === false)
    throw new WorkerStartUnconfirmed('Warm Claude worker cleanup could not be confirmed', {
      cause: closeFailure.error,
    });
  if (closeFailure && (!executionFailure || !closeFailure.quiescent)) throw closeFailure.error;
  // A child that never started reports that, whatever the SDK threw on the way out.
  const stop = workerStop(controller.signal.reason);
  if (stop?.kind === 'not_started')
    throw new ModelWorkerStopped({ kind: 'not_started', reason: 'startup_timeout' });
  if (executionFailure) throw executionFailure.error;
  return redactAll(result!);
}

/** Native local settings and MCP config of repositories nested in a worker root: closed. */
const NESTED_PRIVATE = ['.claude/settings.local.json', '.mcp.json'];
/**
 * A repository's shared settings, at any depth: readable, as a native subagent reads them,
 * and never written by the file tools. A working directory's own copy is in the sandbox's
 * write denies too, so a merge or checkout that must rewrite it fails at that write, as a
 * native sandboxed command does before it asks to run unsandboxed, which a worker's command
 * cannot.
 */
const NESTED_SETTINGS = '.claude/settings.json';

/** A worker request the bridge refuses before anything is sent on or paid; the message
 *  is fixed text, never the request's content. */
class UnsupportedRequest extends Error {}
