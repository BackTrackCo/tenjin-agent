import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

/**
 * THE `hook` TOOL'S CALLER IS NOT PROVEN. Claude Code calls it from the hook
 * entries `tenjin install` wrote, but the model sees the tool too, and the
 * event's `session_id` and `transcript_path` are plain arguments. A forged path
 * would have this process read any local file and send it to the router, and
 * charge a routing fee for it once the fee is approved.
 *
 * So a call is admitted only with a real Claude Code transcript of its own
 * session: the path resolves, symlinks followed, to a regular file under
 * `~/.claude/projects/<project>/` named `<session_id>.jsonl`, or to one of that
 * session's subagent files, `<session_id>/subagents/agent-<id>.jsonl` beside
 * it (the layout of Claude Code 2.1.x). And one `tenjin mcp` serves one
 * session: the first admitted session id binds the process, and any other id
 * is refused afterwards. A refused call reads nothing, sends nothing and pays
 * nothing.
 */

/** A session or agent id becomes a path segment, so only an opaque token passes. */
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,200}$/;
const AGENT_FILE_RE = /^agent-[A-Za-z0-9_-]{1,200}\.jsonl$/;

interface OwnTranscript {
  /** The resolved path, the one the handlers then read. */
  path: string;
  kind: 'session' | 'subagent';
}

export class HookSession {
  private bound: string | undefined;

  constructor(private readonly homeDir: string = homedir()) {}

  /** The session this process serves, once one was admitted. */
  get sessionId(): string | undefined {
    return this.bound;
  }

  /**
   * The event with its transcript path resolved, or `null` when the call is
   * refused. A refused call does not bind the process.
   */
  async admit(event: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const sessionId = event['session_id'];
    if (typeof sessionId !== 'string' || !SEGMENT_RE.test(sessionId)) return null;
    if (this.bound !== undefined && this.bound !== sessionId) return null;
    const transcript = await ownTranscript(this.homeDir, event['transcript_path'], sessionId);
    if (transcript === null) return null;
    const agentId = event['agent_id'];
    if (
      transcript.kind === 'session' &&
      typeof agentId === 'string' &&
      !(await subagentFileStaysHome(transcript.path, sessionId, agentId))
    ) {
      return null;
    }
    // Checked again after the reads: two first calls racing must not both bind.
    if (this.bound !== undefined && this.bound !== sessionId) return null;
    this.bound = sessionId;
    return { ...event, transcript_path: transcript.path };
  }
}

async function ownTranscript(
  homeDir: string,
  raw: unknown,
  sessionId: string,
): Promise<OwnTranscript | null> {
  if (typeof raw !== 'string' || !isAbsolute(raw)) return null;
  let projects: string;
  let path: string;
  try {
    projects = await realpath(join(homeDir, '.claude', 'projects'));
    path = await realpath(raw);
  } catch {
    return null;
  }
  const rel = relative(projects, path);
  if (rel.length === 0 || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (parts[0] === '..' || parts[0] === '.') return null;
  let kind: OwnTranscript['kind'];
  if (parts.length === 2 && parts[1] === `${sessionId}.jsonl`) {
    kind = 'session';
  } else if (
    parts.length === 4 &&
    parts[1] === sessionId &&
    parts[2] === 'subagents' &&
    AGENT_FILE_RE.test(parts[3]!)
  ) {
    kind = 'subagent';
  } else {
    return null;
  }
  try {
    if (!(await stat(path)).isFile()) return null;
  } catch {
    return null;
  }
  return { path, kind };
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
