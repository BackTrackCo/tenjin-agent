import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { readFile, realpath } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { withAppServer, type CodexAppRequest } from '../lib/codex-app-server';
import { resolveCodex } from '../lib/codex-bin';
import { isRecord } from '../lib/guards';
import { canonicalHash } from '../lib/request-schema';
import {
  codexInstructionProfile,
  readCodexInstructionFilesOnServer,
} from './codex-instruction-reader';
import { policyRules, type CodexModelPolicy } from './codex-model-gates';
import {
  resolveCodexInstructions,
  assertInstructionContextCurrent,
  type InstructionContext,
} from './model-instructions';
import { nativeFlashCatalog } from './deepseek-codex-catalog';
import { modelSettings } from './model-settings';
import { MCP_SERVER_NAME } from './names';
import type { ModelJob } from './model-job';
import type { ModelTransport } from './model-transport';

const PROVIDER = 'tenjin_deepseek_worker_v1';
const VERSION = '0.167.0-alpha.4.1';
const CLEARED_PROVIDER_KEYS = [
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'TYPESAFE_KEY',
  'TYPESAFE_API_KEY',
] as const;
interface Options {
  cwd: string;
  dataDir: string;
  policy: CodexModelPolicy;
  signal?: AbortSignal;
  home?: string;
  env?: NodeJS.ProcessEnv;
}
export interface NativeCodexSnapshot {
  version: 1;
  fingerprint: string;
  parent: string;
  instructions: string;
}
interface Session {
  request: CodexAppRequest;
  threadId: string;
  snapshot: NativeCodexSnapshot;
  instructionContext: InstructionContext;
  assertCurrent(): Promise<void>;
}
interface OwnedProvider {
  url: string;
  catalogPath: string;
}

function assertOwnedProvider(config: Record<string, unknown>, owned: OwnedProvider) {
  const expected = {
    name: 'Tenjin DeepSeek worker',
    base_url: owned.url,
    wire_api: 'responses',
    env_key: 'TENJIN_MODEL_TOKEN',
    requires_openai_auth: false,
    supports_websockets: false,
    request_max_retries: 0,
    stream_max_retries: 0,
  };
  if (
    config.model !== 'deepseek-flash' ||
    config.model_provider !== PROVIDER ||
    config.model_reasoning_effort !== 'high' ||
    config.model_catalog_json !== owned.catalogPath ||
    !isRecord(config.model_providers) ||
    !isDeepStrictEqual(config.model_providers[PROVIDER], expected)
  )
    throw new Error('Native provider/catalog authority changed');
}

function assertMcpEnvironment(config: Record<string, unknown>) {
  if (!isRecord(config.mcp_servers)) return;
  for (const [name, server] of Object.entries(config.mcp_servers)) {
    if (name === MCP_SERVER_NAME || !isRecord(server) || server.enabled === false) continue;
    if (!Array.isArray(server.env_vars)) continue;
    for (const key of CLEARED_PROVIDER_KEYS) {
      if (
        server.env_vars.includes(key) &&
        (!isRecord(server.env) || typeof server.env[key] !== 'string' || !server.env[key])
      )
        throw new Error('Native MCP requires a provider credential excluded from worker commands');
    }
  }
}

