import { beforeEach, expect, it, vi } from 'vitest';
import { routeIntent } from './routing';
import { demoCatalog } from './demo-catalog';
import {
  advertisedBaseAtomic,
  evaluatePrices,
  gradePriceDecision,
  priceEvalCases,
  selectPriceCases,
  summarizePrices,
  type PriceEvalCase,
  type PriceEvalResult,
} from './price-eval';

vi.mock('./routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./routing')>()),
  routeIntent: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(routeIntent).mockReset();
});

const cases = priceEvalCases();
const calibration = cases.filter((test) => test.cohort === 'calibration');
const heldout = cases.filter((test) => test.cohort === 'heldout');

it('uses the router conservative maximum and refuses partially unknown prices', () => {
  const contract = calibration[0]!.contracts[0]!;
  const offer = {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo: `0x${'1'.repeat(40)}`,
  };
  expect(
    advertisedBaseAtomic({
      ...contract,
      accepts: [
        { ...offer, amount: '7000' },
        { ...offer, amount: '20000' },
      ],
    }),
  ).toBe('20000');
  expect(() =>
    advertisedBaseAtomic({ ...contract, accepts: [{ ...offer, amount: '7000' }, { ...offer }] }),
  ).toThrow('known conservative Base USDC price ceiling');
});

it('seals held-out cases by default and covers all eight real capabilities', () => {
  expect(calibration).toHaveLength(12);
  expect(heldout).toHaveLength(8);
  expect(selectPriceCases().map((test) => test.id)).toEqual(calibration.map((test) => test.id));
  expect(selectPriceCases('calibration', [heldout[0]!.id])).toEqual([]);
  expect(selectPriceCases('heldout')).toHaveLength(8);
  expect(new Set(cases.map((test) => test.id)).size).toBe(20);
  const real = new Set(demoCatalog().resources.map((resource) => resource.resource));
  const covered = new Set(
    cases
      .flatMap((test) => test.contracts.map((contract) => contract.url))
      .filter((url) => real.has(url)),
  );
  expect(covered).toEqual(real);
});

it('changes only advertised amounts in matched current/high pairs, preserving merchant, task and schema', () => {
  const paired = cases.filter((test) => ['essential', 'optional-benefit'].includes(test.kind));
  for (const group of new Set(paired.map((test) => test.group))) {
    const low = paired.find((test) => test.group === group && test.variant === 'current')!;
    const high = paired.find((test) => test.group === group && test.variant === 'high')!;
    expect(low.context).toEqual(high.context);
    expect(low.event.tool_name).toBe(high.event.tool_name);
    expect(low.event.tool_input).toEqual(high.event.tool_input);
    const original = low.contracts[0]!;
    const changed = high.contracts[0]!;
    expect({ ...original, accepts: undefined }).toEqual({ ...changed, accepts: undefined });
    expect(BigInt(advertisedBaseAtomic(changed))).toBeGreaterThan(
      BigInt(advertisedBaseAtomic(original)),
    );
    for (let index = 0; index < original.accepts.length; index++) {
      const a = original.accepts[index] as Record<string, unknown>;
      const b = changed.accepts[index] as Record<string, unknown>;
      expect({ ...a, amount: undefined, maxAmountRequired: undefined }).toEqual({
        ...b,
        amount: undefined,
        maxAmountRequired: undefined,
      });
      if (a.network !== 'eip155:8453') expect(b).toEqual(a);
    }
  }
});

it('blinds equivalent providers and changes the cheaper candidate position only by swapping prices', () => {
  const [first, second] = cases.filter((test) => test.kind === 'equivalent-offers');
  expect(first!.context).toEqual(second!.context);
  expect(first!.event.tool_input).toEqual(second!.event.tool_input);
  expect(first!.expectedProvider).toBe(first!.contracts[0]!.url);
  expect(second!.expectedProvider).toBe(second!.contracts[1]!.url);
  for (const index of [0, 1]) {
    const a = first!.contracts[index]!;
    const b = second!.contracts[index]!;
    expect({ ...a, accepts: undefined }).toEqual({ ...b, accepts: undefined });
    expect(a.url).toContain('.price-fixture.example/');
    expect(a.description).not.toMatch(/Exa|Firecrawl/);
  }
  expect(first!.prices.map((price) => price.baseAtomic)).toEqual(
    second!.prices.map((price) => price.baseAtomic).reverse(),
  );
});

it('preserves essential capabilities and user restrictions without inventing an optimal dollar threshold', () => {
  const essential = cases.find((test) => test.kind === 'essential' && test.variant === 'high')!;
  expect(gradePriceDecision(essential, { kind: 'native' })).not.toEqual([]);
  expect(gradePriceDecision(essential, { kind: 'defer' })).toEqual([]);
  const optional = cases.find(
    (test) => test.kind === 'optional-benefit' && test.variant === 'high',
  )!;
  expect(gradePriceDecision(optional, { kind: 'native' })).toEqual([]);
  expect(
    gradePriceDecision(optional, {
      kind: 'specialist',
      provider: optional.expectedProvider,
      baseAtomic: optional.prices[0]!.baseAtomic,
    }),
  ).toEqual([]);
  const native = cases.find((test) => test.kind === 'native-control')!;
  expect(
    gradePriceDecision(native, {
      kind: 'specialist',
      provider: native.expectedProvider,
      baseAtomic: '1',
    }),
  ).not.toEqual([]);
  const equivalent = cases.find((test) => test.kind === 'equivalent-offers')!;
  expect(
    gradePriceDecision(equivalent, {
      kind: 'specialist',
      provider: equivalent.contracts[1]!.url,
      baseAtomic: equivalent.prices[1]!.baseAtomic,
    }),
  ).not.toEqual([]);
});

