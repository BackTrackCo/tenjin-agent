import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePassphraseRecord } from './passphrase-record';
import { passphraseFilePathFor, walletPath } from './paths';
import { readWalletFacts, unlockStamp } from './wallet-facts';
import { PRIVATE_KEY_RE } from './wallet-unlock';

const ADDRESS = '0x' + 'Ab'.repeat(20);
const KEY = '0x' + '1f'.repeat(32);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-wf-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeWallet(address: string = ADDRESS): Promise<void> {
  await writeFile(walletPath(dir), JSON.stringify({ schemaVersion: 2, address, keystore: {} }));
}

describe('readWalletFacts', () => {
  it('reports no wallet file', async () => {
    expect(await readWalletFacts(dir, {})).toEqual({
      envKey: 'absent',
      walletFile: 'absent',
      address: null,
      envPassphraseSet: false,
      passphraseStore: null,
      passphraseFileMissing: false,
      walletMtimeMs: null,
      sidecarMtimeMs: null,
    });
  });

  it('reads a valid wallet file and its sidecar entry', async () => {
    await writeWallet();
    await writePassphraseRecord(dir, ADDRESS, { store: 'keychain', by: 'create' });
    const facts = await readWalletFacts(dir, { TENJIN_WALLET_PASSPHRASE: 'pw' });
    expect(facts).toMatchObject({
      walletFile: 'present',
      address: ADDRESS,
      envPassphraseSet: true,
      passphraseStore: 'keychain',
      passphraseFileMissing: false,
    });
    expect(typeof facts.walletMtimeMs).toBe('number');
    expect(typeof facts.sidecarMtimeMs).toBe('number');
  });

  it.each<[string, string]>([
    ['bad JSON', '{oops'],
    ['no address', JSON.stringify({ schemaVersion: 2 })],
    ['an invalid address', JSON.stringify({ address: '0x123' })],
    ['JSON null', 'null'],
  ])('calls %s unparsable', async (_label, text) => {
    await writeFile(walletPath(dir), text);
    expect(await readWalletFacts(dir, {})).toMatchObject({
      walletFile: 'unparsable',
      address: null,
    });
  });

  it('counts an empty TENJIN_WALLET_PASSPHRASE as unset', async () => {
    expect((await readWalletFacts(dir, { TENJIN_WALLET_PASSPHRASE: '' })).envPassphraseSet).toBe(
      false,
    );
  });

  it.each<[string, string, 'absent' | 'valid' | 'malformed']>([
    ['a valid key', KEY, 'valid'],
    ['a valid key with whitespace', `  ${KEY}\n`, 'valid'],
    ['a malformed key', '0x1234', 'malformed'],
    ['a whitespace-only key', '   ', 'absent'],
  ])('envKey: %s', async (_label, value, expected) => {
    expect((await readWalletFacts(dir, { TENJIN_WALLET_KEY: value })).envKey).toBe(expected);
  });

  it('calls an upper-case 0X key valid exactly when PRIVATE_KEY_RE does (S12)', async () => {
    const upper = '0X' + '1F'.repeat(32);
    const expected = PRIVATE_KEY_RE.test(upper) ? 'valid' : 'malformed';
    expect((await readWalletFacts(dir, { TENJIN_WALLET_KEY: upper })).envKey).toBe(expected);
    const mixedHex = '0x' + '1F'.repeat(32);
    expect((await readWalletFacts(dir, { TENJIN_WALLET_KEY: mixedHex })).envKey).toBe('valid');
  });

  it("flags a sidecar 'file' entry whose .plain file is missing", async () => {
    await writeWallet();
    await writePassphraseRecord(dir, ADDRESS, { store: 'file', by: 'create' });
    const missing = await readWalletFacts(dir, {});
    expect(missing).toMatchObject({ passphraseStore: 'file', passphraseFileMissing: true });

    await writeFile(passphraseFilePathFor(ADDRESS.toLowerCase(), dir), 'secret', { mode: 0o600 });
    expect((await readWalletFacts(dir, {})).passphraseFileMissing).toBe(false);
  });

  it('never flags a missing file for an OS store', async () => {
    await writeWallet();
    await writePassphraseRecord(dir, ADDRESS, { store: 'secret-service', by: 'create' });
    expect((await readWalletFacts(dir, {})).passphraseFileMissing).toBe(false);
  });
});

describe('unlockStamp', () => {
  it('is the two mtimes', () => {
    expect(unlockStamp({ walletMtimeMs: 1, sidecarMtimeMs: null })).toBe('1:null');
  });

  it('changes when the wallet mtime changes', async () => {
    await writeWallet();
    await utimes(walletPath(dir), new Date(1_000_000), new Date(1_000_000));
    const before = unlockStamp(await readWalletFacts(dir, {}));
    await utimes(walletPath(dir), new Date(2_000_000), new Date(2_000_000));
    const after = unlockStamp(await readWalletFacts(dir, {}));
    expect(after).not.toBe(before);
  });
});
