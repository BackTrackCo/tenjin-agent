import { formatEther, getAddress, isAddress, type Address } from 'viem';
import { SEND_MAX_UNSET } from '../lib/config';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { promptYesNo } from '../lib/prompt';
import { resolveContextSettings } from '../lib/settings';
import {
  broadcastUsdcSend,
  FeeCapExceededError,
  getUsdcBalance,
  prepareUsdcSend,
  SendPendingError,
  SendRevertedError,
  USDC_ADDRESS,
} from '../lib/usdc';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin send <amount> <token> <to>`: the escape hatch that moves funds OUT of
 * the agent wallet, complementary to delegation (which redirects future revenue
 * off the hot key; this is for a balance already on it). Invariants a reader
 * cannot derive from the code order alone:
 *   - the confirm (buy's posture: interactive y/N, `--yes` bypasses the prompt
 *     only, headless without it refuses) runs BEFORE the signer is resolved, so
 *     no refusal branch ever touches key material;
 *   - `sendMaxAmount` is a spend-policy gate, NOT satisfiable by --yes, and it
 *     has NO default: unset refuses until `config set sendMaxAmount` is run
 *     (require-set-before-first-send; "none" is an explicit uncapped opt-in);
 *   - the verb is deliberately absent from the MCP toolset (spec 10's narrow
 *     toolset) and the skill adapters — human-invoked only, both pinned by tests.
 */

export interface SendArgs {
  /** Decimal USD at the edge (O1 convention); converted to atomic exactly once. */
  amount: string;
  token: string;
  /** Recipient address, 0x-prefixed; checksummed or all-lowercase. */
  to: string;
  /** Skip the interactive confirm. REQUIRED to send when not at a TTY. */
  yes?: boolean;
}

export interface SendDeps {
  /** Test seam: bypass the local wallet provider. */
  provider?: WalletProvider;
  /** Interactive-confirm seam; defaults to a TTY y/n prompt (same shape as buy). */
  confirm?: (prompt: string) => Promise<boolean>;
}

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const DEAD_ADDRESS: Address = '0x000000000000000000000000000000000000dEaD';

export async function runSend(
  args: SendArgs,
  ctx: CommandContext,
  deps: SendDeps = {},
): Promise<CommandResult> {
  requireUsdc(args.token);
  const amountAtomic = BigInt(parseUsdToAtomic(args.amount));
  if (amountAtomic === 0n) {
    throw new CliError('USAGE', 'The send amount must be greater than zero.', {
      fix: 'Pass a positive decimal USDC amount, e.g. `tenjin send 5 usdc <to>`.',
    });
  }
  const to = parseRecipient(args.to);

  const provider = await resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  // Address + posture only; surfaces WALLET_MISSING. No key material yet.
  const desc = await describeWallet(provider);
  if (to.toLowerCase() === desc.address.toLowerCase()) {
    throw new CliError('USAGE', 'The recipient is this wallet itself.', {
      fix: 'Pass the destination wallet address, not the sending one.',
    });
  }

  const { rpcUrl, sendMaxAmountAtomic } = await resolveContextSettings(ctx);
  enforceSendCap(amountAtomic, sendMaxAmountAtomic);

  let balance: bigint;
  try {
    balance = await getUsdcBalance(desc.address, rpcUrl);
  } catch (err) {
    throw new CliError('RPC_ERROR', `Could not read the USDC balance from ${rpcUrl}.`, {
      fix: 'Check your network, or set a working RPC with `tenjin config set rpcUrl <url>`.',
      cause: err,
    });
  }
  if (amountAtomic > balance) {
    throw new CliError('REFUSED', 'The amount exceeds the wallet USDC balance.', {
      fix: 'Check `tenjin wallet balance` and send at most that amount.',
      details: {
        requested: toMoney(amountAtomic.toString()),
        balance: toMoney(balance.toString()),
      },
    });
  }

  // Read-only chain prep before the confirm, so the prompt can show the fee and
  // a wallet without gas refuses before asking anyone to approve anything.
  let prepared;
  try {
    prepared = await prepareUsdcSend({ from: desc.address, to, amountAtomic, rpcUrl });
  } catch (err) {
    if (err instanceof FeeCapExceededError) {
      throw new CliError('REFUSED', 'The RPC gas/fee estimate is abnormal for Base; refusing.', {
        fix: 'Check `tenjin config get rpcUrl` points at a trusted Base RPC; if the RPC is fine, Base fees are spiking — wait and retry.',
        cause: err,
      });
    }
    throw new CliError('RPC_ERROR', 'Could not prepare the transfer on Base.', {
      fix: 'Check your network, or set a working RPC with `tenjin config set rpcUrl <url>`.',
      cause: err,
    });
  }
  if (prepared.ethBalanceWei < prepared.feeWei) {
    throw new CliError('REFUSED', 'The wallet has no ETH on Base to pay the network fee.', {
      fix: `Send a little ETH on Base to ${desc.address} (about ${formatEther(prepared.feeWei)} ETH needed), then retry.`,
      details: {
        ethBalanceWei: prepared.ethBalanceWei.toString(),
        feeWei: prepared.feeWei.toString(),
      },
    });
  }

  const approved = await confirmSend(ctx, deps, args.yes === true, {
    amountAtomic,
    to,
    from: desc.address,
    feeWei: prepared.feeWei,
  });
  if (!approved) {
    throw new CliError('REFUSED', 'Send not confirmed.', {
      fix: 'Verify the recipient and amount, then re-run with --yes to approve this transfer.',
      details: { to, amount: toMoney(amountAtomic.toString()) },
    });
  }

  // The only door to the key; a missing passphrase entry refuses here with the
  // provider's coded error. The signer must be the wallet the human just saw:
  // the local provider guarantees it, a hosted one is only trusted after this.
  const signer = await provider.getSigner();
  if (signer.address.toLowerCase() !== desc.address.toLowerCase()) {
    throw new CliError(
      'PROVIDER_ERROR',
      `The signer address ${signer.address} does not match the confirmed wallet ${desc.address}.`,
      { fix: 'The wallet changed between preview and signing; re-run `tenjin send`.' },
    );
  }

  let txHash: string;
  try {
    txHash = await broadcastUsdcSend({ signer, prepared, rpcUrl });
  } catch (err) {
    if (err instanceof SendRevertedError) {
      throw new CliError('SEND_FAILED', 'The transfer was mined but reverted; no USDC moved.', {
        fix: 'Check the transaction on a Base explorer, then retry if the cause is transient.',
        details: { txHash: err.txHash },
        cause: err,
      });
    }
    if (err instanceof SendPendingError) {
      throw new CliError('SEND_FAILED', 'The transfer was broadcast but not confirmed in time.', {
        fix: 'Check the transaction on a Base explorer before retrying: it may still mine, and an immediate retry could double-send.',
        details: { txHash: err.txHash, pending: true },
        cause: err,
      });
    }
    throw new CliError('RPC_ERROR', 'The transfer could not be sent on Base.', {
      fix: 'Check the network and RPC, then retry.',
      cause: err,
    });
  }

  const amount = toMoney(amountAtomic.toString());
  return {
    data: { txHash, from: signer.address, to, token: 'USDC', network: 'base', amount },
    humanLines: [`Sent ${amount.usd} USDC on Base to ${to}`, `Tx: ${txHash}`],
  };
}

/**
 * The hard per-send cap (`config set sendMaxAmount`): a policy gate, not a
 * confirm — no branch here is satisfiable by --yes. There is no default cap:
 * an unset key refuses (require-set-before-first-send), exactly as strict as
 * the set-cap refusals below.
 */
function enforceSendCap(
  amountAtomic: bigint,
  capAtomic: bigint | null | typeof SEND_MAX_UNSET,
): void {
  if (capAtomic === SEND_MAX_UNSET) {
    throw new CliError(
      'POLICY_REFUSED',
      'No sendMaxAmount is configured; a per-send cap must be set before the first send.',
      {
        fix: 'Run `tenjin config set sendMaxAmount <usd>` (or `0` to disable send, or `none` to opt in to uncapped), then retry. --yes does not bypass this.',
      },
    );
  }
  if (capAtomic === null) return;
  if (capAtomic === 0n) {
    throw new CliError('POLICY_REFUSED', 'Sending is disabled by sendMaxAmount = 0.', {
      fix: 'Run `tenjin config set sendMaxAmount <usd|none>` to allow sends.',
    });
  }
  if (amountAtomic > capAtomic) {
    throw new CliError('POLICY_REFUSED', 'The amount exceeds the sendMaxAmount cap.', {
      fix: 'Send a smaller amount, or raise the cap with `tenjin config set sendMaxAmount <usd>`.',
      details: { requested: toMoney(amountAtomic.toString()), cap: toMoney(capAtomic.toString()) },
    });
  }
}

/** USDC on Base only; anything else is a usage error, not a guess. */
function requireUsdc(token: string): void {
  if (token.trim().toLowerCase() === 'usdc') return;
  throw new CliError('USAGE', `Unsupported token: ${JSON.stringify(token)}`, {
    fix: 'Only USDC on Base is supported: `tenjin send <amount> usdc <to>`.',
  });
}

/**
 * Validate and resolve the recipient. Strict `isAddress` refuses malformed input
 * and a bad EIP-55 checksum on MIXED-CASE input (all-lowercase input carries no
 * checksum to verify — that limit is inherent to the format); `getAddress` then
 * yields the checksummed form the preview shows and the transfer targets. Known
 * fund-destroying destinations (the USDC contract, the zero address, the burn
 * address) refuse outright.
 */
function parseRecipient(raw: string): Address {
  const trimmed = raw.trim();
  if (!isAddress(trimmed)) {
    throw new CliError('USAGE', `Invalid recipient address: ${JSON.stringify(raw)}`, {
      fix: 'Pass a 0x-prefixed 20-byte address, checksummed or all-lowercase (lowercase skips the checksum typo check).',
    });
  }
  const to = getAddress(trimmed);
  if (to === USDC_ADDRESS || to === ZERO_ADDRESS || to === DEAD_ADDRESS) {
    throw new CliError('USAGE', 'The recipient is a known fund-destroying address.', {
      fix: 'Tokens sent to the token contract, the zero address, or the burn address are unrecoverable. Pass the destination wallet address.',
    });
  }
  return to;
}

interface ConfirmDetails {
  amountAtomic: bigint;
  to: Address;
  from: Address;
  feeWei: bigint;
}

/** Buy's confirm posture; the preview names the resolved recipient, amount, and fee. */
async function confirmSend(
  ctx: CommandContext,
  deps: SendDeps,
  yes: boolean,
  d: ConfirmDetails,
): Promise<boolean> {
  if (yes) return true;
  const prompt =
    `Send ${toMoney(d.amountAtomic.toString()).usd} USDC on Base\n` +
    `  from ${d.from}\n` +
    `  to   ${d.to}\n` +
    `  network fee up to ~${formatEther(d.feeWei)} ETH\n` +
    `This moves funds out of the agent wallet and cannot be undone. [y/N] `;
  if (deps.confirm !== undefined) return deps.confirm(prompt);
  // Both streams must be real TTYs; piped stdin/stdout without --yes refuses.
  if (!ctx.io.isTTY || !process.stdin.isTTY) return false;
  return promptYesNo(prompt);
}
