import process from 'node:process';

export default {
  resolve: { alias: { '@': process.cwd(), '#benchmark/database': '/benchmark-database.mjs' } },
  cacheDir: '/tmp/benchmark-historical-vite-cache',
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
