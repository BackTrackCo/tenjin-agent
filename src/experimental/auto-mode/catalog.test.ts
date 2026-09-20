import { describe, expect, it, vi } from 'vitest';
import fixtures from './fixtures/cdp-demo-resources.json';
import { auditResources, discoverCandidates, snapshotCatalog } from './catalog';

describe('CDP catalog transport and coverage', () => {
  it('preserves rejected records and marks search results as partial', async () => {
    const incomplete = { type: 'http', resource: 'https://unknown.example/action' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ resources: [fixtures.resources[0], incomplete], partialResults: true }),
      );
    const found = await discoverCandidates('a & b', { fetch: fetcher });
    expect(found.resources).toHaveLength(2);
    expect(found.contracts).toHaveLength(1);
    expect(found.rejected).toHaveLength(1);
    expect(found.partial).toBe(true);
    expect(String(fetcher.mock.calls[0]![0])).toContain('query=a+%26+b');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
  });

  it('uses the returned page size and keeps a complete denominator', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ items: [1, 2], pagination: { limit: 2, offset: 0, total: 3 } }),
      )
      .mockResolvedValueOnce(
        Response.json({ items: [3], pagination: { limit: 2, offset: 2, total: 3 } }),
      );
    const snapshot = await snapshotCatalog({ fetch: fetcher, pageSize: 1, maxPages: 3 });
    expect(String(fetcher.mock.calls[1]![0])).toContain('offset=2');
    expect(snapshot).toMatchObject({
      resources: [1, 2, 3],
      reportedTotal: 3,
      complete: true,
      pages: 2,
      reasons: [],
    });
  });

  it('reports budget-limited, changing and resumed snapshots as incomplete', async () => {
    const capped = await snapshotCatalog({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ items: [1], pagination: { offset: 0, limit: 1, total: 100 } }),
        ),
      maxPages: 1,
    });
    expect(capped).toMatchObject({
      complete: false,
      reportedTotal: 100,
      resources: [1],
      reasons: ['page_limit_reached'],
    });
    const changing = await snapshotCatalog({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ items: [1], pagination: { limit: 1, offset: 0, total: 2 } }),
        )
        .mockResolvedValueOnce(
          Response.json({ items: [2], pagination: { limit: 1, offset: 1, total: 3 } }),
        )
        .mockResolvedValueOnce(
          Response.json({ items: [3], pagination: { limit: 1, offset: 2, total: 3 } }),
        ),
      maxPages: 3,
    });
    expect(changing.complete).toBe(false);
    expect(changing.reasons).toContain('catalog_total_changed');
    const resumed = await snapshotCatalog({
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ items: [2], pagination: { offset: 1, limit: 1, total: 2 } }),
        ),
      startOffset: 1,
    });
    expect(resumed.complete).toBe(false);
    expect(resumed.reasons).toContain('resumed_partial_snapshot');
  });

  it('fails explicitly for malformed, oversized and HTTP-error responses', async () => {
    await expect(
      discoverCandidates('test', {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ items: [] })),
      }),
    ).rejects.toThrow('resources missing');
    await expect(
      discoverCandidates('test', {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('fail', { status: 503 })),
      }),
    ).rejects.toThrow('503');
    await expect(
      discoverCandidates('test', {
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response('{}', { headers: { 'content-length': String(9 * 1024 * 1024) } }),
          ),
      }),
    ).rejects.toThrow('8 MiB');
    await expect(
      snapshotCatalog({
        fetch: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json({ items: [1], pagination: { offset: 5, limit: 1, total: 20 } }),
          ),
      }),
    ).rejects.toThrow('contradicts');
  });

  it('gives every row an honest evidence level, including duplicates and malformed entries', () => {
    const report = auditResources([
      ...fixtures.resources,
      fixtures.resources[0],
      null,
      { type: 'mcp', resource: 'https://seller.example/mcp' },
    ]);
    expect(report.total).toBe(5);
    expect(report.contractValidated).toBe(3);
    expect(report.unsupported).toBe(2);
    expect(
      report.rows.every(
        (row) =>
          row.fixtureExecuted === false &&
          row.quoteChecked === false &&
          row.livePaidVerified === false,
      ),
    ).toBe(true);
    expect(report.rows[0]!.paymentOptions.length).toBeGreaterThan(1);
    expect(report.rows[3]!.reasons.length).toBeGreaterThan(0);
  });
});
