import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factsWithPrefix, setFact } from '../hooks/facts';
import { withLoopDb } from './loop-db';
import {
  normalizePublishBody,
  publishBodyHash,
  publishedUrlFor,
  recordPublished,
} from './publish-dedup';

/**
 * The dedup and the child-publish record, both `facts` rows on `loop.db`. What
 * these pin: the same body twice is one publish, a re-render that differs only
 * in line endings hashes the same, and one row per PUBLISH rather than per
 * agent.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-publish-dedup-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function keys(prefix: string): string[] {
  return withLoopDb(dir, (db) => factsWithPrefix(db, prefix).map((f) => f.key));
}

describe('normalizePublishBody', () => {
  it('folds a re-render that differs only in line endings and trailing space', () => {
    const a = '# T\n\nThe retry counter was off by one.\n';
    const b = '# T\r\n\r\nThe retry counter was off by one.   \r\n\r\n';
    expect(normalizePublishBody(b)).toBe(normalizePublishBody(a));
    expect(publishBodyHash(b)).toBe(publishBodyHash(a));
  });

  it('leaves interior whitespace alone: a reflowed paragraph is a different body', () => {
    expect(publishBodyHash('one two')).not.toBe(publishBodyHash('one  two'));
  });
});

describe('recordPublished', () => {
  it('the same body twice is one publish', async () => {
    const body = '# T\n\nox 0.14 still exports Bytes.from.\n';
    expect(await publishedUrlFor(dir, body)).toBeNull();
    await recordPublished(dir, body, 'https://tenjin.blog/p/one');
    expect(await publishedUrlFor(dir, body)).toBe('https://tenjin.blog/p/one');
    // The same finding rendered again by an agent asked twice.
    expect(await publishedUrlFor(dir, body.replace(/\n/g, '\r\n'))).toBe(
      'https://tenjin.blog/p/one',
    );
    expect(keys('published:')).toHaveLength(1);
  });

  it('two publishes by one child are two facts, so neither hides the other', async () => {
    await recordPublished(dir, 'first body', 'https://tenjin.blog/p/one', { agentId: 'child-1' });
    await recordPublished(dir, 'second body', 'https://tenjin.blog/p/two', { agentId: 'child-1' });
    const rows = keys('agent_published:');
    expect(rows).toHaveLength(2);
    for (const key of rows) expect(key.startsWith('agent_published:child-1@')).toBe(true);
  });

  it('records no agent row when the publish named none', async () => {
    await recordPublished(dir, 'a body', 'https://tenjin.blog/p/one');
    expect(keys('agent_published:')).toEqual([]);
  });

  it('nothing ages out: an old row still answers', async () => {
    const body = 'an old finding';
    await recordPublished(dir, body, 'https://tenjin.blog/p/old');
    withLoopDb(dir, (db) =>
      setFact(db, `published:${publishBodyHash(body)}`, 'https://tenjin.blog/p/old', 1),
    );
    await recordPublished(dir, 'something new', 'https://tenjin.blog/p/new');
    expect(await publishedUrlFor(dir, body)).toBe('https://tenjin.blog/p/old');
  });
});