function projectConfig(raw: Record<string, unknown>) {
  const copy = structuredClone(raw);
  for (const key of ['model', 'model_provider', 'model_reasoning_effort', 'model_catalog_json'])
    delete copy[key];
  if (isRecord(copy.model_providers)) {
    delete copy.model_providers[PROVIDER];
    if (!Object.keys(copy.model_providers).length) delete copy.model_providers;
  }
  return copy;
}
function projectLayers(layers: unknown[]) {
  return layers.map((layer) => {
    if (
      !isRecord(layer) ||
      !isRecord(layer.name) ||
      layer.name.type !== 'sessionFlags' ||
      !isRecord(layer.config)
    )
      return layer;
    const config = projectConfig(layer.config);
    // Only owned argv values differ between the preflight and live bridge.
    // Preserve every other layer/version and bind the remaining session flags.
    return { ...layer, config, version: canonicalHash(config) };
  });
}
export function savedNativeSnapshot(raw: unknown): NativeCodexSnapshot | null {
  return isRecord(raw) &&
    raw.version === 1 &&
    ['fingerprint', 'parent', 'instructions'].every(
      (key) => typeof raw[key] === 'string' && /^[a-f0-9]{64}$/.test(raw[key] as string),
    )
    ? (raw as unknown as NativeCodexSnapshot)
    : null;
}
async function hostSnapshot(
  request: CodexAppRequest,
  options: Options,
  owned: OwnedProvider,
  threadId?: string,
) {
  const [raw, listed, requirements] = await Promise.all([
    request('config/read', { cwd: options.cwd, includeLayers: true }),
    request('hooks/list', threadId ? { threadId } : { cwds: [options.cwd] }),
    request('configRequirements/read', {}),
  ]);
  if (
    !isRecord(raw) ||
    !isRecord(raw.config) ||
    !Array.isArray(raw.layers) ||
    !isRecord(requirements) ||
    !isRecord(listed) ||
    !Array.isArray(listed.data) ||
    !listed.data.length
  )
    throw new Error('Native configuration unavailable');
  assertOwnedProvider(raw.config, owned);
  assertMcpEnvironment(raw.config);
  const hooks: unknown[] = [];
  for (const entry of listed.data) {
    if (
      !isRecord(entry) ||
      !Array.isArray(entry.hooks) ||
      !Array.isArray(entry.errors) ||
      entry.errors.length
    )
      throw new Error('Native hooks unavailable');
    for (const hook of entry.hooks) {
      if (!isRecord(hook)) throw new Error('Native hook metadata unavailable');
      if (
        hook.enabled === true &&
        (!['command', 'mcpTool'].includes(String(hook.handlerType)) ||
          !['trusted', 'managed'].includes(String(hook.trustStatus)) ||
          typeof hook.currentHash !== 'string' ||
          ['preModelRequest', 'postModelRequest'].includes(String(hook.eventName)))
      )
        throw new Error('Native prompt/model/untrusted hook remains native');
      hooks.push(hook);
    }
  }
  const rules = await policyRules(raw.layers);
  if (!rules) throw new Error('Native rule layers unavailable');
  const ruleHashes = [];
  for (const path of rules) {
    const bytes = await readFile(path);
    if (bytes.byteLength > 256_000) throw new Error('Native rules oversized');
    ruleHashes.push({ path, hash: canonicalHash(bytes.toString('utf8')) });
  }
  const inventory: unknown[] = [];
  if (threadId) {
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      if (pages >= 20) throw new Error('Native MCP inventory exceeds bound');
      const page = await request('mcpServerStatus/list', {
        threadId,
        detail: 'toolsAndAuthOnly',
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!isRecord(page) || !Array.isArray(page.data))
        throw new Error('Native MCP inventory unavailable');
      for (const row of page.data) {
        if (!isRecord(row) || typeof row.name !== 'string' || !isRecord(row.tools))
          throw new Error('Native MCP inventory invalid');
        if (row.runtimeStatus === 'disabled') continue;
        if (row.runtimeStatus !== 'connected' || row.toolsError != null)
          throw new Error('Native MCP authentication/connection unavailable');
        if (
          typeof row.pluginId === 'string' &&
          options.policy.disabledPluginIds?.includes(row.pluginId)
        )
          throw new Error('Disabled plugin remains active');
        inventory.push({
          name: row.name,
          pluginId: row.pluginId ?? null,
          tools: row.tools,
          authStatus: row.authStatus,
        });
      }
      if (page.nextCursor == null) break;
      if (typeof page.nextCursor !== 'string' || page.nextCursor === cursor)
        throw new Error('Invalid native MCP pagination');
      cursor = page.nextCursor;
    }
  }
  const layers = projectLayers(raw.layers);
  if (threadId) {
    const served = new Map<string, Set<string>>();
    for (const row of inventory) {
      if (!isRecord(row) || typeof row.name !== 'string' || !isRecord(row.tools)) continue;
      const add = (namespace: string, name: string) => {
        const names = served.get(namespace) ?? new Set<string>();
        names.add(name);
        served.set(namespace, names);
      };
      for (const [key, tool] of Object.entries(row.tools)) {
        add(`mcp__${row.name}`, key);
        if (isRecord(tool) && typeof tool.name === 'string') {
          add(`mcp__${row.name}`, tool.name);
          if (typeof tool.namespace === 'string' && tool.namespace.startsWith('mcp__'))
            add(tool.namespace, tool.name);
        }
      }
    }
    for (const expected of options.policy.parent?.externalTools ?? [])
      if (expected.tools.some((name) => !served.get(expected.namespace)?.has(name)))
        throw new Error('A parent-served external tool is unavailable in the native worker');
  }
  const host = { config: projectConfig(raw.config), layers, requirements, hooks, ruleHashes };
  return {
    raw,
    hostFingerprint: canonicalHash(host),
    fingerprint: canonicalHash({ ...host, inventory }),
  };
}
async function parentEnvironments(request: CodexAppRequest, options: Options) {
  const parent = options.policy.parent;
  if (!parent) throw new Error('Complete native parent authority unavailable');
  const raw = await request('thread/read', { threadId: parent.sessionId, includeTurns: false });
  if (
    !isRecord(raw) ||
    !isRecord(raw.thread) ||
    raw.thread.id !== parent.sessionId ||
    raw.thread.sessionId !== parent.sessionId ||
    raw.thread.parentThreadId != null ||
    raw.thread.source !== 'vscode' ||
    raw.thread.extra != null ||
    !Array.isArray(raw.thread.environments)
  )
    throw new Error('Native parent environment unavailable');
  const environments = [];
  for (const entry of raw.thread.environments) {
    if (
      !isRecord(entry) ||
      entry.environmentId !== 'local' ||
      typeof entry.cwd !== 'string' ||
      !Array.isArray(entry.runtimeWorkspaceRoots)
    )
      throw new Error('Unsupported native environment');
    const roots = await Promise.all(
      entry.runtimeWorkspaceRoots.map((path) =>
        typeof path === 'string'
          ? realpath(path)
          : Promise.reject(new Error('Unknown native root')),
      ),
    );
    if (roots.some((root) => !parent.runtimeWorkspaceRoots.includes(root)))
      throw new Error('Native environment roots changed');
    environments.push({
      environmentId: 'local',
      cwd: await realpath(entry.cwd),
      runtimeWorkspaceRoots: roots,
    });
  }
  return environments;
}

