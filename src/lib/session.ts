/**
 * The harness whose agent runs this command (Claude Code, which Claude Desktop
 * runs too, or Codex), from the variables each exports to the commands its
 * agent runs, or undefined in a person's own terminal, which sets none of them.
 * A Claude Code variable wins when both are set.
 */
export function agentHost(env: NodeJS.ProcessEnv = process.env): 'claude' | 'codex' | undefined {
  const set = (v: string | undefined) => typeof v === 'string' && v.trim().length > 0;
  if (set(env.CLAUDECODE) || set(env.CLAUDE_CODE_SESSION_ID) || set(env.CLAUDE_CODE_EXECPATH)) {
    return 'claude';
  }
  if (set(env.CODEX_SESSION_ID)) return 'codex';
  return undefined;
}

/** Is this command run by an agent under a harness? */
export function underAgentHarness(env: NodeJS.ProcessEnv = process.env): boolean {
  return agentHost(env) !== undefined;
}
