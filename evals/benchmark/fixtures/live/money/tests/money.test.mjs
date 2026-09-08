import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { cases } from './support/cases.mjs';

function cli(atomic) {
  const run = spawnSync(process.execPath, ['src/cli.mjs', String(atomic)], { encoding: 'utf8' });
  return { out: run.stdout.trim(), err: run.stderr.trim().split('\n').slice(0, 12).join('\n') };
}

test.each(cases)('cli money case %#', ({ atomic, expected }) => {
  const { out, err } = cli(atomic);
  expect(out, err).toBe(expected);
});
