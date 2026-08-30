/* global process */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = process.cwd();
const fixtureDir = join(repoRoot, 'evals', 'tenjin-publish', 'session-capture', 'v1');
const entry = join(fixtureDir, 'replay.ts');
const outDir = mkdtempSync(join(tmpdir(), 'tenjin-session-capture-build-'));
const binary = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsup.cmd' : 'tsup',
);

try {
  const built = spawnSync(
    binary,
    [
      entry,
      '--format',
      'esm',
      '--platform',
      'node',
      '--target',
      'node24',
      '--out-dir',
      outDir,
      '--no-config',
      '--silent',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (built.error !== undefined) throw built.error;
  if (built.status !== 0) {
    process.stderr.write(built.stderr || built.stdout || 'session-capture replay build failed\n');
    process.exitCode = built.status ?? 1;
  } else {
    const output = readdirSync(outDir).find((name) => /^replay\.(?:m?js)$/.test(name));
    if (output === undefined) throw new Error('tsup produced no replay entry');
    const replay = spawnSync(process.execPath, [join(outDir, output), ...process.argv.slice(2)], {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env },
    });
    if (replay.error !== undefined) throw replay.error;
    process.exitCode = replay.status ?? 1;
  }
} catch (error) {
  process.stderr.write(
    `session-capture replay launcher: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
