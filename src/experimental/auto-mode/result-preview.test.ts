import { describe, expect, it } from 'vitest';
import { previewResult } from './result-preview';
import { hookOutput } from './runtime';

function crowdedResponse() {
  return {
    data: Array.from({ length: 19 }, (_, index) => ({
      // Metadata deliberately precedes the fields the caller needs.
      tags: Array.from({ length: 24 }, (_, tag) => ({
        slug: `tag-${tag}`,
        description: 'verbose metadata '.repeat(30),
        aliases: Array.from({ length: 16 }, () => 'a long alias '.repeat(10)),
      })),
      symbol: ['BTC', 'ETH'][index] ?? `ASSET${index}`,
      quote: [{ currency: 'USD', price: index === 0 ? 12345.67 : 2345.89 }],
      active: true,
    })),
    status: { timestamp: '2026-09-20T00:00:00Z', error: null },
  };
}

describe('bounded provider result preview', () => {
  it('keeps both sibling asset prices despite earlier nested metadata and string arrays', () => {
    const body = JSON.stringify(crowdedResponse());
    const preview = previewResult(body);
    const parsed = JSON.parse(preview.result);
    expect(parsed.data.slice(0, 2)).toMatchObject([
      { symbol: 'BTC', quote: [{ currency: 'USD', price: 12345.67 }], active: true },
      { symbol: 'ETH', quote: [{ currency: 'USD', price: 2345.89 }], active: true },
    ]);
    expect(parsed.status).toEqual({ timestamp: '2026-09-20T00:00:00Z', error: null });
    expect(preview.result.length).toBeLessThanOrEqual(6000);
    expect(preview.format).toBe('json');
    expect(preview.truncated).toBe(true);
    expect(preview.note).toContain('not the complete response');
    expect(preview.note).toContain('full result is saved locally');
    expect(previewResult(body)).toEqual(preview);
    expect(JSON.parse(body).data).toHaveLength(19);
  });

  it('delivers structured JSON within the hook envelope and leaves the saved body untouched', () => {
    const response = { status: 200, headers: {}, body: JSON.stringify(crowdedResponse()) };
    const original = response.body;
    const output = hookOutput({
      status: 'fulfilled',
      execution: { status: 'fulfilled', response },
    }).hookSpecificOutput;
    expect(output.additionalContext.length).toBeLessThan(10000);
    const delivered = JSON.parse(
      output.additionalContext.slice(output.additionalContext.indexOf('\n') + 1),
    );
    expect(delivered.resultFormat).toBe('json');
    expect(JSON.parse(delivered.result).data.slice(0, 2)).toMatchObject([
      { symbol: 'BTC', quote: [{ price: 12345.67 }] },
      { symbol: 'ETH', quote: [{ price: 2345.89 }] },
    ]);
    expect(response.body).toBe(original);
  });

  it('preserves complete small JSON and does not flag whitespace compaction as loss', () => {
    const value = { arbitrary: [{ yes: true, absent: null, zero: 0 }], other: 'unchanged' };
    const preview = previewResult(JSON.stringify(value, null, 20), 256);
    expect(JSON.parse(preview.result)).toEqual(value);
    expect(preview.truncated).toBe(false);
    expect(preview.note).toBeUndefined();
  });

  it('bounds oversized keys, escaped text, and depth without returning broken JSON', () => {
    let nested: unknown = 42;
    for (let depth = 0; depth < 100; depth++) nested = { child: nested };
    for (const value of [{ ['key'.repeat(10000)]: 'value' }, nested, '\u0000'.repeat(10000)]) {
      const preview = previewResult(JSON.stringify(value), 256);
      expect(() => JSON.parse(preview.result)).not.toThrow();
      expect(preview.result.length).toBeLessThanOrEqual(256);
      expect(preview.truncated).toBe(true);
      expect(preview.note).toContain('full result is saved locally');
    }
  });

  it('keeps arbitrary property names without prototype mutation', () => {
    const body = '{"__proto__":{"visible":true},"constructor":"provider data"}';
    const preview = previewResult(body);
    expect(JSON.parse(preview.result)).toEqual(JSON.parse(body));
    expect(Object.prototype).not.toHaveProperty('visible');
  });

  it('labels plain text truncation and rejects invalid preview limits', () => {
    const preview = previewResult('plain text '.repeat(1000), 300);
    expect(preview.format).toBe('text');
    expect(preview.result.length).toBeLessThanOrEqual(300);
    expect(preview.result).toContain('[truncated]');
    expect(preview.truncated).toBe(true);
    expect(() => previewResult('{}', 100)).toThrow('preview limit');
  });
});
