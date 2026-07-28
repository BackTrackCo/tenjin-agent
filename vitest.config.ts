import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The wallet suites run real ox scrypt (N=262144) several times per test;
    // the 5s default flakes under load (a saturated dev box stretches one
    // scrypt past 30s). One generous global timeout instead of per-test
    // overrides scattered through the suites.
    testTimeout: 120000,
  },
});
