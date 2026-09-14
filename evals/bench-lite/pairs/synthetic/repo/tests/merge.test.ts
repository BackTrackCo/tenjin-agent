import { describe, expect, it } from 'vitest';
import { mergeAll, mergeDefaults, withoutNulls } from '../src/merge.ts';

describe('mergeDefaults', () => {
  it('takes the override value where there is one', () => {
    expect(mergeDefaults({ retries: 3, backoffMs: 500 }, { retries: 5 })).toEqual({
      retries: 5,
      backoffMs: 500,
    });
  });

  it('keeps the base where the override is silent', () => {
    expect(mergeDefaults({ a: 1, b: 2 }, {})).toEqual({ a: 1, b: 2 });
  });

  it('does not mutate either argument', () => {
    const base = { a: 1 };
    const override = { a: 2 };
    mergeDefaults(base, override);
    expect(base).toEqual({ a: 1 });
    expect(override).toEqual({ a: 2 });
  });

  it('keeps a null, which is a value like any other', () => {
    expect(mergeDefaults({ email: 'ops@example.com' as string | null }, { email: null })).toEqual({
      email: null,
    });
  });
});

describe('mergeAll', () => {
  it('layers left to right', () => {
    expect(mergeAll({ a: 1, b: 1, c: 1 }, { b: 2 }, { c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('lets a later layer win', () => {
    expect(mergeAll({ a: 1 }, { a: 2 }, { a: 3 })).toEqual({ a: 3 });
  });
});

describe('withoutNulls', () => {
  it('drops the null-valued keys', () => {
    expect(withoutNulls({ a: 1, b: null, c: 'x' })).toEqual({ a: 1, c: 'x' });
  });
});
