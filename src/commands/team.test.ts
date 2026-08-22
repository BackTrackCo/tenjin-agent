import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runTeamInit, runTeamSync } from './team';
import type { TeamInitDeps } from './team';
import { notesDir } from '../lib/paths';
import { CliError } from '../lib/errors';
import type { CommandContext } from '../context';

let root: string;
let dataDir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tenjin-team-cmd-'));
  dataDir = join(root, 'data');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeCtx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000 },
    dataDir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

/** A bare "origin" with one commit on `main`, so a clone has a HEAD to check out. */
function makeOrigin(): string {
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  const seed = join(root, 'seed');
  execFileSync('git', ['clone', '--quiet', origin, seed]);
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: seed });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: seed });
  execFileSync('bash', ['-c', 'echo "team notes" > README.md'], { cwd: seed });
  execFileSync('git', ['add', '-A'], { cwd: seed });
  execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: seed });
  execFileSync('git', ['push', '--quiet', 'origin', 'HEAD:main'], { cwd: seed });
  return origin;
}

describe('runTeamInit', () => {
  it('clones into notesDir when it does not exist yet', async () => {
    const origin = makeOrigin();
    const result = await runTeamInit({ gitUrl: origin }, makeCtx());
    expect(result.data).toEqual({ dir: notesDir(dataDir) });
    await expect(readFile(join(notesDir(dataDir), 'README.md'), 'utf8')).resolves.toContain(
      'team notes',
    );
  });

  it('clones into an existing, empty, non-repo directory', async () => {
    const origin = makeOrigin();
    await mkdir(notesDir(dataDir), { recursive: true });
    await runTeamInit({ gitUrl: origin }, makeCtx());
    await expect(readFile(join(notesDir(dataDir), 'README.md'), 'utf8')).resolves.toContain(
      'team notes',
    );
  });

  /**
   * The URL is not merely an address. A value starting with `-` is parsed by
   * git as an OPTION to `clone` — `--upload-pack=<cmd>` runs `<cmd>` — and the
   * `ext::` transport exists to execute a command. An argv array does not help
   * with either: the parsing that matters is git's own.
   */
  it.each([
    ['a leading-dash option', '--upload-pack=touch /tmp/pwned'],
    ['a short-flag option', '-uecho'],
    ['the ext transport', "ext::sh -c 'touch /tmp/pwned'"],
    ['an unknown scheme', 'javascript:alert(1)'],
    ['a relative path', '../../etc'],
    ['a bare word', 'origin'],
    ['nothing at all', '   '],
  ])('refuses %s before git is invoked', async (_label, gitUrl) => {
    let invoked = false;
    const git: TeamInitDeps['git'] = async () => {
      invoked = true;
      return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false };
    };
    await expect(runTeamInit({ gitUrl }, makeCtx(), { git })).rejects.toMatchObject({
      code: 'USAGE',
    });
    expect(invoked).toBe(false);
    expect(existsSync(notesDir(dataDir))).toBe(false);
  });

  it.each([
    ['https', 'https://github.com/org/repo.git'],
    ['ssh', 'ssh://git@github.com/org/repo.git'],
    ['git', 'git://github.com/org/repo.git'],
    ['file', 'file:///srv/notes.git'],
    ['scp-like', 'git@github.com:org/repo.git'],
  ])('accepts a %s URL', async (_label, gitUrl) => {
    let seen: readonly string[] = [];
    const git: TeamInitDeps['git'] = async (argv) => {
      seen = argv;
      return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false };
    };
    await runTeamInit({ gitUrl }, makeCtx(), { git });
    expect(seen[1]).toBe(gitUrl);
  });

  it('refuses when notesDir already has content that is not a repo', async () => {
    await mkdir(notesDir(dataDir), { recursive: true });
    await writeFile(join(notesDir(dataDir), 'stray.txt'), 'not a note repo');
    await expect(
      runTeamInit({ gitUrl: 'https://example.invalid/x.git' }, makeCtx()),
    ).rejects.toThrow(CliError);
  });

  /**
   * What `isEmptyDir` answers authorizes a delete: "empty" is what gets past the
   * overwrite guard, and a failed clone then `rm -rf`s the path. Returning true
   * on any readdir error handed that authorization to every case it could not
   * look at — a regular file raises ENOTDIR and was read as empty.
   */
  it('refuses a plain file at notesDir instead of deleting it', async () => {
    await mkdir(dirname(notesDir(dataDir)), { recursive: true });
    await writeFile(notesDir(dataDir), "somebody else's file");
    const bogus = join(root, 'does-not-exist.git');

    await expect(runTeamInit({ gitUrl: bogus }, makeCtx())).rejects.toMatchObject({
      code: 'USAGE',
    });
    // Still there, still theirs.
    await expect(readFile(notesDir(dataDir), 'utf8')).resolves.toBe("somebody else's file");
  });

  it('refuses a symlink at notesDir rather than cloning through it', async () => {
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, 'keep.txt'), 'not ours to touch');
    await mkdir(dirname(notesDir(dataDir)), { recursive: true });
    await symlink(elsewhere, notesDir(dataDir));

    await expect(
      runTeamInit({ gitUrl: join(root, 'does-not-exist.git') }, makeCtx()),
    ).rejects.toMatchObject({ code: 'USAGE' });
    await expect(readFile(join(elsewhere, 'keep.txt'), 'utf8')).resolves.toBe('not ours to touch');
  });

  it('refuses when notesDir is already an initialized repo', async () => {
    const origin = makeOrigin();
    await runTeamInit({ gitUrl: origin }, makeCtx());
    await expect(runTeamInit({ gitUrl: origin }, makeCtx())).rejects.toThrow(/already/);
  });

  it('reports a real clone failure as INTERNAL, not a silent success', async () => {
    const bogus = join(root, 'does-not-exist.git');
    await expect(runTeamInit({ gitUrl: bogus }, makeCtx())).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  /**
   * The retry the error message asks for has to be able to run. A failed clone
   * that leaves its directory behind is neither a repo (so `team sync` refuses
   * it) nor empty (so the guard in `team init` refuses it) — the command would
   * be stuck on its own wreckage with no documented way out.
   */
  it('leaves no directory behind after a failed clone, so the retry works', async () => {
    const bogus = join(root, 'does-not-exist.git');
    await expect(runTeamInit({ gitUrl: bogus }, makeCtx())).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(existsSync(notesDir(dataDir))).toBe(false);

    // And the retry the fix line names now succeeds.
    const origin = makeOrigin();
    const result = await runTeamInit({ gitUrl: origin }, makeCtx());
    expect((result.data as { dir: string }).dir).toBe(notesDir(dataDir));
    expect(existsSync(join(notesDir(dataDir), 'README.md'))).toBe(true);
  });

  /**
   * The case git cannot be asked to produce: a clone KILLED at the timeout. Git
   * tidies up after its own errors, but not after SIGKILL, so this is the one
   * that actually leaves a half-written directory behind — and the one the
   * cleanup exists for. The seam stands in for the killed clone.
   */
  it('removes the half-written directory a killed clone leaves behind', async () => {
    const killed: TeamInitDeps['git'] = async (args) => {
      // What a killed `git clone` leaves: the target directory, partly written.
      const target = args[2]!;
      await mkdir(join(target, '.git'), { recursive: true });
      await writeFile(join(target, '.git', 'FETCH_HEAD'), 'partial\n');
      return { ok: false, code: null, timedOut: true, stderr: '' };
    };
    await expect(
      runTeamInit({ gitUrl: 'https://example.invalid/x.git' }, makeCtx(), { git: killed }),
    ).rejects.toMatchObject({ code: 'INTERNAL', message: /timed out after 120s/ });
    expect(existsSync(notesDir(dataDir))).toBe(false);
  });

  /** An empty directory the operator made themselves is theirs; the cleanup puts
   *  it back rather than taking it away. */
  it('puts back an empty directory it was handed, after a killed clone', async () => {
    await mkdir(notesDir(dataDir), { recursive: true });
    const killed: TeamInitDeps['git'] = async (args) => {
      await mkdir(join(args[2]!, '.git'), { recursive: true });
      return { ok: false, code: null, timedOut: true, stderr: '' };
    };
    await expect(
      runTeamInit({ gitUrl: 'https://example.invalid/x.git' }, makeCtx(), { git: killed }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(existsSync(notesDir(dataDir))).toBe(true);
    expect(await readdir(notesDir(dataDir))).toEqual([]);
  });

  /** The budget a clone gets, which is NOT `runGit`'s 10s default: that default
   *  is sized for the local one-object operations `notes add` does. */
  it('gives the clone its own 120s budget', async () => {
    let sawTimeout: number | undefined;
    const spy: TeamInitDeps['git'] = async (_args, _cwd, timeoutMs) => {
      sawTimeout = timeoutMs;
      return { ok: false, code: 1, timedOut: false, stderr: 'nope' };
    };
    await expect(
      runTeamInit({ gitUrl: 'https://example.invalid/x.git' }, makeCtx(), { git: spy }),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(sawTimeout).toBe(120_000);
  });
});

describe('runTeamSync', () => {
  it('refuses when notesDir is not a git repo', async () => {
    await expect(runTeamSync(makeCtx())).rejects.toThrow(CliError);
  });

  it('pulls a fast-forward commit made on the origin by another clone', async () => {
    const origin = makeOrigin();
    await runTeamInit({ gitUrl: origin }, makeCtx());

    // A second clone pushes a new commit that `team sync` should pull down.
    const other = join(root, 'other-clone');
    execFileSync('git', ['clone', '--quiet', origin, other]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: other });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: other });
    await writeFile(join(other, 'from-teammate.txt'), 'hi');
    execFileSync('git', ['add', '-A'], { cwd: other });
    execFileSync('git', ['commit', '--quiet', '-m', 'teammate change'], { cwd: other });
    execFileSync('git', ['push', '--quiet'], { cwd: other });

    const result = await runTeamSync(makeCtx());
    expect(result.data).toEqual({ dir: notesDir(dataDir) });
    await expect(readFile(join(notesDir(dataDir), 'from-teammate.txt'), 'utf8')).resolves.toBe(
      'hi',
    );
  });
});
