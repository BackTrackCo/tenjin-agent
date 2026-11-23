import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CliError } from '../lib/errors';
import { resolveContextSettings } from '../lib/settings';
import { resolveSpendAuthorizer, resolveWalletProvider } from '../lib/wallet';
import type { CommandContext, CommandResult } from '../context';
import { modelSettings } from '../router/model-settings';
import type { ModelJob } from '../router/model-job';
import { chainReader } from '../router/routing-payer';
import { NEON_TURN_MAX_TOKENS } from '../router/neon-chat';
import { neonSeller } from '../router/neon-seller';
import { NeonTransport, readNeonRecord } from '../router/neon-transport';

export const NEON_PROBE_ENV = 'TENJIN_NEON_PROBE';

/**
 * A DEV-ONLY DOOR for the Neon evaluation, hidden and off unless `TENJIN_NEON_PROBE=1`: it sends
 * one given request body through the Neon transport with the seller `TENJIN_NEON_SELLER` names,
 * and prints the reply, its usage and what the call was quoted and charged. It is the worker's
 * own payment code under the person's own limits and Neon consent, with no worker around it.
 * With `--refund` it asks the x402inference channel for the remainder back instead.
 */
export async function runNeonProbe(
  file: string | undefined,
  flags: { refund?: boolean },
  ctx: CommandContext,
): Promise<CommandResult> {
  if (process.env[NEON_PROBE_ENV] !== '1')
    throw new CliError('USAGE', `This is a dev door: set ${NEON_PROBE_ENV}=1 to use it.`);
  const settings = await resolveContextSettings(ctx);
  const provider = resolveWalletProvider(ctx);
  const transport = new NeonTransport({
    dataDir: ctx.dataDir,
    ctx,
    provider,
    authorizer: resolveSpendAuthorizer(ctx, settings.policy),
    readContract: chainReader(settings.rpcUrl),
  });
  const seller = neonSeller();
  const abort = new AbortController();
  if (flags.refund) {
    if (seller !== 'x402inference')
      throw new CliError('USAGE', 'Only the x402inference channel has a remainder to refund.');
    const settled = await transport.refundChannel(abort.signal);
    return {
      data: { seller, refund: settled },
      humanLines: [`Refund answered: ${JSON.stringify(settled)}`],
    };
  }
  if (file === undefined) throw new CliError('USAGE', 'Give the request body file.');
  const body = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  const consent = await modelSettings(ctx.dataDir, process.cwd(), 'neon');
  if (!consent)
    throw new CliError(
      'USAGE',
      'Neon is off here: run `tenjin config neon on` for this directory.',
    );
  const job = {
    id: randomUUID(),
    sessionId: 'probe',
    turnId: 'probe',
    callId: 'probe',
    root: process.cwd(),
    task: 'probe',
    native: {},
    decision: { provider: 'neon', maxOutputTokens: NEON_TURN_MAX_TOKENS },
    capAtomic: consent.maxJobAtomic.toString(),
    state: 'running',
    expiresAt: Date.now() + 60_000,
  } as unknown as ModelJob;
  const message = await transport.messages(job, body, abort.signal);
  const call = (await readNeonRecord(ctx.dataDir, job.id))?.calls.at(-1);
  return {
    data: { seller, message, call },
    humanLines: [
      `seller ${seller}`,
      `stop ${String(message.stop_reason)}  usage ${JSON.stringify(message.usage)}`,
      `ceiling ${call?.quotedAtomic}  charged ${call?.settledAtomic}  reasoning ${call?.reasoningTokens ?? 0}  cached ${call?.cachedInputTokens}`,
      `text ${JSON.stringify(message.content).slice(0, 400)}`,
    ],
  };
}
