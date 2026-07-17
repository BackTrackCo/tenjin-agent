import { CliError } from '../errors';
import { createLocalProvider } from './local';
import type { CommandContext } from '../../context';
import type { WalletDescription, WalletProvider } from './provider';

export * from './provider';
export { createLocalWallet, type LocalWalletInfo } from './local';

export interface ResolveWalletProviderOptions {
  /** Test-injection seam: bypass the local provider with a fake (e.g. a remote stub). */
  provider?: WalletProvider;
}

/**
 * The commands' one entry to a wallet. Production always gets the `local`
 * provider bound to the context's data dir and process env; tests pass
 * `opts.provider` to prove `show`/`balance` work against any provider without a
 * real key on disk.
 */
export function resolveWalletProvider(
  ctx: CommandContext,
  opts: ResolveWalletProviderOptions = {},
): WalletProvider {
  if (opts.provider !== undefined) return opts.provider;
  return createLocalProvider({ dir: ctx.dataDir, env: process.env });
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