async function withNativeSession<T>(
  options: Options,
  bridge: { url: string; token: string },
  fn: (session: Session) => Promise<T>,
  callbacks: {
    notification?: (method: string, params: unknown) => void | Promise<void>;
    exit?: (error: Error) => void | Promise<void>;
    serverRequest?: (method: string, params: unknown) => Promise<unknown>;
  } = {},
): Promise<T | null> {
  if (
    !options.policy.parent ||
    !['user', 'auto_review'].includes(options.policy.approvalsReviewer) ||
    !['on-request', 'never', 'untrusted'].includes(String(options.policy.approvalPolicy))
  )
    return null;
  const profile = codexInstructionProfile({ ...options, worker: true });
  const instructionProfile = codexInstructionProfile(options);
  if (!profile || !instructionProfile) return null;
  const catalog = await nativeFlashCatalog(options.dataDir);
  const owned = { url: bridge.url, catalogPath: catalog.path };
  const env = {
    ...(options.env ?? process.env),
    TENJIN_MODEL_WORKER: '1',
    TENJIN_MODEL_TOKEN: bridge.token,
  };
  for (const key of ['TENJIN_WALLET_PASSPHRASE', ...CLEARED_PROVIDER_KEYS])
    delete env[key as keyof typeof env];
  const overrides = [
    ...profile.overrides,
    ...instructionProfile.overrides,
    `model=${JSON.stringify('deepseek-flash')}`,
    `model_provider=${JSON.stringify(PROVIDER)}`,
    'model_reasoning_effort="high"',
    `model_catalog_json=${JSON.stringify(catalog.path)}`,
    `model_providers.${PROVIDER}={ name="Tenjin DeepSeek worker", base_url=${JSON.stringify(bridge.url)}, wire_api="responses", env_key="TENJIN_MODEL_TOKEN", requires_openai_auth=false, supports_websockets=false, request_max_retries=0, stream_max_retries=0 }`,
    `mcp_servers.${MCP_SERVER_NAME}.env.TENJIN_MODEL_WORKER="1"`,
    ...(options.policy.disabledPluginIds ?? []).map(
      (id) => `plugins.${JSON.stringify(id)}.enabled=false`,
    ),
  ];
  return withAppServer(
    options.home ?? homedir(),
    env,
    15_000,
    async (request) => {
      const environments = await parentEnvironments(request, options);
      const before = await hostSnapshot(request, options, owned);
      const read = (
        paths: string[],
        maxBytes: number,
        signal = options.signal ?? new AbortController().signal,
      ) => readCodexInstructionFilesOnServer(request, options, paths, maxBytes, signal);
      const instructionContext = await resolveCodexInstructions({
        ...options,
        nativeConfig: {
          config: projectConfig(before.raw.config as Record<string, unknown>),
          layers: projectLayers(before.raw.layers as unknown[]),
        },
        read,
        nativeHarness: true,
      });
      const started = await request('thread/start', {
        cwd: options.cwd,
        model: 'deepseek-flash',
        modelProvider: PROVIDER,
        ephemeral: true,
        approvalPolicy: options.policy.approvalPolicy,
        approvalsReviewer: options.policy.approvalsReviewer,
        permissions: profile.name,
        runtimeWorkspaceRoots: options.policy.parent!.runtimeWorkspaceRoots,
        environments,
        baseInstructions: options.policy.parent!.baseInstructions,
        developerInstructions: options.policy.parent!.developerInstructions,
      });
      if (
        !isRecord(started) ||
        !isRecord(started.thread) ||
        typeof started.thread.id !== 'string' ||
        started.model !== 'deepseek-flash' ||
        started.modelProvider !== PROVIDER ||
        started.approvalsReviewer !== options.policy.approvalsReviewer ||
        !isDeepStrictEqual(started.approvalPolicy, options.policy.approvalPolicy) ||
        !isRecord(started.activePermissionProfile) ||
        started.activePermissionProfile.id !== profile.name ||
        !isDeepStrictEqual(
          started.runtimeWorkspaceRoots,
          options.policy.parent!.runtimeWorkspaceRoots,
        )
      )
        throw new Error('Native worker authority changed');
      const threadId = started.thread.id;
      try {
        const current = await hostSnapshot(request, options, owned, threadId);
        if (before.hostFingerprint !== current.hostFingerprint)
          throw new Error('Native host changed during qualification');
        const snapshot: NativeCodexSnapshot = {
          version: 1,
          fingerprint: canonicalHash({ host: current.fingerprint, catalog: catalog.hash }),
          parent: options.policy.parent!.fingerprint,
          instructions: instructionContext.fingerprint,
        };
        return await fn({
          request,
          threadId,
          snapshot,
          instructionContext,
          assertCurrent: async () => {
            options.signal?.throwIfAborted();
            if (
              canonicalHash({
                host: (await hostSnapshot(request, options, owned, threadId)).fingerprint,
                catalog: (await nativeFlashCatalog(options.dataDir)).hash,
              }) !== snapshot.fingerprint
            )
              throw new Error('Native host configuration changed');
            await assertInstructionContextCurrent(instructionContext, read);
          },
        });
      } finally {
        await request('thread/unsubscribe', { threadId }, 1500);
      }
    },
    {
      cwd: options.cwd,
      experimentalApi: true,
      expectedVersion: VERSION,
      configOverrides: overrides,
      signal: options.signal,
      onNotification: callbacks.notification,
      onExit: callbacks.exit,
      onServerRequest: callbacks.serverRequest,
    },
  );
}

