import path from 'node:path';
import process from 'node:process';

// Copied from tenjin-agent `origin/codex/bench3-task-readiness`
// `evals/benchmark/historical/vitest.config.mjs`, with TWO deliberate changes for
// a local (non-Docker) runner. Everything else is verbatim.
//
// 1. `#benchmark/database` pointed at the absolute `/benchmark-database.mjs`,
//    which is where the harness's container image has it. A local runner cannot
//    stage a file at the filesystem root, and bench-lite refuses to write
//    outside the worktree at all, so the alias now resolves inside the checkout
//    and pairs.json stages `database.mjs` at `.bench3/benchmark-database.mjs`.
// 2. `cacheDir` was the shared `/tmp/benchmark-historical-vite-cache`. Two
//    sessions running at once would share one cache directory; it is now per
//    checkout.
//
// `test.include` is unchanged and still hardcoded to the single hidden-oracle
// file, which is what makes "point --config at this and run" mean "run only the
// oracle".
export default {
  resolve: {
    alias: {
      '@': process.cwd(),
      '#benchmark/database': path.join(process.cwd(), '.bench3/benchmark-database.mjs'),
    },
  },
  cacheDir: path.join(process.cwd(), '.bench3/vite-cache'),
  test: {
    environment: 'node',
    // Match the server's existing Vitest resolution for extensionless next/server.
    server: { deps: { inline: ['@x402/next'] } },
    include: ['src/benchmark-independent.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15000,
  },
};