it('records a valid specialist price choice separately from an incomplete binding', async () => {
  const test = calibration[0]!;
  vi.mocked(routeIntent).mockImplementation(
    async (_event, _context, _contracts, choose, options) => {
      expect(options).toEqual({ nativeFallback: true, priceAware: true });
      await choose(
        {},
        {
          route: {
            type: 'choice',
            instructions: 'Choose.',
            criteria: { c0: 'Specialist', native: 'Native', none: 'Defer' },
          },
        },
      );
      return { status: 'needs_input', reason: 'Missing argument.' };
    },
  );
  const results = await evaluatePrices(async () => ({ route: { choice: 'c0' } }), [test]);
  expect(results[0]).toMatchObject({
    decisionPassed: true,
    bindingComplete: false,
    decision: { kind: 'specialist' },
  });
  expect(results[0]!.bindingErrors).toHaveLength(1);
});

function resultFor(test: PriceEvalCase, decision: PriceEvalResult['decision']): PriceEvalResult {
  const decisionFailures = gradePriceDecision(test, decision);
  return {
    id: test.id,
    group: test.group,
    cohort: test.cohort,
    kind: test.kind,
    variant: test.variant,
    expectation: test.expectation,
    expectedProvider: test.expectedProvider,
    prices: test.prices,
    decision,
    decisionPassed: decisionFailures.length === 0,
    decisionFailures,
    bindingComplete: decision.kind === 'specialist' ? true : null,
    bindingErrors: [],
    latencyMs: 0,
  };
}

it('does not count partial groups, deferrals, or held-out cases as completed successful bindings', () => {
  const low = calibration.find((test) => test.kind === 'essential' && test.variant === 'current')!;
  const high = calibration.find((test) => test.group === low.group && test.variant === 'high')!;
  const lowResult = resultFor(low, {
    kind: 'specialist',
    provider: low.expectedProvider,
    baseAtomic: low.prices[0]!.baseAtomic,
  });
  expect(summarizePrices([lowResult], [low]).groups[0]).toMatchObject({
    complete: false,
    invariantsPassed: null,
  });
  const report = summarizePrices([lowResult, resultFor(high, { kind: 'defer' })], [low, high]);
  expect(report.groups[0]).toMatchObject({
    complete: true,
    invariantsPassed: true,
    successfulBindings: 1,
    deferrals: 1,
  });
  expect(report.cohorts).toEqual({
    calibration: {
      completedCases: 2,
      decisionPasses: 2,
      successfulBindings: 1,
      incompleteBindings: 0,
      nativeChoices: 0,
      deferrals: 1,
      priceOnlyPairs: {
        expected: 1,
        evaluated: 1,
        changedChoices: 1,
        unchangedChoices: 0,
        specialistToNativeSwitches: 0,
        specialistToDeferrals: 1,
        providerSwitches: 0,
        optionalBenefitPairs: 0,
        optionalBenefitChoiceChanges: 0,
      },
    },
  });
});

it('counts actual optional choice switches without treating a changed price as a changed choice', () => {
  const low = calibration.find(
    (test) => test.kind === 'optional-benefit' && test.variant === 'current',
  )!;
  const high = calibration.find((test) => test.group === low.group && test.variant === 'high')!;
  const paidLow = resultFor(low, {
    kind: 'specialist',
    provider: low.expectedProvider,
    baseAtomic: low.prices[0]!.baseAtomic,
  });
  const paidHigh = resultFor(high, {
    kind: 'specialist',
    provider: high.expectedProvider,
    baseAtomic: high.prices[0]!.baseAtomic,
  });
  const unchanged = summarizePrices([paidLow, paidHigh], [low, high]);
  expect(unchanged.groups[0]).toMatchObject({
    specialistPreferenceNonIncreasing: true,
    priceResponse: { evaluable: true, choiceChanged: false, specialistToNative: false },
  });
  expect(unchanged.cohorts.calibration?.priceOnlyPairs).toMatchObject({
    evaluated: 1,
    changedChoices: 0,
    unchangedChoices: 1,
    optionalBenefitPairs: 1,
    optionalBenefitChoiceChanges: 0,
  });
  const switched = summarizePrices([paidLow, resultFor(high, { kind: 'native' })], [low, high]);
  expect(switched.cohorts.calibration?.priceOnlyPairs).toMatchObject({
    evaluated: 1,
    changedChoices: 1,
    unchangedChoices: 0,
    specialistToNativeSwitches: 1,
    specialistToDeferrals: 0,
    optionalBenefitChoiceChanges: 1,
  });
  const partial = summarizePrices([paidLow], [low]);
  expect(partial.groups[0]?.priceResponse).toMatchObject({ evaluable: false, choiceChanged: null });
  expect(partial.cohorts.calibration?.priceOnlyPairs).toMatchObject({
    expected: 1,
    evaluated: 0,
    changedChoices: 0,
    unchangedChoices: 0,
  });
});
