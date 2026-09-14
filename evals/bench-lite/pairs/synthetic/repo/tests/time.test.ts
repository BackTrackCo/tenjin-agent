import { describe, expect, it } from 'vitest';
import { daysBetween, formatStamp, fromStamp, parseStamp, toStamp } from '../src/time.ts';

const NOON = '2026-03-04T12:00:00.000Z';

describe('storage timestamps', () => {
  it('turns a date into the storage form', () => {
    expect(toStamp(new Date(NOON))).toBe(1772625600);
  });

  it('turns the storage form back into a date', () => {
    expect(fromStamp(1772625600).toISOString()).toBe(NOON);
  });

  it('parses an ISO string', () => {
    expect(parseStamp(NOON)).toBe(1772625600);
  });

  it('formats back to an ISO string', () => {
    expect(formatStamp(parseStamp(NOON))).toBe(NOON);
  });

  it('refuses something that is not a timestamp', () => {
    expect(() => parseStamp('last tuesday')).toThrow(/ISO-8601/);
  });
});

describe('daysBetween', () => {
  it('counts whole days', () => {
    const from = parseStamp('2026-03-01T00:00:00.000Z');
    const to = parseStamp('2026-03-04T00:00:00.000Z');
    expect(daysBetween(from, to)).toBe(3);
  });

  it('rounds a part day down', () => {
    const from = parseStamp('2026-03-01T00:00:00.000Z');
    const to = parseStamp('2026-03-01T23:00:00.000Z');
    expect(daysBetween(from, to)).toBe(0);
  });
});
