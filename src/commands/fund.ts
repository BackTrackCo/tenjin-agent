import { getAddress, isAddress } from 'viem';
import { CliError } from '../lib/errors';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { deviceName as readDeviceName } from '../lib/device-name';
import { httpRequest, fetchFailureToCliError, type HttpRequestOptions } from '../lib/http';
import { liveLine, type LiveLine } from '../lib/live-line';
import { buildSiwxHeader, SIWX_CHAIN_ID, SIWX_HEADER } from '../lib/siwx';
import {
  describeWallet,
  resolveWalletProvider,
  type ResolveWalletProviderOptions,
  type TenjinSigner,
} from '../lib/wallet';
import { getUsdcBalance } from '../lib/usdc';
import { toMoney } from '../lib/money';
import { emitWriteNotice, paint, style } from '../lib/output';
import { addressQrLines, textQrLines } from '../lib/qr';
import { openInBrowser } from '../lib/open-url';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import { underAgentHarness } from '../lib/session';
import { SUGGESTED_FUND_USD } from '../router/fee';
import {
  dollars,
  forgetLink,
  inFlight,
  LINK_LIFETIME_MS,
  readLinkStatus,
  recallLink,
  rememberLink,
  STATUS_GRACE_MS,
  tokenExpiry,
  tokenOf,
  watchFunding,
  type LinkStatus,
  type RememberedLink,
  type WatchEnd,
} from './fund-watch';
import type { CommandContext, CommandResult } from '../context';

/*
 * `tenjin fund` (and `tenjin wallet fund`): add funds to THIS wallet in the
 * browser. The CLI signs a SIWX proof with the wallet's own key and asks the
 * Tenjin backend for a checkout link for that same address (the server refuses
 * any other address). The link is the Tenjin /fund page, with a short-lived
 * token in the URL fragment, or a Coinbase-hosted checkout. The money moves
 * entirely on the provider's side and the link grants no spending power over
 * the wallet. A hosted link is single-use, expires in ~5 minutes and is bound
 * to this machine's public IP at mint time.
 *
 * At a terminal it then watches: the link's payment status from the server
 * and the balance, on one status line, until the money lands
 * (`fund-watch.ts`). `--usdc` shows the address to send USDC to instead,
 * and watches the same way.
 */

/** The hosted Coinbase checkout host, one of the two hosts a returned link may use. */
const COINBASE_CHECKOUT_HOST = 'pay.coinbase.com';
/** A hosted Coinbase link's own lifetime. */
const HOSTED_LIFETIME_MS = 5 * 60_000;
/**
 * fund talks to production, full stop (owner decision, 2026-08-12): the mint
 * signs with the wallet key, so this path takes no override -- not `--base-url`,
 * not the env, not config. Cutting the surface entirely is what lets the verb
 * sit in the free allowlist tier with nothing to caveat.
 */
const FUND_ORIGIN = PRODUCTION_ORIGIN;
/**
 * The only hosts a returned link may point at; anything else is refused unopened.
 * The first is the host of the pinned origin (the Tenjin /fund page), so it
 * follows the origin if that is ever re-pointed.
 */
const ALLOWED_CHECKOUT_HOSTS: readonly string[] = [
  new URL(FUND_ORIGIN).host,
  COINBASE_CHECKOUT_HOST,
];
/** Matches the server's presetAmount bound (the fund link route's body schema). */
const MAX_PRESET_USD = 100_000;
/** The link route's bounds on `need`. */
const NEED_LABEL_MAX = 60;
const NEED_PRICE_MAX_USD = 100;
/** How long the balance read before a mint may take: it never holds the link up for long. */
const BASELINE_TIMEOUT_MS = 4_000;
/**
 * A payment started on a link this recent, with the balance not yet up, is
 * one on its way: a rerun waits on it rather than opening a second checkout.
 */
const DUPLICATE_WINDOW_MS = 15 * 60_000;
/** How long `--usdc` watches for a transfer. */
const USDC_WAIT_MS = 15 * 60_000;

