import { AGENT_ID_RE } from './grade';

/**
 * Who a command or a hook fire belongs to. ONE COPY, because the daemon's
 * `actorOf` and the CLI's `search` must agree on what "this actor" means: a
 * `tenjin search` run inside a child and that child's own stop hook have to
 * land on the same `(session, agent)` row, or the child is never asked about
 * its own miss.
 *
 * The stored session is NAMESPACED BY HARNESS. Two harnesses can mint equal
 * native ids, and `marks`, `handoff` and `searches` key on the session string
 * alone; without the prefix their state would merge. The prefix is the only
 * place a harness name enters stored identity.
 */

export interface SessionActor {
  session: string;
  /** The child inside the session; absent for the lead. */
  agent?: string;
}

/** The stored form of a native session id: `<harness>:<id>`. */
export function sessionKey(harness: string, native: string): string {
  return `${harness}:${native}`;
}

/** The native id back out of a stored key; the whole key when it carries no prefix. */
export function nativeSessionOf(key: string): string {
  const at = key.indexOf(':');
  return at === -1 ? key : key.slice(at + 1);
}

/**
 * The actor a CLI command runs as, from the environment its harness exported.
 *
 * TENJIN_SESSION_ID is the operator override and is taken as the whole stored
 * key. CLAUDE_CODE_SESSION_ID is what Claude Code exports to the Bash
 * subprocess a `tenjin search` runs as, and it equals the `session_id` its
 * hooks post, so the two stamp identically (observed, not documented).
 * Codex 0.153.4 exports CODEX_SESSION_ID for the root session and
 * CODEX_THREAD_ID for the thread the command runs in (exec_env.rs); the thread
 * is the child only when it differs from the session, and it must be an id
 * this build can file a child under. Neither harness names a distinct child id
 * for the lead. On a harness exporting none of these the actor is undefined.
 */
export function readActor(env: NodeJS.ProcessEnv = process.env): SessionActor | undefined {
  const override = firstNonEmpty(env.TENJIN_SESSION_ID);
  if (override !== undefined) return { session: override };
  const claude = firstNonEmpty(env.CLAUDE_CODE_SESSION_ID);
  if (claude !== undefined) return { session: sessionKey('claude', claude) };
  const codex = firstNonEmpty(env.CODEX_SESSION_ID);
  if (codex !== undefined) {
    const thread = firstNonEmpty(env.CODEX_THREAD_ID);
    const actor: SessionActor = { session: sessionKey('codex', codex) };
    if (thread !== undefined && thread !== codex && AGENT_ID_RE.test(thread)) actor.agent = thread;
    return actor;
  }
  return undefined;
}

function firstNonEmpty(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
