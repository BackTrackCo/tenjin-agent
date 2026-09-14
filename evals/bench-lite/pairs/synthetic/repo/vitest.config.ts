import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    environment: 'node',
    // One worker. This service is a single in-memory store, and the laptops
    // this runs on do not enjoy thirty forks.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    clearMocks: true,
    restoreMocks: true,
  },
});
