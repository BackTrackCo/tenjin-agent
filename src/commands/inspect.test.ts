import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInspect } from './inspect';
import {
  buildPaymentRequired,
  makeReadServer,
  previewCard,
  readBody,
  reply,
} from '../lib/read-test-utils';
import { libraryDir } from '../lib/library';
import { recordSearch } from '../lib/state-store';
import type { CommandContext, GlobalFlags } from '../context';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tenjin-inspect-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeCtx(flags: Partial<GlobalFlags> = {}): CommandContext {
  const sink = () => ({ write: () => true }) as unknown as NodeJS.WritableStream;
  return {
    flags: { json: false, timeout: 5000, ...flags },
    dataDir: dir,
    io: { stdout: sink(), stderr: sink(), isTTY: false },
  };
}

const URL_ = 'https://tenjin.blog/api/read/iris/slug';

describe('runInspect', () => {
  it('shows the paid card + price from the 402 without paying and without saving', async () => {
    const pr = buildPaymentRequired();
    const { fetch, calls } = makeReadServer({ plain: () => reply.paymentRequired(pr) });
    const res = await runInspect({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    const data = res.data as { access: string; price?: { atomic: string } };
    expect(data.access).toBe('paid');
    expect(data.price?.atomic).toBe('100000');
    expect(calls.every((c) => c.phase === 'plain')).toBe(true);
    // Nothing is written to the library on inspect.
    await expect(readdir(libraryDir(dir))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a free resource as free', async () => {
    const { fetch } = makeReadServer({ plain: () => reply.entitled(readBody({ price: '0' })) });
    const res = await runInspect({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    expect((res.data as { access: string }).access).toBe('free');
  });

  // The verb split (#42): delivery is free here, so the copy must NOT send an agent
  // through the paying verb; paid-and-unowned still must.
  it('points a free piece at `tenjin read`, never at buy', async () => {
    const { fetch } = makeReadServer({ plain: () => reply.entitled(readBody({ price: '0' })) });
    const res = await runInspect({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    const data = res.data as { nextCommand: string };
    expect(data.nextCommand).toBe(`tenjin read ${URL_}`);
    const human = (res.humanLines ?? []).join('\n');
    expect(human).toContain('tenjin read');
    expect(human).not.toContain('tenjin buy');
  });

  it('keeps pointing a paid, unowned piece at `tenjin buy`', async () => {
    const pr = buildPaymentRequired();
    const { fetch } = makeReadServer({ plain: () => reply.paymentRequired(pr) });
    const res = await runInspect({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    const data = res.data as { nextCommand: string };
    expect(data.nextCommand).toBe(`tenjin buy ${URL_}`);
    expect((res.humanLines ?? []).join('\n')).toContain('run `tenjin buy`');
  });
});

/**
 * The team lead's follow-up on tenjin-agent#252 item 1: (1) surface title
 * from the 402 preview `inspect` already fetches (no new network call);
 * (2) when no preview metadata exists at all — a title-less preview, or the
 * `already_purchased` branch, which carries no preview whatsoever — fall
 * back to the live `GET /api/posts/<id>/public` lookup (tenjin#803) for a
 * ref resolved via a bare id; (3) never call it, and never invent a value,
 * when there is no id to look up or the lookup itself fails.
 */
describe('runInspect, live metadata fallback for an id-resolved ref', () => {
  const RES = '0197aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  async function seedCandidate(): Promise<void> {
    await recordSearch(dir, {
      searchId: '0197aaaa-bbbb-cccc-dddd-000000000001',
      at: new Date().toISOString(),
      question: 'q',
      decision: 'CANDIDATES',
      candidates: [{ resourceId: RES, url: URL_, title: 't', price: '1' }],
    });
  }

  /** Branches on the URL rather than the header-based phase `makeReadServer`
   *  uses: the metadata lookup is a second, differently-pathed GET the read
   *  route's phase classifier knows nothing about. */
  function idResolvedFetch(config: { read: () => Response; postsPublic?: () => Response }): {
    fetch: typeof fetch;
    calls: string[];
  } {
    const calls: string[] = [];
    const fn = (async (input: string | URL | Request) => {
      const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
      calls.push(url);
      if (url.includes('/public')) {
        if (config.postsPublic === undefined) throw new Error('no postsPublic mock configured');
        return config.postsPublic();
      }
      return config.read();
    }) as unknown as typeof fetch;
    return { fetch: fn, calls };
  }

  function jsonRes(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('falls back to live metadata when the 402 preview carries no title', async () => {
    await seedCandidate();
    const pr = buildPaymentRequired();
    const { fetch, calls } = idResolvedFetch({
      read: () => reply.paymentRequired(pr, { price: '100000', creator: { handle: 'iris' } }),
      postsPublic: () =>
        jsonRes(200, {
          id: RES,
          slug: 'slug',
          title: 'Live Title',
          price: '100000',
          status: 'published',
          creator: { handle: 'iris' },
        }),
    });
    const res = await runInspect({ ref: RES }, makeCtx(), { fetchImpl: fetch });
    expect((res.data as { title?: string }).title).toBe('Live Title');
    expect(res.humanLines?.[0]).toBe('Live Title, paid, 0.1 USD (100000 atomic).');
    expect(calls.some((u) => u.includes(`/api/posts/${RES}/public`))).toBe(true);
  });

  it('leaves title absent, never invented, when the metadata lookup 404s', async () => {
    await seedCandidate();
    const pr = buildPaymentRequired();
    const { fetch } = idResolvedFetch({
      read: () => reply.paymentRequired(pr, { price: '100000', creator: { handle: 'iris' } }),
      postsPublic: () => jsonRes(404, { error: 'post_not_found' }),
    });
    const res = await runInspect({ ref: RES }, makeCtx(), { fetchImpl: fetch });
    expect(res.data).not.toHaveProperty('title');
    expect(res.humanLines?.[0]).toBe('Paid resource, 0.1 USD (100000 atomic).');
  });

  it('never calls the metadata endpoint when the preview already names a title', async () => {
    await seedCandidate();
    const pr = buildPaymentRequired();
    const { fetch, calls } = idResolvedFetch({
      read: () => reply.paymentRequired(pr),
      // No postsPublic mock configured: a call here throws and fails the test.
    });
    const res = await runInspect({ ref: RES }, makeCtx(), { fetchImpl: fetch });
    expect((res.data as { title?: string }).title).toBe('The Answer');
    expect(calls).toHaveLength(1);
  });

  it('never calls the metadata endpoint for a ref resolved by URL, not id', async () => {
    const pr = buildPaymentRequired();
    const { fetch, calls } = idResolvedFetch({
      read: () => reply.paymentRequired(pr, { price: '100000', creator: { handle: 'iris' } }),
      // No postsPublic mock configured: a call here throws and fails the test.
    });
    const res = await runInspect({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
    expect(res.data).not.toHaveProperty('title');
    expect(calls).toHaveLength(1);
  });

  it('fills title/price on the already_purchased branch, which carries no preview at all', async () => {
    await seedCandidate();
    const { fetch } = idResolvedFetch({
      read: () => reply.alreadyPurchased(),
      postsPublic: () =>
        jsonRes(200, {
          id: RES,
          slug: 'slug',
          title: 'Owned Piece',
          price: '100000',
          status: 'published',
          creator: { handle: 'iris' },
        }),
    });
    const res = await runInspect({ ref: RES }, makeCtx(), { fetchImpl: fetch });
    const data = res.data as { title?: string; price?: { atomic: string } };
    expect(data.title).toBe('Owned Piece');
    expect(data.price?.atomic).toBe('100000');
    expect(res.humanLines?.[0]).toBe('Owned Piece.');
  });

  it('reports already_purchased plainly when the metadata lookup also fails', async () => {
    await seedCandidate();
    const { fetch } = idResolvedFetch({
      read: () => reply.alreadyPurchased(),
      postsPublic: () => jsonRes(404, { error: 'post_not_found' }),
    });
    const res = await runInspect({ ref: RES }, makeCtx(), { fetchImpl: fetch });
    expect(res.data).not.toHaveProperty('title');
    expect(res.data).not.toHaveProperty('price');
    expect(res.humanLines?.[0]).toContain('Already purchased.');
  });
});

// The answer card left the search candidate in search v2, so this free 402 fetch
// is the ONLY place an agent can read what a piece claims before paying for it.
describe('runInspect, the 402 answer card', () => {
  const cardedPreview = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    title: 'The Answer',
    price: '100000',
    creator: { handle: 'iris' },
    card: previewCard(over),
  });

  function inspect402(preview: unknown): Promise<{ data: unknown; humanLines?: string[] }> {
    const pr = buildPaymentRequired();
    const { fetch } = makeReadServer({ plain: () => reply.paymentRequired(pr, preview) });
    return runInspect({ ref: URL_ }, makeCtx(), { fetchImpl: fetch });
  }

  it('renders every populated card field', async () => {
    const res = await inspect402(cardedPreview());
    const lines = (res.humanLines ?? []).join('\n');
    expect(lines).toContain('Answers: What does a Base transaction cost?');
    expect(lines).toContain('Applies to: products=Base');
    expect(lines).toContain('Scope: L2 execution fees only');
    expect(lines).toContain('Excludes: No L1 data costs');
    expect(lines).toContain(
      'Freshness: document, snapshot, as of 2026-07-01T00:00:00.000Z, valid until 2026-08-01T00:00:00.000Z',
    );
    expect(lines).toContain('Provenance: Measured against mainnet over one week');
  });

  it('skips the lines whose card fields are null or empty', async () => {
    const res = await inspect402(
      cardedPreview({
        questionsAnswered: [],
        tasksSupported: [],
        appliesTo: {},
        scope: null,
        exclusions: null,
        asOf: null,
        validUntil: null,
        provenanceSummary: null,
        methodologySummary: null,
        maintenanceCadence: null,
      }),
    );
    const lines = res.humanLines ?? [];
    // Freshness survives on artifactType + temporalMode alone; nothing else does.
    expect(lines.filter((l) => l.startsWith('Freshness: '))).toEqual([
      'Freshness: document, snapshot',
    ]);
    for (const label of ['Answers', 'Applies to', 'Scope', 'Excludes', 'Provenance']) {
      expect(lines.some((l) => l.startsWith(`${label}: `))).toBe(false);
    }
  });

  it('renders an uncarded piece exactly as before, aside from the title line: no card key, no card lines', async () => {
    const res = await inspect402({ title: 'The Answer', price: '100000' });
    expect(res.data).not.toHaveProperty('card');
    expect(res.humanLines).toEqual([
      'The Answer, paid, 0.1 USD (100000 atomic).',
      // The parenthetical is this branch's (#43): inspect tells humans up front
      // that the free verb refuses paid pieces.
      'This is the pre-purchase card; run `tenjin buy` to pay and read (`tenjin read` refuses paid pieces).',
    ]);
  });

  it('drops a malformed card without losing the rest of the preview, and says so', async () => {
    // Every other preview field is optional, so a half-filled card must not cost
    // the caller the title and price it came for. But the drop cannot be silent:
    // "no card" is a signal a buyer acts on, and a dropped card is not that.
    const res = await inspect402({
      title: 'The Answer',
      price: '100000',
      card: { artifactType: 'document' },
    });
    const data = res.data as { cardError?: true; preview: { title?: string; card?: unknown } };
    expect(data.preview.card).toBeUndefined();
    expect(data.preview.title).toBe('The Answer');
    expect(data.cardError).toBe(true);
    expect((res.humanLines ?? []).join('\n')).toContain('could not parse');
  });

  it('does not flag cardError on a genuinely uncarded piece', async () => {
    const res = await inspect402({ title: 'The Answer', price: '100000' });
    expect(res.data).not.toHaveProperty('cardError');
  });

  // Three states hide behind an absent card and they call for three different
  // actions, so the CLI has to keep them apart: uncarded (a signal, judge on it),
  // server could not load it (transient, retry), this CLI could not parse it
  // (ours). cardUnavailable is the server's, cardError is the client's.
  it('distinguishes a server-side unloadable card from an uncarded piece', async () => {
    const res = await inspect402({
      title: 'The Answer',
      price: '100000',
      cardUnavailable: true,
    });
    const lines = (res.humanLines ?? []).join('\n');
    expect(lines).toContain('the server could not load');
    expect(lines).not.toContain('could not parse');
    expect(res.data).not.toHaveProperty('cardError');
  });

  it('says nothing about an unloadable card on an ordinary uncarded piece', async () => {
    const res = await inspect402({ title: 'The Answer', price: '100000' });
    expect((res.humanLines ?? []).join('\n')).not.toContain('could not load');
  });

  // The two flags describe different failures and must not collapse into one
  // line: a parse failure is not a load failure, whatever else the body carries.
  it('reports a client parse failure as its own thing, not as unavailability', async () => {
    const res = await inspect402({
      title: 'The Answer',
      price: '100000',
      card: { artifactType: 'document' },
    });
    const lines = (res.humanLines ?? []).join('\n');
    expect(lines).toContain('could not parse');
    expect(lines).not.toContain('could not load');
  });

  // The card is the biggest object in the envelope; a second hoisted copy would
  // double every inspect payload to save one key of depth.
  it('emits the card exactly once in the machine envelope', async () => {
    const res = await inspect402(cardedPreview());
    const occurrences = JSON.stringify(res.data).match(/"card":/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect((res.data as { preview: { card?: { scope: string } } }).preview.card?.scope).toBe(
      'L2 execution fees only',
    );
  });

  // The old 300-char cap clipped cards the server considers perfectly valid, and
  // clipped them unmarked, so a partial claim read as a whole one.
  it('does not clip a card at the server write-time bounds', async () => {
    const tenQuestions = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(200));
    const res = await inspect402(
      cardedPreview({ questionsAnswered: tenQuestions, scope: 'S'.repeat(500) }),
    );
    const lines = res.humanLines ?? [];
    expect(lines.find((l) => l.startsWith('Answers: '))).toBe(
      `Answers: ${tenQuestions.join('; ')}`,
    );
    expect(lines.find((l) => l.startsWith('Scope: '))).toBe(`Scope: ${'S'.repeat(500)}`);
  });

  // artifactType and temporalMode are open strings on the wire, so an empty one
  // must drop out of the join rather than leaving the line to lead with a comma.
  it('never renders a freshness line that leads with a comma', async () => {
    const res = await inspect402(cardedPreview({ artifactType: '', temporalMode: 'snapshot' }));
    expect((res.humanLines ?? []).find((l) => l.startsWith('Freshness: '))).toBe(
      'Freshness: snapshot, as of 2026-07-01T00:00:00.000Z, valid until 2026-08-01T00:00:00.000Z',
    );
  });

  it('omits the freshness line entirely when it would carry nothing', async () => {
    const res = await inspect402(
      cardedPreview({ artifactType: '', temporalMode: '  ', asOf: null, validUntil: null }),
    );
    expect((res.humanLines ?? []).some((l) => l.startsWith('Freshness'))).toBe(false);
  });

  it('marks the clip when a server breaks its own bounds', async () => {
    const res = await inspect402(cardedPreview({ scope: 'S'.repeat(900) }));
    const scope = (res.humanLines ?? []).find((l) => l.startsWith('Scope: '));
    expect(scope).toBe(`Scope: ${'S'.repeat(500)}...`);
  });
});
