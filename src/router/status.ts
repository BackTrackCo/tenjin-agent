import { formatUsdDisplay, toMoney } from '../lib/money';
import {
  loadRawConfig,
  readPersonalRouter,
  retiredPaymentKeys,
  RETIRED_PAYMENT_GUIDANCE,
} from '../lib/config';
import { spentOf } from '../lib/spend-ledger';
import { resolveContextSettings } from '../lib/settings';
import { readUsdcBalanceWithFallback } from '../lib/usdc-balance';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import { readSpendSummary } from '../lib/wallet/spend';
import type { CommandContext, CommandResult } from '../context';
import { channelCredit } from './channel-credit';
import { FUND_COMMAND_LINE, ROUTING_DEPOSIT_KEY, ROUTING_FEE_ATOMIC } from './fee';
import { accountLines, accountStatuses } from './accounts/readout';
import { BUILT_IN_SOURCE } from './access';
import type { DirectoryListing, Target } from './decision';
import { cachedDirectory, labelOf } from './directory';
import { routerSettings } from './settings';

/**
 * `tenjin status`: THE FOUR THINGS A USER SEES (tenjin-notes#37), led by
 * whether Tenjin is on: the balance, today's spend against the daily limit
 * and the per-call limit (both on the Tenjin balance only), the connected
 * accounts and their jobs, and the settings. Nothing else is printed. What lookups cost,
 * the routing credit and the requests still open are in `--json` alone.
 *
 * ON OR PAUSED is read the way both hooks read it, from this directory, so a
 * project file that pauses Tenjin here shows here. A setting that can't be
 * read is off, as the hooks treat it.
 *
 * IT READS `spend.json`, NOT THE BACKEND. The rolling window, the committed
 * total and the reservations still open are the local truth about money, and
 * the reservations are also the record of a request whose outcome is unknown:
 * an authorization that was transmitted is committed, so anything still open
 * here is either in flight or a crash that has not yet aged out.
 *
 * A ROUTING DEPOSIT IS NOT A LOOKUP. It is prepaid credit the routing fee
 * draws from, so `--json` keeps it apart from what lookups cost, with what
 * the channel still holds. It still counts toward the daily limit, like any
 * automatic payment.
 *
 * THE USER'S OWN ACCOUNTS are listed with who pays for them: their own plans,
 * never counted in the limits on the Tenjin balance. Read from the config and
 * each sign-in's plaintext header, with no key, keychain or network.
 *
 * THE BALANCE COMES NEXT, read from the chain with the same fallback a lookup
 * uses, because a balance at $0 is why nothing pays. A read that does not
 * answer says so rather than failing the readout, and no wallet means no read
 * at all.
 *
 * THE USER'S SETTINGS FOLLOW THEIR ACCOUNTS, one line of short phrases
 * ("prefer Exa for web research · never use Firecrawl"), named from the
 * directory's copy on disk and the saved accounts, never by id. `tenjin
 * config` reads them back in full, with how to undo each.
 */

export interface StatusDeps {
  now?: () => number;
  /** The directory whose project files can pause Tenjin; the process's own by default. */
  cwd?: string;
  /** Seam for the wallet's routing credit; production reads its channel files. */
  routingCredit?: (ctx: CommandContext) => Promise<bigint>;
  /** Seam for the wallet and its USDC balance (null when the read failed);
   *  null with no wallet. Production reads the chain. */
  wallet?: (
    ctx: CommandContext,
    rpcUrl: string,
  ) => Promise<{ address: string; atomic: bigint | null } | null>;
}

/** The wallet's address and USDC balance, or null with no wallet. Never
 *  throws: a balance the RPC did not give is null. */
async function walletOnChain(
  ctx: CommandContext,
  rpcUrl: string,
): Promise<{ address: string; atomic: bigint | null } | null> {
  let address: string;
  try {
    ({ address } = await describeWallet(resolveWalletProvider(ctx)));
  } catch {
    return null;
  }
  const atomic = await readUsdcBalanceWithFallback(address, rpcUrl, {
    timeoutMs: Math.max(1, Math.floor(ctx.flags.timeout / 2)),
  }).catch(() => null);
  return { address, atomic };
}

/** What the wallet's routing channel still holds; 0n with no wallet, or one
 *  this cannot read without a prompt. */
async function walletRoutingCredit(ctx: CommandContext): Promise<bigint> {
  try {
    const { address } = await describeWallet(resolveWalletProvider(ctx));
    return await channelCredit(ctx.dataDir, address);
  } catch {
    return 0n;
  }
}

