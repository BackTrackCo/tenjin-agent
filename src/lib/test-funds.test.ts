import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { TRANSAK_TEST_TOKEN, readTestFunds, testFundsLine } from './test-funds';

const ADDRESS = '0x3200000000000000000000000000000000000038';
const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

describe('testFundsLine', () => {
  it('formats the 18-decimal test token, not USDC 6', () => {
    expect(testFundsLine(100n * 10n ** 18n)).toBe(
      'Test funds on Base Sepolia: 100 TRNSK (Transak staging)',
    );
    expect(testFundsLine(15n * 10n ** 17n)).toBe(
      'Test funds on Base Sepolia: 1.5 TRNSK (Transak staging)',
    );
  });

  it('says nothing at zero or when the read failed', () => {
    expect(testFundsLine(0n)).toBeNull();
    expect(testFundsLine(null)).toBeNull();
  });
});

describe('readTestFunds', () => {
  it("reads the wallet's test-token balance on Base Sepolia", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 1, result: word(7n) }));
    expect(await readTestFunds(ADDRESS, { fetchImpl })).toBe(7n);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://sepolia.base.org');
    const sent = JSON.parse(String(init.body)) as { params: [{ to: string; data: string }] };
    expect(sent.params[0].to).toBe(TRANSAK_TEST_TOKEN.address);
    expect(sent.params[0].data).toBe(`0x70a08231${ADDRESS.slice(2).padStart(64, '0')}`);
  });

  it('is null, never a throw, on an RPC failure or a malformed answer', async () => {
    for (const fetchImpl of [
      vi.fn(async () => new Response('down', { status: 502 })),
      vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000 } })),
      vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 1, result: '0x12' })),
      vi.fn(async () => {
        throw new Error('offline');
      }),
    ]) {
      expect(await readTestFunds(ADDRESS, { fetchImpl })).toBeNull();
    }
  });
});

describe('scope', () => {
  // The router's payment path, the x402 channel, deposit sizing and every spend
  // decision stay on USDC on Base: none of them may read the test token.
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
    const importers = files.filter((f) => readFileSync(f, 'utf8').includes('test-funds'));
    expect(files.length).toBeGreaterThan(20);
    expect(importers).toEqual([]);
  });
});
