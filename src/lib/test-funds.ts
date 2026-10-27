/**
 * Transak staging test funds for `tenjin wallet balance`. A Transak STAGING
 * purchase delivers a test token on Base Sepolia instead of USDC on Base, so a
 * staging demo's funds show up only here. Display only: nothing that pays,
 * deposits, or decides a spend reads this module (`test-funds.test.ts` checks
 * the router and payers never import it).
 */

import { formatUnits } from 'viem';
import { readErc20Balance } from './usdc-balance';

// docs.transak.com/guides/sandbox-credentials, "Blockchain Testnets (Onramp)", Base Sepolia row.
export const TRANSAK_TEST_TOKEN = {
  chainId: 84532,
  rpcUrl: 'https://sepolia.base.org',
  address: '0xD733D48f2a7F57D4559F98ae07f87Dab595E3523',
  symbol: 'TRNSK',
  decimals: 18,
} as const;

/** How long `wallet balance` waits on the test read, alongside the USDC read. */
export const TEST_FUNDS_TIMEOUT_MS = 3_000;

/** The test-funds line, or null at zero so a wallet without test funds shows nothing new. */
export function testFundsLine(atomic: bigint | null): string | null {
  if (atomic === null || atomic <= 0n) return null;
  const { decimals, symbol } = TRANSAK_TEST_TOKEN;
  return `Test funds on Base Sepolia: ${formatUnits(atomic, decimals)} ${symbol} (Transak staging)`;
}

/** The address's test-token balance on Base Sepolia, or null when it cannot be read. Never throws. */
export function readTestFunds(
  address: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<bigint | null> {
  return readErc20Balance(TRANSAK_TEST_TOKEN.address, address, TRANSAK_TEST_TOKEN.rpcUrl, {
    timeoutMs: opts.timeoutMs ?? TEST_FUNDS_TIMEOUT_MS,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
