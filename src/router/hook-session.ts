import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/**
 * THE `hook` TOOL'S CALLER IS NOT PROVEN. Claude Code calls it from the hook
 * entries `tenjin install` wrote, but the model sees the tool too, and the
 * event's `session_id` and `transcript_path` are plain arguments. A forged path
 * would have this process read any local file and send it to the router, and
 * charge a routing fee for it once the fee is approved.
 *
 * So a call is admitted only with a real Claude Code transcript of its own
 * session: its folder resolves, symlinks followed, under
 * `~/.claude/projects/<project>/` and the file is named `<session_id>.jsonl`,
 * or it is one of that session's subagent files,
 * `<session_id>/subagents/agent-<id>.jsonl` beside it (the layout of Claude
 * Code 2.1.x). A file that is there must resolve to that same place and be a
 * regular file. One not written yet, as at a session's first prompt (in a new
 * project, the folder too), is no history: the leg routes on its own input and
 * reads no file. Each call is checked on its own: a
 * session id that changes inside one `tenjin mcp` process, as after `/clear`
 * or a resume, is a new session with its own transcript, not a forgery. A
 * refused call reads nothing, sends nothing and pays nothing.
 */

/** A session or agent id becomes a path segment, so only an opaque token passes. */
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,200}$/;
const AGENT_FILE_RE = /^agent-[A-Za-z0-9_-]{1,200}\.jsonl$/;

interface OwnTranscript {
  /** The resolved path, the one the handlers then read; `null` while the file is not written yet. */
  path: string | null;
  kind: 'session' | 'subagent';
}

/** The event with its transcript path resolved, or `null` when the call is refused. */
export async function admitHookEvent(
  event: Record<string, unknown>,
  homeDir: string = homedir(),
): Promise<Record<string, unknown> | null> {
  const sessionId = event['session_id'];
  if (typeof sessionId !== 'string' || !SEGMENT_RE.test(sessionId)) return null;
  const transcript = await ownTranscript(homeDir, event['transcript_path'], sessionId);
  if (transcript === null) return null;
  // No file yet: the leg routes on its own input, with no history to read.
  if (transcript.path === null) {
    const unread = { ...event };
    delete unread['transcript_path'];
    return unread;
  }
  const agentId = event['agent_id'];
  if (
    transcript.kind === 'session' &&
    typeof agentId === 'string' &&
    !(await subagentFileStaysHome(transcript.path, sessionId, agentId))
  ) {
    return null;
  }
  return { ...event, transcript_path: transcript.path };
}

async function ownTranscript(
  homeDir: string,
  raw: unknown,
  sessionId: string,
): Promise<OwnTranscript | null> {
  if (typeof raw !== 'string' || !isAbsolute(raw)) return null;
  if (raw.split(sep).some((part) => part === '.' || part === '..')) return null;
  const name = basename(raw);
  if (name !== `${sessionId}.jsonl` && !AGENT_FILE_RE.test(name)) return null;
  // The folder resolves before the file: Claude Code fires a session's first
  // prompt before it writes the file, and in a new project before the folder.
  const projects = await resolveExisting(join(homeDir, '.claude', 'projects'));
  const folder = await resolveExisting(dirname(raw));
  if (projects === null || folder === null) return null;
  const named = join(folder.path, name);
  const kind = layoutKind(projects.path, named, sessionId);
  if (kind === null) return null;
  if (folder.missing) return { path: null, kind };
  try {
    await lstat(named);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { path: null, kind } : null;
  }
  // A file that is there, or a symlink, must resolve to the same layout.
  try {
    const path = await realpath(named);
    if (layoutKind(projects.path, path, sessionId) !== kind) return null;
    return (await stat(path)).isFile() ? { path, kind } : null;
  } catch {
    return null;
  }
}

/**
 * `path` with its deepest existing folder resolved, symlinks followed, and the
 * rest kept as written, which is then known not to exist. A part that is a
 * symlink leading nowhere refuses, so nothing missing can lead out later.
 */
async function resolveExisting(path: string): Promise<{ path: string; missing: boolean } | null> {
  const rest: string[] = [];
  let at = path;
  for (;;) {
    try {
      return { path: join(await realpath(at), ...rest), missing: rest.length > 0 };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    try {
      await lstat(at);
      return null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    }
    const up = dirname(at);
    if (up === at) return null;
    rest.unshift(basename(at));
    at = up;
  }
}

/** Where `path` sits under `projects`, or `null` when it is not a transcript of `sessionId`. */
function layoutKind(
  projects: string,
  path: string,
  sessionId: string,
): OwnTranscript['kind'] | null {
  const rel = relative(projects, path);
  if (rel.length === 0 || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts[0] === '..' || parts[0] === '.') return null;
  if (parts.length === 2 && parts[1] === `${sessionId}.jsonl`) return 'session';
  if (
    parts.length === 4 &&
    parts[1] === sessionId &&
    parts[2] === 'subagents' &&
    AGENT_FILE_RE.test(parts[3]!)
  ) {
    return 'subagent';
  }
  return null;
}

/**
 * The subagent file a leg derives from the session's transcript
 * (`subagentTranscriptPath`) must not lead out of the session's folder either.
 * A file not there yet reads as nothing, so it passes; one that resolves
 * anywhere but where it is named refuses the call.
 */
async function subagentFileStaysHome(
  transcript: string,
  sessionId: string,
  agentId: string,
): Promise<boolean> {
  if (agentId.length === 0 || !SEGMENT_RE.test(agentId)) return true;
  const named = join(dirname(transcript), sessionId, 'subagents', `agent-${agentId}.jsonl`);
  try {
    return (await realpath(named)) === named;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
