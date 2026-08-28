/**
 * The harness session a command belongs to: `search` stamps entries with it and
 * `outcome --all-open` sweeps only this session's. ONE COPY, because a sweep and
 * the nag that named it must agree on what "this session" means.
 *
 * TENJIN_SESSION_ID is the operator override; CLAUDE_CODE_SESSION_ID is what
 * Claude Code exports to the Bash subprocess a `tenjin search` runs as, to the
 * stdio MCP server, and as the `session_id` the hook scripts read on stdin, so
 * all three stamp identically. Observed rather than documented, hence a
 * fallback: on a harness exporting neither this stays undefined.
 */
export function readSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return firstNonEmpty(env.TENJIN_SESSION_ID) ?? firstNonEmpty(env.CLAUDE_CODE_SESSION_ID);
}

function firstNonEmpty(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
