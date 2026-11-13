import { formatUsdDisplay, toMoney } from '../lib/money';
import { loadRawConfig, retiredPaymentKeys, RETIRED_PAYMENT_GUIDANCE } from '../lib/config';
import { paint } from '../lib/output';
import { spentOf } from '../lib/spend-ledger';
import { resolveContextSettings } from '../lib/settings';
import { describeWallet, resolveWalletProvider } from '../lib/wallet';
import { readSpendSummary } from '../lib/wallet/spend';
import type { CommandContext, CommandResult } from '../context';
import { balanceReader, lowBalance } from '../commands/balance';
import { connectedLabels, describeRules, summarizeRule } from '../commands/config-readback';
import { dollars } from '../commands/fund-watch';
import { channelCredit } from './channel-credit';
import { ROUTING_DEPOSIT_KEY, ROUTING_FEE_CEILING_ATOMIC, SUGGESTED_FUND_USD } from './fee';
import { accountJobs, cachedIdentities, labelOf, type Identities } from './identities';
import { readVaultHeader } from './accounts/vault';
import { routerSettings, type RouterSettings } from './settings';
import { BUILT_IN_SOURCE, type Target } from './settings-wire';

/**
 * `tenjin status`: THE FOUR THINGS A USER SEES (plan 37), led by one line
 * saying whether Tenjin is on: the balance, today's spend against the daily
 * limit with the per-call limit beside it (both on the Tenjin balance only),
 * the connected accounts, and the settings in a few words. Each row is one
 * line, a dim command beside it only where there is a next step, and each
 * problem one `! ` line at the end with its fix. What lookups cost, the
 * routing credit and the requests still open are in `--json`.
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
  modelCredit?: (ctx: CommandContext) => Promise<bigint>;
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
async function walletRoutingCredit(
  ctx: CommandContext,
  lane: 'tool' | 'model' = 'tool',
): Promise<bigint> {
  try {
    const { address } = await describeWallet(resolveWalletProvider(ctx));
    return await channelCredit(ctx.dataDir, address, lane);
  } catch {
    return 0n;
  }
}

/** Whether Tenjin routes from here, the lines that say so when it doesn't,
 *  and the settings read with it. */
async function onOrPaused(
  ctx: CommandContext,
  cwd: string,
): Promise<{ enabled: boolean; paused: string[]; router?: RouterSettings }> {
  try {
    const router = await routerSettings({ cwd, dataDir: ctx.dataDir });
    const { enabled } = router;
    if (enabled.value) return { enabled: true, paused: [], router };
    return {
      enabled: false,
      router,
      paused:
        enabled.source === 'project' || enabled.source === 'local'
          ? [
              '○ Tenjin is paused here',
              `  It offers nothing here until router.enabled is true in ${enabled.path ?? 'its project file'}.`,
            ]
          : [
              '○ Tenjin is paused',
              '  It offers nothing until you turn it back on:',
              '  tenjin config set router.enabled true',
            ],
    };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      enabled: false,
      paused: ['○ Tenjin is off here', `  Its on/off setting can't be read (${why}).`],
    };
  }
}

