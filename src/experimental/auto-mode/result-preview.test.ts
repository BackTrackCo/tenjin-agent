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
  it.each(['markdown', 'arbitraryPayloadName'])(
    'retains document substance in %s instead of spending its budget on metadata',
    (field) => {
      const heading = '# Protocol specification';
      const overview =
        '## Overview\nThe client requests a resource, receives payment requirements, and retries with authorization.';
      const document =
        `${'Navigation text. '.repeat(200).slice(0, 2700)}${heading}\n`.padEnd(4200, '.') +
        `${overview}\n${'Protocol details. '.repeat(1700)}`;
      const metadata = Object.fromEntries(
        Array.from({ length: 70 }, (_, index) => [
          `attribute${index}`,
          `Auxiliary metadata ${index}. `.repeat(5),
        ]),
      );
      const value = {
        ok: true,
        source: 'https://documents.example/protocol',
        data: { success: true, data: { metadata, [field]: document } },
      };
      const body = JSON.stringify(value);
      const preview = previewResult(body, 6000);
      const parsed = JSON.parse(preview.result);
      const delivered = parsed.data.data[field];
      expect(document.length).toBeGreaterThan(30_000);
      expect(delivered).toContain(heading);
      expect(delivered).toContain(overview);
      expect(delivered.slice(0, 4500)).toBe(document.slice(0, 4500));
      expect(parsed).toMatchObject({ ok: true, source: value.source, data: { success: true } });
      expect(Object.keys(parsed.data.data.metadata).length).toBeLessThan(70);
      expect(preview.result.length).toBeLessThanOrEqual(6000);
      expect(preview).toMatchObject({ format: 'json', truncated: true });
      expect(preview.note).toContain('full result is saved locally');
      expect(previewResult(body, 6000)).toEqual(preview);
      expect(JSON.parse(body)).toEqual(value);
    },
  );

  it('shares space across comparable long values even when they follow many small fields', () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 70 }, (_, i) => [`label${i}`, `value${i}`]),
    );
    const value = {
      success: true,
      pages: {
        ...metadata,
        first: 'First document. '.repeat(2000),
        second: 'Second document. '.repeat(2000),
      },
    };
    const preview = previewResult(JSON.stringify(value));
    const parsed = JSON.parse(preview.result);
    expect(parsed.success).toBe(true);
    expect(parsed.pages.first.slice(0, 2000)).toBe(value.pages.first.slice(0, 2000));
    expect(parsed.pages.second.slice(0, 2000)).toBe(value.pages.second.slice(0, 2000));
    expect(preview.result.length).toBeLessThanOrEqual(6000);
    expect(preview.truncated).toBe(true);
  });

  it('retains late provenance scalars alongside dominant prose under the same budget', () => {
    const metadata = {
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          `og:image:${index}`,
          `https://images.example/social-preview-${index}.png`,
        ]),
      ),
      title: 'How the payment protocol works — Developer documentation',
      sourceURL: 'https://docs.example/payment-protocol/how-it-works',
      statusCode: 200,
    };
    const document =
      '# Payment protocol\n' +
      'The client requests a resource and receives payment requirements. '.repeat(700);
    const value = { ok: true, data: { success: true, data: { metadata, markdown: document } } };
    const body = JSON.stringify(value);
    const preview = previewResult(body);
    const parsed = JSON.parse(preview.result);
    expect(parsed.data.data.metadata).toMatchObject({
      title: metadata.title,
      sourceURL: metadata.sourceURL,
      statusCode: 200,
    });
    expect(parsed.data.data.markdown.slice(0, 4500)).toBe(document.slice(0, 4500));
    expect(Object.keys(parsed.data.data.metadata).length).toBeLessThan(
      Object.keys(metadata).length,
    );
    expect(preview.result.length).toBeLessThanOrEqual(6000);
    expect(preview.truncated).toBe(true);
    expect(previewResult(body)).toEqual(preview);
    expect(JSON.parse(body)).toEqual(value);
  });

  it('preserves bounded provenance ancestors and does not let repeated URL fields consume prose', () => {
    const value = {
      images: Array.from({ length: 60 }, (_, index) => ({
        url: `https://images.example/${index}.png`,
      })),
      ...Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [`field${index}`, 'auxiliary']),
      ),
      details: {
        title: 'Canonical document title',
        source_url: 'https://docs.example/canonical',
        status_code: 200,
      },
      document: 'Verified document substance. '.repeat(2000),
    };
    const preview = previewResult(JSON.stringify(value));
    const parsed = JSON.parse(preview.result);
    expect(parsed.details).toEqual(value.details);
    expect(parsed.images.length).toBeLessThan(10);
    expect(parsed.document.slice(0, 4500)).toBe(value.document.slice(0, 4500));
    expect(preview.result.length).toBeLessThanOrEqual(6000);
    expect(preview.truncated).toBe(true);
  });

  it('narrows nested auxiliary objects before they crowd out the main document', () => {
    const document = `${'Navigation. '.repeat(250)}\n# Actual document\n${'Substance. '.repeat(3000)}`;
    const auxiliary = Object.fromEntries(
      Array.from({ length: 8 }, (_, outer) => [
        `group${outer}`,
        Object.fromEntries(
          Array.from({ length: 8 }, (_, inner) => [`label${inner}`, 'Metadata. '.repeat(5)]),
        ),
      ]),
    );
    const preview = previewResult(JSON.stringify({ auxiliary, document, success: true }));
    const parsed = JSON.parse(preview.result);
    expect(parsed.document.slice(0, 4500)).toBe(document.slice(0, 4500));
    expect(parsed.document).toContain('# Actual document');
    expect(parsed.success).toBe(true);
    expect(preview.result.length).toBeLessThanOrEqual(6000);
    expect(preview.truncated).toBe(true);
  });

  it('measures escaped prose as serialized JSON and preserves Unicode boundaries', () => {
    const value = { root: { text: '\n"\\🙂'.repeat(6000) }, status: 200 };
    for (const limit of [256, 1000, 6000]) {
      const preview = previewResult(JSON.stringify(value), limit);
      const parsed = JSON.parse(preview.result);
      expect(parsed.status).toBe(200);
      expect(parsed.root.text).toContain('chars omitted');
      expect(parsed.root.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(preview.result.length).toBeLessThanOrEqual(limit);
      expect(preview.truncated).toBe(true);
    }
  });

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
