import { basename, resolve } from 'node:path';
import type { ResolvedSettings } from '@anthropic-ai/claude-agent-sdk/core';
import { isRecord } from '../lib/guards';

export const CLAUDE_DEEPSEEK_MODEL = 'deepseek-flash';
export type ClaudeWorkerPermissionMode = 'default' | 'acceptEdits' | 'auto' | 'dontAsk';
const MODES = new Set(['default', 'acceptEdits', 'auto', 'dontAsk']);
const CLEARED_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDECODE',
  'TENJIN_WALLET_PASSPHRASE',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'TYPESAFE_KEY',
  'TYPESAFE_API_KEY',
] as const;
const REPLACED_CREDENTIALS = new Set<string>([
  ...CLEARED_ENV,
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
]);

export function claudeWorkerPermissionMode(value: unknown): ClaudeWorkerPermissionMode | null {
  return typeof value === 'string' && MODES.has(value)
    ? (value as ClaudeWorkerPermissionMode)
    : null;
}

/** Called only after native hook admission, never on the model's capture arguments. */
export function observeClaudeWorkerMode(
  event: Record<string, unknown>,
  session: { sessionId: string; cwd: string; transcript: string },
): { mode?: ClaudeWorkerPermissionMode } | null {
  if (
    event.session_id !== session.sessionId ||
    event.agent_id ||
    !['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(
      String(event.hook_event_name),
    )
  )
    return null;
  if (
    typeof event.transcript_path !== 'string' ||
    basename(event.transcript_path) !== `${session.sessionId}.jsonl` ||
    resolve(event.transcript_path) !== resolve(session.transcript) ||
    typeof event.cwd !== 'string' ||
    resolve(event.cwd) !== resolve(session.cwd)
  )
    return {};
  const mode = claudeWorkerPermissionMode(event.permission_mode);
  return mode ? { mode } : {};
}

export function assertClaudeWorkerMode(
  expected: unknown,
  current: unknown,
): ClaudeWorkerPermissionMode {
  const mode = claudeWorkerPermissionMode(expected);
  if (!mode || claudeWorkerPermissionMode(current) !== mode)
    throw new Error('Owned Claude permission mode changed or is unavailable; keep native');
  return mode;
}

/** All overrides belong to the disposable worker, including its native auto classifier. */
export function claudeDeepSeekWorkerEnv(
  parent: NodeJS.ProcessEnv,
  baseUrl: string,
  token: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parent,
    ...claudeDeepSeekWorkerSettingsEnv(baseUrl, token),
  };
  for (const key of CLEARED_ENV) env[key] = undefined;
  return env;
}

/** The SDK flag layer outranks user/project/local settings, but never managed policy.
 * Empty values must survive JSON serialization to clear lower-tier credentials. */
export function claudeDeepSeekWorkerSettingsEnv(
  baseUrl: string,
  token: string,
): Record<string, string> {
  return {
    ...Object.fromEntries(CLEARED_ENV.map((key) => [key, ''])),
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_MODEL: CLAUDE_DEEPSEEK_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_DEEPSEEK_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_DEEPSEEK_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_DEEPSEEK_MODEL,
    CLAUDE_CODE_SUBAGENT_MODEL: CLAUDE_DEEPSEEK_MODEL,
    CLAUDE_CODE_AUTO_MODE_MODEL: CLAUDE_DEEPSEEK_MODEL,
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    TENJIN_MODEL_WORKER: '1',
    ANTHROPIC_MAX_RETRIES: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ENABLE_TOOL_SEARCH: 'false',
  };
}

export function claudeManagedProviderCompatible(
  resolved: Partial<Pick<ResolvedSettings, 'sources'>>,
): boolean {
  const fixed = claudeDeepSeekWorkerSettingsEnv('', '');
  return !(resolved.sources ?? []).some(
    ({ source, settings }) =>
      source === 'managed' &&
      Object.keys(settings.env ?? {}).some((key) => Object.hasOwn(fixed, key)),
  );
}

/** Read native configuration only; never invoke an MCP tool or rewrite its authentication. */
export function claudeMcpProviderCompatible(statuses: unknown): boolean {
  if (!Array.isArray(statuses)) return false;
  for (const status of statuses) {
    if (!isRecord(status)) return false;
    if (status.status === 'disabled' || !isRecord(status.config)) continue;
    if (isRecord(status.config.env))
      for (const [key, value] of Object.entries(status.config.env))
        if (REPLACED_CREDENTIALS.has(key) && (typeof value !== 'string' || !value.trim()))
          return false;
    let config: string;
    try {
      config = JSON.stringify(status.config);
    } catch {
      return false;
    }
    if (Buffer.byteLength(config) > 256_000) return false;
    for (const match of config.matchAll(
      /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    )) {
      const key = match[1] ?? match[2];
      if (key && REPLACED_CREDENTIALS.has(key)) return false;
    }
  }
  return true;
}
