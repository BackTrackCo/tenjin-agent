import { beforeEach, expect, it, vi } from 'vitest';
import { evaluateRouting, routingEvalCases, summarizeNativeValue } from './routing-eval';
import { routeIntent } from './routing';
import type { Choose } from './routing';
import nativeValueFixture from './fixtures/native-value-cases.json';

vi.mock('./routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./routing')>()),
  routeIntent: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(routeIntent).mockReset();
});
const choose: Choose = async () => ({});

it('keeps frozen capability preferences, misleading-keyword cases, and identical catalog choices', () => {
  const all = routingEvalCases();
  const cases = all.filter((test) => test.category === 'native-value');
  expect(cases).toHaveLength(33);
  expect(new Set(all.map((test) => test.id)).size).toBe(all.length);
  expect(cases.filter((test) => test.expected.statuses.includes('selected'))).toHaveLength(19);
  expect(cases.filter((test) => test.expected.statuses.includes('native_fallback'))).toHaveLength(
    14,
  );
  expect(cases.filter((test) => test.evaluationSplit === 'held-out')).toHaveLength(4);
  expect(cases.filter((test) => test.evaluationSplit === 'cross-endpoint')).toHaveLength(13);
  expect(
    new Set(cases.flatMap((test) => (test.expected.url ? [test.expected.url] : []))).size,
  ).toBe(8);
  for (const test of cases) {
    expect(test.nativeFallback).toBe(true);
    expect(test.contracts).toHaveLength(8);
    expect(test.contracts).toEqual(cases[0]!.contracts);
    if (test.expected.url)
      expect(test.contracts.some((contract) => contract.url === test.expected.url)).toBe(true);
  }
  expect(
    all.filter((test) => test.category !== 'native-value').every((test) => !test.nativeFallback),
  ).toBe(true);
  for (const id of [
    'native-research-keyword-is-not-value',
    'native-quick-authoritative-links',
    'native-single-current-public-fact',
    'native-latest-user-revokes-spending',
    'native-only-explicit-page-reading',
  ]) {
    expect(nativeValueFixture.find((test) => test.id === id)?.expected).toBe('native');
  }
  for (const id of [
    'paid-exact-public-page-fetch',
    'paid-known-page-after-research',
    'paid-readable-page-header-lookup',
  ]) {
    expect(nativeValueFixture.find((test) => test.id === id)).toMatchObject({
      expected: 'paid',
      providerUrl: 'https://vaaya.ai/api/run/firecrawl/scrape',
      rationale: expect.stringContaining('Operator preference changed'),
    });
  }
}, 15_000);

it('grades a native decision as success only for a native label and enables the option explicitly', async () => {
  const cases = routingEvalCases();
  const native = cases.find((test) => test.expected.statuses.includes('native_fallback'))!;
  const paid = cases.find(
    (test) => test.nativeFallback && test.expected.statuses.includes('selected'),
  )!;
  vi.mocked(routeIntent).mockResolvedValue({
    status: 'native_fallback',
    reason: 'Native is sufficient.',
  });
  const results = await evaluateRouting(choose, [native, paid]);
  expect(results.map((result) => result.passed)).toEqual([true, false]);
  expect(vi.mocked(routeIntent).mock.calls.every((call) => call[4]?.nativeFallback === true)).toBe(
    true,
  );

  await evaluateRouting(choose, [cases[0]!]);
  expect(vi.mocked(routeIntent).mock.calls[2]).toHaveLength(4);
});

it('allows varied paid providers only when no exact provider was labeled', async () => {
  const paid = routingEvalCases().find(
    (test) => test.nativeFallback && test.expected.statuses.includes('selected'),
  )!;
  const contract = paid.contracts[0]!;
  vi.mocked(routeIntent).mockResolvedValue({
    status: 'selected',
    operation: 'request',
    contract,
    args: { body: { query: 'primary-source payment research' } },
    evidence: {},
  });
  const results = await evaluateRouting(choose, [
    { ...paid, expected: { statuses: ['selected'] } },
    { ...paid, expected: { statuses: ['selected'], url: 'https://wrong-provider.example/query' } },
  ]);
  expect(results.map((result) => result.passed)).toEqual([true, false]);
});

it('records the value decision separately when paid argument binding remains incomplete', async () => {
  const paid = routingEvalCases().find(
    (test) => test.nativeFallback && test.expected.statuses.includes('selected'),
  )!;
  vi.mocked(routeIntent).mockImplementation(async (_event, _context, _contracts, choose) => {
    await choose(
      {},
      {
        route: {
          type: 'choice',
          instructions: 'Choose a strategy.',
          criteria: { native: 'Native lookup.', c0: 'A paid capability.' },
        },
      },
    );
    return { status: 'needs_input', reason: 'A required argument was not supplied.' };
  });
  const results = await evaluateRouting(async () => ({ route: { choice: 'c0' } }), [paid]);
  expect(results[0]).toMatchObject({
    passed: false,
    expectedStrategy: 'paid',
    selectedStrategy: 'paid',
    strategyPassed: true,
    actual: { status: 'needs_input' },
  });
});

it('separates observed calibration cases from new endpoint contrasts and provider failures', () => {
  const provider = 'https://specialist.example/query';
  expect(
    summarizeNativeValue([
      {
        evaluationSplit: 'initial',
        expectedStrategy: 'native',
        strategyPassed: true,
        passed: true,
      },
      {
        evaluationSplit: 'held-out',
        expectedStrategy: 'paid',
        strategyPassed: false,
        passed: false,
      },
      {
        evaluationSplit: 'cross-endpoint',
        expected: { url: provider },
        strategyPassed: true,
        passed: false,
      },
      {
        evaluationSplit: 'cross-endpoint',
        expected: { url: provider },
        strategyPassed: true,
        passed: true,
      },
      { passed: true },
    ]),
  ).toEqual({
    completedCases: 4,
    strategyPassed: 3,
    fullRoutingPassed: 2,
    byEvaluationCohort: {
      calibration: { completedCases: 2, strategyPassed: 1, fullRoutingPassed: 1 },
      'cross-endpoint': { completedCases: 2, strategyPassed: 2, fullRoutingPassed: 1 },
    },
    byExpectedProvider: {
      native: { completedCases: 1, strategyPassed: 1, fullRoutingPassed: 1 },
      'any-paid': { completedCases: 1, strategyPassed: 0, fullRoutingPassed: 0 },
      [provider]: { completedCases: 2, strategyPassed: 2, fullRoutingPassed: 1 },
    },
  });
});
