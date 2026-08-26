import { getAddress, isAddress } from 'viem';
import { CliError } from '../lib/errors';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { httpRequest, fetchFailureToCliError, type HttpRequestOptions } from '../lib/http';
import { buildSiwxHeader, SIWX_HEADER } from '../lib/siwx';
import { SESSION_CHAIN_ID } from '../lib/session-key';
import {
  describeWallet,
  resolveWalletProvider,
  type ResolveWalletProviderOptions,
} from '../lib/wallet';
import { getUsdcBalance } from '../lib/usdc';
import { toMoney } from '../lib/money';
import { emitNotice, emitWriteNotice } from '../lib/output';
import { openInBrowser } from '../lib/open-url';
import { PRODUCTION_ORIGIN } from '../lib/production-origin';
import type { CommandContext, CommandResult } from '../context';

/*
 * `tenjin wallet fund`: card-fund THIS wallet via Coinbase Onramp. The CLI signs a
 * SIWX proof with the wallet's own key and asks the Tenjin backend to mint a
 * Coinbase-hosted checkout URL for that same address (the server refuses any
 * other address, per Coinbase's onboarding-verified auth model). The money
 * moves entirely on Coinbase's side; the minted session grants no spending
 * power over the wallet. Two Coinbase properties shape the UX here: the URL is
 * single-use and expires in ~5 minutes (mint fresh per run, open immediately,
 * never persist), and it is bound to this machine's public IP at mint time, so
 * it must be opened in a browser on this machine/network.
 */

/** The only host a minted checkout URL may point at; anything else is refused unopened. */
const CHECKOUT_HOST = 'pay.coinbase.com';
/**
 * fund talks to production, full stop (owner decision, 2026-08-12): the mint
 * signs with the wallet key, so this path takes no override -- not `--base-url`,
 * not the env, not config. Cutting the surface entirely is what lets the verb
 * sit in the free allowlist tier with nothing to caveat.
 */
const FUND_ORIGIN = PRODUCTION_ORIGIN;
/** Matches the server's presetAmount bound (app/api/cdp/session bodySchema). */
const MAX_PRESET_USD = 100_000;
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 600_000;

/**
 * Why the run is not reporting an arrival, kept distinct in the envelope because
 * three different outcomes otherwise collapse into `funded: false`: the run never
 * waited, it wanted to but could not read a baseline balance, or it waited and
 * the deadline won. Only `timed-out` says anything about the purchase.
 */
export type FundPollStatus = 'skipped' | 'unavailable' | 'timed-out' | 'arrived';

