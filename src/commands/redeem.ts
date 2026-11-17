import { copyText as copyToClipboard } from '../lib/clipboard';
import { CliError } from '../lib/errors';
import {
  pollForToken,
  requestDeviceCode,
  validClientId,
  type DeviceFlowOptions,
} from '../lib/github-device';
import { httpRequest } from '../lib/http';
import { liveLine, type LiveLine } from '../lib/live-line';
import { machineHash as readMachineHash } from '../lib/machine-id';
import { toMoney } from '../lib/money';
import { openInBrowser } from '../lib/open-url';
import { paint, sanitizeForTerminal, style } from '../lib/output';
import { underAgentHarness } from '../lib/session';
import { buildSiwxHeader, SIWX_CHAIN_ID, SIWX_HEADER } from '../lib/siwx';
import {
  resolveWalletProvider,
  type ResolveWalletProviderOptions,
  type TenjinSigner,
} from '../lib/wallet';
import { balanceReader } from './balance';
import {
  BALANCE_WAIT_STEP,
  browserAvailable,
  checksummed,
  FUND_ORIGIN,
  runFund,
  withTimeout,
} from './fund';
import { dollars, rememberStartBalance } from './fund-watch';
import type { CommandContext, CommandResult } from '../context';

/*
 * `tenjin redeem <code>`: an event or promo code puts USDC straight into THIS
 * wallet, paid from a Tenjin treasury. The CLI signs the same SIWX proof
 * `tenjin fund` does, pinned to production with no override, and the server
 * credits only the signing wallet. No money leaves the wallet.
 *
 * Two kinds of code. A single-use table code just redeems. A shared event
 * code is one per person and one per computer: the server answers
 * `promo_github_required`, and at a terminal the CLI runs GitHub's device
 * flow and asks again with the token. Off a terminal (an agent, a pipe,
 * --json) nobody can relay a device code from a command that blocks, so the
 * CLI opens the fund page in redeem mode instead and the page signs in with
 * GitHub in the browser.
 *
 * Every refusal the server words itself (`promo_*`) is printed as it sent it,
 * so a new code can say its own thing without a CLI release.
 */

/** A code, as the person types it: letters, digits, dashes and underscores. */
const CODE_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;
/** The server waits up to ~10 s for the transfer's receipt; give it room. */
const REDEEM_TIMEOUT_MS = 30_000;
/** How long the balance read before a redeem may take. */
const BASELINE_TIMEOUT_MS = 4_000;
/** How long to watch for a transfer the server has not yet seen land. */
const WATCH_MS = 60_000;
const WATCH_INTERVAL_MS = 3_000;
/** How long `tenjin balance --wait` may count a credit still on its way from this baseline. */
const ON_ITS_WAY_MS = 15 * 60_000;
/** The longest server message printed; past it the text is cut. */
const MESSAGE_MAX = 300;

export interface RedeemOptions extends ResolveWalletProviderOptions {
  code: string;
  /** The environment the agent-harness and browser checks read; defaults to the process's. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  openUrl?: typeof openInBrowser;
  copyText?: (text: string) => Promise<boolean>;
  machineHash?: () => Promise<string | undefined>;
  /** Forwarded to the fund link off a terminal. */
  deviceName?: () => Promise<string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  live?: LiveLine;
  /** Bounds the balance watch for a transfer still on its way. */
  watchMs?: number;
  intervalMs?: number;
}

interface Redeemed {
  address: string;
  code: string;
  amountAtomic: bigint;
  txHash: string;
  confirmed: boolean;
  balanceAtomic?: bigint;
  /** This wallet had redeemed the code before: the server told it again. */
  replayed: boolean;
}

/** `lost`: no answer, or a failure with no word from Tenjin on the code: it may have gone through. */
type Answer =
  | { kind: 'redeemed'; redeemed: Redeemed }
  | { kind: 'github'; clientId: string }
  | { kind: 'lost' };

/**
 * Asks after a lost answer. Safe because the server is idempotent per wallet:
 * asking again returns this wallet's redemption, never a second payment.
 */
const ASK_ATTEMPTS = 3;
const ASK_BACKOFF_MS = 2_000;

