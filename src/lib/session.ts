/**
 * Is this command run by an agent under a harness (Claude Code, which Claude
 * Desktop runs too, or Codex), from the variables each exports to the commands
 * its agent runs? A person's own terminal sets none of them.
 */
export function underAgentHarness(env: NodeJS.ProcessEnv = process.env): boolean {
  return [
    env.CLAUDECODE,
    env.CLAUDE_CODE_SESSION_ID,
    env.CLAUDE_CODE_EXECPATH,
    env.CODEX_SESSION_ID,
  ].some((v) => firstNonEmpty(v) !== undefined);
}

function firstNonEmpty(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
