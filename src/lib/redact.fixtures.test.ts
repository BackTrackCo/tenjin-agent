/**
 * The labeled-fixture gate for both verbs of redact.ts. `redact.fixtures.json`
 * names, per case, EXACTLY what the module must do: the detector ids
 * `findings()` reports on a `publish` case, the text `redact()` returns on a
 * `query` case. The publish cases turn into per-detector precision and recall
 * and fail on anything below 1.0 in either direction, so a detector edit has to
 * show its false-positive cost here before it can merge: recall alone is cheap
 * to buy.
 *
 * The `team` expectation is DERIVED, never written by hand: a team shelf reports
 * exactly the rules whose `scopes` include `team`, so every publish case is
 * replayed in the team scope against its expected set filtered by the rules
 * data. An emitted check (`hex32-value`) follows its emitting rule.
 *
 * It also pins the properties the rest of the pipeline depends on — the
 * redaction invariant (no finding excerpt ever carries the matched secret), the
 * team survivor set, and a ReDoS budget against transcript-scale input for the
 * report rows and against the query seeds that bit before (#273) for the strip
 * rows.
 */

import { describe, it, expect } from 'vitest';
import { findings, redact, checksFor, EMITTED_CHECKS, REDACT_INPUT_MAX } from './redact';
import type { ReportScope } from './redact';
import fixtures from './redact.fixtures.json';
import rules from './redact-rules.json';

interface Case {
  id: string;
  scope: 'publish' | 'query';
  label: 'positive' | 'negative';
  input: string;
  expect_ids?: string[];
  expect_text?: string;
  secret?: string;
  markers?: string[];
}

interface Rule {
  id: string;
  tier?: string;
  scopes: string[];
}

const {
  cases: RAW_CASES,
  tokens: TOKENS,
  redos: REDOS,
} = fixtures as {
  cases: Case[];
  tokens: string[][];
  redos: Array<{ seed: string; prefix?: string; note: string }>;
};
const RULES = (rules as { rules: Rule[] }).rules;

/**
 * Credential literals live in `tokens` split into thirds and are referenced from
 * the case text as `%%tN%%`; nothing in the committed fixtures is a contiguous
 * token shape. Rejoin them here, once, so the scan sees what a real draft holds.
 */
function materialize(value: string): string {
  return value.replace(/%%t(\d+)%%/g, (_, n: string) => (TOKENS[Number(n)] ?? []).join(''));
}

const CASES: Case[] = RAW_CASES.map((c) => ({
  ...c,
  input: materialize(c.input),
  expect_text: c.expect_text === undefined ? undefined : materialize(c.expect_text),
  secret: c.secret === undefined ? undefined : materialize(c.secret),
}));
const PUBLISH_CASES = CASES.filter((c) => c.scope === 'publish');
const QUERY_CASES = CASES.filter((c) => c.scope === 'query');

const RULE_IDS = new Set(RULES.map((r) => r.id));
for (const check of Object.keys(EMITTED_CHECKS)) RULE_IDS.add(check);

/** The rule a reported check belongs to: itself, or the rule that emits it. */
function ruleOf(check: string): string {
  return EMITTED_CHECKS[check] ?? check;
}

function scopedExpectation(c: Case, scope: ReportScope): string[] {
  const allowed = checksFor(scope);
  return [...(c.expect_ids ?? [])].filter((id) => allowed.has(id)).sort();
}

function detectorsFor(c: Case, scope: ReportScope): string[] {
  const found = findings(c.input, scope, { projectMarkers: c.markers ?? [] });
  return [...new Set(found.map((f) => f.check))].sort();
}

