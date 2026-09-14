// The reported defect, reproduced end to end on the DISPLAY view: a paid piece
// whose TITLE nearly quotes the query lost to a free piece that only mentions the
// query's words in passing. Three independent causes, all fixed together, and the
// fixture is shaped so each one is separately visible:
//
//   - the keyword leg AND-joined the plain words, so one missing word dropped a
//     piece out of the pool before ranking (lib/search/retrieve/tsquery.ts);
//   - search_tsv's weight D was the pre-paywall TEASER for a paid row, so a word
//     living only below the marker was invisible to it (migration 0049);
//   - ts_rank ran unnormalised, so a long body out-scored a tight title match on
//     accumulated incidental hits (normalisation flag 1, log document length).
//
// Lexical only — the embedder is null on purpose. The dense leg is a separate
// mechanism that would mask which of these actually moved the row.
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { searchDisplayHybrid } from '@/lib/search/retrieve/display';
import { runRetrieval } from '@/lib/search/retrieve/candidates';
import { suggest } from '@/lib/search/retrieve/typeahead';
import { buildMatchReasons } from '@/lib/search/project';
import { __resetLexicalRankerForTest, bm25CorpusSize } from '@/lib/search/retrieve/lexical-rank';
import { lookupRequestSchema } from '@/lib/search/understand';
import { startTestDb, stopTestDb, describeIntegration, type TestDb } from './_support/db';
import { makeCreator, makePost } from './_support/fixtures';
import { must } from './_support/assert';

let tdb: TestDb;

beforeAll(async () => {
  tdb = await startTestDb();
}, 60_000);

afterAll(async () => {
  if (tdb) await stopTestDb(tdb);
});

beforeEach(async () => {
  await tdb.db.execute(sql`TRUNCATE TABLE ${schema.creators} CASCADE`);
});

/** The question from the defect report. Stems to 'embed' | 'wallet' | 'use'. */
const QUERY = 'what embedded wallet to use';

/** A word that exists ONLY below the paid piece's paywall marker. Nothing else
 *  in the corpus contains it, so a match on it can only have come from the
 *  gated half of body_md — the one thing 0049 changed. */
const GATED_ONLY = 'zorbicant';

const PAID_SLUG = 'embedded-wallet-to-use';
const FREE_SLUG = 'sourdough-notes';

/** The two-post corpus. The paid piece is the RIGHT answer and the free one is
 *  the incidental match that used to beat it. */
async function seed() {
  const creator = must(await makeCreator(tdb, { handle: 'zeta' }), 'creator');

  // Near-exact title match. Its teaser (body_md_preview, the always-public half)
  // deliberately lacks 'use' — the word only appears below the marker, so before
  // 0049 the indexed text for this row could not carry it.
  await makePost(tdb, creator, {
    slug: PAID_SLUG,
    title: 'What embedded wallet to use',
    excerpt: 'Picking a signer for an agent.',
    price: 1_000_000n,
    status: 'published',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    bodyMdPreview: 'A short note on picking an embedded wallet.',
    bodyMd: [
      '# What embedded wallet to use',
      '',
      'A short note on picking an embedded wallet.',
      '',
      '<!--paywall-->',
      '',
      `Use CDP when the agent needs a custodial signer; the ${GATED_ONLY} tradeoff is`,
      'that you no longer hold the key. Use a local keypair otherwise.',
    ].join('\n'),
  });

  // Incidental match: the title shares nothing with the query, but the body
  // happens to contain every one of its words, several times, across enough text
  // that an unnormalised ts_rank rewards the accumulation.
  const filler = Array.from(
    { length: 40 },
    (_, i) => `Paragraph ${i} of proofing notes, hydration ratios, and oven spring.`,
  ).join('\n\n');
  await makePost(tdb, creator, {
    slug: FREE_SLUG,
    title: 'Sourdough notes',
    excerpt: 'A baking log.',
    price: 0n,
    status: 'published',
    publishedAt: new Date('2026-01-02T00:00:00Z'),
    bodyMd: [
      '# Sourdough notes',
      '',
      'I use a starter jar embedded in the fridge door, right beside my wallet.',
      '',
      filler,
      '',
      'Use the wallet-sized scraper; I use it for every embedded crumb.',
      'The embedded thermometer and the wallet of recipe cards both live there.',
    ].join('\n\n'),
  });
}

