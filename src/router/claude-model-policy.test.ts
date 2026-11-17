import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  assertClaudeWorkerMode,
  claudeDeepSeekWorkerEnv,
  claudeDeepSeekWorkerApiKeyHelper,
  claudeDeepSeekWorkerSettingsEnv,
  claudeManagedProviderCompatible,
  claudeMcpProviderCompatible,
  claudeWorkerPermissionMode,
  claudeWorkerAuthCompatible,
  observeClaudeWorkerMode,
} from './claude-model-policy';

const session = {
  sessionId: 'owned',
  cwd: '/repo',
  transcript: '/home/.claude/projects/repo/owned.jsonl',
};
const hook = {
  hook_event_name: 'PreToolUse',
  session_id: 'owned',
  cwd: '/repo',
  transcript_path: session.transcript,
};

it.each(['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'] as const)(
  'preserves the owned native %s mode exactly',
  (mode) => {
    expect(observeClaudeWorkerMode({ ...hook, permission_mode: mode }, session)).toEqual({ mode });
    expect(assertClaudeWorkerMode(mode, mode)).toBe(mode);
  },
);

it.each([undefined, 'plan', 'acceptAll', {}, 1])(
  'keeps unsupported or missing mode native: %s',
  (mode) => {
    expect(claudeWorkerPermissionMode(mode)).toBeNull();
    expect(observeClaudeWorkerMode({ ...hook, permission_mode: mode }, session)).toEqual({});
    expect(() => assertClaudeWorkerMode(mode, 'auto')).toThrow(/unavailable/);
  },
);

it('never lets a child, foreign session or model-supplied capture input select parent mode', () => {
  expect(
    observeClaudeWorkerMode({ ...hook, permission_mode: 'auto', agent_id: 'child' }, session),
  ).toBeNull();
  expect(
    observeClaudeWorkerMode({ ...hook, permission_mode: 'auto', session_id: 'foreign' }, session),
  ).toBeNull();
  expect(
    observeClaudeWorkerMode({ ...hook, tool_input: { permission_mode: 'auto' } }, session),
  ).toEqual({});
  expect(
    observeClaudeWorkerMode(
      {
        ...hook,
        permission_mode: 'auto',
        transcript_path: '/home/.claude/projects/repo/agent-child.jsonl',
      },
      session,
    ),
  ).toEqual({});
  expect(() => assertClaudeWorkerMode('default', 'auto')).toThrow(/changed/);
});

it('keeps provider, aliases and the native auto classifier inside the disposable worker', () => {
  const parent = {
    ANTHROPIC_MODEL: 'opus',
    ANTHROPIC_BASE_URL: 'https://parent.invalid',
    CLAUDE_CODE_OAUTH_TOKEN: 'parent-token',
    CLAUDE_CODE_AUTO_MODE_SERVER: '1',
    TENJIN_WALLET_PASSPHRASE: 'wallet-secret',
    DEEPSEEK_API_KEY: 'provider-secret',
    DEEPSEEK_KEY: 'provider-alias-secret',
    CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
    OPENAI_API_KEY: 'other-provider-secret',
    TYPESAFE_KEY: 'router-secret',
    NEON_API_KEY: 'mcp-secret',
  };
  const env = claudeDeepSeekWorkerEnv(parent, 'http://127.0.0.1:1234', 'worker-token');
  expect(env).toMatchObject({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
    ANTHROPIC_API_KEY: 'worker-token',
    ANTHROPIC_AUTH_TOKEN: 'worker-token',
    ANTHROPIC_MODEL: 'deepseek-flash[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-flash[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-flash[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash',
    CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-flash',
    CLAUDE_CODE_AUTO_MODE_MODEL: 'deepseek-flash',
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
    // The most the bridge and the router take; Claude Code asks 32,000 unless told.
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '65536',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
  });
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(env.TENJIN_WALLET_PASSPHRASE).toBeUndefined();
  expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  expect(env.DEEPSEEK_KEY).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.TYPESAFE_KEY).toBeUndefined();
  expect(env.NEON_API_KEY).toBe('mcp-secret');
  expect(parent.ANTHROPIC_MODEL).toBe('opus');
  expect(parent.ANTHROPIC_BASE_URL).toBe('https://parent.invalid');
  expect(parent.CLAUDE_CODE_OAUTH_TOKEN).toBe('parent-token');
  expect(parent.CLAUDE_CODE_AUTO_MODE_SERVER).toBe('1');
  expect(parent.DEEPSEEK_KEY).toBe('provider-alias-secret');
  expect(parent.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop');
});

