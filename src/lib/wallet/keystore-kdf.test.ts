import { describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import * as Keystore from 'ox/Keystore';
import { deriveKeystoreKey } from './keystore-kdf';

const salt = new Uint8Array(32).fill(7);
const iv = new Uint8Array(16).fill(3);

async function encrypted(password: string, n = 1024) {
  const privateKey = generatePrivateKey();
  const [key, options] = await Keystore.scryptAsync({ password, n, salt, iv });
  return { privateKey, key, keystore: Keystore.encrypt(privateKey, key, options) };
}

function hex(key: Keystore.Key) {
  return typeof key === 'function' ? key() : key;
}

describe('isolated keystore derivation', () => {
  it.each(['ascii password', 'café 🔒', 'cafe\u0301 🔒', 'nul\0inside'])(
    'preserves Ox password bytes and exact key for %j',
    async (password) => {
      const fixture = await encrypted(password);
      const derived = await deriveKeystoreKey(fixture.keystore, password);
      expect(hex(derived)).toBe(hex(fixture.key));
      expect(Keystore.decrypt(fixture.keystore, derived)).toBe(fixture.privateKey);
    },
  );

  it('does not normalize distinct composed and decomposed passwords', async () => {
    const fixture = await encrypted('café');
    const wrong = await deriveKeystoreKey(fixture.keystore, 'cafe\u0301');
    expect(() => Keystore.decrypt(fixture.keystore, wrong)).toThrow('corrupt keystore');
  });

  it('preserves PBKDF2 derivation and rejects an incorrect passphrase by MAC', async () => {
    const privateKey = generatePrivateKey();
    const [key, options] = Keystore.pbkdf2({
      password: 'fixture password',
      iterations: 1024,
      salt,
      iv,
    });
    const keystore = Keystore.encrypt(privateKey, key, options);
    const correct = await deriveKeystoreKey(keystore, 'fixture password');
    expect(hex(correct)).toBe(hex(key));
    expect(Keystore.decrypt(keystore, correct)).toBe(privateKey);
    const wrong = await deriveKeystoreKey(keystore, 'wrong password');
    expect(() => Keystore.decrypt(keystore, wrong)).toThrow('corrupt keystore');
  });

  it('supports the existing production scrypt parameters while keeping timers responsive', async () => {
    const fixture = await encrypted('production-shape fixture', 262144);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      const derived = await deriveKeystoreKey(fixture.keystore, 'production-shape fixture');
      expect(hex(derived)).toBe(hex(fixture.key));
      expect(Keystore.decrypt(fixture.keystore, derived)).toBe(fixture.privateKey);
      expect(ticks).toBeGreaterThan(1);
    } finally {
      clearInterval(timer);
    }
  }, 120_000);

  it('terminates a timed out computation and can derive again afterwards', async () => {
    const fixture = await encrypted('timeout fixture');
    await expect(
      deriveKeystoreKey(fixture.keystore, 'timeout fixture', { timeoutMs: 1 }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(hex(await deriveKeystoreKey(fixture.keystore, 'timeout fixture'))).toBe(
      hex(fixture.key),
    );
  });

  it('honors already aborted and in-flight cancellation without returning a late key', async () => {
    const fixture = await encrypted('abort fixture');
    const already = AbortSignal.abort();
    await expect(
      deriveKeystoreKey(fixture.keystore, 'abort fixture', { signal: already }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const controller = new AbortController();
    const result = deriveKeystoreKey(fixture.keystore, 'abort fixture', {
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(hex(await deriveKeystoreKey(fixture.keystore, 'abort fixture'))).toBe(hex(fixture.key));
  });

  it.each([0, -1, 120001, Number.NaN, 1.5])(
    'rejects invalid timeout %s before derivation',
    async (timeoutMs) => {
      const fixture = await encrypted('bounded fixture');
      await expect(
        deriveKeystoreKey(fixture.keystore, 'bounded fixture', { timeoutMs }),
      ).rejects.toThrow('timeout must be between');
    },
  );

  it('keeps worker failures bounded without exposing its input', async () => {
    const fixture = await encrypted('do-not-echo-this-password');
    fixture.keystore.crypto.kdfparams.salt = 'not-hex';
    const error = await deriveKeystoreKey(fixture.keystore, 'do-not-echo-this-password').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Keystore derivation failed.');
  });
});
