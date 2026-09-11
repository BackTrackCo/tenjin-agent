import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.level ?? [];

function cli(score) {
  const run = spawnSync(process.execPath, ['src/cli.ts', String(score)], { encoding: 'utf8' });
  return { out: run.stdout.trim(), err: run.stderr.trim().split('\n').slice(0, 12).join('\n') };
}

test.each(cases)('cli level case %#', ({ score, expected }) => {
  const { out, err } = cli(score);
  expect(out, err).toBe(expected);
});
