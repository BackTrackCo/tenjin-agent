import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  COULD_NOT_READ_TEST_FUNDS,
  parseTestSettlement,
  testFundsLine,
  testFundsLines,
} from './test-settlement';

const ADDRESS = '0x3200000000000000000000000000000000000038';
const SETTLEMENT = {
  provider: 'transak',
  chainId: 84532,
  token: '0xD733D48f2a7F57D4559F98ae07f87Dab595E3523',
  symbol: 'TRNSK',
  decimals: 18,
};
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

/** A fetch that answers the settlement route with `server` and the RPC with `rpc`. */
function fakeFetch(server: () => Response, rpc: () => Response) {
  return vi.fn(async (url: string | URL | Request) =>
    String(url).endsWith('/api/transak/test-settlement') ? server() : rpc(),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });
const rpcBalance = (n: bigint) => () => Response.json({ jsonrpc: '2.0', id: 1, result: word(n) });

describe('parseTestSettlement', () => {
  it('takes a well-formed Transak settlement on Base Sepolia', () => {
    expect(parseTestSettlement({ testSettlement: SETTLEMENT })).toEqual({
      chainId: 84532,
      token: SETTLEMENT.token,
      symbol: 'TRNSK',
      decimals: 18,
    });
  });

  it('refuses an absent or malformed one', () => {
    expect(parseTestSettlement({})).toBeNull();
    expect(parseTestSettlement(null)).toBeNull();
    for (const bad of [
      { chainId: 8453 },
      { token: '0x1234' },
      { decimals: 18.5 },
      { decimals: '18' },
      { symbol: 'TR NSK' },
      { provider: 'other' },
    ]) {
      expect(parseTestSettlement({ testSettlement: { ...SETTLEMENT, ...bad } })).toBeNull();
    }
  });
});

describe('testFundsLine', () => {
  it('formats with the 18 decimals the server names, not USDC 6', () => {
    expect(
      testFundsLine(100n * 10n ** 18n, parseTestSettlement({ testSettlement: SETTLEMENT })!),
    ).toBe('Test funds on Base Sepolia: 100 TRNSK (Transak staging)');
    expect(
      testFundsLine(15n * 10n ** 17n, parseTestSettlement({ testSettlement: SETTLEMENT })!),
    ).toBe('Test funds on Base Sepolia: 1.5 TRNSK (Transak staging)');
  });
});

describe('testFundsLines', () => {
  const opts = (fetchImpl: typeof fetch) => ({ timeoutMs: 1000, fetchImpl });

  it('never asks production', async () => {
    const fetchImpl = fakeFetch(json({ testSettlement: SETTLEMENT }), rpcBalance(1n));
    expect(await testFundsLines(ADDRESS, 'https://tenjin.sh', opts(fetchImpl))).toEqual([]);
    expect(await testFundsLines(ADDRESS, 'https://tenjin.blog/', opts(fetchImpl))).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the wallet's test token on Base Sepolia from a staging server", async () => {
    const fetchImpl = fakeFetch(
      json({ testSettlement: SETTLEMENT }),
      rpcBalance(100n * 10n ** 18n),
    );
    expect(await testFundsLines(ADDRESS, 'http://127.0.0.1:3100', opts(fetchImpl))).toEqual([
      'Test funds on Base Sepolia: 100 TRNSK (Transak staging)',
    ]);
    const rpcCall = fetchImpl.mock.calls[1]!;
    expect(rpcCall[0]).toBe('https://sepolia.base.org');
    const sent = JSON.parse(rpcCall[1].body) as { params: [{ to: string; data: string }] };
    expect(sent.params[0].to).toBe(SETTLEMENT.token);
    expect(sent.params[0].data).toBe(`0x70a08231${ADDRESS.slice(2).padStart(64, '0')}`);
  });

  it('adds nothing when the server has no test settlement', async () => {
    const fetchImpl = fakeFetch(json({}), rpcBalance(1n));
    expect(await testFundsLines(ADDRESS, 'http://127.0.0.1:3100', opts(fetchImpl))).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('says one quiet line when the answer or the read fails', async () => {
    const cases = [
      fakeFetch(json({ testSettlement: { ...SETTLEMENT, decimals: 'x' } }), rpcBalance(1n)),
      fakeFetch(json({ error: 'nope' }, 500), rpcBalance(1n)),
      fakeFetch(json({ testSettlement: SETTLEMENT }), () => new Response('down', { status: 502 })),
      fakeFetch(json({ testSettlement: SETTLEMENT }), json({ jsonrpc: '2.0', id: 1, error: {} })),
    ];
    for (const fetchImpl of cases) {
      expect(await testFundsLines(ADDRESS, 'http://127.0.0.1:3100', opts(fetchImpl))).toEqual([
        COULD_NOT_READ_TEST_FUNDS,
      ]);
    }
  });
});

describe('scope', () => {
  // The router's payment path, the x402 channel, deposit sizing and every spend
  // decision stay on mainnet USDC: none of them may read the test token.
  it('is imported by no router, payer, or spend module', () => {
    const src = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path);
      }
    };
    walk(join(src, 'router'));
    for (const name of readdirSync(join(src, 'lib'))) {
      if (/^(spend-|x402-pay|usdc)/.test(name) && !name.endsWith('.test.ts')) {
        files.push(join(src, 'lib', name));
      }
    }
    files.push(join(src, 'commands', 'pay.ts'), join(src, 'commands', 'send.ts'));
    const importers = files.filter((f) => readFileSync(f, 'utf8').includes('test-settlement'));
    expect(files.length).toBeGreaterThan(20);
    expect(importers).toEqual([]);
  });
});
