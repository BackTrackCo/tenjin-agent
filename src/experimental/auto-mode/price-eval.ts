#!/usr/bin/env node
/** Opt-in Jev price experiment. Imports no executor, provider transport, or signer. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { writeFileAtomic } from '../../lib/atomic-json';
import { compileResource } from './contracts';
import type { AutoContract } from './contracts';
import { fingerprint } from './context';
import type { HookEvent, TaskContext } from './context';
import { demoCatalog } from './demo-catalog';
import { advertisedPrice } from './pricing';
import { createJevChooser, routeIntent } from './routing';
import type { Choose, RouteResult } from './routing';
import fixture from './fixtures/price-value-cases.json';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const atomic = z.string().regex(/^[1-9]\d{0,29}$/);
const fixtureSchema = z.object({
  version: z.literal(1),
  disclosure: z.string(),
  groups: z
    .array(
      z.object({
        id: z.string(),
        cohort: z.enum(['calibration', 'heldout']),
        kind: z.enum(['optional-benefit', 'essential', 'equivalent-offers', 'native-control']),
        providerUrl: z.url(),
        task: z.object({
          user: z.string(),
          tool: z.enum(['Request', 'WebSearch', 'WebFetch']),
          input: z.record(z.string(), z.unknown()),
        }),
        requiredBody: z.record(z.string(), z.unknown()).optional(),
        requiredQuery: z.record(z.string(), z.unknown()).optional(),
        equivalenceDisclosure: z.string().optional(),
        variants: z
          .array(
            z.object({
              id: z.string(),
              amountAtomic: atomic.optional(),
              aliasPrices: z.tuple([atomic, atomic]).optional(),
            }),
          )
          .min(1)
          .max(4),
      }),
    )
    .min(1)
    .max(20),
});
const frozen = fixtureSchema.parse(fixture);
type Group = z.infer<typeof fixtureSchema>['groups'][number];
export type PriceCohort = Group['cohort'];

function baseTerm(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const term = value as Record<string, unknown>;
  return (
    term.scheme === 'exact' &&
    term.network === 'eip155:8453' &&
    typeof term.asset === 'string' &&
    term.asset.toLowerCase() === USDC
  );
}

export function advertisedBaseAtomic(contract: AutoContract): string {
  const price = advertisedPrice(contract);
  if (price.status !== 'known')
    throw new Error('Fixture needs a known conservative Base USDC price ceiling.');
  return price.comparisonCeilingAtomic;
}

function usd(amount: string): string {
  const value = BigInt(amount);
  return `${value / 1_000_000n}.${(value % 1_000_000n).toString().padStart(6, '0')}`;
}

/** Only offer amounts change. Contract identity/schema remain paired controls;
 * the report explicitly marks these as synthetic, never executable quotations. */
export function withSyntheticPrice(contract: AutoContract, amount: string): AutoContract {
  atomic.parse(amount);
  advertisedBaseAtomic(contract);
  return {
    ...structuredClone(contract),
    accepts: contract.accepts.map((value) => {
      if (!baseTerm(value)) return structuredClone(value);
      return {
        ...structuredClone(value),
        ...(value.amount === undefined ? {} : { amount }),
        ...(value.maxAmountRequired === undefined ? {} : { maxAmountRequired: amount }),
      };
    }),
  };
}

export interface PriceEvalCase {
  id: string;
  group: string;
  cohort: PriceCohort;
  kind: Group['kind'];
  variant: string;
  event: HookEvent;
  context: TaskContext;
  contracts: AutoContract[];
  expectedProvider: string;
  expectation:
    'specialist' | 'specialist-or-defer' | 'optional-high' | 'cheapest-equivalent' | 'native';
  requiredBody?: Record<string, unknown>;
  requiredQuery?: Record<string, unknown>;
  prices: { url: string; baseAtomic: string; baseUSDC: string; synthetic: boolean }[];
}

