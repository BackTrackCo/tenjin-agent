#!/usr/bin/env node
// Bin entry. The Node version guard runs BEFORE importing anything else — no
// static imports above it — so an out-of-support runtime gets one JSON error
// envelope plus a human stderr line instead of a syntax/parse crash from a
// lazily-loaded module written in newer syntax. Kept in conservative syntax.
const MIN_NODE_MAJOR = 24;

const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);

if (Number.isNaN(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
  const envelope = {
    schemaVersion: 1,
    command: 'preflight',
    ok: false,
    error: {
      code: 'NODE_UNSUPPORTED',
      message: `Tenjin CLI requires Node ${MIN_NODE_MAJOR} or newer (found ${process.versions.node}).`,
      fix: 'Install Node 24 or newer',
    },
  };
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  process.stderr.write(`error: Node ${MIN_NODE_MAJOR}+ required, found ${process.versions.node}\n`);
  process.exit(1);
}

// THE STATUS LINE NEVER LOADS THE CLI. Claude Code runs it once a second for as
// long as a session is open, and commander, zod and the command tree are parse
// cost it has no use for. Only the bare invocation is diverted; `--help` and
// every flag fall through to the command tree, which registers it like any verb.
if (process.argv.length === 3 && process.argv[2] === 'status-line') {
  const { statusLineMain } = await import('./router/status-line');
  await statusLineMain();
  process.exit(0);
}

const { main } = await import('./cli');
process.exit(await main(process.argv.slice(2)));

// Marks this file a module so top-level await is legal; emits nothing.
export {};
