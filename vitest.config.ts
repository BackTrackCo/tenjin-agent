import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The default 5s testTimeout stands globally so a genuine hang (MCP/stdio,
    // e2e) surfaces fast. The scrypt-heavy wallet suites raise it per-file via
    // vi.setConfig — real ox scrypt at N=262144 flakes the default under
    // parallel load (tenjin-agent#47).
  },
});
