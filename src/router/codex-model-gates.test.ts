import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  codexMcpNeedsApproval,
  codexExecPolicyDecision,
  codexModelProfile,
  qualifyCodexModelGates,
  withCodexModelGates,
  type CodexModelPolicy,
} from './codex-model-gates';
import { withAppServer } from '../lib/codex-app-server';
vi.mock('../lib/codex-app-server', () => ({ withAppServer: vi.fn() }));

const policy: CodexModelPolicy = {
  approvalPolicy: 'on-request',
  approvalsReviewer: 'user',
  sandbox: { type: 'read-only' },
  permissionProfile: {
    type: 'managed',
    file_system: {
      type: 'restricted',
      entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }],
    },
    network: 'restricted',
  },
};
let root: string;
let config: Record<string, unknown>;
let hooks: Record<string, unknown>[];
let tool: Record<string, unknown>;
let requirements: unknown;
let requests: { method: string; params: unknown }[];
let closed: boolean;
let onCall: (() => void) | undefined;
let serverVersion: string | undefined;
const ask = vi.fn(async () => true);
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenjin-codex-gates-'));
  config = { approvals_reviewer: 'user', mcp_servers: { neon: {} } };
  hooks = [];
  requirements = null;
  requests = [];
  closed = false;
  onCall = undefined;
  serverVersion = undefined;
  ask.mockClear();
  tool = {
    name: 'read',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  };
  vi.mocked(withAppServer).mockImplementation(async (_home, _env, _timeout, fn) => {
    try {
      return await fn(async (method, params) => {
        requests.push({ method, params });
        if (method === 'config/read')
          return {
            config: structuredClone(config),
            layers: [{ name: { type: 'user', file: join(root, 'config.toml') } }],
          };
        if (method === 'configRequirements/read') return { requirements };
        if (method === 'hooks/list')
          return { data: [{ cwd: root, hooks, errors: [], warnings: [] }] };
        if (method === 'thread/start')
          return {
            thread: { id: 'owned-ephemeral' },
            approvalPolicy: (params as { approvalPolicy: unknown }).approvalPolicy,
            approvalsReviewer: 'user',
            sandbox: { type: 'readOnly', networkAccess: false },
          };
        if (method === 'mcpServerStatus/list')
          return {
            data: [
              {
                name: 'neon',
                authStatus: 'oAuth',
                runtimeStatus: 'connected',
                toolsError: null,
                tools: { read: tool },
              },
            ],
            nextCursor: null,
          };
        if (method === 'mcpServer/tool/call') {
          onCall?.();
          return { content: [{ type: 'text', text: 'native authenticated read' }] };
        }
        return undefined;
      }, serverVersion);
    } catch {
      return null;
    } finally {
      closed = true;
    }
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const options = () => ({ cwd: root, policy, signal: new AbortController().signal, ask });

describe('Codex worker admission preserves native policy before inference', () => {
  it('qualifies a supported read-only root and reuses native MCP inventory without starting a turn', async () => {
    const q = await qualifyCodexModelGates(options());
    expect(q).toMatchObject({
      qualified: true,
      commands: true,
      tools: [{ server: 'neon', name: 'read' }],
    });
    expect(requests.some((r) => r.method === 'turn/start')).toBe(false);
    expect(requests.some((r) => r.method === 'mcpServer/tool/call')).toBe(false);
    expect(closed).toBe(true);
    expect(q?.instructionConfig).toMatchObject({
      config: { approvals_reviewer: 'user' },
      layers: [{ name: { type: 'user' } }],
    });
  });
  it('uses current Desktop thread-scoped hook lookup without mixing exclusive parameters', async () => {
    serverVersion = '0.167.0-alpha.4.1';
    expect(await qualifyCodexModelGates(options())).toMatchObject({ qualified: true });
    const calls = requests.filter((r) => r.method === 'hooks/list');
    expect(calls.map((r) => r.params)).toEqual([{ cwds: [root] }, { threadId: 'owned-ephemeral' }]);
    expect(requests.find((r) => r.method === 'thread/start')?.params).toMatchObject({
      config: { project_doc_max_bytes: 0 },
    });
  });
  it.each(['preModelRequest', 'postModelRequest', 'futurePolicyEvent'])(
    'keeps an enabled %s guard native instead of skipping it',
    async (eventName) => {
      hooks = [{ eventName, enabled: true, matcher: 'unrelated-model', command: 'guard' }];
      expect(await qualifyCodexModelGates(options())).toMatchObject({ qualified: false });
      expect(requests.some((r) => r.method === 'thread/start')).toBe(false);
      hooks[0]!.enabled = false;
      expect(await qualifyCodexModelGates(options())).toMatchObject({ qualified: true });
    },
  );
  it.each(['auto_review', 'guardian_subagent'])(
    'does not replace native %s with an unreviewed direct call',
    async (reviewer) => {
      const q = await qualifyCodexModelGates({
        ...options(),
        policy: { ...policy, approvalsReviewer: reviewer },
      });
      expect(q).toMatchObject({
        qualified: false,
        reasons: expect.arrayContaining(['native_auto_review_unavailable']),
      });
      expect(requests.some((r) => r.method === 'thread/start')).toBe(false);
    },
  );
  it('refuses unknown managed requirements whose execution rules are not exposed', async () => {
    requirements = { autoReview: {} };
    expect(await qualifyCodexModelGates(options())).toMatchObject({
      qualified: false,
      reasons: expect.arrayContaining(['managed_requirements_unqualified']),
    });
  });
  it('replays captured path restrictions and refuses unknown permission semantics', () => {
    const p = codexModelProfile(policy, { cwd: root, dataDir: join(root, 'wallet') });
    expect(p).not.toBeNull();
    expect(
      p!.overrides.some((v) => v.includes(JSON.stringify(join(root, 'wallet')) + ' = "deny"')),
    ).toBe(true);
    const profile = structuredClone(policy.permissionProfile) as {
      file_system: { entries: unknown[] };
    };
    profile.file_system.entries.push({
      path: { type: 'path', path: join(root, 'protected') },
      access: 'deny',
    });
    expect(
      codexModelProfile({ ...policy, permissionProfile: profile }, { cwd: root })?.overrides.some(
        (v) => v.includes(JSON.stringify(join(root, 'protected')) + ' = "deny"'),
      ),
    ).toBe(true);
    profile.file_system.entries.push({ path: { type: 'futurePathKind' }, access: 'read' });
    expect(codexModelProfile({ ...policy, permissionProfile: profile }, { cwd: root })).toBeNull();
  });
  it('retains current Desktop optional read restrictions without inventing optional write grants', () => {
    const profile = structuredClone(policy.permissionProfile) as {
      file_system: { entries: unknown[] };
    };
    const entry = {
      path: { type: 'path', path: join(root, 'native-protected') },
      access: 'read',
      missing_path_behavior: 'skip',
    };
    profile.file_system.entries.push(entry);
    expect(
      codexModelProfile({ ...policy, permissionProfile: profile }, { cwd: root })?.overrides.some(
        (v) => v.includes(JSON.stringify(entry.path.path) + ' = "read"'),
      ),
    ).toBe(true);
    entry.access = 'write';
    expect(codexModelProfile({ ...policy, permissionProfile: profile }, { cwd: root })).toBeNull();
    entry.access = 'read';
    entry.missing_path_behavior = 'unknown';
    expect(codexModelProfile({ ...policy, permissionProfile: profile }, { cwd: root })).toBeNull();
  });
  it('keeps an applicable Neon guard native but does not reject unrelated hook matchers', async () => {
    hooks = [
      {
        eventName: 'preToolUse',
        enabled: true,
        matcher: 'mcp__neon__read',
        handlerType: 'command',
        command: 'guard',
      },
    ];
    expect(await qualifyCodexModelGates(options())).toMatchObject({
      qualified: false,
      reasons: expect.arrayContaining(['mcp_policy_hook_unavailable']),
    });
    hooks[0]!.matcher = 'Agent|spawn_agent';
    expect(await qualifyCodexModelGates(options())).toMatchObject({ qualified: true });
  });
  it('ignores only the trusted exact Tenjin discovery hook, never a changed command guard', async () => {
    hooks = [
      {
        eventName: 'preToolUse',
        enabled: true,
        matcher: 'webrun',
        key: 'fixture:pre_tool_use:0:0',
        sourcePath: join(root, 'hooks', 'hooks.json'),
        pluginId: 'tenjin@tenjin',
        trustStatus: 'trusted',
        handlerType: 'mcpTool',
        server: 'router',
        tool: 'hook',
      },
    ];
    expect(await qualifyCodexModelGates(options())).toMatchObject({ qualified: true });
    hooks[0]!.matcher = '.*';
    expect(await qualifyCodexModelGates(options())).toMatchObject({ qualified: false });
  });
});

it('requires approval for native execpolicy no-match output and rejects malformed decisions', () => {
  expect(codexExecPolicyDecision({ matchedRules: [] })).toBe('prompt');
  expect(codexExecPolicyDecision({ decision: 'allow', matchedRules: [] })).toBe('allow');
  expect(codexExecPolicyDecision({ decision: 'forbidden', matchedRules: [] })).toBe('forbidden');
  expect(codexExecPolicyDecision({})).toBeNull();
  expect(codexExecPolicyDecision({ decision: 'unknown', matchedRules: [] })).toBeNull();
});

describe('MCP direct-call adapter authorization', () => {
  it('forwards an enabled read-only tool through native auth without an unnecessary prompt', async () => {
    const result = await withCodexModelGates(options(), (g) =>
      g.callMcp('neon', 'read', { branch: 'preview' }, options().signal),
    );
    expect(result).toMatchObject({ content: [{ text: 'native authenticated read' }] });
    expect(ask).not.toHaveBeenCalled();
    expect(closed).toBe(true);
  });
  it('honors a per-tool prompt even when the tool claims read-only', async () => {
    config.mcp_servers = { neon: { tools: { read: { approval_mode: 'prompt' } } } };
    const result = await withCodexModelGates(options(), (g) =>
      g.callMcp('neon', 'read', {}, options().signal),
    );
    expect(result).not.toBeNull();
    expect(ask).toHaveBeenCalledWith('mcp__neon__read', {}, expect.any(AbortSignal));
  });
  it('never lets a user denial reach the authenticated tool', async () => {
    tool.annotations = { destructiveHint: true, readOnlyHint: true };
    ask.mockResolvedValueOnce(false);
    expect(
      await withCodexModelGates(options(), (g) => g.callMcp('neon', 'read', {}, options().signal)),
    ).toBeNull();
    expect(requests.some((r) => r.method === 'mcpServer/tool/call')).toBe(false);
  });
  it('does not interpret never plus a restricted filesystem as blanket MCP approval', async () => {
    tool.annotations = {};
    const opts = { ...options(), policy: { ...policy, approvalPolicy: 'never' } };
    expect(
      await withCodexModelGates(opts, (g) => g.callMcp('neon', 'read', {}, opts.signal)),
    ).toBeNull();
    expect(ask).not.toHaveBeenCalled();
    expect(requests.some((r) => r.method === 'mcpServer/tool/call')).toBe(false);
  });
  it('rechecks config after an approval wait so revoked access does not execute', async () => {
    tool.annotations = {};
    ask.mockImplementationOnce(async () => {
      config.mcp_servers = { neon: { disabled_tools: ['read'] } };
      return true;
    });
    expect(
      await withCodexModelGates(options(), (g) => g.callMcp('neon', 'read', {}, options().signal)),
    ).toBeNull();
    expect(requests.some((r) => r.method === 'mcpServer/tool/call')).toBe(false);
  });
  it('unknown tool names never reach the native client', async () => {
    expect(
      await withCodexModelGates(options(), (g) => g.callMcp('neon', 'write', {}, options().signal)),
    ).toBeNull();
    expect(requests.some((r) => r.method === 'mcpServer/tool/call')).toBe(false);
  });
  it('preserves exact0.163 destructive/read-only precedence and writes/approve modes', () => {
    expect(codexMcpNeedsApproval('auto', { destructiveHint: true, readOnlyHint: true })).toBe(true);
    expect(codexMcpNeedsApproval('writes', { readOnlyHint: true })).toBe(false);
    expect(codexMcpNeedsApproval('approve', {})).toBe(false);
  });
  it('detects policy rule contents changing during an approval wait', async () => {
    await mkdir(join(root, 'rules'));
    const path = join(root, 'rules', 'default.rules');
    await writeFile(path, 'prefix_rule(pattern=["safe"], decision="allow")');
    tool.annotations = {};
    ask.mockImplementationOnce(async () => {
      await writeFile(path, 'prefix_rule(pattern=["safe"], decision="forbidden")');
      return true;
    });
    expect(
      await withCodexModelGates(options(), (g) => g.callMcp('neon', 'read', {}, options().signal)),
    ).toBeNull();
    expect(requests.some((r) => r.method === 'mcpServer/tool/call')).toBe(false);
  });
});
