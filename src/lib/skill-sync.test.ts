import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  legacySkillDirs,
  maybeResyncSkills,
  readSkillsStamp,
  REINSTALL_NOTICE,
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

describe('legacySkillDirs', () => {
  it('detects a directory holding a CLI adapter skill', () => {
    const home = tempDir();
    wireAdapter(claudeDir(home), 'tenjin-publish');
    expect(legacySkillDirs(home)).toEqual([claudeDir(home)]);
  });

  it('ignores a hosted-only directory: that mirror is fetchable independently', () => {
    const home = tempDir();
    mkdirSync(join(sharedDir(home), 'tenjin'), { recursive: true });
    writeFileSync(join(sharedDir(home), 'tenjin', 'SKILL.md'), 'hosted');
    expect(legacySkillDirs(home)).toEqual([]);
  });

  it('finds nothing on a machine with no skills at all', () => {
    expect(legacySkillDirs(tempDir())).toEqual([]);
  });

  it('reports the shared directory once, not once per harness that reads it', () => {
    const home = tempDir();
    wireAdapter(sharedDir(home));
    expect(legacySkillDirs(home)).toEqual([sharedDir(home)]);
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
// A machine with wired skills but no stamp. An adapter file is not provenance:
// `npx skills add BackTrackCo/tenjin-agent` plants the same adapters, so nothing
// on disk distinguishes a `tenjin install` from another installer's copy. The
// self-heal therefore writes NOTHING and points at the one ceremony that grants
// ownership.
describe('maybeResyncSkills: a legacy machine is noticed, never adopted', () => {
  it('prints the reinstall notice once per CLI version and writes no skills', async () => {
    const dir = tempDir();
    const home = tempDir();
    wireAdapter(claudeDir(home));
    const before = snapshot(claudeDir(home));
    const spy = resyncSpy();
    const { io, errText } = makeIo(true);
    const run = () =>
      maybeResyncSkills({
        dir,
        io,
        json: false,
        currentVersion: '2.0.0',
        homeDir: home,
        resync: spy.fn,
      });

    await run();
    expect(errText()).toContain(REINSTALL_NOTICE);
    expect(spy.calls).toHaveLength(0);
    expect(snapshot(claudeDir(home))).toEqual(before);

    // Second command on the same version: silent, and still no writes.
    const firstText = errText();
    await run();
    expect(errText()).toBe(firstText);
    expect(spy.calls).toHaveLength(0);
  });

  it('notices again on the next CLI version', async () => {
    const dir = tempDir();
    const home = tempDir();
    wireAdapter(claudeDir(home));
    const { io, errText } = makeIo(true);
    const base = { dir, io, json: false, homeDir: home, resync: resyncSpy().fn };

    await maybeResyncSkills({ ...base, currentVersion: '2.0.0' });
    await maybeResyncSkills({ ...base, currentVersion: '3.0.0' });
    expect(errText().split(REINSTALL_NOTICE)).toHaveLength(3); // two notices
  });

  // The stamp it leaves must never be mistaken for consent.
  it('records the notice with an EMPTY dirs list, which authorizes no writes', async () => {
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
      resync: resyncSpy().fn,
    });

    const stamp = await readSkillsStamp(dir);
    expect(stamp?.dirs).toEqual([]);
    expect(stamp?.noticedVersion).toBe('2.0.0');

    // A later version sees empty dirs and still refuses to sync anything.
    const spy = resyncSpy();
    await maybeResyncSkills({
      dir,
      io,
      json: false,
      currentVersion: '9.9.9',
      homeDir: home,
      resync: spy.fn,
    });
    expect(spy.calls).toHaveLength(0);
  });

  // The reviewer's scenario: `npx skills add` planted the adapters, tenjin
  // install never ran. Not one byte may change.
  it('leaves an npx-skills-add directory byte-for-byte untouched', async () => {
    const dir = tempDir();
    const home = tempDir();
    const claude = claudeDir(home);
    mkdirSync(join(claude, 'tenjin-search'), { recursive: true });
    writeFileSync(join(claude, 'tenjin-search', 'SKILL.md'), 'placed by npx skills add');
    mkdirSync(join(claude, 'tenjin-publish'), { recursive: true });
    writeFileSync(join(claude, 'tenjin-publish', 'SKILL.md'), 'placed by npx skills add');
    const before = snapshot(claude);
    const { io } = makeIo(true);

    await maybeResyncSkills({
      dir,
      io,
      json: false,
      currentVersion: '2.0.0',
      homeDir: home,
      resync: async (dirs) => resyncWiredSkills(dirs, PACKAGED),
    });

    expect(snapshot(claude)).toEqual(before);
  });

  it('stays silent under --json and off a TTY, and records nothing', async () => {
    const dir = tempDir();
    const home = tempDir();
    wireAdapter(claudeDir(home));
    const { io, errText } = makeIo(false);
    await maybeResyncSkills({
      dir,
      io,
      json: true,
      currentVersion: '2.0.0',
      homeDir: home,
      resync: resyncSpy().fn,
    });
    expect(errText()).toBe('');
    expect(await readSkillsStamp(dir)).toBeNull();
  });

  it('writes no stamp and touches nothing on a truly unwired machine', async () => {
    const dir = tempDir();
    const home = tempDir();
    const spy = resyncSpy([]);
    const { io, errText } = makeIo(true);

    await maybeResyncSkills({
      dir,
      io,
      json: false,
      currentVersion: '2.0.0',
      homeDir: home,
      resync: spy.fn,
    });

    expect(spy.calls).toHaveLength(0);
    expect(errText()).toBe('');
    expect(await readSkillsStamp(dir)).toBeNull();
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  // A pre-feature headless install may never have created ~/.tenjin at all, and
  // the lock's own mkdir is non-recursive.
  it('works when the data directory does not exist yet', async () => {
    const parent = tempDir();
    const dir = join(parent, 'never', 'created');
    const home = tempDir();
    wireAdapter(claudeDir(home));
    const { io, errText } = makeIo(true);

    await maybeResyncSkills({
      dir,
      io,
      json: false,
      currentVersion: '2.0.0',
      homeDir: home,
      resync: resyncSpy().fn,
    });

    expect(errText()).toContain(REINSTALL_NOTICE);
    expect((await readSkillsStamp(dir))?.noticedVersion).toBe('2.0.0');
  });

  it('syncs a stamped machine whose data directory was removed underneath it', async () => {
    const parent = tempDir();
    const dir = join(parent, 'gone');
    const home = tempDir();
    wireAdapter(claudeDir(home));
    await writeSkillsStamp(dir, '1.0.0', [claudeDir(home)]);
    rmSync(join(dir, 'skills-sync.json'));
    rmSync(dir, { recursive: true, force: true });
    // Stamp gone with the directory: this is now the legacy shape, and must
    // still not throw or write skills.
    const spy = resyncSpy();
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

// The one window the two-rename swap leaves open: the live directory is parked
// and the replacement is not in place yet. A crash there must cost a retry, not
// a missing skill, which is why the park name is deterministic.
describe('resyncWiredSkills: recovery from a crash mid-swap', () => {
  /** The state a SIGKILL between the two renames leaves on disk. */
  function crashMidSwap(dir: string, name: string): void {
    mkdirSync(join(dir, `.tenjin-old-${name}`), { recursive: true });
    writeFileSync(join(dir, `.tenjin-old-${name}`, 'SKILL.md'), 'the parked old copy');
    writeFileSync(join(dir, `.tenjin-old-${name}`, 'extra.md'), 'parked too');
  }

  it('restores the parked copy and completes the update', async () => {
    const home = tempDir();
    const claude = claudeDir(home);
    mkdirSync(claude, { recursive: true });
    crashMidSwap(claude, 'tenjin-search');
    expect(existsSync(join(claude, 'tenjin-search'))).toBe(false); // no live dir

    await resyncWiredSkills([claude], PACKAGED);

    // A complete live directory, matching the package...
    expect(readFileSync(join(claude, 'tenjin-search', 'SKILL.md'), 'utf8')).toBe(
      readFileSync(join(PACKAGED, 'tenjin-search', 'SKILL.md'), 'utf8'),
    );
    // ...the park is gone, and the parked-only file did not survive the swap.
    expect(existsSync(join(claude, '.tenjin-old-tenjin-search'))).toBe(false);
    expect(existsSync(join(claude, 'tenjin-search', 'extra.md'))).toBe(false);
  });

  // Without this the crashed directory fails the "is anything wired here" bar
  // and is skipped forever, so the skill stays missing.
  it('counts a park as wiring evidence, so a crashed dir is not skipped', async () => {
    const home = tempDir();
    const claude = claudeDir(home);
    mkdirSync(claude, { recursive: true });
    crashMidSwap(claude, 'tenjin-search'); // the ONLY thing in the directory

    const { refreshed } = await resyncWiredSkills([claude], PACKAGED);

    expect(refreshed.length).toBeGreaterThan(0);
    for (const name of SKILL_NAMES) {
      expect(existsSync(join(claude, name, 'SKILL.md'))).toBe(true);
    }
  });

  it('clears a redundant park left by a crash after the second rename', async () => {
    const home = tempDir();
    const claude = claudeDir(home);
    // Live copy already current, plus a stale park the crashed run never removed.
    mkdirSync(join(claude, 'tenjin-search'), { recursive: true });
    writeFileSync(
      join(claude, 'tenjin-search', 'SKILL.md'),
      readFileSync(join(PACKAGED, 'tenjin-search', 'SKILL.md'), 'utf8'),
    );
    crashMidSwap(claude, 'tenjin-search');

    await resyncWiredSkills([claude], PACKAGED);

    expect(existsSync(join(claude, '.tenjin-old-tenjin-search'))).toBe(false);
    expect(readFileSync(join(claude, 'tenjin-search', 'SKILL.md'), 'utf8')).toBe(
      readFileSync(join(PACKAGED, 'tenjin-search', 'SKILL.md'), 'utf8'),
    );
  });
});

// A crashed holder used to lock the self-heal out permanently: every later
// command waited out the full timeout, threw, and was swallowed in silence.
describe('maybeResyncSkills: a stale lock does not lock the machine out', () => {
  const lockPath = (dir: string) => join(dir, 'skills-sync.lock');

  it('recovers a lock left behind by a crashed process', async () => {
    const dir = tempDir();
    await writeSkillsStamp(dir, '1.0.0', ['/a']);
    mkdirSync(lockPath(dir), { recursive: true });
    const old = Date.now() / 1000 - 3600; // an hour ago, well past the stale window
    utimesSync(lockPath(dir), old, old);

    const spy = resyncSpy();
    const { io } = makeIo(false);
    await maybeResyncSkills({ dir, io, json: true, currentVersion: '2.0.0', resync: spy.fn });

    expect(spy.calls).toHaveLength(1);
    expect((await readSkillsStamp(dir))?.cliVersion).toBe('2.0.0');
  });

  it('still waits for a FRESH lock rather than stealing it', async () => {
    const dir = tempDir();
    await writeSkillsStamp(dir, '1.0.0', ['/a']);
    mkdirSync(lockPath(dir), { recursive: true }); // just created, so not stale

    const spy = resyncSpy();
    const { io } = makeIo(false);
    await maybeResyncSkills({
      dir,
      io,
      json: true,
      currentVersion: '2.0.0',
      resync: spy.fn,
      lockTimeoutMs: 150,
    });

    // Timed out and was swallowed: no resync, and the old stamp survives so the
    // next command retries.
    expect(spy.calls).toHaveLength(0);
    expect((await readSkillsStamp(dir))?.cliVersion).toBe('1.0.0');
  });
});