const list = new Intl.ListFormat('en', { type: 'conjunction' });
const either = new Intl.ListFormat('en', { type: 'disjunction' });
/** The saved settings, one short phrase each, in the order `tenjin config`
 *  reads them back: blocks, only rules, preferences, then the switches. What
 *  `--json` carries; the human row is {@link settingsRow}'s. */
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
    // A block stops only what Tenjin offers on its own; asked by name, it runs.
    for (const target of block) {
      const named =
        target.kind === 'source' && target.id === BUILT_IN_SOURCE
          ? "Tenjin's own tools"
          : name(target);
      phrases.push(`never offer ${named} unless asked`);
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

/** One status row: a label, its value, and a dim next command or detail. */
interface Row {
  label: string;
  /** The value as it reads, for alignment. */
  value: string;
  /** The same value with its color, when it has one. */
  styled?: string;
  /** A dim command, lined up with the other rows' commands. */
  hint?: string;
  /** Dim words right after the value, not lined up. */
  after?: string;
}

/** Each connected account, `fal ✓`, or what it needs; and the problem lines
 *  that say how to fix one. Local state only: no account is asked. */
function accountsRow(
  ctx: CommandContext,
  accounts: readonly AccountStatus[],
): { row: Row; problems: string[] } {
  if (accounts.length === 0)
    return {
      row: { label: 'Accounts', value: 'none yet', hint: 'tenjin connect fal' },
      problems: [],
    };
  const needs = (account: AccountStatus) =>
    account.signIn === 'expired'
      ? 'sign-in expired'
      : account.signIn === 'signed_out'
        ? 'not signed in here'
        : undefined;
  const entries = accounts.map((account) => {
    const need = needs(account);
    return need === undefined
      ? { value: `${account.label} ✓`, styled: `${account.label} ${paint(ctx.io, 'green', '✓')}` }
      : {
          value: `${account.label} ! ${need}`,
          styled: `${account.label} ${paint(ctx.io, 'yellow', `! ${need}`)}`,
        };
  });
  return {
    row: {
      label: 'Accounts',
      value: entries.map(({ value }) => value).join(' · '),
      styled: entries.map(({ styled }) => styled).join(' · '),
    },
    problems: accounts.flatMap(({ id, label, signIn }) =>
      signIn === 'expired'
        ? [`${label}'s sign-in expired: tenjin connect ${id}`]
        : signIn === 'signed_out'
          ? [`${label} isn't signed in on this machine: tenjin connect ${id}`]
          : [],
    ),
  };
}

/** The most the settings row spells out before it counts the rules instead. */
const SETTINGS_PHRASES = 3;
const SETTINGS_WIDTH = 60;

/** The settings in a few words, from the readback `tenjin config` lists. */
function settingsRow(
  router: RouterSettings | undefined,
  identities: Identities | undefined,
): { row: Row; problems: string[] } {
  const label = 'Settings';
  if (router === undefined || router.policy.status === 'invalid') {
    return {
      row: { label, value: "can't be read" },
      problems: ["Your settings can't be read, so Tenjin won't route: tenjin config shows why"],
    };
  }
  const rules =
    router.policy.status === 'ok'
      ? describeRules(router.policy.saved, identities, connectedLabels(router))
      : [];
  const phrases = rules.map((rule) => summarizeRule(rule, identities, router.accounts.saved).short);
  const automatic = router.nativeReplacement.mode !== 'off' ? ['automatic picks on'] : [];
  const all = [...phrases, ...automatic];
  if (all.length === 0)
    return { row: { label, value: "Tenjin's defaults", hint: 'tenjin config' }, problems: [] };
  const spelled = all.join(' · ');
  const value =
    all.length <= SETTINGS_PHRASES && spelled.length <= SETTINGS_WIDTH
      ? spelled
      : [`${phrases.length} ${phrases.length === 1 ? 'rule' : 'rules'}`, ...automatic].join(' · ');
  return { row: { label, value }, problems: [] };
}

/** Labels line up at this width: `Accounts   `. */
const LABEL_WIDTH = 11;

/** The rows, labels and next commands lined up. */
function rowLines(ctx: CommandContext, rows: readonly Row[]): string[] {
  const hinted = rows.filter(({ hint }) => hint !== undefined);
  const at = Math.max(0, ...hinted.map(({ value }) => value.length)) + 2;
  return rows.map(({ label, value, styled, hint, after }) => {
    const shown = `  ${label.padEnd(LABEL_WIDTH)}${styled ?? value}`;
    if (after !== undefined) return `${shown}  ${paint(ctx.io, 'dim', after)}`;
    if (hint !== undefined)
      return `${shown}${' '.repeat(at - value.length)}${paint(ctx.io, 'dim', hint)}`;
    return shown;
  });
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
  const [creditAtomic, wallet, modelCreditAtomic] = await Promise.all([
    (deps.routingCredit ?? walletRoutingCredit)(ctx),
    (deps.wallet ?? walletBalance)(ctx).catch(() => null),
    deps.modelCredit ? deps.modelCredit(ctx) : walletRoutingCredit(ctx, 'model'),
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
    modelCredit: { remaining: toMoney(modelCreditAtomic.toString()) },
    caps: { maxAutoSpend: toMoney(capAtomic.toString()) },
    accounts,
    settings: saved,
    inFlight: (ledger?.reservations ?? []).map((r) => ({
      amount: toMoney(r.amountAtomic),
      ageSeconds: Math.max(0, Math.round((now() - r.atMs) / 1000)),
      ...(r.requestKey !== undefined ? { request: r.requestKey } : {}),
    })),
  };
  const yellow = (text: string) => paint(ctx.io, 'yellow', text);
  const low = wallet?.atomic != null && lowBalance(wallet.atomic, settings.policy);
  const head = !power.enabled
    ? power.paused
    : low
      ? [yellow('! Tenjin is on, but your balance is low')]
      : [`${paint(ctx.io, 'green', '●')} Tenjin is on`];
  const balance: Row[] =
    wallet === null
      ? []
      : wallet.atomic === null
        ? [{ label: 'Balance', value: 'unknown' }]
        : [
            {
              label: 'Balance',
              value: dollars(wallet.atomic),
              styled: paint(ctx.io, 'bold', dollars(wallet.atomic)),
              ...(low ? { hint: `tenjin fund ${SUGGESTED_FUND_USD}` } : {}),
            },
          ];
  const today: Row = {
    label: 'Today',
    value:
      budgetAtomic === null
        ? `${dollars(automaticAtomic)}, no daily limit`
        : budgetAtomic === 0n
          ? `automatic payments off (${dollars(0n)} a day)`
          : `${dollars(automaticAtomic)} of ${dollars(budgetAtomic)}`,
    after:
      capAtomic === 0n
        ? '· every call asks first'
        : `· up to $${formatUsdDisplay(capAtomic.toString())} a call`,
  };
  const accountsShown = accountsRow(ctx, accounts);
  const settingsShown = settingsRow(power.router, identities);
  const problems = [
    ...(wallet !== null && wallet.atomic === null
      ? ["Your balance couldn't be read just now: tenjin balance tries again"]
      : []),
    ...accountsShown.problems,
    ...settingsShown.problems,
    ...warnings,
  ];
  return {
    data,
    humanLines: [
      ...head,
      '',
      ...rowLines(ctx, [
        ...balance,
        today,
        ...(modelCreditAtomic > 0n
          ? [
              {
                label: 'Subagents',
                value: `${dollars(modelCreditAtomic)} set aside for model calls`,
              },
            ]
          : []),
        accountsShown.row,
        settingsShown.row,
      ]),
      ...(problems.length > 0 ? ['', ...problems.map((problem) => yellow(`! ${problem}`))] : []),
    ],
  };
}
