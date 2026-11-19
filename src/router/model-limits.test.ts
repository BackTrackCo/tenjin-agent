import { expect, it } from 'vitest';
import {
  compactWindowTokens,
  fittingOutputTokens,
  offeredOutputTokens,
  MODEL_MINIMUM_CALL_ATOMIC,
  MODEL_OUTPUT_TOKENS,
  modelPeakQuoteAtomic,
  usdOfAtomic,
} from './model-limits';

// The floor was a literal for a 32K output (44,611) while workers asked 65,536, so a job
// ceiling between $0.0446 and $0.0869 admitted a job that could not fit one call.
it('derives the call floor from the output cap with the router quote formula', () => {
  expect(MODEL_OUTPUT_TOKENS).toBe(65_536);
  expect(MODEL_MINIMUM_CALL_ATOMIC).toBe(83_866n);
  expect(usdOfAtomic(MODEL_MINIMUM_CALL_ATOMIC)).toBe('$0.083866');
  // The router's own figures: a zero-byte 32,000-token quote was 41,611; other caps follow.
  expect(modelPeakQuoteAtomic(0, 32_000)).toBe(41_611n);
  expect(modelPeakQuoteAtomic(0, 128_000)).toBe(162_571n);
  expect(modelPeakQuoteAtomic(0, 256_000)).toBe(323_851n);
  // Input is bound by the model's context, as the router bounds it.
  expect(modelPeakQuoteAtomic(10_000_000, 0)).toBe(modelPeakQuoteAtomic(1_048_576, 0));
});

// Operator ruling 2026-11-18: 256,000 output tokens, the DeepSeek harness's cap, on a
// router that says it accepts them. A worker asked 65,536 of every router.
it("reads a job's output cap from its offer alone, up to 256,000", () => {
  expect(offeredOutputTokens({ maxOutputTokens: 256_000 })).toBe(256_000);
  expect(offeredOutputTokens({ maxOutputTokens: 128_000 })).toBe(128_000);
  expect(offeredOutputTokens({ maxOutputTokens: 1_000_000 })).toBe(256_000);
  // Production's offer names none: 65,536 as before, whatever its version is.
  for (const decision of [{}, { maxOutputTokens: '256000' }, { maxOutputTokens: 65_536 }])
    expect(offeredOutputTokens(decision)).toBeUndefined();
});

// A 256,000-token call reserves $0.365784 for a 130 KiB request where a 65,536-token one
// reserves $0.125799: without a step down, a job stopped on its ceiling that much sooner.
it('steps the output cap down to the largest one whose reserve fits what a job has left, never below 65,536', () => {
  const bytes = 130 * 1024;
  expect(modelPeakQuoteAtomic(bytes, 256_000)).toBe(365_784n);
  expect(modelPeakQuoteAtomic(bytes, 128_000)).toBe(204_504n);
  expect(modelPeakQuoteAtomic(bytes, 65_536)).toBe(125_799n);
  expect(fittingOutputTokens(bytes, 256_000, 365_784n)).toBe(256_000);
  expect(fittingOutputTokens(bytes, 256_000, 1_000_000n)).toBe(256_000);
  // One atomic unit short of a cap's reserve: the largest cap that still fits.
  for (const remaining of [365_783n, 204_504n, 204_503n, 150_000n]) {
    const fits = fittingOutputTokens(bytes, 256_000, remaining);
    expect(modelPeakQuoteAtomic(bytes, fits)).toBeLessThanOrEqual(remaining);
    expect(modelPeakQuoteAtomic(bytes, fits + 1)).toBeGreaterThan(remaining);
  }
  expect(fittingOutputTokens(bytes, 256_000, 204_504n)).toBeGreaterThanOrEqual(128_000);
  // At and under the 65,536 reserve the cap stops there, and the ceiling's own rule decides.
  expect(fittingOutputTokens(bytes, 256_000, 125_799n)).toBe(65_536);
  expect(fittingOutputTokens(bytes, 256_000, 1_000n)).toBe(65_536);
  // A call that asks no more than 65,536 is never changed.
  expect(fittingOutputTokens(bytes, 32_000, 1_000n)).toBe(32_000);
});

// The DeepSeek harness compacts at floor(min(0.8 * window, window - reply cap - 65,536)). A fixed
// 786,432 left a 256,000 reply 6,144 tokens of the 1,048,576 context.
it('compacts where the DeepSeek harness does for the reply cap of the job', () => {
  expect(compactWindowTokens(65_536)).toBe(838_860);
  expect(compactWindowTokens(256_000)).toBe(727_040);
  expect(compactWindowTokens()).toBe(compactWindowTokens(MODEL_OUTPUT_TOKENS));
  // A reply and the headroom always fit under the trigger's context.
  for (const cap of [65_536, 128_000, 256_000])
    expect(compactWindowTokens(cap) + cap).toBeLessThanOrEqual(1_048_576 - 65_536);
});
