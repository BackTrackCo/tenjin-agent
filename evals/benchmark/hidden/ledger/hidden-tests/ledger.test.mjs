import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
// Amounts the run never prints, against the rates that ship with the fixture,
// and called the way the scheduler calls it: by full path, from a directory
// that is not the project. A CLI that answers from the three amounts the run
// prints, or that only works when it is started from the project, is red here.
const CLI = fileURLToPath(new URL('../src/ledger.mjs', import.meta.url));
for (const [code, amount, expected] of [
  ['EURC', '250', '272.50 USD'],
  ['GBPC', '3', '3.81 USD'],
  ['USDC', '0.5', '0.50 USD'],
]) {
  const run = spawnSync(process.execPath, [CLI, code, amount], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), expected);
}
