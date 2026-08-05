import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { healWiredSkills } from './skill-heal';
import { skillsHealLockPath } from './paths';
import { resolveSkillsSource, SKILL_NAMES } from './skills-source';
import { skillsDirsFor } from './skill-wiring';
import type { Io } from './output';

// The real packaged skills, so a heal that claims "matches this CLI" is compared
// against the bytes the CLI actually ships.
const SKILLS_SRC = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));

let home: string;
let data: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tenjin-heal-home-'));
  data = await mkdtemp(join(tmpdir(), 'tenjin-heal-data-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
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
  return healWiredSkills({ dir: data, io, json, homeDir: home, skillsSourceDir: SKILLS_SRC });
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
    const hosted = await seedSkill(claudeDir(), 'tenjin');
    const { io, stderr } = captureIo();
    await heal(io);
    expect(await readFile(search, 'utf8')).toBe(await packaged('tenjin-search'));
    expect(await readFile(hosted, 'utf8')).toBe(await packaged('tenjin'));
    expect(stderr()).toContain('could not update');
    expect(stderr()).toContain(join(claudeDir(), 'tenjin-publish'));
  });

  it('skips silently while another process holds the heal lock', async () => {
    const path = await seedSkill(claudeDir(), 'tenjin-search');
    await mkdir(skillsHealLockPath(data), { recursive: true });
    const { io, stderr } = captureIo();
    await heal(io);
    expect(await readFile(path, 'utf8')).toBe('stale\n');
    expect(stderr()).toBe('');
    expect(existsSync(skillsHealLockPath(data))).toBe(true); // still the holder's
  });

  it('releases its own lock', async () => {
    await seedSkill(claudeDir(), 'tenjin-search');
    const { io } = captureIo();
    await heal(io);
    expect(existsSync(skillsHealLockPath(data))).toBe(false);
  });

  it('heals both harness directories, and discloses the hosted mirror it replaced', async () => {
    for (const name of SKILL_NAMES) {
      await seedSkill(claudeDir(), name);
      await seedSkill(sharedDir(), name);
    }
    const { io, stderr } = captureIo();
    await heal(io);
    for (const dir of [claudeDir(), sharedDir()]) {
      for (const name of SKILL_NAMES) {
        expect(await readFile(join(dir, name, 'SKILL.md'), 'utf8')).toBe(await packaged(name));
      }
    }
    expect(stderr()).toContain(claudeDir());
    expect(stderr()).toContain(sharedDir());
    expect(stderr()).toContain('hosted tenjin skill');
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
      dir: data,
      io,
      json: false,
      homeDir: 'relative-home',
      skillsSourceDir: SKILLS_SRC,
    });
    expect(existsSync('relative-home')).toBe(false);
    expect(existsSync(skillsHealLockPath(data))).toBe(false);
  });

  it('does not touch the data dir when no skill is wired', async () => {
    await rm(data, { recursive: true, force: true });
    const { io } = captureIo();
    await heal(io);
    expect(existsSync(data)).toBe(false);
  });

  it('never rejects when the packaged source is gone', async () => {
    await seedSkill(claudeDir(), 'tenjin-search');
    const { io, stderr } = captureIo();
    await expect(
      healWiredSkills({
        dir: data,
        io,
        json: false,
        homeDir: home,
        skillsSourceDir: join(home, 'not-a-skills-dir'),
      }),
    ).resolves.toBeUndefined();
    expect(stderr()).toContain('could not update');
  });
});
