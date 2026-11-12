import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context';
import { testCtx } from '../context-test-utils';
import { FUND_COMMAND_LINE } from './fee';
import { runRouterStatus } from './status';

/**
 * `tenjin status`: WHETHER TENJIN IS ON, THEN THE FOUR THINGS A USER SEES.
 * The balance (at $0 it says how to fund it, a read the RPC did not answer
 * says so, and no wallet means no line and no read), today's spend against
 * the daily limit, the connected accounts with who pays for them, and the
 * settings in plain words. The chain is a seam here; nothing goes on the
 * network.
 */

const ADDRESS = '0xA7f3Ad0E69F61864092FAbBa6Cee00AF6e584689';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-status-'));
  await mkdir(join(dir, '.git'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(): CommandContext {
  return testCtx(dir, { json: false });
}

const status = (atomic: bigint | null) =>
  runRouterStatus(ctx(), {
    cwd: dir,
    routingCredit: async () => 0n,
    wallet: async () => ({ address: ADDRESS, atomic }),
  });

const lines = (result: Awaited<ReturnType<typeof runRouterStatus>>) =>
  (result.humanLines ?? []).map((line) => line.replace(/\s+/g, ' ').trim());

describe('status, the balance line', () => {
  it('keeps usable routing funds visible without asking to fund an empty wallet', async () => {
    const result = await runRouterStatus(ctx(), {
      cwd: dir,
      routingCredit: async () => 18_000n,
      wallet: async () => ({ address: ADDRESS, atomic: 0n }),
    });
    expect(lines(result)).toContain('Set aside about $0.018 for routing');
    expect(result.humanLines).not.toContain(FUND_COMMAND_LINE);
    expect(result.data).toMatchObject({ routingCredit: { remaining: { atomic: '18000' } } });
  });

  it('leads with whether Tenjin is on, and says how to fund a wallet at exactly $0', async () => {
    const result = await status(0n);
    expect(lines(result).slice(0, 3)).toEqual([
      'Tenjin is on.',
      'Balance $0.00',
      FUND_COMMAND_LINE,
    ]);
    expect(result.data).toMatchObject({
      enabled: true,
      wallet: { address: ADDRESS, balance: { atomic: '0', usd: '0' } },
    });
  });

  it('shows a funded balance, then today against the daily limit', async () => {
    const result = await status(5_000_000n);
    expect(lines(result).slice(1, 4)).toEqual([
      'Balance $5.00',
      'Today $0.00 of your $5.00 daily limit (Tenjin balance)',
      'Per call up to $0.25 from the Tenjin balance runs on its own; above it asks first',
    ]);
    expect(result.humanLines).not.toContain(FUND_COMMAND_LINE);
  });

  it('says the balance is unknown when the RPC did not answer, without a funding line', async () => {
    const result = await status(null);
    expect(lines(result)[1]).toBe(
      "Balance unknown: it couldn't be read just now; `tenjin balance` retries",
    );
    expect(result.humanLines).not.toContain(FUND_COMMAND_LINE);
    expect(result.data).toMatchObject({ wallet: { address: ADDRESS, balance: null } });
  });

  it('has no balance line with no wallet, and never fails on a read that throws', async () => {
    for (const wallet of [
      async () => null,
      async () => {
        throw new Error('rpc down');
      },
    ]) {
      const result = await runRouterStatus(ctx(), {
        cwd: dir,
        routingCredit: async () => 0n,
        wallet,
      });
      expect(lines(result)[1]).toMatch(/^Today /);
      expect(result.data).toMatchObject({ wallet: null });
    }
  });

  it('reads nothing from the chain on this machine with no wallet', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
    try {
      const result = await runRouterStatus(ctx(), { cwd: dir, routingCredit: async () => 0n });
      expect(result.data).toMatchObject({ wallet: null });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('status, accounts and settings', () => {
  async function save(router: Record<string, unknown>): Promise<void> {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ router }));
  }

  it('names each connected account, who pays for it, and the settings in plain words', async () => {
    await save({
      policy: {
        version: 1,
        block: [{ kind: 'provider', id: 'firecrawl' }],
        prefer: [{ scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'apify' }] }],
      },
      sources: [
        {
          id: 'apify',
          label: 'Apify',
          mcpUrl: 'https://mcp.apify.com',
          signIn: 'oauth',
          mapped: true,
        },
        {
          id: 'fal',
          label: 'fal',
          mcpUrl: 'https://mcp.fal.ai/mcp-relay',
          signIn: 'key',
          mapped: true,
          onRefusal: 'tenjin',
        },
      ],
    });
    const { fakeKeychain } = await import('./accounts/test-support');
    const { writeVault } = await import('./accounts/vault');
    await writeVault(
      'apify',
      'Apify',
      {
        kind: 'oauth',
        mcpUrl: 'https://mcp.apify.com',
        connectedAt: '2026-11-11T10:00:00.000Z',
        state: 'ok',
        missingTools: [],
      },
      { apiKey: 'apify-test' },
      { dataDir: dir, platform: 'darwin', exec: fakeKeychain().exec },
    );
    const { readFileSync } = await import('node:fs');
    await writeFile(
      join(dir, 'router-identities.json'),
      readFileSync(new URL('./fixtures/wire-identities-mcp.json', import.meta.url), 'utf8'),
    );
    const result = await status(5_000_000n);
    const shown = lines(result);
    expect(shown).toContain(
      'Your accounts Apify (set to come first for the jobs Tenjin has checked); fal (not put first): billed to your own plans, not counted in the limit',
    );
    expect(shown).toContain('Apify does local business search and web research');
    expect(shown).toContain("fal isn't signed in on this machine: `tenjin connect fal`");
    expect(shown).toContain("when fal refuses a call, Tenjin's own tool runs in its place");
    expect(shown.at(-1)).toBe('Your settings never use Firecrawl · your Apify first');
    expect(JSON.stringify(result.humanLines)).not.toMatch(/x402|USDC|wallet|source/i);
    expect(result.data).toMatchObject({
      accounts: [
        { id: 'apify', preferred: true, signIn: 'ok' },
        { id: 'fal', preferred: false, signIn: 'signed_out', onRefusal: 'tenjin' },
      ],
    });
  });

  it('says when Tenjin is paused, and when nothing is connected', async () => {
    await save({ enabled: false });
    const result = await status(1_000_000n);
    expect(lines(result)[0]).toBe(
      'Tenjin is paused on this machine: `tenjin config set router.enabled true` turns it back on.',
    );
    expect(lines(result)).toContain(
      'Your accounts none connected (`tenjin connect <name>` adds one)',
    );
    expect(lines(result)).toContain("Your settings Tenjin's defaults (`tenjin config` shows them)");
  });
});
