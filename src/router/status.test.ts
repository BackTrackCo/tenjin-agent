import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../context';
import { FUND_COMMAND_LINE } from './fee';
import { runRouterStatus } from './status';

/**
 * `tenjin status` SAYS WHETHER TENJIN IS ON, THEN THE BALANCE: at $0 it says
 * how to fund it, a read the RPC did not answer says so, and no wallet means no
 * line and no read. The chain is a seam here; nothing goes on the network.
 */

const ADDRESS = '0xA7f3Ad0E69F61864092FAbBa6Cee00AF6e584689';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-status-'));
  // A git root of its own, so no project file on the machine running the
  // suite can pause Tenjin here.
  await mkdir(join(dir, '.git'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000 },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const status = (atomic: bigint | null) =>
  runRouterStatus(ctx(), {
    cwd: dir,
    routingCredit: async () => 0n,
    wallet: async () => ({ address: ADDRESS, atomic }),
  });

describe('status, the balance line', () => {
  it('says how to fund a wallet at exactly $0', async () => {
    const result = await status(0n);
    expect(result.humanLines?.slice(0, 4)).toEqual([
      'Tenjin is on.',
      'Balance $0.00',
      'Fund it with `tenjin wallet fund 5`.',
      'Today $0.00 of your $5.00 daily limit (Tenjin balance, over the last 24 hours)',
    ]);
    expect(result.data).toMatchObject({
      wallet: { address: ADDRESS, balance: { atomic: '0', usd: '0' } },
    });
  });

  it('shows a funded balance with no funding line', async () => {
    const result = await status(5_000_000n);
    expect(result.humanLines?.slice(0, 3)).toEqual([
      'Tenjin is on.',
      'Balance $5.00',
      'Today $0.00 of your $5.00 daily limit (Tenjin balance, over the last 24 hours)',
    ]);
    expect(result.humanLines).not.toContain(FUND_COMMAND_LINE);
  });

  it('says the balance is unknown when the RPC did not answer, without a funding line', async () => {
    const result = await status(null);
    expect(result.humanLines?.[1]).toBe(
      "Balance unknown: it couldn't be read just now; `tenjin wallet balance` retries",
    );
    expect(result.humanLines).not.toContain(FUND_COMMAND_LINE);
    expect(result.data).toMatchObject({ wallet: { address: ADDRESS, balance: null } });
  });

  it('has no wallet line with no wallet', async () => {
    const result = await runRouterStatus(ctx(), {
      cwd: dir,
      routingCredit: async () => 0n,
      wallet: async () => null,
    });
    expect(result.humanLines?.slice(0, 2)).toEqual([
      'Tenjin is on.',
      'Today $0.00 of your $5.00 daily limit (Tenjin balance, over the last 24 hours)',
    ]);
    expect(result.data).toMatchObject({ wallet: null });
  });

  it('never fails the readout on a wallet read that throws', async () => {
    const result = await runRouterStatus(ctx(), {
      cwd: dir,
      routingCredit: async () => 0n,
      wallet: async () => {
        throw new Error('rpc down');
      },
    });
    expect(result.humanLines?.slice(0, 2)).toEqual([
      'Tenjin is on.',
      'Today $0.00 of your $5.00 daily limit (Tenjin balance, over the last 24 hours)',
    ]);
    expect(result.data).toMatchObject({ wallet: null });
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

/**
 * THE USER'S OWN ACCOUNTS, read from the config and each sign-in's header:
 * who comes first, that their plans pay outside the limits, and what needs
 * the user (an expired sign-in, one missing here). No key and no network.
 */
describe('status, the accounts', () => {
  const header = (state: 'ok' | 'expired') => ({
    version: 1,
    header: {
      version: 1,
      id: 'apify',
      kind: 'oauth',
      store: 'keychain',
      mcpUrl: 'https://mcp.apify.com',
      connectedAt: '2026-10-23T10:00:00.000Z',
      state,
      ready: [],
      missing: [],
    },
    iv: 'x',
    tag: 'x',
    data: 'x',
  });

  it('names each account, who pays, and what needs the user', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        router: {
          sources: [
            { id: 'apify', label: 'Apify', mcpUrl: 'https://mcp.apify.com', signIn: 'oauth' },
            {
              id: 'fal',
              label: 'fal',
              mcpUrl: 'https://mcp.fal.ai/mcp-relay',
              signIn: 'key',
              onRefusal: 'tenjin',
            },
          ],
          policy: {
            version: 1,
            prefer: [{ scope: { kind: 'global' }, targets: [{ kind: 'source', id: 'apify' }] }],
          },
        },
      }),
    );
    await mkdir(join(dir, 'sources'), { recursive: true });
    await writeFile(join(dir, 'sources', 'apify.json'), JSON.stringify(header('expired')));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
    try {
      const result = await runRouterStatus(ctx(), { cwd: dir, routingCredit: async () => 0n });
      expect(result.humanLines).toEqual(
        expect.arrayContaining([
          'Your accounts: Apify (used first for jobs they can do); fal (not put first). Billed to your own plans, not counted in the limit.',
          "  Apify's sign-in has expired: `tenjin connect apify` reconnects it.",
          "  fal isn't signed in on this machine: `tenjin connect fal`.",
          "  When fal refuses a call, Tenjin's own tool runs in its place.",
        ]),
      );
      expect(result.data).toMatchObject({
        accounts: [
          { id: 'apify', label: 'Apify', preferred: true, signIn: 'expired', onRefusal: 'ask' },
          { id: 'fal', label: 'fal', preferred: false, signIn: 'signed_out', onRefusal: 'tenjin' },
        ],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('says how to add one when none is connected', async () => {
    const result = await runRouterStatus(ctx(), { cwd: dir, routingCredit: async () => 0n });
    expect(result.humanLines).toContain(
      'Your accounts: none connected (`tenjin connect <name>` adds one)',
    );
  });
});

/**
 * THE USER'S SETTINGS, ON ONE LINE: each saved rule as a short phrase, named
 * from the directory's copy and the saved accounts, never by id, and the
 * automatic switch when it is on. `tenjin config` reads them back in full.
 */
describe('status, the settings line', () => {
  const run = () =>
    runRouterStatus(ctx(), { cwd: dir, routingCredit: async () => 0n, wallet: async () => null });

  it('names each rule in a few words', async () => {
    const directory = JSON.parse(
      readFileSync(new URL('./fixtures/wire-directory-mcp.json', import.meta.url), 'utf8'),
    ) as { directory: unknown };
    await writeFile(join(dir, 'router-directory.json'), JSON.stringify(directory.directory));
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        router: {
          nativeReplacement: 'when-routed',
          policy: {
            version: 1,
            block: [{ kind: 'provider', id: 'firecrawl' }],
            prefer: [
              {
                scope: { kind: 'task', id: 'web research' },
                targets: [{ kind: 'provider', id: 'google' }],
              },
            ],
          },
        },
      }),
    );
    const result = await run();
    expect(result.humanLines).toContain(
      "Your settings: never use Firecrawl · prefer Google for web research · run Tenjin's picks automatically",
    );
    expect(result.data).toMatchObject({
      settings: {
        status: 'ok',
        phrases: [
          'never use Firecrawl',
          'prefer Google for web research',
          "run Tenjin's picks automatically",
        ],
      },
    });
  });

  it('says when there are none, and when they cannot be read', async () => {
    expect((await run()).humanLines).toContain(
      "Your settings: Tenjin's defaults (`tenjin config` shows them)",
    );
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ router: { policy: { version: 2 } } }),
    );
    expect((await run()).humanLines).toContain(
      "Your settings: can't be read; `tenjin config` shows the problem",
    );
  });
});

