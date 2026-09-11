import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
for (const [atomic, expected] of [
  ['2000000', '2.00 USDC'],
  ['1', '0.00 USDC'],
  ['123456789', '123.46 USDC'],
]) {
  const run = spawnSync(process.execPath, ['src/cli.mjs', atomic], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), expected);
}