it('pins the native settings flag layer and clears inherited provider credentials in JSON', () => {
  const env = JSON.parse(
    JSON.stringify(claudeDeepSeekWorkerSettingsEnv('http://127.0.0.1:1234', 'worker-token')),
  );
  expect(env).toMatchObject({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1234',
    ANTHROPIC_API_KEY: 'worker-token',
    ANTHROPIC_MODEL: 'deepseek-flash[1m]',
    CLAUDE_CODE_AUTO_MODE_MODEL: 'deepseek-flash',
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
    CLAUDE_CODE_USE_BEDROCK: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    DEEPSEEK_API_KEY: '',
    DEEPSEEK_KEY: '',
    OPENAI_API_KEY: '',
    TYPESAFE_KEY: '',
    TYPESAFE_API_KEY: '',
    TENJIN_WALLET_KEY: '',
    TENJIN_WALLET_PASSPHRASE: '',
  });
  expect(env).not.toHaveProperty('NEON_API_KEY');
});

it('reads the generated worker credential without embedding it in the helper command', async () => {
  const parent = { ANTHROPIC_API_KEY: 'parent-key' };
  const token = 'ab'.repeat(32);
  const env = claudeDeepSeekWorkerEnv(parent, 'http://127.0.0.1', token);
  const command = claudeDeepSeekWorkerApiKeyHelper();
  const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  const { stdout } = await promisify(execFile)(executable, args, { env });
  expect(stdout.trimEnd()).toBe(token);
  expect(command).not.toContain(token);
  expect(parent.ANTHROPIC_API_KEY).toBe('parent-key');
});

it.each([
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_REMOTE_TOOLS_PIN_STORED_LOGIN',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
])('keeps host-bound authentication native without clearing %s', (key) => {
  for (const value of ['1', 'true', 'unknown-host-selection']) {
    expect(claudeWorkerAuthCompatible({ [key]: value })).toBe(false);
    expect(claudeWorkerAuthCompatible({}, { [key]: value })).toBe(false);
  }
  expect(claudeDeepSeekWorkerEnv({ [key]: 'true' }, 'http://127.0.0.1', 'worker-token')[key]).toBe(
    'true',
  );
});

it.each([
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_REMOTE_TOOLS_PIN_STORED_LOGIN',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
])('does not reject ordinary worker authentication for an explicitly disabled %s', (key) => {
  for (const value of ['0', 'false', 'FALSE', ' 0 ']) {
    expect(claudeWorkerAuthCompatible({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', [key]: value })).toBe(
      true,
    );
    expect(claudeWorkerAuthCompatible({}, { [key]: value })).toBe(true);
  }
});

it('never lets a false flag hide another host authentication selection', () => {
  expect(
    claudeWorkerAuthCompatible(
      { CLAUDE_CODE_USE_GATEWAY: 'false' },
      { CLAUDE_CODE_USE_GATEWAY: 'true' },
    ),
  ).toBe(false);
  expect(
    claudeWorkerAuthCompatible({ CLAUDE_CODE_REMOTE: 'true' }, { CLAUDE_CODE_REMOTE: '0' }),
  ).toBe(false);
  expect(
    claudeWorkerAuthCompatible({
      CLAUDE_CODE_REMOTE: 'false',
      CLAUDE_CODE_USE_GATEWAY: 'unknown-host-selection',
    }),
  ).toBe(false);
});

it.each(['CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_HOST_CREDS_FILE', 'ANTHROPIC_UNIX_SOCKET'])(
  'keeps a native host credential binding unchanged: %s',
  (key) => {
    for (const value of ['bound-by-host', '0', 'false']) {
      expect(claudeWorkerAuthCompatible({ [key]: value })).toBe(false);
      expect(claudeWorkerAuthCompatible({}, { [key]: value })).toBe(false);
    }
  },
);

it.each(['claude-desktop', 'claude-desktop-3p', 'local-agent', 'claude-vscode', 'sdk-ts'])(
  'can identify the separate SDK worker without changing the %s parent',
  (entrypoint) => {
    const parent = { CLAUDE_CODE_ENTRYPOINT: entrypoint, CLAUDE_CONFIG_DIR: '/normal/.claude' };
    expect(claudeWorkerAuthCompatible(parent)).toBe(true);
    expect(claudeDeepSeekWorkerEnv(parent, 'http://127.0.0.1', 'worker-token')).toMatchObject({
      CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
      CLAUDE_CONFIG_DIR: '/normal/.claude',
    });
    expect(parent.CLAUDE_CODE_ENTRYPOINT).toBe(entrypoint);
  },
);

it.each([
  ['autoMemoryEnabled', true],
  ['apiKeyHelper', '/managed/read-token'],
  ['forceLoginMethod', 'claudeai'],
  ['forceLoginOrgUUID', '9ee71865-25b6-4384-9ccd-0cdfdf9afaa3'],
  ['forceLoginGatewayUrl', 'https://managed.invalid'],
  ['allowedProviders', ['anthropic', 'customEndpoint']],
  ['allowedProviders', []],
])('does not replace a managed authentication control: %s', (key, value) => {
  expect(
    claudeManagedProviderCompatible({
      sources: [{ source: 'managed', settings: { [key as string]: value } }],
    } as never),
  ).toBe(false);
});

it('preserves user and project provider settings below the fixed worker flag layer', () => {
  expect(
    claudeManagedProviderCompatible({
      sources: [
        { source: 'user', settings: { env: { ANTHROPIC_BASE_URL: 'https://parent.invalid' } } },
        { source: 'project', settings: { env: { ANTHROPIC_MODEL: 'parent-model' } } },
        { source: 'managed', settings: { env: { NEON_API_KEY: 'mcp-auth' } } },
      ],
    }),
  ).toBe(true);
  expect(
    claudeManagedProviderCompatible({
      sources: [{ source: 'managed', settings: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } } }],
    }),
  ).toBe(false);
});