/**
 * Why the run is not reporting an arrival, kept distinct in the envelope because
 * three different outcomes otherwise collapse into `funded: false`: the run never
 * waited, it wanted to but could not read a baseline balance, or it waited and
 * the deadline (or the link's expiry) won. None establishes the payment status;
 * `status` carries what the page reported, when it did.
 */
export type FundPollStatus = 'skipped' | 'unavailable' | 'timed-out' | 'arrived';

/** Where a fund link was asked for, as the fund page is told. */
export type FundSource = 'install' | 'agent' | 'terminal';

export interface FundNeed {
  label: string;
  priceUsd: number;
}

export interface FundOptions extends ResolveWalletProviderOptions {
  /** Optional USD preset forwarded to the checkout. */
  amountUsd?: string;
  /** Skip the browser open (still prints the URL). */
  open?: boolean;
  /** The environment the agent-harness and browser checks read; defaults to the process's. */
  env?: NodeJS.ProcessEnv;
  /** `--no-qr`: no QR code, even where no browser can open. */
  qr?: boolean;
  /** Watch for the payment after issuing the link. Defaults to ON at a TTY, OFF otherwise. */
  wait?: boolean;
  /** `--usdc`: the address and a QR to send USDC to, no checkout. */
  usdc?: boolean;
  /** `--for` and `--price`: the paid call the money is for, shown on the page. */
  forLabel?: string;
  priceUsd?: string;
  /** Overrides the derived source; install passes `install`. */
  source?: FundSource;
  /** The "Add funds to Tenjin" title and balance; install has its own heading. */
  header?: boolean;
  /** Printed after "Stopped watching" on Ctrl-C: install's limits, next step and disclosure. */
  onStopLines?: readonly string[];
  fetchImpl?: typeof fetch;
  openUrl?: typeof openInBrowser;
  deviceName?: () => Promise<string | undefined>;
  /** One key from the person, for the expired link's `r` / `q`; null when nobody can answer. */
  readKey?: (keys: readonly string[]) => Promise<string | null>;
  /** Poll seams so tests never sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  /** Bounds the whole wait, in place of the link's expiry plus its grace. */
  pollTimeoutMs?: number;
  /** The status line's stream behavior, for tests. */
  live?: LiveLine;
  platform?: NodeJS.Platform;
}

interface Issued {
  url: string;
  token?: string;
  expiresAt: number;
  hosted: boolean;
}

