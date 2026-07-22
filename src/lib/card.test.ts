import { describe, it, expect } from 'vitest';
import {
  deriveCard,
  localCardEligibility,
  missingSentences,
  parseAppliesToFlags,
  parseFrontmatter,
  type CardFlags,
} from './card';

function expectUsage(fn: () => unknown, field?: string): void {
  try {
    fn();
    throw new Error('expected a USAGE throw');
  } catch (err) {
    const e = err as { code?: string; details?: { fieldErrors?: Record<string, string[]> } };
    expect(e.code).toBe('USAGE');
    if (field !== undefined) {
      expect(Object.keys(e.details?.fieldErrors ?? {})).toContain(`resource.${field}`);
    }
  }
}

describe('parseFrontmatter', () => {
  it('returns an empty map and the whole text when there is no frontmatter', () => {
    const { frontmatter, body } = parseFrontmatter('# Just a body\n');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Just a body\n');
  });

  it('parses scalars, flow lists, block lists, and a one-level appliesTo map', () => {
    const text = [
      '---',
      'title: Base fees',
      'tags: [base, fees]',
      'questionsAnswered:',
      '  - What do Base txns cost?',
      '  - How much is gas?',
      'appliesTo:',
      '  products: [Base, L2]',
      '  chains:',
      '    - base',
      '---',
      '# Body here',
      '',
    ].join('\n');
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter.title).toBe('Base fees');
    expect(frontmatter.tags).toEqual(['base', 'fees']);
    expect(frontmatter.questionsAnswered).toEqual(['What do Base txns cost?', 'How much is gas?']);
    expect(frontmatter.appliesTo).toEqual({ products: ['Base', 'L2'], chains: ['base'] });
    expect(body).toBe('# Body here\n');
  });

  it('strips quotes and ignores comment lines', () => {
    const text = [
      '---',
      '# a comment',
      'title: "Quoted Title"',
      "scope: 'single'",
      '---',
      'body',
    ].join('\n');
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter.title).toBe('Quoted Title');
    expect(frontmatter.scope).toBe('single');
  });

  it('refuses an unsupported construct as USAGE rather than mis-parsing', () => {
    const text = ['---', '   unexpected indent', '---', 'body'].join('\n');
    expectUsage(() => parseFrontmatter(text));
  });
});

describe('deriveCard — precedence (frontmatter < flags)', () => {
  it('a flag overrides the same frontmatter field', () => {
    const fm = { scope: 'from frontmatter', artifactType: 'document' };
    const flags: CardFlags = { scope: 'from flag' };
    const card = deriveCard(fm, flags);
    expect(card?.scope).toBe('from flag');
    expect(card?.artifactType).toBe('document');
  });

  it('repeatable flags win over a frontmatter list', () => {
    const fm = { questionsAnswered: ['fm-q'] };
    const card = deriveCard(fm, { question: ['flag-q1', 'flag-q2'] });
    expect(card?.questionsAnswered).toEqual(['flag-q1', 'flag-q2']);
  });

  it('returns undefined when no card field is present (empty resource is a no-op)', () => {
    expect(deriveCard({}, {})).toBeUndefined();
    expect(deriveCard({ title: 'not a card field' }, {})).toBeUndefined();
  });
});

