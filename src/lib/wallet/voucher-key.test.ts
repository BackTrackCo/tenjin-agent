import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadVoucherKey, type VoucherKeyDeps } from './voucher-key';

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'voucher-key-'));
  path = join(dir, 'router', 'lanes', 'voucher-key.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const WALLET = '0x1234567890AbcdEF1234567890aBcdef12345678';
const deps = (passphrase = 'correct horse'): VoucherKeyDeps => ({
  walletAddress: WALLET,
  // The env slot, so no test reaches the developer's OS credential store.
  passphrase: { env: { TENJIN_WALLET_PASSPHRASE: passphrase }, dir, isTTY: false },
});

// Each case runs the wallet's real scrypt, which takes seconds under a busy run.
describe('loadVoucherKey', { timeout: 30_000 }, () => {
  it('makes one key, keeps it encrypted at rest, and reads the same key back', async () => {
    const key = await loadVoucherKey(path, deps());
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain(key.slice(2));
    const record = JSON.parse(raw) as { version: number; address: string; keystore: unknown };
    expect(record.version).toBe(2);
    expect(record.address).toBe(privateKeyToAccount(key).address);
    expect(record.keystore).toBeTypeOf('object');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadVoucherKey(path, deps())).toBe(key);
  });

  it('refuses a wrong passphrase rather than making a new key', async () => {
    await loadVoucherKey(path, deps());
    await expect(loadVoucherKey(path, deps('wrong'))).rejects.toThrow();
  });

  it('seals a plaintext key from an earlier build on its first read, keeping the key', async () => {
    const legacy = generatePrivateKey();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'router', 'lanes'), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, privateKey: legacy }));
    expect(await loadVoucherKey(path, deps())).toBe(legacy);
    expect(await readFile(path, 'utf8')).not.toContain(legacy.slice(2));
    expect(await loadVoucherKey(path, deps())).toBe(legacy);
  });

  it('leaves a file it cannot read alone', async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'router', 'lanes'), { recursive: true });
    await writeFile(path, 'not json');
    await expect(loadVoucherKey(path, deps())).rejects.toThrow('left as it is');
    expect(await readFile(path, 'utf8')).toBe('not json');
  });
});
