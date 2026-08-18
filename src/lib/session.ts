/**
 * The harness session a command belongs to, so `search` can stamp an entry with
 * it and `outcome --all-open` can sweep only the loops this session opened.
 * ONE COPY: the Stop hook, the stamp and the sweep must agree on what "this
 * session" means, or the sweep covers a different set than the nag that named it.
 *
 * Two sources, in precedence order. TENJIN_SESSION_ID is the operator override.
 * CLAUDE_CODE_SESSION_ID is what Claude Code exports to Bash subprocesses, which
 * is what a `tenjin search` runs as, and it is the same `session_id` the hook
 * scripts are handed on stdin, so a CLI search and a hook search in one session
 * stamp identically. Verified against a live session rather than documented,
 * hence a fallback: on a harness that exports neither this stays undefined.
 */
export function readSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return firstNonEmpty(env.TENJIN_SESSION_ID) ?? firstNonEmpty(env.CLAUDE_CODE_SESSION_ID);
}

function firstNonEmpty(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Whether an entry is this session's business, mirroring the Stop hook's
 * `ownedByThisSession`. SCOPED WHEN KNOWN, GLOBAL WHEN NOT: a differently
 * stamped entry belongs to that session, and an unstamped one stays in scope,
 * because scoping must never make a loop unreachable everywhere at once.
 */
export function ownedByThisSession(
  entrySessionId: string | undefined,
  sessionId: string | undefined,
): boolean {
  if (sessionId === undefined) return true;
  return entrySessionId === undefined || entrySessionId === sessionId;
}
