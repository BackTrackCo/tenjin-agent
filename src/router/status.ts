import { formatUsdDisplay, toMoney } from '../lib/money';
import { loadRawConfig, retiredPaymentKeys, RETIRED_PAYMENT_GUIDANCE } from '../lib/config';
import { paint } from '../lib/output';
import { spentOf } from '../lib/spend-ledger';
import { resolveContextSettings } from '../lib/settings';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import { readSpendSummary } from '../lib/wallet/spend';
import type { CommandContext, CommandResult } from '../context';
import { balanceReader } from '../commands/balance';
import { dollars } from '../commands/fund-watch';
import { channelCredit } from './channel-credit';
import { FUND_COMMAND_LINE, ROUTING_DEPOSIT_KEY, ROUTING_FEE_CEILING_ATOMIC } from './fee';
import { accountJobs, cachedIdentities, labelOf, type Identities } from './identities';
import { readVaultHeader } from './accounts/vault';
import { routerSettings, type RouterSettings } from './settings';
import { BUILT_IN_SOURCE, type Target } from './settings-wire';

/**
 * `tenjin status`: THE FOUR THINGS A USER SEES (plan 37), led by whether
 * Tenjin is on: the balance, today's spend against the daily limit and the
 * per-call limit (both on the Tenjin balance only), the connected accounts
 * and their jobs, and the settings in plain words. Nothing else is printed.
 * What lookups cost, the routing credit and the requests still open are in
 * `--json`.
 *
 * ON OR PAUSED is read the way both hooks read it, from this directory, so a
 * project file that pauses Tenjin here shows here. A setting that can't be
 * read is off, as the hooks treat it.
 *
 * THE BALANCE is read the way `tenjin balance` reads it
 * (`commands/balance.ts`), so the two never disagree. A read that does not
 * answer says so rather than failing the readout, and no wallet means no read
 * at all.
 *
 * IT READS `spend.json` FOR TODAY, NOT THE BACKEND. The rolling window, the
 * committed total and the reservations still open are the local truth about
 * money. A routing deposit is not a lookup: `--json` keeps it apart from what
 * lookups cost, with what the channel still holds. It still counts toward the
 * daily limit, like any automatic payment.
 *
 * THE USER'S OWN ACCOUNTS are listed with who pays for them: their own plans,
 * never counted in the limits on the Tenjin balance. Read from the config,
 * each sign-in's plaintext header and the identities read kept on disk, with
 * no key, keychain or network.
 */

export interface StatusDeps {
  now?: () => number;
  /** The directory whose project files can pause Tenjin; the process's own by default. */
  cwd?: string;
  /** Seam for funds set aside for routing; production reads local channel files. */
  routingCredit?: (ctx: CommandContext) => Promise<bigint>;
  /** Seam for the wallet and its USDC balance (null when the read failed);
   *  null with no wallet. Production reads it as `tenjin balance` does. */
  wallet?: (ctx: CommandContext) => Promise<{ address: string; atomic: bigint | null } | null>;
}

/** The wallet's address and USDC balance, or null with no wallet. Never
 *  throws: a balance the RPC did not give is null. */
