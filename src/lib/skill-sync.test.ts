import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { maybeResyncSkills, readSkillsStamp, writeSkillsStamp } from './skill-sync';
import { resyncWiredSkills } from '../commands/install';
import { resolveSkillsSource } from './skills-source';
import { skillsSyncPath } from './paths';
import type { Io } from './output';

const PACKAGED = resolveSkillsSource(fileURLToPath(new URL('.', import.meta.url)));

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tenjin-skill-sync-'));
}

function makeIo(isTTY: boolean): { io: Io; errText: () => string } {
  const stderr = new PassThrough();
  let err = '';
  stderr.on('data', (c: Buffer) => (err += c.toString()));
  return {
    io: { stdout: new PassThrough(), stderr, isTTY },
    errText: () => err,
  };
}

describe('the skills stamp', () => {
  it('round-trips, and absent or unparsable both read as null', async () => {
    const dir = tempDir();
    expect(await readSkillsStamp(dir)).toBeNull();
    await writeSkillsStamp(dir, '1.2.3');
    expect(await readSkillsStamp(dir)).toEqual({ schemaVersion: 1, cliVersion: '1.2.3' });
    writeFileSync(skillsSyncPath(dir), 'not json');
    expect(await readSkillsStamp(dir)).toBeNull();
  });
});

describe('maybeResyncSkills', () => {
  const resyncSpy = () => {
    const calls: unknown[] = [];
    return {
      calls,
      fn: async () => {
        calls.push(true);
        return { refreshed: ['x'], removed: [] };
      },
    };
  };

  it('does nothing on a machine install never stamped', async () => {
    const dir = tempDir();
    const spy = resyncSpy();
    const { io } = makeIo(true);
    await maybeResyncSkills({ dir, io, json: false, currentVersion: '2.0.0', resync: spy.fn });
    expect(spy.calls).toHaveLength(0);
    expect(await readSkillsStamp(dir)).toBeNull();
  });

  it('does nothing when the stamp already matches the binary', async () => {
    const dir = tempDir();
    await writeSkillsStamp(dir, '2.0.0');
    const spy = resyncSpy();
    const { io } = makeIo(true);
    await maybeResyncSkills({ dir, io, json: false, currentVersion: '2.0.0', resync: spy.fn });
    expect(spy.calls).toHaveLength(0);
  });

  it('resyncs once on a version change, restamps, and says so at a TTY', async () => {
    const dir = tempDir();
    await writeSkillsStamp(dir, '1.0.0');
    const spy = resyncSpy();
    const { io, errText } = makeIo(true);
    await maybeResyncSkills({ dir, io, json: false, currentVersion: '2.0.0', resync: spy.fn });
    expect(spy.calls).toHaveLength(1);
    expect(await readSkillsStamp(dir)).toEqual({ schemaVersion: 1, cliVersion: '2.0.0' });
    expect(errText()).toContain('tenjin skills refreshed for 2.0.0');
    // Restamped, so the next command is quiet.
    await maybeResyncSkills({ dir, io, json: false, currentVersion: '2.0.0', resync: spy.fn });
    expect(spy.calls).toHaveLength(1);
  });

  it('syncs under --json but keeps the notice off the stream', async () => {
    const dir = tempDir();
    await writeSkillsStamp(dir, '1.0.0');
    const spy = resyncSpy();
    const { io, errText } = makeIo(false);
    await maybeResyncSkills({ dir, io, json: true, currentVersion: '2.0.0', resync: spy.fn });
    expect(spy.calls).toHaveLength(1);
    expect(errText()).toBe('');
  });

  it('swallows a failed sync and leaves the stamp so the next command retries', async () => {
    const dir = tempDir();
    await writeSkillsStamp(dir, '1.0.0');
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
    expect(await readSkillsStamp(dir)).toEqual({ schemaVersion: 1, cliVersion: '1.0.0' });
  });
});

describe('resyncWiredSkills', () => {
  it('refreshes only already-wired directories and never touches foreign skills', async () => {
    const home = tempDir();
    // A wired Claude dir with one drifted copy and one foreign skill.
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(join(claudeSkills, 'tenjin-search'), { recursive: true });
    writeFileSync(join(claudeSkills, 'tenjin-search', 'SKILL.md'), 'stale copy');
    mkdirSync(join(claudeSkills, 'my-notes'), { recursive: true });
    writeFileSync(join(claudeSkills, 'my-notes', 'SKILL.md'), 'mine');

    const { refreshed, removed } = await resyncWiredSkills(home, PACKAGED);

    const packagedSearch = readFileSync(join(PACKAGED, 'tenjin-search', 'SKILL.md'), 'utf8');
    expect(readFileSync(join(claudeSkills, 'tenjin-search', 'SKILL.md'), 'utf8')).toBe(
      packagedSearch,
    );
    // All shipped skills land, matching install's own semantics for a wired dir.
    expect(existsSync(join(claudeSkills, 'tenjin-publish', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(claudeSkills, 'my-notes', 'SKILL.md'), 'utf8')).toBe('mine');
    expect(refreshed.length).toBeGreaterThan(0);
    expect(removed).toEqual([]);
    // The never-wired shared dir is not created.
    expect(existsSync(join(home, '.agents', 'skills'))).toBe(false);
  });

  it('removes a retired skill copy, but not a bare directory sharing its name', async () => {
    const home = tempDir();
    const claudeSkills = join(home, '.claude', 'skills');
    mkdirSync(join(claudeSkills, 'tenjin-search'), { recursive: true });
    writeFileSync(join(claudeSkills, 'tenjin-search', 'SKILL.md'), 'stale');
    mkdirSync(join(claudeSkills, 'tenjin-old'), { recursive: true });
    writeFileSync(join(claudeSkills, 'tenjin-old', 'SKILL.md'), 'retired copy');
    mkdirSync(join(claudeSkills, 'tenjin-older'), { recursive: true }); // bare, no SKILL.md

    const { removed } = await resyncWiredSkills(home, PACKAGED, ['tenjin-old', 'tenjin-older']);

    expect(existsSync(join(claudeSkills, 'tenjin-old'))).toBe(false);
    expect(existsSync(join(claudeSkills, 'tenjin-older'))).toBe(true);
    expect(removed).toEqual([join(claudeSkills, 'tenjin-old')]);
  });

  it('is a no-op on a machine with no wired directory', async () => {
    const home = tempDir();
    const { refreshed, removed } = await resyncWiredSkills(home, PACKAGED);
    expect(refreshed).toEqual([]);
    expect(removed).toEqual([]);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });
});
