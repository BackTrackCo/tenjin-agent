#!/usr/bin/env node
for (let i = 1; i <= 60; i++) {
  console.error(`unrelated integration shard ${i}: fixture database unavailable at worker ${i}`);
}
console.error('The package script ignored the requested file and entered every workspace project.');
process.exit(1);
