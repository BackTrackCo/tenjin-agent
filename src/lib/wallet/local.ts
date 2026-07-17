import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { CliError } from '../errors';
import { walletPath } from '../paths';
import {
  PRIVATE_KEY_RE,
  readWalletRecord,
  walletFileMode,
  writeWalletRecord,
  type WalletRecord,
} from './store';
import type {
  TenjinSigner,
  WalletDescription,
  WalletDiagnostics,
  WalletProvider,
} from './provider';

export interface LocalProviderDeps {
  dir: string;
  env: NodeJS.ProcessEnv;
}

const isWindows = process.platform === 'win32';

/**
 * The only real B1 provider: a local viem account whose key comes from the env
 * override or the wallet file. Together with the lifecycle helpers below, this is
 * the ONLY module that knows raw keys exist — `describe()` returns just the
 * address and posture, so `show`/`balance` stay keyless; `getSigner()` is the
 * single door to the key material.
 */
export function createLocalProvider(deps: LocalProviderDeps): WalletProvider {
  return {
    id: 'local',
    async describe(): Promise<WalletDescription> {
      const cred = resolveCredentialOrThrow(await loadCredential(deps));
      return {
        // A stored address is only a claim; accountForCredential derives from the
        // key and rejects a record whose address does not match, so show/balance
        // can never display an address the key would not sign as.
        address: accountForCredential(cred).address,
        provider: 'local',
        credentialSource: cred.source,
        policyEnforcement: 'client-only',
      };
    },
    async getSigner(): Promise<TenjinSigner> {
      const cred = resolveCredentialOrThrow(await loadCredential(deps));
      const account = accountForCredential(cred);
      return {
        address: account.address,
        signMessage: (args) => account.signMessage({ message: args.message }),
        signTypedData: (args) => account.signTypedData(args),
      };
    },
    diagnostics(): Promise<WalletDiagnostics> {
      return localWalletDiagnostics(deps);
    },
  };
}

/**
 * File-custody warnings for the local provider: an env key shadowing the file,
 * non-0600 perms, and the Windows "perms not checkable" note. Keyless. walletPath
 * is reported only when the file actually exists, so a pure-env caller advertises
 * no on-disk path. This is the ONLY place these local-only signals live — `show`
 * and `doctor` render what the active provider returns, never their own fs probe.
 */
export async function localWalletDiagnostics(deps: LocalProviderDeps): Promise<WalletDiagnostics> {
  const mode = await walletFileMode(deps.dir);
  const fileExists = mode !== null;
  const envKey = deps.env.TENJIN_WALLET_KEY;
  const envSet = envKey !== undefined && envKey.length > 0;
  const path = walletPath(deps.dir);

  const warnings: string[] = [];
  if (envSet && fileExists) {
    warnings.push('TENJIN_WALLET_KEY is set and shadows the wallet file at runtime.');
  }
  if (mode !== null) {
    if (isWindows) {
      warnings.push('File permission checks are not available on Windows.');
    } else if (mode !== 0o600) {
      warnings.push(
        `Wallet file permissions are ${mode.toString(8)}, expected 600. Run \`chmod 600 ${path}\`.`,
      );
    }
  }
  return { ...(fileExists ? { walletPath: path } : {}), warnings };
}

export interface LocalWalletInfo {
  address: Address;
  walletPath: string;
}

/**
 * Generate a fresh key and persist it NO-CLOBBER, returning the address and path.
 * The write, not a caller's pre-check, is the authority: a lost create race throws
 * WALLET_EXISTS rather than overwriting a funded key.
 */
export async function createLocalWallet(dir: string): Promise<LocalWalletInfo> {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  await writeWalletRecord(dir, walletRecord(address, key));
  return { address, walletPath: walletPath(dir) };
}

type Credential = { source: 'env'; key: Hex } | { source: 'file'; key: Hex; address: Address };

/** Env override beats the wallet file (CI + ephemeral agents); null when neither exists. */
async function loadCredential(deps: LocalProviderDeps): Promise<Credential | null> {
  const envKey = deps.env.TENJIN_WALLET_KEY;
  if (envKey !== undefined && envKey.trim().length > 0) {
    const key = envKey.trim();
    if (!PRIVATE_KEY_RE.test(key)) {
      throw new CliError('WALLET_INVALID_KEY', 'TENJIN_WALLET_KEY is not a valid private key.', {
        fix: 'Set TENJIN_WALLET_KEY to a 0x-prefixed 32-byte hex key, or unset it to use the wallet file.',
      });
    }
    return { source: 'env', key: key as Hex };
  }
  const record = await readWalletRecord(deps.dir);
  if (record !== null) {
    return { source: 'file', key: record.privateKey as Hex, address: record.address as Address };
  }
  return null;
}

/**
 * Build the viem account from a credential, mapping viem's throw on an invalid
 * key to WALLET_INVALID_KEY. For a FILE credential, also require the stored
 * address to match what the key derives (EIP-55 normalized): a stale or tampered
 * record that would show address A but sign as B is rejected, not trusted.
 */
function accountForCredential(cred: Credential): PrivateKeyAccount {
  let account: PrivateKeyAccount;
  try {
    account = privateKeyToAccount(cred.key);
  } catch (err) {
    throw new CliError('WALLET_INVALID_KEY', 'The private key is not a valid secp256k1 key.', {
      fix:
        cred.source === 'file'
          ? 'Move the wallet file aside, then run `tenjin wallet create` for a fresh key or set TENJIN_WALLET_KEY to use the intended one.'
          : 'Set TENJIN_WALLET_KEY to a valid 0x-prefixed 32-byte hex key.',
      cause: err,
    });
  }
  if (cred.source === 'file' && account.address.toLowerCase() !== cred.address.toLowerCase()) {
    throw new CliError(
      'WALLET_INVALID_KEY',
      `The wallet file's stored address ${cred.address} does not match its private key (derives ${account.address}).`,
      {
        fix: 'Move the wallet file aside, then run `tenjin wallet create` for a fresh key or set TENJIN_WALLET_KEY to use the intended one.',
      },
    );
  }
  return account;
}

function resolveCredentialOrThrow(cred: Credential | null): Credential {
  if (cred === null) {
    throw new CliError('WALLET_MISSING', 'No wallet found.', {
      fix: 'Run `tenjin wallet create` to create one.',
    });
  }
  return cred;
}

function walletRecord(address: Address, privateKey: Hex): WalletRecord {
  return {
    schemaVersion: 1,
    provider: 'local',
    address,
    privateKey,
    createdAt: new Date().toISOString(),
  };
}