describe('deriveCard — every bound, dotted resource.<field> errors', () => {
  it('artifactType must be in the enum', () => {
    expect(deriveCard({}, { artifactType: 'skill' })?.artifactType).toBe('skill');
    expectUsage(() => deriveCard({}, { artifactType: 'video' }), 'artifactType');
  });

  it('temporalMode must be in the enum', () => {
    expect(deriveCard({}, { temporalMode: 'snapshot' })?.temporalMode).toBe('snapshot');
    expectUsage(() => deriveCard({}, { temporalMode: 'someday' }), 'temporalMode');
  });

  it('mediaType must be a MIME shape ≤100', () => {
    expect(deriveCard({ mediaType: 'text/markdown' }, {})?.mediaType).toBe('text/markdown');
    expectUsage(() => deriveCard({ mediaType: 'not a mime' }, {}), 'mediaType');
    expectUsage(() => deriveCard({ mediaType: `text/${'x'.repeat(200)}` }, {}), 'mediaType');
  });

  it('asOf/validUntil must be ISO-8601 with an offset, and validUntil ≥ asOf', () => {
    const ok = deriveCard({}, { asOf: '2026-07-01T00:00:00Z', validUntil: '2026-08-01T00:00:00Z' });
    expect(ok?.asOf).toBe('2026-07-01T00:00:00Z');
    expectUsage(() => deriveCard({}, { asOf: '2026-07-01' }), 'asOf'); // no time/offset
    expectUsage(
      () => deriveCard({}, { asOf: '2026-08-01T00:00:00Z', validUntil: '2026-07-01T00:00:00Z' }),
      'validUntil',
    );
  });

  it('supersedesPostId must be a uuid', () => {
    const uuid = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(deriveCard({ supersedesPostId: uuid }, {})?.supersedesPostId).toBe(uuid);
    expectUsage(() => deriveCard({ supersedesPostId: 'not-a-uuid' }, {}), 'supersedesPostId');
  });

  it('questionsAnswered/tasksSupported cap at 10 × 200', () => {
    expectUsage(
      () => deriveCard({}, { question: Array.from({ length: 11 }, (_, i) => `q${i}`) }),
      'questionsAnswered',
    );
    expectUsage(() => deriveCard({}, { task: ['x'.repeat(201)] }), 'tasksSupported');
  });

  it('scope/exclusions/provenance/methodology cap at 500', () => {
    expectUsage(() => deriveCard({}, { scope: 'x'.repeat(501) }), 'scope');
    expectUsage(() => deriveCard({}, { exclusions: 'x'.repeat(501) }), 'exclusions');
    expectUsage(() => deriveCard({}, { provenance: 'x'.repeat(501) }), 'provenanceSummary');
    expectUsage(() => deriveCard({}, { methodology: 'x'.repeat(501) }), 'methodologySummary');
  });

  it('appliesTo enforces ≤8 canonical keys × ≤20 values (1..120 chars)', () => {
    const ok = deriveCard({}, { appliesTo: { products: ['Vercel', 'Next'] } });
    expect(ok?.appliesTo).toEqual({ products: ['Vercel', 'Next'] });
    expectUsage(() => deriveCard({}, { appliesTo: { 'Bad-Key': ['x'] } }), 'appliesTo');
    expectUsage(() => deriveCard({}, { appliesTo: { k: ['x'.repeat(121)] } }), 'appliesTo');
    const nineKeys = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`k${i}`, ['v']]),
    ) as Record<string, string[]>;
    expectUsage(() => deriveCard({}, { appliesTo: nineKeys }), 'appliesTo');
  });

  it('reproductionMinutes must be an int 0..1e6; estimatedPaidInputCost an atomic string', () => {
    expect(deriveCard({ reproductionMinutes: '30' }, {})?.reproductionMinutes).toBe(30);
    expectUsage(() => deriveCard({ reproductionMinutes: '1.5' }, {}), 'reproductionMinutes');
    expectUsage(() => deriveCard({ reproductionMinutes: '2000000' }, {}), 'reproductionMinutes');
    expect(deriveCard({ estimatedPaidInputCost: '5000' }, {})?.estimatedPaidInputCost).toBe('5000');
    expectUsage(() => deriveCard({ estimatedPaidInputCost: '5.00' }, {}), 'estimatedPaidInputCost');
  });

  it('maintenanceCadence caps at 120', () => {
    expect(deriveCard({ maintenanceCadence: 'weekly' }, {})?.maintenanceCadence).toBe('weekly');
    expectUsage(
      () => deriveCard({ maintenanceCadence: 'x'.repeat(121) }, {}),
      'maintenanceCadence',
    );
  });
});

describe('parseAppliesToFlags', () => {
  it('accumulates values per key', () => {
    expect(parseAppliesToFlags(['products=Vercel', 'products=Next', 'chains=base'])).toEqual({
      products: ['Vercel', 'Next'],
      chains: ['base'],
    });
  });
  it('rejects a pair without =', () => {
    expect(() => parseAppliesToFlags(['bad'])).toThrow();
  });

  it('rejects a prototype-polluting key as USAGE, not a raw TypeError', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expectUsage(() => parseAppliesToFlags([`${key}=x`]));
    }
  });
});

describe('prototype-pollution safety', () => {
  it('a __proto__ frontmatter key fails loudly (USAGE), never a silent prototype mutation', () => {
    const text = ['---', '__proto__:', '  - polluted', '---', 'body'].join('\n');
    expectUsage(() => parseFrontmatter(text));
    // The parser never corrupted Object.prototype on the way to throwing.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a __proto__ nested appliesTo key also fails as USAGE', () => {
    const text = ['---', 'appliesTo:', '  __proto__: [x]', '---', 'body'].join('\n');
    expectUsage(() => parseFrontmatter(text));
  });
});

describe('cacheEligible echo', () => {
  it('maps every rubric token to a plain sentence, unknown tokens pass through', () => {
    expect(missingSentences(['scope', 'asOf', 'weird'])).toEqual([
      'Describe the scope (what this piece covers).',
      'Set an as-of date (a snapshot card needs one).',
      'weird',
    ]);
  });

  it('localCardEligibility mirrors the Q9 rubric (asOf only for snapshot)', () => {
    expect(localCardEligibility(undefined)).toEqual({
      cacheEligible: false,
      missing: missingSentences([
        'questionsOrTasks',
        'scope',
        'exclusions',
        'provenanceOrMethodology',
      ]),
    });
    const full = deriveCard(
      {},
      {
        question: ['q'],
        scope: 's',
        exclusions: 'e',
        provenance: 'p',
        temporalMode: 'snapshot',
        asOf: '2026-07-01T00:00:00Z',
      },
    );
    expect(localCardEligibility(full)).toEqual({ cacheEligible: true, missing: [] });
    const noAsOf = deriveCard(
      {},
      { question: ['q'], scope: 's', exclusions: 'e', provenance: 'p', temporalMode: 'snapshot' },
    );
    expect(localCardEligibility(noAsOf).missing).toEqual(missingSentences(['asOf']));
  });
});
