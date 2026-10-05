import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { admitHookEvent } from './hook-session';

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

const admit = (e: Record<string, unknown>) => admitHookEvent(e, home);

describe('admitHookEvent', () => {
  it("admits the session's own transcript", async () => {
    await expect(admit(event(SESSION, transcript))).resolves.toEqual(event(SESSION, transcript));
  });

  it('refuses a path outside the projects directory', async () => {
    const named = join(home, `${SESSION}.jsonl`);
    await writeFile(named, '{}\n');
    await expect(admit(event(SESSION, named))).resolves.toBeNull();
    await expect(admit(event(SESSION, outside))).resolves.toBeNull();
    await expect(admit(event(SESSION, '/etc/hosts'))).resolves.toBeNull();
  });

  it('refuses a symlink inside the projects directory that leads out of it', async () => {
    const link = join(project, `${OTHER}.jsonl`);
    await symlink(outside, link);
    await expect(admit(event(OTHER, link))).resolves.toBeNull();
    // A `..` hop is resolved before the check too.
    const hop = join(project, '..', '..', '..', 'secret.jsonl');
    await expect(admit(event(SESSION, hop))).resolves.toBeNull();
  });

  it('refuses a transcript whose name is not the session id', async () => {
    const other = join(project, `${OTHER}.jsonl`);
    await writeFile(other, '{}\n');
    await expect(admit(event(SESSION, other))).resolves.toBeNull();
    // Nor a relative path, a missing file, a directory, or a non-jsonl name.
    await expect(admit(event(SESSION, `${SESSION}.jsonl`))).resolves.toBe(null);
    await rm(transcript);
    await expect(admit(event(SESSION, transcript))).resolves.toBeNull();
    await mkdir(transcript);
    await expect(admit(event(SESSION, transcript))).resolves.toBeNull();
    const txt = join(project, `${SESSION}.txt`);
    await writeFile(txt, '{}\n');
    await expect(admit(event(SESSION, txt))).resolves.toBeNull();
  });

  it('checks each call on its own: a new session id after /clear is admitted', async () => {
    const other = join(project, `${OTHER}.jsonl`);
    await writeFile(other, '{}\n');
    await expect(admit(event(SESSION, transcript))).resolves.not.toBeNull();
    await expect(admit(event(OTHER, other))).resolves.not.toBeNull();
    // Each still needs its own transcript.
    await expect(admit(event(OTHER, transcript))).resolves.toBeNull();
  });

  it("admits a subagent file only in that session's own folder", async () => {
    const own = join(project, SESSION, 'subagents');
    await mkdir(own, { recursive: true });
    const sub = join(own, 'agent-a3148a84ba8b76284.jsonl');
    await writeFile(sub, '{}\n');
    await expect(admit(event(SESSION, sub))).resolves.not.toBeNull();
    // The same file named under another session's folder is that session's.
    const theirs = join(project, OTHER, 'subagents');
    await mkdir(theirs, { recursive: true });
    const foreign = join(theirs, 'agent-a3148a84ba8b76284.jsonl');
    await writeFile(foreign, '{}\n');
    await expect(admit(event(SESSION, foreign))).resolves.toBeNull();
    // And a file in the folder that is not an agent transcript.
    const stray = join(own, 'notes.jsonl');
    await writeFile(stray, '{}\n');
    await expect(admit(event(SESSION, stray))).resolves.toBeNull();
  });

  it('refuses a call whose derived subagent file leads out of the session folder', async () => {
    const own = join(project, SESSION, 'subagents');
    await mkdir(own, { recursive: true });
    await symlink(outside, join(own, 'agent-abc.jsonl'));
    const leg = (agentId: string) => event(SESSION, transcript, { agent_id: agentId });
    await expect(admit(leg('abc'))).resolves.toBeNull();
    // A subagent with no file yet reads nothing, so it is admitted.
    await expect(admit(leg('def'))).resolves.not.toBeNull();
  });

  it('hands the handlers the resolved path, never the one it was given', async () => {
    const link = join(home, 'via-link.jsonl');
    await symlink(transcript, link);
    const admitted = await admit(event(SESSION, link));
    expect(admitted?.['transcript_path']).toBe(transcript);
  });
});