export function priceEvalCases(): PriceEvalCase[] {
  const catalog = demoCatalog().resources.map((resource) => {
    const compiled = compileResource(resource);
    if (compiled.status !== 'supported') throw new Error(compiled.reasons.join('; '));
    return compiled.contract;
  });
  return frozen.groups.flatMap((group) => {
    const original = catalog.find((contract) => contract.url === group.providerUrl);
    if (!original) throw new Error(`Missing frozen capability: ${group.id}`);
    return group.variants.map((variant) => {
      const id = `${group.id}:${variant.id}`;
      let contracts: AutoContract[];
      if (group.kind === 'equivalent-offers') {
        if (!variant.aliasPrices) throw new Error('Equivalent offers need two prices.');
        contracts = variant.aliasPrices.map((amount, index) =>
          withSyntheticPrice(
            {
              ...original,
              id: `synthetic-price-alias-${index}`,
              url: `https://provider-${index}.price-fixture.example/search`,
              pathTemplate: '/search',
              description:
                'Synthetic equal-capability search fixture. Both offered services have identical retrieval capabilities and return equivalent query results; neither has a quality advantage. These are not live providers.',
            },
            amount,
          ),
        );
      } else {
        // Isolate incremental price effects. Unproven cross-provider substitutions
        // cannot make a cheap but incompatible service look like a successful route.
        contracts = [
          variant.amountAtomic
            ? withSyntheticPrice(original, variant.amountAtomic)
            : structuredClone(original),
        ];
      }
      const prices = contracts.map((contract) => ({
        url: contract.url,
        baseAtomic: advertisedBaseAtomic(contract),
        baseUSDC: usd(advertisedBaseAtomic(contract)),
        synthetic: variant.amountAtomic !== undefined || variant.aliasPrices !== undefined,
      }));
      const cheapest = prices.reduce((a, b) =>
        BigInt(a.baseAtomic) < BigInt(b.baseAtomic) ? a : b,
      );
      const messages = [{ role: 'user' as const, text: group.task.user }];
      return {
        id,
        group: group.id,
        cohort: group.cohort,
        kind: group.kind,
        variant: variant.id,
        event: {
          hook_event_name: 'PreToolUse' as const,
          session_id: `price-${id}`,
          tool_use_id: `price-${id}`,
          transcript_path: '/not-read-by-eval',
          tool_name: group.task.tool,
          tool_input: structuredClone(group.task.input),
        },
        context: { messages, fingerprint: fingerprint(messages) },
        contracts,
        expectedProvider: group.kind === 'equivalent-offers' ? cheapest.url : original.url,
        expectation:
          group.kind === 'native-control'
            ? ('native' as const)
            : group.kind === 'equivalent-offers'
              ? ('cheapest-equivalent' as const)
              : variant.id === 'current'
                ? ('specialist' as const)
                : group.kind === 'essential'
                  ? ('specialist-or-defer' as const)
                  : ('optional-high' as const),
        requiredBody: group.requiredBody,
        requiredQuery: group.requiredQuery,
        prices,
      };
    });
  });
}

export function selectPriceCases(
  cohort: PriceCohort | 'all' = 'calibration',
  ids?: string[],
): PriceEvalCase[] {
  return priceEvalCases().filter(
    (test) => (cohort === 'all' || test.cohort === cohort) && (!ids || ids.includes(test.id)),
  );
}

type Decision =
  | { kind: 'specialist'; provider: string; baseAtomic: string }
  | { kind: 'native' | 'defer' | 'not-completed' };
export interface PriceEvalResult {
  id: string;
  group: string;
  cohort: PriceCohort;
  kind: Group['kind'];
  variant: string;
  expectation: PriceEvalCase['expectation'];
  expectedProvider: string;
  prices: PriceEvalCase['prices'];
  decision: Decision;
  decisionPassed: boolean;
  decisionFailures: string[];
  bindingComplete: boolean | null;
  bindingErrors: string[];
  latencyMs: number;
  actual?: unknown;
  error?: string;
}

export function gradePriceDecision(test: PriceEvalCase, decision: Decision): string[] {
  const specialist = decision.kind === 'specialist' && decision.provider === test.expectedProvider;
  const accepted =
    test.expectation === 'native'
      ? decision.kind === 'native'
      : test.expectation === 'specialist-or-defer'
        ? specialist || decision.kind === 'defer'
        : test.expectation === 'optional-high'
          ? specialist || decision.kind === 'native' || decision.kind === 'defer'
          : specialist;
  return accepted ? [] : ['Choice does not meet the frozen capability/constraint expectation.'];
}

function bindingErrors(test: PriceEvalCase, result: RouteResult): string[] {
  if (result.status !== 'selected')
    return ['The selected specialist did not produce a complete argument set.'];
  const errors: string[] = [];
  for (const [binding, required] of [
    ['body', test.requiredBody],
    ['query', test.requiredQuery],
  ] as const) {
    const actual = result.args[binding] as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(required ?? {}))
      if (JSON.stringify(actual?.[key]) !== JSON.stringify(value))
        errors.push(`${binding}.${key} differs from the frozen required argument.`);
  }
  return errors;
}

