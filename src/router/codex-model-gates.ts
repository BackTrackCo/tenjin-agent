import { execFile } from 'node:child_process';
import { realpath, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { withAppServer, type CodexAppRequest } from '../lib/codex-app-server';
import { resolveCodex } from '../lib/codex-bin';
import { QUALIFIED_CODEX_MODEL_VERSIONS } from '../lib/codex-model-version';
import { isRecord } from '../lib/guards';
import { canonicalHash } from '../lib/request-schema';
import { MCP_SERVER_NAME } from './names';
import { codexHome } from '../lib/codex-home';
import { dataDir } from '../lib/paths';
import { ownCodexRow } from './codex-install';

export interface CodexModelPolicy {
  approvalPolicy: unknown;
  approvalsReviewer: string;
  sandbox: unknown;
  permissionProfile?: unknown;
  disabledPluginIds?: string[];
}
export interface CodexModelTool {
  server: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export interface CodexModelQualification {
  qualified: boolean;
  reasons: string[];
  tools: CodexModelTool[];
  commands: boolean;
  /** Native config for local instruction qualification; never sent as model context. */
  instructionConfig?: { config: Record<string, unknown>; layers: unknown };
}
export interface CodexModelGates extends CodexModelQualification {
  callMcp(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  command(
    argv: string[],
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
interface Options {
  cwd: string;
  policy: CodexModelPolicy;
  home?: string;
  dataDir?: string;
  /** Additional exact credential paths owned by the embedding worker. */
  protectedPaths?: string[];
  env?: NodeJS.ProcessEnv;
}
interface RunOptions extends Options {
  signal: AbortSignal;
  ask(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<boolean>;
}
interface Snapshot extends CodexModelQualification {
  serverVersion?: string | null;
  config: Record<string, unknown>;
  hooks: Record<string, unknown>[];
  rules: string[];
  profile: NativeProfile | null;
  fingerprint: string;
}
const exec = promisify(execFile);
const MODES = new Set(['auto', 'prompt', 'writes', 'approve']);
const GUARDED_EVENTS = new Set(['preToolUse', 'permissionRequest', 'postToolUse']);
const MODEL_GUARDED_EVENTS = new Set(['preModelRequest', 'postModelRequest']);
const LIFECYCLE_EVENTS = new Set([
  'preCompact',
  'postCompact',
  'sessionStart',
  'sessionEnd',
  'userPromptSubmit',
  'subagentStart',
  'subagentStop',
  'stop',
  'interrupt',
]);
const COMMAND_NAMES = [
  'exec_command',
  'execCommand',
  'commandexec',
  'functions.exec_command',
  'Bash',
];

interface NativeProfile {
  name: string;
  overrides: string[];
}
/** Intersect captured filesystem grants with repository consent through Codex's
 * maintained profile resolver. Preserve denies and add credential shields. */
export function codexModelProfile(
  policy: CodexModelPolicy,
  options: Omit<Options, 'policy'>,
): NativeProfile | null {
  const p = policy.permissionProfile;
  if (
    !isRecord(p) ||
    p.type !== 'managed' ||
    p.network !== 'restricted' ||
    !isRecord(p.file_system) ||
    Object.keys(p).some((k) => !['type', 'file_system', 'network'].includes(k))
  )
    return null;
  const fs = p.file_system;
  if (
    fs.type !== 'restricted' ||
    !Array.isArray(fs.entries) ||
    fs.entries.length > 256 ||
    Object.keys(fs).some((k) => !['type', 'entries', 'glob_scan_max_depth'].includes(k))
  )
    return null;
  const entries = new Map<string, string>();
  const root = options.cwd;
  if (!isAbsolute(root)) return null;
  const inside = (path: string) => path === root || path.startsWith(`${root}${sep}`);
  let rootAccess: string | null = null;
  let rootSpecificity = -1;
  let minimal = false;
  for (const entry of fs.entries) {
    if (
      !isRecord(entry) ||
      !isRecord(entry.path) ||
      !['read', 'write', 'deny', 'none'].includes(String(entry.access)) ||
      Object.keys(entry).some((k) => !['path', 'access', 'missing_path_behavior'].includes(k)) ||
      (entry.missing_path_behavior != null &&
        (entry.missing_path_behavior !== 'skip' || entry.access === 'write'))
    )
      return null;
    let path: string;
    if (
      entry.path.type === 'path' &&
      typeof entry.path.path === 'string' &&
      isAbsolute(entry.path.path)
    )
      path = entry.path.path;
    else if (entry.path.type === 'special' && isRecord(entry.path.value)) {
      const value = entry.path.value;
      if (value.kind === 'root') path = ':root';
      else if (value.kind === 'minimal') path = ':minimal';
      else if (value.kind === 'tmpdir') path = ':tmpdir';
      else if (value.kind === 'slash_tmp') path = ':slash_tmp';
      else if (value.kind === 'project_roots' && value.subpath == null) path = root;
      else return null;
    } else return null;
    const access = entry.access === 'none' ? 'deny' : String(entry.access);
    // Current Desktop marks protected read paths skip-when-missing. Keeping
    // their restriction even when absent is conservative; never add a grant
    // from an optional write entry whose native activation is unresolved.
    if (access === 'deny') {
      // Creating a new child allow below a parent denial would relax native policy.
      if (
        path === ':root' ||
        (isAbsolute(path) && (root === path || root.startsWith(`${path}${sep}`)))
      )
        return null;
      entries.set(path, access);
      continue;
    }
    if (
      path === ':root' ||
      (isAbsolute(path) && (root === path || root.startsWith(`${path}${sep}`)))
    ) {
      const specificity = path === ':root' ? 0 : path.length;
      if (specificity >= rootSpecificity) {
        rootAccess = access;
        rootSpecificity = specificity;
      }
      if (path === ':root') minimal = true;
    }
    if (path === ':minimal') minimal = true;
    if (isAbsolute(path) && inside(path)) {
      if (entries.has(path)) return null;
      entries.set(path, access);
    }
    // All other parent read/write grants are outside this repository's disclosure consent.
  }
  if (!rootAccess || !minimal) return null;
  entries.set(':minimal', 'read');
  if (!entries.has(root)) entries.set(root, rootAccess);
  // Codex's runtime may add writable system-temp roots. Explicit denies win
  // there; the more specific consented repository remains available.
  for (const path of [':slash_tmp', ':tmpdir', '/tmp', '/private/tmp'])
    if (root !== path) entries.set(path, 'deny');
  const env = options.env ?? process.env;
  const protectedPaths = [
    options.dataDir ?? dataDir(env),
    codexHome(options.home ?? homedir(), env),
    ...['.ssh', '.aws', '.claude', '.kube', '.gnupg', '.npmrc', '.netrc', '.git-credentials'].map(
      (name) => join(homedir(), name),
    ),
    join(options.cwd, '.env'),
    join(options.cwd, '.env.local'),
    ...(options.protectedPaths ?? []),
  ];
  for (const path of protectedPaths) {
    if (!isAbsolute(path)) return null;
    // A narrower allow must not override one of our protected subtrees.
    for (const key of entries.keys())
      if (key === path || key.startsWith(`${path}/`)) entries.delete(key);
    entries.set(path, 'deny');
  }
  const name = `tenjin-worker-${canonicalHash({ entries: [...entries], root: options.cwd }).slice(0, 16)}`;
  const prefix = `permissions.${name}`;
  const filesystem = `{ ${[...entries].map(([path, access]) => `${JSON.stringify(path)} = ${JSON.stringify(access)}`).join(', ')}, ":workspace_roots" = { "**/.env*" = "deny", "**/*.pem" = "deny", "**/*.p12" = "deny" }, glob_scan_max_depth = 6 }`;
  const overrides = [
    `${prefix}.filesystem=${filesystem}`,
    `${prefix}.network.enabled=false`,
    // Commands inherit no wallet/provider environment. Native MCP auth is broker-owned.
    'shell_environment_policy.inherit="none"',
    'shell_environment_policy.set={}',
    ...Object.entries({
      PATH: env.PATH ?? '/usr/bin:/bin',
      HOME: homedir(),
      LANG: 'C.UTF-8',
      TMPDIR: join(root, '.tenjin-worker-tmp'),
    }).map(([key, value]) => `shell_environment_policy.set.${key}=${JSON.stringify(value)}`),
  ];
  return { name, overrides };
}

/** Exact trusted Tenjin discovery hooks are not permission guards for the worker. */
function ownHook(hook: Record<string, unknown>): boolean {
  return ['trusted', 'managed'].includes(String(hook.trustStatus)) && ownCodexRow(hook);
}

function hookApplies(hook: Record<string, unknown>, names: string[]): boolean {
  if (hook.enabled !== true || !GUARDED_EVENTS.has(String(hook.eventName)) || ownHook(hook))
    return false;
  if (hook.matcher == null || hook.matcher === '' || hook.matcher === '*') return true;
  if (typeof hook.matcher !== 'string' || hook.matcher.length > 2000) return true;
  try {
    const pattern = new RegExp(hook.matcher);
    return names.some((name) => pattern.test(name));
  } catch {
    return true;
  }
}
function mcpNames(server: string, tool: string) {
  return [`mcp__${server}__${tool}`, `${server}.${tool}`, `${server}${tool}`];
}
function serverConfig(config: Record<string, unknown>, server: string) {
  return isRecord(config.mcp_servers) && isRecord(config.mcp_servers[server])
    ? config.mcp_servers[server]
    : null;
}
function approvalMode(
  config: Record<string, unknown>,
  server: string,
  tool: string,
): string | null {
  const entry = serverConfig(config, server);
  if (!entry || entry.enabled === false) return null;
  const perTool = isRecord(entry.tools) && isRecord(entry.tools[tool]) ? entry.tools[tool] : null;
  if (
    (entry.enabled_tools !== undefined &&
      (!Array.isArray(entry.enabled_tools) ||
        !entry.enabled_tools.every((v) => typeof v === 'string') ||
        !entry.enabled_tools.includes(tool))) ||
    (entry.disabled_tools !== undefined &&
      (!Array.isArray(entry.disabled_tools) ||
        !entry.disabled_tools.every((v) => typeof v === 'string') ||
        entry.disabled_tools.includes(tool)))
  )
    return null;
  const mode = perTool?.approval_mode ?? entry.default_tools_approval_mode ?? 'auto';
  return typeof mode === 'string' && MODES.has(mode) ? mode : null;
}
/** Codex0.163: destructive wins even when readOnlyHint is true. */
export function codexMcpNeedsApproval(mode: string, annotations: unknown): boolean {
  const a = isRecord(annotations) ? annotations : {};
  if (mode === 'approve') return false;
  if (mode === 'prompt') return true;
  if (mode === 'writes') return a.readOnlyHint !== true;
  if (mode !== 'auto' || a.destructiveHint === true) return true;
  if (a.readOnlyHint === true) return false;
  return a.destructiveHint !== false || a.openWorldHint !== false;
}
function askAllowed(policy: CodexModelPolicy) {
  return (
    policy.approvalsReviewer === 'user' &&
    ['on-request', 'untrusted'].includes(String(policy.approvalPolicy))
  );
}

/** Native execpolicy omits decision when no rule matches; approval is still required. */
export function codexExecPolicyDecision(value: unknown): 'allow' | 'prompt' | 'forbidden' | null {
  if (!isRecord(value)) return null;
  if (['allow', 'prompt', 'forbidden'].includes(String(value.decision)))
    return value.decision as 'allow' | 'prompt' | 'forbidden';
  return value.decision === undefined &&
    Array.isArray(value.matchedRules) &&
    value.matchedRules.length === 0
    ? 'prompt'
    : null;
}

async function policyRules(layers: unknown): Promise<string[] | null> {
  if (!Array.isArray(layers)) return null;
  const files: string[] = [];
  //0.163 config/read lists highest precedence first; native execpolicy loads low to high.
  for (const layer of [...layers].reverse()) {
    if (!isRecord(layer) || !isRecord(layer.name)) return null;
    if (layer.disabledReason != null) continue;
    const source = layer.name;
    let folder: string | undefined;
    if (['packagedDefaults', 'system', 'user'].includes(String(source.type))) {
      if (typeof source.file !== 'string' || !isAbsolute(source.file)) return null;
      folder = dirname(source.file);
    } else if (source.type === 'project') {
      if (typeof source.dotCodexFolder !== 'string' || !isAbsolute(source.dotCodexFolder))
        return null;
      folder = source.dotCodexFolder;
    } else if (source.type !== 'sessionFlags') return null;
    if (!folder) continue;
    let rows;
    try {
      rows = await readdir(join(folder, 'rules'), { withFileTypes: true });
    } catch (e) {
      if (isRecord(e) && e.code === 'ENOENT') continue;
      return null;
    }
    for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!row.name.endsWith('.rules')) continue;
      // Symlink or directory rules have not been qualified.
      if (!row.isFile()) return null;
      files.push(join(folder, 'rules', row.name));
    }
  }
  return files;
}
async function snapshot(
  request: CodexAppRequest,
  options: Options,
  threadId?: string,
  serverVersion?: string | null,
): Promise<Snapshot> {
  const reasons: string[] = [];
  const [raw, listed, requirements] = await Promise.all([
    request('config/read', { cwd: options.cwd, includeLayers: true }),
    request(
      'hooks/list',
      threadId && serverVersion === '0.167.0-alpha.4.1' ? { threadId } : { cwds: [options.cwd] },
    ),
    request('configRequirements/read', {}),
  ]);
  const config = isRecord(raw) && isRecord(raw.config) ? raw.config : {};
  if (!isRecord(raw) || !isRecord(raw.config)) reasons.push('config_unavailable');
  if (options.policy.approvalsReviewer !== 'user' || config.approvals_reviewer !== 'user')
    reasons.push('native_auto_review_unavailable');
  if (!['never', 'on-request', 'untrusted'].includes(String(options.policy.approvalPolicy)))
    reasons.push('approval_policy_unsupported');
  if (
    isRecord(config.features) &&
    (config.features.strict_auto_review === true || config.features.guardian_approval === true)
  )
    reasons.push('strict_auto_review_unavailable');
  // The API does not expose the exec-policy overlay or strict-review state of managed requirements.
  if (!isRecord(requirements) || requirements.requirements != null)
    reasons.push('managed_requirements_unqualified');
  const profile = codexModelProfile(options.policy, options);
  if (!profile) reasons.push('permission_profile_unrepresentable');
  let hooks: Record<string, unknown>[] = [];
  if (
    !isRecord(listed) ||
    !Array.isArray(listed.data) ||
    listed.data.length !== 1 ||
    !isRecord(listed.data[0]) ||
    !Array.isArray(listed.data[0].hooks) ||
    !Array.isArray(listed.data[0].errors) ||
    listed.data[0].errors.length > 0
  )
    reasons.push('hooks_unavailable');
  else hooks = listed.data[0].hooks.filter(isRecord);
  if (hooks.some((h) => h.enabled === true && MODEL_GUARDED_EVENTS.has(String(h.eventName))))
    reasons.push('model_policy_hook_unavailable');
  if (
    hooks.some(
      (h) =>
        h.enabled === true &&
        !GUARDED_EVENTS.has(String(h.eventName)) &&
        !MODEL_GUARDED_EVENTS.has(String(h.eventName)) &&
        !LIFECYCLE_EVENTS.has(String(h.eventName)),
    )
  )
    reasons.push('hook_event_unqualified');
  const rules = await policyRules(isRecord(raw) ? raw.layers : null);
  if (!rules) reasons.push('execpolicy_layers_unqualified');
  if (hooks.some((h) => hookApplies(h, COMMAND_NAMES)))
    reasons.push('command_policy_hook_unavailable');
  const ruleContents: string[] = [];
  for (const file of rules ?? []) {
    try {
      const contents = await readFile(file, 'utf8');
      if (Buffer.byteLength(contents) > 256_000 || ruleContents.length >= 512) {
        reasons.push('execpolicy_size_unqualified');
        break;
      }
      ruleContents.push(contents);
    } catch {
      reasons.push('execpolicy_unavailable');
    }
  }
  const tools: CodexModelTool[] = [];
  const metadata: Record<string, unknown>[] = [];
  if (threadId) {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await request('mcpServerStatus/list', {
        threadId,
        detail: 'toolsAndAuthOnly',
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      if (!isRecord(page) || !Array.isArray(page.data) || ++pages > 20) {
        reasons.push('mcp_inventory_unavailable');
        break;
      }
      for (const row of page.data) {
        if (!isRecord(row) || typeof row.name !== 'string' || !isRecord(row.tools)) {
          reasons.push('mcp_inventory_invalid');
          continue;
        }
        // Tenjin is not available recursively inside its own worker.
        if (row.name === MCP_SERVER_NAME) continue;
        if (row.runtimeStatus === 'disabled') continue;
        if (row.name === 'codex_apps' || row.pluginId != null) {
          if (Object.keys(row.tools).length) reasons.push('app_or_plugin_policy_unqualified');
          continue;
        }
        if (row.runtimeStatus !== 'connected' || row.toolsError != null) {
          reasons.push('mcp_connection_unavailable');
          continue;
        }
        for (const [name, tool] of Object.entries(row.tools)) {
          if (!isRecord(tool) || !isRecord(tool.inputSchema)) {
            reasons.push('mcp_schema_unavailable');
            continue;
          }
          if (approvalMode(config, row.name, name) === null) {
            reasons.push('mcp_policy_unqualified');
            continue;
          }
          if (hooks.some((h) => hookApplies(h, mcpNames(row.name as string, name)))) {
            reasons.push('mcp_policy_hook_unavailable');
            continue;
          }
          tools.push({
            server: row.name,
            name,
            inputSchema: tool.inputSchema,
            ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          });
          metadata.push({ server: row.name, name, annotations: tool.annotations });
        }
      }
      if (page.nextCursor != null && typeof page.nextCursor !== 'string') {
        reasons.push('mcp_cursor_invalid');
        break;
      }
      cursor = page.nextCursor as string | undefined;
    } while (cursor);
  }
  tools.sort((a, b) => `${a.server}:${a.name}`.localeCompare(`${b.server}:${b.name}`));
  metadata.sort((a, b) => `${a.server}:${a.name}`.localeCompare(`${b.server}:${b.name}`));
  return {
    qualified: reasons.length === 0,
    reasons: [...new Set(reasons)],
    tools,
    commands: reasons.length === 0,
    ...(reasons.length === 0 && isRecord(raw)
      ? { instructionConfig: { config, layers: raw.layers } }
      : {}),
    config,
    hooks,
    rules: rules ?? [],
    profile,
    fingerprint: canonicalHash({
      config,
      hooks,
      rules,
      ruleContents,
      tools,
      metadata,
      requirements,
    }),
  };
}
async function withGates<T>(
  options: Options,
  signal: AbortSignal | undefined,
  run: (request: CodexAppRequest, state: Snapshot, threadId: string) => Promise<T>,
): Promise<T | null> {
  const profile = codexModelProfile(options.policy, options);
  const brokerEnv = { ...(options.env ?? process.env) };
  for (const key of [
    'TENJIN_WALLET_PASSPHRASE',
    'DEEPSEEK_API_KEY',
    'TYPESAFE_KEY',
    'TYPESAFE_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
  ])
    delete brokerEnv[key];
  return withAppServer(
    options.home ?? homedir(),
    brokerEnv,
    10_000,
    async (request, serverVersion) => {
      const initial = await snapshot(request, options, undefined, serverVersion);
      if (!initial.qualified) return run(request, initial, '');
      const started = await request('thread/start', {
        ephemeral: true,
        cwd: options.cwd,
        approvalPolicy: options.policy.approvalPolicy,
        approvalsReviewer: options.policy.approvalsReviewer,
        config: {
          // This ephemeral thread only executes tools. The SDK worker receives
          // its separately qualified instruction snapshot; do not broaden its
          // filesystem boundary just to re-read ancestor AGENTS files here.
          project_doc_max_bytes: 0,
          ...(profile ? { default_permissions: profile.name } : {}),
          ...(options.policy.disabledPluginIds?.length
            ? {
                plugins: Object.fromEntries(
                  options.policy.disabledPluginIds.map((id) => [id, { enabled: false }]),
                ),
              }
            : {}),
        },
      });
      if (
        !isRecord(started) ||
        !isRecord(started.thread) ||
        typeof started.thread.id !== 'string' ||
        started.approvalsReviewer !== options.policy.approvalsReviewer ||
        !isDeepStrictEqual(started.approvalPolicy, options.policy.approvalPolicy)
      )
        throw new Error('Codex did not preserve worker policy');
      const state = await snapshot(request, options, started.thread.id, serverVersion);
      // Preserve the qualified native protocol behavior for live rechecks.
      state.serverVersion = serverVersion;
      return run(request, state, started.thread.id);
    },
    {
      cwd: options.cwd,
      signal,
      experimentalApi: true,
      expectedVersion: QUALIFIED_CODEX_MODEL_VERSIONS,
      configOverrides: profile?.overrides,
    },
  );
}
export async function qualifyCodexModelGates(
  options: Options,
): Promise<CodexModelQualification | null> {
  return withGates(options, AbortSignal.timeout(7_000), async (_request, state) => ({
    qualified: state.qualified,
    reasons: state.reasons,
    tools: state.tools,
    commands: state.commands,
    ...(state.instructionConfig ? { instructionConfig: state.instructionConfig } : {}),
  }));
}

/** Native auth/sandbox are reused; approvals are never inferred from the direct-call API. */
export async function withCodexModelGates<T>(
  options: RunOptions,
  fn: (gates: CodexModelGates) => Promise<T>,
): Promise<T | null> {
  const lifetime = new AbortController();
  const cancelled = () => lifetime.abort();
  options.signal.addEventListener('abort', cancelled, { once: true });
  if (options.signal.aborted) cancelled();
  try {
    return await withGates(options, lifetime.signal, async (request, initial, threadId) => {
      if (!initial.qualified)
        throw new Error(`Codex worker policy unavailable: ${initial.reasons.join(', ')}`);
      const live = async (signal: AbortSignal) => {
        signal.throwIfAborted();
        options.signal.throwIfAborted();
        const current = await snapshot(request, options, threadId, initial.serverVersion);
        if (!current.qualified || current.fingerprint !== initial.fingerprint)
          throw new Error('Codex tool policy changed; keep native');
        return current;
      };
      return fn({
        ...initial,
        callMcp: async (server, tool, args, signal) => {
          const stop = () => lifetime.abort();
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
          try {
            const state = await live(signal);
            if (!state.tools.some((t) => t.server === server && t.name === tool))
              throw new Error('MCP tool unavailable');
            const row = await request('mcpServerStatus/list', {
              threadId,
              serverName: server,
              detail: 'toolsAndAuthOnly',
            });
            const data =
              isRecord(row) && Array.isArray(row.data) && isRecord(row.data[0])
                ? row.data[0]
                : null;
            const meta =
              data && isRecord(data.tools) && isRecord(data.tools[tool]) ? data.tools[tool] : null;
            const mode = approvalMode(state.config, server, tool);
            if (!mode || !meta) throw new Error('MCP tool policy unavailable');
            if (
              codexMcpNeedsApproval(mode, meta.annotations) &&
              (!askAllowed(options.policy) ||
                !(await options.ask(`mcp__${server}__${tool}`, args, signal)))
            )
              throw new Error('Native MCP approval required');
            // Re-read after an interactive wait; a policy change revokes the permission.
            await live(signal);
            const result = await request(
              'mcpServer/tool/call',
              { threadId, server, tool, arguments: args },
              60_000,
            );
            if (result === undefined) throw new Error('MCP call uncertain; do not repeat');
            return result;
          } finally {
            signal.removeEventListener('abort', stop);
          }
        },
        command: async (argv, cwd, signal) => {
          const state = await live(signal);
          const root = await realpath(options.cwd),
            where = await realpath(cwd);
          if (
            where !== root ||
            !argv.length ||
            argv.length > 128 ||
            argv.some((v) => !v || v.includes('\0')) ||
            Buffer.byteLength(JSON.stringify(argv)) > 16384
          )
            throw new Error('Unsupported command');
          const codex = resolveCodex(options.env ?? process.env);
          if (!codex) throw new Error('Codex unavailable');
          let allowed = false;
          if (state.rules.length) {
            const checked = await exec(
              codex.cmd,
              [
                ...codex.prefix,
                'execpolicy',
                'check',
                '--resolve-host-executables',
                ...state.rules.flatMap((p) => ['--rules', p]),
                '--',
                ...argv,
              ],
              { cwd, env: options.env ?? process.env, signal, timeout: 5000, maxBuffer: 256_000 },
            );
            const policy: unknown = JSON.parse(checked.stdout);
            const decision = codexExecPolicyDecision(policy);
            if (decision === null) throw new Error('Execpolicy result unavailable');
            if (decision === 'forbidden') throw new Error('Command denied by native execpolicy');
            allowed = decision === 'allow';
          }
          if (
            !allowed &&
            (!askAllowed(options.policy) ||
              !(await options.ask('exec_command', { argv, cwd }, signal)))
          )
            throw new Error('Native command approval required');
          await live(signal);
          const processId = `tenjin-${canonicalHash({ argv, at: Date.now() }).slice(0, 20)}`;
          const abort = () => {
            void request('command/exec/terminate', { processId });
          };
          signal.addEventListener('abort', abort, { once: true });
          try {
            const result = await request(
              'command/exec',
              {
                command: argv,
                cwd,
                processId,
                permissionProfile: state.profile?.name,
                timeoutMs: 30_000,
                outputBytesCap: 256_000,
              },
              35_000,
            );
            signal.throwIfAborted();
            if (
              !isRecord(result) ||
              typeof result.stdout !== 'string' ||
              typeof result.stderr !== 'string' ||
              typeof result.exitCode !== 'number'
            )
              throw new Error('Command result unavailable');
            return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
          } finally {
            signal.removeEventListener('abort', abort);
            await request('command/exec/terminate', { processId });
          }
        },
      });
    });
  } finally {
    options.signal.removeEventListener('abort', cancelled);
    lifetime.abort();
  }
}
