/**
 * The labeled-fixture gate for redact.ts. `redact.fixtures.json` names, per
 * case, EXACTLY the text `mask()` returns, so a rule edit has to show what it
 * changes in every case before it can merge: a positive the mask stops
 * replacing and a lookalike it starts replacing both fail here.
 *
 * It also pins the properties the rest of the pipeline depends on: the
 * redaction invariant (no masked text ever carries a labeled secret), a
 * positive and a lookalike for every rule, and a ReDoS budget against
 * transcript-scale input.
 */

import { describe, it, expect } from 'vitest';
import { mask } from './redact';
import fixtures from './redact.fixtures.json';
import rules from './redact-rules.json';

interface Case {
  id: string;
  label: 'positive' | 'negative';
  input: string;
  expect_text: string;
  secret?: string;
}

const { cases: RAW_CASES, tokens: TOKENS } = fixtures as { cases: Case[]; tokens: string[][] };
const RULE_IDS = new Set((rules as { rules: Array<{ id: string }> }).rules.map((r) => r.id));

/**
 * Credential literals live in `tokens` split into thirds and are referenced from
 * the case text as `%%tN%%`; nothing in the committed fixtures is a contiguous
 * token shape. Rejoin them here, once, so the mask sees what a real query holds.
 */
function materialize(value: string): string {
  return value.replace(/%%t(\d+)%%/g, (_, n: string) => (TOKENS[Number(n)] ?? []).join(''));
}

const CASES: Case[] = RAW_CASES.map((c) => ({
  ...c,
  input: materialize(c.input),
  expect_text: materialize(c.expect_text),
  secret: c.secret === undefined ? undefined : materialize(c.secret),
}));

describe('mask() — every labeled case', () => {
  for (const c of CASES) {
    it(`${c.id}`, () => {
      expect(mask(c.input)).toBe(c.expect_text);
    });
  }

  it('never leaves a labeled secret in the masked text', () => {
    const leaks = CASES.filter((c) => c.secret !== undefined && mask(c.input).includes(c.secret));
    expect(leaks.map((c) => c.id)).toEqual([]);
  });

  it('replaces something in every positive and nothing in every lookalike', () => {
    const wrong = CASES.filter((c) => (mask(c.input) !== c.input) !== (c.label === 'positive'));
    expect(wrong.map((c) => c.id)).toEqual([]);
  });
});

describe('fixture coverage', () => {
  it('carries a positive and a negative case for every rule in the table', () => {
    const uncovered: string[] = [];
    for (const id of [...RULE_IDS].sort()) {
      const mine = CASES.filter((c) => c.id.startsWith(`${id}/`));
      if (!mine.some((c) => c.label === 'positive')) uncovered.push(`${id}: no positive case`);
      if (!mine.some((c) => c.label === 'negative')) uncovered.push(`${id}: no benign lookalike`);
    }
    expect(uncovered).toEqual([]);
  });

  it('gives every case the text mask() returns', () => {
    for (const c of RAW_CASES) expect(typeof c.expect_text, c.id).toBe('string');
  });
});

describe('ReDoS budget', () => {
  // A JSONL transcript record is ONE line of hundreds of kilobytes, so the audit
  // has to hold on a single huge line, not merely on a large file. Each shape
  // below is an ambiguity trap for a specific detector family: repeated
  // separators (db-uri), a secret-named key with an endless value
  // (secret-assignment), and a giant base64 blob. A quadratic backtracker blows
  // the budget by orders of magnitude, so the threshold does not need to be
  // tight to be meaningful.
  const BUDGET_MS = 1000;
  const pathological: Array<[string, string]> = [
    ['long word run', 'a'.repeat(200_000)],
    ['uri separators', `postgres://${'u:'.repeat(50_000)}`],
    ['email locals', `${'a.'.repeat(50_000)}@${'b.'.repeat(20_000)}`],
    ['secret assignment tail', `API_KEY=${'x1'.repeat(50_000)}`],
    ['secret flag tail', `--api-key ${'x1'.repeat(50_000)}`],
    ['header colon run', `X-Api-Key${':'.repeat(100_000)}`],
    ['nested path segments', `/Users/dana${'/aaaaaaaa'.repeat(20_000)}`],
    ['base64 blob', 'QmVhcmVyVG9rZW4x'.repeat(12_500)],
    ['bearer prefix run', `Authorization: Bearer ${'\t'.repeat(50_000)}`],
    ['ip-ish digits', '10.'.repeat(60_000)],
    ['dotted alphanumerics', 'aA1.'.repeat(50_000)],
    ['scheme-ish hyphen run', `https://${'a-'.repeat(50_000)}`],
    ['colon run', 'a:'.repeat(100_000)],
    ['at-sign run', 'a@'.repeat(100_000)],
    ['wordlist run', 'abandon '.repeat(25_000)],
    ['quoted wordlist run', '"abandon" '.repeat(25_000)],
    ['curl flag run', `curl ${'-u a '.repeat(40_000)}`],
    ['quoted secret-name run', '"password" '.repeat(20_000)],
    ['unclosed quoted secret value', `"api_key":"${'a1'.repeat(50_000)}`],
    ['long url path segments', `https://a.io${'/a1b2c3d4e5f6g7h8i9j0k1l2m3'.repeat(7_000)}`],
    ['url slug run', `https://a.io/${'abc1-'.repeat(40_000)}`],
    ['base58 run', '9WzDXwBbmkg8'.repeat(20_000)],
    ['byte array run', `[${'255, '.repeat(50_000)}`],
    ['32-hex halves run', `${'c'.repeat(32)} `.repeat(6_000)],
    ['capitalized comma wordlist run', 'Abandon, '.repeat(25_000)],
    // Every value here runs the hash-label lookback. An unbounded lookback
    // re-slices the whole line per match and goes quadratic.
    ['dense 64-hex line', `hash ${`0x${'ab'.repeat(32)} `.repeat(3_000)}`],
    ['fence and quote run', `\`\`\`\n${'> word '.repeat(30_000)}\n\`\`\``],
  ];

  for (const [name, text] of pathological) {
    it(`mask completes within budget on ${name}`, () => {
      const started = performance.now();
      mask(text);
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    });
  }

  it('masks a megabyte-scale multi-line transcript within budget', () => {
    const record = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'ran the migration against 10.14.203.7 and retried' },
    });
    const started = performance.now();
    mask(Array.from({ length: 8000 }, () => record).join('\n'));
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
