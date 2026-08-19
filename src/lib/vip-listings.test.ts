import { describe, it, expect } from 'vitest';
import { pinnedListings, selectPins } from './vip-listings';

describe('pinnedListings', () => {
  it('derives first-party pins from the configured deployment, not a hardcoded host', () => {
    const pins = pinnedListings('https://tenjin.example');
    expect(pins.every((p) => p.url.startsWith('https://tenjin.example/'))).toBe(true);
    expect(pins.map((p) => p.url)).toContain('https://tenjin.example/api/phone-lookup');
  });

  it('tolerates a base URL with a trailing slash without doubling it', () => {
    expect(pinnedListings('https://tenjin.example/').map((p) => p.url)).toContain(
      'https://tenjin.example/api/phone-lookup',
    );
  });

  // Article reads stay search-driven, and /api/answer is deliberately unpinned.
  it('pins exactly one first-party path in v1', () => {
    const paths = pinnedListings('https://tenjin.blog').map((p) => new URL(p.url).pathname);
    expect(paths).toEqual(['/api/phone-lookup']);
  });

  // Curation is endorsement: the seed list is empty until an operator vets
  // sellers and confirms a registry lists them.
  it('ships no ecosystem pins', () => {
    expect(pinnedListings('https://tenjin.blog').filter((p) => p.kind === 'ecosystem')).toEqual([]);
  });
});

describe('selectPins', () => {
  it('shows every pin when there is no query (browse-everything mode)', () => {
    expect(selectPins('https://tenjin.blog')).toEqual(pinnedListings('https://tenjin.blog'));
    expect(selectPins('https://tenjin.blog', '   ')).toHaveLength(
      pinnedListings('https://tenjin.blog').length,
    );
  });

  it('matches a query token against keywords, case-insensitively', () => {
    expect(selectPins('https://tenjin.blog', 'PHONE carrier')).toHaveLength(1);
    expect(selectPins('https://tenjin.blog', 'lookup')).toHaveLength(1);
  });

  it('matches a query token against description words', () => {
    expect(selectPins('https://tenjin.blog', 'portability')).toHaveLength(1);
  });

  it('hides pins a query does not name', () => {
    expect(selectPins('https://tenjin.blog', 'inference')).toEqual([]);
    expect(selectPins('https://tenjin.blog', 'weather forecast')).toEqual([]);
  });

  // A pin that surfaces for "a" or "in" is noise, not curation.
  it('ignores tokens under three characters', () => {
    expect(selectPins('https://tenjin.blog', 'a in of')).toEqual([]);
  });

  it('does not fuzzy-match: a prefix is not a hit', () => {
    expect(selectPins('https://tenjin.blog', 'phon')).toEqual([]);
  });
});
