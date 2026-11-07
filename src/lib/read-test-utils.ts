import { vi } from 'vitest';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { declareBuilderCodeExtension } from '@x402/extensions/builder-code';
import type { PaymentRequired } from '@x402/core/types';
import type { PolicyReason, SpendDecision } from './policy';
import type { TenjinSigner, WalletProvider } from './wallet/provider';
import type { SpendAuthorization, SpendAuthorizer, SpendRequest } from './wallet/spend';

/** Shared payment test fixtures: a real (offline) viem signer, a fake wallet
 *  provider around it, a spend authorizer double and 402 challenges. Not bundled
 *  into dist (nothing in the entry graph imports it), same pattern as
 *  wallet/test-support. */

// A well-known Anvil/hardhat test key; deterministic, holds no real funds.
export const TEST_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

/** A wallet signer over `account`, the fixed test key unless a test passes its own. */
export function testSigner(
  account: PrivateKeyAccount = privateKeyToAccount(TEST_PRIVATE_KEY),
): TenjinSigner {
  return {
    address: account.address,
    signMessage: (args) => account.signMessage({ message: args.message }),
    signTypedData: (args) => account.signTypedData(args),
    signTransaction: (tx) => account.signTransaction(tx),
  };
}

export function testWalletProvider(signer: TenjinSigner = testSigner()): WalletProvider {
  return {
    id: 'local',
    describe: async () => ({
      address: signer.address,
      provider: 'local',
      credentialSource: 'file',
      policyEnforcement: 'client-only',
    }),
    getSigner: async () => signer,
    diagnostics: async () => ({ warnings: [] }),
  };
}

/** The reservation a {@link testAuthorizer} holds for every spend it does not deny. */
export const TEST_RESERVATION = 'rsv';

/**
 * A spend authorizer that answers every request with `decision`, or with what
 * the function picks for that request, and spies on commit and release. The
 * reason defaults to the one policy gives that decision.
 */
export function testAuthorizer(
  decision: SpendDecision | ((req: SpendRequest) => SpendDecision) = 'allow',
  reason?: PolicyReason,
): SpendAuthorizer {
  return {
    policyEnforcement: 'client-only',
    authorize: vi.fn(async (req: SpendRequest): Promise<SpendAuthorization> => {
      const decided = typeof decision === 'function' ? decision(req) : decision;
      return {
        decision: decided,
        reason: reason ?? (decided === 'allow' ? 'within_policy' : 'confirm_always'),
        message: 'test',
        amountAtomic: req.amountAtomic,
        sessionSpentAtomic: 0n,
        sessionBudgetAtomic: 0n,
        policyEnforcement: 'client-only',
        ...(decided === 'deny' ? {} : { reservationId: TEST_RESERVATION }),
      };
    }),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
}

export interface PaymentRequiredFixture {
  header: string;
  paymentRequired: PaymentRequired;
}

export function buildPaymentRequired(
  over: Partial<PaymentRequired['accepts'][number]> = {},
  overTop: Partial<Omit<PaymentRequired, 'accepts'>> = {},
): PaymentRequiredFixture {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: 'https://tenjin.blog/api/read/iris/slug',
      description: 'A paid resource',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '100000',
        payTo: '0x1111111111111111111111111111111111111111',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
        ...over,
      },
    ],
    ...overTop,
  };
  return { header: encodePaymentRequiredHeader(paymentRequired), paymentRequired };
}

/** A 402 that advertises the ERC-8021 builder-code extension the way Tenjin's own
 *  paid routes do (app code `a` declared server-side, schema attached).
 *
 *  `sellerServiceCodes` declares an `info.s` alongside it. That is spec-legal (the
 *  live schema lists `s` with `maxItems: 11`) but `s` is the CLIENT's field, so a
 *  seller filling it is claiming attribution the client is supposed to write. */
export function withBuilderCode(
  appCode = 'bc_kc0altv3',
  sellerServiceCodes?: string[],
): Partial<PaymentRequired> {
  const declared = declareBuilderCodeExtension(appCode);
  const entry =
    sellerServiceCodes === undefined
      ? declared
      : { ...declared, info: { ...declared.info, s: sellerServiceCodes } };
  return { extensions: { 'builder-code': entry } };
}
