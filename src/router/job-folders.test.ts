import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  JOB_FOLDER_MARKER,
  JOB_FOLDER_STALE_MS,
  markJobFolder,
  parsePsStart,
  removeJobFolder,
  sweepJobFolders,
  systemProcessFacts,
  type ProcessFacts,
} from './job-folders';

// Every folder here is under a temp directory of this test's own, never the real one.
let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'job-folders-test-')));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

const HOUR = 60 * 60_000;
const now = Date.now();
/** A job folder of the given kind and age, with an owner marker unless `owner` is null. */
async function folder(
  name: string,
  o: { ageMs: number; owner?: { pid: number; startedAt: number } | null },
) {
  const path = join(scratch, name);
  await mkdir(path);
  await writeFile(join(path, 'settings.json'), '{}');
  if (o.owner)
    await writeFile(join(path, JOB_FOLDER_MARKER), JSON.stringify(o.owner), { mode: 0o600 });
  const at = new Date(now - o.ageMs);
  if (o.owner) await utimes(join(path, JOB_FOLDER_MARKER), at, at);
  await utimes(path, at, at);
  return path;
}
const facts = (o: Partial<ProcessFacts> & { alive?: (pid: number) => boolean } = {}) => ({
  alive: () => false,
  startedAt: async () => undefined,
  commandLines: async () => '',
  ...o,
});
const sweep = (f: ProcessFacts) =>
  sweepJobFolders({ directories: [scratch], now, facts: f, changedAt: (stat) => stat.mtimeMs });

it('marks a folder with the process that made it, readable by this user alone', async () => {
  const path = join(scratch, 'tenjin-worker-settings-AbCdEf');
  await mkdir(path);
  markJobFolder(path);
  const file = join(path, JOB_FOLDER_MARKER);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid });
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

it('removes the folder of a job whose process is gone, in each of the three kinds', async () => {
  // Failure caught: a crash or a kill of `tenjin mcp` left the job's settings folder, which
  // holds its bridge token and GitHub token, in the temp folder for good.
  const owner = { pid: 4_000_001, startedAt: now - 9 * HOUR };
  const settings = await folder('tenjin-worker-settings-AbCdEf', { ageMs: 3 * HOUR, owner });
  const github = await folder('tenjin-worker-Gh1234', { ageMs: 3 * HOUR, owner });
  const temp = await folder('tenjin-job-Tm5678', { ageMs: 3 * HOUR, owner });
  const removed = await sweep(facts({ alive: () => false }));
  expect(removed.sort()).toEqual([github, settings, temp].sort());
  for (const path of [settings, github, temp]) expect(existsSync(path)).toBe(false);
});

it('leaves a folder whose owner is gone until it has been quiet for hours', async () => {
  const young = await folder('tenjin-worker-settings-Young1', {
    ageMs: 30 * 60_000,
    owner: { pid: 4_000_004, startedAt: now - HOUR },
  });
  expect(await sweep(facts())).toEqual([]);
  expect(existsSync(young)).toBe(true);
});

it('never removes the folder of a live owner in another process, whatever its start time reads', async () => {
  // Failure caught: a sweep at one session's start taking the settings file out from under a
  // worker another Claude Code session runs: `ps` printed local time, one hour early for a
  // process started in the second 01:30 of a fall-back night, and the owner read as a reused pid.
  const live = { pid: 4_000_002, startedAt: now - 20 * HOUR };
  // Quiet for hours, as after a sleeping laptop; each start below is before the last beat.
  const beat = now - 5 * HOUR;
  const paths = [
    await folder('tenjin-worker-settings-Live01', { ageMs: 5 * HOUR, owner: live }),
    await folder('tenjin-worker-Live02', { ageMs: 5 * HOUR, owner: live }),
    await folder('tenjin-job-Live03', { ageMs: 5 * HOUR, owner: live }),
  ];
  for (const started of [
    live.startedAt,
    live.startedAt - HOUR,
    live.startedAt + HOUR,
    live.startedAt + 3 * HOUR,
    beat + 5 * 60_000,
    undefined,
  ]) {
    const removed = await sweep(
      facts({ alive: (pid) => pid === live.pid, startedAt: async () => started }),
    );
    expect(removed, String(started)).toEqual([]);
    for (const path of paths) expect(existsSync(path), path).toBe(true);
  }
});

it('keeps a live owner whose system clock moved between the mark and the sweep', async () => {
  const live = { pid: 4_000_007, startedAt: now - 3 * HOUR };
  const path = await folder('tenjin-worker-settings-Clock1', { ageMs: 0, owner: live });
  // The clock jumped forward ten days: the beat looks ancient, the owner still holds its pid
  // and started before that beat.
  expect(
    await sweepJobFolders({
      directories: [scratch],
      now: now + 10 * 24 * HOUR,
      facts: facts({ alive: () => true, startedAt: async () => live.startedAt }),
      changedAt: (stat) => stat.mtimeMs,
    }),
  ).toEqual([]);
  // The clock jumped back: the beat lies in the future.
  expect(
    await sweepJobFolders({
      directories: [scratch],
      now: now - 10 * 24 * HOUR,
      facts: facts({ alive: () => false }),
      changedAt: (stat) => stat.mtimeMs,
    }),
  ).toEqual([]);
  expect(existsSync(path)).toBe(true);
});

