export default {
  cacheDir: '/tmp/bench3-vite-cache',
  test: {
    environment: 'node',
    include: ['src/bench3-independent.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15000,
  },
};
