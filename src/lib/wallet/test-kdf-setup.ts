import { vi } from 'vitest';

/**
 * Vitest setup (vitest.config.ts `setupFiles`): every keystore a test writes
 * defaults to a cheap scrypt cost. Production wallets keep ox's default
 * N=262144, a second or more per derivation, which made the wallet suites the
 * critical path of every CI run. Decryption reads N from the keystore document,
 * so a cheap keystore also decrypts cheaply, in the KDF worker too. An explicit
 * `n` passes through: keystore-kdf.test.ts unmocks this to pin the production
 * cost a new wallet is written with.
 */
vi.mock('ox/Keystore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ox/Keystore')>();
  return {
    ...actual,
    scryptAsync: (options: Parameters<typeof actual.scryptAsync>[0]) =>
      actual.scryptAsync({ ...options, n: options.n ?? 2 ** 10 }),
  };
});
