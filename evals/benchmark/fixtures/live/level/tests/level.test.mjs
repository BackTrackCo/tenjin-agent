import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { cases } from './support/cases.mjs';

function cli(score) {
  const run = spawnSync(process.execPath, ['src/cli.ts', String(score)], { encoding: 'utf8' });
  return { out: run.stdout.trim(), err: run.stderr.trim().split('\n').slice(0, 12).join('\n') };
}

test.each(cases)('cli level case %#', ({ score, expected }) => {
  const { out, err } = cli(score);
  expect(out, err).toBe(expected);
});
