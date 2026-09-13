import process from 'node:process';

export default {
  resolve: { alias: { '@': process.cwd(), '#benchmark/database': '/benchmark-database.mjs' } },
  cacheDir: '/tmp/benchmark-historical-vite-cache',
  test: {
    environment: 'node',
    include: ['src/benchmark-independent.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15000,
  },
};
