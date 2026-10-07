import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';

/**
 * THE `hook` TOOL'S CALLER IS NOT PROVEN. Claude Code calls it from the hook
 * entries `tenjin install` wrote, and `install` denies the tool to the model,
 * but the event's `session_id` and `transcript_path` are plain arguments. A
 * forged path would have this process read a local file and send it to the
 * router.
 *
 * So a transcript is read only when its real path, symlinks followed, lies
 * under Claude Code's projects directory (`$CLAUDE_CONFIG_DIR/projects`, else
 * `~/.claude/projects`) and is a file named for the session (`<session_id>.jsonl`)
 * or a subagent (`agent-<id>.jsonl`). One not written yet, as at a session's
 * first prompt, is no history: the leg routes on its own input and reads no
 * file. Anything else is refused: nothing is read, sent or paid.
 */

/** A session or agent id names a file, so only an opaque token passes. */
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,200}$/;
const AGENT_FILE_RE = /^agent-[A-Za-z0-9_-]{1,200}\.jsonl$/;

export interface AdmitOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** Where Claude Code keeps session transcripts on this machine. */
export function claudeProjectsDir(opts: AdmitOptions = {}): string {
  const configDir = (opts.env ?? process.env).CLAUDE_CONFIG_DIR;
  const base =
    configDir !== undefined && configDir.length > 0
      ? configDir
      : join(opts.homeDir ?? homedir(), '.claude');
  return join(base, 'projects');
}

/** The event with its transcript path resolved, or `null` when the call is refused. */
export async function admitHookEvent(
  event: Record<string, unknown>,
  opts: AdmitOptions = {},
): Promise<Record<string, unknown> | null> {
  const sessionId = event['session_id'];
  const agentId = event['agent_id'];
  const raw = event['transcript_path'];
  if (typeof sessionId !== 'string' || !SEGMENT_RE.test(sessionId)) return null;
  if (typeof agentId === 'string' && agentId.length > 0 && !SEGMENT_RE.test(agentId)) return null;
  if (typeof raw !== 'string' || !isAbsolute(raw)) return null;
  const named = (path: string) =>
    basename(path) === `${sessionId}.jsonl` || AGENT_FILE_RE.test(basename(path));
  const projects = claudeProjectsDir(opts);
  const roots = [projects, await realpath(projects).catch(() => projects)];
  const under = (path: string, root: string) => path.startsWith(`${root}${sep}`);
  let real: string;
  try {
    real = await realpath(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    // Not written yet: routed on its own input, with no file to read.
    if (!named(raw) || !roots.some((root) => under(resolve(raw), root))) return null;
    const unread = { ...event };
    delete unread['transcript_path'];
    return unread;
  }
  if (!named(real) || !under(real, roots[1]!)) return null;
  if (!(await stat(real).catch(() => null))?.isFile()) return null;
  return { ...event, transcript_path: real };
}
