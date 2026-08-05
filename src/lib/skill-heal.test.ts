import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { healWiredSkills } from './skill-heal';
import { resolveSkillsSource } from './skills-source';
import { CLI_SKILL_NAMES, HOSTED_SKILL_NAME, skillsDirsFor } from './skill-wiring';
import type { Io } from './output';

// The real packaged skills, so a heal that claims "matches this CLI" is compared
// against the bytes the CLI actually ships.
const SKILLS_SRC = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-heal-home-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function captureIo(isTTY = true) {
  const err: string[] = [];
  const mk = (sink: string[]) =>
    ({
      write: (chunk: string | Uint8Array) => {
        sink.push(chunk.toString());
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
  const io: Io = { stdout: mk([]), stderr: mk(err), isTTY };
  // eslint-disable-next-line no-control-regex
  return { io, stderr: () => err.join('').replace(/\x1b\[[0-9;]*m/g, '') };
}

function heal(io: Io, json = false): Promise<void> {
  return healWiredSkills({ io, json, homeDir: home, skillsSourceDir: SKILLS_SRC });
}

const claudeDir = (): string => skillsDirsFor(home)[0]!;
const sharedDir = (): string => skillsDirsFor(home)[1]!;

/** Put `name` in `dir` with the given SKILL.md bytes (a stale copy by default). */
async function seedSkill(dir: string, name: string, text = 'stale\n'): Promise<string> {
  const path = join(dir, name, 'SKILL.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

async function packaged(name: string): Promise<string> {
  return readFile(join(SKILLS_SRC, name, 'SKILL.md'), 'utf8');
}

describe('healWiredSkills', () => {
  it('rewrites a stale skill and says so once', async () => {
    const path = await seedSkill(claudeDir(), 'tenjin-search');
    const { io, stderr } = captureIo();
    await heal(io);
    expect(await readFile(path, 'utf8')).toBe(await packaged('tenjin-search'));
    expect(stderr()).toContain(claudeDir());
    expect(stderr().trimEnd().split('\n')).toHaveLength(1);
  });

  it('never creates a skill that is not already there', async () => {
    await seedSkill(claudeDir(), 'tenjin-search');
    const { io } = captureIo();
    await heal(io);
    expect(existsSync(join(claudeDir(), 'tenjin-publish'))).toBe(false);
    expect(existsSync(sharedDir())).toBe(false);
  });

  it('leaves a current skill untouched, and says nothing', async () => {
    const path = await seedSkill(claudeDir(), 'tenjin-search', await packaged('tenjin-search'));
    const before = await stat(path);
    const { io, stderr } = captureIo();
    await heal(io);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(stderr()).toBe('');
  });

  it('heals the skills either side of one that cannot be written', async () => {
    if (process.platform === 'win32') return;
    const fifo = join(claudeDir(), 'tenjin-publish', 'SKILL.md');
    await mkdir(dirname(fifo), { recursive: true });
    execFileSync('mkfifo', [fifo]);
    const search = await seedSkill(claudeDir(), 'tenjin-search');
    const shared = await seedSkill(sharedDir(), 'tenjin-publish');
    const { io, stderr } = captureIo();
    await heal(io);
    expect(await readFile(search, 'utf8')).toBe(await packaged('tenjin-search'));
    expect(await readFile(shared, 'utf8')).toBe(await packaged('tenjin-publish'));
    expect(stderr()).toContain('could not update');
    expect(stderr()).toContain(join(claudeDir(), 'tenjin-publish'));
  });

  // The mirror of tenjin.blog/skills.md may legitimately be NEWER on disk than the
  // one this package ships, and `install` tells operators to re-fetch it from
  // there, so an unattended rewrite would undo their fetch and make that advice a
  // lie. Same skills `doctor`'s staleness check compares, for the same reason.
  it('leaves the hosted tenjin mirror exactly as it found it', async () => {
    const hosted = await seedSkill(claudeDir(), HOSTED_SKILL_NAME, 'a newer fetch\n');
    await seedSkill(claudeDir(), 'tenjin-search');
    const { io, stderr } = captureIo();
    await heal(io);
    expect(await readFile(hosted, 'utf8')).toBe('a newer fetch\n');
    expect(stderr()).not.toContain(HOSTED_SKILL_NAME + '/');
  });

  // A machine carrying only the hosted skill is a working zero-install install,
  // and nothing here is ours to refresh.
  it('does nothing at all in a directory holding only the hosted skill', async () => {
    const hosted = await seedSkill(sharedDir(), HOSTED_SKILL_NAME);
    const { io, stderr } = captureIo();
    await heal(io);
    expect(await readFile(hosted, 'utf8')).toBe('stale\n');
    expect(stderr()).toBe('');
  });

  it('heals both harness directories', async () => {
    for (const name of CLI_SKILL_NAMES) {
      await seedSkill(claudeDir(), name);
      await seedSkill(sharedDir(), name);
    }
    const { io, stderr } = captureIo();
    await heal(io);
    for (const dir of [claudeDir(), sharedDir()]) {
      for (const name of CLI_SKILL_NAMES) {
        expect(await readFile(join(dir, name, 'SKILL.md'), 'utf8')).toBe(await packaged(name));
      }
    }
    expect(stderr()).toContain(claudeDir());
    expect(stderr()).toContain(sharedDir());
  });

  it('says nothing to a machine consumer', async () => {
    const path = await seedSkill(claudeDir(), 'tenjin-search');
    const { io, stderr } = captureIo();
    await heal(io, true);
    expect(await readFile(path, 'utf8')).toBe(await packaged('tenjin-search'));
    expect(stderr()).toBe('');
  });

  it('writes nothing when HOME is not absolute', async () => {
    const { io } = captureIo();
    await healWiredSkills({
      io,
      json: false,
      homeDir: 'relative-home',
      skillsSourceDir: SKILLS_SRC,
    });
    expect(existsSync('relative-home')).toBe(false);
  });

  it('never rejects when the packaged source is gone', async () => {
    await seedSkill(claudeDir(), 'tenjin-search');
    const { io, stderr } = captureIo();
    await expect(
      healWiredSkills({
        io,
        json: false,
        homeDir: home,
        skillsSourceDir: join(home, 'not-a-skills-dir'),
      }),
    ).resolves.toBeUndefined();
    expect(stderr()).toContain('could not update');
  });
});
