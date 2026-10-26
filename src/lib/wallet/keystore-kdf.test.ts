import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
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
  it.each([
    '',
    'ascii password',
    'café 🔒',
    'cafe\u0301 🔒',
    'nul\0inside',
    'unpaired \ud800',
    'long password '.repeat(16),
  ])('preserves Ox password bytes and exact key for %j', async (password) => {
    const fixture = await encrypted(password);
    const derived = await deriveKeystoreKey(fixture.keystore, password);
    expect(hex(derived)).toBe(hex(fixture.key));
    expect(Keystore.decrypt(fixture.keystore, derived)).toBe(fixture.privateKey);
  });

  it('does not normalize distinct composed and decomposed passwords', async () => {
    const fixture = await encrypted('café');
    const wrong = await deriveKeystoreKey(fixture.keystore, 'cafe\u0301');
    expect(() => Keystore.decrypt(fixture.keystore, wrong)).toThrow('corrupt keystore');
  });

  it('retains Ox unlocking when the runtime disables WebAssembly', async () => {
    const fixture = await encrypted('fallback fixture');
    const url = new URL('./keystore-kdf-worker.ts', import.meta.url);
    // Node's source-only TS stripper also uses WASM; initialize it first.
    const worker = new Worker(
      `require('node:module').stripTypeScriptTypes('const ready: boolean = true;');
       globalThis.WebAssembly = undefined; void import(${JSON.stringify(url.href)});`,
      { eval: true, workerData: { keystore: fixture.keystore, password: 'fallback fixture' } },
    );
    try {
      const message = await new Promise<{ key?: string }>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      expect(message.key).toBe(hex(fixture.key));
    } finally {
      await worker.terminate();
    }
  });

  it('still rejects a wrong scrypt passphrase and modified contents by MAC', async () => {
    const fixture = await encrypted('scrypt MAC fixture');
    const wrong = await deriveKeystoreKey(fixture.keystore, 'wrong password');
    expect(() => Keystore.decrypt(fixture.keystore, wrong)).toThrow('corrupt keystore');
    fixture.keystore.crypto.mac = '00'.repeat(32);
    const correct = await deriveKeystoreKey(fixture.keystore, 'scrypt MAC fixture');
    expect(() => Keystore.decrypt(fixture.keystore, correct)).toThrow('corrupt keystore');
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

      const controller = new AbortController();
      const cancelled = expect(
        deriveKeystoreKey(fixture.keystore, 'production-shape fixture', {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await cancelled;
    } finally {
      clearInterval(timer);
    }
  }, 120_000);

  it('retains a larger scrypt work factor through Ox', async () => {
    const fixture = await encrypted('higher-cost fixture', 524288);
    const derived = await deriveKeystoreKey(fixture.keystore, 'higher-cost fixture');
    expect(hex(derived)).toBe(hex(fixture.key));
    expect(Keystore.decrypt(fixture.keystore, derived)).toBe(fixture.privateKey);
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

  it.each(['salt', 'iv'] as const)(
    'rejects a malformed %s without exposing its input',
    async (field) => {
      const fixture = await encrypted('do-not-echo-this-password');
      if (field === 'salt') fixture.keystore.crypto.kdfparams.salt = 'not-hex';
      else fixture.keystore.crypto.cipherparams.iv = 'not-hex';
      const error = await deriveKeystoreKey(fixture.keystore, 'do-not-echo-this-password').catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Keystore derivation failed.');
    },
  );

  it.each([0, 1, 3, 2.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity])(
    'rejects invalid scrypt cost %s without allocating its workspace',
    async (n) => {
      const fixture = await encrypted('invalid cost');
      if (fixture.keystore.crypto.kdf === 'scrypt' && 'n' in fixture.keystore.crypto.kdfparams)
        fixture.keystore.crypto.kdfparams.n = n;
      await expect(deriveKeystoreKey(fixture.keystore, 'invalid cost')).rejects.toThrow(
        'Keystore derivation failed.',
      );
    },
  );
});