export async function evaluatePrices(
  choose: Choose,
  cases = selectPriceCases(),
  onResult?: (results: PriceEvalResult[]) => Promise<void>,
) {
  const results: PriceEvalResult[] = [];
  for (const test of cases) {
    const started = Date.now();
    let decision: Decision = { kind: 'not-completed' };
    let result: RouteResult | undefined;
    let error: string | undefined;
    const observed: Choose = async (state, questions) => {
      const answer = await choose(state, questions);
      if (questions.route) {
        const choice = answer.route?.choice;
        if (choice === 'native') decision = { kind: 'native' };
        else if (choice === 'none') decision = { kind: 'defer' };
        else if (
          choice &&
          /^c\d+$/.test(choice) &&
          Object.hasOwn(questions.route.criteria, choice)
        ) {
          const contract = test.contracts[Number(choice.slice(1))];
          if (contract)
            decision = {
              kind: 'specialist',
              provider: contract.url,
              baseAtomic: advertisedBaseAtomic(contract),
            };
        }
      }
      return answer;
    };
    try {
      result = await routeIntent(test.event, test.context, test.contracts, observed, {
        nativeFallback: true,
        priceAware: true,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Price routing failed.';
    }
    const choice = decision as Decision; // Assignment occurs in the awaited chooser callback.
    const failures = gradePriceDecision(test, choice);
    if (error) failures.push('Routing raised an error.');
    const errors =
      choice.kind === 'specialist'
        ? result
          ? bindingErrors(test, result)
          : ['Routing failed before arguments were completed.']
        : [];
    results.push({
      id: test.id,
      group: test.group,
      cohort: test.cohort,
      kind: test.kind,
      variant: test.variant,
      expectation: test.expectation,
      expectedProvider: test.expectedProvider,
      prices: test.prices,
      decision: choice,
      decisionPassed: failures.length === 0,
      decisionFailures: failures,
      bindingComplete: choice.kind === 'specialist' ? errors.length === 0 : null,
      bindingErrors: errors,
      latencyMs: Date.now() - started,
      ...(result
        ? {
            actual:
              result.status === 'selected'
                ? {
                    status: result.status,
                    provider: result.contract.url,
                    args: result.args,
                    evidence: result.evidence,
                  }
                : result,
          }
        : {}),
      ...(error ? { error } : {}),
    });
    await onResult?.(results);
  }
  return results;
}

/** No arbitrary price threshold is scored as truth. Optional pairs report their
 * observed response; capability preservation and equivalent-offer dominance are
 * separate invariants. A partial pair is never counted as a passing group. */
export function summarizePrices(results: PriceEvalResult[], cases: PriceEvalCase[]) {
  const all = priceEvalCases();
  const groups = [...new Set(cases.map((test) => test.group))].map((id) => {
    const expected = all.filter((test) => test.group === id);
    const rows = results.filter((item) => item.group === id);
    const complete = expected.every((test) => rows.some((row) => row.id === test.id));
    const low = rows.find((row) => row.variant === 'current');
    const high = rows.find((row) => row.variant === 'high');
    const known = (row: PriceEvalResult | undefined) =>
      row && row.decision.kind !== 'not-completed';
    const optional = expected[0]!.kind === 'optional-benefit';
    const pricePair =
      expected.some((test) => test.variant === 'current') &&
      expected.some((test) => test.variant === 'high');
    const comparable = Boolean(complete && known(low) && known(high));
    // A changed offer amount is the treatment, not itself a changed choice.
    const choiceKey = (decision: Decision) =>
      decision.kind === 'specialist' ? `${decision.kind}:${decision.provider}` : decision.kind;
    const monotonic =
      complete && known(low) && known(high)
        ? Number(high!.decision.kind === 'specialist') <=
          Number(low!.decision.kind === 'specialist')
        : null;
    return {
      group: id,
      cohort: expected[0]!.cohort,
      kind: expected[0]!.kind,
      complete,
      invariantsPassed: complete
        ? rows.every((row) => row.decisionPassed) && (!optional || monotonic === true)
        : null,
      ...(pricePair
        ? {
            priceResponse: {
              evaluable: comparable,
              choiceChanged: comparable
                ? choiceKey(low!.decision) !== choiceKey(high!.decision)
                : null,
              specialistToNative: comparable
                ? low!.decision.kind === 'specialist' && high!.decision.kind === 'native'
                : null,
              specialistToDeferral: comparable
                ? low!.decision.kind === 'specialist' && high!.decision.kind === 'defer'
                : null,
              providerChanged: comparable
                ? low!.decision.kind === 'specialist' &&
                  high!.decision.kind === 'specialist' &&
                  low!.decision.provider !== high!.decision.provider
                : null,
            },
          }
        : {}),
      ...(optional
        ? {
            specialistPreferenceNonIncreasing: monotonic,
            observedHighPriceResponse: high?.decision.kind ?? 'not-run',
            thresholdIsNotGroundTruth: true,
          }
        : {}),
      successfulBindings: rows.filter((row) => row.bindingComplete === true).length,
      incompleteBindings: rows.filter((row) => row.bindingComplete === false).length,
      deferrals: rows.filter((row) => row.decision.kind === 'defer').length,
    };
  });
  return {
    cohorts: Object.fromEntries(
      (['calibration', 'heldout'] as const).flatMap((cohort) => {
        const rows = results.filter((row) => row.cohort === cohort);
        if (!rows.length) return [];
        const pairs = groups.filter((group) => group.cohort === cohort && group.priceResponse);
        const evaluated = pairs.filter((group) => group.priceResponse?.evaluable);
        return [
          [
            cohort,
            {
              completedCases: rows.length,
              decisionPasses: rows.filter((row) => row.decisionPassed).length,
              successfulBindings: rows.filter((row) => row.bindingComplete === true).length,
              incompleteBindings: rows.filter((row) => row.bindingComplete === false).length,
              nativeChoices: rows.filter((row) => row.decision.kind === 'native').length,
              deferrals: rows.filter((row) => row.decision.kind === 'defer').length,
              priceOnlyPairs: {
                expected: pairs.length,
                evaluated: evaluated.length,
                changedChoices: evaluated.filter(
                  (group) => group.priceResponse?.choiceChanged === true,
                ).length,
                unchangedChoices: evaluated.filter(
                  (group) => group.priceResponse?.choiceChanged === false,
                ).length,
                specialistToNativeSwitches: evaluated.filter(
                  (group) => group.priceResponse?.specialistToNative === true,
                ).length,
                specialistToDeferrals: evaluated.filter(
                  (group) => group.priceResponse?.specialistToDeferral === true,
                ).length,
                providerSwitches: evaluated.filter(
                  (group) => group.priceResponse?.providerChanged === true,
                ).length,
                optionalBenefitPairs: evaluated.filter((group) => group.kind === 'optional-benefit')
                  .length,
                optionalBenefitChoiceChanges: evaluated.filter(
                  (group) =>
                    group.kind === 'optional-benefit' &&
                    group.priceResponse?.choiceChanged === true,
                ).length,
              },
            },
          ],
        ];
      }),
    ),
    groups,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'env-file': { type: 'string' },
      output: { type: 'string' },
      model: { type: 'string', default: 'jev-latest' },
      cohort: { type: 'string', default: 'calibration' },
      case: { type: 'string', multiple: true },
      'max-calls': { type: 'string', default: '60' },
    },
  });
  if (!values.output)
    throw new Error('Pass --output <report.json> for this opt-in Jev-only experiment.');
  const cohort = z.enum(['calibration', 'heldout', 'all']).parse(values.cohort);
  const maxCalls = Number(values['max-calls']);
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 100)
    throw new Error('--max-calls must be from 1 through 100.');
  const cases = selectPriceCases(cohort, values.case);
  if (!cases.length) throw new Error('No requested cases matched the explicitly selected cohort.');
  const env = values['env-file'] ? parseEnv(await readFile(values['env-file'], 'utf8')) : {};
  const apiKey =
    process.env.TYPESAFE_API_KEY ??
    process.env.TYPESAFE_KEY ??
    env.TYPESAFE_API_KEY ??
    env.TYPESAFE_KEY;
  if (!apiKey) throw new Error('A TypeSafe key is required; keys are never included in reports.');
  const live = createJevChooser({ apiKey, model: values.model, timeoutMs: 15_000 });
  let calls = 0;
  const choose: Choose = async (state, questions) => {
    if (calls >= maxCalls) throw new Error('Explicit Jev request-count cap reached.');
    calls++;
    return live(state, questions);
  };
  const startedAt = new Date().toISOString();
  const save = async (results: PriceEvalResult[]) => {
    await writeFileAtomic(
      resolve(values.output!),
      JSON.stringify(
        {
          version: 1,
          startedAt,
          model: values.model,
          cohort,
          disclosure: frozen.disclosure,
          fixtureHash: fingerprint(fixture),
          catalogFixtureHash: fingerprint(demoCatalog().resources),
          expectedCases: cases.length,
          completedCases: results.length,
          jevCalls: calls,
          maxJevCalls: maxCalls,
          providerRequests: 0,
          paymentSignatures: 0,
          ...summarizePrices(results, cases),
          results,
        },
        null,
        2,
      ),
      { mode: 0o600, dirMode: 0o700 },
    );
    process.stderr.write(
      `Price eval: ${results.length}/${cases.length} cases; ${calls}/${maxCalls} Jev calls.\n`,
    );
  };
  const results = await evaluatePrices(choose, cases, save);
  const summary = summarizePrices(results, cases);
  process.stdout.write(
    `${JSON.stringify({ report: resolve(values.output), ...summary.cohorts, jevCalls: calls, providerRequests: 0, paymentSignatures: 0 })}\n`,
  );
  if (
    results.some((row) => !row.decisionPassed || row.bindingComplete === false) ||
    summary.groups.some((group) => group.invariantsPassed === false)
  )
    process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Price evaluation failed.'}\n`,
    );
    process.exitCode = 1;
  });
}