async function walletBalance(
  ctx: CommandContext,
): Promise<{ address: string; atomic: bigint | null } | null> {
  let reader: Awaited<ReturnType<typeof balanceReader>>;
  try {
    reader = await balanceReader(ctx);
  } catch {
    return null;
  }
  const atomic = await reader.read().catch(() => null);
  return { address: reader.address, atomic };
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

/** Whether Tenjin routes from here, the line that says so, and the settings
 *  read with it. */
async function onOrPaused(
  ctx: CommandContext,
  cwd: string,
): Promise<{ enabled: boolean; line: string; router?: RouterSettings }> {
  try {
    const router = await routerSettings({ cwd, dataDir: ctx.dataDir });
    const { enabled } = router;
    if (enabled.value) return { enabled: true, line: 'Tenjin is on.', router };
    return {
      enabled: false,
      router,
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
 *  reads them back: blocks, only rules, preferences, then the switches. */
export function settingsPhrases(
  router: Pick<RouterSettings, 'policy' | 'nativeReplacement' | 'accounts'>,
  identities: Identities | undefined,
): { status: 'ok'; phrases: string[] } | { status: 'invalid' } {
  const { policy } = router;
  if (policy.status === 'invalid') return { status: 'invalid' };
  const accounts = new Map(router.accounts.saved.map(({ id, label }) => [id, label]));
  const name = (target: Target) => {
    const label = labelOf(target, identities);
    return target.kind === 'source' && label === target.id
      ? (accounts.get(target.id) ?? label)
      : label;
  };
  const scoped = (scope: { kind: string; id?: string }) =>
    scope.kind === 'global' || scope.id === undefined
      ? ''
      : ` for ${name({ kind: scope.kind as 'task' | 'category', id: scope.id })}`;
  const phrases: string[] = [];
  if (policy.status === 'ok') {
    const { block = [], only = [], prefer = [], preferSpeed } = policy.saved;
    for (const target of block) {
      phrases.push(
        target.kind === 'source' && target.id === BUILT_IN_SOURCE
          ? "Tenjin's own tools off"
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
          : `only ${names}${scoped(rule.scope)}`,
      );
    }
    for (const rule of prefer) {
      const names = list.format(rule.targets.map(name));
      phrases.push(
        rule.scope.kind === 'global'
          ? `your ${names} first`
          : `prefer ${names}${scoped(rule.scope)}`,
      );
    }
    if (preferSpeed === true) phrases.push('faster paid tools where they are as accurate');
  }
  if (router.nativeReplacement.mode !== 'off') phrases.push("Tenjin's picks run automatically");
  return { status: 'ok', phrases };
}

/** The settings as the one line status shows. */
function settingsLine(settings: ReturnType<typeof settingsPhrases>): string {
  if (settings.status === 'invalid') return "can't be read; `tenjin config` shows the problem";
  const { phrases } = settings;
  if (phrases.length === 0) return "Tenjin's defaults (`tenjin config` shows them)";
  const more = phrases.length - SETTINGS_SHOWN;
  return `${phrases.slice(0, SETTINGS_SHOWN).join(' · ')}${
    more > 0 ? ` · and ${more} more (\`tenjin config\`)` : ''
  }`;
}

/** One saved account, as status reads it. */
export interface AccountStatus {
  id: string;
  label: string;
  /** In the account-wide preference: set to come first for its jobs. */
  preferred: boolean;
  /** `ok`; `expired`: a refresh was refused; `signed_out`: no sign-in here. */
  signIn: 'ok' | 'expired' | 'signed_out';
  onRefusal: 'tenjin' | 'ask';
  /** Its jobs, for a mapped account, by name. */
  jobs: string[];
  /** Tools its maps call that this account lacks: jobs that need them are left out. */
  missingTools: string[];
}

/** Every saved account, from local state alone. */
async function accountStatuses(
  dataDir: string,
  router: Pick<RouterSettings, 'policy' | 'accounts'>,
  identities: Identities | undefined,
): Promise<AccountStatus[]> {
  const global =
    router.policy.status === 'ok'
      ? router.policy.saved.prefer?.find(({ scope }) => scope.kind === 'global')
      : undefined;
  const preferred = new Set(
    global?.targets.filter(({ kind }) => kind === 'source').map(({ id }) => id) ?? [],
  );
  return Promise.all(
    router.accounts.saved.map(async (account) => {
      const header = await readVaultHeader(dataDir, account.id).catch(() => null);
      return {
        id: account.id,
        label: account.label,
        preferred: preferred.has(account.id),
        signIn: header === null ? 'signed_out' : header.state === 'expired' ? 'expired' : 'ok',
        onRefusal: account.onRefusal ?? 'ask',
        jobs: account.mapped === true ? accountJobs(account.id, identities) : [],
        missingTools: header?.missingTools ?? [],
      } satisfies AccountStatus;
    }),
  );
}

/** The accounts, as the lines under the label column. */
function accountLines(accounts: readonly AccountStatus[]): string[] {
  if (accounts.length === 0) return ['none connected (`tenjin connect <name>` adds one)'];
  const labels = (keep: (account: AccountStatus) => boolean) =>
    accounts.filter(keep).map(({ label }) => label);
  const first = labels(({ preferred }) => preferred);
  const rest = labels(({ preferred }) => !preferred);
  const named = [
    // Set, not used: only a map Tenjin has checked comes first, and the
    // identities read doesn't say which those are.
    ...(first.length > 0
      ? [`${list.format(first)} (set to come first for the jobs Tenjin has checked)`]
      : []),
    ...(rest.length > 0 ? [`${list.format(rest)} (not put first)`] : []),
  ];
  return [
    `${named.join('; ')}: billed to your own plans, not counted in the limit`,
    ...accounts.flatMap(({ id, label, signIn, onRefusal, jobs, missingTools }) => [
      ...(jobs.length > 0 ? [`${label} does ${list.format(jobs)}`] : []),
      ...(missingTools.length > 0
        ? [
            `this ${label} account lacks ${list.format(missingTools)}, so jobs that need them are left out`,
          ]
        : []),
      ...(signIn === 'expired'
        ? [`${label}'s sign-in has expired: \`tenjin connect ${id}\` reconnects it`]
        : signIn === 'signed_out'
          ? [`${label} isn't signed in on this machine: \`tenjin connect ${id}\``]
          : []),
      ...(onRefusal === 'tenjin'
        ? [`when ${label} refuses a call, Tenjin's own tool runs in its place`]
        : []),
    ]),
  ];
}