/**
 * THE FOUR THINGS, AND NOTHING ELSE: whether Tenjin is on, read the way the
 * hooks read it; the balance; today against the daily limit and the per-call
 * limit, both on the Tenjin balance; the accounts; the settings. What lookups
 * cost, the routing credit and the requests still open are in `--json` alone.
 */
describe('status, on or paused, and only what the user reads', () => {
  const run = () =>
    runRouterStatus(ctx(), {
      cwd: dir,
      routingCredit: async () => 240_000n,
      wallet: async () => null,
    });

  it('says Tenjin is on, and the per-call limit in plain words', async () => {
    const result = await run();
    expect(result.humanLines).toEqual([
      'Tenjin is on.',
      'Today $0.00 of your $5.00 daily limit (Tenjin balance, over the last 24 hours)',
      'Per call: up to $0.25 from the Tenjin balance runs on its own; a call above it asks you first.',
      'Your accounts: none connected (`tenjin connect <name>` adds one)',
      "Your settings: Tenjin's defaults (`tenjin config` shows them)",
    ]);
    expect(result.data).toMatchObject({ enabled: true });
  });

  it('keeps lookups, routing credit and open requests to --json', async () => {
    const now = Date.now();
    await writeFile(
      join(dir, 'spend.json'),
      JSON.stringify({
        schemaVersion: 2,
        windowStartMs: now,
        committedAtomic: '300000',
        automaticCommittedAtomic: '300000',
        reservations: [{ id: 'r', amountAtomic: '20000', mode: 'automatic', atMs: now }],
        exposures: [
          { nonce: 'routing-deposit:r1', amountAtomic: '250000', atMs: now, mode: 'automatic' },
        ],
      }),
    );
    const result = await run();
    const shown = result.humanLines?.join('\n') ?? '';
    for (const internal of ['lookups', 'routing credit', 'reserved', 'open request', 'USD'])
      expect(shown).not.toContain(internal);
    expect(result.data).toMatchObject({
      window: { lookups: { atomic: '50000' }, reserved: { atomic: '20000' } },
      routingCredit: { remaining: { atomic: '240000' }, calls: 80 },
      inFlight: [{ amount: { atomic: '20000' } }],
      caps: { maxAutoSpend: { atomic: '250000' } },
    });
  });

  it('says when Tenjin is paused on this machine, and how to turn it back on', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ router: { enabled: false } }));
    const result = await run();
    expect(result.humanLines?.[0]).toBe(
      'Tenjin is paused on this machine: `tenjin config set router.enabled true` turns it back on.',
    );
    expect(result.data).toMatchObject({ enabled: false });
  });

  it('says when a project file pauses it here', async () => {
    await mkdir(join(dir, '.tenjin'), { recursive: true });
    await writeFile(
      join(dir, '.tenjin', 'config.json'),
      JSON.stringify({ router: { enabled: false } }),
    );
    const result = await run();
    expect(result.humanLines?.[0]).toBe(
      `Tenjin is paused here by ${join(dir, '.tenjin', 'config.json')}: set router.enabled to true there to turn it back on.`,
    );
    expect(result.data).toMatchObject({ enabled: false });
  });

  it('says every call asks first when the per-call limit is zero', async () => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ maxAutoSpend: '0' }));
    expect((await run()).humanLines).toContain(
      'Per call: every call paid from the Tenjin balance asks you first.',
    );
  });
});
