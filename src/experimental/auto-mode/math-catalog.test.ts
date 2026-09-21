import { describe, expect, it } from 'vitest';
import math from './fixtures/cdp-math-resources.json';
import { buildRequest, compileResource, validateArguments } from './contracts';
import type { AutoContract } from './contracts';

function contract(resource: unknown): AutoContract {
  const result = compileResource(resource);
  if (result.status !== 'supported') throw new Error(result.reasons.join('; '));
  return result.contract;
}

describe('curated math contracts', () => {
  it.each([math])('keeps raw CDP records and isolates documented schema corrections', (fixture) => {
    for (const [index, derived] of fixture.resources.entries()) {
      const raw = fixture.rawResources[index]!;
      expect(derived.resource).toBe(raw.resource);
      expect(derived.accepts).toEqual(raw.accepts);
      expect(derived.x402Version).toBe(raw.x402Version);
      expect(derived.extensions.bazaar.info).toEqual(raw.extensions.bazaar.info);
      expect(fixture.translations[index]?.resource).toBe(raw.resource);
      expect(fixture.translations[index]?.documentationUrl).toMatch(/^https:\/\//);
      // Replacing only the documented binding restores the entire raw record.
      const restored = structuredClone(derived) as Record<string, unknown>;
      const pointer = fixture.translations[index]!.fields[0]!.split('.');
      let target = restored;
      let source = raw as Record<string, unknown>;
      for (const key of pointer.slice(0, -1)) {
        target = target[key] as Record<string, unknown>;
        source = source[key] as Record<string, unknown>;
      }
      const key = pointer.at(-1)!;
      target[key] = source[key];
      expect(restored).toEqual(raw);
    }
  });

  it('records paid task evidence separately from HTTP and settlement success', () => {
    const evidence = math.verification.paidExecution;
    expect(math.verification.livePaidVerified).toBe(true);
    expect(math.verification.quoteChecked).toBe(true);
    expect(evidence.calls).toHaveLength(2);
    expect(evidence.calls[0]).toMatchObject({ httpStatus: 200, querySuccess: false, podCount: 0 });
    const successful = evidence.calls.filter((call) => call.querySuccess && call.podCount > 0);
    expect(successful).toHaveLength(1);
    expect(successful[0]).toBe(evidence.calls[1]);
    const translated = contract(math.resources[0]);
    for (const call of evidence.calls) {
      expect(call.resource).toBe(translated.url);
      expect(validateArguments(translated, call.args).valid).toBe(true);
      expect(new URL(buildRequest(translated, call.args).url).searchParams.get('input')).toBe(
        call.args.query.input,
      );
      expect(call.settlementStatus).toBe('reported');
    }
    const total = evidence.calls.reduce((sum, call) => sum + BigInt(call.amountAtomic), 0n);
    expect(total.toString()).toBe(evidence.totalAmountAtomic);
    expect(Number(total) / 1_000_000).toBe(Number(evidence.totalUsdc));
    expect(evidence.result.exact).toBe('pi^2 - 4');
    expect(evidence.result.providerPlaintext).toContain('π^2 - 4');
    expect(evidence.result.approximate).toBeCloseTo(Math.PI ** 2 - 4, 12);
    expect(evidence.result.finalAnswerMatched).toBe(true);
    expect(evidence.chainVerified).toBe(false);
  });

  it('restores Wolfram inputs explicitly and requires JSON output', () => {
    const raw = contract(math.rawResources[0]);
    expect(
      validateArguments(raw, { query: { input: 'integrate x^2 dx', output: 'json' } }).valid,
    ).toBe(false);
    const translated = contract(math.resources[0]);
    const request = buildRequest(translated, {
      query: { input: 'integrate x^2 dx', output: 'json', format: 'plaintext' },
    });
    const url = new URL(request.url);
    expect(url.origin + url.pathname).toBe(math.rawResources[0]!.resource);
    expect(request.method).toBe('GET');
    expect(url.searchParams.get('input')).toBe('integrate x^2 dx');
    expect(url.searchParams.get('output')).toBe('json');
    for (const query of [
      { input: 'integrate x^2 dx' },
      { input: '', output: 'json' },
      { input: '2+2', output: 'xml' },
      { input: '2+2', output: 'json', appid: 'untrusted' },
    ])
      expect(validateArguments(translated, { query }).valid).toBe(false);
  });
});