export async function runFund(ctx: CommandContext, opts: FundOptions = {}): Promise<CommandResult> {
  const preset = parsePreset(opts.amountUsd);
  const need = parseNeed(opts.forLabel, opts.priceUsd);
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const human = ctx.io.isTTY && !ctx.flags.json;

  const provider = resolveWalletProvider(ctx, opts);
  const desc = await describeWallet(provider);
  const address = checksummed(desc.address);

  const config = await loadRawConfig(ctx.dataDir);
  const settings = resolveSettings({ config, flags: {}, env: process.env });
  const rpcUrl = settings.rpcUrl.value;
  const readBalance = () => balanceOrUndefined(address, rpcUrl);

  // Waiting is an INTERACTIVE posture: a human is standing at the terminal with
  // a browser open. Piped, --json, and MCP runs default to not waiting: the
  // envelope carrying the link is written only after runFund returns, and an
  // agent waits with `tenjin balance --wait` in the background instead.
  const shouldWait = opts.wait ?? ctx.io.isTTY;
  const live = opts.live ?? liveLine(ctx.io.stderr);
  const err = ctx.io.stderr;
  const say = (line = '') => err.write(`${line}\n`);
  const dim = (text: string) => style('dim', text, err);

  if (opts.usdc === true) {
    return fundByUsdc(ctx, { address, readBalance, human, shouldWait, live, say, dim, opts });
  }

  // Read the balance BEFORE minting, every time: it is the baseline the wait
  // and a later `tenjin balance --wait` measure an arrival from, and what the
  // header shows. A slow or failed read only costs those, never the link.
  const startBalance = await withTimeout(readBalance(), BASELINE_TIMEOUT_MS);

  if (human && opts.header !== false) {
    say();
    say(`  ${style('bold', 'Add funds to Tenjin', err)}`);
    say();
    if (startBalance !== undefined) say(`  Balance   ${dollars(startBalance)}`);
  }

  // A PAYMENT ALREADY ON ITS WAY is waited on, never doubled: a rerun while
  // money is landing is exactly how a second top-up happens.
  const prior = await recallLink(ctx.dataDir, address, now());
  const onItsWay =
    prior !== null && now() - prior.issuedAt < DUPLICATE_WINDOW_MS
      ? await paymentOnItsWay(prior, startBalance, opts.fetchImpl)
      : undefined;

  const source: FundSource = opts.source ?? (underAgentHarness(env) ? 'agent' : 'terminal');
  // Unlocked only to mint: waiting on a payment already on its way needs no
  // key, and a fresh link after it expires unlocks then.
  let signer: TenjinSigner | undefined;
  const mint = async (): Promise<Issued> => {
    signer ??= await provider.getSigner();
    const url = await mintLink(ctx, signer, address, {
      ...(preset !== undefined ? { presetAmount: preset } : {}),
      ...(need !== undefined ? { need } : {}),
      source,
      deviceName: await (opts.deviceName ?? readDeviceName)().catch(() => undefined),
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const token = tokenOf(url);
    const hosted = new URL(url).host === COINBASE_CHECKOUT_HOST;
    const issuedAt = now();
    const expiresAt =
      (token !== undefined ? tokenExpiry(token) : undefined) ??
      issuedAt + (hosted ? HOSTED_LIFETIME_MS : LINK_LIFETIME_MS);
    // Every link is remembered, a hosted one too: its starting balance is what
    // a later `tenjin balance --wait` measures an arrival from. Only a Tenjin
    // link has a token, so only it has a status to follow.
    await rememberLink(ctx.dataDir, {
      version: 1,
      address: address.toLowerCase(),
      url,
      ...(token !== undefined ? { token } : {}),
      issuedAt,
      expiresAt,
      ...(startBalance !== undefined ? { startBalanceAtomic: startBalance.toString() } : {}),
    });
    return { url, ...(token !== undefined ? { token } : {}), expiresAt, hosted };
  };

  let link: Issued =
    onItsWay !== undefined
      ? {
          // On its way means it had a token, so it is a Tenjin link with a url.
          url: prior!.url!,
          ...(prior!.token !== undefined ? { token: prior!.token } : {}),
          expiresAt: prior!.expiresAt,
          hosted: false,
        }
      : await mint();

  // The link goes out on EVERY surface and before any waiting: the stdout
  // envelope that also carries it is written only after this function
  // returns. Off a terminal these are write-notices (stderr, no TTY or --json
  // gate); stdout stays exactly one JSON object. The link prints whole on
  // every path: a person who copies it into another browser needs the token
  // in its fragment, which can only fund this wallet and expires with the link.
  if (!human) {
    emitWriteNotice(
      ctx.io,
      `${onItsWay !== undefined ? 'Payment on its way, from' : 'Checkout'}: ${link.url}`,
    );
    emitWriteNotice(
      ctx.io,
      link.hosted
        ? 'The link is single-use, expires in ~5 minutes, and only works in a browser on this machine (it is bound to this network).'
        : 'The link expires in about 10 minutes.',
    );
  }

  // An explicitly requested funding command can open under an agent harness
  // even without a terminal. The opener is resolved by absolute path and
  // ignores BROWSER (lib/open-url.ts), so an agent host cannot route the link
  // into its embedded view.
  const willOpen =
    onItsWay === undefined && opts.open !== false && (ctx.io.isTTY || underAgentHarness(env));
  const show = async (issued: Issued): Promise<boolean> => {
    const browser = browserAvailable(env, opts.platform ?? process.platform);
    const opened = willOpen && browser ? await (opts.openUrl ?? openInBrowser)(issued.url) : false;
    if (!human) return opened;
    if (onItsWay !== undefined) {
      say();
      say('  A payment is already on its way.');
      say(`  ${dim(issued.url)}`);
    } else if (opened) {
      say('  Checkout  opened in your browser');
      say(`            ${dim(issued.url)}`);
    } else if (!willOpen) {
      say('  Checkout  open this link to pay:');
      say(`            ${issued.url}`);
    } else {
      // No browser here (SSH, no display) or it would not open: a phone
      // camera opens the same page, the same flow.
      const qr = opts.qr !== false ? textQrLines(issued.url, err) : [];
      say();
      if (qr.length > 0) {
        say(
          browser
            ? "  Couldn't open a browser. Scan to pay on your phone:"
            : '  No browser on this machine. Scan to pay on your phone:',
        );
        for (const line of qr) say(`  ${line}`);
        say(`  or open  ${issued.url}`);
      } else {
        say(
          browser
            ? "  Couldn't open a browser. Open this link to pay:"
            : '  No browser on this machine. Open this link to pay:',
        );
        say(`  ${issued.url}`);
      }
    }
    say();
    return opened;
  };
  let opened = await show(link);

  let pollStatus: FundPollStatus = 'skipped';
  let end: WatchEnd | undefined;
  if (shouldWait && startBalance === undefined) pollStatus = 'unavailable';
  if (shouldWait && startBalance !== undefined) {
    const stopInterrupt = human ? onInterrupt(live, say, opts.onStopLines) : () => undefined;
    try {
      for (;;) {
        end = await watchFunding({
          startBalance,
          readBalance,
          ...(link.token !== undefined ? { token: link.token } : {}),
          expiresAt: link.expiresAt,
          deadline:
            opts.pollTimeoutMs !== undefined
              ? now() + opts.pollTimeoutMs
              : link.expiresAt + STATUS_GRACE_MS,
          view: 'checkout',
          ...(human ? { live } : {}),
          ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
          ...(opts.pollIntervalMs !== undefined ? { intervalMs: opts.pollIntervalMs } : {}),
          now,
        });
        if (end.kind !== 'expired' || !human) break;
        // AN EXPIRED LINK, at a terminal: say whether money moved, then offer
        // a fresh link. Nothing was charged on it, unless the page could not
        // report (no status), where the payment may still be landing.
        live.warn(
          end.statusKnown
            ? 'The checkout link expired. Nothing was charged.'
            : 'The checkout link expired.',
        );
        if (!end.statusKnown) say('    If you paid, it still lands; `tenjin balance` shows it.');
        const ask = opts.readKey ?? (process.stdin.isTTY ? readKey : undefined);
        if (ask === undefined) break;
        say(`    ${style('bold', 'r', err)} new link    ${style('bold', 'q', err)} stop`);
        const key = await ask(['r', 'q']);
        if (key !== 'r') break;
        say();
        link = await mint();
        opened = await show(link);
      }
    } finally {
      stopInterrupt();
      live.stop();
    }
    pollStatus = end.kind === 'arrived' ? 'arrived' : 'timed-out';
  }

  const arrived = end?.kind === 'arrived' ? end : undefined;
  if (arrived !== undefined) await forgetLink(ctx.dataDir);
  const status: LinkStatus | undefined = end?.status ?? onItsWay;
  const balanceAtomic = arrived?.balance ?? startBalance;
  const amount = preset !== undefined ? String(preset) : SUGGESTED_FUND_USD;
  return {
    data: {
      address,
      checkoutUrl: link.url,
      opened,
      ...(preset !== undefined ? { presetAmount: preset } : {}),
      funded: arrived !== undefined,
      pollStatus,
      ...(status !== undefined ? { status: status.state } : {}),
      ...(onItsWay !== undefined ? { paymentInFlight: true } : {}),
      // The link expired and this round's status read said no payment is on it.
      ...(end?.kind === 'expired' && end.statusKnown ? { nothingCharged: true } : {}),
      source,
      ...(need !== undefined ? { need } : {}),
      nextStep:
        arrived !== undefined
          ? 'Funds confirmed. Continue the original task; funding does not require another restart.'
          : agentNextStep({
              opened,
              amount,
              inFlight: onItsWay !== undefined,
              ...(need ? { need } : {}),
            }),
      ...(balanceAtomic !== undefined ? { balance: toMoney(balanceAtomic.toString()) } : {}),
      ...(arrived !== undefined ? { added: toMoney(arrived.added.toString()) } : {}),
    },
    humanLines: humanEnding(ctx.io, pollStatus, end, arrived?.balance),
  };
}

/** What a person reads last: the balance and what follows. */
function humanEnding(
  io: CommandContext['io'],
  pollStatus: FundPollStatus,
  end: WatchEnd | undefined,
  balance: bigint | undefined,
): string[] {
  if (pollStatus === 'arrived' && balance !== undefined) {
    return [
      '',
      `  Balance   ${paint(io, 'bold', dollars(balance))}`,
      '  You can close the browser tab.',
    ];
  }
  if (pollStatus === 'unavailable') {
    return [
      "  Couldn't read your balance to watch for the payment. The link still works,",
      '  and `tenjin balance` shows the payment once it lands.',
    ];
  }
  if (pollStatus === 'skipped') {
    return ['  `tenjin balance --wait` tells you when the payment lands.'];
  }
  if (end?.kind === 'expired') {
    return ['', '  Run `tenjin fund` for a fresh link when you are ready.'];
  }
  return [
    '',
    "  The payment hasn't reached your balance yet. It still can:",
    '  `tenjin balance --wait` watches for it.',
  ];
}

/**
 * THE AGENT'S NEXT STEP after a link it did not wait on: say what the money is
 * for, wait in the background, carry on when it lands. It never asks the
 * person to come back and type that they are done.
 */
function agentNextStep(o: {
  opened: boolean;
  amount: string;
  inFlight: boolean;
  need?: FundNeed;
}): string {
  const wait =
    'run `tenjin balance --wait` in the background, with the same Tenjin executable and shell as this command (in Claude Code, as a background Bash command, so you are woken when it exits), and continue the task when it exits: exit 0 means the funds arrived, and its output says how much. If it exits without funds, say once that nothing arrived and nothing went wrong, and continue without paid tools.';
  if (o.inFlight) {
    return `A payment for this machine is already on its way, so no second checkout was opened; do not open another. Tell the person in one sentence, then ${wait} Never ask the person to type "done" or to tell you when the money arrives.`;
  }
  const what =
    o.need !== undefined
      ? `what the money is for (${o.need.label}, $${o.need.priceUsd} a call)`
      : 'what the money is for (the paid tool you wanted and its price, if there is one)';
  const where = o.opened
    ? `that checkout is open in their browser with $${o.amount} filled in`
    : `that checkout is ready with $${o.amount} filled in, and show checkoutUrl as a clickable link`;
  return `Tell the person in one or two sentences ${what} and ${where}. Then ${wait} Never ask the person to type "done" or to tell you when they have paid. Ask about adding funds at most once per session: if they decline, carry on without paid tools and do not offer again. Do not open another checkout unless they ask for a new link.`;
}

/**
 * `--usdc`: the address to send USDC to, its safety rule first, and a QR of
 * the plain address. Nothing is minted and no key is unlocked; the wait is
 * the balance alone.
 */
async function fundByUsdc(
  ctx: CommandContext,
  c: {
    address: string;
    readBalance: () => Promise<bigint | undefined>;
    human: boolean;
    shouldWait: boolean;
    live: LiveLine;
    say: (line?: string) => void;
    dim: (text: string) => string;
    opts: FundOptions;
  },
): Promise<CommandResult> {
  const { address, human, say, dim, opts } = c;
  const now = opts.now ?? Date.now;
  const warning = "Only USDC, only on the Base network. Anything else can't be recovered.";
  const check = `starts ${address.slice(0, 6)} · ends ${address.slice(-4)}`;
  // Read the balance BEFORE the handoff, waiting or not: it is what this wait
  // and a later `tenjin balance --wait` measure an arrival from, so a transfer
  // that lands before that wait starts still counts. Bounded off the wait, as
  // for a checkout, so it never holds up the agent's envelope.
  const startBalance = c.shouldWait
    ? await c.readBalance()
    : await withTimeout(c.readBalance(), BASELINE_TIMEOUT_MS);
  // Remembered with no url and no token: `tenjin fund` finds no status to
  // follow, so it never reads this as a checkout on its way. A live checkout
  // link with a token is kept instead: replacing it would hide a card payment
  // still landing from the next `tenjin fund`, which would open a second
  // checkout. Its starting balance drops to this reading when that is lower
  // or it has none (its own read failed, or money was spent since), so
  // `tenjin balance --wait` counts a transfer that lands before it starts,
  // and a card payment still rises above it.
  if (startBalance !== undefined) {
    const prior = await recallLink(ctx.dataDir, address, now());
    if (prior?.token === undefined) {
      const issuedAt = now();
      await rememberLink(ctx.dataDir, {
        version: 1,
        address: address.toLowerCase(),
        issuedAt,
        expiresAt: issuedAt + USDC_WAIT_MS,
        startBalanceAtomic: startBalance.toString(),
      });
    } else if (
      prior.startBalanceAtomic === undefined ||
      startBalance < BigInt(prior.startBalanceAtomic)
    ) {
      await rememberLink(ctx.dataDir, { ...prior, startBalanceAtomic: startBalance.toString() });
    }
  }
  if (human) {
    const err = ctx.io.stderr;
    say();
    say(`  ${style('bold', 'Send USDC to add funds', ctx.io.stderr)}`);
    say();
    say(`  ${style('yellow', warning, err)}`);
    say();
    say(`  ${style('bold', address, err)}`);
    say(`  ${dim(check)}`);
    const qr = opts.qr !== false ? addressQrLines(address, err) : [];
    if (qr.length > 0) {
      say();
      for (const line of qr) say(`  ${line}`);
    }
    say();
  } else {
    emitWriteNotice(ctx.io, `Send USDC to ${address} (${check}).`);
    emitWriteNotice(ctx.io, warning);
  }

  let end: WatchEnd | undefined;
  let pollStatus: FundPollStatus = c.shouldWait ? 'unavailable' : 'skipped';
  if (c.shouldWait && startBalance !== undefined) {
    const stopInterrupt = human ? onInterrupt(c.live, say, opts.onStopLines) : () => undefined;
    try {
      end = await watchFunding({
        startBalance,
        readBalance: c.readBalance,
        deadline: now() + (opts.pollTimeoutMs ?? USDC_WAIT_MS),
        view: 'usdc',
        ...(human ? { live: c.live } : {}),
        ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
        ...(opts.pollIntervalMs !== undefined ? { intervalMs: opts.pollIntervalMs } : {}),
        now,
      });
    } finally {
      stopInterrupt();
      c.live.stop();
    }
    pollStatus = end.kind === 'arrived' ? 'arrived' : 'timed-out';
  }
  const arrived = end?.kind === 'arrived' ? end : undefined;
  if (arrived !== undefined) await forgetLink(ctx.dataDir);
  const balanceAtomic = arrived?.balance ?? startBalance;
  return {
    data: {
      address,
      usdc: true,
      funded: arrived !== undefined,
      pollStatus,
      nextStep:
        arrived !== undefined
          ? 'Funds confirmed. Continue the original task; funding does not require another restart.'
          : `Give the person the address exactly as printed, with the rule "${warning}" Then run \`tenjin balance --wait\` in the background (in Claude Code, as a background Bash command) and continue the task when it exits. Never ask the person to type "done".`,
      ...(balanceAtomic !== undefined ? { balance: toMoney(balanceAtomic.toString()) } : {}),
      ...(arrived !== undefined ? { added: toMoney(arrived.added.toString()) } : {}),
    },
    humanLines:
      arrived !== undefined
        ? ['', `  Balance   ${paint(ctx.io, 'bold', dollars(arrived.balance))}`]
        : pollStatus === 'skipped'
          ? ['  `tenjin balance --wait` says when it arrives.']
          : ['', '  Nothing has arrived yet. `tenjin balance --wait` keeps watching.'],
  };
}

/**
 * The prior link's payment status when it shows money on its way: `paying`,
 * or `paid` with the balance not yet above where it was when that link was
 * issued. Undefined otherwise, when the status cannot be read, or for a hosted
 * link or a `--usdc` handoff, which have no status to read.
 */
async function paymentOnItsWay(
  prior: RememberedLink,
  balance: bigint | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<LinkStatus | undefined> {
  if (prior.token === undefined) return undefined;
  const read = await readLinkStatus(prior.token, {
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  if (!('status' in read) || !inFlight(read.status)) return undefined;
  if (balance !== undefined && prior.startBalanceAtomic !== undefined) {
    return balance > BigInt(prior.startBalanceAtomic) ? undefined : read.status;
  }
  // No balance to compare: only a payment still in progress is certain to be pending.
  return read.status.state === 'paying' ? read.status : undefined;
}

/** POST /api/fund/link with the wallet's SIWX proof: the checkout URL, validated. */
async function mintLink(
  ctx: CommandContext,
  signer: TenjinSigner,
  address: string,
  extra: {
    presetAmount?: number;
    need?: FundNeed;
    source: FundSource;
    deviceName: string | undefined;
    fetchImpl?: typeof fetch;
  },
): Promise<string> {
  const siwxHeader = await buildSiwxHeader(signer, {
    baseUrl: FUND_ORIGIN,
    chainId: SIWX_CHAIN_ID,
  });
  const request: HttpRequestOptions = {
    method: 'POST',
    timeoutMs: ctx.flags.timeout,
    headers: { [SIWX_HEADER]: siwxHeader },
    // `deviceName`, `source` and `need` are display context for the page; a
    // server without them ignores them (its body schema is not strict).
    jsonBody: {
      address,
      ...(extra.presetAmount !== undefined ? { presetAmount: extra.presetAmount } : {}),
      ...(extra.deviceName !== undefined ? { deviceName: extra.deviceName } : {}),
      source: extra.source,
      ...(extra.need !== undefined ? { need: extra.need } : {}),
    },
  };
  const res = await httpRequest(`${FUND_ORIGIN}/api/fund/link`, {
    ...request,
    ...(extra.fetchImpl !== undefined ? { fetchImpl: extra.fetchImpl } : {}),
  });
  if (!res.ok) {
    throw fetchFailureToCliError(res, {
      fix: 'Check your network, then retry.',
    });
  }
  return checkoutUrlFrom(res.status, res.json);
}

/**
 * Is there a browser on this machine a person is sitting at? Not over SSH,
 * and not on a Linux or BSD desktop with no display server.
 */
export function browserAvailable(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const set = (v: string | undefined) => typeof v === 'string' && v.length > 0;
  if (set(env.SSH_CONNECTION) || set(env.SSH_CLIENT) || set(env.SSH_TTY)) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return set(env.DISPLAY) || set(env.WAYLAND_DISPLAY);
}

/**
 * Ctrl-C while watching: clear the status line, say that checkout carries on,
 * print what the caller still owes the person (install's next step), then let
 * the signal end the process as it always did. Returns the remover.
 */
function onInterrupt(
  live: LiveLine,
  say: (line?: string) => void,
  after: readonly string[] = [],
): () => void {
  const handler = () => {
    live.stop();
    say();
    say("  Stopped watching. This doesn't cancel checkout: `tenjin balance` shows the");
    say('  payment once it lands.');
    for (const line of after) say(line);
    process.removeListener('SIGINT', handler);
    process.kill(process.pid, 'SIGINT');
  };
  process.on('SIGINT', handler);
  return () => process.removeListener('SIGINT', handler);
}

/** One key from the terminal, in raw mode; Ctrl-C and Escape read as `q`. */
async function readKey(keys: readonly string[]): Promise<string | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return null;
  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk: Buffer) => {
      const key = chunk.toString('utf8').toLowerCase();
      const answer = key === '\x03' || key === '\x1b' ? 'q' : keys.includes(key) ? key : null;
      if (answer === null) return;
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(answer);
    };
    stdin.on('data', onData);
  });
}

/**
 * The route parses the destination with strict EIP-55 (`checksummedAddress`) but
 * the local wallet store accepts any casing, so an imported or hand-edited wallet
 * file would earn an unactionable 400 on a purely local condition. Normalize here
 * instead, as `send` does for its recipient.
 */
function checksummed(address: string): string {
  if (!isAddress(address, { strict: false })) {
    throw new CliError(
      'USAGE',
      `The active wallet address is not a valid EVM address: ${address}`,
      {
        fix: 'Check the wallet file, or create a fresh wallet with `tenjin wallet create`.',
      },
    );
  }
  return getAddress(address);
}

function parsePreset(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_PRESET_USD) {
    throw new CliError('USAGE', `Amount must be a positive USD number up to ${MAX_PRESET_USD}.`, {
      fix: 'Example: tenjin fund 5',
    });
  }
  return n;
}

