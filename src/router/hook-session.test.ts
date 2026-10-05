import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HookSession } from './hook-session';

/**
 * The `hook` tool reads history only from a real Claude Code transcript of the
 * session it serves. Each case lays out a home the way Claude Code 2.1.x does:
 * `~/.claude/projects/<project>/<session>.jsonl`, with subagents under
 * `<session>/subagents/agent-<id>.jsonl`.
 */

const SESSION = '3d92fa44-db22-4b08-abc8-b3693288aa66';
const OTHER = 'c9329f62-a6fd-49ab-a2fe-35a10e25b23d';

let home: string;
let project: string;
let transcript: string;
let outside: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'hook-session-')));
  project = join(home, '.claude', 'projects', '-Users-me-repo');
  await mkdir(project, { recursive: true });
  transcript = join(project, `${SESSION}.jsonl`);
  await writeFile(transcript, '{}\n');
  outside = join(home, 'secret.jsonl');
  await writeFile(outside, 'not a transcript\n');
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const event = (sessionId: string, path: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: 'UserPromptSubmit',
  session_id: sessionId,
  transcript_path: path,
  prompt: 'hi',
  ...extra,
});

describe('HookSession.admit', () => {
  it("admits the session's own transcript and binds the process to that session", async () => {
    const session = new HookSession(home);
    await expect(session.admit(event(SESSION, transcript))).resolves.toEqual(
      event(SESSION, transcript),
    );
    expect(session.sessionId).toBe(SESSION);
  });

  it('refuses a path outside the projects directory', async () => {
    const session = new HookSession(home);
    const named = join(home, `${SESSION}.jsonl`);
    await writeFile(named, '{}\n');
    await expect(session.admit(event(SESSION, named))).resolves.toBeNull();
    await expect(session.admit(event(SESSION, outside))).resolves.toBeNull();
    await expect(session.admit(event(SESSION, '/etc/hosts'))).resolves.toBeNull();
    // A refused call binds nothing: the real session is still admitted.
    expect(session.sessionId).toBeUndefined();
    await expect(session.admit(event(SESSION, transcript))).resolves.not.toBeNull();
  });

  it('refuses a symlink inside the projects directory that leads out of it', async () => {
    const link = join(project, `${OTHER}.jsonl`);
    await symlink(outside, link);
    await expect(new HookSession(home).admit(event(OTHER, link))).resolves.toBeNull();
    // A `..` hop is resolved before the check too.
    const hop = join(project, '..', '..', '..', 'secret.jsonl');
    await expect(new HookSession(home).admit(event(SESSION, hop))).resolves.toBeNull();
  });

  it('refuses a transcript whose name is not the session id', async () => {
    const other = join(project, `${OTHER}.jsonl`);
    await writeFile(other, '{}\n');
    await expect(new HookSession(home).admit(event(SESSION, other))).resolves.toBeNull();
    // Nor a relative path, a missing file, a directory, or a non-jsonl name.
    await expect(new HookSession(home).admit(event(SESSION, `${SESSION}.jsonl`))).resolves.toBe(
      null,
    );
    await rm(transcript);
    await expect(new HookSession(home).admit(event(SESSION, transcript))).resolves.toBeNull();
    await mkdir(transcript);
    await expect(new HookSession(home).admit(event(SESSION, transcript))).resolves.toBeNull();
    const txt = join(project, `${SESSION}.txt`);
    await writeFile(txt, '{}\n');
    await expect(new HookSession(home).admit(event(SESSION, txt))).resolves.toBeNull();
  });

  it('refuses a second session id once the first was served', async () => {
    const session = new HookSession(home);
    const other = join(project, `${OTHER}.jsonl`);
    await writeFile(other, '{}\n');
    await expect(session.admit(event(SESSION, transcript))).resolves.not.toBeNull();
    await expect(session.admit(event(OTHER, other))).resolves.toBeNull();
    await expect(session.admit(event(SESSION, transcript))).resolves.not.toBeNull();
  });

  it('binds only one of two first calls that race', async () => {
    const session = new HookSession(home);
    const other = join(project, `${OTHER}.jsonl`);
    await writeFile(other, '{}\n');
    const results = await Promise.all([
      session.admit(event(SESSION, transcript)),
      session.admit(event(OTHER, other)),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("admits a subagent file only in that session's own folder", async () => {
    const own = join(project, SESSION, 'subagents');
    await mkdir(own, { recursive: true });
    const sub = join(own, 'agent-a3148a84ba8b76284.jsonl');
    await writeFile(sub, '{}\n');
    await expect(new HookSession(home).admit(event(SESSION, sub))).resolves.not.toBeNull();
    // The same file named under another session's folder is that session's.
    const theirs = join(project, OTHER, 'subagents');
    await mkdir(theirs, { recursive: true });
    const foreign = join(theirs, 'agent-a3148a84ba8b76284.jsonl');
    await writeFile(foreign, '{}\n');
    await expect(new HookSession(home).admit(event(SESSION, foreign))).resolves.toBeNull();
    // And a file in the folder that is not an agent transcript.
    const stray = join(own, 'notes.jsonl');
    await writeFile(stray, '{}\n');
    await expect(new HookSession(home).admit(event(SESSION, stray))).resolves.toBeNull();
  });

  it('refuses a call whose derived subagent file leads out of the session folder', async () => {
    const own = join(project, SESSION, 'subagents');
    await mkdir(own, { recursive: true });
    await symlink(outside, join(own, 'agent-abc.jsonl'));
    const leg = (agentId: string) => event(SESSION, transcript, { agent_id: agentId });
    await expect(new HookSession(home).admit(leg('abc'))).resolves.toBeNull();
    // A subagent with no file yet reads nothing, so it is admitted.
    await expect(new HookSession(home).admit(leg('def'))).resolves.not.toBeNull();
  });

  it('hands the handlers the resolved path, never the one it was given', async () => {
    const link = join(home, 'via-link.jsonl');
    await symlink(transcript, link);
    const admitted = await new HookSession(home).admit(event(SESSION, link));
    expect(admitted?.['transcript_path']).toBe(transcript);
  });
});
