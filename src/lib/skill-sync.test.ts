import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adoptableSkillDirs,
  maybeResyncSkills,
  readSkillsStamp,
  writeSkillsStamp,
} from './skill-sync';
import { resyncWiredSkills } from '../commands/install';
import { resolveSkillsSource, SKILL_NAMES } from './skills-source';
import { skillsSyncPath } from './paths';
import type { Io } from './output';

const PACKAGED = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tenjin-skill-sync-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

function makeIo(isTTY: boolean): { io: Io; errText: () => string } {
  const stderr = new PassThrough();
  let err = '';
  stderr.on('data', (c: Buffer) => (err += c.toString()));
  return {
    io: { stdout: new PassThrough(), stderr, isTTY },
    errText: () => err,
  };
}

/** A wired harness directory: a real adapter copy, with stale bytes. */
function wireAdapter(dir: string, name = 'tenjin-search'): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), 'stale copy');
}

const claudeDir = (home: string): string => join(home, '.claude', 'skills');
const sharedDir = (home: string): string => join(home, '.agents', 'skills');

/** Every file under a directory, as path -> bytes, for byte-for-byte comparison. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(d, entry.name), rel);
      else out[rel] = readFileSync(join(d, entry.name), 'utf8');
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

describe('the skills stamp', () => {
  it('round-trips the version and the consented directories', async () => {
    const dir = tempDir();
    expect(await readSkillsStamp(dir)).toBeNull();
    await writeSkillsStamp(dir, '1.2.3', ['/a/skills']);
    expect(await readSkillsStamp(dir)).toEqual({
      schemaVersion: 1,
      cliVersion: '1.2.3',
      dirs: ['/a/skills'],
    });
  });

  it('reads unparsable and pre-dirs shapes as null, so neither authorizes a write', async () => {
    const dir = tempDir();
    writeFileSync(skillsSyncPath(dir), 'not json');
    expect(await readSkillsStamp(dir)).toBeNull();
    // The shape shipped before `dirs` existed: no consent record, so not usable.
    writeFileSync(skillsSyncPath(dir), JSON.stringify({ schemaVersion: 1, cliVersion: '1.0.0' }));
    expect(await readSkillsStamp(dir)).toBeNull();
  });
});

describe('adoptableSkillDirs', () => {
  it('adopts a directory holding a CLI adapter skill', () => {
    const home = tempDir();
    wireAdapter(claudeDir(home), 'tenjin-publish');
    expect(adoptableSkillDirs(home)).toEqual([claudeDir(home)]);
  });

  it('does NOT adopt a hosted-only directory: that mirror is fetchable independently', () => {
    const home = tempDir();
    mkdirSync(join(sharedDir(home), 'tenjin'), { recursive: true });
    writeFileSync(join(sharedDir(home), 'tenjin', 'SKILL.md'), 'hosted');
    expect(adoptableSkillDirs(home)).toEqual([]);
  });

  it('adopts nothing on a machine with no skills at all', () => {
    expect(adoptableSkillDirs(tempDir())).toEqual([]);
  });

  it('reports the shared directory once, not once per harness that reads it', () => {
    const home = tempDir();
    wireAdapter(sharedDir(home));
    expect(adoptableSkillDirs(home)).toEqual([sharedDir(home)]);
  });
});

/** Records the dirs it was asked to resync, so consent scope is assertable. */
function resyncSpy(refreshed: string[] = ['x']): {
  calls: string[][];
  fn: (dirs: readonly string[]) => Promise<{ refreshed: string[]; removed: string[] }>;
} {
  const calls: string[][] = [];
  return {
    calls,
    fn: async (dirs: readonly string[]) => {
      calls.push([...dirs]);
      return { refreshed, removed: [] };
    },
  };
}

