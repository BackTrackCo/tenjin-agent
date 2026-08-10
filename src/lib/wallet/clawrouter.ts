import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { CliError } from '../errors';
import { hasCode } from '../errno';
import { PRIVATE_KEY_RE, type ClawRouterWalletRecord } from './store';
import type {
  CredentialSource,
  TenjinSigner,
  WalletDescription,
  WalletDiagnostics,
  WalletProvider,
} from './provider';

export const CLAWROUTER_WALLET_ENV = 'BLOCKRUN_WALLET_KEY';

/**
 * Machine-readable custody facts shared by wallet connect and every stacked
 * installer. Keep this factual and provider-specific so higher layers surface
 * one contract instead of maintaining security prose that can drift.
 */
export const CLAWROUTER_CUSTODY = {
  sourceOwnedBy: 'clawrouter-user',
  sourceMutationByTenjin: 'none',
  sourceDeletedByTenjin: false,
  connectMovesFunds: false,
  privateKeyAccess: 'read-into-process-memory-at-connect-and-sign',
  privateKeyCopiedToTenjinStorage: false,
  privateKeyPersistedByTenjin: false,
  privateKeyLogged: false,
  privateKeyReturned: false,
  privateKeyTransmitted: false,
  mnemonicAccessed: false,
  rawTransactionSigning: false,
  pinnedAddressDriftRefusal: true,
  humanAcknowledgement: 'not-proven',
  sameUserUnrestrictedAgentContained: false,
  enforcementBoundary: 'outside-tenjin-process',
} as const;

export type ClawRouterCustodyFacts = typeof CLAWROUTER_CUSTODY;

export function defaultClawRouterWalletPath(): string {
  return join(homedir(), '.openclaw', 'blockrun', 'wallet.key');
}

export interface ClawRouterProviderDeps {
  /**
   * Deliberately read-only capabilities. The connector has no injected or
   * imported rename/unlink/write/chmod primitive, so neither connect nor sign
   * can mutate the ClawRouter-owned source as an incidental code path.
   */
  env?: NodeJS.ProcessEnv;
  walletKeyPath?: string;
  readFileImpl?: typeof readFile;
  statImpl?: typeof stat;
}

interface ClawRouterCredential {
  address: Address;
  key: Hex;
  source: CredentialSource;
}

/**
 * Resolve ClawRouter's canonical EVM payment key without ever reading its
 * mnemonic. The upstream TypeScript router's precedence is preserved exactly:
 * wallet.key first, BLOCKRUN_WALLET_KEY only when that file is absent.
 * Checked against BlockRunAI/ClawRouter auth.ts at
 * ba855b90103cde00b5d39023220e2f5aeab94b75.
 */
async function resolveCredential(deps: ClawRouterProviderDeps): Promise<ClawRouterCredential> {
  const path = deps.walletKeyPath ?? defaultClawRouterWalletPath();
  const read = deps.readFileImpl ?? readFile;
  const env = deps.env ?? process.env;
  let raw: string | undefined;
  try {
    raw = (await read(path, 'utf8')).trim();
  } catch (err) {
    if (!hasCode(err, 'ENOENT')) {
      throw new CliError('WALLET_INVALID_KEY', `Could not read ClawRouter's wallet at ${path}.`, {
        fix: `Fix access to ${path}; Tenjin will not fall through to ${CLAWROUTER_WALLET_ENV} while the canonical file exists but is unreadable.`,
        cause: err,
      });
    }
  }

  const source: CredentialSource = raw !== undefined ? 'file' : 'env';
  const candidate = raw ?? env[CLAWROUTER_WALLET_ENV];
  if (candidate === undefined || candidate.trim().length === 0) {
    throw new CliError('WALLET_MISSING', 'No ClawRouter EVM wallet was found.', {
      fix: `Run \`npx @blockrun/clawrouter setup\` to create ${path}, or set ${CLAWROUTER_WALLET_ENV}. Tenjin never reads the mnemonic.`,
    });
  }
  const key = candidate.trim();
  if (!PRIVATE_KEY_RE.test(key)) {
    throw new CliError(
      'WALLET_INVALID_KEY',
      source === 'file'
        ? `ClawRouter's wallet file at ${path} is not a 0x-prefixed 32-byte EVM key.`
        : `${CLAWROUTER_WALLET_ENV} is not a 0x-prefixed 32-byte EVM key.`,
      {
        fix:
          source === 'file'
            ? `Restore ClawRouter's ${path}; Tenjin refuses to derive from or expose the mnemonic.`
            : `Set ${CLAWROUTER_WALLET_ENV} to the EVM key ClawRouter uses.`,
      },
    );
  }

  try {
    const normalized = key as Hex;
    return { key: normalized, address: privateKeyToAccount(normalized).address, source };
  } catch (err) {
    throw new CliError(
      'WALLET_INVALID_KEY',
      'The ClawRouter EVM key is not valid secp256k1 key material.',
      {
        fix: 'Restore the ClawRouter wallet key and retry.',
        cause: err,
      },
    );
  }
}

