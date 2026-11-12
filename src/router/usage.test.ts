import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '../context';
import { CliError } from '../lib/errors';
import { runRouterUsage } from './usage';

/**
 * `tenjin usage`: the local ledger, totalled by day and by who ran each call,
 * Tenjin's tools from the balance and each account on its own plan.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-usage-'));
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

const NOW = Date.parse('2026-10-23T18:00:00.000Z');

function row(ts: string, over: Record<string, unknown>) {
  return JSON.stringify({
    version: 1,
    ts,
    capabilityId: 'x',
    provider: 'Exa',
    url: 'https://x.test',
    sent: '{}',
    amountAtomic: '7000',
    settlement: 'settled',
    savedFiles: [],
    ...over,
  });
}

describe('usage', () => {
  it('totals each day by Tenjin’s tools and by account, and leaves out what is older', async () => {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        router: {
          sources: [
            { id: 'apify', label: 'Apify', mcpUrl: 'https://mcp.apify.com', signIn: 'oauth' },
          ],
        },
      }),
    );
    await mkdir(join(dir, 'paid'), { recursive: true });
    await writeFile(
      join(dir, 'paid', 'ledger.jsonl'),
      [
        row('2026-10-01T10:00:00.000Z', {}),
        row('2026-10-22T10:00:00.000Z', {}),
        row('2026-10-23T10:00:00.000Z', { source: 'tenjin' }),
        row('2026-10-23T11:00:00.000Z', { amountAtomic: '3000' }),
        // Signed, and never used: the chain says so, so nothing left the balance.
        row('2026-10-23T11:30:00.000Z', { amountAtomic: '50000', settlement: 'not_charged' }),
        row('2026-10-23T12:00:00.000Z', {
          source: 'apify',
          provider: 'Apify',
          amountAtomic: '0',
          settlement: 'account',
        }),
        row('2026-10-23T13:00:00.000Z', {
          source: 'apify',
          provider: 'Apify',
          amountAtomic: '0',
          settlement: 'account',
        }),
      ].join('\n') + '\n',
    );
    const result = await runRouterUsage(ctx(), {}, { now: () => NOW });
    expect(result.humanLines).toEqual([
      'Since 2026-10-16:',
      "2026-10-23  Tenjin's tools      2 calls    $0.01",
      '2026-10-23  your Apify account  2 calls    billed to that account',
      "2026-10-22  Tenjin's tools      1 call     $0.007",
      'Total: $0.017 from your Tenjin balance over 3 calls; 2 calls on your own accounts, billed to their plans and not counted in the limit.',
      "Routing fees aren't in this history; `tenjin status` shows today's spending with them.",
    ]);
    expect(result.data).toMatchObject({
      totals: { balanceCalls: 3, accountCalls: 2 },
      days: [
        { day: '2026-10-23', source: 'tenjin', calls: 2 },
        { day: '2026-10-23', source: 'apify', calls: 2, billedTo: 'account' },
        { day: '2026-10-22', source: 'tenjin', calls: 1 },
      ],
    });
    const day = await runRouterUsage(ctx(), { since: '24h' }, { now: () => NOW });
    expect(day.data).toMatchObject({ totals: { balanceCalls: 2, accountCalls: 2 } });
  });

  it('shows an account call whose charge is unknown as may have charged, never as billed', async () => {
    // Review: a job still running, failed after it started, or answered with
    // the account's own error read "billed to that account" and was counted
    // with the calls that billed.
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        router: {
          sources: [
            { id: 'apify', label: 'Apify', mcpUrl: 'https://mcp.apify.com', signIn: 'oauth' },
          ],
        },
      }),
    );
    await mkdir(join(dir, 'paid'), { recursive: true });
    const apify = { source: 'apify', provider: 'Apify', amountAtomic: '0', settlement: 'account' };
    await writeFile(
      join(dir, 'paid', 'ledger.jsonl'),
      [
        row('2026-10-23T10:00:00.000Z', {}),
        row('2026-10-23T12:00:00.000Z', apify),
        row('2026-10-23T13:00:00.000Z', { ...apify, charge: 'unknown' }),
        row('2026-10-23T14:00:00.000Z', { ...apify, charge: 'unknown' }),
      ].join('\n') + '\n',
    );
    const result = await runRouterUsage(ctx(), {}, { now: () => NOW });
    expect(result.humanLines).toEqual([
      'Since 2026-10-16:',
      "2026-10-23  Tenjin's tools      1 call     $0.007",
      '2026-10-23  your Apify account  1 call     billed to that account',
      '2026-10-23  your Apify account  2 calls    may have charged',
      'Total: $0.007 from your Tenjin balance over 1 call; 1 call on your own accounts, billed to their plans and not counted in the limit.',
      "2 calls on your own accounts may have charged their plans: still running, failed, or answered with the account's own error.",
      "Routing fees aren't in this history; `tenjin status` shows today's spending with them.",
    ]);
    expect(result.data).toMatchObject({
      totals: { balanceCalls: 1, accountCalls: 1, mayHaveChargedCalls: 2 },
      days: [
        { source: 'tenjin', calls: 1 },
        { source: 'apify', calls: 1, billedTo: 'account' },
        { source: 'apify', calls: 2, mayHaveCharged: 'account' },
      ],
    });
    const days = (result.data as { days: Record<string, unknown>[] }).days;
    expect(days[2]).not.toHaveProperty('billedTo');
  });

  it('takes 24h, 7d, 30d or a date, and nothing else', async () => {
    const empty = await runRouterUsage(ctx(), { since: '2026-10-20' }, { now: () => NOW });
    expect(empty.humanLines).toEqual(['No lookups on this machine since 2026-10-20.']);
    await expect(runRouterUsage(ctx(), { since: 'last week' }, { now: () => NOW })).rejects.toThrow(
      CliError,
    );
  });
});
