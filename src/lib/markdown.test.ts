import { describe, it, expect } from 'vitest';
import { estimateTokens, headingOutline, selectSections, splitSections } from './markdown';

describe('headingOutline', () => {
  it('extracts ATX headings with levels', () => {
    expect(headingOutline('# A\n## B\ntext\n### C')).toEqual([
      { level: 1, text: 'A' },
      { level: 2, text: 'B' },
      { level: 3, text: 'C' },
    ]);
  });
  it('ignores # inside fenced code blocks', () => {
    const md = '# Real\n\n```bash\n# not a heading\n```\n\n## Also real';
    expect(headingOutline(md)).toEqual([
      { level: 1, text: 'Real' },
      { level: 2, text: 'Also real' },
    ]);
  });
});

describe('splitSections / selectSections / estimateTokens', () => {
  const DOC = [
    'preamble text',
    '# One',
    'alpha beta',
    '## Two',
    '```',
    '# not a heading',
    '```',
    'gamma',
  ].join('\n');

  it('splits on ATX headings, keeps preamble, ignores headings in fences', () => {
    const sections = splitSections(DOC);
    expect(sections.map((s) => s.heading)).toEqual([null, 'One', 'Two']);
    expect(sections[2]?.body).toContain('# not a heading');
    expect(sections[2]?.level).toBe(2);
  });

  it('estimates tokens as ceil(words x 1.33)', () => {
    expect(estimateTokens('one two three')).toBe(Math.ceil(3 * 1.33));
    expect(estimateTokens('')).toBe(0);
  });

  it('selects sections in order within the budget, always shipping the first', () => {
    const sections = splitSections(DOC);
    const one = selectSections(sections, 1);
    expect(one).toHaveLength(1);
    expect(one[0]?.heading).toBeNull();
    const all = selectSections(sections, 10_000);
    expect(all).toHaveLength(sections.length);
  });
});
