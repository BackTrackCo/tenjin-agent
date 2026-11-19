import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  JOB_FOLDER_MARKER,
  JOB_FOLDER_STALE_MS,
  markJobFolder,
  removeJobFolder,
  sweepJobFolders,
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
  const owner = { pid: 4_000_001, startedAt: now - 3 * HOUR };
  const settings = await folder('tenjin-worker-settings-AbCdEf', { ageMs: HOUR, owner });
  const github = await folder('tenjin-worker-Gh1234', { ageMs: HOUR, owner });
  const temp = await folder('tenjin-job-Tm5678', { ageMs: HOUR, owner });
  const removed = await sweep(facts({ alive: () => false }));
  expect(removed.sort()).toEqual([github, settings, temp].sort());
  for (const path of [settings, github, temp]) expect(existsSync(path)).toBe(false);
});

it('leaves the folder of a job that still runs in another process alone', async () => {
  // Failure caught: a sweep at one session's start taking the settings file out from under
  // a worker another Claude Code session runs, however old the folder looks.
  const live = { pid: 4_000_002, startedAt: now - 5 * HOUR };
  const old = JOB_FOLDER_STALE_MS + HOUR;
  const paths = [
    await folder('tenjin-worker-settings-Live01', { ageMs: old, owner: live }),
    await folder('tenjin-worker-Live02', { ageMs: old, owner: live }),
    await folder('tenjin-job-Live03', { ageMs: old, owner: live }),
  ];
  const removed = await sweep(
    facts({ alive: (pid) => pid === live.pid, startedAt: async () => live.startedAt + 1000 }),
  );
  expect(removed).toEqual([]);
  for (const path of paths) expect(existsSync(path), path).toBe(true);
});

it('never takes a folder of its own process, however its owner reads', async () => {
  const own = await folder('tenjin-worker-settings-Own001', {
    ageMs: 3 * HOUR,
    owner: { pid: process.pid, startedAt: 1 },
  });
  expect(await sweep(facts({ alive: () => false }))).toEqual([]);
  expect(existsSync(own)).toBe(true);
});

it('takes a folder whose pid another process now holds, told by its start time', async () => {
  const reused = await folder('tenjin-worker-settings-Reuse1', {
    ageMs: HOUR,
    owner: { pid: 4_000_003, startedAt: now - 10 * HOUR },
  });
  const removed = await sweep(
    facts({ alive: () => true, startedAt: async () => now - 60_000 /* a newer process */ }),
  );
  expect(removed).toEqual([reused]);
});

it('leaves a young folder whose owner is gone: age is the second condition', async () => {
  const young = await folder('tenjin-worker-settings-Young1', {
    ageMs: 5_000,
    owner: { pid: 4_000_004, startedAt: now - HOUR },
  });
  expect(await sweep(facts())).toEqual([]);
  expect(existsSync(young)).toBe(true);
});

it('keeps a folder whose owner is alive but whose start cannot be read, until no job can be that old', async () => {
  const owner = { pid: 4_000_005, startedAt: now - HOUR };
  const recent = await folder('tenjin-worker-settings-Unk001', { ageMs: 20 * 60_000, owner });
  const ancient = await folder('tenjin-worker-settings-Unk002', {
    ageMs: JOB_FOLDER_STALE_MS + HOUR,
    owner,
  });
  const removed = await sweep(facts({ alive: () => true, startedAt: async () => undefined }));
  expect(removed).toEqual([ancient]);
  expect(existsSync(recent)).toBe(true);
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
