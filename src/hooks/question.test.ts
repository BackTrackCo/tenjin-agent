import { describe, expect, it } from 'vitest';
import { QUERY_MAX } from '../lib/agent-api';
import { promptSkip, question, questionKeyOf, skipText } from './question';

/**
 * `question()` is pure: text in, `{ text, questionKey }` out. What is under test
 * is that MASKING AND THE CUT ARE THE WHOLE TRANSFORM — the words an arm was
 * given are the words that leave, minus the secrets and minus whatever the shelf
 * would not read — and that nothing else drops or rewrites them on the way.
 */

const PROMPT =
  'why does the deploy fail when the token ghp_abcdefghijklmnopqrstuvwxyz0123456789 ' +
  'is set in the migrate.yml step of PR 751';

/** The token's body, which must survive nowhere. `mask()` keeps the `ghp_`
 *  prefix as a stub, so the assertion is on the secret, not on the prefix. */
const SECRET = 'abcdefghijklmnopqrstuvwxyz0123456789';

describe('question', () => {
  it('leaves the text alone: the question is what was typed', () => {
    for (const text of [
      'pgvector testcontainer collation',
      'x402 payTo attribution',
      'arXiv 2608.13568',
      'the migrate.yml step of PR 751 keeps failing and I cannot see why',
    ]) {
      expect(question(text).text).toBe(text);
    }
  });

  it('a ghp_ token reaches neither the text nor the key', () => {
    const q = question(PROMPT);
    expect(q.text).not.toContain(SECRET);
    // Everything around the token is untouched.
    expect(q.text).toContain('the migrate.yml step of PR 751');
    // The key is a hash of what was SENT, not of what was typed.
    expect(q.questionKey).toBe(questionKeyOf(q.text));
    expect(q.questionKey).not.toBe(questionKeyOf(PROMPT));
  });

  it('cuts at QUERY_MAX at a whole word, and the key is over what it cut to', () => {
    const paste = `${'collation '.repeat(1500)}pgvector`;
    expect(paste.length).toBeGreaterThan(QUERY_MAX);

    const asked = question(paste);
    expect(asked.text.length).toBeLessThanOrEqual(QUERY_MAX);
    expect(asked.text.endsWith('collation')).toBe(true);
    expect(paste.startsWith(`${asked.text} `)).toBe(true);
    expect(asked.questionKey).toBe(questionKeyOf(asked.text));
  });

  it('keys two work orders apart when only their tails differ', () => {
    const rules = 'follow the repo rules and never push. '.repeat(20);
    const first = question(`${rules}now fix the pgvector collation flip`);
    const second = question(`${rules}now fix the ivfflat index build`);
    expect(first.questionKey).not.toBe(second.questionKey);
  });

  it('keys the same question the same way across case and whitespace', () => {
    const key = questionKeyOf('pgvector testcontainer collation');
    expect(questionKeyOf('  PGVector   Testcontainer\n\tCollation  ')).toBe(key);
    expect(questionKeyOf('pgvector testcontainer collations')).not.toBe(key);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('skipText', () => {
  it('masks a refused text and keeps 512 characters of it', () => {
    const refused = `/compact ${PROMPT} ${'x'.repeat(2000)}`;
    const stored = skipText(refused);
    expect(stored).not.toContain(SECRET);
    expect(stored.length).toBe(512);
  });
});

describe('promptSkip', () => {
  it('names each of the three reasons', () => {
    expect(
      promptSkip(
        '/compact please summarize the whole session before we continue with the migration',
      ),
    ).toBe('slash');
    expect(promptSkip('<task-notification>agent a-1 finished</task-notification>')).toBe('harness');
    expect(promptSkip('<agent-message from="a-1">done with the migration</agent-message>')).toBe(
      'harness',
    );
    expect(promptSkip('[SYSTEM NOTIFICATION] the daemon restarted mid-turn')).toBe('harness');
    // Thirty two-character tokens: no word long enough to be one.
    expect(promptSkip('ab '.repeat(30).trim())).toBe('words');
  });

  it('counts words on the masked text, so a stub is not a word', () => {
    expect(promptSkip(`is ${'ghp_abcdefghijklmnopqrstuvwxyz0123456789'} ok`)).toBe('words');
  });

  it('asks a short question rather than refusing it for being short', () => {
    // 78 characters, which the deleted length floor refused as a conversational
    // reply. It is a question, so it is asked.
    const short = 'the pgvector testcontainer collation flipped after the image bump, why was it?';
    expect(short.length).toBe(78);
    expect(promptSkip(short)).toBeNull();
  });

  it('asks a pasted payload rather than refusing it for being long', () => {
    const paste = `${'collation '.repeat(500)}pgvector`;
    expect(paste.length).toBeGreaterThan(5000);
    expect(promptSkip(paste)).toBeNull();
  });

  it('passes a real question through', () => {
    expect(
      promptSkip(
        'the pgvector testcontainer collation flipped when the image tag changed and the suite fails',
      ),
    ).toBeNull();
  });
});
