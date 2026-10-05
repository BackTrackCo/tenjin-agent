import { readFile } from 'node:fs/promises';
import * as Keystore from 'ox/Keystore';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { writeFileAtomic, writeFileAtomicExclusive } from '../atomic-json';
import { hasCode } from '../errno';
import { deriveKeystoreKey, type KeystoreDerivationOptions } from './keystore-kdf';
import { encryptToKeystore } from './local';
import { resolvePassphrase, type PassphraseDeps } from './passphrase';
import { PRIVATE_KEY_RE } from './store';

/**
 * THE ROUTING FEE'S VOUCHER KEY, AT REST THE WAY THE WALLET KEY IS: a keystore
 * v3 (scrypt) sealed with the wallet's own passphrase, resolved the same way
 * the wallet resolves it (env, then the OS credential store, never a prompt
 * here). The key signs routing-fee vouchers and nothing else, and every lane
 * names its address as the `payerAuthorizer`, so it is made once and kept: a
 * new key would mean new channels.
 *
 * A key an earlier build left in plaintext is sealed on its first read.
 */

export interface VoucherKeyDeps {
  /** The wallet whose passphrase seals the key. */
  walletAddress: string;
  passphrase: PassphraseDeps;
  derivation?: KeystoreDerivationOptions;
}

interface SealedRecord {
  version: 2;
  address: string;
  keystore: Keystore.Keystore;
}

export async function loadVoucherKey(path: string, deps: VoucherKeyDeps): Promise<Hex> {
  const stored = await readRecord(path);
  if (stored !== null && 'keystore' in stored) {
    const { passphrase } = await resolvePassphrase(deps.passphrase, deps.walletAddress);
    const derived = await deriveKeystoreKey(stored.keystore, passphrase, deps.derivation);
    const key = Keystore.decrypt(stored.keystore, derived);
    if (privateKeyToAccount(key).address.toLowerCase() !== stored.address.toLowerCase()) {
      throw new Error(`the voucher key in ${path} does not derive its stored address`);
    }
    return key;
  }
  if (stored !== null) {
    // Plaintext from an earlier build: seal it in place, keeping the same key.
    await writeFileAtomic(path, await sealed(stored.privateKey, deps), {
      mode: 0o600,
      dirMode: 0o700,
    });
    return stored.privateKey;
  }
  const fresh = generatePrivateKey();
  try {
    await writeFileAtomicExclusive(path, await sealed(fresh, deps), {
      mode: 0o600,
      dirMode: 0o700,
    });
    return fresh;
  } catch (err) {
    // Another process made it first: theirs is every lane's authorizer.
    if (hasCode(err, 'EEXIST')) return loadVoucherKey(path, deps);
    throw err;
  }
}

async function sealed(key: Hex, deps: VoucherKeyDeps): Promise<string> {
  const { passphrase } = await resolvePassphrase(deps.passphrase, deps.walletAddress);
  const record: SealedRecord = {
    version: 2,
    address: privateKeyToAccount(key).address,
    keystore: await encryptToKeystore(key, passphrase),
  };
  return `${JSON.stringify(record)}\n`;
}

/** The record at `path`, or null when there is no file. Anything else there is
 *  refused rather than replaced: it may be the only copy of a lane's key. */
async function readRecord(path: string): Promise<SealedRecord | { privateKey: Hex } | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return null;
    throw err;
  }
  const value = parseJson(raw);
  if (
    typeof value?.keystore === 'object' &&
    value.keystore !== null &&
    typeof value.address === 'string'
  ) {
    return value as unknown as SealedRecord;
  }
  if (typeof value?.privateKey === 'string' && PRIVATE_KEY_RE.test(value.privateKey)) {
    return { privateKey: value.privateKey as Hex };
  }
  throw new Error(`${path} is not a voucher key this build can read; it was left as it is`);
}

function parseJson(
  raw: string,
): { keystore?: unknown; address?: unknown; privateKey?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
