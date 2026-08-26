import { resolveContextSettings } from '../lib/settings';
import { resolveWriteAuth } from '../lib/consent';
import { getMyStats } from '../lib/posts-api';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import { atomicToUsd } from '../lib/money';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin stats`: this month's earnings, full reads, and glances for the pieces
 * this wallet published. A thin verb over `GET /api/me/stats` (tenjin-agent#208)
 * on the same read-scoped session auth `tenjin edit`'s show uses; a cached
 * session means no wallet prompt. Per-sale detail stays on the desk URL.
 */

export interface StatsDeps {
  fetchImpl?: typeof fetch;
  provider?: WalletProvider;
  useSession?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function runStats(ctx: CommandContext, deps: StatsDeps = {}): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  const runtime = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  const wallet = await describeWallet(provider);
  const signer = await provider.getSigner();
  const auth = resolveWriteAuth({
    signer,
    baseUrl: runtime.baseUrl,
    dataDir: ctx.dataDir,
    scope: 'read',
    ...(deps.useSession !== undefined ? { useSession: deps.useSession } : {}),
    env,
  });
  const stats = await getMyStats(auth, {
    baseUrl: runtime.baseUrl,
    timeoutMs: ctx.flags.timeout,
    ...(runtime.bypass !== undefined ? { bypass: runtime.bypass } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const earningsUsd = atomicToUsd(stats.earningsThisMonth);
  return {
    data: {
      address: wallet.address,
      earningsThisMonth: stats.earningsThisMonth,
      earningsThisMonthUsd: earningsUsd,
      readsThisMonth: stats.readsThisMonth,
      glancesThisMonth: stats.glancesThisMonth,
    },
    humanLines: [
      `This month (UTC) for ${wallet.address}:`,
      `  earnings: $${earningsUsd}`,
      `  reads:    ${stats.readsThisMonth}`,
      `  glances:  ${stats.glancesThisMonth}`,
    ],
  };
}
