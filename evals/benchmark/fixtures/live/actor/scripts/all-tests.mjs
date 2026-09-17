#!/usr/bin/env node
// The package test script runs every project in the tree. File arguments are
// not forwarded, so `pnpm test -- <file>` still enters the unrelated shards.
import { spawnSync } from 'node:child_process';
console.error('all-tests: running every project; file arguments are not forwarded');
const child = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run'], {
  stdio: 'inherit',
});
process.exit(child.status ?? 2);
