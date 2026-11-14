import { basename, resolve } from 'node:path';

export const CLAUDE_DEEPSEEK_MODEL = 'deepseek-flash';
export type ClaudeWorkerPermissionMode = 'default' | 'acceptEdits' | 'auto' | 'dontAsk';
const MODES = new Set(['default', 'acceptEdits', 'auto', 'dontAsk']);

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
  return {
    ...parent,
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
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
    ANTHROPIC_CUSTOM_HEADERS: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    CLAUDECODE: undefined,
    TENJIN_WALLET_PASSPHRASE: undefined,
    TENJIN_MODEL_WORKER: '1',
    ANTHROPIC_MAX_RETRIES: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ENABLE_TOOL_SEARCH: 'false',
  };
}
