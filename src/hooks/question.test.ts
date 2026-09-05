import { describe, expect, it } from 'vitest';
import { condense, identifiersOf } from '../lib/query-condense';
import { mask } from '../lib/redact';
import { promptSkip, question, questionKeyOf } from './question';

/**
 * `question()` is pure: text in, `{ text, questionKey, identifiers? }` out. What
 * is under test is the SHAPE LIST — that the steps run in the order given, that
 * only a shape carrying `condense` produces identifiers, and that nothing an arm
 * masked can reappear downstream.
 */

const PROMPT =
  'why does the deploy fail when the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ' +
  'is set in the migrate.yml step of PR 751';

/** The token's body, which must survive nowhere. `mask()` keeps the `ghp_`
 *  prefix as a stub, so the assertion is on the secret, not on the prefix. */
const SECRET = 'abcdefghijklmnopqrstuvwxyz0123456789';

describe('question', () => {
  it('runs the shape in order: mask before condense', () => {
    const q = question(PROMPT, [mask, condense]);
    // Identifiers are read off the MASKED text. On the raw prompt the token
    // matches the identifier regex and would have been lifted whole.
    expect(identifiersOf(PROMPT)).toContain(`ghp_${SECRET}`);
    expect(q.identifiers).toEqual(['migrate.yml', 'pr-751']);
  });

  it('a ghp_ token reaches neither the text, nor the key, nor the identifiers', () => {
    const q = question(PROMPT, [mask, condense]);
    expect(q.text).not.toContain(SECRET);
    expect(q.identifiers?.join(' ')).not.toContain(SECRET);
    // The key is a hash of what was SENT, not of what was typed.
    expect(q.questionKey).toBe(questionKeyOf(q.text));
    expect(q.questionKey).not.toBe(questionKeyOf(PROMPT));
  });

  it('a mask-only shape leaves a search-shaped query byte-identical', () => {
    // The three shapes the 14-day corpus is made of; condense damaged all of
    // them, which is why no search arm has it in its shape.
    for (const query of [
      'pgvector testcontainer collation',
      'x402 payTo attribution',
      'arXiv 2608.13568',
    ]) {
      expect(question(query, [mask]).text).toBe(query);
    }
  });

  it('fills identifiers only when condense is in the shape', () => {
    expect(
      question('the migrate.yml step of PR 751 keeps failing', [mask]).identifiers,
    ).toBeUndefined();
    expect(
      question('the migrate.yml step of PR 751 keeps failing', [mask, condense]).identifiers,
    ).toEqual(['migrate.yml', 'pr-751']);
  });

  it('falls back to the head when condensing leaves nothing', () => {
    // Three-word questions: no identifier, no clause of four words.
    const thin = 'does it build? does it lint? does it ship?';
    expect(condense(thin)).toBe('');
    expect(question(thin, [mask, condense]).text).toBe(thin);
  });

  it('keys the same question the same way across case and whitespace', () => {
    const key = questionKeyOf('pgvector testcontainer collation');
    expect(questionKeyOf('  PGVector   Testcontainer\n\tCollation  ')).toBe(key);
    expect(questionKeyOf('pgvector testcontainer collations')).not.toBe(key);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('promptSkip', () => {
  it('names each reason', () => {
    expect(promptSkip('yes')).toBe('short');
    expect(promptSkip('x '.repeat(2100))).toBe('long');
    expect(
      promptSkip(
        '/compact please summarize the whole session before we continue with the migration',
      ),
    ).toBe('slash');
    // Thirty two-character tokens: 89 characters, no word long enough to be one.
    expect(promptSkip('ab '.repeat(30).trim())).toBe('words');
  });

  it('counts words on the masked text, so a stub is not a word', () => {
    const q = `is ${'ghp_abcdefghijklmnopqrstuvwxyz0123456789'} ok or ok or ok or ok or ok or ok or ok`;
    expect(q.length).toBeGreaterThanOrEqual(80);
    expect(promptSkip(q)).toBe('words');
  });

  it('passes a real question through', () => {
    expect(
      promptSkip(
        'the pgvector testcontainer collation flipped when the image tag changed and the suite fails',
      ),
    ).toBeNull();
  });
});
