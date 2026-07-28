import { createInterface } from 'node:readline';
import { getAddress, isAddress, type Address } from 'viem';
import { CliError } from '../lib/errors';
import { parseUsdToAtomic, toMoney } from '../lib/money';
import { resolveContextSettings } from '../lib/settings';
import { getUsdcBalance, sendUsdc, USDC_ADDRESS } from '../lib/usdc';
import { describeWallet, resolveWalletProvider, type WalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';

/**
 * `tenjin send <amount> <token> <to>` — the EXPLICIT ESCAPE HATCH for moving
 * funds OUT of the agent wallet (issue #34). The notes deliberately ship no
 * funds-moving verb by default; this one exists for funds already sitting on the
 * hot key, complementary to tenjin#251 delegation (which routes FUTURE revenue
 * off the hot key and does nothing for a balance already here). Because a
 * transfer is irreversible, the gate is explicit per the repo's confirm
 * conventions (the `wallet export --yes` posture): the resolved recipient and
 * amount are previewed and an interactive y/N (or `--yes`) is required before
 * anything is signed — headless without `--yes` refuses, and a missing wallet
 * passphrase refuses through the provider seam before any signature exists.
 * Everything signs through the same TenjinSigner/WalletProvider seam `buy` uses;
 * there is no second signing path. Deliberately EXCLUDED from the MCP toolset
 * (doc 10's narrow-toolset rule) and from the skill adapters: a human invokes
 * this verb, never a model.
 */

export interface SendArgs {
  /** Decimal USD at the edge (O1 convention); converted to atomic exactly once. */
  amount: string;
  /** Token symbol; USDC on Base only, for now. */
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

  const provider = resolveWalletProvider(
    ctx,
    deps.provider !== undefined ? { provider: deps.provider } : {},
  );
  // Surfaces WALLET_MISSING with its own fix if no wallet exists. No key material
  // is touched here; the signer (and any passphrase) is resolved only after the
  // explicit confirm below.
  const desc = await describeWallet(provider);

  const { rpcUrl } = await resolveContextSettings(ctx);
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

  // The explicit gate: preview the RESOLVED recipient (checksummed, not the raw
  // input) and the exact amount, then require a y/N or --yes. No flag and no
  // approval means NOTHING is signed — the signer has not even been resolved yet.
  const approved = await confirmSend(ctx, deps, args.yes === true, amountAtomic, to, desc.address);
  if (!approved) {
    throw new CliError('REFUSED', 'Send not confirmed.', {
      fix: 'Verify the recipient and amount, then re-run with --yes to approve this transfer.',
      details: { to, amount: toMoney(amountAtomic.toString()) },
    });
  }

  // The ONLY door to the key. A missing passphrase entry for the active wallet
  // refuses here with the provider's own coded error (headless: USAGE
  // no-passphrase; wrong entry: WALLET_INVALID_KEY) — never a silent prompt loop,
  // never a second signing path.
  const signer = await provider.getSigner();

  let txHash: string;
  try {
    txHash = await sendUsdc({ signer, to, amountAtomic, rpcUrl });
  } catch (err) {
    throw new CliError('RPC_ERROR', 'The transfer could not be sent on Base.', {
      fix: 'Check the network, and that the wallet holds a little ETH on Base for gas; then retry.',
      cause: err,
    });
  }

  const amount = toMoney(amountAtomic.toString());
  return {
    data: {
      txHash,
      from: desc.address,
      to,
      token: 'USDC',
      network: 'base',
      amount,
    },
    humanLines: [`Sent ${amount.usd} USDC on Base to ${to}`, `Tx: ${txHash}`],
  };
}

/** USDC on Base first (issue #34); anything else is a usage error, not a guess. */
function requireUsdc(token: string): void {
  if (token.trim().toLowerCase() === 'usdc') return;
  throw new CliError('USAGE', `Unsupported token: ${JSON.stringify(token)}`, {
    fix: 'Only USDC on Base is supported: `tenjin send <amount> usdc <to>`.',
  });
}

/**
 * Validate and RESOLVE the recipient: viem's strict isAddress rejects a
 * malformed address and a bad EIP-55 checksum (a likely typo — getAddress alone
 * would silently re-checksum it), then getAddress returns the checksummed form —
 * what the preview shows and the transfer targets. Sending to the USDC contract
 * itself is refused outright: tokens transferred to the token contract are
 * unrecoverable, and no legitimate send targets it.
 */
function parseRecipient(raw: string): Address {
  const trimmed = raw.trim();
  if (!isAddress(trimmed)) {
    throw new CliError('USAGE', `Invalid recipient address: ${JSON.stringify(raw)}`, {
      fix: 'Pass a 0x-prefixed 20-byte address, checksummed or all-lowercase.',
    });
  }
  const to = getAddress(trimmed);
  if (to === USDC_ADDRESS) {
    throw new CliError('USAGE', 'The recipient is the USDC token contract itself.', {
      fix: 'Tokens sent to the token contract are unrecoverable. Pass the destination wallet address.',
    });
  }
  return to;
}

/**
 * The same confirm posture as buy: --yes bypasses the interactive confirm only;
 * a TTY gets a y/N prompt naming the resolved recipient and amount; headless
 * without --yes declines (exit 3), so no flag can ever mean a signature.
 */
async function confirmSend(
  ctx: CommandContext,
  deps: SendDeps,
  yes: boolean,
  amountAtomic: bigint,
  to: Address,
  from: Address,
): Promise<boolean> {
  if (yes) return true;
  const prompt =
    `Send ${toMoney(amountAtomic.toString()).usd} USDC on Base\n` +
    `  from ${from}\n` +
    `  to   ${to}\n` +
    `This moves funds out of the agent wallet and cannot be undone. [y/N] `;
  if (deps.confirm !== undefined) return deps.confirm(prompt);
  if (!ctx.io.isTTY) return false; // non-interactive without --yes: refuse (exit 3)
  if (!process.stdin.isTTY) return false;
  return promptYesNo(prompt);
}

/** stdin closing mid-prompt (ctrl-D) resolves as decline, never a hang. */
function promptYesNo(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    rl.once('close', () => settle(false));
    rl.question(prompt, (answer) => settle(/^y(es)?$/i.test(answer.trim())));
  });
}