interface Score {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

function scoreCorpus(scope: ReportScope): { scores: Map<string, Score>; mismatches: string[] } {
  const scores = new Map<string, Score>();
  const mismatches: string[] = [];
  const bump = (id: string, field: keyof Score): void => {
    const s = scores.get(id) ?? { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
    s[field]++;
    scores.set(id, s);
  };
  for (const c of PUBLISH_CASES) {
    const actual = detectorsFor(c, scope);
    const expected = scopedExpectation(c, scope);
    for (const id of actual) bump(id, expected.includes(id) ? 'truePositives' : 'falsePositives');
    for (const id of expected) if (!actual.includes(id)) bump(id, 'falseNegatives');
    if (actual.join(',') !== expected.join(',')) {
      mismatches.push(
        `${c.id} [${scope}]: expected [${expected.join(', ')}] got [${actual.join(', ')}]`,
      );
    }
  }
  return { scores, mismatches };
}

describe.each<ReportScope>(['publish', 'team'])('findings(%s) — precision and recall', (scope) => {
  it('reports exactly the labeled detector set on every case', () => {
    expect(scoreCorpus(scope).mismatches).toEqual([]);
  });

  it('holds precision and recall at 1.0 for every detector', () => {
    const { scores } = scoreCorpus(scope);
    const below: string[] = [];
    for (const [id, s] of scores) {
      const precision = s.truePositives / (s.truePositives + s.falsePositives);
      const recall = s.truePositives / (s.truePositives + s.falseNegatives);
      if (precision < 1 || recall < 1) {
        below.push(`${id}: precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)}`);
      }
    }
    expect(below).toEqual([]);
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

  it('names only rules that exist in every expected set', () => {
    const unknown: string[] = [];
    for (const c of PUBLISH_CASES) {
      for (const id of c.expect_ids ?? []) if (!RULE_IDS.has(id)) unknown.push(`${c.id}: ${id}`);
    }
    expect(unknown).toEqual([]);
  });

  it('gives every case the fields its scope needs and no other', () => {
    for (const c of CASES) {
      if (c.scope === 'publish') {
        expect(c.expect_ids, `${c.id} lists no expect_ids`).toBeDefined();
        expect(c.expect_text, `${c.id} carries expect_text in the publish scope`).toBeUndefined();
      } else {
        expect(c.expect_text, `${c.id} carries no expect_text`).toBeDefined();
        expect(c.expect_ids, `${c.id} carries expect_ids in the query scope`).toBeUndefined();
      }
    }
  });
});

describe('redact() — the query scope', () => {
  for (const c of QUERY_CASES) {
    it(`${c.id}`, () => {
      expect(redact(c.input)).toBe(c.expect_text);
    });
  }

  it('never lets a labeled secret through', () => {
    // Every credential-shaped token in the publish corpus is a shape the strip
    // rows must also remove from a query, whatever the surrounding text.
    const leaks: string[] = [];
    for (const c of PUBLISH_CASES) {
      if (c.secret === undefined) continue;
      // Pure lowercase hex is kept in a query by policy (a git SHA); the publish
      // rows catch a hex-only key in credential position instead.
      if (/^[0-9a-f]+$/.test(c.secret)) continue;
      // Seed phrases and PEM blocks have no strip row: an algorithmic detector
      // on publish, and neither shape is a search query. A home path's
      // username is a path, and paths stay in a query by the same policy.
      if (/^(?:bip39-|pem-|openssh-|local-path\/)/.test(c.id)) continue;
      if (redact(c.input).includes(c.secret)) leaks.push(`${c.id}: ${c.secret.slice(0, 6)}…`);
    }
    expect(leaks).toEqual([]);
  });

  it('bounds the input to whole tokens', () => {
    const secret = 'sk-' + 'a1'.repeat(20);
    const text = `${'word '.repeat(REDACT_INPUT_MAX / 5 - 2)}${secret} tail`;
    const out = redact(text);
    expect(out.length).toBeLessThanOrEqual(REDACT_INPUT_MAX);
    expect(out).not.toContain(secret);
    expect(out).not.toMatch(/sk-a1/);
  });
});

describe('findings — excerpts are redacted', () => {
  it('never echoes a labeled secret in any excerpt', () => {
    const leaks: string[] = [];
    for (const c of PUBLISH_CASES) {
      if (c.secret === undefined) continue;
      for (const f of findings(c.input, 'publish', { projectMarkers: c.markers ?? [] })) {
        if (f.excerpt.includes(c.secret)) leaks.push(`${c.id}: ${f.check}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('masks every block-tier excerpt (pem armor is the one header-only exception)', () => {
    const unmasked: string[] = [];
    for (const c of PUBLISH_CASES) {
      for (const f of findings(c.input, 'publish', { projectMarkers: c.markers ?? [] })) {
        if (f.severity !== 'block' || f.check === 'pem-private-key') continue;
        if (!f.excerpt.includes('[redacted')) unmasked.push(`${c.id}: ${f.check}`);
      }
    }
    expect(unmasked).toEqual([]);
  });

  it('gives every finding a detector id, a tier, and in-range offsets', () => {
    for (const c of PUBLISH_CASES) {
      const lines = c.input.split('\n');
      for (const f of findings(c.input, 'publish', { projectMarkers: c.markers ?? [] })) {
        expect(RULE_IDS.has(f.check)).toBe(true);
        expect(['block', 'warn']).toContain(f.severity);
        const line = lines[f.line - 1] ?? '';
        expect(f.span[0]).toBeGreaterThanOrEqual(0);
        expect(f.span[1]).toBeLessThanOrEqual(line.length);
        expect(f.span[0]).toBeLessThanOrEqual(f.span[1]);
      }
    }
  });
});

describe('ReDoS budget', () => {
  // A JSONL transcript record is ONE line of hundreds of kilobytes, so the audit
  // has to hold on a single huge line, not merely on a large file. Each shape
  // below is an ambiguity trap for a specific detector family: repeated
  // separators (db-uri, email), a secret-named key with an endless value
  // (secret-assignment), a nested path run (local-path), and a giant base64 blob
  // (entropy). A quadratic backtracker blows the budget by orders of magnitude,
  // so the threshold does not need to be tight to be meaningful.
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
    // Every value here runs the hash-label lookback. An unbounded lookback
    // re-slices the whole line per match and goes quadratic.
    ['dense 64-hex line', `hash ${`0x${'ab'.repeat(32)} `.repeat(3_000)}`],
    ['fence and quote run', `\`\`\`\n${'> word '.repeat(30_000)}\n\`\`\``],
  ];

  for (const [name, text] of pathological) {
    it(`findings completes within budget on ${name}`, () => {
      const started = performance.now();
      findings(text, 'publish');
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    });
  }

  it('scans a megabyte-scale multi-line transcript within budget', () => {
    const record = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'ran the migration against 10.14.203.7 and retried' },
    });
    const started = performance.now();
    findings(Array.from({ length: 8000 }, () => record).join('\n'), 'publish');
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });

  // The strip rows only ever see REDACT_INPUT_MAX characters, so the seeds are
  // built to that bound; the measured shapes from #273 ran 0.05-0.65 ms at 16k
  // on the old scrub, so a synchronous regex that reaches this budget is
  // super-linear, not slow.
  const STRIP_BUDGET_MS = 100;
  for (const { seed, prefix, note } of REDOS) {
    it(`redact completes within budget on ${JSON.stringify(seed)} repeats (${note})`, () => {
      const body = seed.repeat(Math.ceil(REDACT_INPUT_MAX / seed.length));
      const text = `${prefix ?? ''}${body}`.slice(0, REDACT_INPUT_MAX);
      const started = performance.now();
      redact(text);
      expect(performance.now() - started).toBeLessThan(STRIP_BUDGET_MS);
    });
  }
});

/**
 * The team-shelf survivor set, pinned so that REMOVING a survivor has to fail
 * here: dropping `team` from a rule's scopes drops that credential check out of
 * every team-shelf publish with every other test still green. ADDING one is a
 * data edit and free by construction, which is the point of `scopes`. The block
 * tier is not listed: the table validator refuses a block rule without `team`.
 */
describe('team-shelf survivor set', () => {
  it('keeps every warn that asks the credential or the injection question', () => {
    const survivors = checksFor('team');
    for (const name of [
      'secret-assignment',
      'hex32-value',
      'high-entropy-string',
      'env-dump-block',
      'embedded-instruction',
    ]) {
      expect(survivors.has(name), `${name} no longer survives on a team shelf`).toBe(true);
    }
  });

  it('still emits every emitted check, so renaming the literal fails here', () => {
    const emitted = findings(`The key hash: 0x${'c'.repeat(64)}`, 'team').map((f) => f.check);
    for (const [check, rule] of Object.entries(EMITTED_CHECKS)) {
      expect(RULE_IDS.has(rule), `${check} names an emitting rule that does not exist`).toBe(true);
      expect(emitted, `${check} is no longer emitted`).toContain(check);
    }
  });

  it('resolves every reported check to a rule row, in both scopes', () => {
    for (const scope of ['publish', 'team'] as const) {
      for (const check of checksFor(scope)) expect(RULE_IDS.has(ruleOf(check))).toBe(true);
    }
  });
});