export async function runRedeem(ctx: CommandContext, opts: RedeemOptions): Promise<CommandResult> {
  const code = parseCode(opts.code);
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // A person at a terminal can carry a GitHub code to a browser and back; an
  // agent's shell, a pipe or --json cannot, so those hand off to the page.
  const human = ctx.io.isTTY && !ctx.flags.json && !underAgentHarness(env);
  const err = ctx.io.stderr;
  const say = (line = '') => err.write(`${line}\n`);
  const live = opts.live ?? liveLine(err);

  if (human) {
    say();
    say(`  ${style('bold', `Redeem ${code.toUpperCase()}`, err)}`);
    say();
  }

  const provider = resolveWalletProvider(ctx, opts);
  const reader = await balanceReader(ctx, { ...opts, provider });
  const address = checksummed(reader.address);
  const readBalance = () => reader.read().catch(() => undefined);
  // Read BEFORE asking: a transfer the server has not seen land is measured
  // from here, and one that lands quickly must not be in the baseline.
  const baseline = withTimeout(readBalance(), BASELINE_TIMEOUT_MS);
  const signer = await provider.getSigner();
  const machineHash = await (opts.machineHash ?? readMachineHash)().catch(() => undefined);
  const startBalance = await baseline;

  // Set once an answer was lost: a later "already redeemed for this wallet" is then
  // this run's own redemption arriving, not one from before.
  let askedAgain = false;
  const ask = async (githubToken?: string): Promise<Exclude<Answer, { kind: 'lost' }>> => {
    if (human) live.spin('Redeeming…');
    try {
      for (let attempt = 1; ; attempt++) {
        const answer = await redeemRequest(ctx, signer, {
          address,
          code,
          ...(machineHash !== undefined ? { machineHash } : {}),
          ...(githubToken !== undefined ? { githubToken } : {}),
          ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
        });
        if (answer.kind !== 'lost') return answer;
        if (attempt >= ASK_ATTEMPTS) {
          throw new CliError(
            'NETWORK_ERROR',
            "Couldn't hear back from Tenjin, so the code may have gone through.",
            {
              fix: `Run \`tenjin balance\` in a minute. Running \`tenjin redeem ${code}\` again is safe: it never pays twice.`,
            },
          );
        }
        askedAgain = true;
        await sleep(ASK_BACKOFF_MS * attempt);
      }
    } finally {
      live.stop();
    }
  };

  let answer = await ask();
  if (answer.kind === 'github') {
    if (!human) {
      return handToFundPage(ctx, code, { ...opts, provider, machineHash: async () => machineHash });
    }
    const flow: DeviceFlowOptions = {
      sleep,
      now,
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    };
    // The token lives in this call alone: sent once, never stored or printed.
    answer = await ask(
      await githubSignIn(code, answer.clientId, { env, opts, flow, live, say, err }),
    );
    if (answer.kind === 'github') {
      throw new CliError('REFUSED', 'GitHub sign-in did not go through. Nothing was redeemed.', {
        fix: `Run \`tenjin redeem ${code}\` again.`,
      });
    }
  }

  const redeemed = answer.redeemed;
  const amount = redeemed.amountAtomic;
  let balance = redeemed.confirmed ? redeemed.balanceAtomic : undefined;
  let landed = redeemed.confirmed;
  if (!landed && startBalance !== undefined) {
    // On its way: watch the balance until it rises by the credit.
    const stop = human
      ? onInterrupt(live, say, [
          `  Stopped watching. ${dollars(amount)} is still on its way: \`tenjin balance\` shows it.`,
        ])
      : () => undefined;
    try {
      const deadline = now() + (opts.watchMs ?? WATCH_MS);
      for (;;) {
        if (human) live.spin(`Adding ${dollars(amount)}…`);
        const read = await readBalance();
        if (read !== undefined && read - startBalance >= amount) {
          balance = read;
          landed = true;
          break;
        }
        if (now() >= deadline) break;
        await sleep(opts.intervalMs ?? WATCH_INTERVAL_MS);
      }
    } finally {
      stop();
      live.stop();
    }
  }
  if (!landed && startBalance !== undefined) {
    // `tenjin balance --wait` then counts the credit even if it lands before that wait starts.
    await rememberStartBalance(ctx.dataDir, address, startBalance, now(), ON_ITS_WAY_MS);
  }
  // Redeemed on an earlier run: nothing new was added this time.
  const earlier = redeemed.replayed && !askedAgain;
  if (landed && human) {
    live.ok(
      earlier
        ? `Already redeemed: ${dollars(amount)} from ${redeemed.code} went to this wallet`
        : `${dollars(amount)} added`,
    );
  }

  return {
    data: {
      address,
      code: redeemed.code,
      ...(earlier ? { alreadyRedeemed: true } : {}),
      added: toMoney(amount.toString()),
      ...(balance !== undefined ? { balance: toMoney(balance.toString()) } : {}),
      txHash: redeemed.txHash,
      // True once the credit is in the balance: the server saw it land, or this run did.
      confirmed: landed,
      nextStep: landed
        ? `${dollars(amount)} from the code is in the balance. Continue the original task.`
        : `${dollars(amount)} from the code is on its way to the wallet. Tell the person in one sentence, then ${BALANCE_WAIT_STEP}`,
    },
    humanLines: landed
      ? balance !== undefined
        ? [`  Balance   ${paint(ctx.io, 'bold', dollars(balance))}`]
        : []
      : [`  ${dollars(amount)} is on its way. \`tenjin balance\` shows it once it lands.`],
  };
}

