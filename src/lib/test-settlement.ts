/**
 * Transak staging test funds for `tenjin wallet balance`. A Transak STAGING
 * purchase delivers a test token on Base Sepolia instead of USDC on Base, and a
 * staging server says which one at GET /api/transak/test-settlement. Display
 * only: nothing that pays, deposits, or decides a spend reads this module
 * (`test-settlement.test.ts` checks the router and payer never import it).
 */

import { formatUnits } from 'viem';
import { httpRequest } from './http';
import { PRODUCTION_ORIGIN, isSameDeployment } from './production-origin';

export interface TestSettlement {
  chainId: 84532;
  token: `0x${string}`;
  symbol: string;
  decimals: number;
}

/** Base Sepolia's public RPC, the only chain a test settlement is read on. */
export const BASE_SEPOLIA_RPC_URL = 'https://sepolia.base.org';
export const COULD_NOT_READ_TEST_FUNDS = 'Could not read test funds.';

const BALANCE_OF_SELECTOR = '0x70a08231';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;

/** The server's `testSettlement`, or null when the answer has none or a malformed one. */
export function parseTestSettlement(body: unknown): TestSettlement | null {
  const s = (body as { testSettlement?: Record<string, unknown> } | null)?.testSettlement;
  if (
    s?.provider !== 'transak' ||
    s.chainId !== 84532 ||
    typeof s.token !== 'string' ||
    !ADDRESS_RE.test(s.token) ||
    typeof s.symbol !== 'string' ||
    !/^[A-Za-z0-9]{1,11}$/.test(s.symbol) ||
    typeof s.decimals !== 'number' ||
    !Number.isInteger(s.decimals) ||
    s.decimals < 0 ||
    s.decimals > 36
  ) {
    return null;
  }
  return {
    chainId: 84532,
    token: s.token as `0x${string}`,
    symbol: s.symbol,
    decimals: s.decimals,
  };
}

export function testFundsLine(atomic: bigint, settlement: TestSettlement): string {
  return `Test funds on Base Sepolia: ${formatUnits(atomic, settlement.decimals)} ${settlement.symbol} (Transak staging)`;
}

/**
 * The lines `wallet balance` adds for test funds: none against production (which
 * is never asked) or a server with no test settlement, one balance line, or one
 * quiet line when the answer or the read fails. Never throws.
 */
export async function testFundsLines(
  address: string,
  baseUrl: string,
  opts: { timeoutMs: number; fetchImpl?: typeof fetch; rpcUrl?: string },
): Promise<string[]> {
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return [];
  }
  if (isSameDeployment(origin, PRODUCTION_ORIGIN)) return [];
  const res = await httpRequest(`${origin}/api/transak/test-settlement`, {
    timeoutMs: opts.timeoutMs,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!res.ok || res.status < 200 || res.status > 299) return [COULD_NOT_READ_TEST_FUNDS];
  const body = res.json as { testSettlement?: unknown } | undefined;
  if (body?.testSettlement === undefined) return [];
  const settlement = parseTestSettlement(body);
  if (!settlement) return [COULD_NOT_READ_TEST_FUNDS];
  const atomic = await readTokenBalance(address, settlement.token, {
    rpcUrl: opts.rpcUrl ?? BASE_SEPOLIA_RPC_URL,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
  return [atomic === null ? COULD_NOT_READ_TEST_FUNDS : testFundsLine(atomic, settlement)];
}

/** One `balanceOf` over JSON-RPC, or null on any failure. */
async function readTokenBalance(
  address: string,
  token: string,
  opts: { rpcUrl: string; timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<bigint | null> {
  if (!ADDRESS_RE.test(address)) return null;
  try {
    const res = await (opts.fetchImpl ?? fetch)(opts.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            to: token,
            data: `${BALANCE_OF_SELECTOR}${address.slice(2).toLowerCase().padStart(64, '0')}`,
          },
          'latest',
        ],
      }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return null;
    const result = ((await res.json()) as { result?: unknown } | null)?.result;
    return typeof result === 'string' && WORD_RE.test(result) ? BigInt(result) : null;
  } catch {
    return null;
  }
}