/** `--for` and `--price`, together or not at all, within the link route's bounds. */
export function parseNeed(
  label: string | undefined,
  price: string | undefined,
): FundNeed | undefined {
  if (label === undefined && price === undefined) return undefined;
  const example = 'Example: tenjin fund 5 --for "X post read" --price 0.006';
  if (label === undefined || price === undefined) {
    throw new CliError('USAGE', '--for and --price go together.', { fix: example });
  }
  const trimmed = label
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();
  if (trimmed.length === 0 || [...trimmed].length > NEED_LABEL_MAX) {
    throw new CliError('USAGE', `--for takes a label of 1 to ${NEED_LABEL_MAX} characters.`, {
      fix: example,
    });
  }
  const n = Number(price);
  if (
    !/^\d+(\.\d+)?$/.test(price.trim()) ||
    !Number.isFinite(n) ||
    n <= 0 ||
    n > NEED_PRICE_MAX_USD
  ) {
    throw new CliError(
      'USAGE',
      `--price takes the call's price in USD, above 0 and at most ${NEED_PRICE_MAX_USD}.`,
      { fix: example },
    );
  }
  return { label: trimmed, priceUsd: n };
}

/**
 * Map the mint response to either the checkout URL or the coded refusal. The
 * URL is opened by this process, so it is validated as https on one of the two
 * allowed hosts (the Tenjin origin or Coinbase's checkout) before anything else
 * sees it: a compromised or misconfigured server must not be able to steer the
 * user's browser anywhere else.
 */
