import { CliError } from '../errors';
import { emitNotice } from '../output';
import { spendLedgerPath } from '../paths';
import { createLocalProvider, type PassphraseOverrides } from './local';
import { createClawRouterProvider, type ClawRouterProviderDeps } from './clawrouter';
import { readWalletRecord } from './store';
import { createLocalSpendAuthorizer, type SpendAuthorizer } from './spend';
import type { SpendPolicy } from '../policy';
import type { CommandContext } from '../../context';
import type { WalletDescription, WalletProvider } from './provider';

export * from './provider';
export {
  CLAWROUTER_WALLET_ENV,
  createClawRouterProvider,
  defaultClawRouterWalletPath,
  discoverClawRouterWallet,
  type ClawRouterProviderDeps,
} from './clawrouter';
export {
  commitLocalWallet,
  createLocalWallet,
  parkOutgoingWallet,
  prepareLocalWallet,
  restoreParkedWallet,
  verifyAndPreserveOutgoingWallet,
  verifyLocalWallet,
  type ArchivedPassphraseLocation,
  type ArchivedWalletInfo,
  type CreatePassphrase,
  type LocalWalletInfo,
  type PreparedLocalWallet,
  type PassphraseOverrides,
  type PreservedWalletInfo,
  type UnarchivedReason,
} from './local';
export {
  createLocalSpendAuthorizer,
  type SpendAuthorizer,
  type SpendAuthorization,
  type SpendRequest,
} from './spend';

export interface ResolveWalletProviderOptions {
  /** Test-injection seam: bypass the local provider with a fake (e.g. a remote stub). */
  provider?: WalletProvider;
  /**
   * Passphrase seams (keychain exec, platform) for the local provider. `doctor`
   * threads its own through so a test never reaches the developer's real OS
   * credential store; `isTTY` is still decided here, never by a caller.
   */
  passphrase?: Omit<PassphraseOverrides, 'isTTY'>;
  /** Test seams for the explicit ClawRouter connector. */
  clawrouter?: ClawRouterProviderDeps;
}

/**
 * The commands' one entry to a wallet. A persisted provider pointer selects the
 * explicit ClawRouter connector; otherwise production gets `local`, bound to
 * the context's data dir and process env. Tests may inject either provider.
 *
 * The context's interactivity is threaded into the passphrase resolver: a
 * non-interactive context (io.isTTY:false — every `tenjin mcp` context, and any
 * piped-stdout run) can NEVER trigger a hidden-input passphrase prompt, which
 * under the MCP stdio transport would fight the transport for stdin. It fails with
 * the coded no-passphrase error instead. This mirrors buy's confirm gate, which
 * already declines when !ctx.io.isTTY. A real TTY passes isTTY:undefined, keeping
 * the resolver's existing process.stdin.isTTY default untouched.
 */
export async function resolveWalletProvider(
  ctx: CommandContext,
  opts: ResolveWalletProviderOptions = {},
): Promise<WalletProvider> {
  if (opts.provider !== undefined) return opts.provider;
  const record = await readWalletRecord(ctx.dataDir);
  if (record?.provider === 'clawrouter') {
    return createClawRouterProvider(record, opts.clawrouter);
  }
  return createLocalProvider({
    dir: ctx.dataDir,
    env: process.env,
    passphrase: { ...opts.passphrase, isTTY: ctx.io.isTTY ? undefined : false },
  });
}

export interface ResolveSpendAuthorizerOptions {
  /** Test-injection seam: bypass the local authorizer (e.g. a provider-enforced stub). */
  authorizer?: SpendAuthorizer;
}

/**
 * The commands' one entry to spend enforcement. Production gets the local
 * (client-only) authorizer bound to the context's data dir and the resolved
 * policy; a future hosted provider returns its own provider-enforced authorizer
 * here, and every spend path already routes through it.
 *
 * The corrupt-ledger notice is attached here because this is the only place the
 * local authorizer meets a context: the authorizer fails open on an unreadable
 * ledger (a spend must not be blocked by a local cache), and this line is what
 * keeps that reset from being invisible to the human whose budget just reset.
 */
export function resolveSpendAuthorizer(
  ctx: CommandContext,
  policy: SpendPolicy,
  opts: ResolveSpendAuthorizerOptions = {},
): SpendAuthorizer {
  if (opts.authorizer !== undefined) return opts.authorizer;
  return createLocalSpendAuthorizer({
    dir: ctx.dataDir,
    policy,
    onCorrupt: (reason) =>
      emitNotice(
        ctx.io,
        `spend ledger at ${spendLedgerPath(ctx.dataDir)} was unreadable (${reason}); spending window restarted`,
        { json: ctx.flags.json },
      ),
  });
}

/**
 * Call `describe()` through the error contract: a CliError (e.g. WALLET_MISSING
 * from the local provider) passes through, but any other rejection — a remote
 * provider's network/refusal error — normalizes to PROVIDER_ERROR so callers
 * always see a coded failure, never a bare stack trace.
 */
export async function describeWallet(provider: WalletProvider): Promise<WalletDescription> {
  try {
    return await provider.describe();
  } catch (err) {
    if (err instanceof CliError) throw err;
    const message = err instanceof Error ? err.message : 'unknown error';
    throw new CliError('PROVIDER_ERROR', `Wallet provider "${provider.id}" failed: ${message}`, {
      fix: 'Check the wallet provider and try again.',
      cause: err,
    });
  }
}