describeIntegration(
  'the keyword leg ranks a near-exact paid title above an incidental free body',
  () => {
    it('puts the paid piece first for the reported query', async () => {
      await seed();

      const res = await searchDisplayHybrid(tdb.db, { q: QUERY, limit: 10 }, null);

      expect(res.calibration).toBe('lexical-v1');
      // BOTH rows are candidates — the OR join is what keeps the pool wide — and
      // the ORDER is the fix: the piece whose title answers the question wins.
      expect(res.items.map((i) => i.slug)).toEqual([PAID_SLUG, FREE_SLUG]);
    });

    it('admits a word that exists only below the paywall marker (0049)', async () => {
      await seed();

      // The index half on its own, and the provenance is asserted rather than
      // assumed: the word is in NO always-public column on any row, so 0032's
      // weight-D source (title/excerpt/tags/body_md_preview) could not have
      // produced this hit. Only 0049's whole-body source can.
      const { rows: publicText } = await tdb.db.execute<{ n: number }>(sql`
      select count(*)::int as n from posts
      where concat_ws(' ', title, excerpt, tags_blob, body_md_preview) ilike ${`%${GATED_ONLY}%`}`);
      expect(publicText[0]!.n).toBe(0);

      const res = await searchDisplayHybrid(tdb.db, { q: GATED_ONLY, limit: 10 }, null);
      expect(res.items.map((i) => i.slug)).toEqual([PAID_SLUG]);
      // ...and the row it returns is still preview-only: the gated bytes that
      // produced the match never ride back out on it.
      expect(JSON.stringify(res.items)).not.toContain(GATED_ONLY);
    });

    it('reaches a gated-body-only term on the decision view without a lexical label or a leak', async () => {
      await seed();
      const request = lookupRequestSchema.parse({ question: GATED_ONLY, limit: 10 });
      const { rows } = await runRetrieval(tdb.db, request, null, async () => false, {});
      expect(rows.map((r) => r.slug)).toEqual([PAID_SLUG]);
      // This ordinary prose match came from weight D (the gated body), so the
      // strong-weight label must NOT claim an identifier/title/excerpt hit.
      expect(buildMatchReasons(rows[0]!)).not.toContain('identifier/title/excerpt lexical match');
      expect(
        JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
      ).not.toContain(GATED_ONLY);
    });

    it('reaches a gated-body-only term on suggest without a leak (accepted: per-minute bound only)', async () => {
      await seed();
      const res = await suggest(tdb.db, GATED_ONLY);
      expect(res.essays.map((e) => e.slug)).toEqual([PAID_SLUG]);
      expect(JSON.stringify(res)).not.toContain(GATED_ONLY);
    });

    it('keeps a piece missing one query word in the pool (the OR join)', async () => {
      await seed();

      // 'sourdough' is in one title and one body; 'wallet' is in the other. Under
      // the old AND join this pair matched nothing at all.
      const res = await searchDisplayHybrid(tdb.db, { q: 'sourdough wallet', limit: 10 }, null);
      expect(res.items.map((i) => i.slug).sort()).toEqual([PAID_SLUG, FREE_SLUG].sort());
    });

    it('prefers the shorter document when the hits are otherwise identical (flag 1)', async () => {
      // The normalisation half, isolated. Both rows carry the query's two words
      // exactly once, at the same weight, so ts_rank WITHOUT flag 1 scores them
      // identically and the D5 tie-break (sortAt desc) decides — which is why the
      // padded one is published later. Flag 1 divides by log(document length), so
      // the tight match wins on rank and the tie-break never runs. Drop the flag
      // and this expectation inverts.
      const creator = must(await makeCreator(tdb, { handle: 'omega' }), 'creator');
      const hit = 'A note on the embedded wallet.';
      const filler = Array.from(
        { length: 200 },
        (_, i) => `Paragraph ${i} of unrelated proofing notes and oven spring.`,
      ).join('\n\n');
      await makePost(tdb, creator, {
        slug: 'tight',
        title: 'Tight',
        excerpt: 'short',
        price: 0n,
        status: 'published',
        publishedAt: new Date('2026-01-01T00:00:00Z'),
        bodyMd: hit,
      });
      await makePost(tdb, creator, {
        slug: 'padded',
        title: 'Padded',
        excerpt: 'long',
        price: 0n,
        status: 'published',
        publishedAt: new Date('2026-06-01T00:00:00Z'),
        bodyMd: `${hit}\n\n${filler}`,
      });

      const res = await searchDisplayHybrid(tdb.db, { q: 'embedded wallet', limit: 10 }, null);
      expect(res.items.map((i) => i.slug)).toEqual(['tight', 'padded']);
    });

    it('still matches nothing for a query that shares no word with the corpus', async () => {
      await seed();

      // The OR join widens the pool; it does not turn search into a match-all. A
      // query of only stopwords renders the EMPTY tsquery, which @@ evaluates
      // false rather than raising.
      expect(
        (await searchDisplayHybrid(tdb.db, { q: 'chinchilla', limit: 10 }, null)).items,
      ).toEqual([]);
      expect(
        (await searchDisplayHybrid(tdb.db, { q: 'the of and', limit: 10 }, null)).items,
      ).toEqual([]);
    });
  },
);

// #839: the corpus size that scales BM25's identifier and strong-field boosts.
// Here rather than in the unit suite because the unit suite's fake db cannot
// execute anything: this is the only place the statement actually parses and
// runs, and it is built from gates.discoverable() embedded in raw SQL.
describeIntegration('bm25CorpusSize', () => {
  beforeEach(() => __resetLexicalRankerForTest());

  it('counts DISCOVERABLE rows only — never a draft, an unlisted piece, or a dead creator', async () => {
    const live = must(await makeCreator(tdb, { handle: 'live-one' }), 'creator');
    const gone = must(
      await makeCreator(tdb, { handle: 'gone-one', deletedAt: new Date('2026-01-01T00:00:00Z') }),
      'creator',
    );
    const published = {
      status: 'published' as const,
      publishedAt: new Date('2026-01-01T00:00:00Z'),
    };
    await makePost(tdb, live, { slug: 'counted-a', ...published });
    await makePost(tdb, live, { slug: 'counted-b', ...published });
    await makePost(tdb, live, { slug: 'a-draft', status: 'draft' });
    await makePost(tdb, live, { slug: 'an-unlisted', status: 'unlisted' });
    // Published, but its creator is soft-deleted, so no leg can return it.
    await makePost(tdb, gone, { slug: 'orphaned', ...published });

    expect(await bm25CorpusSize(tdb.db)).toBe(2);
  });
});
