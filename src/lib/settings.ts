import { loadRawConfig, resolveSettings } from './config';
import { parseConfirmPolicy, type SpendPolicy } from './policy';
import type { CommandContext } from '../context';

/**
 * The effective runtime settings a B2 command needs, resolved once through the
 * same precedence (flag > env > file > default) config/doctor use. Spend values
 * arrive atomic from config and are handed on as bigint for the policy layer.
 */
export interface ResolvedSettings {
  baseUrl: string;
  rpcUrl: string;
  policy: SpendPolicy;
}

export async function resolveContextSettings(ctx: CommandContext): Promise<ResolvedSettings> {
  const config = await loadRawConfig(ctx.dataDir);
  const s = resolveSettings({ config, flags: { baseUrl: ctx.flags.baseUrl }, env: process.env });
  return {
    baseUrl: s.baseUrl.value,
    rpcUrl: s.rpcUrl.value,
    policy: {
      maxAutoSpendAtomic: BigInt(s.maxAutoSpend.value),
      sessionBudgetAtomic: BigInt(s.sessionBudget.value),
      confirm: parseConfirmPolicy(s.confirm.value),
      allowlistCreators: s.allowlistCreators.value,
    },
  };
}