/** Whether Tenjin routes from here, and the line that says so. */
async function onOrPaused(
  dataDir: string,
  config: Awaited<ReturnType<typeof loadRawConfig>>,
  cwd: string,
): Promise<{ enabled: boolean; line: string }> {
  try {
    const { enabled } = await routerSettings({ cwd, dataDir, config });
    if (enabled.value) return { enabled: true, line: 'Tenjin is on.' };
    return {
      enabled: false,
      line:
        enabled.source === 'project' || enabled.source === 'local'
          ? `Tenjin is paused here by ${enabled.path ?? 'a project file'}: set router.enabled to true there to turn it back on.`
          : 'Tenjin is paused on this machine: `tenjin config set router.enabled true` turns it back on.',
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      enabled: false,
      line: `Tenjin is off here: its on/off setting can't be read (${why}).`,
    };
  }
}

const list = new Intl.ListFormat('en', { type: 'conjunction' });
const either = new Intl.ListFormat('en', { type: 'disjunction' });
/** How many phrases the one settings line shows before it points elsewhere. */
const SETTINGS_SHOWN = 5;

/** The saved settings, one short phrase each, in the order `tenjin config`
 *  reads them back: blocks, only rules, preferences, then the switch. */
export function settingsPhrases(
  router: unknown,
  listing: DirectoryListing | undefined,
  accounts: ReadonlyMap<string, string>,
): { status: 'ok'; phrases: string[] } | { status: 'invalid' } {
  const personal = readPersonalRouter(router);
  if (personal.policy.status === 'invalid') return { status: 'invalid' };
  const name = (target: Target) => {
    const label = labelOf(target, listing);
    return target.kind === 'source' && label === target.id
      ? (accounts.get(target.id) ?? label)
      : label;
  };
  const task = (id: string) => name({ kind: 'task', id });
  const phrases: string[] = [];
  if (personal.policy.status === 'ok') {
    const { block = [], only = [], prefer = [] } = personal.policy.saved;
    for (const target of block) {
      phrases.push(
        target.kind === 'source' && target.id === BUILT_IN_SOURCE
          ? 'only your own accounts'
          : target.kind === 'task' || target.kind === 'category'
            ? `never handle ${name(target)}`
            : `never use ${name(target)}`,
      );
    }
    for (const rule of only) {
      const names = either.format(rule.targets.map(name));
      phrases.push(
        rule.dimension === 'capability'
          ? `Tenjin only for ${names}`
          : rule.scope.kind === 'task'
            ? `only ${names} for ${task(rule.scope.id)}`
            : `only ${names}`,
      );
    }
    for (const rule of prefer) {
      const names = list.format(rule.targets.map(name));
      phrases.push(
        rule.scope.kind === 'task'
          ? `prefer ${names} for ${task(rule.scope.id)}`
          : `prefer ${names}`,
      );
    }
  }
  if (personal.nativeReplacement.mode !== 'off') phrases.push("run Tenjin's picks automatically");
  return { status: 'ok', phrases };
}