it('never takes a folder of its own process, however its owner reads', async () => {
  const own = await folder('tenjin-worker-settings-Own001', {
    ageMs: 3 * HOUR,
    owner: { pid: process.pid, startedAt: 1 },
  });
  expect(await sweep(facts({ alive: () => false }))).toEqual([]);
  expect(existsSync(own)).toBe(true);
});

it('takes a folder whose pid a different process holds, once that process started long after the owner was last seen', async () => {
  const reused = await folder('tenjin-worker-settings-Reuse1', {
    ageMs: 5 * HOUR,
    owner: { pid: 4_000_003, startedAt: now - 10 * HOUR },
  });
  const removed = await sweep(facts({ alive: () => true, startedAt: async () => now - 2 * HOUR }));
  expect(removed).toEqual([reused]);
});

it('reads a ps start time in UTC, whatever the time zone and the hour', () => {
  const saved = process.env.TZ;
  try {
    // 01:30 happens twice in New York on 2026-11-01; 02:30 does not exist on 2026-03-08.
    process.env.TZ = 'America/New_York';
    expect(parsePsStart('Sun Nov  1 01:30:00 2026\n')).toBe(Date.UTC(2026, 10, 1, 1, 30));
    expect(parsePsStart('Sun Mar  8 02:30:00 2026\n')).toBe(Date.UTC(2026, 2, 8, 2, 30));
    for (const bad of ['', 'garbage', 'Sun Nov  1 25:61:00 2026 extra', '1 Nov 2026'])
      expect(parsePsStart(bad), bad).toBeUndefined();
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

it.skipIf(process.platform === 'win32')(
  'reads the real start of a process the same in a fall-back time zone',
  async () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const own = Math.round(Date.now() - process.uptime() * 1000);
      const read = await systemProcessFacts.startedAt(process.pid);
      expect(Math.abs(read! - own)).toBeLessThan(5_000);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  },
);

it('touches the marker while the owner runs, and stops once the folder is removed', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    const path = join(scratch, 'tenjin-worker-settings-Beat01');
    await mkdir(path);
    markJobFolder(path);
    const marker = join(path, JOB_FOLDER_MARKER);
    const old = new Date(now - 5 * HOUR);
    await utimes(marker, old, old);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(statSync(marker).mtimeMs).toBeGreaterThan(now - HOUR);
    await removeJobFolder(path);
  } finally {
    vi.useRealTimers();
  }
});

it('treats a folder with no marker as stale only when older than any job and named by no process', async () => {
  // The folders an older build left carry no marker.
  const old = JOB_FOLDER_STALE_MS + HOUR;
  const left = await folder('tenjin-worker-settings-Old001', { ageMs: old });
  const named = await folder('tenjin-worker-settings-Old002', { ageMs: old });
  const young = await folder('tenjin-worker-settings-Old003', { ageMs: 20 * 60_000 });
  const removed = await sweep(
    facts({ commandLines: async () => `claude --settings ${join(named, 'settings.json')}\n` }),
  );
  expect(removed).toEqual([left]);
  expect(existsSync(named)).toBe(true);
  expect(existsSync(young)).toBe(true);
});

it('keeps a folder with no marker where the process list cannot be read', async () => {
  const unlisted = await folder('tenjin-worker-settings-Old004', {
    ageMs: JOB_FOLDER_STALE_MS + HOUR,
  });
  expect(await sweep(facts({ commandLines: async () => undefined }))).toEqual([]);
  expect(existsSync(unlisted)).toBe(true);
});

it('touches only folders of the names a job makes, and never follows a link', async () => {
  const owner = { pid: 4_000_006, startedAt: now - 3 * HOUR };
  const other = await folder('tenjin-worker-views-xyz', { ageMs: 3 * HOUR, owner });
  const similar = await folder('tenjin-worker-AbCdEfG', { ageMs: 3 * HOUR, owner });
  const target = await folder('keep-me', { ageMs: 3 * HOUR });
  const { symlink } = await import('node:fs/promises');
  await symlink(target, join(scratch, 'tenjin-job-Link01'));
  expect(await sweep(facts())).toEqual([]);
  for (const path of [other, similar, target]) expect(existsSync(path), path).toBe(true);
});

it('never throws, also where the folder list cannot be read', async () => {
  await expect(
    sweepJobFolders({ directories: [join(scratch, 'missing')], facts: facts() }),
  ).resolves.toEqual([]);
});

it('removes a folder, and says it could not rather than throwing', async () => {
  const path = await folder('tenjin-worker-settings-Rm0001', { ageMs: 0 });
  expect(await removeJobFolder(path)).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(await removeJobFolder(path)).toBe(true);
});
