import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { admitCodexHookEvent, admitHookEvent, claudeProjectsDir } from './hook-session';

/**
 * The `hook` tool reads history only from a file under Claude Code's projects
 * directory named for the session or a subagent. Each case lays out a home the
 * way Claude Code 2.1.x does: `~/.claude/projects/<project>/<session>.jsonl`.
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

const admit = (e: Record<string, unknown>) => admitHookEvent(e, { homeDir: home, env: {} });

describe('admitHookEvent', () => {
  it("admits the session's own transcript and a subagent's, by their real paths", async () => {
    await expect(admit(event(SESSION, transcript))).resolves.toEqual(event(SESSION, transcript));
    const own = join(project, SESSION, 'subagents');
    await mkdir(own, { recursive: true });
    const sub = join(own, 'agent-a3148a84ba8b76284.jsonl');
    await writeFile(sub, '{}\n');
    await expect(admit(event(SESSION, sub))).resolves.not.toBeNull();
    // A symlinked route in is followed to the real file.
    const link = join(home, 'via-link');
    await symlink(project, link);
    const admitted = await admit(event(SESSION, join(link, `${SESSION}.jsonl`)));
    expect(admitted?.['transcript_path']).toBe(transcript);
  });

  it('refuses a file whose real path is outside the projects directory', async () => {
    const named = join(home, `${SESSION}.jsonl`);
    await writeFile(named, '{}\n');
    await expect(admit(event(SESSION, named))).resolves.toBeNull();
    await expect(admit(event(SESSION, outside))).resolves.toBeNull();
    // A symlink in the projects directory that leads out, and a `..` hop.
    const link = join(project, `${OTHER}.jsonl`);
    await symlink(outside, link);
    await expect(admit(event(OTHER, link))).resolves.toBeNull();
    const hop = join(project, '..', '..', '..', 'secret.jsonl');
    await expect(admit(event(SESSION, hop))).resolves.toBeNull();
  });

  it('refuses a file not named for the session or a subagent', async () => {
    const other = join(project, `${OTHER}.jsonl`);
    await writeFile(other, '{}\n');
    await expect(admit(event(SESSION, other))).resolves.toBeNull();
    const txt = join(project, `${SESSION}.txt`);
    await writeFile(txt, '{}\n');
    await expect(admit(event(SESSION, txt))).resolves.toBeNull();
    await expect(admit(event(SESSION, `${SESSION}.jsonl`))).resolves.toBeNull();
    await rm(transcript);
    await mkdir(transcript);
    await expect(admit(event(SESSION, transcript))).resolves.toBeNull();
  });

  it('admits a transcript not written yet with no path to read, only under the projects directory', async () => {
    await rm(transcript);
    await expect(admit(event(SESSION, transcript))).resolves.toEqual({
      hook_event_name: 'UserPromptSubmit',
      session_id: SESSION,
      prompt: 'hi',
    });
    // A new project, before Claude Code makes its folder.
    const fresh = join(home, '.claude', 'projects', '-Users-me-new', `${SESSION}.jsonl`);
    await expect(admit(event(SESSION, fresh))).resolves.not.toBeNull();
    // Not outside it, nor under another name.
    await expect(admit(event(SESSION, join(home, 'nope', `${SESSION}.jsonl`)))).resolves.toBeNull();
    await expect(admit(event(SESSION, join(project, `${OTHER}.jsonl`)))).resolves.toBeNull();
    const hop = `${home}/.claude/projects/-a/../../../${SESSION}.jsonl`;
    await expect(admit(event(SESSION, hop))).resolves.toBeNull();
  });

  it('refuses a session or agent id that is not an opaque token', async () => {
    for (const bad of ['', '.', '..', 'a.b', 'a/b', '../x', 'x'.repeat(201)]) {
      await expect(admit(event(bad, join(project, `${bad}.jsonl`)))).resolves.toBeNull();
    }
    await expect(admit({ ...event(SESSION, transcript), session_id: 7 })).resolves.toBeNull();
    await expect(admit(event(SESSION, transcript, { agent_id: '../x' }))).resolves.toBeNull();
  });

  it('reads the projects directory from CLAUDE_CONFIG_DIR when it is set, else the default', async () => {
    const config = join(home, 'custom-config');
    const custom = join(config, 'projects', '-repo');
    await mkdir(custom, { recursive: true });
    const there = join(custom, `${SESSION}.jsonl`);
    await writeFile(there, '{}\n');
    const env = { CLAUDE_CONFIG_DIR: config };
    expect(claudeProjectsDir({ env, homeDir: home })).toBe(join(config, 'projects'));
    expect(claudeProjectsDir({ env: {}, homeDir: home })).toBe(join(home, '.claude', 'projects'));
    await expect(admitHookEvent(event(SESSION, there), { env, homeDir: home })).resolves.toEqual(
      event(SESSION, there),
    );
    // With the variable set, the default directory is not the one Claude Code uses.
    await expect(
      admitHookEvent(event(SESSION, transcript), { env, homeDir: home }),
    ).resolves.toBeNull();
    // Unset, it is.
    await expect(
      admitHookEvent(event(SESSION, there), { env: {}, homeDir: home }),
    ).resolves.toBeNull();
    await expect(
      admitHookEvent(event(SESSION, transcript), { env: { CLAUDE_CONFIG_DIR: '' }, homeDir: home }),
    ).resolves.not.toBeNull();
  });
});

describe('a Codex leg', () => {
  const rollout = (id: string) => `rollout-2026-10-22T17-35-09-${id}.jsonl`;
  let day: string;
  beforeEach(async () => {
    day = join(home, '.codex', 'sessions', '2026', '10', '22');
    await mkdir(day, { recursive: true });
    await writeFile(join(day, rollout(SESSION)), '{}\n');
  });
  const admit = (e: Record<string, unknown>, threadId: unknown = SESSION, env = {}) =>
    admitCodexHookEvent(e, { homeDir: home, env, threadId });

  it("reads the session's own rollout file under the Codex home, and nothing else", async () => {
    const own = join(day, rollout(SESSION));
    expect(await admit(event(SESSION, own))).toMatchObject({ transcript_path: own });
    await writeFile(join(day, rollout(OTHER)), '{}\n');
    expect(await admit(event(SESSION, join(day, rollout(OTHER))))).toBeNull();
    expect(await admit(event(SESSION, outside))).toBeNull();
    expect(await admit(event(SESSION, 'relative.jsonl'))).toBeNull();
  });

  it('routes on the leg alone when there is no transcript yet, or none at all', async () => {
    const unwritten = await admit(event(OTHER, join(day, rollout(OTHER))), OTHER);
    expect(unwritten).not.toHaveProperty('transcript_path');
    const none: Record<string, unknown> = event(SESSION, '');
    delete none['transcript_path'];
    expect(await admit(none)).toEqual(none);
  });

  it("refuses a subagent's leg, whose thread is not the session's own", async () => {
    expect(await admit(event(SESSION, join(day, rollout(SESSION))), OTHER)).toBeNull();
  });

  it('follows CODEX_HOME', async () => {
    const custom = join(home, 'custom', 'sessions');
    await mkdir(custom, { recursive: true });
    await writeFile(join(custom, rollout(SESSION)), '{}\n');
    const env = { CODEX_HOME: join(home, 'custom') };
    expect(
      await admit(event(SESSION, join(custom, rollout(SESSION))), SESSION, env),
    ).not.toBeNull();
    expect(await admit(event(SESSION, join(day, rollout(SESSION))), SESSION, env)).toBeNull();
  });
});
