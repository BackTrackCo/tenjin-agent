import { basename, resolve } from 'node:path';
import type { ResolvedSettings } from '@anthropic-ai/claude-agent-sdk/core';
import { isRecord } from '../lib/guards';
import { MODEL_WORKER_CREDENTIAL_KEYS } from './model-worker-privacy';
import { compactWindowTokens, MODEL_NATIVE_TEXT_BYTES, MODEL_OUTPUT_TOKENS } from './model-limits';

export const CLAUDE_DEEPSEEK_MODEL = 'deepseek-flash';
// Claude strips this native context hint before calling the fixed Flash provider.
export const CLAUDE_DEEPSEEK_WORKER_MODEL = `${CLAUDE_DEEPSEEK_MODEL}[1m]`;
export type ClaudeWorkerPermissionMode =
  'default' | 'acceptEdits' | 'auto' | 'dontAsk' | 'bypassPermissions';
// A plan-mode parent stays native; a bypass parent's worker keeps the sandbox, and the wallet and keychain walls.
const MODES = new Set(['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
const CLEARED_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDECODE',
  ...MODEL_WORKER_CREDENTIAL_KEYS.filter(
    (key) => key !== 'ANTHROPIC_API_KEY' && key !== 'ANTHROPIC_AUTH_TOKEN',
  ),
] as const;
const REPLACED_CREDENTIALS = new Set<string>([...CLEARED_ENV, ...MODEL_WORKER_CREDENTIAL_KEYS]);

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

/** These native contexts bind credentials to their host; a local worker cannot replace them. */
export function claudeWorkerAuthCompatible(
  env: NodeJS.ProcessEnv,
  settingsEnv: Record<string, string> = {},
): boolean {
  return [env, settingsEnv].every((source) => {
    const selectedByFlag = [
      'CLAUDE_CODE_REMOTE',
      'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
      'CLAUDE_CODE_REMOTE_TOOLS_PIN_STORED_LOGIN',
      'CLAUDE_CODE_USE_ANTHROPIC_AWS',
      'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
      'CLAUDE_CODE_USE_MANTLE',
      'CLAUDE_CODE_USE_GATEWAY',
    ].some((key) => {
      const value = source[key];
      return Boolean(value && !/^(?:0|false)$/i.test(value.trim()));
    });
    const boundByHost = [
      'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
      'CLAUDE_CODE_HOST_CREDS_FILE',
      'ANTHROPIC_UNIX_SOCKET',
    ].some((key) => Boolean(source[key]));
    return !selectedByFlag && !boundByHost;
  });
}

/** Native helper auth does not approve or change any key in the user's saved profile. */
export function claudeDeepSeekWorkerApiKeyHelper(platform = process.platform): string {
  // The command is fixed. Its value comes only from the worker's pinned env,
  // rather than placing another copy of the bridge secret in command text.
  return platform === 'win32' ? 'echo %ANTHROPIC_API_KEY%' : `printf '%s' "$ANTHROPIC_API_KEY"`;
}

/**
 * THE PERSON'S OWN WAYS TO TURN THINKING OFF IN CLAUDE CODE, cleared for the worker: with
 * either set (`MAX_THINKING_TOKENS=0`, say) Claude Code sends its turns with no
 * `thinking` field. An empty value in the worker's flag settings clears one from the
 * person's settings env and from the process env alike (checked on Claude Code 2.1.328).
 * Not part of the fixed provider env a managed policy may not set: a policy that sets one
 * keeps its offers, and the bridge still sends the worker's turns with thinking on.
 */
export const CLAUDE_WORKER_THINKING_ENV = {
  MAX_THINKING_TOKENS: '',
  CLAUDE_CODE_DISABLE_THINKING: '',
} as const;

/** All overrides belong to the disposable worker, including its native auto classifier. */
export function claudeDeepSeekWorkerEnv(
  parent: NodeJS.ProcessEnv,
  baseUrl: string,
  token: string,
  outputCap?: number,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...parent,
    ...claudeDeepSeekWorkerSettingsEnv(baseUrl, token, outputCap),
  };
  for (const key of [...CLEARED_ENV, ...Object.keys(CLAUDE_WORKER_THINKING_ENV)])
    env[key] = undefined;
  return env;
}

/** The SDK flag layer outranks user/project/local settings, but never managed policy.
 * Empty values must survive JSON serialization to clear lower-tier credentials. */
export function claudeDeepSeekWorkerSettingsEnv(
  baseUrl: string,
  token: string,
  /** The reply cap of the job's own model calls: where its compaction triggers follows it. */
  outputCap?: number,
): Record<string, string> {
  return {
    ...Object.fromEntries(CLEARED_ENV.map((key) => [key, ''])),
    ANTHROPIC_API_KEY: token,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_MODEL: CLAUDE_DEEPSEEK_WORKER_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_DEEPSEEK_WORKER_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_DEEPSEEK_WORKER_MODEL,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_DEEPSEEK_MODEL,
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    CLAUDE_CODE_SUBAGENT_MODEL: CLAUDE_DEEPSEEK_MODEL,
    CLAUDE_CODE_AUTO_MODE_MODEL: CLAUDE_DEEPSEEK_MODEL,
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compactWindowTokens(outputCap)),
    // Claude Code asks 32,000 by default; it clamps a larger value to 128,000.
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(MODEL_OUTPUT_TOKENS),
    // Native's explicit false disable flag otherwise forces memory on ahead of settings.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    // A native subagent uses the parent's MCP servers as they are and waits for none.
    // Without this the worker's first turn waits for the slowest server it is still
    // starting; with it, a server that connects later announces its tools and tool
    // search loads them, as in a session whose servers are still connecting.
    CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0',
    TENJIN_MODEL_WORKER: '1',
    ANTHROPIC_MAX_RETRIES: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // No ENABLE_TOOL_SEARCH: tool search stays as the person's session has it, and the
    // bridge serves its deferred tools (`workerMessages`).
  };
}

export function claudeManagedProviderCompatible(
  resolved: Partial<Pick<ResolvedSettings, 'sources'>>,
): boolean {
  const fixed = claudeDeepSeekWorkerSettingsEnv('', '');
  return !(resolved.sources ?? []).some(
    ({ source, settings }) =>
      source === 'managed' &&
      (settings.autoMemoryEnabled === true ||
        settings.apiKeyHelper !== undefined ||
        settings.forceLoginMethod !== undefined ||
        settings.forceLoginOrgUUID !== undefined ||
        settings.forceLoginGatewayUrl !== undefined ||
        settings.allowedProviders !== undefined ||
        Object.keys(settings.env ?? {}).some((key) => Object.hasOwn(fixed, key))),
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
    if (Buffer.byteLength(config) > MODEL_NATIVE_TEXT_BYTES) return false;
    for (const match of config.matchAll(
      /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    )) {
      const key = match[1] ?? match[2];
      if (key && REPLACED_CREDENTIALS.has(key)) return false;
    }
  }
  return true;
}
