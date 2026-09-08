import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.money ?? [];

function cli(atomic) {
  const run = spawnSync(process.execPath, ['src/cli.mjs', String(atomic)], { encoding: 'utf8' });
  return { out: run.stdout.trim(), err: run.stderr.trim().split('\n').slice(0, 12).join('\n') };
}

test.each(cases)('cli money case %#', ({ atomic, expected }) => {
  const { out, err } = cli(atomic);
  expect(out, err).toBe(expected);
});
