// Unit coverage for the pure halves of the shared publication gates. The SQL
// predicates in this module are exercised against real Postgres in
// tests/integration/search-telemetry.test.ts, which is where a gate that stops
// composing into a rollup shows up.
import { describe, it, expect } from 'vitest';
import { CODE_VETOED_QUESTIONS, isPublishableQuestionShape } from './gates';
import { normalizeQuery } from './telemetry';

describe('the question tiers shape gate', () => {
  // One case per rule, and nothing beyond the three.
  it('drops a question of two characters or fewer', () => {
    expect(isPublishableQuestionShape('x')).toBe(false);
    expect(isPublishableQuestionShape('  Hi  ')).toBe(false);
  });

  // '😀a' is 3 UTF-16 code units but 2 code points; a length check on code
  // units would keep it while Postgres length() (code points) drops it (#798).
  it('drops a question at the non-BMP code-point boundary, and keeps one past it', () => {
    expect(isPublishableQuestionShape('😀a')).toBe(false);
    expect(isPublishableQuestionShape('😀😀a')).toBe(true);
  });

  it('drops a question with no letters at all', () => {
    expect(isPublishableQuestionShape('12345')).toBe(false);
    expect(isPublishableQuestionShape('???')).toBe(false);
  });

  it('drops the canonical test question, counter and all', () => {
    for (const q of ['test', 'Testing', 'test 2', 'testing_03', 'test-7']) {
      expect(isPublishableQuestionShape(q)).toBe(false);
    }
  });

  // The operator's ruling is explicit that under-filtering beats an empty page,
  // so the gate must not reach past its three anchors.
  it('keeps a short but real question, and anything the word "test" merely appears in', () => {
    for (const q of [
      'why x402?',
      'is x402 live?',
      'how do i test an x402 server?',
      'testnet rpc',
    ]) {
      expect(isPublishableQuestionShape(q)).toBe(true);
    }
  });

  it('reads its input through normalizeQuery, so casing and spacing cannot slip past', () => {
    expect(isPublishableQuestionShape('  TEST   ')).toBe(false);
  });
});

describe('the in-code question veto seed', () => {
  it('carries only strings normalizeQuery leaves untouched, so the SQL compare can match', () => {
    for (const term of CODE_VETOED_QUESTIONS) {
      expect(normalizeQuery(term)).toBe(term);
    }
  });
});
