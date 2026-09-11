import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// The cases arrive through the runner's setup file; a run is the only way to learn them.
const cases = globalThis.__bench1Cases?.ledger ?? [];
const CLI = fileURLToPath(new URL('../src/ledger.mjs', import.meta.url));

function cli(code, amount) {
  const run = spawnSync(process.execPath, [CLI, code, String(amount)], {
    encoding: 'utf8',
    cwd: tmpdir(),
  });
  return { out: run.stdout.trim(), err: run.stderr.trim().split('\n').slice(0, 12).join('\n') };
}

test.each(cases)('cli ledger case %#', ({ args, expected }) => {
  const { out, err } = cli(...args);
  expect(out, err).toBe(expected);
});
