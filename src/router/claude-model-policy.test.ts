import { expect, it } from 'vitest';
import {
  assertClaudeWorkerMode,
  claudeDeepSeekWorkerEnv,
  claudeDeepSeekWorkerSettingsEnv,
  claudeManagedProviderCompatible,
  claudeMcpProviderCompatible,
  claudeWorkerPermissionMode,
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

it.each(['default', 'acceptEdits', 'auto', 'dontAsk'] as const)(
  'preserves the owned native %s mode exactly',
  (mode) => {
    expect(observeClaudeWorkerMode({ ...hook, permission_mode: mode }, session)).toEqual({ mode });
    expect(assertClaudeWorkerMode(mode, mode)).toBe(mode);
  },
);

it.each([undefined, 'plan', 'bypassPermissions', 'acceptAll', {}, 1])(
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
  });
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(env.TENJIN_WALLET_PASSPHRASE).toBeUndefined();
  expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.TYPESAFE_KEY).toBeUndefined();
  expect(env.NEON_API_KEY).toBe('mcp-secret');
  expect(parent.ANTHROPIC_MODEL).toBe('opus');
  expect(parent.ANTHROPIC_BASE_URL).toBe('https://parent.invalid');
  expect(parent.CLAUDE_CODE_OAUTH_TOKEN).toBe('parent-token');
  expect(parent.CLAUDE_CODE_AUTO_MODE_SERVER).toBe('1');
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
    OPENAI_API_KEY: '',
    TYPESAFE_KEY: '',
    TYPESAFE_API_KEY: '',
    TENJIN_WALLET_PASSPHRASE: '',
  });
  expect(env).not.toHaveProperty('NEON_API_KEY');
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
