/**
 * The labeled-corpus gate. `scan-corpus.json` names, per sample, the EXACT set of
 * detector ids scan() must report; this suite turns that into per-detector
 * precision and recall and fails on anything below 1.0 in either direction. A
 * detector edit therefore has to show its false-positive cost here before it can
 * merge, which is the point: recall alone is cheap to buy.
 *
 * It also pins the two properties the rest of the pipeline depends on — the
 * redaction invariant (no finding excerpt ever carries the matched secret) and a
 * ReDoS budget against transcript-scale input.
 */

import { describe, it, expect } from 'vitest';
import { scan } from './scan';
import corpus from './scan-corpus.json';
import rules from './scan-rules.json';

interface Sample {
  id: string;
  label: 'positive' | 'negative';
  detectors: string[];
  text: string;
  secret?: string;
  markers?: string[];
}

const { samples: RAW_SAMPLES, tokens: TOKENS } = corpus as {
  samples: Sample[];
  tokens: string[][];
};

/**
 * Credential literals live in `tokens` split into thirds and are referenced from
 * the sample text as `%%tN%%`; nothing in the committed corpus is a contiguous
 * token shape. Rejoin them here, once, so the scan sees what a real draft holds.
 */
function materialize(value: string): string {
  return value.replace(/%%t(\d+)%%/g, (_, n: string) => (TOKENS[Number(n)] ?? []).join(''));
}

const SAMPLES: Sample[] = RAW_SAMPLES.map((s) => ({
  ...s,
  text: materialize(s.text),
  secret: s.secret === undefined ? undefined : materialize(s.secret),
}));
const RULE_IDS = new Set((rules as { rules: { id: string }[] }).rules.map((r) => r.id));
// hex32-value is the warn form scan() demotes raw-private-key to in hash
// context; it is one detector in the corpus data, two ids on the wire.
RULE_IDS.add('hex32-value');

function detectorsFor(sample: Sample): string[] {
  const found = scan(sample.text, { projectMarkers: sample.markers ?? [] });
  return [...new Set(found.map((f) => f.check))].sort();
}

interface Score {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

function scoreCorpus(): { scores: Map<string, Score>; mismatches: string[] } {
  const scores = new Map<string, Score>();
  const mismatches: string[] = [];
  const bump = (id: string, field: keyof Score): void => {
    const s = scores.get(id) ?? { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
    s[field]++;
    scores.set(id, s);
  };
  for (const sample of SAMPLES) {
    const actual = detectorsFor(sample);
    const expected = [...sample.detectors].sort();
    for (const id of actual) bump(id, expected.includes(id) ? 'truePositives' : 'falsePositives');
    for (const id of expected) if (!actual.includes(id)) bump(id, 'falseNegatives');
    if (actual.join(',') !== expected.join(',')) {
      mismatches.push(`${sample.id}: expected [${expected.join(', ')}] got [${actual.join(', ')}]`);
    }
  }
  return { scores, mismatches };
}

describe('scan corpus — precision and recall', () => {
  it('reports exactly the labeled detector set on every sample', () => {
    expect(scoreCorpus().mismatches).toEqual([]);
  });

  it('holds precision and recall at 1.0 for every detector', () => {
    const { scores } = scoreCorpus();
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

  it('carries a positive and a negative sample for every detector in the corpus data', () => {
    const uncovered: string[] = [];
    for (const id of [...RULE_IDS].sort()) {
      const mine = SAMPLES.filter((s) => s.id.startsWith(`${id}/`));
      if (!mine.some((s) => s.label === 'positive')) uncovered.push(`${id}: no positive sample`);
      if (!mine.some((s) => s.label === 'negative')) uncovered.push(`${id}: no benign lookalike`);
    }
    expect(uncovered).toEqual([]);
  });
});

describe('scan corpus — findings are redacted', () => {
  it('never echoes a labeled secret in any excerpt', () => {
    const leaks: string[] = [];
    for (const sample of SAMPLES) {
      if (sample.secret === undefined) continue;
      for (const f of scan(sample.text, { projectMarkers: sample.markers ?? [] })) {
        if (f.excerpt.includes(sample.secret)) leaks.push(`${sample.id}: ${f.check}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it('masks every block-tier excerpt (pem armor is the one header-only exception)', () => {
    const unmasked: string[] = [];
    for (const sample of SAMPLES) {
      for (const f of scan(sample.text, { projectMarkers: sample.markers ?? [] })) {
        if (f.severity !== 'block' || f.check === 'pem-private-key') continue;
        if (!f.excerpt.includes('[redacted')) unmasked.push(`${sample.id}: ${f.check}`);
      }
    }
    expect(unmasked).toEqual([]);
  });

  it('gives every finding a detector id, a tier, and in-range offsets', () => {
    for (const sample of SAMPLES) {
      const lines = sample.text.split('\n');
      for (const f of scan(sample.text, { projectMarkers: sample.markers ?? [] })) {
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

describe('scan corpus — ReDoS budget on transcript-scale input', () => {
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
    it(`completes within budget on ${name}`, () => {
      const started = performance.now();
      scan(text);
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    });
  }

  it('scans a megabyte-scale multi-line transcript within budget', () => {
    const record = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'ran the migration against 10.14.203.7 and retried' },
    });
    const started = performance.now();
    scan(Array.from({ length: 8000 }, () => record).join('\n'));
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
