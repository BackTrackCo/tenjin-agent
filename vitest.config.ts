import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Test keystores default to a cheap scrypt cost; production keeps ox's.
    setupFiles: ['./src/lib/wallet/test-kdf-setup.ts'],
    // The default 5s testTimeout stands globally so a genuine hang (MCP/stdio,
    // e2e) surfaces fast. The cheap test scrypt cost keeps the wallet suites
    // inside it; real ox scrypt at N=262144 flaked the default under
    // parallel load (tenjin-agent#47).
    reporters: ['default'],
  },
});
