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
    // Nor a relative path, a directory, or a non-jsonl name.
    await expect(admit(event(SESSION, `${SESSION}.jsonl`))).resolves.toBe(null);
    await rm(transcript);
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
    const link = join(home, 'via-link');
    await symlink(project, link);
    const admitted = await admit(event(SESSION, join(link, `${SESSION}.jsonl`)));
    expect(admitted?.['transcript_path']).toBe(transcript);
    // A file link to the transcript from outside the projects directory is refused.
    const fileLink = join(home, `${SESSION}.jsonl`);
    await symlink(transcript, fileLink);
    await expect(admit(event(SESSION, fileLink))).resolves.toBeNull();
  });

  it("admits a session's first prompt before its transcript is written, with no path to read", async () => {
    await rm(transcript);
    const admitted = await admit(event(SESSION, transcript));
    expect(admitted).toEqual({
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION,
      prompt: 'hi',
    });
    // The same for a subagent file not written yet, in that session's own folder.
    const own = join(project, SESSION, 'subagents');
    await mkdir(own, { recursive: true });
    const sub = join(own, 'agent-abc.jsonl');
    await expect(admit(event(SESSION, sub))).resolves.not.toBeNull();
  });

  it('admits the first prompt of a new project, before Claude Code makes its folder', async () => {
    const fresh = join(home, '.claude', 'projects', '-Users-me-new');
    const first = join(fresh, `${SESSION}.jsonl`);
    await expect(admit(event(SESSION, first))).resolves.toEqual({
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION,
      prompt: 'hi',
    });
    // And of the very first session on a machine, before the projects directory exists.
    await rm(join(home, '.claude'), { recursive: true });
    await expect(admit(event(SESSION, first))).resolves.not.toBeNull();
    // Only in its own place: a missing name one level too deep, or a dot hop.
    await expect(admit(event(SESSION, join(fresh, 'x', `${SESSION}.jsonl`)))).resolves.toBeNull();
    const hop = `${home}/.claude/projects/-a/../../../${SESSION}.jsonl`;
    await expect(admit(event(SESSION, hop))).resolves.toBeNull();
  });

  it('refuses a missing transcript under a dangling symlinked folder', async () => {
    const linked = join(home, '.claude', 'projects', '-dangling');
    await symlink(join(home, 'gone'), linked);
    await expect(admit(event(SESSION, join(linked, `${SESSION}.jsonl`)))).resolves.toBeNull();
  });

  it('refuses a missing transcript anywhere but its own place under the projects directory', async () => {
    await rm(transcript);
    // A folder outside the projects directory, or one that does not exist.
    await expect(admit(event(SESSION, join(home, `${SESSION}.jsonl`)))).resolves.toBeNull();
    await expect(admit(event(SESSION, join(home, 'nope', `${SESSION}.jsonl`)))).resolves.toBeNull();
    await expect(
      admit(event(SESSION, join(project, 'nope', `${SESSION}.jsonl`))),
    ).resolves.toBeNull();
    // The projects directory itself, with no project folder.
    const top = join(home, '.claude', 'projects', `${SESSION}.jsonl`);
    await expect(admit(event(SESSION, top))).resolves.toBeNull();
    // A project folder that is a symlink out of the projects directory.
    const away = join(home, 'away');
    await mkdir(away);
    const linked = join(home, '.claude', 'projects', '-linked');
    await symlink(away, linked);
    await expect(admit(event(SESSION, join(linked, `${SESSION}.jsonl`)))).resolves.toBeNull();
    // Another session's name.
    await expect(admit(event(SESSION, join(project, `${OTHER}.jsonl`)))).resolves.toBeNull();
  });

  it('refuses a session id that is not an opaque token', async () => {
    for (const bad of ['', '.', '..', 'a.b', 'a/b', '../x', `${SESSION}\\x`, 'x'.repeat(201)]) {
      await expect(admit(event(bad, join(project, `${bad}.jsonl`)))).resolves.toBeNull();
    }
    await expect(admit({ ...event(SESSION, transcript), session_id: 7 })).resolves.toBeNull();
  });

  it('refuses a transcript symlink that leads out, there or dangling', async () => {
    await rm(transcript);
    await symlink(outside, transcript);
    await expect(admit(event(SESSION, transcript))).resolves.toBeNull();
    await rm(transcript);
    await symlink(join(home, 'not-there.jsonl'), transcript);
    await expect(admit(event(SESSION, transcript))).resolves.toBeNull();
  });
});