function checkoutUrlFrom(status: number, json: unknown): string {
  if (status === 200) {
    const url =
      typeof json === 'object' && json !== null ? (json as { url?: unknown }).url : undefined;
    if (typeof url === 'string') {
      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        parsed = undefined;
      }
      if (
        parsed !== undefined &&
        parsed.protocol === 'https:' &&
        ALLOWED_CHECKOUT_HOSTS.includes(parsed.host)
      ) {
        return url;
      }
    }
    throw new CliError(
      'CONTRACT_MISMATCH',
      `The server's checkout URL was missing or not https on ${ALLOWED_CHECKOUT_HOSTS.join(' or ')}; refusing to open it.`,
    );
  }
  const code = errorCode(json);
  if (status === 403 && code === 'region_not_supported') {
    throw new CliError('REFUSED', 'Adding funds is not available in your region yet.');
  }
  // A rejected proof is a local condition ("retry" never fixes it): the signed
  // window is clock-relative, and the domain is always the pinned production origin.
  if (status === 401) {
    throw new CliError('REFUSED', "Your computer's clock is off, so Tenjin could not sign in.", {
      fix: "Set your computer's clock right in its system settings, then run `tenjin fund` again.",
    });
  }
  if (status === 429) {
    throw new CliError('RATE_LIMITED', 'Too many tries. Nothing was charged.', {
      fix: 'Wait a minute and retry.',
    });
  }
  if (status === 503) {
    throw new CliError('API_UNREACHABLE', 'Adding funds is down right now. Nothing was charged.', {
      fix: 'Retry later.',
    });
  }
  throw new CliError(
    'API_UNREACHABLE',
    `The funding endpoint returned ${status}${code !== undefined ? ` (${code})` : ''}.`,
    { fix: 'Retry; if it persists, check the service status.' },
  );
}

/** The `error.code` of the withApi failure envelope, when the server sent one. */
function errorCode(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const err = (json as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

async function balanceOrUndefined(address: string, rpcUrl: string): Promise<bigint | undefined> {
  try {
    return await getUsdcBalance(address as `0x${string}`, rpcUrl);
  } catch {
    return undefined;
  }
}

/** `p`, or undefined once `ms` has passed. */
async function withTimeout<T>(p: Promise<T | undefined>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    timer.unref();
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}
