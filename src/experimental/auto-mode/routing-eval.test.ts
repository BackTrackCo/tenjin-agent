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
  expect(cases).toHaveLength(38);
  expect(new Set(all.map((test) => test.id)).size).toBe(all.length);
  expect(cases.filter((test) => test.expected.statuses.includes('selected'))).toHaveLength(21);
  expect(cases.filter((test) => test.expected.statuses.includes('native_fallback'))).toHaveLength(
    17,
  );
  expect(cases.filter((test) => test.evaluationSplit === 'held-out')).toHaveLength(4);
  expect(cases.filter((test) => test.evaluationSplit === 'cross-endpoint')).toHaveLength(13);
  expect(cases.filter((test) => test.evaluationSplit === 'regression')).toHaveLength(5);
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
    all
      .filter((test) => !['native-value', 'compound-scope'].includes(test.category))
      .every((test) => !test.nativeFallback),
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

it('labels natural math regressions without requiring provider names or engine instructions', () => {
  const cases = routingEvalCases().filter(
    (test) => test.category === 'native-value' && test.evaluationSplit === 'regression',
  );
  expect(cases.map((test) => test.id)).toEqual([
    '84-paid-natural-definite-integral',
    '85-paid-natural-numerical-root',
    '86-native-natural-multiplication',
    '87-native-natural-integral-explanation',
    '88-native-natural-integral-by-hand-correction',
  ]);
  expect(cases[0]!.event.tool_input.query).toBe('integrate x^2 sin(x) dx from 0 to pi');
  for (const test of cases.slice(0, 2)) {
    expect(test.context.messages).toEqual([{ role: 'user', text: test.event.tool_input.query }]);
    expect(JSON.stringify(test.context.messages)).not.toMatch(/wolfram|engine|verify/i);
    expect(test.expected).toEqual({
      statuses: ['selected'],
      url: 'https://wolframalpha.x402.paysponge.com/v2/query',
      requiredQuery: { input: test.event.tool_input.query, output: 'json' },
    });
  }
  for (const test of cases.slice(2, 4)) expect(test.expected.statuses).toEqual(['native_fallback']);
  expect(cases[4]!.expected.statuses).toEqual(['native_fallback', 'needs_input']);
  expect(cases[4]!.context.messages.at(-1)?.text).toContain("don't use any paid services");
});

it('freezes compound research failures and narrowed controls against the same full catalog', () => {
  const cases = routingEvalCases().filter((test) => test.category === 'compound-scope');
  expect(cases.map((test) => test.id)).toEqual([
    '89-compound-research-observed-1',
    '90-compound-research-observed-2',
    '91-compound-company-research-firmographics',
    '92-compound-research-then-explicit-price-refresh',
    '93-compound-research-needed-measurement-substep',
    '94-compound-company-research-then-enrichment',
  ]);
  for (const test of cases) {
    expect(test.nativeFallback).toBe(true);
    expect(test.evaluationSplit).toBe('regression');
    expect(test.contracts).toHaveLength(8);
    expect(test.contracts).toEqual(cases[0]!.contracts);
    expect(test.contracts.some((contract) => contract.url === test.expected.url)).toBe(true);
  }
  for (const test of cases.slice(0, 3))
    expect(test.expected).toEqual({ statuses: ['selected'], url: 'https://api.exa.ai/search' });
  for (const test of cases.slice(0, 2)) {
    expect(test.context.messages).toEqual([
      { role: 'user', text: 'can you research BTC and ETH for someone new to crypto' },
    ]);
    expect(test.event.tool_input.query).toContain('current price and market cap');
    expect(test.event.tool_input.query).toContain('Research Bitcoin (BTC) and Ethereum (ETH)');
  }
  for (const test of cases.slice(3, 5))
    expect(test.expected.exactQueryAlternatives).toEqual([
      { symbol: 'BTC,ETH' },
      { symbol: 'BTC,ETH', convert: 'USD' },
    ]);
  expect(cases[3]!.context.messages.at(-1)?.text).toBe('Check price for both now');
  expect(cases[4]!.context.messages.at(-1)?.text).toContain('Research BTC and ETH');
  expect(cases[4]!.event.tool_input.query).toBe('Get current USD price quotes for BTC and ETH.');
  expect(cases[5]!.expected.exactBody).toEqual({ domain: 'stripe.com' });
  expect(cases[5]!.context.messages.at(-1)?.text).toBe(
    'Now get company enrichment data for stripe.com.',
  );
});

it('accepts explicit USD quote bindings while rejecting wrong targets, currencies and extra selectors', async () => {
  const test = routingEvalCases().find(
    (item) => item.id === '92-compound-research-then-explicit-price-refresh',
  )!;
  const contract = test.contracts.find((item) => item.url === test.expected.url)!;
  const queries = [
    { symbol: 'BTC,ETH' },
    { convert: 'USD', symbol: 'BTC,ETH' },
    { symbol: 'BTC' },
    { symbol: 'BTC,ETH', convert: 'EUR' },
    { symbol: 'BTC,ETH', id: '1' },
  ];
  for (const query of queries)
    vi.mocked(routeIntent).mockResolvedValueOnce({
      status: 'selected',
      operation: 'request',
      contract,
      args: { query },
      evidence: {},
    });
  const results = await evaluateRouting(
    choose,
    queries.map(() => test),
  );
  expect(results.map((result) => result.passed)).toEqual([true, true, false, false, false]);
  for (const result of results.slice(2))
    expect(result.failures).toEqual([
      'Query differs from every labeled exact request alternative.',
    ]);
});

