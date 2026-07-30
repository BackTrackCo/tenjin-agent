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

  it('renders an uncarded piece exactly as before: no card key, no card lines', async () => {
    const res = await inspect402({ title: 'The Answer', price: '100000' });
    expect(res.data).not.toHaveProperty('card');
    expect(res.humanLines).toEqual([
      'Paid resource, 0.1 USD (100000 atomic).',
      'This is the pre-purchase card; run `tenjin buy` to pay and read.',
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