/** Read and validate the current ClawRouter signer for an explicit connect. */
export async function discoverClawRouterWallet(
  deps: ClawRouterProviderDeps = {},
): Promise<{ address: Address; credentialSource: CredentialSource }> {
  const credential = await resolveCredential(deps);
  return { address: credential.address, credentialSource: credential.source };
}

/**
 * A local-signing connector to ClawRouter's signer material. The private key
 * necessarily enters this process to produce the message and typed-data
 * signatures Tenjin needs for SIWX, writes, and x402. Tenjin does not copy,
 * persist, log, return, or transmit it and deliberately refuses raw
 * transactions (`tenjin send`). These are application behavior guarantees, not
 * containment from an unrestricted agent running as the same OS user.
 */
export function createClawRouterProvider(
  record: ClawRouterWalletRecord,
  deps: ClawRouterProviderDeps = {},
): WalletProvider {
  const path = deps.walletKeyPath ?? defaultClawRouterWalletPath();
  const env = deps.env ?? process.env;
  return {
    id: 'clawrouter',
    async describe(): Promise<WalletDescription> {
      const source = await currentSource(path, env, deps.statImpl ?? stat);
      return {
        address: record.address as Address,
        provider: 'clawrouter',
        credentialSource: source,
        policyEnforcement: 'client-only',
      };
    },
    async getSigner(): Promise<TenjinSigner> {
      const credential = await resolveCredential({ ...deps, env, walletKeyPath: path });
      if (credential.address.toLowerCase() !== record.address.toLowerCase()) {
        throw new CliError(
          'REFUSED',
          `ClawRouter's current signer ${credential.address} does not match the address Tenjin connected (${record.address}).`,
          {
            fix:
              'Refusing signer drift. Review the ClawRouter wallet change, then run ' +
              '`tenjin wallet connect clawrouter --replace` to pin the new address explicitly.',
          },
        );
      }
      const account = privateKeyToAccount(credential.key);
      return {
        address: account.address,
        signMessage: (args) => account.signMessage({ message: args.message }),
        signTypedData: (args) => account.signTypedData(args),
        signTransaction: async () => {
          throw new CliError(
            'REFUSED',
            'The ClawRouter wallet connector refuses raw transaction signing.',
            {
              fix:
                '`tenjin send` is unavailable for this provider. Use ClawRouter wallet tooling, ' +
                'or intentionally switch to a Tenjin local wallet for funds-out operations.',
            },
          );
        },
      };
    },
    async diagnostics(): Promise<WalletDiagnostics> {
      const statFn = deps.statImpl ?? stat;
      let mode: number | undefined;
      try {
        mode = (await statFn(path)).mode & 0o777;
      } catch (err) {
        if (!hasCode(err, 'ENOENT')) {
          return { warnings: [`Could not inspect ClawRouter wallet permissions at ${path}.`] };
        }
      }
      const warnings: string[] = [];
      if (mode !== undefined && mode !== 0o600 && process.platform !== 'win32') {
        warnings.push(
          `ClawRouter wallet permissions are ${mode.toString(8)}, expected 600. Run \`chmod 600 ${path}\`.`,
        );
      }
      if (mode !== undefined && env[CLAWROUTER_WALLET_ENV]?.trim()) {
        warnings.push(
          `${CLAWROUTER_WALLET_ENV} is set, but ClawRouter's wallet.key takes precedence.`,
        );
      }
      return {
        ...(mode !== undefined
          ? { walletPath: path, keyStorage: 'ClawRouter-managed plaintext key (mode 0600)' }
          : {}),
        warnings,
      };
    },
  };
}

async function currentSource(
  path: string,
  env: NodeJS.ProcessEnv,
  statFn: typeof stat,
): Promise<CredentialSource> {
  try {
    await statFn(path);
    return 'file';
  } catch (err) {
    if (!hasCode(err, 'ENOENT')) {
      throw new CliError(
        'WALLET_INVALID_KEY',
        `Could not inspect ClawRouter's wallet at ${path}.`,
        {
          fix: `Fix access to ${path} and retry.`,
          cause: err,
        },
      );
    }
  }
  if (env[CLAWROUTER_WALLET_ENV]?.trim()) return 'env';
  throw new CliError(
    'WALLET_MISSING',
    'The connected ClawRouter wallet source is no longer available.',
    {
      fix: `Restore ${path} or ${CLAWROUTER_WALLET_ENV}; Tenjin has not changed the pinned address.`,
    },
  );
}
