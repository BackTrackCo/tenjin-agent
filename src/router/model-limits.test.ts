import { expect, it } from 'vitest';
import {
  MODEL_MINIMUM_CALL_ATOMIC,
  MODEL_MINIMUM_JOB_ATOMIC,
  MODEL_OUTPUT_TOKENS,
  modelPeakQuoteAtomic,
  usdOfAtomic,
} from './model-limits';

// The floor was a literal for a 32K output (44,611) while workers asked 65,536, so a job
// ceiling between $0.0446 and $0.0869 admitted a job that could not fit one call.
it('derives the job floor from the output cap with the router quote formula', () => {
  expect(MODEL_OUTPUT_TOKENS).toBe(65_536);
  expect(MODEL_MINIMUM_CALL_ATOMIC).toBe(83_866n);
  expect(MODEL_MINIMUM_JOB_ATOMIC).toBe(86_866n);
  expect(usdOfAtomic(MODEL_MINIMUM_JOB_ATOMIC)).toBe('$0.086866');
  // The router's own figures: a zero-byte 32,000-token quote was 41,611; other caps follow.
  expect(modelPeakQuoteAtomic(0, 32_000)).toBe(41_611n);
  expect(modelPeakQuoteAtomic(0, 128_000) + 3_000n).toBe(165_571n);
  expect(modelPeakQuoteAtomic(0, 256_000) + 3_000n).toBe(326_851n);
  // Input is bound by the model's context, as the router bounds it.
  expect(modelPeakQuoteAtomic(10_000_000, 0)).toBe(modelPeakQuoteAtomic(1_048_576, 0));
});
