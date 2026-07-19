import { describe, it, expect } from 'vitest';
import { splitSections, outline, estimateTokens, selectSections } from './markdown';
import type { MarkdownSection } from './markdown';

describe('estimateTokens', () => {
  it('is ceil(words * 1.33)', () => {
    expect(estimateTokens('one two three')).toBe(4); // 3 * 1.33 = 3.99 -> 4
    expect(estimateTokens('one two three four')).toBe(6); // 4 * 1.33 = 5.32 -> 6
  });

  it('is 0 for empty or whitespace-only input', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   \n\t  ')).toBe(0);
  });

  it('collapses runs of whitespace when counting words', () => {
    expect(estimateTokens('one   two\n\nthree')).toBe(estimateTokens('one two three'));
  });
});

describe('splitSections', () => {
  const lines = [
    'Some preamble text.',
    '',
    'More preamble.',
    '',
    '# Title One',
    'Body one.',
    '',
    '## Sub A',
    'Sub body.',
    '',
    '```',
    '# not a heading',
    '```',
    'fence trailing text.',
    '',
    '### Sub Sub ##',
    'Deep body.',
  ];
  const md = lines.join('\n');

  it('carries preamble before the first heading as a heading:null section', () => {
    const sections = splitSections(md);
    expect(sections[0]).toMatchObject({
      heading: null,
      level: 0,
      body: 'Some preamble text.\n\nMore preamble.',
    });
  });

  it('splits nested heading levels in document order', () => {
    const sections = splitSections(md);
    expect(sections.map((s) => [s.heading, s.level])).toEqual([
      [null, 0],
      ['Title One', 1],
      ['Sub A', 2],
      ['Sub Sub', 3],
    ]);
  });

  it('ignores heading-like lines inside a fenced code block', () => {
    const sections = splitSections(md);
    const subA = sections.find((s) => s.heading === 'Sub A') as MarkdownSection;
    expect(subA.body).toContain('# not a heading');
    // The fenced "heading" must not have split Sub A into extra sections.
    expect(sections.filter((s) => s.heading === null)).toHaveLength(1);
  });

  it('strips trailing ATX #s from the heading text', () => {
    const sections = splitSections(md);
    const subSub = sections.find((s) => s.level === 3) as MarkdownSection;
    expect(subSub.heading).toBe('Sub Sub');
    expect(subSub.body).toBe('Deep body.');
  });

  it('sets estimatedTokens per section from its own body', () => {
    const sections = splitSections(md);
    for (const section of sections) {
      expect(section.estimatedTokens).toBe(estimateTokens(section.body));
    }
  });

  it('drops a heading:null section when there is no preamble at all', () => {
    const sections = splitSections('# Only Heading\nbody');
    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe('Only Heading');
  });

  it('returns an empty list for empty input', () => {
    expect(splitSections('')).toEqual([]);
  });
});

describe('outline', () => {
  it('renders `#`-repeated heading lines in document order, skipping preamble', () => {
    const md = [
      'Preamble.',
      '',
      '# Title One',
      'body',
      '## Sub A',
      'body',
      '### Sub Sub',
      'body',
    ].join('\n');
    expect(outline(md)).toEqual(['# Title One', '## Sub A', '### Sub Sub']);
  });

  it('is empty for a document with no headings', () => {
    expect(outline('just some text\nno headings here')).toEqual([]);
  });
});

describe('selectSections', () => {
  const section = (estimatedTokens: number, heading = 'h'): MarkdownSection => ({
    heading,
    level: 1,
    body: 'x',
    estimatedTokens,
  });

  it('always ships the first section even when it alone exceeds the budget', () => {
    const sections = [section(100, 'big'), section(5, 'small')];
    const selected = selectSections(sections, 10);
    expect(selected).toEqual([sections[0]]);
  });

  it('accumulates sections in document order and stops before exceeding the budget', () => {
    const sections = [section(3, 'a'), section(4, 'b'), section(5, 'c')];
    const selected = selectSections(sections, 10);
    expect(selected.map((s) => s.heading)).toEqual(['a', 'b']);
  });

  it('includes a section that lands exactly on the budget boundary', () => {
    const sections = [section(5, 'a'), section(5, 'b')];
    const selected = selectSections(sections, 10);
    expect(selected.map((s) => s.heading)).toEqual(['a', 'b']);
  });

  it('returns an empty selection for an empty section list', () => {
    expect(selectSections([], 100)).toEqual([]);
  });
});
