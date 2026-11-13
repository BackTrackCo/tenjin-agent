import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context';
import { testCtx } from '../context-test-utils';
import { runRouterStatus } from './status';

/**
 * `tenjin status`: WHETHER TENJIN IS ON, THEN THE FOUR THINGS A USER SEES.
 * The balance (below the per-call limit it is low and names the fund
 * command, a read the RPC did not answer says so, and no wallet means no row
 * and no read), today's spend against the daily limit, the connected
 * accounts, and the settings in a few words. The chain is a seam here;
 * nothing goes on the network.
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
  it('shows the state in one line, then the rows, with the next commands beside them', async () => {
    const result = await status(5_000_000n);
    expect(lines(result)).toEqual([
      '● Tenjin is on',
      '',
      'Balance $5.00',
      'Today $0.00 of $5.00 · up to $0.25 a call',
      'Accounts none yet tenjin connect fal',
      "Settings Tenjin's defaults tenjin config",
    ]);
    expect(result.data).toMatchObject({ enabled: true, wallet: { address: ADDRESS } });
  });

  it('keeps the routing credit in --json only', async () => {
    const result = await runRouterStatus(ctx(), {
      cwd: dir,
      routingCredit: async () => 18_000n,
      wallet: async () => ({ address: ADDRESS, atomic: 5_000_000n }),
    });
    expect(JSON.stringify(result.humanLines)).not.toMatch(/routing|set aside/i);
    expect(result.data).toMatchObject({ routingCredit: { remaining: { atomic: '18000' } } });
  });

  it('shows model-routing and inference credit separately from funds for tool routing', async () => {
    const result = await runRouterStatus(ctx(), {
      cwd: dir,
      routingCredit: async () => 21000n,
      modelCredit: async () => 977000n,
      modelRoutingCredit: async () => 47000n,
      wallet: async () => ({ address: ADDRESS, atomic: 5000000n }),
    });
    expect(result.data).toMatchObject({
      routingCredit: { remaining: { atomic: '21000' } },
      modelCredit: { remaining: { atomic: '977000' } },
      modelRoutingCredit: { remaining: { atomic: '47000' } },
    });
    expect(lines(result)).toContain('Subagents $0.977 set aside for model calls');
    expect(lines(result)).toContain('Model fee $0.047 set aside for model routing');
  });

  it('says the balance is low below the per-call limit, as `tenjin balance` does, and how to fund it', async () => {
    for (const atomic of [0n, 249_999n]) {
      const result = await status(atomic);
      expect(lines(result).slice(0, 3)).toEqual([
        '! Tenjin is on, but your balance is low',
        '',
        `Balance ${atomic === 0n ? '$0.00' : '$0.249999'} tenjin fund 5`,
      ]);
    }
    const enough = await status(250_000n);
    expect(lines(enough)[0]).toBe('● Tenjin is on');
  });

  it('says the balance is unknown when the RPC did not answer, without a funding line', async () => {
    const result = await status(null);
    expect(lines(result)[2]).toBe('Balance unknown');
    expect(lines(result).at(-1)).toBe(
      "! Your balance couldn't be read just now: tenjin balance tries again",
    );
    expect(JSON.stringify(result.humanLines)).not.toContain('tenjin fund');
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
      expect(lines(result)[2]).toMatch(/^Today /);
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

  it('names each connected account and what one needs, and the settings in a few words', async () => {
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
    expect(shown).toContain('Accounts Apify ✓ · fal ! not signed in here');
    expect(shown).toContain('Settings Firecrawl blocked · Apify first');
    expect(shown.at(-1)).toBe("! fal isn't signed in on this machine: tenjin connect fal");
    expect(JSON.stringify(result.humanLines)).not.toMatch(/x402|USDC|wallet|source/i);
    // The phrases `--json` carries are its own, unchanged.
    expect(result.data).toMatchObject({
      settings: { phrases: ['never offer Firecrawl unless asked', 'your Apify first'] },
    });
    expect(result.data).toMatchObject({
      accounts: [
        { id: 'apify', preferred: true, signIn: 'ok' },
        { id: 'fal', preferred: false, signIn: 'signed_out', onRefusal: 'tenjin' },
      ],
    });
  });

  it('says when Tenjin is paused, and the command that turns it back on', async () => {
    await save({ enabled: false });
    const result = await status(1_000_000n);
    expect(lines(result).slice(0, 4)).toEqual([
      '○ Tenjin is paused',
      'It offers nothing until you turn it back on:',
      'tenjin config set router.enabled true',
      '',
    ]);
    expect(result.data).toMatchObject({ enabled: false });
  });

  it('counts the rules once they no longer fit the row', async () => {
    await save({
      policy: {
        version: 1,
        block: [
          { kind: 'provider', id: 'firecrawl' },
          { kind: 'provider', id: 'exa' },
          { kind: 'provider', id: 'tavily' },
          { kind: 'provider', id: 'apollo' },
        ],
      },
      nativeReplacement: 'when-routed',
    });
    const result = await status(5_000_000n);
    expect(lines(result)).toContain('Settings 4 rules · automatic picks on');
  });
});
