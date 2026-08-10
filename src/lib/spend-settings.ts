import type { CommandContext } from '../context';
import {
  loadRawConfig,
  resolveSettings,
  type PartialConfig,
  type ProjectPublishLayer,
} from './config';
import { parseConfirmPolicy } from './policy';
import { resolveContextSettings, type ResolvedSettings } from './settings';
import {
  readClawRouterSpendPolicy,
  type ClawRouterPolicyDeps,
  type ClawRouterPolicyRead,
} from './wallet/clawrouter-policy';
import { readWalletRecord } from './wallet/store';

export interface SpendResolvedSettings extends ResolvedSettings {
  /** Where the read-spend policy came from. ClawRouter inheritance is read-only. */
  spendPolicySource: 'tenjin' | 'clawrouter' | 'safe-fallback';
  spendPolicyWarnings: string[];
  clawRouterPolicyPath?: string;
}

export interface SpendSettingsDeps {
  clawrouterPolicy?: ClawRouterPolicyDeps;
}

const TENJIN_READ_SPEND_KEYS = [
  'maxAutoSpend',
  'sessionBudget',
  'confirm',
  'allowlistCreators',
] as const;

/** Setting any Tenjin read-spend key selects the separate Tenjin policy as a
 * whole. This prevents a surprising hybrid of explicit and inherited limits. */
export function hasExplicitTenjinSpendPolicy(config: PartialConfig): boolean {
  return TENJIN_READ_SPEND_KEYS.some((key) => config[key] !== undefined);
}

export async function resolveSpendContextSettings(
  ctx: CommandContext,
  deps: SpendSettingsDeps = {},
): Promise<SpendResolvedSettings> {
  const base = await resolveContextSettings(ctx);
  const config = await loadRawConfig(ctx.dataDir);
  const inherited = await resolveClawRouterDefaults(ctx, config, deps.clawrouterPolicy);
  if (inherited === undefined) {
    return { ...base, spendPolicySource: 'tenjin', spendPolicyWarnings: [] };
  }
  if (inherited.policy.status !== 'configured' || inherited.source === 'safe-fallback') {
    return {
      ...base,
      spendPolicySource: 'safe-fallback',
      spendPolicyWarnings: inherited.warnings,
      clawRouterPolicyPath: inherited.policy.path,
    };
  }
  return {
    ...base,
    policy: {
      maxAutoSpendAtomic: BigInt(inherited.settings.maxAutoSpend.value),
      sessionBudgetAtomic: BigInt(inherited.settings.sessionBudget.value),
      confirm: parseConfirmPolicy(inherited.settings.confirm.value),
      allowlistCreators: inherited.settings.allowlistCreators.value,
      perRequestLimitAtomic: inherited.policy.limits.perRequestAtomic,
      hourlyBudgetAtomic: inherited.policy.limits.hourlyAtomic,
      dailyBudgetAtomic: inherited.policy.limits.dailyAtomic,
    },
    spendPolicySource: 'clawrouter',
    spendPolicyWarnings: inherited.warnings,
    clawRouterPolicyPath: inherited.policy.path,
  };
}

interface InheritedPolicyResolution {
  settings: ReturnType<typeof resolveSettings>;
  policy: ClawRouterPolicyRead;
  source: 'clawrouter' | 'safe-fallback';
  warnings: string[];
}

async function resolveClawRouterDefaults(
  ctx: CommandContext,
  config: PartialConfig,
  deps?: ClawRouterPolicyDeps,
): Promise<InheritedPolicyResolution | undefined> {
  if (hasExplicitTenjinSpendPolicy(config)) return undefined;
  const record = await readWalletRecord(ctx.dataDir);
  if (record?.provider !== 'clawrouter') return undefined;

  const policy = await readClawRouterSpendPolicy(deps);
  const base = resolveSettings({
    config,
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
  });
  if (policy.status !== 'configured') {
    return {
      settings: base,
      policy,
      source: 'safe-fallback',
      warnings: policy.status === 'invalid' ? [policy.warning] : [],
    };
  }

  const values = Object.values(policy.limits).filter(
    (value): value is bigint => value !== undefined,
  );
  if (values.length === 0) {
    return { settings: base, policy, source: 'safe-fallback', warnings: [] };
  }
  const auto = values.reduce((smallest, value) => (value < smallest ? value : smallest));
  return {
    settings: {
      ...base,
      maxAutoSpend: { value: auto.toString(), source: 'clawrouter' },
      sessionBudget: {
        value: (policy.limits.sessionAtomic ?? 0n).toString(),
        source: 'clawrouter',
      },
      confirm: { value: `above:${auto}`, source: 'clawrouter' },
      allowlistCreators: { value: [], source: 'clawrouter' },
    },
    policy,
    source: 'clawrouter',
    warnings: [
      'Tenjin reads ClawRouter limits as defaults but enforces them with its own ledger; combined ClawRouter + Tenjin spend is not an aggregate budget.',
    ],
  };
}

/** Effective config view used by `tenjin config`: it reports inherited values
 * and provenance, while preserving the project publish layer. */
export async function resolveEffectiveSpendSettingsForContext(
  ctx: CommandContext,
  project?: ProjectPublishLayer,
  deps: SpendSettingsDeps = {},
): Promise<ReturnType<typeof resolveSettings>> {
  const config = await loadRawConfig(ctx.dataDir);
  const resolved = resolveSettings({
    config,
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
    project,
  });
  const inherited = await resolveClawRouterDefaults(ctx, config, deps.clawrouterPolicy);
  if (inherited === undefined) return resolved;
  return {
    ...resolved,
    maxAutoSpend: inherited.settings.maxAutoSpend,
    sessionBudget: inherited.settings.sessionBudget,
    confirm: inherited.settings.confirm,
    allowlistCreators: inherited.settings.allowlistCreators,
  };
}
