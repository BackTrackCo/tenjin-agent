import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Turns the gate's destination into a symlink the moment the heal has finished
 * reading it, which is precisely the window between the lstat that judged it a
 * regular file and the write. Inert unless a test arms it.
 */
const race = vi.hoisted(() => ({ swapAfterRead: '', target: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (race.swapAfterRead !== '' && String(args[0]) === race.swapAfterRead) {
        const path = race.swapAfterRead;
        race.swapAfterRead = '';
        await actual.rm(path);
        await actual.symlink(race.target, path);
      }
      return handle;
    },
  };
});
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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

function heal(io: Io, env: NodeJS.ProcessEnv = {}): Promise<void> {
  return healWiredSkills({ io, env, homeDir: home, skillsSourceDir: SKILLS_SRC });
}

const claudeDir = (): string => skillsDirsFor(home)[0]!;
const sharedDir = (): string => skillsDirsFor(home)[1]!;

/** What an older build left behind: our frontmatter, someone else's body. */
const stale = (name: string): string =>
  `---\nname: ${name}\ndescription: an older build's copy\n---\n\nstale\n`;

async function seedSkill(dir: string, name: string, text = stale(name)): Promise<string> {
  const path = join(dir, name, 'SKILL.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

async function packaged(name: string): Promise<string> {
  return readFile(join(SKILLS_SRC, name, 'SKILL.md'), 'utf8');
}

describe('healWiredSkills', () => {
  it('rewrites a stale skill and names the file it wrote', async () => {
    const path = await seedSkill(claudeDir(), 'tenjin-search');
    const { io, stderr } = captureIo();
    await heal(io);
    expect(await readFile(path, 'utf8')).toBe(await packaged('tenjin-search'));
    expect(stderr()).toContain(path);
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

  // `install` writes THROUGH a symlink because the operator pointed it somewhere
  // on purpose. Unattended, that same behavior turns any link at this path into a
  // write to wherever it points, so the heal declines and leaves it to `install`.
  // The link target is a VALID, stale tenjin-search skill: the dotfiles setup this
  // is about, and the only fixture that isolates the lstat gate. Point it at
  // anything else and the frontmatter gate passes the case on its own.
  it('skips a symlinked SKILL.md rather than writing through it', async () => {
    if (process.platform === 'win32') return;
    const elsewhere = join(home, 'dotfiles-tenjin-search.md');
    await writeFile(elsewhere, stale('tenjin-search'));
    await mkdir(join(claudeDir(), 'tenjin-search'), { recursive: true });
    await symlink(elsewhere, join(claudeDir(), 'tenjin-search', 'SKILL.md'));
    const { io, stderr } = captureIo();
    await heal(io);
    expect(await readFile(elsewhere, 'utf8')).toBe(stale('tenjin-search'));
    expect(stderr()).toBe('');
  });

  it('skips a SKILL.md that is not a regular file', async () => {
    if (process.platform === 'win32') return;
    const fifo = join(claudeDir(), 'tenjin-search', 'SKILL.md');
    await mkdir(dirname(fifo), { recursive: true });
    execFileSync('mkfifo', [fifo]);
    const { io, stderr } = captureIo();
    await heal(io);
    expect(stderr()).toBe('');
  });

  // Being at our path does not make a file ours: a third-party skill that happens
  // to be named tenjin-search is the operator's, and gets left alone.
  it('skips a same-named skill whose frontmatter is somebody else s', async () => {
    const theirs = '---\nname: tenjin-search\n---\n';
    const path = await seedSkill(
      claudeDir(),
      'tenjin-search',
      theirs.replace('name: tenjin-search', 'name: acme-search'),
    );
    const { io, stderr } = captureIo();
    await heal(io);
    expect(await readFile(path, 'utf8')).toContain('acme-search');
    expect(stderr()).toBe('');
  });

  it('skips a SKILL.md with no frontmatter at all', async () => {
    const path = await seedSkill(claudeDir(), 'tenjin-search', '# just a note\n');
    const { io } = captureIo();
    await heal(io);
    expect(await readFile(path, 'utf8')).toBe('# just a note\n');
  });

  it('keeps the mode the existing file had', async () => {
    if (process.platform === 'win32') return;
    const path = await seedSkill(claudeDir(), 'tenjin-search');
    await chmod(path, 0o600);
    const { io } = captureIo();
    await heal(io);
    expect(await readFile(path, 'utf8')).toBe(await packaged('tenjin-search'));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('heals the skills either side of one that cannot be written', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const denied = await seedSkill(claudeDir(), 'tenjin-publish');
    await chmod(dirname(denied), 0o500);
    const search = await seedSkill(claudeDir(), 'tenjin-search');
    const shared = await seedSkill(sharedDir(), 'tenjin-publish');
    const { io, stderr } = captureIo();
    try {
      await heal(io);
    } finally {
      await chmod(dirname(denied), 0o700).catch(() => undefined);
    }
    expect(await readFile(search, 'utf8')).toBe(await packaged('tenjin-search'));
    expect(await readFile(shared, 'utf8')).toBe(await packaged('tenjin-publish'));
    expect(stderr()).not.toContain(denied);
  });

  // A cause the next command cannot clear either would otherwise print the same
  // line on every command forever, with no state to suppress it and nothing to
  // dismiss it with. Silence here is what makes `tenjin doctor` the place a
  // permanently un-healable skill is reported.
  it('says nothing at all, on any run, about a skill it cannot write', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const denied = await seedSkill(claudeDir(), 'tenjin-search');
    await chmod(dirname(denied), 0o500);
    try {
      for (let run = 0; run < 3; run += 1) {
        const { io, stderr } = captureIo();
        await heal(io);
        expect(stderr()).toBe('');
      }
    } finally {
      await chmod(dirname(denied), 0o700).catch(() => undefined);
    }
    expect(await readFile(denied, 'utf8')).toBe(stale('tenjin-search'));
  });

  // The gate looks, then the writer writes, and a link can appear in between. It
  // is REPLACED by our regular file, never followed, because the heal tells the
  // writer not to resolve links and `rename` does not follow its final component.
  it('replaces a link that appears after the gate rather than following it', async () => {
    if (process.platform === 'win32') return;
    const elsewhere = join(home, 'dotfiles-tenjin-search.md');
    await writeFile(elsewhere, stale('tenjin-search'));
    const path = await seedSkill(claudeDir(), 'tenjin-search');
    race.swapAfterRead = path;
    race.target = elsewhere;
    const { io } = captureIo();
    try {
      await heal(io);
    } finally {
      race.swapAfterRead = '';
    }
    expect(await readFile(elsewhere, 'utf8')).toBe(stale('tenjin-search'));
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(await packaged('tenjin-search'));
  });

  // The mirror of tenjin.blog/skills.md may legitimately be NEWER on disk than the
  // one this package ships, and `install` tells operators to re-fetch it from
  // there, so an unattended rewrite would undo their fetch and make that advice a
  // lie. Same skills `doctor`'s staleness check compares, for the same reason.
  it('leaves the hosted tenjin mirror exactly as it found it', async () => {
    const text = stale(HOSTED_SKILL_NAME);
    const hosted = await seedSkill(claudeDir(), HOSTED_SKILL_NAME, text);
    await seedSkill(claudeDir(), 'tenjin-search');
    const { io, stderr } = captureIo();
    await heal(io);
    expect(await readFile(hosted, 'utf8')).toBe(text);
    expect(stderr()).not.toContain(hosted);
  });

  it('does nothing at all in a directory holding only the hosted skill', async () => {
    const text = stale(HOSTED_SKILL_NAME);
    const hosted = await seedSkill(sharedDir(), HOSTED_SKILL_NAME, text);
    const { io, stderr } = captureIo();
    await heal(io);
    expect(await readFile(hosted, 'utf8')).toBe(text);
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

  // A piped run is exactly the case where an unannounced rewrite of the
  // operator's files would otherwise be invisible, so the line is not TTY-gated.
  it('reports the write off a TTY too', async () => {
    const path = await seedSkill(claudeDir(), 'tenjin-search');
    const { io, stderr } = captureIo(false);
    await heal(io);
    expect(await readFile(path, 'utf8')).toBe(await packaged('tenjin-search'));
    expect(stderr()).toContain(path);
  });

  it('does nothing under CI, or when opted out', async () => {
    for (const env of [{ CI: '1' }, { TENJIN_NO_SKILL_HEAL: '1' }]) {
      const path = await seedSkill(claudeDir(), 'tenjin-search');
      const { io, stderr } = captureIo();
      await heal(io, env);
      expect(await readFile(path, 'utf8')).toBe(stale('tenjin-search'));
      expect(stderr()).toBe('');
    }
  });

  // The default source resolution lands on this repo's own skills/ when the CLI
  // runs from a checkout, and those are nobody's agreed-upon install.
  it('does not heal from a source checkout', async () => {
    const path = await seedSkill(claudeDir(), 'tenjin-search');
    const { io, stderr } = captureIo();
    await healWiredSkills({ io, env: {}, homeDir: home });
    expect(await readFile(path, 'utf8')).toBe(stale('tenjin-search'));
    expect(stderr()).toBe('');
  });

  it('writes nothing when HOME is not absolute', async () => {
    const { io } = captureIo();
    await healWiredSkills({
      io,
      env: {},
      homeDir: 'relative-home',
      skillsSourceDir: SKILLS_SRC,
    });
    expect(existsSync('relative-home')).toBe(false);
  });

  it('never rejects when the packaged source is gone', async () => {
    const path = await seedSkill(claudeDir(), 'tenjin-search');
    const { io, stderr } = captureIo();
    await expect(
      healWiredSkills({
        io,
        env: {},
        homeDir: home,
        skillsSourceDir: join(home, 'not-a-skills-dir'),
      }),
    ).resolves.toBeUndefined();
    expect(await readFile(path, 'utf8')).toBe(stale('tenjin-search'));
    expect(stderr()).toBe('');
  });
});