it('fails a valid incidental-record request when broad research was the labeled purpose', async () => {
  const test = routingEvalCases().find((item) => item.id === '89-compound-research-observed-1')!;
  const research = test.contracts.find((item) => item.url === test.expected.url)!;
  const quotes = test.contracts.find((item) => item.url.includes('coinmarketcap'))!;
  expect(quotes).toBeDefined();
  vi.mocked(routeIntent)
    .mockResolvedValueOnce({
      status: 'selected',
      operation: 'request',
      contract: research,
      args: { body: { query: test.event.tool_input.query } },
      evidence: {},
    })
    .mockResolvedValueOnce({
      status: 'selected',
      operation: 'request',
      contract: quotes,
      args: { query: { symbol: 'BTC,ETH' } },
      evidence: {},
    });
  const results = await evaluateRouting(choose, [test, test]);
  expect(results.map((result) => result.passed)).toEqual([true, false]);
  expect(results[1]!.failures).toEqual([
    'Selected endpoint differs from the labeled provider/capability.',
  ]);
});

it('requires the natural math expression and JSON output to survive argument binding', async () => {
  const test = routingEvalCases().find((item) => item.id === '84-paid-natural-definite-integral')!;
  const contract = test.contracts.find((item) => item.url === test.expected.url)!;
  const query = test.expected.requiredQuery!;
  vi.mocked(routeIntent)
    .mockResolvedValueOnce({
      status: 'selected',
      operation: 'request',
      contract,
      args: { query },
      evidence: {},
    })
    .mockResolvedValueOnce({
      status: 'selected',
      operation: 'request',
      contract,
      args: { query: { ...query, input: 'integrate x^2 dx' } },
      evidence: {},
    })
    .mockResolvedValueOnce({
      status: 'selected',
      operation: 'request',
      contract,
      args: { query: { ...query, output: 'xml' } },
      evidence: {},
    });
  const results = await evaluateRouting(choose, [test, test, test]);
  expect(results.map((result) => result.passed)).toEqual([true, false, false]);
  expect(results[1]!.failures).toEqual(['query.input differs from the labeled required argument.']);
  expect(results[2]!.failures).toEqual([
    'query.output differs from the labeled required argument.',
  ]);
});

it('forwards opt-in demo routing settings and records them without changing historical defaults', async () => {
  const cases = routingEvalCases();
  const math = cases.find((item) => item.evaluationSplit === 'regression')!;
  const legacy = cases[0]!;
  const options = { priceAware: true, nativeWebFetch: false };
  vi.mocked(routeIntent).mockResolvedValue({ status: 'needs_input', reason: 'Test deferral.' });
  const results = await evaluateRouting(choose, [math, legacy], undefined, options);
  expect(vi.mocked(routeIntent).mock.calls[0]![4]).toEqual({
    nativeFallback: true,
    ...options,
  });
  expect(vi.mocked(routeIntent).mock.calls[1]![4]).toEqual(options);
  expect(results[0]).toMatchObject({
    evaluationSplit: 'regression',
    routingOptions: { nativeFallback: true, ...options },
  });
  expect(results[1]).toMatchObject({ routingOptions: options });
  await evaluateRouting(choose, [legacy]);
  expect(vi.mocked(routeIntent).mock.calls[2]).toHaveLength(4);
});

it.each(['native', 'none'] as const)(
  'allows %s for a by-hand/no-paid correction and counts it as calibration',
  async (choice) => {
    const test = routingEvalCases().find(
      (item) => item.id === '88-native-natural-integral-by-hand-correction',
    )!;
    vi.mocked(routeIntent).mockImplementation(async (_event, _context, _contracts, choose) => {
      await choose(
        {},
        {
          route: {
            type: 'choice',
            instructions: 'Choose a strategy.',
            criteria: { native: 'Native reasoning.', none: 'Decline.', c0: 'Paid computation.' },
          },
        },
      );
      return choice === 'native'
        ? { status: 'native_fallback', reason: 'Work by hand.' }
        : { status: 'needs_input', reason: 'Preserve the no-paid restriction.' };
    });
    const results = await evaluateRouting(async () => ({ route: { choice } }), [test]);
    expect(results[0]).toMatchObject({
      passed: true,
      strategyPassed: true,
      selectedStrategy: choice === 'native' ? 'native' : 'abstain',
      evaluationSplit: 'regression',
    });
    expect(summarizeNativeValue(results).byEvaluationCohort).toEqual({
      calibration: { completedCases: 1, strategyPassed: 1, fullRoutingPassed: 1 },
    });
  },
);

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