describe('maybeResyncSkills', () => {
  it('does nothing when the stamp already matches the binary', async () => {
    const dir = tempDir();
    await writeSkillsStamp(dir, '2.0.0', ['/a']);
    const spy = resyncSpy();
    const { io } = makeIo(true);
    await maybeResyncSkills({ dir, io, json: false, currentVersion: '2.0.0', resync: spy.fn });
    expect(spy.calls).toHaveLength(0);
  });

  it('resyncs the stamped dirs on a version change, restamps, and says so at a TTY', async () => {
    const dir = tempDir();
    await writeSkillsStamp(dir, '1.0.0', ['/a/skills']);
    const spy = resyncSpy();
    const { io, errText } = makeIo(true);
    await maybeResyncSkills({ dir, io, json: false, currentVersion: '2.0.0', resync: spy.fn });
    expect(spy.calls).toEqual([['/a/skills']]);
    expect(await readSkillsStamp(dir)).toEqual({
      schemaVersion: 1,
      cliVersion: '2.0.0',
      dirs: ['/a/skills'],
    });
    expect(errText()).toContain('tenjin skills refreshed for 2.0.0');
    // Restamped, so the next command is quiet.
    await maybeResyncSkills({ dir, io, json: false, currentVersion: '2.0.0', resync: spy.fn });
    expect(spy.calls).toHaveLength(1);
  });

  it('never widens beyond the stamped dirs, whatever else is wired', async () => {
    const dir = tempDir();
    const home = tempDir();
    wireAdapter(claudeDir(home));
    wireAdapter(sharedDir(home));
    await writeSkillsStamp(dir, '1.0.0', [claudeDir(home)]);
    const spy = resyncSpy();
    const { io } = makeIo(false);
    await maybeResyncSkills({
      dir,
      io,
      json: true,
      currentVersion: '2.0.0',
      resync: spy.fn,
      homeDir: home,
    });
    expect(spy.calls).toEqual([[claudeDir(home)]]);
  });

  it('syncs under --json but keeps the notice off the stream', async () => {
    const dir = tempDir();
    await writeSkillsStamp(dir, '1.0.0', ['/a']);
    const spy = resyncSpy();
    const { io, errText } = makeIo(false);
    await maybeResyncSkills({ dir, io, json: true, currentVersion: '2.0.0', resync: spy.fn });
    expect(spy.calls).toHaveLength(1);
    expect(errText()).toBe('');
  });

  // Two first-commands-after-an-update racing. Without the lock the second can
  // read the pre-update stamp while the first is still mid-swap, so both resync
  // and one stamps over the other's unfinished work.
  it('serializes concurrent passes: the resync runs once, not once per process', async () => {
    const dir = tempDir();
    await writeSkillsStamp(dir, '1.0.0', ['/a']);
    let running = 0;
    let overlapped = false;
    let calls = 0;
    const slowResync = async (): Promise<{ refreshed: string[]; removed: string[] }> => {
      calls++;
      running++;
      if (running > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return { refreshed: ['x'], removed: [] };
    };
    const { io } = makeIo(false);
    const run = () =>
      maybeResyncSkills({ dir, io, json: true, currentVersion: '2.0.0', resync: slowResync });

    await Promise.all([run(), run(), run()]);

    expect(overlapped).toBe(false);
    expect(calls).toBe(1); // the queued two re-read the stamp and find it current
    expect((await readSkillsStamp(dir))?.cliVersion).toBe('2.0.0');
  });

  it('swallows a failed sync and leaves the stamp so the next command retries', async () => {
    const dir = tempDir();
    await writeSkillsStamp(dir, '1.0.0', ['/a']);
    const { io } = makeIo(true);
    await maybeResyncSkills({
      dir,
      io,
      json: false,
      currentVersion: '2.0.0',
      resync: async () => {
        throw new Error('disk full');
      },
    });
    expect(await readSkillsStamp(dir)).toEqual({
      schemaVersion: 1,
      cliVersion: '1.0.0',
      dirs: ['/a'],
    });
  });
});

// The machines that ran `tenjin install` before this feature shipped: no stamp
// exists, yet their skills are exactly the ones going stale. They are adopted
// once, from evidence on disk, and only where a CLI adapter proves install ran.
describe('maybeResyncSkills: bootstrapping a pre-feature install', () => {
  it('heals a pre-feature machine and stamps it once', async () => {
    const dir = tempDir();
    const home = tempDir();
    wireAdapter(claudeDir(home));
    const { io } = makeIo(true);

    await maybeResyncSkills({
      dir,
      io,
      json: false,
      currentVersion: '2.0.0',
      homeDir: home,
      resync: async (dirs) => ({ refreshed: [...dirs], removed: [] }),
    });

    expect(await readSkillsStamp(dir)).toEqual({
      schemaVersion: 1,
      cliVersion: '2.0.0',
      dirs: [claudeDir(home)],
    });
    // Stamped, so the adoption scan does not run again.
    const spy = resyncSpy([]);
    await maybeResyncSkills({
      dir,
      io,
      json: false,
      currentVersion: '2.0.0',
      homeDir: home,
      resync: spy.fn,
    });
    expect(spy.calls).toHaveLength(0);
  });

  it('really refreshes the stale bytes, through the default worker', async () => {
    const dir = tempDir();
    const home = tempDir();
    wireAdapter(claudeDir(home));
    const { io } = makeIo(false);

    await maybeResyncSkills({
      dir,
      io,
      json: true,
      currentVersion: '2.0.0',
      homeDir: home,
      resync: async (dirs) => resyncWiredSkills(dirs, PACKAGED),
    });

    const packaged = readFileSync(join(PACKAGED, 'tenjin-search', 'SKILL.md'), 'utf8');
    expect(readFileSync(join(claudeDir(home), 'tenjin-search', 'SKILL.md'), 'utf8')).toBe(packaged);
  });

  // The reviewer's scenario: install ran for Claude only, and the operator
  // fetched the hosted mirror into the shared directory by hand. An update must
  // not treat that as consent to manage the shared directory.
  it('leaves an independently fetched hosted-only shared dir byte-for-byte alone', async () => {
    const dir = tempDir();
    const home = tempDir();
    wireAdapter(claudeDir(home));
    mkdirSync(join(sharedDir(home), 'tenjin'), { recursive: true });
    writeFileSync(join(sharedDir(home), 'tenjin', 'SKILL.md'), 'my own hosted fetch');
    const before = snapshot(sharedDir(home));
    const { io } = makeIo(false);

    await maybeResyncSkills({
      dir,
      io,
      json: true,
      currentVersion: '2.0.0',
      homeDir: home,
      resync: async (dirs) => resyncWiredSkills(dirs, PACKAGED),
    });

    expect(snapshot(sharedDir(home))).toEqual(before);
    expect((await readSkillsStamp(dir))?.dirs).toEqual([claudeDir(home)]);
    // ...and the Claude directory it DID adopt was healed.
    expect(existsSync(join(claudeDir(home), 'tenjin-publish', 'SKILL.md'))).toBe(true);
  });

  it('writes no stamp and touches nothing on a truly unwired machine', async () => {
    const dir = tempDir();
    const home = tempDir();
    const spy = resyncSpy([]);
    const { io } = makeIo(true);

    await maybeResyncSkills({
      dir,
      io,
      json: false,
      currentVersion: '2.0.0',
      homeDir: home,
      resync: spy.fn,
    });

    expect(spy.calls).toHaveLength(0);
    // install stays the first thing that ever consents on this machine.
    expect(await readSkillsStamp(dir)).toBeNull();
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });
});

describe('resyncWiredSkills', () => {
  it('refreshes only the dirs it is given and never touches foreign skills', async () => {
    const home = tempDir();
    const claude = claudeDir(home);
    wireAdapter(claude);
    mkdirSync(join(claude, 'my-notes'), { recursive: true });
    writeFileSync(join(claude, 'my-notes', 'SKILL.md'), 'mine');

    const { refreshed, removed } = await resyncWiredSkills([claude], PACKAGED);

    const packagedSearch = readFileSync(join(PACKAGED, 'tenjin-search', 'SKILL.md'), 'utf8');
    expect(readFileSync(join(claude, 'tenjin-search', 'SKILL.md'), 'utf8')).toBe(packagedSearch);
    // All shipped skills land, matching install's own semantics for a wired dir.
    expect(existsSync(join(claude, 'tenjin-publish', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(claude, 'my-notes', 'SKILL.md'), 'utf8')).toBe('mine');
    expect(refreshed.length).toBeGreaterThan(0);
    expect(removed).toEqual([]);
    // A directory it was not given is never created.
    expect(existsSync(sharedDir(home))).toBe(false);
  });

  it('skips a recorded directory the operator has since emptied', async () => {
    const home = tempDir();
    const { refreshed } = await resyncWiredSkills([claudeDir(home)], PACKAGED);
    expect(refreshed).toEqual([]);
    expect(existsSync(claudeDir(home))).toBe(false);
  });

  it('deduplicates a directory recorded twice', async () => {
    const home = tempDir();
    const claude = claudeDir(home);
    wireAdapter(claude);
    const { refreshed } = await resyncWiredSkills([claude, claude], PACKAGED);
    expect(refreshed).toEqual(SKILL_NAMES.map((n) => join(claude, n)));
  });

  it('removes a retired skill copy, but not a bare directory sharing its name', async () => {
    const home = tempDir();
    const claude = claudeDir(home);
    wireAdapter(claude);
    mkdirSync(join(claude, 'tenjin-old'), { recursive: true });
    writeFileSync(join(claude, 'tenjin-old', 'SKILL.md'), 'retired copy');
    mkdirSync(join(claude, 'tenjin-older'), { recursive: true }); // bare, no SKILL.md

    const { removed } = await resyncWiredSkills([claude], PACKAGED, ['tenjin-old', 'tenjin-older']);

    expect(existsSync(join(claude, 'tenjin-old'))).toBe(false);
    expect(existsSync(join(claude, 'tenjin-older'))).toBe(true);
    expect(removed).toEqual([join(claude, 'tenjin-old')]);
  });

  it('is a no-op when given no directories', async () => {
    const { refreshed, removed } = await resyncWiredSkills([], PACKAGED);
    expect(refreshed).toEqual([]);
    expect(removed).toEqual([]);
  });
});

// The swap runs unattended on someone's first command after an update, so a
// crash mid-write must never leave a half-written skill a harness would load.
describe('resyncWiredSkills: the directory swap is transactional', () => {
  it('leaves the live directory fully intact when the temp write fails', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // mode is no barrier
    const home = tempDir();
    const claude = claudeDir(home);
    wireAdapter(claude);
    writeFileSync(join(claude, 'tenjin-search', 'extra.md'), 'old extra');
    const before = snapshot(join(claude, 'tenjin-search'));

    // Read-only parent: the swap can still read the live copy but cannot create
    // its sibling scratch directory, so the new tree fails to materialize partway
    // through. This is the crash-mid-write shape, minus the crash.
    chmodSync(claude, 0o500);
    try {
      await expect(resyncWiredSkills([claude], PACKAGED)).rejects.toThrow();
    } finally {
      chmodSync(claude, 0o700);
    }

    // Fully old, not partial: the stale copy and its extra file are both still here.
    expect(snapshot(join(claude, 'tenjin-search'))).toEqual(before);
    expect(existsSync(join(claude, `.tenjin-sync-tenjin-search-${process.pid}`))).toBe(false);
  });

  it('leaves no scratch directories behind on a successful swap', async () => {
    const home = tempDir();
    const claude = claudeDir(home);
    wireAdapter(claude);

    await resyncWiredSkills([claude], PACKAGED);

    const entries = Object.keys(snapshot(claude));
    expect(entries.some((p) => p.includes('.tenjin-sync-'))).toBe(false);
    expect(entries.some((p) => p.includes('.old-'))).toBe(false);
  });

  it('replaces the tree wholesale, dropping files the package no longer ships', async () => {
    const home = tempDir();
    const claude = claudeDir(home);
    wireAdapter(claude);
    writeFileSync(join(claude, 'tenjin-search', 'stray.md'), 'gone after the swap');

    await resyncWiredSkills([claude], PACKAGED);

    expect(existsSync(join(claude, 'tenjin-search', 'stray.md'))).toBe(false);
    expect(readFileSync(join(claude, 'tenjin-search', 'SKILL.md'), 'utf8')).toBe(
      readFileSync(join(PACKAGED, 'tenjin-search', 'SKILL.md'), 'utf8'),
    );
  });
});
