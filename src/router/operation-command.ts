import { CliError } from '../lib/errors';
import { resolveContextSettings } from '../lib/settings';
import { readUsdcBalanceWithFallback } from '../lib/usdc-balance';
import { resolveSpendAuthorizer, resolveWalletProvider } from '../lib/wallet';
import { createLocalSpendAuthorizer } from '../lib/wallet/spend';
import type { CommandContext, CommandResult } from '../context';
import { chainReader, RoutingPayer } from './routing-payer';
import { runRequestTool, type RequestToolDeps, type RequestToolResult } from './tool';

/**
 * `tenjin request`, FOR SCRIPTS: the `request` tool's operation forms from a shell.
 * It prints the tool's own envelope (the same `status`, `operation`, `run`,
 * `output`, `receipt` and `fullResultPath` the model reads), obeys the same
 * spend limits, and ends with an exit code per status. It never asks anyone
 * (no `approve`): a run over the limits is refused with nothing paid, and
 * says what it would cost. The input stays on this machine.
 *
 * Exit codes follow the CLI's: 0 fulfilled; 2 an input the operation does not
 * take; 3 refused (over the limits, or not routed); 4 a failure after money
 * may have moved; 1 any other failure.
 */

export interface RequestCommandArgs {
  operation: string;
  /** The input as JSON text; absent reads the operation. */
  input?: string;
  choice?: string;
}

/** The exit-code class of a result that is not fulfilled. */
function failureOf(result: RequestToolResult): CliError {
  const status = String(result.envelope['status'] ?? 'failed');
  const message = result.summary;
  const details = result.envelope;
  if (status === 'needs_input') return new CliError('USAGE', message, { details });
  if (status === 'needs_approval') return new CliError('POLICY_REFUSED', message, { details });
  if (status === 'native') return new CliError('REFUSED', message, { details });
  const moved =
    result.envelope['possiblyPaid'] === true ||
    (typeof result.envelope['receipt'] === 'object' &&
      (result.envelope['receipt'] as { provider?: { state?: string } }).provider?.state === 'paid');
  return new CliError(moved ? 'PAYMENT_FAILED' : 'API_UNREACHABLE', message, { details });
}

export async function runRequestCommand(
  ctx: CommandContext,
  args: RequestCommandArgs,
  seams: Partial<RequestToolDeps> = {},
): Promise<CommandResult> {
  let input: Record<string, unknown> | undefined;
  if (args.input !== undefined) {
    try {
      const parsed: unknown = JSON.parse(args.input);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      input = parsed as Record<string, unknown>;
    } catch {
      throw new CliError('USAGE', '--input takes one JSON object, such as \'{"query":"x402"}\'.');
    }
  }
  const settings = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(ctx);
  const authorizer = resolveSpendAuthorizer(ctx, settings.policy);
  const payer = new RoutingPayer({
    dataDir: ctx.dataDir,
    getSigner: () => provider.getSigner(),
    policy: async () => (await resolveContextSettings(ctx)).policy,
    authorizer: (policy) => createLocalSpendAuthorizer({ dir: ctx.dataDir, policy }),
    walletBalance: (address, timeoutMs) =>
      readUsdcBalanceWithFallback(address, settings.rpcUrl, { timeoutMs }),
    readContract: chainReader(settings.rpcUrl),
  });
  try {
    const result = await runRequestTool(
      {
        operation: args.operation,
        ...(input !== undefined ? { input } : {}),
        ...(args.choice !== undefined ? { choice: args.choice } : {}),
      },
      {
        ctx,
        provider,
        authorizer,
        route: payer.routeFor.bind(payer),
        approves: false,
        ...seams,
      },
    );
    if (
      result.isError ||
      ['needs_input', 'needs_approval', 'native'].includes(String(result.envelope['status']))
    ) {
      throw failureOf(result);
    }
    return { data: result.envelope, humanLines: [result.summary] };
  } finally {
    await payer.idle();
  }
}