/** Labels line up at this width, as `tenjin balance`'s do. */
const LABEL_WIDTH = 14;

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
  const power = await onOrPaused(ctx, deps.cwd ?? process.cwd());
  const retired = retiredPaymentKeys(config);
  const warnings = retired.length
    ? [`Ignored retired keys: ${retired.join(', ')}. ${RETIRED_PAYMENT_GUIDANCE}`]
    : [];
  // THE USER'S OWN ACCOUNTS AND SETTINGS, from local state: their plans pay,
  // so the limits above never count them.
  const identities = await cachedIdentities(ctx.dataDir);
  const accounts =
    power.router !== undefined ? await accountStatuses(ctx.dataDir, power.router, identities) : [];
  const saved =
    power.router !== undefined
      ? settingsPhrases(power.router, identities)
      : ({ status: 'invalid' } as const);
  const automaticAtomic = ledger === null ? 0n : spentOf(ledger);
  const depositedAtomic = (ledger?.exposures ?? [])
    .filter((e) => e.nonce.startsWith(ROUTING_DEPOSIT_KEY))
    .reduce((sum, e) => sum + BigInt(e.amountAtomic), 0n);
  // Never below zero, whatever an older ledger holds.
  const lookupsAtomic = committedAtomic > depositedAtomic ? committedAtomic - depositedAtomic : 0n;
  const [creditAtomic, wallet] = await Promise.all([
    (deps.routingCredit ?? walletRoutingCredit)(ctx),
    (deps.wallet ?? walletBalance)(ctx).catch(() => null),
  ]);
  const budgetAtomic = settings.policy.sessionBudgetAtomic;
  const capAtomic = settings.policy.maxAutoSpendAtomic;
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
      // At least this many: counted at the fee ceiling, since the fee each
      // call pays is the router's quote, at or below it.
      calls: Number(creditAtomic / ROUTING_FEE_CEILING_ATOMIC),
    },
    caps: { maxAutoSpend: toMoney(capAtomic.toString()) },
    accounts,
    settings: saved,
    inFlight: (ledger?.reservations ?? []).map((r) => ({
      amount: toMoney(r.amountAtomic),
      ageSeconds: Math.max(0, Math.round((now() - r.atMs) / 1000)),
      ...(r.requestKey !== undefined ? { request: r.requestKey } : {}),
    })),
  };
  const label = (text: string) => `  ${text.padEnd(LABEL_WIDTH)}`;
  const under = (text: string) => `  ${' '.repeat(LABEL_WIDTH)}${text}`;
  const rows = (name: string, lines: readonly string[]) =>
    lines.map((line, at) => (at === 0 ? `${label(name)}${line}` : under(line)));
  const today =
    budgetAtomic === null
      ? `${dollars(automaticAtomic)} spent automatically (Tenjin balance); no daily limit`
      : budgetAtomic === 0n
        ? `automatic payments are off: your daily limit is ${dollars(0n)} (Tenjin balance)`
        : `${dollars(automaticAtomic)} of your ${dollars(budgetAtomic)} daily limit (Tenjin balance)`;
  const perCall =
    capAtomic === 0n
      ? 'every call paid from the Tenjin balance asks you first'
      : `up to $${formatUsdDisplay(capAtomic.toString())} from the Tenjin balance runs on its own; above it asks first`;
  const balanceLines =
    wallet === null
      ? []
      : wallet.atomic === null
        ? rows('Balance', ["unknown: it couldn't be read just now; `tenjin balance` retries"])
        : [
            `${label('Balance')}${paint(ctx.io, 'bold', dollars(wallet.atomic))}`,
            ...(wallet.atomic === 0n && creditAtomic < ROUTING_FEE_CEILING_ATOMIC
              ? [under(FUND_COMMAND_LINE)]
              : []),
          ];
  return {
    data,
    humanLines: [
      power.line,
      ...balanceLines,
      `${label('Today')}${today}`,
      `${label('Per call')}${perCall}`,
      ...(creditAtomic > 0n
        ? [`${label('Set aside')}about ${dollars(creditAtomic)} for routing`]
        : []),
      ...rows('Your accounts', accountLines(accounts)),
      `${label('Your settings')}${settingsLine(saved)}`,
      ...warnings,
    ],
  };
}
