import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTeamInit, runTeamSync } from './team';
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

  it('refuses when notesDir already has content that is not a repo', async () => {
    await mkdir(notesDir(dataDir), { recursive: true });
    await writeFile(join(notesDir(dataDir), 'stray.txt'), 'not a note repo');
    await expect(
      runTeamInit({ gitUrl: 'https://example.invalid/x.git' }, makeCtx()),
    ).rejects.toThrow(CliError);
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