it('keeps declared MCP dependencies on removed provider credentials native', () => {
  expect(
    claudeMcpProviderCompatible([{ name: 'foreign', config: { env: { OPENAI_API_KEY: '' } } }]),
  ).toBe(false);
  expect(
    claudeMcpProviderCompatible([{ name: 'foreign', config: { args: ['${DEEPSEEK_API_KEY}'] } }]),
  ).toBe(false);
  expect(
    claudeMcpProviderCompatible([{ name: 'foreign', config: { args: ['${DEEPSEEK_KEY}'] } }]),
  ).toBe(false);
  expect(
    claudeMcpProviderCompatible([
      { name: 'foreign', config: { headers: { Authorization: 'Bearer $TYPESAFE_KEY' } } },
    ]),
  ).toBe(false);
  expect(claudeMcpProviderCompatible(undefined)).toBe(false);
  expect(
    claudeMcpProviderCompatible([
      {
        name: 'Neon',
        status: 'needs-auth',
        config: { type: 'http', url: 'https://mcp.neon.invalid/mcp' },
      },
      {
        name: 'foreign',
        config: { env: { OPENAI_API_KEY: 'explicit-mcp-auth', NEON_API_KEY: 'unrelated' } },
      },
      { name: 'opaque', config: { auth: { opaque: true } } },
      { name: 'disabled', status: 'disabled', config: { env: { OPENAI_API_KEY: '' } } },
    ]),
  ).toBe(true);
});

it('excludes the inherited wallet signer and overrides native forced-on auto memory only in the worker', () => {
  const parent = {
    TENJIN_WALLET_KEY: 'synthetic-wallet-key',
    TENJIN_WALLET_PASSPHRASE: 'synthetic-wallet-passphrase',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    NEON_API_KEY: 'ordinary-mcp-key',
  };
  const child = claudeDeepSeekWorkerEnv(parent, 'http://127.0.0.1', 'worker-token');
  expect(child.TENJIN_WALLET_KEY).toBeUndefined();
  expect(child.TENJIN_WALLET_PASSPHRASE).toBeUndefined();
  expect(child.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
  expect(child.NEON_API_KEY).toBe('ordinary-mcp-key');
  expect(parent.TENJIN_WALLET_KEY).toBe('synthetic-wallet-key');
  expect(parent.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
  expect(
    claudeManagedProviderCompatible({
      sources: [{ source: 'managed', settings: { env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' } } }],
    } as never),
  ).toBe(false);
});

it.each(['TENJIN_WALLET_KEY', 'TENJIN_WALLET_PASSPHRASE'])(
  'keeps a foreign MCP dependent on inherited %s native',
  (key) => {
    expect(
      claudeMcpProviderCompatible([{ status: 'connected', config: { env: { [key]: '' } } }]),
    ).toBe(false);
    expect(
      claudeMcpProviderCompatible([{ status: 'connected', config: { args: ['$' + key] } }]),
    ).toBe(false);
  },
);

it("leaves tool search as the person's session has it, a managed setting included", () => {
  // Failure caught: every worker request carrying every tool schema, where the session
  // loads MCP tools on demand (the proxy takes 256 tools at most), and a managed tool
  // search setting keeping the work native because the worker overrode it.
  const url = 'http://127.0.0.1:1234';
  expect(claudeDeepSeekWorkerSettingsEnv(url, 'worker-token')).not.toHaveProperty(
    'ENABLE_TOOL_SEARCH',
  );
  expect(
    claudeDeepSeekWorkerEnv({ ENABLE_TOOL_SEARCH: 'auto:5' }, url, 'worker-token')
      .ENABLE_TOOL_SEARCH,
  ).toBe('auto:5');
  expect(
    claudeManagedProviderCompatible({
      sources: [{ source: 'managed', settings: { env: { ENABLE_TOOL_SEARCH: 'true' } } }],
    } as never),
  ).toBe(true);
});
