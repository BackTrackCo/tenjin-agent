import { CliError } from '../lib/errors';
import { walletPath } from '../lib/paths';
import { loadRawConfig, resolveSettings } from '../lib/config';
import { toMoney } from '../lib/money';
import { getUsdcBalance } from '../lib/usdc';
import {
  createLocalWallet,
  describeWallet,
  importLocalWallet,
  resolveWalletProvider,
  type ResolveWalletProviderOptions,
} from '../lib/wallet';
import { walletFileExists } from '../lib/wallet/store';
import type { CommandContext, CommandResult } from '../context';

const FUNDING_LINE = 'Send USDC on Base. $5 covers ~50 typical resources.';
const isWindows = process.platform === 'win32';

/** Injectable stdin reader for `import`. Null means "no piped input" (a TTY, or an
 * empty pipe): the default never blocks on a TTY, so the command turns null into a
 * USAGE error instead of hanging. Tests inject a stub to drive every branch. */
export type ReadStdin = () => Promise<string | null>;

export const readStdinDefault: ReadStdin = async () => {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const data = Buffer.concat(chunks).toString('utf8').trim();
  return data.length > 0 ? data : null;
};

export async function runWalletCreate(ctx: CommandContext): Promise<CommandResult> {
  await refuseIfWalletExists(ctx.dataDir);

  const { address, walletPath: path } = await createLocalWallet(ctx.dataDir);

  const warnings = custodyWarnings();
  return {
    data: {
      address,
      walletPath: path,
      provider: 'local',
      policyEnforcement: 'client-only',
      warnings,
    },
    humanLines: [`Wallet created: ${address}`, FUNDING_LINE, ...warnings],
  };
}

export async function runWalletShow(
  ctx: CommandContext,
  opts: ResolveWalletProviderOptions = {},
): Promise<CommandResult> {
  const provider = resolveWalletProvider(ctx, opts);
  const desc = await describeWallet(provider);
  // Diagnostics are the provider's own: a remote provider reports no local file
  // path or perms warning, so `show` never contaminates a remote wallet's output
  // with a stale local wallet.json's state.
  const { walletPath: path, warnings } = await provider.diagnostics();

  return {
    data: {
      address: desc.address,
      provider: desc.provider,
      credentialSource: desc.credentialSource,
      policyEnforcement: desc.policyEnforcement,
      ...(path !== undefined ? { walletPath: path } : {}),
      warnings,
    },
    humanLines: [`Address: ${desc.address}`, `Key source: ${desc.credentialSource}`, ...warnings],
  };
}

export async function runWalletBalance(
  ctx: CommandContext,
  opts: ResolveWalletProviderOptions = {},
): Promise<CommandResult> {
  const provider = resolveWalletProvider(ctx, opts);
  const desc = await describeWallet(provider);

  const config = await loadRawConfig(ctx.dataDir);
  const rpcUrl = resolveSettings({
    config,
    flags: { baseUrl: ctx.flags.baseUrl },
    env: process.env,
  }).rpcUrl.value;

  let atomic: bigint;
  try {
    atomic = await getUsdcBalance(desc.address, rpcUrl);
  } catch (err) {
    throw new CliError('RPC_ERROR', `Could not read the USDC balance from ${rpcUrl}.`, {
      fix: 'Check your network, or set a working RPC with `tenjin config set rpcUrl <url>`.',
      cause: err,
    });
  }

  const balance = toMoney(atomic.toString());
  return {
    data: { address: desc.address, balance },
    humanLines: [`Balance: ${balance.usd} USDC on Base`],
  };
}

export async function runWalletImport(
  args: { fromEnv: boolean },
  ctx: CommandContext,
  readStdin: ReadStdin = readStdinDefault,
): Promise<CommandResult> {
  await refuseIfWalletExists(ctx.dataDir);

  let key: string;
  let source: 'env' | 'stdin';
  if (args.fromEnv) {
    const envKey = process.env.TENJIN_WALLET_KEY;
    if (envKey === undefined || envKey.trim().length === 0) {
      throw new CliError('USAGE', 'TENJIN_WALLET_KEY is not set.', {
        fix: 'Set TENJIN_WALLET_KEY, or pipe the key: `echo $KEY | tenjin wallet import`.',
      });
    }
    key = envKey.trim();
    source = 'env';
  } else {
    const input = await readStdin();
    if (input === null) {
      throw new CliError('USAGE', 'No private key on stdin.', {
        fix: 'Pipe the key (`echo $KEY | tenjin wallet import`) or use `--from-env`.',
      });
    }
    key = input;
    source = 'stdin';
  }

  const { address, walletPath: path } = await importLocalWallet(ctx.dataDir, key);

  return {
    data: { address, walletPath: path, source },
    humanLines: [`Imported wallet: ${address}`],
  };
}

/** create and import both refuse to overwrite: keys are non-recoverable and may hold funds. */
async function refuseIfWalletExists(dir: string): Promise<void> {
  if (!(await walletFileExists(dir))) return;
  const path = walletPath(dir);
  throw new CliError('WALLET_EXISTS', `A wallet already exists at ${path}.`, {
    fix: `Keys are non-recoverable; move it aside first (e.g. \`mv ${path} ${path}.bak\`) to create a new one.`,
  });
}

function custodyWarnings(): string[] {
  const warnings: string[] = [];
  if (hasEnvKey()) {
    warnings.push('TENJIN_WALLET_KEY is set and shadows this file at runtime.');
  }
  if (isWindows) {
    warnings.push('File permissions are not enforced on Windows; the key file is not restricted.');
  }
  return warnings;
}

function hasEnvKey(): boolean {
  const envKey = process.env.TENJIN_WALLET_KEY;
  return envKey !== undefined && envKey.length > 0;
}