/** The settings as the one line status shows. */
function settingsLine(settings: ReturnType<typeof settingsPhrases>): string {
  if (settings.status === 'invalid')
    return "Your settings: can't be read; `tenjin config` shows the problem";
  const { phrases } = settings;
  if (phrases.length === 0) return "Your settings: Tenjin's defaults (`tenjin config` shows them)";
  const more = phrases.length - SETTINGS_SHOWN;
  return `Your settings: ${phrases.slice(0, SETTINGS_SHOWN).join(' · ')}${
    more > 0 ? ` · and ${more} more (\`tenjin config\`)` : ''
  }`;
}

export async function runRouterStatus(
  ctx: CommandContext,
  deps: StatusDeps = {},
): Promise<CommandResult> {
  const now = deps.now ?? Date.now;
  const settings = await resolveContextSettings(ctx);
  // The same projection an authorization would make, so what this prints is
  // what the next lookup would actually be measured against.
  const ledger = await readSpendSummary(ctx.dataDir, { now });
  const committedAtomic = BigInt(ledger?.committedAtomic ?? '0');
  const reservedAtomic = (ledger?.reservations ?? []).reduce(
    (sum, r) => sum + BigInt(r.amountAtomic),
    0n,
  );
  const config = await loadRawConfig(ctx.dataDir);
  const power = await onOrPaused(ctx.dataDir, config, deps.cwd ?? process.cwd());
  const retired = retiredPaymentKeys(config);
  // THE USER'S OWN ACCOUNTS (#37), from the config, each vault's header and
  // the directory's copy: their plans pay, so the limits below never count them.
  const listing = await cachedDirectory(ctx.dataDir);
  const accounts = await accountStatuses(ctx.dataDir, config.router, listing);
  const saved = settingsPhrases(
    config.router,
    listing,
    new Map(accounts.map(({ id, label }) => [id, label])),
  );
  const warnings = retired.length
    ? [`Ignored retired keys: ${retired.join(', ')}. ${RETIRED_PAYMENT_GUIDANCE}`]
    : [];
  const automaticAtomic = ledger === null ? 0n : spentOf(ledger);
  const depositedAtomic = (ledger?.exposures ?? [])
    .filter((e) => e.nonce.startsWith(ROUTING_DEPOSIT_KEY))
    .reduce((sum, e) => sum + BigInt(e.amountAtomic), 0n);
  // Never below zero, whatever an older ledger holds.
  const lookupsAtomic = committedAtomic > depositedAtomic ? committedAtomic - depositedAtomic : 0n;
  const [creditAtomic, wallet] = await Promise.all([
    (deps.routingCredit ?? walletRoutingCredit)(ctx),
    (deps.wallet ?? walletOnChain)(ctx, settings.rpcUrl).catch(() => null),
  ]);
  const budgetAtomic = settings.policy.sessionBudgetAtomic;
  const data = {
    enabled: power.enabled,
    baseUrl: settings.baseUrl,
    warnings,
    wallet:
      wallet === null
        ? null
        : {
            address: wallet.address,
            balance: wallet.atomic === null ? null : toMoney(wallet.atomic.toString()),
          },
    window: {
      startedAtMs: ledger?.windowStartMs ?? null,
      committed: toMoney(committedAtomic.toString()),
      lookups: toMoney(lookupsAtomic.toString()),
      routingDeposits: toMoney(depositedAtomic.toString()),
      automaticExposure: toMoney(automaticAtomic.toString()),
      reserved: toMoney(reservedAtomic.toString()),
      budget: budgetAtomic === null ? null : toMoney(budgetAtomic.toString()),
    },
    routingCredit: {
      remaining: toMoney(creditAtomic.toString()),
      calls: Number(creditAtomic / ROUTING_FEE_ATOMIC),
    },
    caps: {
      maxAutoSpend: toMoney(settings.policy.maxAutoSpendAtomic.toString()),
    },
    settings: saved.status === 'ok' ? { status: 'ok', phrases: saved.phrases } : saved,
    accounts: accounts.map(({ id, label, preferred, signIn, onRefusal, jobs }) => ({
      id,
      label,
      preferred,
      signIn,
      onRefusal,
      ...(jobs !== undefined ? { jobs } : {}),
    })),
    inFlight: (ledger?.reservations ?? []).map((r) => ({
      amount: toMoney(r.amountAtomic),
      ageSeconds: Math.max(0, Math.round((now() - r.atMs) / 1000)),
      ...(r.requestKey !== undefined ? { request: r.requestKey } : {}),
    })),
  };
  // THE LIMITS CAP THE TENJIN BALANCE, and say so: a bill an account of the
  // user's own sends (#37) is not counted against them.
  const automatic = `$${formatUsdDisplay(automaticAtomic.toString())}`;
  const budgetLine =
    budgetAtomic === null
      ? `Today ${automatic} spent automatically (Tenjin balance); no daily limit`
      : `Today ${automatic} of your $${formatUsdDisplay(budgetAtomic.toString())} daily limit (Tenjin balance, over the last 24 hours)`;
  const capAtomic = settings.policy.maxAutoSpendAtomic;
  const perCallLine =
    capAtomic === 0n
      ? 'Per call: every call paid from the Tenjin balance asks you first.'
      : `Per call: up to $${formatUsdDisplay(capAtomic.toString())} from the Tenjin balance runs on its own; a call above it asks you first.`;
  const walletLines =
    wallet === null
      ? []
      : wallet.atomic === null
        ? ["Balance unknown: it couldn't be read just now; `tenjin wallet balance` retries"]
        : [
            `Balance $${formatUsdDisplay(wallet.atomic.toString())}`,
            ...(wallet.atomic === 0n ? [FUND_COMMAND_LINE] : []),
          ];
  return {
    data,
    humanLines: [
      power.line,
      ...walletLines,
      budgetLine,
      perCallLine,
      ...accountLines(accounts),
      settingsLine(saved),
      ...warnings,
    ],
  };
}
