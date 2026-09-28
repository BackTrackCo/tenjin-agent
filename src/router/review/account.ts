import { join } from 'node:path';
import { z } from 'zod';
import { runPay, type PayDeps } from '../../commands/pay';
import { CliError } from '../../lib/errors';
import { withFileLock } from '../../lib/lock';
import { resolveWalletProvider } from '../../lib/wallet';
import type { CommandContext, CommandResult } from '../../context';
import { privateDir, readPrivate, reviewDir, savePrivate } from './store';

const AccountSchema = z.strictObject({
  wallet: z.string(),
  apiKey: z.string().min(1),
  createdAt: z.string(),
});
const SignupSchema = z.object({
  success: z.literal(true),
  status: z.literal('account_created'),
  apiKey: z.string().min(1),
  balanceCents: z.number().int().nonnegative(),
});
export async function reviewAccount(ctx: CommandContext, deps: Pick<PayDeps, 'provider'> = {}) {
  const wallet = await (deps.provider ?? resolveWalletProvider(ctx)).describe();
  const account = await readPrivate(join(reviewDir(ctx.dataDir), 'account.json'), AccountSchema);
  if (account && account.wallet.toLowerCase() !== wallet.address.toLowerCase())
    throw new CliError(
      'REFUSED',
      'The human-review account belongs to a different wallet. Recover the original connection.',
    );
  return { wallet: wallet.address, account };
}
export async function connectReviewAccount(
  ctx: CommandContext,
  options: { yes?: boolean; country?: string },
  deps: PayDeps = {},
): Promise<CommandResult> {
  const dir = reviewDir(ctx.dataDir);
  await privateDir(dir);
  return withFileLock(join(dir, 'account.lock'), async () => {
    const { wallet, account } = await reviewAccount(ctx, deps);
    if (account)
      return {
        data: { status: 'connected', provider: 'RentAHuman' },
        humanLines: ['RentAHuman is connected.'],
      };
    const signed = await readPrivate(join(dir, 'signup-signed.json'), z.unknown());
    if (signed !== undefined)
      throw new CliError(
        'REFUSED',
        'Signup has an unresolved signed payment. Reconcile that attempt before another signup.',
      );
    if (options.country !== undefined && !/^[A-Z]{2}$/.test(options.country))
      throw new CliError(
        'USAGE',
        'Country must be an explicitly supplied uppercase two-letter code.',
      );
    if (options.yes !== true)
      return {
        data: {
          status: 'needs_approval',
          fundingUsd: '10.00',
          purpose: 'RentAHuman account credit, not a purchased review',
          nextStep: 'Run tenjin jobs connect --yes only after approving the $10 funding.',
        },
      };
    const result = await runPay(
      {
        url: 'https://rentahuman.ai/api/x402/signup',
        data: JSON.stringify({
          agentName: 'Tenjin',
          ...(options.country ? { country: options.country } : {}),
        }),
        yes: true,
        maxPrice: '10',
        execution: 'manual',
        terms: { source: 'RentAHuman signup credit', maxAmountAtomic: '10000000' },
        printBody: true,
      },
      ctx,
      {
        ...deps,
        beforePayment: async (payment) =>
          savePrivate(join(dir, 'signup-signed.json'), { wallet, ...payment }),
      },
    );
    await savePrivate(join(dir, 'signup-response.json'), result.data);
    const data = result.data as { bodyText?: string };
    let body: unknown;
    try {
      body = JSON.parse(data.bodyText ?? '');
    } catch {
      body = null;
    }
    const parsed = SignupSchema.safeParse(body);
    if (!parsed.success)
      throw new CliError(
        'REFUSED',
        'Signup did not return a verified account credential. Preserve the signed attempt for recovery; do not pay again.',
      );
    await savePrivate(join(dir, 'account.json'), {
      wallet,
      apiKey: parsed.data.apiKey,
      createdAt: new Date().toISOString(),
    });
    return {
      data: { status: 'connected', provider: 'RentAHuman', balanceCents: parsed.data.balanceCents },
      humanLines: ['RentAHuman connected; credential saved privately. No review was purchased.'],
    };
  });
}