export interface FundOptions extends ResolveWalletProviderOptions {
  /** Optional USD preset forwarded to Coinbase (clamped upward to its own floor there). */
  amountUsd?: string;
  /** Skip the browser open (still prints the URL). */
  open?: boolean;
  /** Poll the balance after issuing the link. Defaults to ON at a TTY, OFF otherwise. */
  wait?: boolean;
  fetchImpl?: typeof fetch;
  openUrl?: typeof openInBrowser;
  /** Poll seams so tests never sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export async function runFund(ctx: CommandContext, opts: FundOptions = {}): Promise<CommandResult> {
  const preset = parsePreset(opts.amountUsd);

  const provider = resolveWalletProvider(ctx, opts);
  const desc = await describeWallet(provider);
  const address = checksummed(desc.address);
  const signer = await provider.getSigner();

  const config = await loadRawConfig(ctx.dataDir);
  const settings = resolveSettings({ config, flags: {}, env: process.env });
  const baseUrl = FUND_ORIGIN;
  const rpcUrl = settings.rpcUrl.value;

  // Waiting is an INTERACTIVE posture: a human is standing at the terminal with
  // a browser open. Piped, --json, and MCP runs default to not waiting, because
  // the envelope carrying the link is written only after runFund returns, and a
  // link that expires in ~5 minutes is worthless after a 10-minute poll.
  const shouldWait = opts.wait ?? ctx.io.isTTY;

  // Read the balance BEFORE minting so the poll has a baseline; an RPC flake
  // here only disables the wait, it never blocks funding.
  const startBalance = shouldWait ? await balanceOrUndefined(desc, rpcUrl) : undefined;

  const siwxHeader = await buildSiwxHeader(signer, { baseUrl, chainId: SESSION_CHAIN_ID });
  const request: HttpRequestOptions = {
    method: 'POST',
    timeoutMs: ctx.flags.timeout,
    headers: { [SIWX_HEADER]: siwxHeader },
    jsonBody: {
      mode: 'onramp',
      address,
      ...(preset !== undefined ? { presetAmount: preset } : {}),
    },
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  };
  const res = await httpRequest(`${baseUrl}/api/cdp/session`, request);
  if (!res.ok) {
    throw fetchFailureToCliError(res, {
      fix: 'Check your network, then retry.',
    });
  }
  const url = checkoutUrlFrom(res.status, res.json);

  // The link goes out on EVERY surface and before any waiting: it is single-use
  // with a ~5 minute expiry, and the stdout envelope that also carries it is
  // written only after this function returns. A piped or agent-driven run is
  // exactly the case that must not get the link after it has died, so these
  // three lines are write-notices (stderr, no TTY gate, no --json gate) rather
  // than human-mode notices. stdout stays exactly one JSON object.
  emitWriteNotice(ctx.io, `Coinbase Onramp checkout for ${address}:`);
  emitWriteNotice(ctx.io, `  ${url}`);
  emitWriteNotice(
    ctx.io,
    'The link is single-use, expires in ~5 minutes, and only works in a browser on this machine (it is bound to this network). A Coinbase account is required.',
  );

  let opened = false;
  if (opts.open !== false && ctx.io.isTTY) {
    opened = await (opts.openUrl ?? openInBrowser)(url);
    emitNotice(
      ctx.io,
      opened ? 'Opened in your default browser.' : 'Could not open a browser; use the link above.',
      { json: ctx.flags.json },
    );
  }

  const funded =
    shouldWait && startBalance !== undefined
      ? await pollForFunds(ctx, desc, rpcUrl, startBalance, opts)
      : undefined;
  if (funded !== undefined) {
    emitWriteNotice(ctx.io, 'USDC arrived - you can close the checkout tab.');
  }
  const pollStatus: FundPollStatus = !shouldWait
    ? 'skipped'
    : startBalance === undefined
      ? 'unavailable'
      : funded !== undefined
        ? 'arrived'
        : 'timed-out';

  const balanceAtomic = funded ?? startBalance;
  return {
    data: {
      address,
      checkoutUrl: url,
      opened,
      ...(preset !== undefined ? { presetAmount: preset } : {}),
      funded: funded !== undefined,
      pollStatus,
      ...(balanceAtomic !== undefined ? { balance: toMoney(balanceAtomic.toString()) } : {}),
    },
    humanLines:
      funded !== undefined
        ? [`Funded: balance is now ${toMoney(funded.toString()).usd} USDC on Base.`]
        : [
            'Checkout link issued (printed above).',
            ...(pollStatus === 'unavailable'
              ? ['Could not read the balance to wait on it; the link is unaffected.']
              : []),
            'Confirm arrival later with `tenjin wallet balance`.',
          ],
  };
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
      fix: 'Example: tenjin wallet fund 5',
    });
  }
  return n;
}

/**
 * Map the mint response to either the checkout URL or the coded refusal. The
 * URL is opened by this process, so it is validated as https on Coinbase's
 * checkout host before anything else sees it: a compromised or misconfigured
 * server must not be able to steer the user's browser anywhere else.
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
      if (parsed !== undefined && parsed.protocol === 'https:' && parsed.host === CHECKOUT_HOST) {
        return url;
      }
    }
    throw new CliError(
      'CONTRACT_MISMATCH',
      `The server's checkout URL was missing or not https://${CHECKOUT_HOST}; refusing to open it.`,
    );
  }
  const code = errorCode(json);
  if (status === 403 && code === 'region_not_supported') {
    throw new CliError('REFUSED', 'Coinbase Onramp is not available in your region.');
  }
  // A rejected proof is a local condition ("retry" never fixes it): the signed
  // window is clock-relative, and the domain is always the pinned production origin.
  if (status === 401) {
    throw new CliError('REFUSED', 'The funding endpoint rejected the signed proof.', {
      fix: 'Check this machine’s clock, then retry.',
    });
  }
  if (status === 429) {
    throw new CliError('RATE_LIMITED', 'The funding endpoint is rate limited right now.', {
      fix: 'Wait a minute and retry.',
    });
  }
  if (status === 503) {
    throw new CliError(
      'API_UNREACHABLE',
      'Production has no Coinbase Onramp configured right now.',
      {
        fix: 'Retry later.',
      },
    );
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

async function balanceOrUndefined(
  desc: { address: string },
  rpcUrl: string,
): Promise<bigint | undefined> {
  try {
    return await getUsdcBalance(desc.address as `0x${string}`, rpcUrl);
  } catch {
    return undefined;
  }
}

/**
 * Wait for the purchased USDC to land: any balance above the pre-mint baseline
 * counts (Coinbase clamps presets, so an exact-amount check would be wrong).
 * RPC flakes mid-poll are tolerated; the deadline is the only exit besides
 * arrival, and timing out is a normal outcome (the human may still be paying),
 * not an error.
 */
async function pollForFunds(
  ctx: CommandContext,
  desc: { address: string },
  rpcUrl: string,
  startBalance: bigint,
  opts: FundOptions,
): Promise<bigint | undefined> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts.pollTimeoutMs ?? POLL_TIMEOUT_MS);
  emitNotice(ctx.io, 'Waiting for the USDC to arrive (Ctrl-C is safe; the purchase is not).', {
    json: ctx.flags.json,
  });
  while (Date.now() < deadline) {
    await sleep(interval);
    const balance = await balanceOrUndefined(desc, rpcUrl);
    if (balance !== undefined && balance > startBalance) return balance;
  }
  return undefined;
}
