import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { testWalletProvider } from '../lib/read-test-utils';
import type { SpendAuthorization, SpendAuthorizer } from '../lib/wallet';
import type { TenjinSigner } from '../lib/wallet/provider';
import type { CommandContext } from '../context';
import { packetForText } from './context';
import { requestDecision, RequirementsCache } from './decision';

/**
 * The paid routing decision, on a 402 that advertises MORE THAN ONE entry.
 *
 * Tenjin's own router answers with a single Base-USDC option today, so this is
 * the preview, self-hosted and hostile shape: the check, the reservation, the
 * signature and the ledger must all land on the one entry this wallet can pay,
 * never on whatever `accepts[0]` happens to be.
 */

let dir: string;
let signer: TenjinSigner;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-decision-'));
  await writeFile(
    join(dir, 'config.json'),
    JSON.stringify({ maxAutoSpend: '100000', sessionBudget: '1000000' }),
  );
  signer = await testWalletProvider().getSigner();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ROUTER = 'https://tenjin.sh';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: true, timeout: 5000, baseUrl: ROUTER },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

function authorizer(): SpendAuthorizer & {
  authorize: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  return {
    policyEnforcement: 'client-only',
    authorize: vi.fn(async (req): Promise<SpendAuthorization> => ({
      decision: 'allow',
      reason: 'within_policy',
      message: 'test',
      amountAtomic: req.amountAtomic,
      sessionSpentAtomic: 0n,
      sessionBudgetAtomic: 0n,
      policyEnforcement: 'client-only',
      reservationId: 'rsv',
    })),
    commit: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  } as never;
}

/** The entry this wallet can pay: canonical USDC on Base, `exact`. */
const BASE_USDC: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: USDC,
  amount: '1000',
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
};

/** An entry on a chain this CLI never registered, priced far above the cap. */
const BNB_FIRST: PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:56',
  asset: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  amount: '900000000000000000',
  payTo: '0x3333333333333333333333333333333333333333',
  maxTimeoutSeconds: 300,
  extra: { name: 'Binance-Peg USD Coin', version: '1' },
};

/** Base, but in a token of the seller's choosing: the canonical-USDC veto. */
const FOREIGN_TOKEN_FIRST: PaymentRequirements = {
  ...BASE_USDC,
  asset: '0x4444444444444444444444444444444444444444',
  amount: '50000',
  payTo: '0x5555555555555555555555555555555555555555',
};

function challengeHeader(accepts: PaymentRequirements[]): string {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: `${ROUTER}/api/x402-router`,
      description: 'One routing decision',
      mimeType: 'application/json',
    },
    accepts,
  };
  return encodePaymentRequiredHeader(paymentRequired);
}

const DECISION = {
  schemaVersion: 1,
  routerVersion: '2026-09-22.1',
  requestId: 'r-1',
  decision: { action: 'native', reason: 'Your own tools cover this.' },
};

/** The probe 402 with `accepts`, then the paid 200 carrying a decision. */
function net(accepts: PaymentRequirements[]): {
  fetchImpl: typeof fetch;
  signatures: string[];
} {
  const signatures: string[] = [];
  let calls = 0;
  const fetchImpl = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls += 1;
    const header = new Headers(init?.headers ?? {}).get('payment-signature');
    if (header !== null) signatures.push(header);
    if (calls === 1) {
      return new Response('{}', {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': challengeHeader(accepts),
        },
      });
    }
    return new Response(JSON.stringify(DECISION), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, signatures };
}

async function decide(
  accepts: PaymentRequirements[],
  auth: ReturnType<typeof authorizer>,
): Promise<{ outcome: Awaited<ReturnType<typeof requestDecision>>; signatures: string[] }> {
  const { fetchImpl, signatures } = net(accepts);
  const outcome = await requestDecision(
    { requestId: 'r-1', query: 'price of BTC', packet: packetForText('price of BTC') },
    {
      ctx: ctx(),
      baseUrl: ROUTER,
      signer,
      authorizer: auth,
      cache: new RequirementsCache(),
      fetchImpl,
    },
  );
  return { outcome, signatures };
}

describe('the paid routing decision on a multi-entry 402', () => {
  it.each([
    ['an unsupported network first', BNB_FIRST],
    ['an unsupported asset on Base first', FOREIGN_TOKEN_FIRST],
  ])('checks, signs and counts the SAME entry when the 402 lists %s', async (_label, first) => {
    const auth = authorizer();
    const { outcome, signatures } = await decide([first, BASE_USDC], auth);

    expect(outcome.status).toBe('decided');
    // The cap and the reservation, on the payable entry rather than accepts[0].
    expect(auth.authorize).toHaveBeenCalledTimes(1);
    expect(auth.authorize.mock.calls[0]![0]).toMatchObject({
      amountAtomic: BigInt(BASE_USDC.amount),
    });
    // The signature target: what left the process, decoded.
    expect(signatures).toHaveLength(1);
    const payload = decodePaymentSignatureHeader(signatures[0]!);
    expect(payload.accepted).toMatchObject({
      network: BASE_USDC.network,
      asset: BASE_USDC.asset,
      amount: BASE_USDC.amount,
      payTo: BASE_USDC.payTo,
    });
    const authorization = (payload.payload as { authorization: Record<string, unknown> })
      .authorization;
    expect(authorization.value).toBe(BASE_USDC.amount);
    expect(authorization.to).toBe(BASE_USDC.payTo);
    // And the ledger, on that same amount.
    expect(auth.commit).toHaveBeenCalledWith('rsv', BigInt(BASE_USDC.amount));
    expect((outcome as { amountAtomic: bigint }).amountAtomic).toBe(BigInt(BASE_USDC.amount));
  });

  it('refuses a 402 with no payable entry before anything is reserved', async () => {
    const auth = authorizer();
    const { outcome, signatures } = await decide([BNB_FIRST, FOREIGN_TOKEN_FIRST], auth);

    expect(outcome.status).toBe('failed');
    expect((outcome as { reason: string }).reason).toContain('nothing this CLI can pay');
    expect((outcome as { committedAtomic: bigint }).committedAtomic).toBe(0n);
    expect(auth.authorize).not.toHaveBeenCalled();
    expect(auth.commit).not.toHaveBeenCalled();
    expect(signatures).toEqual([]);
  });

  it('refuses a 402 that advertises no requirements at all', async () => {
    const auth = authorizer();
    const { outcome } = await decide([], auth);

    expect(outcome.status).toBe('failed');
    expect((outcome as { reason: string }).reason).toContain('advertised no payment requirements');
    expect(auth.authorize).not.toHaveBeenCalled();
  });
});
