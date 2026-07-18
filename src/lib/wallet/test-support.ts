import { randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import * as Keystore from 'ox/Keystore';
import type { WalletRecord } from './store';

/** Shared test-only fixtures for encrypted (keystore v3) wallet records. Never bundled into dist. */

export const KNOWN_PASSPHRASE = 'correct horse battery staple';

/**
 * A structurally-valid Keystore v3 with placeholder ciphertext. Fast (no scrypt)
 * and enough for read/describe/show paths that never decrypt. A unique `id`
 * keeps the provider's decrypt cache from ever colliding across tests.
 */
export function fakeKeystore(id: string = randomUUID()): Keystore.Keystore {
  return {
    crypto: {
      cipher: 'aes-128-ctr',
      ciphertext: 'ab'.repeat(32),
      cipherparams: { iv: 'cd'.repeat(16) },
      kdf: 'scrypt',
      kdfparams: { dklen: 32, n: 262144, p: 8, r: 1, salt: 'ef'.repeat(32) },
      mac: '00'.repeat(32),
    },
    id,
    version: 3,
  };
}

/** A v2 record with a fast fake keystore and a real, coherent top-level address. */
export function fakeRecord(overrides: Partial<WalletRecord> = {}): WalletRecord {
  return {
    schemaVersion: 2,
    provider: 'local',
    address: privateKeyToAccount(generatePrivateKey()).address,
    keystore: fakeKeystore(),
    createdAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * A v2 record with a REAL keystore encrypting `key` under `passphrase` — for the
 * decryption paths (roundtrip, wrong passphrase, tamper). `address` defaults to
 * the key's own address but can be overridden to fabricate a tamper fixture.
 */
export async function encryptedRecord(
  key: Hex,
  passphrase: string = KNOWN_PASSPHRASE,
  address?: Address,
): Promise<WalletRecord> {
  const [derivedKey, opts] = await Keystore.scryptAsync({ password: passphrase });
  const keystore = Keystore.encrypt(key, derivedKey, opts);
  return {
    schemaVersion: 2,
    provider: 'local',
    address: address ?? privateKeyToAccount(key).address,
    keystore,
    createdAt: '2026-07-17T00:00:00.000Z',
  };
}