export async function qualifyNativeCodexWorker(options: Options) {
  const binary = resolveCodex(options.env ?? process.env);
  if (!binary) return null;
  return withNativeSession(
    options,
    { url: 'http://127.0.0.1:1/v1', token: randomBytes(32).toString('hex') },
    async (session) => ({
      path: binary.cmd,
      instructionContext: session.instructionContext,
      nativeSnapshot: session.snapshot,
    }),
  );
}

export async function runNativeCodexWorker(
  job: ModelJob,
  options: {
    dataDir: string;
    transport: ModelTransport;
    signal: AbortSignal;
    codexPolicy: CodexModelPolicy;
    permission: (
      tool: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<boolean>;
  },
) {
  const expected = savedNativeSnapshot(job.decision.nativeSnapshot);
  if (
    !expected ||
    !options.codexPolicy.parent ||
    expected.parent !== options.codexPolicy.parent.fingerprint
  )
    throw new Error('Native worker authority unavailable');
  const controller = new AbortController(),
    token = randomBytes(32).toString('hex');
  let session: Session | undefined, turnId: string | undefined, proxyFailure: unknown;
  let finish!: (text: string) => void, fail!: (error: unknown) => void;
  const completion = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void completion.catch(() => {});
  const messages = new Map<string, string>(),
    fileChanges = new Map<string, unknown>();
  const early: Array<{ method: string; params: unknown }> = [];
  let turnReady!: (value: string | undefined) => void;
  const ready = new Promise<string | undefined>((resolve) => {
    turnReady = resolve;
  });
  const cancel = () => {
    if (session && turnId)
      void session.request('turn/interrupt', { threadId: session.threadId, turnId }, 1000);
    controller.abort(options.signal.reason);
    turnReady(undefined);
    fail(options.signal.reason ?? new Error('Native worker cancelled'));
  };
  options.signal.addEventListener('abort', cancel, { once: true });
  if (options.signal.aborted) cancel();
  const notify = async (method: string, params: unknown) => {
    if (!session || !isRecord(params) || params.threadId !== session.threadId) return;
    if (!turnId) {
      if (early.length >= 128) throw new Error('Native early event bound exceeded');
      early.push({ method, params });
      return;
    }
    if (
      method === 'item/started' &&
      params.turnId === turnId &&
      isRecord(params.item) &&
      params.item.type === 'fileChange' &&
      typeof params.item.id === 'string'
    )
      fileChanges.set(params.item.id, params.item.changes);
    if (
      method === 'item/completed' &&
      params.turnId === turnId &&
      isRecord(params.item) &&
      params.item.type === 'agentMessage' &&
      params.item.phase === 'final_answer' &&
      typeof params.item.id === 'string' &&
      typeof params.item.text === 'string'
    ) {
      if (Buffer.byteLength(params.item.text) > 256_000)
        throw new Error('Native worker result exceeds bound');
      messages.set(params.item.id, params.item.text);
    }
    if (method === 'turn/completed' && isRecord(params.turn) && params.turn.id === turnId) {
      if (params.turn.status !== 'completed') fail(new Error('Native worker did not complete'));
      else {
        const text = [...messages.values()].join('\n\n');
        if (!text || Buffer.byteLength(text) > 256_000)
          fail(new Error('Native completed result unavailable'));
        else finish(text);
      }
    }
  };
  const serverRequest = async (method: string, params: unknown) => {
    const ownedTurn = turnId ?? (await ready);
    if (
      !session ||
      !ownedTurn ||
      !isRecord(params) ||
      params.threadId !== session.threadId ||
      params.turnId !== ownedTurn
    )
      throw new Error('Foreign native request');
    if (method === 'item/commandExecution/requestApproval') {
      if (
        typeof params.itemId !== 'string' ||
        typeof params.command !== 'string' ||
        typeof params.cwd !== 'string' ||
        params.additionalPermissions != null ||
        (params.kind != null && params.kind !== 'command') ||
        (params.environmentId != null && params.environmentId !== 'local')
      )
        return { decision: 'decline' };
      const allow = await options.permission(
        'Codex command',
        { command: params.command, cwd: params.cwd, itemId: params.itemId },
        controller.signal,
      );
      return { decision: allow ? 'accept' : 'decline' };
    }
    if (method === 'item/fileChange/requestApproval') {
      const changes =
        typeof params.itemId === 'string' ? fileChanges.get(params.itemId) : undefined;
      if (!changes) return { decision: 'decline' };
      return {
        decision: (await options.permission(
          'Codex file changes',
          { ...params, changes },
          controller.signal,
        ))
          ? 'accept'
          : 'decline',
      };
    }
    if (method === 'mcpServer/elicitation/request') return { action: 'cancel' };
    if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
    throw new Error('Unsupported native user request');
  };
  let checked = false;
  const pending = new Set<Promise<void>>();
  const bridge = createServer((req, res) => {
    const operation = (async () => {
      try {
        if (
          req.method !== 'POST' ||
          req.url?.split('?')[0] !== '/v1/responses' ||
          req.headers.authorization !== `Bearer ${token}`
        ) {
          res.writeHead(403).end();
          return;
        }
        if (
          !session ||
          controller.signal.aborted ||
          !(await modelSettings(options.dataDir, job.root))
        )
          throw new Error('Native worker cancelled or consent revoked');
        if (!checked) {
          await session.assertCurrent();
          checked = true;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) throw new Error('Native request exceeds bound');
          chunks.push(Buffer.from(chunk));
        }
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          !isRecord(raw) ||
          raw.model !== 'deepseek-flash' ||
          raw.stream !== true ||
          !isRecord(raw.reasoning) ||
          raw.reasoning.effort !==
            (isRecord(raw.client_metadata) &&
            raw.client_metadata['x-openai-subagent'] === 'guardian'
              ? 'low'
              : 'high')
        )
          throw new Error('Unsupported native model request');
        const body = { ...raw, max_output_tokens: raw.max_output_tokens ?? 65536 };
        const wire = await options.transport.responses(job, body, controller.signal);
        if (!res.destroyed) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(wire);
      } catch (error) {
        proxyFailure ??= error;
        if (!res.destroyed) {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
          res.end(
            '{"error":{"type":"trial_stopped","message":"Tenjin worker stopped; inspect receipts"}}',
          );
        }
        fail(error);
        controller.abort(error);
      }
    })();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  try {
    options.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      bridge.once('error', reject);
      bridge.listen(0, '127.0.0.1', resolve);
    });
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('Native bridge unavailable');
    let workerFailure: unknown;
    const result = await withNativeSession(
      {
        cwd: job.root,
        dataDir: options.dataDir,
        policy: options.codexPolicy,
        signal: controller.signal,
      },
      { url: `http://127.0.0.1:${address.port}/v1`, token },
      async (current) => {
        try {
          session = current;
          if (!isDeepStrictEqual(current.snapshot, expected))
            throw new Error('Native host changed after recommendation');
          controller.signal.throwIfAborted();
          const mode = options.codexPolicy.parent!.collaborationMode;
          const started = await current.request('turn/start', {
            threadId: current.threadId,
            input: [{ type: 'text', text: job.task }],
            ...(mode
              ? {
                  collaborationMode: {
                    mode: 'default',
                    settings: {
                      model: 'deepseek-flash',
                      reasoning_effort: 'high',
                      developer_instructions: mode.developerInstructions,
                    },
                  },
                }
              : {}),
          });
          if (!isRecord(started) || !isRecord(started.turn) || typeof started.turn.id !== 'string')
            throw new Error('Native turn unavailable');
          turnId = started.turn.id;
          turnReady(turnId);
          for (const event of early.splice(0)) await notify(event.method, event.params);
          return await completion;
        } catch (error) {
          workerFailure = error;
          throw error;
        }
      },
      {
        notification: notify,
        exit: (error) => {
          fail(error);
          turnReady(undefined);
        },
        serverRequest,
      },
    );
    if (proxyFailure) throw proxyFailure;
    if (workerFailure) throw workerFailure;
    if (result === null) throw new Error('Native Codex policy unavailable; keep native');
    return result;
  } finally {
    controller.abort();
    turnReady(undefined);
    bridge.closeAllConnections();
    await Promise.allSettled([...pending]);
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    options.signal.removeEventListener('abort', cancel);
  }
}