/**
 * Off a terminal, a code that needs GitHub: the fund page, opened in redeem
 * mode with the code filled in, signs in with GitHub in the browser. The agent
 * then waits with `tenjin balance --wait`, as it does after checkout.
 */
async function handToFundPage(
  ctx: CommandContext,
  code: string,
  opts: RedeemOptions,
): Promise<CommandResult> {
  const funded = await runFund(ctx, {
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.passphrase !== undefined ? { passphrase: opts.passphrase } : {}),
    ...(opts.onWarning !== undefined ? { onWarning: opts.onWarning } : {}),
    code,
    wait: false,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.openUrl !== undefined ? { openUrl: opts.openUrl } : {}),
    ...(opts.deviceName !== undefined ? { deviceName: opts.deviceName } : {}),
    ...(opts.machineHash !== undefined ? { machineHash: opts.machineHash } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const data = funded.data as Record<string, unknown>;
  const where =
    data.opened === true
      ? `The fund page is open in the person's browser to finish redeeming ${code} with a GitHub sign-in. Tell them in one sentence.`
      : `The fund page is ready to finish redeeming ${code} with a GitHub sign-in. Tell them in one sentence and show checkoutUrl as a clickable link.`;
  return {
    data: {
      ...data,
      code,
      redeem: 'browser',
      nextStep: `${where} Then ${BALANCE_WAIT_STEP} Never ask the person to type "done" or to tell you when they have signed in.`,
    },
    humanLines: ['  Finish in the browser. `tenjin balance --wait` tells you when it lands.'],
  };
}

/**
 * At a terminal: GitHub's device flow, the code copied and the page opened,
 * then a live line until GitHub answers. Ctrl-C here redeems nothing.
 */
async function githubSignIn(
  code: string,
  clientId: string,
  c: {
    env: NodeJS.ProcessEnv;
    opts: RedeemOptions;
    flow: DeviceFlowOptions;
    live: LiveLine;
    say: (line?: string) => void;
    err: NodeJS.WritableStream;
  },
): Promise<string> {
  const { opts, live, say } = c;
  const again = `Run \`tenjin redeem ${code}\` again.`;
  say("  This code is one per person, so GitHub confirms it's you.");
  say('  Tenjin sees only your public profile.');
  say();
  const device = await requestDeviceCode(clientId, c.flow);
  if (!device.ok) {
    if (device.reason === 'network') {
      throw new CliError(
        'NETWORK_ERROR',
        "Couldn't reach GitHub to sign in. Nothing was redeemed.",
        {
          fix: `Check your network, then run \`tenjin redeem ${code}\` again.`,
        },
      );
    }
    if (device.reason === 'malformed') {
      throw new CliError(
        'CONTRACT_MISMATCH',
        "GitHub's sign-in answer was not a device code on https://github.com, so it was not opened. Nothing was redeemed.",
      );
    }
    throw new CliError(
      'API_UNREACHABLE',
      `GitHub refused the sign-in (${device.detail ?? 'no reason given'}). Nothing was redeemed.`,
      { fix: 'Retry later.' },
    );
  }
  const { userCode, verificationUri } = device.code;
  const copied = await (opts.copyText ?? copyToClipboard)(userCode).catch(() => false);
  const browser = browserAvailable(c.env, opts.platform ?? process.platform);
  const opened = browser ? await (opts.openUrl ?? openInBrowser)(verificationUri) : false;
  const page = new URL(verificationUri);
  const where = `${page.host}${page.pathname}`;
  // The labels line up with `tenjin fund`'s: a 10-column label, then the value.
  say(
    `  Code      ${style('bold', userCode, c.err)}${copied ? `  ${style('dim', 'copied', c.err)}` : ''}`,
  );
  if (opened) {
    say('  GitHub    opened in your browser: paste the code, then Authorize');
    say(`            ${style('dim', where, c.err)}`);
  } else {
    say(`  GitHub    open ${where} and enter the code`);
  }
  say();

  const stop = onInterrupt(live, say, ['  Stopped. Nothing was redeemed.']);
  let result: Awaited<ReturnType<typeof pollForToken>>;
  try {
    live.spin('Waiting for GitHub…');
    result = await pollForToken(clientId, device.code, c.flow);
  } finally {
    stop();
    live.stop();
  }
  if (result.ok) {
    live.ok('GitHub confirmed');
    return result.token;
  }
  if (result.reason === 'expired') {
    throw new CliError('REFUSED', 'The GitHub code expired. Nothing was redeemed.', {
      fix: `Run \`tenjin redeem ${code}\` again for a fresh one.`,
    });
  }
  if (result.reason === 'denied') {
    throw new CliError('REFUSED', 'GitHub sign-in was cancelled. Nothing was redeemed.', {
      fix: again,
    });
  }
  if (result.reason === 'network') {
    throw new CliError(
      'NETWORK_ERROR',
      'Lost touch with GitHub while waiting for the sign-in. Nothing was redeemed.',
      { fix: `Check your network, then run \`tenjin redeem ${code}\` again.` },
    );
  }
  throw new CliError(
    'API_UNREACHABLE',
    `GitHub refused the sign-in (${result.detail ?? 'no reason given'}). Nothing was redeemed.`,
    { fix: again },
  );
}

/** POST /api/promo/redeem with the wallet's SIWX proof: the credit, or GitHub needed. */
async function redeemRequest(
  ctx: CommandContext,
  signer: TenjinSigner,
  body: {
    address: string;
    code: string;
    machineHash?: string;
    githubToken?: string;
    fetchImpl?: typeof fetch;
  },
): Promise<Answer> {
  // A fresh proof every ask: its nonce is single-use.
  const siwxHeader = await buildSiwxHeader(signer, {
    baseUrl: FUND_ORIGIN,
    chainId: SIWX_CHAIN_ID,
  });
  const { fetchImpl, ...jsonBody } = body;
  const res = await httpRequest(`${FUND_ORIGIN}/api/promo/redeem`, {
    method: 'POST',
    timeoutMs: Math.max(ctx.flags.timeout, REDEEM_TIMEOUT_MS),
    headers: { [SIWX_HEADER]: siwxHeader },
    jsonBody,
    ...(fetchImpl !== undefined ? { fetchImpl } : {}),
  });
  // No answer, or a server failure that says nothing about the code: the request
  // may have redeemed it, so the caller asks again rather than calling it refused.
  if (!res.ok) return { kind: 'lost' };
  if (res.status === 200) {
    return { kind: 'redeemed', redeemed: redeemedFrom(res.json, body.address, body.code) };
  }
  const envelope = errorEnvelope(res.json);
  if (res.status >= 500 && envelope.code?.startsWith('promo_') !== true) return { kind: 'lost' };
  if (res.status === 403 && envelope.code === 'promo_github_required') {
    const clientId = envelope.details?.clientId;
    if (!validClientId(clientId)) {
      throw new CliError(
        'CONTRACT_MISMATCH',
        'Tenjin asked for a GitHub sign-in but named no GitHub app to sign in with.',
      );
    }
    return { kind: 'github', clientId };
  }
  throw redeemRefusal(res.status, envelope, body.code);
}

/**
 * A refusal, mapped to the house codes. A `promo_*` code prints the server's
 * own message, as sent; anything else is worded here.
 */
function redeemRefusal(status: number, envelope: ErrorEnvelope, code: string): CliError {
  const again = `Run \`tenjin redeem ${code}\` again.`;
  if (envelope.code?.startsWith('promo_') === true) {
    const message =
      envelope.message ??
      `Tenjin couldn't redeem this code (${envelope.code}). Nothing was redeemed.`;
    const details = { reason: envelope.code };
    if (envelope.code === 'promo_github_invalid') {
      return new CliError('REFUSED', message, { fix: again, details });
    }
    if (envelope.code === 'promo_github_unreachable') {
      return new CliError('API_UNREACHABLE', message, {
        fix: 'Wait a minute, then retry.',
        details,
      });
    }
    // The code is spent and the transfer may still land: a rerun only hears
    // "already redeemed", so the way to know is the balance.
    if (envelope.code === 'promo_unconfirmed') {
      return new CliError('API_UNREACHABLE', message, {
        fix: 'Run `tenjin balance` in a few minutes to see whether it arrived.',
        details,
      });
    }
    if (envelope.code === 'promo_unavailable' || status >= 500) {
      return new CliError('API_UNREACHABLE', message, { fix: 'Retry later.', details });
    }
    // A rule refusal: a code that does not exist, is not open, is used up,
    // or was already redeemed. A retry changes nothing, so there is no fix.
    return new CliError('REFUSED', message, { details });
  }
  // A rejected proof is a local condition, as for `tenjin fund`: the signed
  // window is clock-relative, and the domain is always the pinned origin.
  if (status === 401) {
    return new CliError('REFUSED', "Your computer's clock is off, so Tenjin could not sign in.", {
      fix: `Set your computer's clock right in its system settings, then run \`tenjin redeem ${code}\` again.`,
    });
  }
  if (status === 429) {
    return new CliError('RATE_LIMITED', 'Too many tries. Nothing was redeemed.', {
      fix: 'Wait a minute and retry.',
    });
  }
  return new CliError(
    'API_UNREACHABLE',
    `The redeem endpoint returned ${status}${envelope.code !== undefined ? ` (${envelope.code})` : ''}. Nothing was redeemed.`,
    { fix: 'Retry; if it persists, check the service status.' },
  );
}

/**
 * The 200 body, checked: the credit must be for this wallet, in atomic USDC,
 * with a transaction hash. Money may have moved even when it is malformed, so
 * the refusal says where to look rather than to retry.
 */
function redeemedFrom(json: unknown, address: string, sent: string): Redeemed {
  const body = record(json);
  // The code as the server normalized it, for display; the one sent otherwise.
  const named =
    typeof body?.code === 'string' ? sanitizeForTerminal(body.code).trim().slice(0, 64) : '';
  const atomic = (v: unknown) => typeof v === 'string' && /^\d{1,30}$/.test(v);
  if (
    body !== undefined &&
    typeof body.address === 'string' &&
    body.address.toLowerCase() === address.toLowerCase() &&
    atomic(body.amountAtomic) &&
    typeof body.txHash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(body.txHash) &&
    typeof body.confirmed === 'boolean' &&
    (body.balanceAtomic === undefined || atomic(body.balanceAtomic))
  ) {
    return {
      address,
      code: named.length > 0 ? named : sent,
      amountAtomic: BigInt(body.amountAtomic as string),
      txHash: body.txHash,
      confirmed: body.confirmed,
      replayed: body.replayed === true,
      ...(body.balanceAtomic !== undefined
        ? { balanceAtomic: BigInt(body.balanceAtomic as string) }
        : {}),
    };
  }
  throw new CliError(
    'CONTRACT_MISMATCH',
    "Tenjin's answer to the redeem was not the expected shape, or not for this wallet.",
    { fix: 'Run `tenjin balance` to see whether the credit arrived.' },
  );
}

interface ErrorEnvelope {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/** The withApi failure envelope's code, its message made safe for a terminal, and its details. */
function errorEnvelope(json: unknown): ErrorEnvelope {
  const error = record(record(json)?.error);
  if (error === undefined) return {};
  const message =
    typeof error.message === 'string' ? sanitizeForTerminal(error.message).trim() : '';
  const details = record(error.details);
  return {
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(message.length > 0 ? { message: [...message].slice(0, MESSAGE_MAX).join('') } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function record(json: unknown): Record<string, unknown> | undefined {
  return typeof json === 'object' && json !== null && !Array.isArray(json)
    ? (json as Record<string, unknown>)
    : undefined;
}

function parseCode(raw: string): string {
  const code = raw.trim();
  if (!CODE_SHAPE.test(code)) {
    throw new CliError('USAGE', 'A code is letters, digits and dashes, up to 64 characters.', {
      fix: 'Example: tenjin redeem NCSTATE26',
    });
  }
  return code;
}

/**
 * Ctrl-C while waiting: clear the status line, say what that means, then let
 * the signal end the process as it always did. Returns the remover.
 */
function onInterrupt(live: LiveLine, say: (line?: string) => void, lines: string[]): () => void {
  const handler = () => {
    live.stop();
    say();
    for (const line of lines) say(line);
    process.removeListener('SIGINT', handler);
    process.kill(process.pid, 'SIGINT');
  };
  process.on('SIGINT', handler);
  return () => process.removeListener('SIGINT', handler);
}
