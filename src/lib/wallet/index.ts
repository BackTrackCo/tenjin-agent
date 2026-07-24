import { CliError } from '../errors';
import { createLocalProvider } from './local';
import { createLocalSpendAuthorizer, type SpendAuthorizer } from './spend';
import type { SpendPolicy } from '../policy';
import type { CommandContext } from '../../context';
import type { WalletDescription, WalletProvider } from './provider';

export * from './provider';
export { createLocalWallet, type LocalWalletInfo } from './local';
export {
  createLocalSpendAuthorizer,
  type SpendAuthorizer,
  type SpendAuthorization,
  type SpendRequest,
} from './spend';

export interface ResolveWalletProviderOptions {
  /** Test-injection seam: bypass the local provider with a fake (e.g. a remote stub). */
  provider?: WalletProvider;
}

/**
 * The commands' one entry to a wallet. Production always gets the `local`
 * provider bound to the context's data dir and process env; tests pass
 * `opts.provider` to prove `show`/`balance` work against any provider without a
 * real key on disk.
 *
 * The context's interactivity is threaded into the passphrase resolver: a
 * non-interactive context (io.isTTY:false — every `tenjin mcp` context, and any
 * piped-stdout run) can NEVER trigger a hidden-input passphrase prompt, which
 * under the MCP stdio transport would fight the transport for stdin. It fails with
 * the coded no-passphrase error instead. This mirrors buy's confirm gate, which
 * already declines when !ctx.io.isTTY. A real TTY passes isTTY:undefined, keeping
 * the resolver's existing process.stdin.isTTY default untouched.
 */
export function resolveWalletProvider(
  ctx: CommandContext,
  opts: ResolveWalletProviderOptions = {},
): WalletProvider {
  if (opts.provider !== undefined) return opts.provider;
  return createLocalProvider({
    dir: ctx.dataDir,
    env: process.env,
    passphrase: { isTTY: ctx.io.isTTY ? undefined : false },
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
 */
export function resolveSpendAuthorizer(
  ctx: CommandContext,
  policy: SpendPolicy,
  opts: ResolveSpendAuthorizerOptions = {},
): SpendAuthorizer {
  if (opts.authorizer !== undefined) return opts.authorizer;
  return createLocalSpendAuthorizer({ dir: ctx.dataDir, policy });
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
